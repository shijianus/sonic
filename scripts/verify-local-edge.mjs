// Exercise the compiled Pages bundle and its shared SQLite Durable Object on loopback.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { dirname, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPagesDeploymentTree } from './pages-release-lib.mjs';

const require = createRequire(import.meta.url);
// Use the version already locked by Wrangler.
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve('wrangler/package.json'))('miniflare');
const root = resolve(import.meta.dirname, '..');
const { stagingRoot, manifest, pagesArtifactDigest } = buildPagesDeploymentTree(root);
const compatibilityDate = '2026-11-10';
const key = randomBytes(32).toString('hex');
const invite = randomBytes(24).toString('hex');
const restartInvite = randomBytes(24).toString('hex');
const browserInvites = Array.from({ length: 2 }, () => randomBytes(24).toString('hex'));
const namespace = { SONIC_RATE_LIMIT_BUCKETS: { className: 'SonicRateBucket', scriptName: 'rate-limiter' } };
const accessNamespace = { SONIC_ACCESS_BUCKETS: { className: 'SonicAccessStore', scriptName: 'rate-limiter' } };
const env = {
  CF_PAGES: '1', SONIC_ENV: 'production', SONIC_ACCESS_MODE: 'invite',
  SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT: '1', SONIC_RATE_LIMIT_FAIL_CLOSED: '1',
  SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'netease', SONIC_ENABLE_LOCAL_ENGINE: '0',
  SONIC_ENGINE_SECRET: key, SONIC_ACCESS_SECRET: randomBytes(32).toString('hex'),
  SONIC_INVITE_CODES: `${invite},${restartInvite}`, SONIC_ENABLE_OAUTH: '0', SONIC_RATE_LIMIT_ANON_RPM: '50',
  SONIC_REQUIRE_DURABLE_INVITES: '1',
  SONIC_TIMEOUT_MS: '500',
};
let runtime;
let engine;
const engineCalls = [];
let redirectEngine = false;
let providerRequests = 0;
let smartRequests = 0;
let smartRecovered = false;
const staticTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function assets(request) {
  const path = new URL(request.url).pathname;
  const dist = resolve(stagingRoot, 'dist');
  const file = resolve(dist, '.' + path);
  if (!file.startsWith(dist + '/') && file !== dist) return new Response(null, { status: 404 });
  const target = extname(file) ? file : resolve(dist, 'index.html');
  try {
    return new Response(readFileSync(target), { headers: { 'Content-Type': staticTypes[extname(target)] || 'application/octet-stream' } });
  } catch { return new Response(null, { status: 404 }); }
}

async function verifyBrowser(pages) {
  const { chromium, devices, expect } = createRequire(resolve(root, 'player/package.json'))('@playwright/test');
  const bridge = createHttpServer(async (req, res) => {
    try {
      const target = new URL(req.url, base);
      assert.equal(target.origin, base);
      const payload = [];
      for await (const chunk of req) payload.push(chunk);
      const headers = new Headers(req.headers);
      headers.delete('host');
      const result = await pages.fetch(target, { method: req.method, headers,
        ...(payload.length ? { body: Buffer.concat(payload) } : {}) });
      const outgoing = Object.fromEntries(result.headers);
      outgoing['set-cookie'] = result.headers.getSetCookie();
      res.writeHead(result.status, outgoing);
      if (result.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(result.body), res);
      else res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502); res.end(); }
    }
  }).listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const base = `http://127.0.0.1:${bridge.address().port}`;
  const screens = resolve(process.env.SONIC_LOCAL_EDGE_SCREENSHOTS);
  mkdirSync(screens, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    for (const [index, profile] of ['desktop', 'mobile'].entries()) {
      const context = await browser.newContext({ ...(profile === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
        baseURL: base, locale: 'en-US', reducedMotion: 'reduce' });
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addInitScript(() => localStorage.setItem('global', JSON.stringify({ lang: 'en' })));
      const page = await context.newPage();
      const entry = await page.goto(`${base}/invite`);
      assert.equal(entry.status(), 200);
      assert.match(entry.headers()['x-robots-tag'], /noindex/);
      const form = page.getByTestId('access-invite-form');
      const input = page.getByTestId('access-code-input');
      const submit = page.getByTestId('access-redeem-button');
      await expect(form).toBeVisible();
      await expect(input).toHaveAccessibleName('Invite code');
      await expect(submit).toBeDisabled();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await expect(page.locator('#nprogress')).toHaveCount(0);
      await page.screenshot({ path: resolve(screens, `invite-${profile}.png`) });
      await input.fill('invalid-audit-invite-code');
      await input.press('Enter');
      await expect(form.getByRole('alert')).toBeVisible();
      await expect(input).toHaveAttribute('aria-describedby', 'access-code-error');
      await expect(input).toHaveAccessibleDescription('This invite code is invalid or expired.');
      await expect(page.locator('#nprogress')).toHaveCount(0);
      await page.screenshot({ path: resolve(screens, `invite-${profile}-invalid.png`) });
      await input.fill(browserInvites[index]);
      await submit.click();
      await expect(form).toBeHidden();
      const status = await page.request.get('/api/access/session');
      assert.equal(status.status(), 200);
      const sessionCookie = (await context.cookies()).find(cookie => cookie.name === 'sonic_access');
      assert.ok(sessionCookie?.httpOnly && sessionCookie.sameSite === 'Lax');
      const search = await page.request.get('/api/music/search?q=Sonic&source=synthetic&count=1');
      assert.equal(search.status(), 200);
      assert.ok((await search.json()).tracks.length > 0);
      await page.evaluate(async () => {
        const audio = document.createElement('audio');
        audio.muted = true;
        audio.src = '/api/music/stream?id=syn-440hz&source=synthetic';
        document.body.append(audio);
        await audio.play();
      });
      await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(audio => !audio.paused && audio.currentTime > 0.1));
      await page.goto(`${base}/#/settings`);
      const card = page.getByTestId('access-status-card');
      await expect(card).toBeVisible();
      await card.getByRole('button', { name: /remove access|移除访问权限/i }).click();
      await expect(form).toBeVisible();
      const replay = await page.request.get('/api/access/session', { headers: { Cookie: `${sessionCookie.name}=${sessionCookie.value}` } });
      assert.equal(replay.status(), 401);
      await input.fill(browserInvites[index]);
      await submit.click();
      await expect(form.getByRole('alert')).toBeVisible();
      await context.close();
    }
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(done => { bridge.close(done); bridge.closeAllConnections(); }); }
  }
}
try {
  const cli = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  execFileSync(process.execPath, [cli, 'pages', 'functions', 'build', 'functions', '--project-directory', '.',
    '--outdir', 'bundle', '--compatibility-date', compatibilityDate, '--compatibility-flags', 'nodejs_compat'], {
    cwd: stagingRoot, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(done => portProbe.close(done));
  const engineOrigin = `http://127.0.0.1:${port}`;
  const engineBindingOrigin = 'https://engine.sonic.test';
  const identity = randomBytes(32).toString('hex');
  const signing = randomBytes(32).toString('hex');
  engine = spawn(process.execPath, ['--experimental-sqlite', resolve(root, 'dist-server/index.mjs')], {
    cwd: stagingRoot, stdio: 'ignore', env: {
      PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production',
      SONIC_ENV: 'staging', SONIC_RUNTIME: 'linux-engine', SONIC_ACCESS_MODE: 'open',
      SONIC_STATIC_DIR: resolve(stagingRoot, 'dist'), SONIC_RECOMMEND_DB_PATH: resolve(stagingRoot, 'recommend.sqlite'),
      SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
      SONIC_ENGINE_SECRET: key, SONIC_ENGINE_IDENTITY_SECRET: identity, SONIC_SECRET: signing,
      SONIC_REQUIRE_ENGINE_IDENTITY: '1', SONIC_ENABLE_OAUTH: '0',
    },
  });
  const health = '/api/sonic/engine/health';
  const deadline = Date.now() + 10_000;
  for (;;) {
    const probe = await fetch(engineOrigin + health, { headers: { 'X-Sonic-Engine-Key': key }, signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (probe?.ok) {
      const status = await probe.json();
      assert.equal(status.release.releaseId, manifest.releaseId);
      assert.equal(status.recommendEngine.storageKind, 'sqlite');
      break;
    }
    await probe?.body?.cancel();
    assert.ok(engine.exitCode === null && Date.now() < deadline, 'Loopback Engine did not become ready');
    await delay(100);
  }
  const pagesScript = readFileSync(resolve(stagingRoot, 'bundle/index.js'), 'utf8');
  const worker = (name, durableObjects, bindings = env) => ({ name, modules: true, script: pagesScript,
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], bindings, durableObjects,
    serviceBindings: { ASSETS: assets },
    outboundService: async request => {
      const target = new URL(request.url);
      if (target.origin === 'https://music.163.com' && target.pathname === '/api/linux/forward') {
        providerRequests++;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')); },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(target.origin, engineBindingOrigin, 'Only the local provider fixture and loopback Engine are allowed');
      if (target.pathname === '/api/sonic/search/smart' && target.searchParams.get('q') === 'local-smart-recovery') {
        smartRequests++;
        const ids = smartRecovered ? ['fast-track', 'recovered-track'] : ['fast-track'];
        return Response.json({
          brand: 'Sonic', data: { tracks: ids.map(platformId => ({ platformId, title: platformId })), total: ids.length },
          meta: { attempts: smartRecovered ? [] : [{ provider: 'netease', ok: false, errorCode: 'UPSTREAM_TIMEOUT' }] },
        }, { headers: { 'Cache-Control': smartRecovered ? 'public, max-age=600' : 'no-store' } });
      }
      if (redirectEngine) return new Response(null, { status: 307, headers: { Location: 'https://unused.sonic.test/' } });
      const result = await fetch(`${engineOrigin}${target.pathname}${target.search}`, {
        method: request.method, headers: [...request.headers], redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      engineCalls.push({ path: target.pathname, status: result.status });
      return new Response(await result.arrayBuffer(), { status: result.status, headers: [...result.headers] });
    },
  });
  const staging = { ...env, SONIC_ENV: 'staging', SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
    SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_LOCAL_ENGINE_URL: engineBindingOrigin, SONIC_ENGINE_IDENTITY_SECRET: identity, SONIC_SECRET: signing,
    SONIC_INVITE_CODES: [env.SONIC_INVITE_CODES, ...browserInvites].join(',') };
  const unavailable = { SONIC_RATE_LIMIT_BUCKETS: { className: 'UnavailableBucket', scriptName: 'rate-limiter' } };
  const script = readFileSync(resolve(root, 'edge-rate-limiter/index.mjs'), 'utf8');
  const options = convertV4MiniflareOptions({ host: '127.0.0.1', port: 0,
    resourcePersistencePath: resolve(stagingRoot, 'durable-state'), workers: [
    worker('pages-a', { ...namespace, ...accessNamespace }), worker('pages-b', { ...namespace, ...accessNamespace }),
    worker('pages-no-binding', { ...accessNamespace }), worker('pages-backend-down', { ...unavailable, ...accessNamespace }),
    worker('pages-access-unbound', namespace),
    worker('pages-access-down', { ...namespace, SONIC_ACCESS_BUCKETS: { className: 'UnavailableBucket', scriptName: 'rate-limiter' } }),
    worker('pages-staging', { ...namespace, SONIC_ACCESS_BUCKETS: { className: 'SonicAccessStore', scriptName: 'staging-access' } }, staging),
    worker('pages-search-load', namespace, { ...staging, SONIC_ACCESS_MODE: 'open', SONIC_REQUIRE_DURABLE_INVITES: '0' }),
    { name: 'rate-limiter', modules: true, script: `${script}
      export class UnavailableBucket extends DurableObject { fetch() { return new Response(null, {status:503}); } }`,
      compatibilityDate, durableObjects: { LOCAL_BUCKETS: { className: 'SonicRateBucket', useSQLite: true },
        LOCAL_ACCESS: { className: 'SonicAccessStore', useSQLite: true },
        UNAVAILABLE_BUCKETS: { className: 'UnavailableBucket', useSQLite: true } } },
    { name: 'staging-access', modules: true, script, compatibilityDate,
      durableObjects: { STAGING_ACCESS: { className: 'SonicAccessStore', useSQLite: true } } },
  ] });
  runtime = new Miniflare(options);
  const loopback = await runtime.ready;
  assert.equal(loopback.hostname, '127.0.0.1');
  const [a, b, broken, localStaging, backendDown, searchLoad, accessUnbound, accessDown] = await Promise.all(
    ['pages-a', 'pages-b', 'pages-no-binding', 'pages-staging', 'pages-backend-down', 'pages-search-load',
      'pages-access-unbound', 'pages-access-down'].map(name => runtime.getWorker(name)));
  const storeWorker = await runtime.getWorker('rate-limiter');
  assert.equal((await storeWorker.fetch('http://127.0.0.1/v1/health')).status, 404);
  const denied = await a.fetch(`http://127.0.0.1${health}`);
  assert.equal(denied.status, 401);
  const ready = await a.fetch(`http://127.0.0.1${health}`, { headers: { 'X-Sonic-Engine-Key': key } });
  assert.equal(ready.status, 200);
  const state = await ready.json();
  assert.equal(state.rateLimit.configuredBackend, 'durable-object');
  assert.equal(state.rateLimit.productionCompliant, true);
  assert.equal(state.release.releaseId, manifest.releaseId);
  assert.equal(state.release.pagesArtifactDigest, pagesArtifactDigest);
  for (const prop of ['durableRequired', 'storeUsable', 'singleUse', 'revocable']) assert.equal(state.readiness.access[prop], true);
  assert.equal(state.readiness.access.backend, 'durable-object');

  const redeem = (worker, code, ip) => worker.fetch('http://127.0.0.1/api/access/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ code }),
  });
  const inviteBurst = 20;
  const simultaneous = await Promise.all(Array.from({ length: inviteBurst }, (_, i) => redeem(i % 2 ? b : a, invite, '192.0.2.1')));
  assert.equal(simultaneous.filter(response => response.status === 200).length, 1);
  for (const denial of simultaneous.filter(response => response.status !== 200)) {
    assert.equal(denial.status, 401);
    assert.equal(denial.headers.get('set-cookie'), null);
    assert.equal((await denial.json()).error.code, 'INVITE_INVALID');
  }
  const entered = simultaneous.find(response => response.status === 200);
  assert.equal(entered.status, 200);
  assert.match(entered.headers.get('set-cookie'), /HttpOnly/i);
  const timeout = await a.fetch('http://127.0.0.1/api/sonic/search/nexus?q=local-slow-body', {
    headers: { Cookie: entered.headers.get('set-cookie').split(';', 1)[0], 'CF-Connecting-IP': '192.0.2.1' },
  });
  assert.equal(timeout.status, 200);
  assert.equal(timeout.headers.get('cache-control'), 'private, no-store');
  const timedOut = await timeout.json();
  assert.deepEqual(timedOut.data.tracks, []);
  assert.deepEqual(timedOut.meta.attempts.map(({ provider, errorCode }) => ({ provider, errorCode })),
    [{ provider: 'netease', errorCode: 'UPSTREAM_TIMEOUT' }]);
  assert.equal(providerRequests, 1);
  assert.equal((await redeem(broken, invite, '192.0.2.1')).status, 503);
  assert.equal((await redeem(backendDown, invite, '192.0.2.1')).status, 503);

  const stagingInvite = await redeem(localStaging, invite, '192.0.2.4');
  assert.equal(stagingInvite.status, 200);
  const cookie = stagingInvite.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.4' };
  const peer = await localStaging.fetch(`http://127.0.0.1${health}?verifyEngine=1`, { headers: { 'X-Sonic-Engine-Key': key } });
  const peerStatus = await peer.json();
  assert.equal(peer.status, 200, JSON.stringify({ reasons: peerStatus.readiness?.reasons, peer: peerStatus.enginePeer, circuit: peerStatus.circuit, engineCalls }));
  assert.equal(peerStatus.enginePeer.release.releaseId, manifest.releaseId);
  const search = await localStaging.fetch('http://127.0.0.1/api/music/search?q=Sonic&source=synthetic&count=5', { headers });
  assert.equal(search.status, 200);
  assert.equal(search.headers.get('x-sonic-via'), 'local-engine');
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control']) {
    assert.equal(search.headers.get(name), 'private, no-store');
  }
  assert.ok((await search.json()).tracks.length > 0);
  const stream = await localStaging.fetch('http://127.0.0.1/api/music/stream?id=syn-440hz&source=synthetic', {
    headers: { ...headers, Range: 'bytes=0-43' },
  });
  assert.equal(stream.status, 206);
  assert.equal(stream.headers.get('x-sonic-via'), 'local-engine');
  assert.equal(Buffer.from(await stream.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');

  const accessSession = 'http://127.0.0.1/api/access/session';
  const inviteCookie = entered.headers.get('set-cookie').split(';', 1)[0];
  const accessHeaders = { Cookie: inviteCookie, 'CF-Connecting-IP': '192.0.2.1' };
  assert.equal((await b.fetch(accessSession, { headers: accessHeaders })).status, 200);
  const sessionBurst = 120;
  const sessionStart = performance.now();
  const sessionLatencies = await Promise.all(Array.from({ length: sessionBurst }, async (_, i) => {
    const started = performance.now();
    const response = await (i % 2 ? a : b).fetch(accessSession, { headers: { ...accessHeaders, 'CF-Connecting-IP': `192.0.2.${20 + i % 8}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).access, true);
    return performance.now() - started;
  }));
  sessionLatencies.sort((left, right) => left - right);
  const sessionP95Ms = Math.round(sessionLatencies[Math.floor((sessionBurst - 1) * 0.95)]);
  assert.ok(sessionP95Ms < 2000, 'Local invite session checks exceeded the 2s p95 gate');
  const sessionDurationMs = Math.round(performance.now() - sessionStart);
  assert.equal((await localStaging.fetch(accessSession, { headers: accessHeaders })).status, 401);
  const logout = worker => worker.fetch('http://127.0.0.1/api/access/logout', {
    method: 'POST', headers: { ...accessHeaders, Origin: 'http://127.0.0.1' },
  });
  for (const inaccessible of [accessUnbound, accessDown]) {
    const redemption = await redeem(inaccessible, restartInvite, '192.0.2.7');
    assert.equal(redemption.status, 503);
    assert.equal(redemption.headers.get('set-cookie'), null);
    assert.equal((await redemption.json()).error.code, 'ACCESS_STORE_UNAVAILABLE');
    const session = await inaccessible.fetch(accessSession, { headers: accessHeaders });
    assert.equal(session.status, 503);
    assert.equal((await session.json()).error.code, 'ACCESS_STORE_UNAVAILABLE');
    const storeHealth = await inaccessible.fetch(`http://127.0.0.1${health}`, { headers: { 'X-Sonic-Engine-Key': key } });
    assert.equal(storeHealth.status, 503);
    assert.equal((await storeHealth.json()).readiness.access.storeUsable, false);
    const failedLogout = await logout(inaccessible);
    assert.equal(failedLogout.status, 503);
    assert.match(failedLogout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await failedLogout.json()).serverRevoked, false);
  }
  const loggedOut = await logout(b);
  assert.equal(loggedOut.status, 200);
  assert.equal((await loggedOut.json()).serverRevoked, true);
  for (const pages of [a, b]) {
    const expired = await pages.fetch('http://127.0.0.1/api/sonic/search/nexus?q=local-slow-body', { headers: accessHeaders });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'ACCESS_REQUIRED');
  }
  assert.equal((await redeem(a, invite, '192.0.2.1')).status, 401);
  const active = await redeem(b, restartInvite, '192.0.2.1');
  assert.equal(active.status, 200);
  const activeHeaders = { ...accessHeaders, Cookie: active.headers.get('set-cookie').split(';', 1)[0] };

  const smartBurstSize = 20;
  const requestSmart = async (cache, expectedIds) => {
    const response = await searchLoad.fetch('http://127.0.0.1/api/sonic/search/smart?q=local-smart-recovery', {
      headers: { 'CF-Connecting-IP': '192.0.2.6' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-sonic-cache'), cache);
    assert.match(response.headers.get('cache-control'), expectedIds.length === 1 ? /no-store/ : /^public,/);
    assert.deepEqual((await response.json()).data.tracks.map(track => track.platformId), expectedIds);
  };
  await Promise.all(Array.from({ length: smartBurstSize }, () => requestSmart('MISS', ['fast-track'])));
  assert.equal(smartRequests, smartBurstSize);
  smartRecovered = true;
  await requestSmart('MISS', ['fast-track', 'recovered-track']);
  await Promise.all(Array.from({ length: smartBurstSize }, () => requestSmart('HIT', ['fast-track', 'recovered-track'])));
  assert.equal(smartRequests, smartBurstSize + 1);

  redirectEngine = true;
  const redirected = await localStaging.fetch(`http://127.0.0.1${health}?verifyEngine=1`, { headers: { 'X-Sonic-Engine-Key': key } });
  const rejectedRedirect = await redirected.json();
  assert.equal(redirected.status, 503);
  assert.equal(rejectedRedirect.circuit.lastError, 'Unexpected upstream redirect');
  redirectEngine = false;

  const burstSize = 200;
  const start = performance.now();
  const outcomes = await Promise.all(Array.from({ length: burstSize }, async (_, index) => {
    const response = await redeem(index % 2 ? a : b, 'invalid-audit-invite-code', '192.0.2.2');
    await response.arrayBuffer();
    return response.status;
  }));
  assert.equal(outcomes.filter(status => status === 401).length, 50);
  assert.equal(outcomes.filter(status => status === 429).length, 150);
  assert.equal((await redeem(b, 'invalid-audit-invite-code', '192.0.2.3')).status, 401);
  const auth = index => (index % 2 ? a : b).fetch('http://127.0.0.1/api/auth/login', { headers: { 'CF-Connecting-IP': '192.0.2.5' } });
  const authStatuses = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    const response = await auth(index);
    await response.arrayBuffer();
    return response.status;
  }));
  assert.equal(authStatuses.filter(status => status === 403).length, 30);
  assert.equal(authStatuses.filter(status => status === 429).length, 10);
  const durationMs = Math.round(performance.now() - start);
  await runtime.dispose();
  runtime = new Miniflare(options);
  const restarted = await runtime.getWorker('pages-a');
  assert.equal((await restarted.fetch(accessSession, { headers: activeHeaders })).status, 200);
  assert.equal((await restarted.fetch(accessSession, { headers: accessHeaders })).status, 401);
  assert.equal((await redeem(restarted, invite, '192.0.2.1')).status, 401);
  const browserChecked = Boolean(process.env.SONIC_LOCAL_EDGE_SCREENSHOTS);
  if (browserChecked) await verifyBrowser(await runtime.getWorker('pages-staging'));
  console.log(JSON.stringify({ ok: true, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest, pagesArtifactDigest,
    workers: 2, requests: burstSize, allowedToReachInviteCheck: 50, rejected429: 150,
    durationMs, authRequests: 40, authRejected429: 10,
    missingBinding503: true, backendUnavailable503: true, protectedHealth401: true, pagesToEngineRange206: true,
    engineRedirectRejected: true, providerBodyTimeout: true, actualPagesBundle: true,
    durableInvite: { simultaneous: inviteBurst, redeemed: 1, logoutReplayDenied: true, namespacesIsolated: true,
      sessionRequests: sessionBurst, sessionP95Ms, sessionDurationMs,
      privateResponses: true, bindingFailure503: true, stateSurvivesRestart: true, desktopAndMobileBrowser: browserChecked },
    smartSearch: { partialMisses: smartBurstSize, recoveryMisses: 1, fullHits: smartBurstSize, engineRequests: smartRequests } }));
} finally {
  try {
    await runtime?.dispose();
  } finally {
    try {
      if (engine?.pid && engine.exitCode === null && engine.signalCode === null) {
        const exited = once(engine, 'exit');
        engine.kill('SIGTERM');
        await exited;
      }
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

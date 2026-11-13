// Exercise the compiled Pages bundle and its shared SQLite Durable Object on loopback.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
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
const namespace = { SONIC_RATE_LIMIT_BUCKETS: { className: 'SonicRateBucket', scriptName: 'rate-limiter' } };
const env = {
  CF_PAGES: '1', SONIC_ENV: 'production', SONIC_ACCESS_MODE: 'invite',
  SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT: '1', SONIC_RATE_LIMIT_FAIL_CLOSED: '1',
  SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'netease', SONIC_ENABLE_LOCAL_ENGINE: '0',
  SONIC_ENGINE_SECRET: key, SONIC_ACCESS_SECRET: randomBytes(32).toString('hex'),
  SONIC_INVITE_CODES: invite, SONIC_ENABLE_OAUTH: '0', SONIC_RATE_LIMIT_ANON_RPM: '50',
  SONIC_TIMEOUT_MS: '500',
};
let runtime;
let engine;
const engineCalls = [];
let redirectEngine = false;
let providerRequests = 0;
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
    serviceBindings: { ASSETS: async () => new Response('Sonic asset') },
    outboundService: async request => {
      const target = new URL(request.url);
      if (target.origin === 'https://music.163.com' && target.pathname === '/api/linux/forward') {
        providerRequests++;
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')); },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(target.origin, engineBindingOrigin, 'Only the local provider fixture and loopback Engine are allowed');
      if (redirectEngine) return new Response(null, { status: 307, headers: { Location: 'https://unused.sonic.test/' } });
      const result = await fetch(`${engineOrigin}${target.pathname}${target.search}`, {
        method: request.method, headers: [...request.headers], redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      engineCalls.push({ path: target.pathname, status: result.status });
      return new Response(await result.arrayBuffer(), { status: result.status, headers: [...result.headers] });
    },
  });
  const staging = { ...env, SONIC_ENV: 'staging', SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
    SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_LOCAL_ENGINE_URL: engineBindingOrigin, SONIC_ENGINE_IDENTITY_SECRET: identity, SONIC_SECRET: signing };
  const unavailable = { SONIC_RATE_LIMIT_BUCKETS: { className: 'UnavailableBucket', scriptName: 'rate-limiter' } };
  runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, workers: [
    worker('pages-a', namespace), worker('pages-b', namespace), worker('pages-no-binding', {}),
    worker('pages-staging', namespace, staging), worker('pages-backend-down', unavailable),
    { name: 'rate-limiter', modules: true, script: `${readFileSync(resolve(root, 'edge-rate-limiter/index.mjs'), 'utf8')}
      export class UnavailableBucket extends DurableObject { fetch() { return new Response(null, {status:503}); } }`,
      compatibilityDate, durableObjects: { LOCAL_BUCKETS: { className: 'SonicRateBucket', useSQLite: true },
        UNAVAILABLE_BUCKETS: { className: 'UnavailableBucket', useSQLite: true } } },
  ] }));
  const loopback = await runtime.ready;
  assert.equal(loopback.hostname, '127.0.0.1');
  const [a, b, broken, localStaging, backendDown] = await Promise.all(
    ['pages-a', 'pages-b', 'pages-no-binding', 'pages-staging', 'pages-backend-down'].map(name => runtime.getWorker(name)));
  const denied = await a.fetch(`http://127.0.0.1${health}`);
  assert.equal(denied.status, 401);
  const ready = await a.fetch(`http://127.0.0.1${health}`, { headers: { 'X-Sonic-Engine-Key': key } });
  assert.equal(ready.status, 200);
  const state = await ready.json();
  assert.equal(state.rateLimit.configuredBackend, 'durable-object');
  assert.equal(state.rateLimit.productionCompliant, true);
  assert.equal(state.release.releaseId, manifest.releaseId);
  assert.equal(state.release.pagesArtifactDigest, pagesArtifactDigest);

  const redeem = (worker, code, ip) => worker.fetch('http://127.0.0.1/api/access/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ code }),
  });
  const entered = await redeem(a, invite, '192.0.2.1');
  assert.equal(entered.status, 200);
  assert.match(entered.headers.get('set-cookie'), /HttpOnly/i);
  const timeout = await a.fetch('http://127.0.0.1/api/sonic/search/nexus?q=local-slow-body', {
    headers: { Cookie: entered.headers.get('set-cookie').split(';', 1)[0], 'CF-Connecting-IP': '192.0.2.1' },
  });
  assert.equal(timeout.status, 200);
  assert.equal(timeout.headers.get('cache-control'), 'no-store');
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
  assert.ok((await search.json()).tracks.length > 0);
  const stream = await localStaging.fetch('http://127.0.0.1/api/music/stream?id=syn-440hz&source=synthetic', {
    headers: { ...headers, Range: 'bytes=0-43' },
  });
  assert.equal(stream.status, 206);
  assert.equal(stream.headers.get('x-sonic-via'), 'local-engine');
  assert.equal(Buffer.from(await stream.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
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
  console.log(JSON.stringify({ ok: true, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest, pagesArtifactDigest,
    workers: 2, requests: burstSize, allowedToReachInviteCheck: 50, rejected429: 150,
    durationMs: Math.round(performance.now() - start), authRequests: 40, authRejected429: 10,
    missingBinding503: true, backendUnavailable503: true, protectedHealth401: true, pagesToEngineRange206: true,
    engineRedirectRejected: true, providerBodyTimeout: true, actualPagesBundle: true }));
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

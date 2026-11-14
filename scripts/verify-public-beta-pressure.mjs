import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const manifestPath = join(root, 'dist', 'release.json');
assert.ok(existsSync(manifestPath), 'Build dist/release.json before running pressure verification');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const workers = Number(process.env.SONIC_PRESSURE_WORKERS || 8);
const requestsPerWorker = Number(process.env.SONIC_PRESSURE_REQUESTS_PER_WORKER || 75);
assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 32, 'SONIC_PRESSURE_WORKERS must be 1..32');
assert.ok(Number.isInteger(requestsPerWorker) && requestsPerWorker >= 10 && requestsPerWorker <= 500, 'SONIC_PRESSURE_REQUESTS_PER_WORKER must be 10..500');

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))].toFixed(2));
}

function localBase(value) {
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'http:', 'Pressure verification only accepts HTTP loopback');
  assert.equal(parsed.hostname, '127.0.0.1', 'Pressure verification only accepts 127.0.0.1');
  return parsed.origin;
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolvePromise => probe.close(resolvePromise));
  assert.ok(port > 0, 'Could not allocate a loopback port');
  return port;
}

function identityAssertion(identitySecret, subject, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    sub: subject,
    mode: 'anonymous-opt-in',
    consent: true,
    method,
    path,
    iat: now,
    exp: now + 30,
  })).toString('base64url');
  const signature = createHmac('sha256', identitySecret)
    .update(`sonic-engine-identity-v1.${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function stats(rows) {
  const values = rows.map(row => row.ms);
  return {
    count: rows.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1),
  };
}

const runtimeRoot = mkdtempSync(join(root, '.pressure-runtime-'));
const shouldSpawn = !process.env.SONIC_PRESSURE_BASE;
const engineKey = randomBytes(32).toString('hex');
const identityKey = randomBytes(32).toString('hex');
const signingKey = randomBytes(32).toString('hex');
let child;
let base;
let childOutput = '';

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolvePromise => {
    child.once('exit', resolvePromise);
    child.kill('SIGTERM');
  });
}

async function request(path, options = {}, subject) {
  const headers = new Headers(options.headers);
  headers.set('X-Sonic-Engine-Key', engineKey);
  if (subject) {
    headers.set('X-Sonic-Verified-Identity', identityAssertion(identityKey, subject, options.method || 'GET', path));
    headers.set('X-Sonic-Identity-Required', '1');
  }
  return fetch(`${base}${path}`, {
    ...options,
    headers,
    redirect: 'error',
    signal: options.signal || AbortSignal.timeout(8000),
  });
}

async function waitReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await request('/api/sonic/engine/health');
      if (response.ok) return await response.json();
      await response.body?.cancel();
    } catch {}
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error('Local Engine did not become ready');
}

async function run() {
  if (shouldSpawn) {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const childEnv = {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      SONIC_RUNTIME: 'linux-engine',
      SONIC_ENV: 'test',
      SONIC_ACCESS_MODE: 'open',
      SONIC_CONTENT_POLICY: 'strict-allowlist',
      SONIC_ALLOWED_SOURCES: 'synthetic',
      SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
      SONIC_ENABLE_OAUTH: '0',
      SONIC_REQUIRE_AUTH: '0',
      SONIC_RATE_LIMIT_ANON_RPM: '100000',
      SONIC_RATE_LIMIT_AUTH_RPM: '100000',
      SONIC_ENGINE_SECRET: engineKey,
      SONIC_ENGINE_IDENTITY_SECRET: identityKey,
      SONIC_SECRET: signingKey,
      SONIC_REQUIRE_ENGINE_IDENTITY: '1',
      SONIC_RECOMMEND_DB_PATH: join(runtimeRoot, 'recommend.sqlite'),
      SONIC_ACCOUNT_DB_PATH: join(runtimeRoot, 'account.sqlite'),
      SONIC_ACCESS_DB_PATH: join(runtimeRoot, 'access.sqlite'),
      SONIC_STATIC_DIR: join(root, 'dist'),
      SONIC_RELEASE_COMMIT: manifest.baseCommit,
      SONIC_RELEASE_ID: manifest.releaseId,
      SONIC_SOURCE_DIGEST: manifest.sourceDigest,
      SONIC_BUILD_TIME: manifest.buildTime,
      SONIC_RELEASE_DIRTY: String(manifest.dirty),
      SONIC_NCM_API_URL: '',
    };
    child = spawn(process.execPath, ['--experimental-sqlite', join(root, 'dist-server', 'index.mjs')], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-12000); });
  } else {
    base = localBase(process.env.SONIC_PRESSURE_BASE);
  }

  const health = await waitReady();
  assert.equal(health.ok, true);
  assert.equal(health.recommendEngine.storageKind, 'sqlite');
  assert.equal(health.release.releaseId, manifest.releaseId);
  assert.equal(health.release.sourceDigest, manifest.sourceDigest);

  const anonymousHealth = await fetch(`${base}/api/sonic/engine/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(anonymousHealth.status, 401);
  await anonymousHealth.body?.cancel();

  const releaseResponse = await request('/release.json');
  assert.equal(releaseResponse.status, 200);
  assert.deepEqual(await releaseResponse.json(), manifest);

  const pressureStart = performance.now();
  const baseline = [];
  const record = async (kind, operation) => {
    const start = performance.now();
    const response = await operation();
    baseline.push({ kind, ms: performance.now() - start, status: response.status });
    return response;
  };

  const search = await record('search', () => request('/api/sonic/search/nexus?q=Sonic&count=3'));
  assert.equal(search.status, 200);
  assert.ok((await search.json()).data.tracks.length > 0);

  const full = await record('stream-200', () => request('/api/music/stream?id=syn-440hz&source=synthetic'));
  assert.equal(full.status, 200);
  const fullBytes = Buffer.from(await full.arrayBuffer());
  assert.equal(fullBytes.toString('ascii', 0, 4), 'RIFF');

  const range = await record('stream-206', () => request('/api/music/stream?id=syn-440hz&source=synthetic', { headers: { Range: 'bytes=0-1023' } }));
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 1024);

  const invalidRange = await record('stream-416', () => request('/api/music/stream?id=syn-440hz&source=synthetic', { headers: { Range: `bytes=${fullBytes.length}-` } }));
  assert.equal(invalidRange.status, 416);
  await invalidRange.body?.cancel();

  const unavailable = await record('stream-404', () => request('/api/music/stream?id=pressure-missing&source=synthetic'));
  assert.equal(unavailable.status, 404);
  assert.equal((await unavailable.json()).error.code, 'STREAM_NOT_FOUND');

  const cancelled = [];
  for (let i = 0; i < 16; i++) {
    const controller = new AbortController();
    controller.abort();
    try {
      await request('/api/sonic/search/nexus?q=Sonic&count=1', { signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') cancelled.push(i);
    }
  }
  assert.equal(cancelled.length, 16);

  const subjects = Array.from({ length: workers }, (_, index) => `anon_${createHash('sha256').update(`public-beta-pressure-${index}`).digest('hex').slice(0, 24)}`);
  const workload = [];
  await Promise.all(subjects.map(async (subject, worker) => {
    for (let index = 0; index < requestsPerWorker; index++) {
      const kind = ['search', 'range', 'error', 'event', 'profile'][index % 5];
      const start = performance.now();
      let response;
      if (kind === 'search') {
        response = await request('/api/sonic/search/nexus?q=Sonic&count=3');
        assert.equal(response.status, 200);
        assert.ok((await response.json()).data.tracks.length > 0);
      } else if (kind === 'range') {
        const isInvalid = index % 10 === 6;
        response = await request('/api/music/stream?id=syn-440hz&source=synthetic', {
          headers: { Range: isInvalid ? 'bytes=999999999-' : 'bytes=0-1023' },
        });
        assert.equal(response.status, isInvalid ? 416 : 206);
        await response.arrayBuffer();
      } else if (kind === 'error') {
        response = await request(`/api/music/stream?id=pressure-missing-${worker}&source=synthetic`);
        assert.equal(response.status, 404);
        assert.equal((await response.json()).error.code, 'STREAM_NOT_FOUND');
      } else if (kind === 'event') {
        response = await request('/api/sonic/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events: [{ type: 'search', query: `pressure-${worker}`, eventId: `pressure-${worker}-${index}` }] }),
        }, subject);
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.data.accepted, 1);
      } else {
        response = await request('/api/sonic/events', {}, subject);
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.data.storageKind, 'sqlite');
        assert.ok(body.data.recentQueries.every(query => query === `pressure-${worker}`));
      }
      workload.push({ kind, ms: performance.now() - start, status: response.status });
    }
  }));

  const allRows = [...baseline, ...workload];
  const overall = stats(allRows);
  const elapsedMs = performance.now() - pressureStart;
  assert.ok(overall.p95Ms < 2000, `Local pressure P95 ${overall.p95Ms}ms exceeds 2000ms`);
  const byKind = Object.fromEntries([...new Set(allRows.map(row => row.kind))].map(kind => [kind, stats(allRows.filter(row => row.kind === kind))]));

  const privacy = [];
  for (const [index, subject] of subjects.entries()) {
    const profile = await (await request('/api/sonic/events', {}, subject)).json();
    assert.ok(profile.data.recentQueries.every(query => query === `pressure-${index}`));
    privacy.push({ subject, totalEvents: profile.data.totalEvents, isolated: true });
    const cleared = await (await request('/api/sonic/events', { method: 'DELETE' }, subject)).json();
    assert.equal(cleared.data.cleared, true);
  }
  const finalHealth = await (await request('/api/sonic/engine/health')).json();
  assert.equal(finalHealth.ok, true);
  assert.equal(finalHealth.recommendEngine.eventCount, 0);

  const result = {
    ok: true,
    verifiedAt: new Date().toISOString(),
    target: '127.0.0.1 loopback Engine',
    releaseId: manifest.releaseId,
    sourceDigest: manifest.sourceDigest,
    workers,
    requestsPerWorker,
    totalRequests: workload.length + baseline.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    throughputRequestsPerSecond: Number(((workload.length + baseline.length) / (elapsedMs / 1000)).toFixed(2)),
    latency: overall,
    byKind,
    cancellationChecks: cancelled.length,
    privacy,
    eventStoreEmptyAfterCleanup: finalHealth.recommendEngine.eventCount === 0,
    externalNetwork: false,
    limitations: ['Synthetic source only', 'Loopback process only', 'Does not measure public network capacity or real provider availability'],
  };
  const evidencePath = join(root, 'reports', 'release-readiness', 'evidence', 'public-beta-pressure.json');
  mkdirSync(join(root, 'reports', 'release-readiness', 'evidence'), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

try {
  await run();
} catch (error) {
  const safe = String(error?.message || error).replaceAll(engineKey, '[redacted]').replaceAll(identityKey, '[redacted]').replaceAll(signingKey, '[redacted]');
  console.error(JSON.stringify({ ok: false, error: safe, engineOutput: childOutput }));
  process.exitCode = 1;
} finally {
  await stopChild();
  rmSync(runtimeRoot, { recursive: true, force: true });
}

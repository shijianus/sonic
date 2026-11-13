import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLiveObservability } from './verify-observability-and-alerts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'dist/release.json'), 'utf8'));
const workers = Number(process.env.SONIC_LOAD_WORKERS || 8);
const requestsPerWorker = Number(process.env.SONIC_LOAD_REQUESTS_PER_WORKER || 75);
assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= 32);
assert.ok(Number.isInteger(requestsPerWorker) && requestsPerWorker >= 10 && requestsPerWorker <= 500 && requestsPerWorker % 5 === 0);
const work = mkdtempSync(join(tmpdir(), 'sonic-mixed-load-'));
const serviceKey = randomBytes(32).toString('hex');
const identityKey = randomBytes(32).toString('hex');
const userKey = randomBytes(32).toString('hex');
const received = [];
const webhook = createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', value => { size += value.length; if (size > 65536) req.destroy(); else chunks.push(value); });
  req.on('end', () => {
    try { received.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { res.writeHead(400); res.end(); return; }
    res.writeHead(204); res.end();
  });
});
await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const engineEnv = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
  HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', SONIC_RUNTIME: 'linux-engine', SONIC_ENV: 'test',
  SONIC_RECOMMEND_DB_PATH: join(work, 'recommend.sqlite'), SONIC_STATIC_DIR: join(root, 'dist'),
  SONIC_ENGINE_SECRET: serviceKey, SONIC_SECRET: userKey, SONIC_ENGINE_IDENTITY_SECRET: identityKey, SONIC_REQUIRE_ENGINE_IDENTITY: '1',
  SONIC_ENABLE_LOCAL_ENGINE: '0', SONIC_LOCAL_ENGINE_URL: '', SONIC_NCM_API_URL: '',
  SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
  SONIC_ENABLE_OAUTH: '0', SONIC_REQUIRE_AUTH: '0', SONIC_RATE_LIMIT_ANON_RPM: '10000', SONIC_RATE_LIMIT_AUTH_RPM: '10000',
  SONIC_ALERT_WEBHOOK_URL: `http://127.0.0.1:${webhook.address().port}/receive`, SONIC_ALERT_ALLOW_LOCALHOST: '1',
  SONIC_ALERT_COOLDOWN_SEC: '1', SONIC_ALERT_MIN_REQUESTS: '100',
  SONIC_SHUTDOWN_TIMEOUT_MS: '5000', SONIC_RELEASE_COMMIT: manifest.baseCommit, SONIC_RELEASE_ID: manifest.releaseId,
  SONIC_SOURCE_DIGEST: manifest.sourceDigest, SONIC_RELEASE_DIRTY: String(manifest.dirty), SONIC_BUILD_TIME: manifest.buildTime,
};
for (const source of ['NETEASE', 'QQ', 'KUGOU', 'KUWO', 'GDSTUDIO', 'LYRIVA', 'AMLL', 'LRCLIB', 'UNBLOCK', 'FREE_CROSS_MATCH']) engineEnv['SONIC_ENABLE_' + source] = '0';
const child = spawn(process.execPath, ['--experimental-sqlite', join(root, 'dist-server/index.mjs')], { cwd: work, env: engineEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-16000); });
const outcomes = [];
function assertion(subject, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: subject, mode: 'anonymous-opt-in', consent: true, method, path, iat: now, exp: now + 30 })).toString('base64url');
  return encoded + '.' + createHmac('sha256', identityKey).update('sonic-engine-identity-v1.' + encoded).digest('base64url');
}
async function request(path, options = {}, subject) {
  const headers = { 'X-Sonic-Engine-Key': serviceKey, ...options.headers };
  if (subject) {
    headers['X-Sonic-Verified-Identity'] = assertion(subject, options.method || 'GET', path);
    headers['X-Sonic-Identity-Required'] = '1';
  }
  return fetch(base + path, { ...options, headers, signal: AbortSignal.timeout(10000) });
}
async function waitReady() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Isolated engine exited before readiness');
    try {
      const response = await request('/api/sonic/engine/health');
      if (response.ok) return await response.json();
      await response.body?.cancel();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated engine readiness timeout');
}
async function stop() {
  if (child.exitCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }
  await new Promise(resolve => webhook.close(resolve));
}
try {
  const initial = await waitReady();
  assert.equal(initial.readiness.identity.ok, true);
  assert.equal(initial.recommendEngine.storageKind, 'sqlite');
  const subjects = Array.from({ length: workers }, (_, i) => 'anon_' + createHash('sha256').update('mixed-load-' + i).digest('hex').slice(0, 24));
  const startedAt = performance.now();
  await Promise.all(subjects.map(async (subject, worker) => {
    for (let i = 0; i < requestsPerWorker; i++) {
      const start = performance.now();
      const kind = ['search', 'range', 'write', 'profile', 'feed'][i % 5];
      let response;
      if (kind === 'search') {
        response = await request('/api/music/search?q=Sonic&source=synthetic&count=3');
        assert.equal(response.status, 200);
        assert.ok((await response.json()).tracks.length > 0);
      } else if (kind === 'range') {
        const invalid = i % 10 === 6;
        response = await request('/api/music/stream?id=syn-440hz&source=synthetic', { headers: { Range: invalid ? 'bytes=999999999-' : 'bytes=0-1023' } });
        assert.equal(response.status, invalid ? 416 : 206);
        const bytes = await response.arrayBuffer();
        if (!invalid) assert.equal(bytes.byteLength, 1024);
      } else if (kind === 'write') {
        response = await request('/api/sonic/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [{ type: 'search', query: `mixed-load-worker-${worker}`, eventId: `load-${worker}-${i}` }] }) }, subject);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.accepted, 1);
        assert.equal(body.data.storageKind, 'sqlite');
      } else if (kind === 'profile') {
        response = await request('/api/sonic/events', {}, subject);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.storageKind, 'sqlite');
        assert.ok(body.data.recentQueries.every(q => q === `mixed-load-worker-${worker}`));
      } else {
        response = await request('/api/sonic/recommend/for-you?count=6&feed=mixed', {}, subject);
        assert.equal(response.status, 200);
        assert.ok(Array.isArray((await response.json()).data));
      }
      outcomes.push({ kind, ms: performance.now() - start, status: response.status });
    }
  }));
  const durationMs = performance.now() - startedAt;
  assert.equal(outcomes.length, subjects.length * requestsPerWorker);
  const percentiles = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { p50Ms: Number(sorted[Math.floor((sorted.length - 1) * 0.5)].toFixed(2)), p95Ms: Number(sorted[Math.floor((sorted.length - 1) * 0.95)].toFixed(2)), maxMs: Number(sorted.at(-1).toFixed(2)) };
  };
  const latency = percentiles(outcomes.map(row => row.ms));
  assert.ok(latency.p95Ms < 2000, 'Local bounded mixed workload exceeded 2s p95 gate');
  for (const subject of subjects) {
    const profile = await (await request('/api/sonic/events', {}, subject)).json();
    assert.equal(profile.data.totalEvents, requestsPerWorker / 5);
    const cleared = await (await request('/api/sonic/events', { method: 'DELETE' }, subject)).json();
    assert.equal(cleared.data.cleared, true);
    assert.equal(cleared.data.removedEvents, requestsPerWorker / 5);
  }
  const finalHealth = await (await request('/api/sonic/engine/health')).json();
  assert.equal(finalHealth.ok, true);
  assert.equal(finalHealth.recommendEngine.eventCount, 0);
  const alerts = await verifyLiveObservability({ env: { SONIC_ENGINE_URL: base, SONIC_ENGINE_SECRET: serviceKey } });
  assert.equal(alerts.ok, true, JSON.stringify(alerts.failures));
  assert.equal(alerts.fullGate, true);
  assert.ok(received.length > 0, 'Test webhook did not receive an alert');
  const result = {
    ok: true, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest, target: 'isolated-local-synthetic-engine',
    workers: subjects.length, requests: outcomes.length, durationMs: Math.round(durationMs), requestsPerSecond: Number((outcomes.length / durationMs * 1000).toFixed(2)),
    latency, byKind: Object.fromEntries(['search', 'range', 'write', 'profile', 'feed'].map(kind => [kind, percentiles(outcomes.filter(row => row.kind === kind).map(row => row.ms))])),
    privacyIsolation: true, temporarySubjectsDeleted: true, webhookReceived: received.length, alertVerification: alerts,
    limitation: 'Bounded local synthetic acceptance only; not production capacity or external webhook/provider availability.',
  };
  const output = join(root, 'reports/release-readiness/evidence/followup/mixed-load.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  let log = childOutput;
  for (const secret of [serviceKey, identityKey, userKey]) log = log.replaceAll(secret, '[redacted]');
  console.error(JSON.stringify({ ok: false, checkedRequests: outcomes.length, error: error.message, engineOutput: log }));
  process.exitCode = 1;
} finally {
  await stop();
  rmSync(work, { recursive: true, force: true });
}

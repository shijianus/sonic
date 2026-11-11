import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] || 18080);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Expected a loopback port');
const environment = process.argv[3] || 'production';
assert.ok(['production', 'staging'].includes(environment), 'Expected a production or staging smoke profile');
const secret = process.env.SONIC_ENGINE_SECRET;
assert.ok(secret, 'SONIC_ENGINE_SECRET is required');
const engineHeaders = { 'X-Sonic-Engine-Key': secret };
const base = `http://127.0.0.1:${port}`;
const healthPath = '/api/sonic/engine/health';
const manifest = JSON.parse(await readFile('dist/release.json', 'utf8'));

function request(path, headers) {
  return fetch(base + path, { headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let failure = 'no response';
  do {
    try {
      const response = await request(healthPath, engineHeaders);
      const health = await response.json();
      if (response.ok && health.ok === true) return { response, health };
      const reasons = health.readiness?.reasons || [health.error?.code].filter(Boolean);
      failure = `HTTP ${response.status}${reasons.length ? ` (${reasons.join(', ')})` : ''}`;
    } catch (error) {
      failure = String(error.cause?.code || error.name);
    }
    if (Date.now() < deadline) await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Engine did not become ready: ${failure}`);
}

const { response, health } = await waitForHealth();
assert.equal(health.release.engineIdentityCompiled, true, 'Engine reports its embedded build identity');
assert.equal(health.release.releaseCommit, manifest.baseCommit);
assert.equal(health.release.environment, environment);
for (const name of ['releaseId', 'sourceDigest', 'buildTime', 'dirty']) {
  assert.equal(health.release[name], manifest[name], `Engine release field ${name}`);
}
assert.equal(health.readiness.access.mode, 'open');
assert.equal(health.readiness.access.explicit, true);
assert.equal(health.recommendEngine.storageKind, 'sqlite');
assert.equal(response.headers.get('x-sonic-release'), manifest.releaseId);

const frontend = await request('/release.json');
assert.equal(frontend.status, 200);
assert.equal(frontend.headers.get('x-sonic-release'), manifest.releaseId);
assert.deepEqual(await frontend.json(), manifest);
for (const path of [healthPath, '/API/Sonic/Engine/Health']) {
  const anonymous = await request(path);
  assert.equal(anonymous.status, 401, `Anonymous health check ${path}`);
  await anonymous.body?.cancel();
}

const stream = '/api/music/stream?id=syn-440hz&source=synthetic';
const full = await request(stream, engineHeaders);
if (environment === 'production') {
  assert.equal(full.status, 403, 'Synthetic test audio must be disabled in production');
  await full.body?.cancel();
  console.log(`Production engine smoke passed for ${manifest.releaseId}: release identity, gated health, SQLite and synthetic audio disabled`);
  process.exit(0);
}
assert.equal(full.status, 200);
const audio = Buffer.from(await full.arrayBuffer());
assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
assert.ok(audio.length > 44);

const range = await request(stream, { ...engineHeaders, Range: 'bytes=0-43' });
assert.equal(range.status, 206);
assert.equal(range.headers.get('content-range'), `bytes 0-43/${audio.length}`);
assert.deepEqual(Buffer.from(await range.arrayBuffer()), audio.subarray(0, 44));

const invalidRange = await request(stream, { ...engineHeaders, Range: `bytes=${audio.length}-` });
assert.equal(invalidRange.status, 416);
assert.equal(invalidRange.headers.get('content-range'), `bytes */${audio.length}`);
await invalidRange.body?.cancel();

console.log(`Engine smoke passed for ${manifest.releaseId}: release identity, gated health, SQLite and WAV 200/206/416`);

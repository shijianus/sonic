import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(resolve(tmpdir()), 'sonic-release-http-'));
const dbPath = join(work, 'recommend.sqlite');
const engineKey = randomBytes(32).toString('hex');
const signingKey = randomBytes(32).toString('hex');
const identityKey = randomBytes(32).toString('hex');
const manifest = JSON.parse(readFileSync(resolve(root, 'dist/release.json'), 'utf8'));
const outcomes = [];
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { 'X-Sonic-Engine-Key': engineKey, 'X-Sonic-Anon-Id': 'anon_release_http_a_20261102', 'X-Sonic-Personalization': 'on' };
// The acceptance engine must never inherit live database paths, upstream
// credentials, or adapter configuration from the operator's shell.
const childEnv = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']
  .filter(name => process.env[name] !== undefined)
  .map(name => [name, process.env[name]]));
const env = {
  ...childEnv,
  NODE_ENV: 'production',
  HOST: '127.0.0.1', PORT: String(port), SONIC_STATIC_DIR: resolve(root, 'dist'),
  SONIC_RECOMMEND_DB_PATH: dbPath, SONIC_ENGINE_SECRET: engineKey, SONIC_SECRET: signingKey,
  SONIC_ENGINE_IDENTITY_SECRET: identityKey, SONIC_REQUIRE_ENGINE_IDENTITY: '1',
  SONIC_ENV: 'staging', SONIC_RUNTIME: 'linux-engine', SONIC_ACCESS_MODE: 'open', SONIC_ENABLE_OAUTH: '0', SONIC_REQUIRE_AUTH: '0',
  SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
  SONIC_ENABLE_NETEASE: '0', SONIC_ENABLE_QQ: '0', SONIC_ENABLE_KUGOU: '0', SONIC_ENABLE_KUWO: '0',
  SONIC_ENABLE_LYRIVA: '0', SONIC_ENABLE_GDSTUDIO: '0', SONIC_ENABLE_AMLL: '0', SONIC_ENABLE_LRCLIB: '0',
  SONIC_ENABLE_UNBLOCK: '0', SONIC_LOCAL_ENGINE_URL: '', SONIC_NCM_API_URL: '', SONIC_ALERT_WEBHOOK_URL: '', SONIC_STAGING_ACCESS_TOKEN: '',
  SONIC_RELEASE_COMMIT: manifest.baseCommit, SONIC_RELEASE_ID: manifest.releaseId,
  SONIC_SOURCE_DIGEST: manifest.sourceDigest, SONIC_RELEASE_DIRTY: String(manifest.dirty), SONIC_BUILD_TIME: manifest.buildTime,
};
let child;
let childOutput = '';
const request = (path, options = {}) => {
  const merged = { ...headers, ...options.headers };
  const now = Math.floor(Date.now() / 1000);
  const subject = 'anon_' + createHash('sha256').update('sonic-subj-v1:anon:' + merged['X-Sonic-Anon-Id']).digest('hex').slice(0, 24);
  const encoded = Buffer.from(JSON.stringify({ v: 1, sub: subject, mode: 'anonymous-opt-in', consent: true, method: options.method || 'GET', path, iat: now, exp: now + 30 })).toString('base64url');
  merged['X-Sonic-Verified-Identity'] = encoded + '.' + createHmac('sha256', identityKey).update('sonic-engine-identity-v1.' + encoded).digest('base64url');
  merged['X-Sonic-Identity-Required'] = '1';
  return fetch(base + path, { ...options, headers: merged, signal: AbortSignal.timeout(10000) });
};
const check = (name, evidence = {}) => outcomes.push({ name, ok: true, ...evidence });
async function start(overrides = {}) {
  childOutput = '';
  child = spawn(process.execPath, ['--experimental-sqlite', resolve(root, 'dist-server/index.mjs')], { cwd: work, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Engine exited before ready: ${childOutput}`);
    try {
      const response = await request('/api/sonic/engine/health');
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.ok, true);
        assert.equal(health.recommendEngine?.storageKind, 'sqlite');
        assert.equal(health.recommendEngine?.erasureRecoveryVersion, 1);
        return health;
      }
      await response.body?.cancel();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Engine readiness timed out: ${childOutput}`);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  const exited = once(current, 'exit');
  current.kill('SIGTERM');
  await exited;
  if (child === current) child = undefined;
}
async function postEvent(identity, eventId, eventEpoch) {
  const response = await request('/api/sonic/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': identity },
    body: JSON.stringify({ events: [{ type: 'search', query: 'release-persistence-check', eventId }], eventEpoch }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  const health = await start({ SONIC_RELEASE_ID: 'incorrect-runtime-release', SONIC_SOURCE_DIGEST: 'f'.repeat(64) });
  assert.equal(health.release.engineIdentityCompiled, true);
  assert.equal(health.release.releaseId, manifest.releaseId);
  assert.equal(health.release.sourceDigest, manifest.sourceDigest);
  check('compiled engine reports matching release identity');
  const frontend = await request('/release.json');
  assert.deepEqual(await frontend.json(), manifest);
  check('served frontend manifest matches backend release');
  for (const path of ['/api/sonic/engine/health', '/proxy', '/proxy/', '/proxy///', '/palette', '/palette/']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 401, path);
    await response.body?.cancel();
  }
  check('engine key enforced for equivalent paths');
  const stream = '/api/music/stream?id=syn-440hz&source=synthetic';
  const head = await request(stream, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const initial = await request(stream, { headers: { Range: 'bytes=0-43' } });
  assert.equal(initial.status, 206);
  const wavHeader = Buffer.from(await initial.arrayBuffer());
  assert.equal(wavHeader.length, 44);
  assert.equal(wavHeader.subarray(0, 4).toString(), 'RIFF');
  const middle = await request(stream, { headers: { Range: 'bytes=16000-16031' } });
  assert.equal(middle.status, 206);
  assert.equal((await middle.arrayBuffer()).byteLength, 32);
  const invalid = await request(stream, { headers: { Range: 'bytes=999999999999-' } });
  assert.equal(invalid.status, 416);
  await invalid.body?.cancel();
  check('HEAD and valid/invalid media ranges', { head: 200, range: 206, invalid: 416 });
  const a = await postEvent('anon_release_http_a_20261102', 'release_same_event_20261102');
  const b = await postEvent('anon_release_http_b_20261102', 'release_same_event_20261102');
  const retry = await postEvent('anon_release_http_a_20261102', 'release_same_event_20261102');
  assert.equal(a.data.accepted, 1);
  assert.equal(b.data.accepted, 1);
  assert.equal(retry.data.deduplicated, 1);
  check('subject-scoped idempotency over real HTTP');
  const backupPath = join(work, 'backup.sqlite');
  const backup = JSON.parse(execFileSync(process.execPath, ['--experimental-sqlite', resolve(root, 'scripts/backup-recommend-db.mjs'), dbPath, backupPath], { env, encoding: 'utf8' }));
  assert.equal(backup.ok, true);
  assert.equal(backup.events, 2);
  check('online backup contains persisted events and a digest', { events: backup.events, sha256: backup.sha256 });
  let refused = false;
  try { execFileSync(process.execPath, ['--experimental-sqlite', resolve(root, 'scripts/restore-recommend-db.mjs'), backupPath, dbPath, '--offline'], { env, stdio: 'pipe' }); }
  catch { refused = true; }
  assert.equal(refused, true);
  check('restore refuses the live database');
  await stop();
  await start();
  const profile = await request('/api/sonic/events');
  const persisted = await profile.json();
  assert.equal(persisted.data.totalEvents, 1);
  check('events survive process restart');
  const heldBody = JSON.stringify({ events: [{ type: 'search', query: 'before-erasure', eventId: 'release_held_event' }] });
  const cleared = await request('/api/sonic/events', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  const erasure = (await cleared.json()).data;
  assert.equal(erasure.cleared, true);
  assert.match(erasure.eventEpoch, /^[0-9a-f]{32}$/);
  const empty = await request('/api/sonic/events');
  assert.equal((await empty.json()).data.totalEvents, 0);
  check('authoritative DELETE removes only the current subject');
  await stop();
  await start();
  const held = await request('/api/sonic/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: heldBody,
  });
  assert.equal(held.status, 409);
  const rejection = await held.json();
  assert.equal(rejection.error.code, 'EVENT_EPOCH_MISMATCH');
  assert.equal(rejection.data.eventEpoch, erasure.eventEpoch);
  assert.equal((await (await request('/api/sonic/events')).json()).data.totalEvents, 0);
  const currentBackupPath = join(work, 'post-erasure-backup.sqlite');
  const currentBackup = JSON.parse(execFileSync(process.execPath, ['--experimental-sqlite', resolve(root, 'scripts/backup-recommend-db.mjs'), dbPath, currentBackupPath], { env, encoding: 'utf8' }));
  assert.equal(currentBackup.events, 1);
  const fresh = await postEvent('anon_release_http_a_20261102', 'release_post_erase_event', erasure.eventEpoch);
  assert.equal(fresh.data.accepted, 1);
  check('erasure marker survives restart and fences held writes over HTTP');
  await stop();
  const recovered = new DatabaseSync(dbPath);
  recovered.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  recovered.close();
  const restore = snapshot => execFileSync(process.execPath, ['--experimental-sqlite', resolve(root, 'scripts/restore-recommend-db.mjs'), snapshot, dbPath, '--offline'], { env, encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => restore(backupPath), error => /snapshot cannot prove it preserves acknowledged erasures/.test(error.stderr));
  const restored = JSON.parse(restore(currentBackupPath));
  assert.equal(restored.ok, true);
  assert.equal(restored.events, 1);
  await start();
  const afterRestore = (await (await request('/api/sonic/events')).json()).data;
  assert.equal(afterRestore.totalEvents, 0);
  assert.equal(afterRestore.eventEpoch, erasure.eventEpoch);
  const otherProfile = (await (await request('/api/sonic/events', { headers: { 'X-Sonic-Anon-Id': 'anon_release_http_b_20261102' } })).json()).data;
  assert.equal(otherProfile.totalEvents, 1);
  const oldBatch = await request('/api/sonic/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: heldBody,
  });
  assert.equal(oldBatch.status, 409);
  await stop();
  check('offline restore refuses pre-erasure snapshots and keeps the erased profile empty and its old batches fenced');
  // Production requires an effective authorized source. The only production
  // media request below explicitly names synthetic, so the policy gate rejects
  // it before resolution and no request reaches the authorized provider.
  const productionHealth = await start({ SONIC_ENV: 'production', SONIC_ALLOWED_SOURCES: 'netease,synthetic', SONIC_ENABLE_NETEASE: '1' });
  assert.equal(productionHealth.flags.enableSynthetic, false);
  assert.deepEqual(productionHealth.readiness.contentPolicy.effectiveSources, ['netease']);
  const disabled = await request(stream);
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error?.code, 'SOURCE_DISABLED_BY_POLICY');
  check('production refuses the synthetic source even when its flag is enabled');
  await stop();
  const result = { ok: true, manifest, runtime: process.version, temporaryDatabase: dbPath, checks: outcomes };
  const output = resolve(root, 'reports/release-readiness/evidence/2026-11-02-release-fix/built-engine-http.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, checks: outcomes, error: error.message, engineOutput: childOutput.slice(-12000) }, null, 2));
  process.exitCode = 1;
} finally { await stop(); }

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { engineEnvironment } from '../scripts/start-bare-metal-engine.mjs';
import { verifyEngineArtifacts, writeArtifactReceipt } from '../scripts/release-artifacts.mjs';

const root = resolve('bare-metal-test-release');
const manifest = {
  schemaVersion: 1, baseCommit: 'a'.repeat(40), releaseId: 'a'.repeat(40),
  sourceDigest: 'b'.repeat(64), buildTime: '2026-11-01T00:00:00.000Z', dirty: false,
};
const env = {
  SONIC_ENV: 'staging', SONIC_ACCESS_MODE: 'open', SONIC_CONTENT_POLICY: 'strict-allowlist',
  SONIC_ALLOWED_SOURCES: 'synthetic', SONIC_RECOMMEND_DB_PATH: resolve('bare-metal-test-data/recommend.sqlite'),
  SONIC_ENGINE_SECRET: 'a'.repeat(32), SONIC_ENGINE_IDENTITY_SECRET: 'b'.repeat(32), SONIC_SECRET: 'c'.repeat(32),
};

test('launch binds a private Engine with the verified release metadata and durable storage', () => {
  const configured = engineEnvironment({ ...env, SONIC_RELEASE_DIRTY: '0' }, manifest, root);
  assert.equal(configured.NODE_ENV, 'production');
  assert.equal(configured.HOST, '127.0.0.1');
  assert.equal(configured.PORT, '8080');
  assert.equal(configured.SONIC_RUNTIME, 'linux-engine');
  assert.equal(configured.SONIC_REQUIRE_ENGINE_IDENTITY, '1');
  assert.equal(configured.SONIC_REQUIRE_RELEASE_METADATA, '1');
  assert.equal(configured.SONIC_STATIC_DIR, resolve(root, 'dist'));
  assert.equal(configured.SONIC_RECOMMEND_DB_PATH, env.SONIC_RECOMMEND_DB_PATH);
  assert.equal(configured.SONIC_RELEASE_COMMIT, manifest.baseCommit);
  assert.equal(configured.SONIC_SOURCE_DIGEST, manifest.sourceDigest);
  assert.equal(configured.SONIC_RELEASE_DIRTY, 'false');
});

test('launch rejects dirty releases, stale overrides and mismatched frontend output paths', () => {
  assert.throws(() => engineEnvironment(env, { ...manifest, dirty: true }, root), /clean release/);
  assert.throws(() => engineEnvironment({ ...env, SONIC_RELEASE_ID: 'stale-release' }, manifest, root), /conflicts/);
  assert.throws(() => engineEnvironment({ ...env, SONIC_STATIC_DIR: 'stale-dist' }, manifest, root), /verified release dist/);
});

test('launch refuses public binds, invalid ports and ambiguous access or content policy', () => {
  for (const [overrides, reason] of [
    [{ HOST: '0.0.0.0' }, /127\.0\.0\.1/],
    [{ PORT: '65536' }, /PORT/],
    [{ SONIC_ENV: 'preview' }, /SONIC_ENV/],
    [{ SONIC_ACCESS_MODE: '' }, /SONIC_ACCESS_MODE/],
    [{ SONIC_CONTENT_POLICY: 'standard' }, /strict-allowlist/],
    [{ SONIC_ALLOWED_SOURCES: ' ' }, /SONIC_ALLOWED_SOURCES/],
  ]) {
    assert.throws(() => engineEnvironment({ ...env, ...overrides }, manifest, root), reason);
  }
});

test('launch refuses missing or reused credentials and ephemeral or shared databases', () => {
  for (const [overrides, reason] of [
    [{ SONIC_ENGINE_SECRET: 'short' }, /SONIC_ENGINE_SECRET/],
    [{ SONIC_ENGINE_IDENTITY_SECRET: env.SONIC_SECRET }, /independent/],
    [{ SONIC_SECRET_PREV: env.SONIC_ENGINE_IDENTITY_SECRET }, /independent/],
    [{ SONIC_RECOMMEND_DB_PATH: 'memory' }, /persistent SQLite path/],
    [{ SONIC_ACCOUNT_DB_PATH: env.SONIC_RECOMMEND_DB_PATH }, /distinct paths/],
    [{ SONIC_ACCESS_MODE: 'invite' }, /SONIC_ACCESS_DB_PATH/],
  ]) {
    assert.throws(() => engineEnvironment({ ...env, ...overrides }, manifest, root), reason);
  }
});

test('launch rejects recommendation memory fallback for persistent releases', () => {
  const production = { ...env, SONIC_ENV: 'production', SONIC_ALLOWED_SOURCES: 'netease' };
  for (const config of [env, production]) {
    assert.throws(
      () => engineEnvironment({ ...config, SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK: '1' }, manifest, root),
      /SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK/,
    );
    assert.doesNotThrow(
      () => engineEnvironment({ ...config, SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK: '0' }, manifest, root),
    );
  }
});

test('production preflight refuses unapproved or unusable content sources', () => {
  const production = { ...env, SONIC_ENV: 'production', SONIC_ALLOWED_SOURCES: 'netease' };
  assert.doesNotThrow(() => engineEnvironment(production, manifest, root));
  assert.throws(
    () => engineEnvironment({ ...production, SONIC_ALLOWED_SOURCES: 'netease,unknown' }, manifest, root),
    /unapproved_sources/,
  );
  assert.throws(
    () => engineEnvironment({ ...production, SONIC_ENABLE_NETEASE: '0' }, manifest, root),
    /no_runtime_enabled_sources/,
  );
});

test('production preflight refuses prohibited switches even with approved sources', () => {
  const production = { ...env, SONIC_ENV: 'production', SONIC_ALLOWED_SOURCES: 'netease' };
  for (const name of ['SONIC_ENABLE_UNBLOCK', 'SONIC_ENABLE_GDSTUDIO', 'SONIC_ENABLE_LYRIVA']) {
    assert.throws(
      () => engineEnvironment({ ...production, [name]: ' YeS ' }, manifest, root),
      new RegExp(`PROHIBITED.*${name}`),
    );
    assert.doesNotThrow(() => engineEnvironment({ ...production, [name]: '0' }, manifest, root));
  }
});

test('preflight rejects unverified, changed, and mismatched release outputs', t => {
  const release = mkdtempSync(join(tmpdir(), 'sonic-bare-metal-'));
  t.after(() => rmSync(release, { recursive: true, force: true }));
  const frontend = join(release, 'dist');
  const engine = join(release, 'dist-server');
  mkdirSync(join(frontend, 'assets'), { recursive: true });
  mkdirSync(engine);
  writeFileSync(join(frontend, 'index.html'), '<script src="/assets/app.js"></script>');
  writeFileSync(join(frontend, 'assets/app.js'), 'document.title = "Sonic";');
  writeFileSync(join(engine, 'index.mjs'), 'export const built = true;');
  assert.throws(() => verifyEngineArtifacts(release, manifest), /Missing or invalid frontend build receipt/);

  writeArtifactReceipt(frontend, 'frontend', manifest);
  writeArtifactReceipt(engine, 'engine', manifest);
  assert.doesNotThrow(() => verifyEngineArtifacts(release, manifest));
  assert.throws(() => verifyEngineArtifacts(release, { ...manifest, buildTime: '2026-11-02T00:00:00.000Z' }), /does not match/);

  writeFileSync(join(engine, 'index.mjs'), 'process.exit(17);');
  assert.throws(() => verifyEngineArtifacts(release, manifest), /engine build output checksum mismatch/);
  writeFileSync(join(engine, 'index.mjs'), 'export const built = true;');
  writeFileSync(join(frontend, 'assets/app.js'), 'document.title = "Stale";');
  assert.throws(() => verifyEngineArtifacts(release, manifest), /frontend build output checksum mismatch/);
});

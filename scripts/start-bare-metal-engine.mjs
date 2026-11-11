import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { validateReleaseManifest, verifyRelease } from './release-inputs.mjs';

const jiti = createJiti(import.meta.url, { fsCache: false });
const { CONTENT_SOURCE_LICENSING_REGISTRY, getContentPolicyReadiness } = jiti('../functions/_lib/sonic/licensing.ts');
const { isEnvEnabled } = jiti('../functions/_lib/sonic/config.ts');

export function engineEnvironment(env, manifest, root) {
  validateReleaseManifest(manifest);
  if (manifest.dirty) throw new Error('Bare-metal Engine requires a clean release manifest');
  if (!['staging', 'production'].includes(env.SONIC_ENV)) throw new Error('Set SONIC_ENV to staging or production');
  if (!['open', 'invite'].includes(env.SONIC_ACCESS_MODE)) throw new Error('Set SONIC_ACCESS_MODE to open or invite');
  if (env.SONIC_CONTENT_POLICY !== 'strict-allowlist' || !env.SONIC_ALLOWED_SOURCES?.trim()) {
    throw new Error('Configure strict-allowlist and the approved SONIC_ALLOWED_SOURCES for this environment');
  }
  if (env.HOST && env.HOST !== '127.0.0.1') throw new Error('Bare-metal Engine must bind to 127.0.0.1');
  const port = env.PORT || '8080';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PORT is invalid');

  const secrets = ['SONIC_ENGINE_SECRET', 'SONIC_ENGINE_IDENTITY_SECRET', 'SONIC_SECRET']
    .map(name => {
      const value = env[name]?.trim();
      if (!value || value.length < 32) throw new Error(`${name} must be at least 32 characters`);
      return value;
    });
  if (new Set(secrets).size !== secrets.length ||
      [env.SONIC_SECRET_PREV, env.SOLARA_SECRET].some(value => value?.trim() === secrets[1])) {
    throw new Error('Engine service, identity and signing keys must be independent');
  }

  if (env.SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK === '1') {
    throw new Error('Unset SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK or set it to 0 for a persistent bare-metal Engine');
  }
  const paths = ['SONIC_RECOMMEND_DB_PATH', 'SONIC_ACCOUNT_DB_PATH', 'SONIC_ACCESS_DB_PATH']
    .flatMap((name, index) => {
      const value = env[name]?.trim();
      if (!value && index !== 0 && !(index === 2 && env.SONIC_ACCESS_MODE === 'invite')) return [];
      if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute persistent SQLite path`);
      return [resolve(value)];
    });
  if (new Set(paths).size !== paths.length) throw new Error('Recommendation, account and access databases must use distinct paths');

  const release = {
    SONIC_RELEASE_COMMIT: manifest.baseCommit,
    SONIC_RELEASE_ID: manifest.releaseId,
    SONIC_SOURCE_DIGEST: manifest.sourceDigest,
    SONIC_BUILD_TIME: manifest.buildTime,
    SONIC_RELEASE_DIRTY: 'false',
  };
  for (const [name, value] of Object.entries(release)) {
    const supplied = env[name]?.trim();
    if (supplied && supplied !== value && !(name === 'SONIC_RELEASE_DIRTY' && supplied === '0')) {
      throw new Error(`${name} conflicts with dist/release.json`);
    }
  }
  const staticDir = resolve(root, 'dist');
  if (env.SONIC_STATIC_DIR && resolve(root, env.SONIC_STATIC_DIR) !== staticDir) {
    throw new Error('SONIC_STATIC_DIR must point to the verified release dist directory');
  }
  const configured = {
    ...env, ...release, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: port,
    SONIC_STATIC_DIR: staticDir, SONIC_RUNTIME: 'linux-engine',
    SONIC_REQUIRE_RELEASE_METADATA: '1', SONIC_REQUIRE_ENGINE_IDENTITY: '1',
  };
  const contentPolicy = getContentPolicyReadiness(configured);
  if (!contentPolicy.ok) {
    throw new Error(`Content policy is not deployment-ready: ${contentPolicy.reason || 'misconfigured'}`);
  }
  if (contentPolicy.production) {
    const enabledProhibited = Object.values(CONTENT_SOURCE_LICENSING_REGISTRY)
      .filter(source => source.authorizationStatus === 'PROHIBITED' && isEnvEnabled(configured[source.envSwitch], false))
      .map(source => source.envSwitch);
    if (enabledProhibited.length > 0) {
      throw new Error(`PROHIBITED content source switches are enabled in production: ${enabledProhibited.join(', ')}; set them to 0 and redeploy`);
    }
  }
  return configured;
}

function start(root, args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node --env-file=<config> scripts/start-bare-metal-engine.mjs [--check]');
  }
  const { manifest } = verifyRelease(root, { manifestPath: 'dist/release.json' });
  if (existsSync(resolve(root, '.git'))) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (manifest.baseCommit !== head) throw new Error('Built release does not match the checked-out commit');
  } else {
    const archived = validateReleaseManifest(JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8')));
    const fields = ['baseCommit', 'releaseId', 'sourceDigest', 'buildTime', 'dirty'];
    if (fields.some(field => archived[field] !== manifest[field])) {
      throw new Error('Built release does not match the source archive manifest');
    }
  }
  const entry = resolve(root, 'dist-server/index.mjs');
  for (const output of [entry, resolve(root, 'dist/index.html')]) {
    if (!existsSync(output) || !lstatSync(output).isFile()) {
      throw new Error('Build both the frontend and Engine before starting the release');
    }
  }
  const env = engineEnvironment(process.env, manifest, root);
  if (args[0] === '--check') {
    console.log(JSON.stringify({ ok: true, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest, host: env.HOST, port: Number(env.PORT) }));
    return;
  }

  const child = spawn(process.execPath, ['--experimental-sqlite', entry], { cwd: root, env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  child.once('error', error => {
    console.error(`[bare-metal] Engine could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    start(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2));
  } catch (error) {
    console.error(`[bare-metal] ${error.message}`);
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One reviewed allowlist drives both the distributable and its source digest.
// Do not replace this with a repository-wide copy or a git archive: releases may
// contain explicitly identified dirty fixes, but never local secrets/history.
export const RELEASE_DIRECTORIES = Object.freeze([
  'functions', 'server', 'js', 'player/src', 'player/build', 'player/public',
  'player/scripts', 'tests', 'player/tests', 'player/e2e', '.github',
]);
export const REQUIRED_RELEASE_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'tsconfig.json',
  'Dockerfile', 'Dockerfile.ncm', 'docker-compose.yml', '.dockerignore',
  'ncm-sidecar/package.json', 'ncm-sidecar/package-lock.json',
  '.gitattributes', '.gitignore', '.env.example', 'AGENTS.md',
  'README.md', 'CHECKLIST.log', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'favicon.png', 'favicon.svg',
  'player/package.json', 'player/pnpm-lock.yaml', 'player/pnpm-workspace.yaml',
  'player/.npmrc', 'player/.env.example', 'player/.gitignore', 'player/index.html',
  'player/vite.config.ts', 'player/tsconfig.json', 'player/vitest.config.ts',
  'player/playwright.config.ts', 'player/postcss.config.mjs',
  'player/eslint.config.mjs', 'player/.eslintrc.cjs',
  'player/.prettierignore', 'player/.prettierrc', 'player/LICENSE',
  // These generated declarations are also inputs to typecheck BEFORE a build.
  'player/src/auto-import/imports.d.ts', 'player/src/auto-import/components.d.ts',
  'player/src/vite-env.d.ts', 'player/build/plugins.ts', 'player/build/getEnv.ts',
  'player/build/proxy.ts', 'player/public/_headers', 'player/public/_redirects', 'player/public/bootstrap.js',
  'js/index.js', 'js/playlist-view.js', '.github/workflows/ci.yml',
  'scripts/release-inputs.mjs', 'scripts/write-release-manifest.mjs',
  'scripts/package-release.mjs', 'scripts/prepare-pages-preview.mjs',
  'scripts/pages-release-lib.mjs', 'scripts/verify-pages-deploy-tree.mjs', 'scripts/verify-deployed-release.mjs',
  'scripts/copy-dist.mjs', 'scripts/build-engine.mjs', 'scripts/release-artifacts.mjs', 'scripts/deploy-pages.mjs', 'scripts/lint-theme.mjs',
  'scripts/theme-lint-baseline.json', 'scripts/generate-sbom.mjs',
  'scripts/test-sonic-gateway.mjs', 'scripts/test-auth-compatibility.mjs',
  'scripts/test-cover-gateway.mjs', 'scripts/test-local-engine-and-degradation.mjs',
  'scripts/verify-observability-and-alerts.mjs',
  'scripts/evaluate-recommendation.mjs', 'scripts/evaluate-multi-entity.mjs',
  'scripts/selftest-multi-entity-http.mjs', 'scripts/verify-mixed-load.mjs',
  'scripts/backup-recommend-db.mjs', 'scripts/restore-recommend-db.mjs', 'scripts/revoke-invite.mjs',
  'scripts/recommend-recovery-guard.mjs',
  'scripts/build-staging-release.sh', 'scripts/deploy-staging-engine.py',
  'scripts/verify-staging-candidate.py', 'scripts/verify-staging-live.mjs',
  'scripts/verify-built-release.mjs', 'scripts/verify-engine-smoke.mjs',
  'scripts/start-bare-metal-engine.mjs', 'scripts/rollback-production.sh',
  'docs/RUNBOOK-ROLLBACK.md', 'docs/OPERATIONS.md',
  'docs/release/RELEASE-CHECKLIST.md', 'docs/release/REMOTE-INVITE-BETA-HANDOFF.md',
  'docs/gray-test-multi-entity-windows.md', 'docs/multi-entity-implementation-status.md',
]);
export const INDEX_ALGORITHM = 'sha256-path-size-content-v1';
const METADATA_FILES = new Set(['release.json', 'release-files.json']);
const BUILD_OUTPUTS = new Set([
  'node_modules', 'dist', 'dist-server', 'coverage', '.cache', '.vite',
  '.pnpm-store', 'e2e-results', 'e2e-report', 'test-results', '__pycache__',
]);
const PRIVATE_DIRECTORIES = new Set([
  '.git', '.wrangler', '.deploy', '.zcode', '.ssh', '.aws', '.azure',
  'data', 'reports', 'cache', 'backups', 'rollback-data',
]);
const EXAMPLE_FILES = new Set(['.env.example', 'player/.env.example']);
const GENERATED_FILES = new Set(['player/src/auto-import/eslintrc-auto-import.json']);

function safeName(name) {
  return typeof name === 'string' && name.length > 0
    && !/[\\\x00-\x1f\x7f:]/.test(name)
    && !name.split('/').some(part => !part || part === '.' || part === '..');
}

// Filter by names BEFORE opening files. Never inspect a credential to decide
// whether it should be shipped. Examples are only allowed at two exact paths.
export function excludedReleasePath(name) {
  if (GENERATED_FILES.has(name)) return true;
  // The reviewed delivery checklist is intentionally shipped even though the
  // generic exclusion rules drop *.log files (which normally contain secrets).
  if (name === 'CHECKLIST.log') return false;
  const parts = name.split('/');
  return parts.some(part => {
    const lower = part.toLowerCase();
    return BUILD_OUTPUTS.has(lower) || PRIVATE_DIRECTORIES.has(lower)
      || (/^\.env(?:\.|$)/i.test(part) && !EXAMPLE_FILES.has(name))
      || /^(?:credentials?|secrets?|cookies?|storage[-_]?state|auth[-_]?state)(?:[._-]|$)/i.test(part)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part)
      || /(?:^|[._-])(?:results?|reports?|evidence)(?:[._-]|$)/i.test(part)
      || /\.(?:pem|key|p12|pfx|jks|keystore|log|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|zip|tar|gz|webm|pyc|tsbuildinfo)$/i.test(part)
      || /(?:~|\.bak|\.tmp|\.swp)$/i.test(part);
  });
}

function inspect(root, name) {
  if (!safeName(name)) throw new Error(`Unsafe release path: ${name}`);
  let current = root;
  let stat;
  for (const part of name.split('/')) {
    current = join(current, part);
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing required release input: ${name}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed in release inputs: ${name}`);
  }
  if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard link not allowed in release inputs: ${name}`);
  return stat;
}

export function collectReleaseInputs(root) {
  root = resolve(root);
  const names = new Set();
  for (const name of REQUIRED_RELEASE_FILES) {
    if (excludedReleasePath(name) || !inspect(root, name).isFile()) {
      throw new Error(`Required release input is not a regular distributable file: ${name}`);
    }
    names.add(name);
  }
  function walk(name) {
    if (excludedReleasePath(name)) return;
    const stat = inspect(root, name);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(join(root, name))) walk(`${name}/${entry}`);
    } else if (stat.isFile()) {
      names.add(name);
    } else {
      throw new Error(`Non-regular release input: ${name}`);
    }
  }
  for (const name of RELEASE_DIRECTORIES) {
    if (!inspect(root, name).isDirectory()) throw new Error(`Required release directory missing: ${name}`);
    const before = names.size;
    walk(name);
    if (names.size === before && ![...names].some(file => file.startsWith(`${name}/`))) {
      throw new Error(`Required release directory is empty: ${name}`);
    }
  }
  // Default JS string ordering is locale-independent; hash exact bytes, not
  // normalized text. The framing matches path + NUL + byte length + NUL + data.
  const hash = createHash('sha256');
  const files = [...names].sort().map(name => {
    const data = readFileSync(join(root, name));
    hash.update(`${name}\0${data.length}\0`);
    hash.update(data);
    return { path: name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  });
  return { sourceDigest: hash.digest('hex'), files };
}

export function assertSuppliedDigest(sourceDigest, supplied = process.env.SONIC_SOURCE_DIGEST) {
  const digest = String(supplied || '').trim().toLowerCase();
  if (digest && !/^[a-f0-9]{64}$/.test(digest)) throw new Error('SONIC_SOURCE_DIGEST must be a SHA-256 digest');
  if (digest && digest !== sourceDigest) throw new Error('SONIC_SOURCE_DIGEST does not match the full source checkout');
}

export function validateReleaseManifest(manifest, { allowUnknownCommit = false } = {}) {
  if (!manifest || manifest.schemaVersion !== 1
    || !(typeof manifest.baseCommit === 'string' && (/^[a-f0-9]{40}$/i.test(manifest.baseCommit) || (allowUnknownCommit && manifest.baseCommit === 'unknown')))
    || typeof manifest.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sourceDigest)
    || typeof manifest.releaseId !== 'string' || !/^[a-zA-Z0-9._-]{7,128}$/.test(manifest.releaseId)
    || typeof manifest.buildTime !== 'string' || !Number.isFinite(Date.parse(manifest.buildTime))
    || typeof manifest.dirty !== 'boolean') {
    throw new Error('Invalid release manifest');
  }
  return manifest;
}

function manifestDigest(manifest) {
  // Bind all existing wire identity fields without adding fields to release.json.
  const { schemaVersion, baseCommit, sourceDigest, releaseId, buildTime, dirty } = manifest;
  return createHash('sha256').update(JSON.stringify({ schemaVersion, baseCommit, sourceDigest, releaseId, buildTime, dirty })).digest('hex');
}

export function createReleaseFileIndex(manifest, inputs) {
  validateReleaseManifest(manifest);
  if (manifest.sourceDigest !== inputs.sourceDigest) throw new Error('Source changed after build; rebuild before packaging');
  return {
    schemaVersion: 1, algorithm: INDEX_ALGORITHM,
    sourceDigest: inputs.sourceDigest, manifestSha256: manifestDigest(manifest),
    files: inputs.files,
  };
}

function verifyIndex(index, manifest, inputs) {
  const expected = createReleaseFileIndex(manifest, inputs);
  if (!index || index.schemaVersion !== 1 || index.algorithm !== INDEX_ALGORITHM
    || index.sourceDigest !== expected.sourceDigest || index.manifestSha256 !== expected.manifestSha256) {
    throw new Error('Release manifest/file index metadata mismatch');
  }
  if (!Array.isArray(index.files) || index.files.length !== expected.files.length) {
    throw new Error('Release file index does not match the complete input list');
  }
  for (let i = 0; i < expected.files.length; i++) {
    const actual = index.files[i];
    const wanted = expected.files[i];
    if (!actual || !safeName(actual.path) || actual.path !== wanted.path
      || actual.size !== wanted.size || actual.sha256 !== wanted.sha256) {
      throw new Error(`Release file index mismatch at ${wanted.path}`);
    }
  }
}

function verifyExtractedFileSet(root, inputs, metadataNames) {
  const allowed = new Set([...inputs.files.map(file => file.path), ...metadataNames]);
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      // Frozen installs and local checks may already have produced these. They
      // are not source inputs and .dockerignore never sends them to Docker.
      if (BUILD_OUTPUTS.has(entry.name.toLowerCase()) || GENERATED_FILES.has(name) || /\.(?:pyc|tsbuildinfo)$/.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in extracted release: ${name}`);
      if (entry.isDirectory()) walk(join(directory, entry.name), `${name}/`);
      else if (!entry.isFile() || !allowed.has(name)) throw new Error(`Unindexed file in extracted release: ${name}`);
    }
  }
  walk(root);
}

export function verifyRelease(root, { manifestPath = 'release.json', indexPath } = {}) {
  root = resolve(root);
  if (!inspect(root, manifestPath).isFile()) throw new Error('Release manifest is not a regular file');
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(join(root, manifestPath), 'utf8')));
  const inputs = collectReleaseInputs(root);
  assertSuppliedDigest(inputs.sourceDigest);
  if (manifest.sourceDigest !== inputs.sourceDigest) throw new Error('Source digest mismatch: source changed after build or extraction is incomplete');
  if (indexPath) {
    if (!inspect(root, indexPath).isFile()) throw new Error('Release file index is not a regular file');
    verifyIndex(JSON.parse(readFileSync(join(root, indexPath), 'utf8')), manifest, inputs);
    verifyExtractedFileSet(root, inputs, new Set([...METADATA_FILES, manifestPath, indexPath]));
  }
  return { manifest, ...inputs };
}

export function copyReleaseInputs(root, destination, files) {
  for (const { path: name } of files) {
    if (excludedReleasePath(name) || !inspect(root, name).isFile()) throw new Error(`Unsafe release copy: ${name}`);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, name), target, constants.COPYFILE_EXCL);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--verify' || !args[1] || (args.length !== 2 && (args.length !== 4 || args[2] !== '--index' || !args[3]))) {
      throw new Error('Usage: node scripts/release-inputs.mjs --verify <manifest> [--index <file-index>] (from release root)');
    }
    const verified = verifyRelease(process.cwd(), { manifestPath: args[1], indexPath: args[3] });
    console.log(JSON.stringify({ ok: true, verification: 'full-source', sourceDigest: verified.sourceDigest, releaseId: verified.manifest.releaseId, fileCount: verified.files.length, indexVerified: Boolean(args[3]) }));
  } catch (error) {
    console.error(`[release-inputs] ${error.message}`);
    process.exitCode = 1;
  }
}

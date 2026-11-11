// Build an isolated Pages deployment tree whose functions carry the exact
// release identity that was verified from dist/release.json.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyReleaseInputs, excludedReleasePath, verifyRelease } from './release-inputs.mjs';

const stagingOrigin = 'https://sonic-staging.pages.dev';
const productionChecks = [
  'oauthLoginAndRevocation', 'authorizedMediaPlaybackAndSeek', 'lyricsSync', 'imageAndSqliteRollback',
];

export function parseDeploymentOrigin(value, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('A valid deployment origin is required'); }
  const loopback = allowLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a canonical HTTPS deployment origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function isStagingPreview(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sonic-staging\.pages\.dev$/.test(value);
}

export function assertStagingAcceptance(evidence, manifest, pagesArtifactDigest, { production = false } = {}) {
  const fail = () => { throw new Error('Accepted live Staging evidence must match this exact release and Pages output'); };
  if (evidence?.ok !== true || evidence.mode !== 'staging-live' ||
      evidence.engineStorage !== 'sqlite' || evidence.independentIdentityBindingPresent !== true ||
      evidence.authenticatedIdentityAssertionLiveVerified !== true ||
      !/^[a-f0-9]{64}$/.test(pagesArtifactDigest) || evidence.pagesArtifactDigest !== pagesArtifactDigest ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(evidence.deploymentId || '') ||
      !['baseCommit', 'releaseId', 'sourceDigest', 'buildTime', 'dirty'].every(key => evidence[key] === manifest[key])) fail();
  const checks = evidence.checks;
  if (!Array.isArray(checks) || checks.length < 12 ||
      checks.some(check => check?.ok !== true || typeof check.name !== 'string' || !check.name.trim()) ||
      new Set(checks.map(check => check.name)).size !== checks.length) fail();
  if (!production) {
    if (evidence.branch === 'staging' || !isStagingPreview(evidence.base) ||
        !isStagingPreview(evidence.branchUrl) || evidence.branchUrl !== `https://${evidence.branch}.sonic-staging.pages.dev`) fail();
    return;
  }
  if (manifest.dirty !== false || evidence.branch !== 'staging' ||
      evidence.base !== stagingOrigin || evidence.branchUrl !== stagingOrigin) fail();
  for (const key of productionChecks) {
    const check = evidence.productionChecks?.[key];
    if (check?.ok !== true || typeof check.evidence !== 'string' || !check.evidence.trim()) {
      throw new Error(`Production requires passing Staging evidence for ${key}`);
    }
  }
}

export function readStagingAcceptance(path, manifest, pagesArtifactDigest, options) {
  let evidence;
  try { evidence = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Unable to read accepted live Staging evidence as JSON'); }
  assertStagingAcceptance(evidence, manifest, pagesArtifactDigest, options);
}

function digestPagesOutput(output) {
  const hash = createHash('sha256');
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      const relative = `${prefix}${name}`;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else if (stat.isFile()) {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        hash.update(JSON.stringify([relative, digest]) + '\n');
      } else throw new Error(`Invalid file in Pages output: ${relative}`);
    }
  }
  visit(output);
  return hash.digest('hex');
}

export function buildPagesDeploymentTree(root, { manifestPath = 'dist/release.json' } = {}) {
  root = resolve(root);
  const absoluteManifest = resolve(root, manifestPath);
  if (!existsSync(absoluteManifest)) throw new Error('Build the release first: npm run build');
  const verified = verifyRelease(root, { manifestPath });
  const { manifest } = verified;
  const stagingRoot = mkdtempSync(join(tmpdir(), 'sonic-pages-deploy-'));
  try {
    copyReleaseInputs(
      root,
      stagingRoot,
      verified.files.filter(file =>
        file.path.startsWith('functions/') ||
        ['package.json', 'package-lock.json', 'tsconfig.json'].includes(file.path)
      ),
    );
    const output = resolve(root, 'dist');
    const stagedOutput = join(stagingRoot, 'dist');
    cpSync(output, stagedOutput, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: path => {
        const name = path.slice(output.length + 1).replaceAll('\\', '/');
        // Vite's .js.gz/.css.gz files are build output, not source archives.
        if (excludedReleasePath(name.replace(/\.gz$/i, ''))) return false;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
          throw new Error(`Link not allowed in Pages output: ${name}`);
        }
        return true;
      },
    });
    const pagesArtifactDigest = digestPagesOutput(stagedOutput);
    const compiledPath = join(stagingRoot, 'functions/_lib/sonic/compiled-release.ts');
    const identity = {
      baseCommit: manifest.baseCommit,
      sourceDigest: manifest.sourceDigest,
      releaseId: manifest.releaseId,
      buildTime: manifest.buildTime,
      dirty: manifest.dirty,
      pagesArtifactDigest,
    };
    writeFileSync(compiledPath, `export const COMPILED_RELEASE = ${JSON.stringify(identity)};\n`);
    return { stagingRoot, manifest, pagesArtifactDigest, verified };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

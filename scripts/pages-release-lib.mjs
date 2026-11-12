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

export function deploymentSourceIds(value) {
  return [...new Set(String(value ?? '').split(',').map(source => source.trim().toLowerCase()).filter(Boolean))].sort();
}

async function readCloudflarePages(path, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true || !payload.result) {
    throw new Error(`Unable to verify the production Pages project or domain (HTTP ${response.status})`);
  }
  return payload.result;
}

function enabledByDefault(value) {
  return value === undefined || value === null || value === '' || /^(?:1|true|on|yes)$/i.test(String(value).trim());
}

export async function verifyProductionPagesBinding({ pagesOrigin, engineOrigin, env = process.env }) {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const project = env.CF_PAGES_PROJECT?.trim();
  const branch = env.CF_PAGES_BRANCH?.trim();
  if (!/^[0-9a-f]{32}$/i.test(account || '')) throw new Error('A valid CLOUDFLARE_ACCOUNT_ID is required');
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required to verify the production Pages project');
  if (!/^[a-z0-9-]{1,63}$/.test(project || '') || project === 'sonic-staging') {
    throw new Error('A production CF_PAGES_PROJECT is required');
  }
  const path = `/accounts/${account}/pages/projects/${project}`;
  const configured = await readCloudflarePages(path, token);
  if (configured.name !== project || !configured.production_branch || (branch && configured.production_branch !== branch)) {
    throw new Error('CF_PAGES_PROJECT or CF_PAGES_BRANCH differs from the production project');
  }
  if (pagesOrigin) {
    const { hostname, port } = new URL(parseDeploymentOrigin(pagesOrigin));
    if (port) throw new Error('Production Pages verification requires the default HTTPS port');
    if (hostname !== String(configured.subdomain ?? '').toLowerCase()) {
      const domain = await readCloudflarePages(`${path}/domains/${encodeURIComponent(hostname)}`, token);
      if (String(domain.name ?? '').toLowerCase() !== hostname || domain.status !== 'active') {
        throw new Error('Production Pages verification origin is not an active domain of the configured project');
      }
    }
  }

  const variables = configured.deployment_configs?.production?.env_vars;
  const value = key => variables?.[key]?.value;
  const configuredEngine = value('SONIC_LOCAL_ENGINE_URL');
  if (!configuredEngine || parseDeploymentOrigin(configuredEngine) !== engineOrigin || !enabledByDefault(value('SONIC_ENABLE_LOCAL_ENGINE'))) {
    throw new Error('Production Pages Engine binding differs from SONIC_DEPLOY_VERIFY_ENGINE_URL or is disabled');
  }
  const normalized = key => String(value(key) ?? '').trim().toLowerCase();
  const environment = normalized('SONIC_ENV');
  if (environment !== 'production' || normalized('SONIC_RUNTIME') === 'linux-engine') {
    throw new Error('Production Pages must use the Pages runtime and production environment');
  }
  const expectedAccess = env.SONIC_ACCESS_MODE?.trim().toLowerCase();
  if (!['open', 'invite'].includes(expectedAccess) || normalized('SONIC_ACCESS_MODE') !== expectedAccess) {
    throw new Error('Production Pages SONIC_ACCESS_MODE differs from the expected access mode');
  }
  const expectedSources = deploymentSourceIds(env.SONIC_ALLOWED_SOURCES);
  if (!['strict', 'strict-allowlist', 'allowlist', 'controlled-beta'].includes(normalized('SONIC_CONTENT_POLICY')) ||
      !expectedSources.length || JSON.stringify(deploymentSourceIds(value('SONIC_ALLOWED_SOURCES'))) !== JSON.stringify(expectedSources)) {
    throw new Error('Production Pages content policy differs from the expected source allowlist');
  }
  if (!enabledByDefault(value('SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT')) || !enabledByDefault(value('SONIC_RATE_LIMIT_FAIL_CLOSED'))) {
    throw new Error('Production Pages rate-limit policy must require the distributed limiter and fail closed');
  }
}

function isStagingPreview(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sonic-staging\.pages\.dev$/.test(value);
}

export function assertStagingAcceptance(evidence, manifest, pagesArtifactDigest, { production = false, productionSources = [] } = {}) {
  const fail = () => { throw new Error('Accepted live Staging evidence must match this exact release and Pages output'); };
  const identityMatches = value => ['baseCommit', 'releaseId', 'sourceDigest', 'buildTime', 'dirty'].every(key => value?.[key] === manifest[key]);
  if (evidence?.ok !== true || evidence.mode !== 'staging-live' ||
      evidence.engineStorage !== 'sqlite' || evidence.engineErasureRecoveryVersion !== 1 || evidence.independentIdentityBindingPresent !== true ||
      evidence.authenticatedIdentityAssertionLiveVerified !== true || evidence.eventEpochLiveVerified !== true ||
      evidence.engineRelease?.engineIdentityCompiled !== true || !identityMatches(evidence.engineRelease) ||
      !/^[a-f0-9]{64}$/.test(pagesArtifactDigest) || evidence.pagesArtifactDigest !== pagesArtifactDigest ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(evidence.deploymentId || '') ||
      !identityMatches(evidence)) fail();
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
  if (evidence.accessGateMode !== 'invite' || evidence.inviteAccessLiveVerified !== true) {
    throw new Error('Production requires live product invite access verification on stable Staging');
  }
  for (const key of productionChecks) {
    const check = evidence.productionChecks?.[key];
    if (check?.ok !== true || typeof check.evidence !== 'string' || !check.evidence.trim()) {
      throw new Error(`Production requires passing Staging evidence for ${key}`);
    }
  }
  const realSources = productionSources.filter(source => source !== 'synthetic');
  if (!realSources.length) throw new Error('Production requires a non-synthetic source in SONIC_ALLOWED_SOURCES');
  for (const runtime of ['pages', 'engine']) {
    const policy = evidence.stagingContentPolicy?.[runtime];
    if (policy?.ok !== true || policy.mode !== 'strict-allowlist' ||
        !Array.isArray(policy.allowedSources) || !Array.isArray(policy.effectiveSources)) {
      throw new Error(`Production requires live strict source policy evidence from Staging ${runtime}`);
    }
    const missing = realSources.filter(source => !policy.allowedSources.includes(source) || !policy.effectiveSources.includes(source));
    if (missing.length) throw new Error(`Production sources were not enabled on Staging ${runtime}: ${missing.join(', ')}`);
  }
  for (const source of realSources) {
    const check = evidence.productionChecks?.sourceAcceptance?.[source];
    if (check?.ok !== true || typeof check.evidence !== 'string' || !check.evidence.trim()) {
      throw new Error(`Production requires passing Staging source evidence for ${source}`);
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

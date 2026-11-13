// Build an isolated Pages deployment tree whose functions carry the exact
// release identity that was verified from dist/release.json.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { copyReleaseInputs, excludedReleasePath, verifyRelease } from './release-inputs.mjs';

const stagingOrigin = 'https://sonic-staging.pages.dev';
const productionChecks = [
  'oauthLoginAndRevocation', 'authorizedMediaPlaybackAndSeek', 'lyricsSync', 'imageAndSqliteRollback',
  'capacityAndAlertDelivery', 'realDevicesAndAccessibility', 'releaseOwnerApproval',
];
const stableProbeNames = [
  'Cloudflare confirms the stable staging branch deployment',
  'invite entry is reachable with noindex and protected API denies anonymous access',
  'disposable invite redeems into a secure expiring session and invalid Cookie is rejected',
  'consumed invite cannot be redeemed again and protected results are not cacheable',
  'durable invite logout revokes the issued session and rejects its replay',
  'Pages and Engine release identities match and direct Engine health is private and durable',
  'synthetic search returns real catalog results through the staging Engine',
  'Engine-backed audio HEAD, RIFF bytes, seek ranges 206 and invalid range 416',
  'anonymous consent, durable isolation, deduplication and erasure epoch verified through Pages and Engine',
  'temporary live-test subjects deleted and absence confirmed directly on Engine',
  'authenticated subject parity, erasure epoch and invalid Engine signature rejection',
];
const sha256 = /^[a-f0-9]{64}$/;
const namespaceId = /^[a-f0-9]{32}$/;

export function strictEdgeRateLimitReady(rateLimit) {
  return rateLimit?.configuredBackend === 'durable-object' && rateLimit.distributedAtomic === true &&
    rateLimit.requireDistributed === true && rateLimit.failClosedOnDegrade === true && rateLimit.productionCompliant === true;
}

export function durablePagesInviteReady(access) {
  return access?.mode === 'invite' && access.explicit === true && access.ok === true &&
    access.backend === 'durable-object' && access.durableRequired === true && access.storeUsable === true &&
    access.singleUse === true && access.revocable === true;
}

export function durablePagesInviteNamespace(config) {
  const access = config?.durable_object_namespaces?.SONIC_ACCESS_BUCKETS?.namespace_id;
  const limiter = config?.durable_object_namespaces?.SONIC_RATE_LIMIT_BUCKETS?.namespace_id;
  const vars = config?.env_vars;
  const required = vars?.SONIC_REQUIRE_DURABLE_INVITES;
  const mode = vars?.SONIC_ACCESS_MODE;
  return config?.fail_open !== true && namespaceId.test(access || '') && access !== limiter && mode?.type === 'plain_text' &&
    String(mode.value).trim().toLowerCase() === 'invite' && required?.type === 'plain_text' &&
    /^(?:1|true|on|yes)$/i.test(String(required.value).trim()) && vars?.SONIC_INVITE_CODES?.type === 'secret_text'
    ? access : null;
}

export async function verifyStableStagingInviteTarget(previewEvidence, env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(account || '') || !token) throw new Error('Cloudflare project read access is required to confirm stable Staging invite bindings');
  const project = await readCloudflarePages(`/accounts/${account}/pages/projects/sonic-staging`, token);
  const stable = durablePagesInviteNamespace(project.deployment_configs?.production);
  const preview = durablePagesInviteNamespace(project.deployment_configs?.preview);
  if (project.name !== 'sonic-staging' || project.production_branch !== 'staging' || !stable ||
      !preview || preview !== previewEvidence.stagingAccessNamespaceId || stable === preview) {
    throw new Error('Stable Staging promotion requires a durable invite namespace separate from the verified preview');
  }
}

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

  const config = configured.deployment_configs?.production;
  const variables = config?.env_vars;
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
  const expectedNamespace = env.SONIC_PRODUCTION_RATE_LIMIT_NAMESPACE_ID?.trim();
  if (!namespaceId.test(expectedNamespace || '') || config?.durable_object_namespaces?.SONIC_RATE_LIMIT_BUCKETS?.namespace_id !== expectedNamespace) {
    throw new Error('Production Pages SONIC_RATE_LIMIT_BUCKETS Durable Object binding is missing or points at the wrong namespace');
  }
  if (expectedAccess === 'invite') {
    const expectedAccessNamespace = env.SONIC_PRODUCTION_ACCESS_NAMESPACE_ID?.trim();
    if (!expectedAccessNamespace || durablePagesInviteNamespace(config) !== expectedAccessNamespace) {
      throw new Error('Production invite Pages requires SONIC_REQUIRE_DURABLE_INVITES, a secret SONIC_INVITE_CODES and the expected SONIC_ACCESS_BUCKETS namespace');
    }
  } else if (value('SONIC_REQUIRE_DURABLE_INVITES') && enabledByDefault(value('SONIC_REQUIRE_DURABLE_INVITES'))) {
    throw new Error('Production open Pages cannot require durable invites');
  }
}

export async function verifyAcceptedStableDeployment(evidence, manifest, pagesArtifactDigest, env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const path = `/accounts/${account}/pages/projects/sonic-staging`;
  const project = await readCloudflarePages(path, token);
  const config = project.deployment_configs?.production;
  const currentNamespace = config?.durable_object_namespaces?.SONIC_RATE_LIMIT_BUCKETS?.namespace_id;
  if (project.name !== 'sonic-staging' || project.production_branch !== 'staging' || project.canonical_deployment?.id !== evidence.deploymentId ||
      currentNamespace !== evidence.stagingRateLimitNamespaceId || currentNamespace === env.SONIC_PRODUCTION_RATE_LIMIT_NAMESPACE_ID?.trim()) {
    throw new Error('Stable Staging limiter binding changed or is shared with production');
  }
  const accessNamespace = durablePagesInviteNamespace(config);
  const previewAccessNamespace = project.deployment_configs?.preview?.durable_object_namespaces?.SONIC_ACCESS_BUCKETS?.namespace_id;
  const productionAccessNamespace = env.SONIC_ACCESS_MODE?.trim().toLowerCase() === 'invite' ? env.SONIC_PRODUCTION_ACCESS_NAMESPACE_ID?.trim() : null;
  if (!accessNamespace || accessNamespace !== evidence.stagingAccessNamespaceId ||
      accessNamespace === previewAccessNamespace || (productionAccessNamespace &&
        [accessNamespace, previewAccessNamespace].includes(productionAccessNamespace))) {
    throw new Error('Stable Staging invite binding changed or is shared with another environment');
  }
  const deployment = await readCloudflarePages(`${path}/deployments/${evidence.deploymentId}`, token);
  if (deployment.id !== evidence.deploymentId || deployment.environment !== 'production' || deployment.latest_stage?.status !== 'success' ||
      deployment.deployment_trigger?.metadata?.branch !== 'staging' || deployment.deployment_trigger?.metadata?.commit_hash !== manifest.baseCommit ||
      deployment.deployment_trigger.metadata.commit_dirty === true) {
    throw new Error('Cloudflare does not confirm the accepted Staging deployment');
  }
  const stagingKey = env.SONIC_STAGING_ENGINE_SECRET?.trim();
  if (!stagingKey || stagingKey.length < 32 || stagingKey === env.SONIC_ENGINE_SECRET?.trim()) {
    throw new Error('A separate SONIC_STAGING_ENGINE_SECRET is required to recheck accepted Staging');
  }
  const response = await fetch(`${stagingOrigin}/api/sonic/engine/health?verifyEngine=1`, {
    headers: { 'X-Sonic-Engine-Key': stagingKey, 'Cache-Control': 'no-cache' },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const health = await response.json().catch(() => null);
  const matches = release => release?.releaseCommit === manifest.baseCommit && release.releaseId === manifest.releaseId &&
    release.sourceDigest === manifest.sourceDigest && release.buildTime === manifest.buildTime && release.dirty === false;
  const sameSources = (actual, recorded) => actual?.ok === true && actual.mode === 'strict-allowlist' &&
    ['allowedSources', 'effectiveSources'].every(field => Array.isArray(actual[field]) &&
      JSON.stringify([...actual[field]].sort()) === JSON.stringify([...recorded[field]].sort()));
  if (!response.ok || health?.ok !== true || health.runtime !== 'cf-pages' ||
      response.headers.get('x-sonic-release') !== manifest.releaseId ||
      !matches(health.release) || health.release.pagesArtifactDigest !== pagesArtifactDigest ||
      !['staging', 'preview'].includes(health.release.environment) || !strictEdgeRateLimitReady(health.rateLimit) ||
      !durablePagesInviteReady(health.readiness?.access) || !sameSources(health.readiness?.contentPolicy, evidence.stagingContentPolicy.pages) ||
      health.enginePeer?.ok !== true || !matches(health.enginePeer.release) || health.enginePeer.release.environment !== 'staging' ||
      health.enginePeer.release.engineIdentityCompiled !== true ||
      !sameSources(health.enginePeer.contentPolicy, evidence.stagingContentPolicy.engine)) {
    throw new Error('Stable Staging no longer serves the accepted artifact, source policy, durable invite gate and working shared limiter');
  }
}

function isStagingPreview(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sonic-staging\.pages\.dev$/.test(value);
}

export function assertStagingAcceptance(evidence, manifest, pagesArtifactDigest, { production = false, requireDurableInvites = false, productionSources = [], verifyRecord } = {}) {
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
  if (production || requireDurableInvites) {
    if (evidence.accessGateMode !== 'invite' || evidence.inviteAccessLiveVerified !== true) {
      throw new Error('Promotion requires live product invite access verification on Staging');
    }
    if (evidence.inviteSingleUseLiveVerified !== true || evidence.inviteSessionRevocationDurable !== true ||
        !durablePagesInviteReady(evidence.stagingAccess) || !namespaceId.test(evidence.stagingAccessNamespaceId || '') ||
        evidence.stagingAccessNamespaceId === evidence.stagingRateLimitNamespaceId) {
      throw new Error('Promotion requires a separate durable Staging invite binding, single-use redemption and confirmed session revocation');
    }
  }
  if (!production) {
    if (evidence.branch === 'staging' || !isStagingPreview(evidence.base) ||
        !isStagingPreview(evidence.branchUrl) || evidence.branchUrl !== `https://${evidence.branch}.sonic-staging.pages.dev`) fail();
    return;
  }
  if (manifest.dirty !== false || evidence.branch !== 'staging' ||
      evidence.base !== stagingOrigin || evidence.branchUrl !== stagingOrigin) fail();
  if (!namespaceId.test(evidence.stagingRateLimitNamespaceId || '') || !strictEdgeRateLimitReady(evidence.stagingRateLimit) ||
      stableProbeNames.some(name => !checks.some(check => check.name === name)) ||
      !/^sha256:[a-f0-9]{64}$/.test(evidence.stagingEngineImageId || '')) {
    throw new Error('Production requires the complete stable Staging probes, Engine image ID and a working shared limiter');
  }
  const checkedRecord = (check, name) => {
    if (check?.ok !== true || typeof check.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,115}\.json$/.test(check.file) ||
        !sha256.test(check.sha256 || '') || typeof verifyRecord !== 'function' || !verifyRecord(check, name, evidence)) {
      throw new Error(`Production requires passing Staging evidence for ${name}`);
    }
  };
  for (const key of productionChecks) {
    checkedRecord(evidence.productionChecks?.[key], key);
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
    checkedRecord(evidence.productionChecks?.sourceAcceptance?.[source], `source:${source}`);
  }
}

export function readStagingAcceptance(path, manifest, pagesArtifactDigest, options) {
  let evidence;
  try { evidence = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Unable to read accepted live Staging evidence as JSON'); }
  const verifyRecord = ({ file, sha256: expectedHash }, name, accepted) => {
    try {
      const filename = resolve(dirname(resolve(path)), file);
      if (filename === resolve(path)) return false;
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.size > 256 * 1024) return false;
      const raw = readFileSync(filename);
      if (createHash('sha256').update(raw).digest('hex') !== expectedHash) return false;
      const record = JSON.parse(raw);
      return record.ok === true && record.checkId === name && record.environment === 'staging' &&
        typeof record.reviewer === 'string' && Boolean(record.reviewer.trim()) &&
        Number.isFinite(Date.parse(record.checkedAt)) && Date.parse(record.checkedAt) >= Date.parse(manifest.buildTime) &&
        typeof record.result === 'string' && Boolean(record.result.trim()) &&
        ['baseCommit', 'releaseId', 'sourceDigest', 'buildTime', 'pagesArtifactDigest', 'deploymentId', 'stagingEngineImageId']
          .every(field => record[field] === accepted[field]);
    } catch { return false; }
  };
  assertStagingAcceptance(evidence, manifest, pagesArtifactDigest, { ...options, verifyRecord });
  return evidence;
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

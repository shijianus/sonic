// Usage: SONIC_ENGINE_SECRET=... node scripts/verify-deployed-release.mjs https://sonic.example.com
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDeploymentOrigin } from './pages-release-lib.mjs';
import { validateReleaseManifest } from './release-inputs.mjs';

const identityFields = ['schemaVersion', 'baseCommit', 'sourceDigest', 'releaseId', 'buildTime', 'dirty'];
const protectedHealth = '/api/sonic/engine/health';
const allowedSourceIds = value => [...new Set(value.split(',').map(source => source.trim().toLowerCase()).filter(Boolean))].sort();

async function verify() {
  const production = process.env.SONIC_DEPLOY_ENV === 'production';
  const base = parseDeploymentOrigin(process.argv[2] || process.env.SONIC_DEPLOY_VERIFY_URL, { allowLoopback: !production });
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(resolve(process.cwd(), 'dist/release.json'), 'utf8')));
  const secret = process.env.SONIC_ENGINE_SECRET?.trim();
  if (!secret) throw new Error('SONIC_ENGINE_SECRET is required to verify the protected health endpoint');
  const expectedAccess = process.env.SONIC_ACCESS_MODE?.trim().toLowerCase();
  const expectedArtifact = process.env.SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST?.trim();
  const expectedSources = allowedSourceIds(process.env.SONIC_ALLOWED_SOURCES || '');
  if (expectedAccess && !['open', 'invite', 'legacy-staging'].includes(expectedAccess)) {
    throw new Error('SONIC_ACCESS_MODE is invalid');
  }
  if ((expectedArtifact && !/^[a-f0-9]{64}$/.test(expectedArtifact)) || (production && !expectedArtifact)) {
    throw new Error('A valid expected Pages artifact digest is required for production verification');
  }
  if (production && (!['open', 'invite'].includes(expectedAccess) || expectedSources.length === 0)) {
    throw new Error('Production verification requires explicit expected access mode and allowed sources');
  }

  async function probe(path, headers) {
    const response = await fetch(new URL(path, base), {
      // Never replay the custom Engine credential to a redirect destination.
      redirect: 'manual',
      headers: { 'Cache-Control': 'no-cache', ...headers },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${path.split('?')[0]} returned a redirect; use the canonical deployment origin`);
    }
    return response;
  }

  const releaseResponse = await probe(`/release.json?v=${encodeURIComponent(manifest.releaseId)}`);
  const deployedRelease = await releaseResponse.json().catch(() => null);
  if (!releaseResponse.ok || !identityFields.every(key => deployedRelease?.[key] === manifest[key]) ||
      releaseResponse.headers.get('x-sonic-release') !== manifest.releaseId) {
    throw new Error('Live /release.json or X-Sonic-Release does not match the built manifest');
  }

  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const healthResponse = await probe(protectedHealth, { 'X-Sonic-Engine-Key': secret });
  const health = await healthResponse.json().catch(() => null);
  check(healthResponse.ok, `${protectedHealth} returned HTTP ${healthResponse.status}`);
  check(health?.ok === true, 'health.ok is not true');
  const { readiness, release } = health || {};
  const healthIdentity = { baseCommit: release?.releaseCommit, sourceDigest: release?.sourceDigest,
    releaseId: release?.releaseId, buildTime: release?.buildTime };
  for (const [key, value] of Object.entries(healthIdentity)) {
    check(value === manifest[key], `health ${key} differs from the built manifest`);
  }
  check(manifest.dirty === false && release?.dirty === false, 'Built manifest or live health reports a dirty release');
  check(readiness?.contentPolicy?.ok === true, 'content policy readiness is not ok');
  check(readiness?.access?.ok === true, 'access readiness is not ok');
  const actualAccess = readiness?.access?.mode;
  if (expectedAccess) check(actualAccess === expectedAccess && readiness.access.explicit === true, 'live access mode is not explicitly the expected mode');
  if (expectedArtifact) check(release?.pagesArtifactDigest === expectedArtifact, 'live Pages artifact digest does not match the approved artifact');
  if (production) {
    check(health?.runtime === 'cf-pages' && release?.environment === 'production', 'live release is not a production Pages deployment');
    check(healthResponse.headers.get('x-sonic-release') === manifest.releaseId, 'health X-Sonic-Release header is missing or stale');
    check(readiness?.contentPolicy?.mode === 'strict-allowlist', 'live content policy must be strict-allowlist');
    const actualSources = readiness?.contentPolicy?.allowedSources;
    check(Array.isArray(actualSources) && JSON.stringify([...actualSources].sort()) === JSON.stringify(expectedSources),
      'live source allowlist does not match the expected source IDs');
    const rateLimit = health?.rateLimit;
    check(rateLimit?.configuredBackend === 'native' && rateLimit.distributedAtomic === true &&
      rateLimit.requireDistributed === true && rateLimit.failClosedOnDegrade === true && rateLimit.productionCompliant === true,
    'production Pages must have the native fail-closed distributed rate limiter');
  }

  // Pages routing is case-insensitive; anonymous probes test route variants too.
  const protectedPaths = [protectedHealth, '/API/sonic/engine/health', '/Api/Sonic/Engine/Health'];
  if (expectedAccess === 'invite' || actualAccess === 'invite') {
    protectedPaths.push('/api/sonic/recommend/trending', '/API/sonic/recommend/trending', '/Api/Sonic/Recommend/Trending');
  }
  for (const path of protectedPaths) {
    const response = await probe(path);
    await response.body?.cancel().catch(() => {});
    check(response.status === 401 || response.status === 403, `anonymous ${path} must be rejected (got HTTP ${response.status})`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ ok: true, base, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest,
    ...(expectedArtifact ? { pagesArtifactDigest: expectedArtifact } : {}) }));
}

verify().catch(error => {
  console.error(`[verify:deployed] ${error.message}`);
  process.exitCode = 1;
});

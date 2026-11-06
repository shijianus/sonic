// Verify the release that is actually served by a deployed environment.
// Usage: node scripts/verify-deployed-release.mjs https://sonic.example.com
// Requires SONIC_ENGINE_SECRET to read the protected health endpoint.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = (process.argv[2] || process.env.SONIC_DEPLOY_VERIFY_URL || '').trim().replace(/\/+$/, '');
if (!base) {
  console.error('[verify:deployed] a deployment base URL is required');
  process.exit(2);
}
let url;
try {
  url = new URL(base);
} catch {
  console.error('[verify:deployed] invalid deployment URL');
  process.exit(2);
}
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname))) {
  console.error('[verify:deployed] deployment URL must be HTTPS (localhost HTTP is allowed for local checks)');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'dist/release.json'), 'utf8'));
const engineSecret = String(process.env.SONIC_ENGINE_SECRET || '').trim();
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

try {
  const releaseResponse = await fetch(`${base}/release.json?v=${encodeURIComponent(manifest.releaseId)}`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  check(releaseResponse.ok, `/release.json returned HTTP ${releaseResponse.status}`);
  const deployedRelease = await releaseResponse.json().catch(() => null);
  check(deployedRelease?.releaseId === manifest.releaseId, 'deployed releaseId differs from dist/release.json');
  check(deployedRelease?.baseCommit === manifest.baseCommit, 'deployed baseCommit differs from dist/release.json');
  check(deployedRelease?.sourceDigest === manifest.sourceDigest, 'deployed sourceDigest differs from dist/release.json');
  check(releaseResponse.headers.get('x-sonic-release') === manifest.releaseId, 'X-Sonic-Release header is missing or stale');

  if (!engineSecret) {
    failures.push('SONIC_ENGINE_SECRET is required to verify the protected health endpoint');
  } else {
    const healthResponse = await fetch(`${base}/api/sonic/engine/health`, {
      headers: { 'X-Sonic-Engine-Key': engineSecret, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
    check(healthResponse.ok, `/api/sonic/engine/health returned HTTP ${healthResponse.status}`);
    const health = await healthResponse.json().catch(() => null);
    check(health?.ok === true, `health.ok is not true: ${JSON.stringify(health?.readiness?.reasons || [])}`);
    check(health?.release?.releaseId === manifest.releaseId, 'health releaseId differs from the built manifest');
    check(health?.release?.dirty === false, 'health reports a dirty release');
    check(health?.readiness?.contentPolicy?.ok === true, 'content policy readiness is not ok');
    check(health?.readiness?.access?.ok === true, 'access readiness is not ok');
  }
} catch (error) {
  failures.push(error?.message || String(error));
}

if (failures.length > 0) {
  console.error('[verify:deployed] failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, base, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest }));
}

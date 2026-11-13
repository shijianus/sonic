import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectReleaseInputs, copyReleaseInputs, createReleaseFileIndex,
  RELEASE_DIRECTORIES, REQUIRED_RELEASE_FILES,
} from '../scripts/release-inputs.mjs';
import { assertStagingAcceptance, buildPagesDeploymentTree, parseDeploymentOrigin, verifyStableStagingInviteTarget } from '../scripts/pages-release-lib.mjs';

const repo = resolve(import.meta.dirname, '..');
const strictRateLimit = { configuredBackend: 'durable-object', requireDistributed: true, distributedAtomic: true, failClosedOnDegrade: true, productionCompliant: true };
const stagingNamespace = 'e'.repeat(32);
const stagingAccessNamespace = 'b'.repeat(32);
const productionAccessNamespace = 'c'.repeat(32);
const stagingAccess = { mode: 'invite', explicit: true, ok: true, backend: 'durable-object', durableRequired: true, storeUsable: true, singleUse: true, revocable: true };
const inviteEvidence = { accessGateMode: 'invite', inviteAccessLiveVerified: true, inviteSingleUseLiveVerified: true,
  inviteSessionRevocationDurable: true, stagingAccess, stagingAccessNamespaceId: stagingAccessNamespace };
const inviteBindings = { SONIC_ACCESS_MODE: { type: 'plain_text', value: 'invite' },
  SONIC_REQUIRE_DURABLE_INVITES: { type: 'plain_text', value: '1' }, SONIC_INVITE_CODES: { type: 'secret_text' } };
const stagingImage = `sha256:${'f'.repeat(64)}`;
const autoChecks = [
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
  'credential parity', 'project metadata', 'invite logout',
].map(name => ({ name, ok: true }));
const checkIds = ['oauthLoginAndRevocation', 'authorizedMediaPlaybackAndSeek', 'lyricsSync', 'imageAndSqliteRollback',
  'capacityAndAlertDelivery', 'realDevicesAndAccessibility', 'releaseOwnerApproval'];
const recordReference = (id: string) => ({ ok: true, file: `${id.replace(':', '-')}.json`, sha256: 'a'.repeat(64) });
function attachEvidence(root: string, evidence: Record<string, unknown>) {
  const references = Object.fromEntries([...checkIds, 'source:netease'].map(checkId => {
    const ref = recordReference(checkId);
    const record = JSON.stringify({ ...evidence, ok: true, checkId, environment: 'staging', checkedAt: '2026-11-13T00:00:00Z', reviewer: 'Fixture', result: 'Fixture evidence' });
    put(root, ref.file, record);
    return [checkId, { ...ref, sha256: createHash('sha256').update(record).digest('hex') }];
  }));
  return { ...references, sourceAcceptance: { netease: references['source:netease'] } };
}
const directories: string[] = [];
const metadata = {
  SONIC_RELEASE_COMMIT: 'a'.repeat(40), SONIC_RELEASE_DIRTY: '1',
  SONIC_SOURCE_DIGEST: '', SONIC_RELEASE_ID: '', SONIC_BUILD_TIME: '2026-11-02T00:00:00.000Z',
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporary(prefix = 'sonic-package-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}
function put(root: string, name: string, content = 'fixture\n') {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), content);
}
function fixture() {
  const root = temporary();
  for (const directory of RELEASE_DIRECTORIES) put(root, `${directory}/fixture.ts`, 'export const fixture = 1;\n');
  for (const file of REQUIRED_RELEASE_FILES) put(root, file);
  for (const file of ['release-inputs.mjs', 'write-release-manifest.mjs', 'package-release.mjs', 'prepare-pages-preview.mjs']) {
    cpSync(join(repo, 'scripts', file), join(root, 'scripts', file));
  }
  put(root, 'package.json', '{"type":"module"}\n');
  put(root, 'player/package.json', '{"type":"module"}\n');
  return root;
}
function runWriter(root: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts/write-release-manifest.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...metadata, ...extra },
  });
}
function snapshot(root: string) {
  const result = runWriter(root, ['--output', 'dist/release.json']);
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(result.stdout);
  put(root, 'release.json', JSON.stringify(manifest));
  put(root, 'release-files.json', JSON.stringify(createReleaseFileIndex(manifest, collectReleaseInputs(root))));
  return manifest;
}
function verify(root: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/release-inputs.mjs'), '--verify', 'release.json', '--index', 'release-files.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SONIC_SOURCE_DIGEST: '' },
  });
}

function productionFixture() {
  const root = fixture();
  put(root, '.gitignore', '/dist/\n');
  put(root, 'functions/_lib/sonic/compiled-release.ts', 'export const COMPILED_RELEASE = null;');
  for (const name of ['verify-deployed-release.mjs', 'pages-release-lib.mjs']) {
    cpSync(join(repo, 'scripts', name), join(root, 'scripts', name));
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Sonic release test', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const manifestResult = runWriter(root, ['--output', 'dist/release.json'], { SONIC_RELEASE_COMMIT: git('rev-parse', 'HEAD'), SONIC_RELEASE_DIRTY: '0' });
  expect(manifestResult.status, manifestResult.stderr).toBe(0);

  const control = temporary();
  const marker = join(control, 'wrangler-ran');
  const wrangler = join(control, 'wrangler.mjs');
  put(control, 'wrangler.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const run = (project: string, args: string[] = [], extra: Record<string, string> = {}) => spawnSync(process.execPath, [join(repo, 'scripts/deploy-pages.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CF_PAGES_PROJECT: project, CF_PAGES_BRANCH: 'main', SONIC_DEPLOY_ENV: 'production',
      SONIC_ENV: 'production', SONIC_ACCESS_MODE: 'invite', SONIC_RUNTIME: '', SONIC_SOURCE_DIGEST: '',
      SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'netease', SONIC_ENGINE_SECRET: 's'.repeat(48),
      SONIC_DEPLOY_VERIFY_URL: 'https://sonic-prod.pages.dev', SONIC_DEPLOY_VERIFY_ENGINE_URL: 'https://engine.example.test',
      SONIC_PRODUCTION_ACCEPTANCE_FILE: join(control, 'acceptance.json'),
      WRANGLER_CLI: wrangler, ALLOW_DIRTY_DEPLOY: '1', ALLOW_UNVERIFIED_DEPLOY: '1', ...extra,
    },
  });
  return { root, control, marker, run };
}

function stagingContentPolicy(effectiveSources: string[]) {
  const policy = { ok: true, mode: 'strict-allowlist', allowedSources: effectiveSources, effectiveSources };
  return { pages: policy, engine: policy };
}

describe('complete, secret-safe release source packages', { timeout: 30_000 }, () => {
  it('binds Staging evidence to the exact Pages output and requires production checks', () => {
    const root = fixture();
    put(root, 'functions/_lib/sonic/compiled-release.ts', 'export const COMPILED_RELEASE = null;');
    put(root, 'dist/index.html', 'first artifact');
    const written = runWriter(root, ['--output', 'dist/release.json'], { SONIC_RELEASE_DIRTY: '0' });
    expect(written.status, written.stderr).toBe(0);
    const first = buildPagesDeploymentTree(root);
    directories.push(first.stagingRoot);
    const identity = { ...first.manifest, pagesArtifactDigest: first.pagesArtifactDigest };
    expect(readFileSync(join(first.stagingRoot, 'functions/_lib/sonic/compiled-release.ts'), 'utf8')).toContain(first.pagesArtifactDigest);
    const preview = {
      ...identity,
      ok: true, mode: 'staging-live', branch: 'rc-fixture', base: 'https://test.sonic-staging.pages.dev',
      branchUrl: 'https://rc-fixture.sonic-staging.pages.dev', deploymentId: '01234567-89ab-cdef-0123-456789abcdef',
      engineStorage: 'sqlite', independentIdentityBindingPresent: true, authenticatedIdentityAssertionLiveVerified: true,
      engineRelease: { ...first.manifest, engineIdentityCompiled: true }, eventEpochLiveVerified: true, engineErasureRecoveryVersion: 1,
      checks: Array.from({ length: 12 }, (_, index) => ({ name: `check ${index}`, ok: true })),
    };
    expect(() => assertStagingAcceptance(preview, first.manifest, first.pagesArtifactDigest)).not.toThrow();
    expect(() => assertStagingAcceptance(preview, first.manifest, first.pagesArtifactDigest, { requireDurableInvites: true })).toThrow(/live product invite/);
    expect(() => assertStagingAcceptance({ ...preview, ...inviteEvidence }, first.manifest, first.pagesArtifactDigest, { requireDurableInvites: true })).not.toThrow();
    expect(() => assertStagingAcceptance({ ...preview, ...inviteEvidence }, first.manifest, first.pagesArtifactDigest, { production: true })).toThrow(/exact release/);
    expect(() => assertStagingAcceptance({ ...preview, eventEpochLiveVerified: undefined }, first.manifest, first.pagesArtifactDigest)).toThrow(/exact release/);
    expect(() => assertStagingAcceptance({ ...preview, engineErasureRecoveryVersion: undefined }, first.manifest, first.pagesArtifactDigest)).toThrow(/exact release/);
    expect(() => assertStagingAcceptance({ ...preview, engineRelease: { ...preview.engineRelease, engineIdentityCompiled: false } }, first.manifest, first.pagesArtifactDigest)).toThrow(/exact release/);
    expect(() => assertStagingAcceptance({ ...preview, engineRelease: { ...preview.engineRelease, baseCommit: 'b'.repeat(40) } }, first.manifest, first.pagesArtifactDigest)).toThrow(/exact release/);

    const stable = {
      ...preview, branch: 'staging', base: 'https://sonic-staging.pages.dev', branchUrl: 'https://sonic-staging.pages.dev',
      ...inviteEvidence, checks: autoChecks,
      stagingRateLimit: strictRateLimit, stagingRateLimitNamespaceId: stagingNamespace, stagingEngineImageId: stagingImage,
    };
    const production = { production: true, productionSources: ['netease', 'lrclib'], verifyRecord: () => true };
    expect(() => assertStagingAcceptance(stable, first.manifest, first.pagesArtifactDigest, production)).toThrow(/oauthLoginAndRevocation/);
    const manualChecks = Object.fromEntries(checkIds.map(name => [name, recordReference(name)]));
    const evidence = {
      ...stable, stagingContentPolicy: stagingContentPolicy(['synthetic', 'netease', 'lrclib']),
      productionChecks: { ...manualChecks, sourceAcceptance: {
        netease: recordReference('source:netease'),
        lrclib: recordReference('source:lrclib'),
      } },
    };
    const verify = (record: unknown, productionSources = production.productionSources) =>
      assertStagingAcceptance(record, first.manifest, first.pagesArtifactDigest, { ...production, productionSources });
    expect(() => verify(evidence, ['synthetic', 'netease', 'lrclib'])).not.toThrow();
    expect(() => verify(evidence, ['synthetic'])).toThrow(/non-synthetic source/);
    expect(() => verify({ ...evidence, accessGateMode: 'legacy-staging' })).toThrow(/live product invite/);
    expect(() => verify({ ...evidence, inviteAccessLiveVerified: undefined })).toThrow(/live product invite/);
    expect(() => verify({ ...evidence, inviteSingleUseLiveVerified: false })).toThrow(/single-use redemption/);
    expect(() => verify({ ...evidence, inviteSessionRevocationDurable: false })).toThrow(/confirmed session revocation/);
    expect(() => verify({ ...evidence, stagingAccessNamespaceId: stagingNamespace })).toThrow(/separate durable Staging invite binding/);
    expect(() => verify({ ...evidence, baseCommit: 'b'.repeat(40) })).toThrow(/exact release/);
    expect(() => verify({ ...evidence, stagingContentPolicy: undefined })).toThrow(/live strict source policy/);
    expect(() => verify({ ...evidence, productionChecks: manualChecks })).toThrow(/passing Staging evidence for source:netease/);
    expect(() => verify({ ...evidence, productionChecks: { ...evidence.productionChecks, oauthLoginAndRevocation: { ok: true, evidence: 'placeholder' } } })).toThrow(/oauthLoginAndRevocation/);
    expect(() => verify({ ...evidence, stagingContentPolicy: {
      ...evidence.stagingContentPolicy,
      engine: { ...evidence.stagingContentPolicy.engine, effectiveSources: ['synthetic', 'netease'] },
    } })).toThrow(/not enabled on Staging engine: lrclib/);
    expect(() => verify(evidence, ['netease', 'qq'])).toThrow(/not enabled on Staging pages: qq/);

    put(root, 'dist/index.html', 'modified artifact');
    const changed = buildPagesDeploymentTree(root);
    directories.push(changed.stagingRoot);
    expect(changed.manifest).toEqual(first.manifest);
    expect(changed.pagesArtifactDigest).not.toBe(first.pagesArtifactDigest);
    expect(() => assertStagingAcceptance(evidence, changed.manifest, changed.pagesArtifactDigest, production)).toThrow(/exact release/);
  });

  it.each(['http://sonic.example/', 'https://user:password@sonic.example/', 'https://sonic.example/elsewhere', 'https://sonic.example/?q=1', 'https://sonic.example/#hash'])('rejects a noncanonical production verification target %s', (target) => {
    expect(() => parseDeploymentOrigin(target)).toThrow(/canonical HTTPS/);
  });

  it('refuses stable Staging promotion if the target would use preview state or fall back to signed cookies', async () => {
    const binding = (id: string) => ({ env_vars: inviteBindings, durable_object_namespaces: { SONIC_ACCESS_BUCKETS: { namespace_id: id } } });
    const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture' };
    const verify = (production: object) => {
      const previous = globalThis.fetch;
      globalThis.fetch = async () => Response.json({ success: true, result: { name: 'sonic-staging', production_branch: 'staging',
        deployment_configs: { preview: binding(stagingAccessNamespace), production } } });
      return verifyStableStagingInviteTarget(inviteEvidence, env).finally(() => { globalThis.fetch = previous; });
    };
    await expect(verify(binding('9'.repeat(32)))).resolves.toBeUndefined();
    await expect(verify(binding(stagingAccessNamespace))).rejects.toThrow(/separate from the verified preview/);
    await expect(verify({ env_vars: inviteBindings })).rejects.toThrow(/separate from the verified preview/);
  });

  it('promotes the already accepted artifact through the normal npm deploy entrypoint', () => {
    const root = temporary();
    const { scripts: { deploy } } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    put(root, 'package.json', JSON.stringify({ scripts: { deploy, build: 'node rebuild.mjs' } }));
    put(root, 'dist/index.html', 'accepted output');
    put(root, 'rebuild.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('dist/index.html', 'rebuilt output');");
    put(root, 'scripts/deploy-pages.mjs', "import { readFileSync } from 'node:fs'; console.log(readFileSync('dist/index.html', 'utf8'));");
    const result = spawnSync('npm run deploy --silent', { cwd: root, encoding: 'utf8', shell: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('accepted output');
    expect(readFileSync(join(root, 'dist/index.html'), 'utf8')).toBe('accepted output');
  });

  it('blocks production deployment before invoking Wrangler when Staging evidence is missing', () => {
    const { marker, run } = productionFixture();
    const noProject = run('');
    expect(noProject.status).toBe(1);
    expect(noProject.stderr).toContain('CF_PAGES_PROJECT is required');
    const noEvidence = run('sonic-prod');
    expect(noEvidence.status).toBe(1);
    expect(noEvidence.stderr).toContain('Unable to read accepted live Staging evidence');
    const preflight = run('sonic-prod', ['--preflight']);
    expect(preflight.status).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      ok: false, decision: 'BLOCK', mode: 'production-preflight', reason: expect.stringContaining('accepted live Staging evidence'),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a production preflight decision after checking the exact artifact and Engine without invoking Wrangler', () => {
    const { root, control, marker, run } = productionFixture();
    const { manifest, pagesArtifactDigest, stagingRoot } = buildPagesDeploymentTree(root);
    directories.push(stagingRoot);
    const acceptance = {
      ...manifest, pagesArtifactDigest, ok: true, mode: 'staging-live', branch: 'staging',
      base: 'https://sonic-staging.pages.dev', branchUrl: 'https://sonic-staging.pages.dev',
      deploymentId: '01234567-89ab-cdef-0123-456789abcdef', ...inviteEvidence,
      engineStorage: 'sqlite', independentIdentityBindingPresent: true, authenticatedIdentityAssertionLiveVerified: true,
      engineRelease: { ...manifest, engineIdentityCompiled: true }, eventEpochLiveVerified: true, engineErasureRecoveryVersion: 1,
      checks: autoChecks, stagingRateLimit: strictRateLimit, stagingRateLimitNamespaceId: stagingNamespace, stagingEngineImageId: stagingImage,
      stagingContentPolicy: stagingContentPolicy(['synthetic', 'netease']),
    };
    put(control, 'acceptance.json', JSON.stringify({ ...acceptance, productionChecks: attachEvidence(control, acceptance) }));

    const project = {
      name: 'sonic-prod', production_branch: 'main', subdomain: 'sonic-prod.pages.dev',
      deployment_configs: { production: { durable_object_namespaces: { SONIC_RATE_LIMIT_BUCKETS: { namespace_id: 'd'.repeat(32) },
        SONIC_ACCESS_BUCKETS: { namespace_id: productionAccessNamespace } }, env_vars: { ...inviteBindings, ...Object.fromEntries(Object.entries({
        SONIC_LOCAL_ENGINE_URL: 'https://engine.example.test', SONIC_ENV: 'production',
        SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'netease',
      }).map(([name, value]) => [name, { type: 'plain_text', value }])) } } },
    };
    const engine = {
      ok: true, runtime: 'linux-engine',
      release: { ...manifest, releaseCommit: manifest.baseCommit, engineIdentityCompiled: true, environment: 'production' },
      readiness: { identity: { ok: true, configured: true, required: true }, access: { mode: 'invite', explicit: true },
        contentPolicy: { ok: true, mode: 'strict-allowlist', allowedSources: ['netease'], effectiveSources: ['netease'] } },
      recommendEngine: { storageKind: 'sqlite', storageHealthy: true, disk: { ok: true }, erasureRecoveryVersion: 1 },
    };
    const stagingProject = { name: 'sonic-staging', production_branch: 'staging', canonical_deployment: { id: acceptance.deploymentId },
      deployment_configs: { production: { env_vars: inviteBindings, durable_object_namespaces: {
        SONIC_RATE_LIMIT_BUCKETS: { namespace_id: stagingNamespace }, SONIC_ACCESS_BUCKETS: { namespace_id: stagingAccessNamespace },
      } } } };
    const deployment = { id: acceptance.deploymentId, environment: 'production', latest_stage: { status: 'success' },
      deployment_trigger: { metadata: { branch: 'staging', commit_hash: manifest.baseCommit } } };
    const stagingRelease = { ...engine.release, environment: 'staging', pagesArtifactDigest };
    const stagingHealth = { ok: true, runtime: 'cf-pages', release: stagingRelease, rateLimit: strictRateLimit,
      readiness: { access: stagingAccess, contentPolicy: acceptance.stagingContentPolicy.pages },
      enginePeer: { ok: true, release: stagingRelease, contentPolicy: acceptance.stagingContentPolicy.engine } };
    put(control, 'mock-preflight.mjs', `globalThis.fetch = async (input, init = {}) => {
      const { origin, pathname } = new URL(input);
      if (origin === 'https://api.cloudflare.com' && pathname === '/client/v4/accounts/${'a'.repeat(32)}/pages/projects/sonic-prod') {
        const project = ${JSON.stringify(project)};
        if (process.env.SONIC_TEST_MISSING_BINDING === '1') delete project.deployment_configs.production.durable_object_namespaces;
        if (process.env.SONIC_TEST_SHARED_ACCESS === '1') project.deployment_configs.production.durable_object_namespaces.SONIC_ACCESS_BUCKETS.namespace_id = '${stagingAccessNamespace}';
        return Response.json({ success: true, result: project });
      }
      if (origin === 'https://api.cloudflare.com' && pathname.endsWith('/projects/sonic-staging')) return Response.json({success:true,result:${JSON.stringify(stagingProject)}});
      if (origin === 'https://api.cloudflare.com' && pathname.endsWith('/deployments/${acceptance.deploymentId}')) return Response.json({success:true,result:${JSON.stringify(deployment)}});
      if (origin === 'https://sonic-staging.pages.dev') {
        if (new Headers(init.headers).get('x-sonic-engine-key') !== '${'t'.repeat(48)}') return new Response(null, {status:401});
        const health = ${JSON.stringify(stagingHealth)};
        if (process.env.SONIC_TEST_STAGING_LIMITER_DOWN === '1') health.rateLimit.productionCompliant = false;
        if (process.env.SONIC_TEST_STAGING_ACCESS_DOWN === '1') health.readiness.access.storeUsable = false;
        return Response.json(health,{headers:{'x-sonic-release':${JSON.stringify(manifest.releaseId)}}});
      }
      if (origin !== 'https://engine.example.test' || pathname !== '/api/sonic/engine/health') throw new Error('Unexpected preflight target');
      if (process.env.SONIC_TEST_ENGINE_UNREACHABLE === '1') return new Response(null, { status: 530 });
      if (new Headers(init.headers).get('x-sonic-engine-key') !== '${'s'.repeat(48)}') return new Response(null, { status: 401 });
      const engine = ${JSON.stringify(engine)};
      if (process.env.SONIC_TEST_DISABLED_SOURCE === '1') engine.readiness.contentPolicy.effectiveSources = [];
      return Response.json(engine, { headers: { 'x-sonic-release': ${JSON.stringify(manifest.releaseId)} } });
    };`);
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-api-token',
      SONIC_PRODUCTION_RATE_LIMIT_NAMESPACE_ID: 'd'.repeat(32), SONIC_STAGING_ENGINE_SECRET: 't'.repeat(48),
      SONIC_PRODUCTION_ACCESS_NAMESPACE_ID: productionAccessNamespace,
      NODE_OPTIONS: `--import=${pathToFileURL(join(control, 'mock-preflight.mjs')).href}`,
    };
    const preflight = run('sonic-prod', ['--preflight'], env);
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      ok: true, decision: 'GO', mode: 'production-preflight', baseCommit: manifest.baseCommit, pagesArtifactDigest,
    });

    const untested = run('sonic-prod', ['--preflight'], { ...env, SONIC_ALLOWED_SOURCES: 'netease,lrclib' });
    expect(untested.status).toBe(1);
    expect(JSON.parse(untested.stdout)).toMatchObject({ ok: false, decision: 'BLOCK', reason: 'Production sources were not enabled on Staging pages: lrclib' });

    const unhealthy = run('sonic-prod', ['--preflight'], { ...env, SONIC_TEST_ENGINE_UNREACHABLE: '1' });
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stderr).toContain('got HTTP 530');
    expect(JSON.parse(unhealthy.stdout)).toMatchObject({ ok: false, decision: 'BLOCK', mode: 'production-preflight' });

    for (const [flag, error] of [
      ['SONIC_TEST_MISSING_BINDING', 'SONIC_RATE_LIMIT_BUCKETS'],
      ['SONIC_TEST_STAGING_LIMITER_DOWN', 'working shared limiter'],
      ['SONIC_TEST_STAGING_ACCESS_DOWN', 'durable invite gate'],
      ['SONIC_TEST_DISABLED_SOURCE', 'effective sources'],
    ]) {
      const refused = run('sonic-prod', [], { ...env, [flag]: '1' });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(error);
    }
    const sharedAccess = run('sonic-prod', ['--preflight'], { ...env, SONIC_TEST_SHARED_ACCESS: '1', SONIC_PRODUCTION_ACCESS_NAMESPACE_ID: stagingAccessNamespace });
    expect(sharedAccess.status).toBe(1);
    expect(sharedAccess.stderr).toContain('invite binding changed or is shared');
    put(control, 'oauthLoginAndRevocation.json', '{"ok":true}');
    const changedEvidence = run('sonic-prod', [], env);
    expect(changedEvidence.status).toBe(1);
    expect(changedEvidence.stderr).toContain('passing Staging evidence for oauthLoginAndRevocation');
    expect(existsSync(marker)).toBe(false);
  });

  it('copies one explicit file set with the Compose, pre-build typecheck, lint, test, CI and runbook inputs', () => {
    const root = fixture();
    const manifest = snapshot(root);
    const inputs = collectReleaseInputs(root);
    const paths = inputs.files.map((file: { path: string }) => file.path);
    expect(paths).toEqual(expect.arrayContaining([
      'Dockerfile.ncm', '.dockerignore', 'CHECKLIST.log', 'player/scripts/fixture.ts', 'player/tsconfig.json',
      'player/src/auto-import/imports.d.ts', 'player/src/auto-import/components.d.ts',
      'player/eslint.config.mjs', 'scripts/theme-lint-baseline.json', '.github/workflows/ci.yml',
      'scripts/deploy-pages.mjs', 'scripts/pages-release-lib.mjs', 'scripts/verify-pages-deploy-tree.mjs', 'scripts/verify-deployed-release.mjs', 'scripts/revoke-invite.mjs',
      'tests/fixture.ts', 'player/tests/fixture.ts', 'player/e2e/fixture.ts', 'js/playlist-view.js',
      'docs/RUNBOOK-ROLLBACK.md', 'docs/OPERATIONS.md', 'docs/release/RELEASE-CHECKLIST.md',
    ]));
    const extracted = temporary();
    copyReleaseInputs(root, extracted, inputs.files);
    for (const name of ['release.json', 'release-files.json']) cpSync(join(root, name), join(extracted, name));
    expect(existsSync(join(extracted, '.git'))).toBe(false);
    expect(existsSync(join(extracted, 'node_modules'))).toBe(false);
    const result = verify(extracted);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, verification: 'full-source', sourceDigest: manifest.sourceDigest, indexVerified: true });
    expect(collectReleaseInputs(extracted)).toEqual(inputs);
    // No .git/env metadata is needed when rebuilding from a verified archive.
    const rebuilt = runWriter(extracted, ['--print'], {
      SONIC_RELEASE_COMMIT: '', SONIC_RELEASE_DIRTY: '', SONIC_BUILD_TIME: '',
    });
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(JSON.parse(rebuilt.stdout)).toEqual(manifest);
  });

  it.each([
    'Dockerfile.ncm', '.dockerignore', 'player/tsconfig.json', 'player/scripts',
    'player/src/auto-import/imports.d.ts', 'player/eslint.config.mjs',
    'scripts/theme-lint-baseline.json', '.github/workflows/ci.yml',
    'docs/RUNBOOK-ROLLBACK.md', 'docs/OPERATIONS.md', 'docs/release/RELEASE-CHECKLIST.md',
  ])('fails closed if an extraction is missing %s', (name) => {
    const root = fixture();
    snapshot(root);
    rmSync(join(root, name), { recursive: true, force: true });
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(name);
    expect(() => collectReleaseInputs(root)).toThrow(/Missing required release input/);
  });

  it.each([
    '.dockerignore', 'Dockerfile.ncm', 'player/tsconfig.json', 'player/.npmrc',
    'package-lock.json', 'player/pnpm-lock.yaml', 'player/scripts/fixture.ts',
    'player/src/auto-import/components.d.ts', 'tests/fixture.ts',
    'player/e2e/fixture.ts', '.github/workflows/ci.yml', 'scripts/theme-lint-baseline.json',
  ])('detects tampering with %s despite a supplied original digest', (name) => {
    const root = fixture();
    const manifest = snapshot(root);
    put(root, name, readFileSync(join(root, name), 'utf8') + '\n// changed\n');
    const result = runWriter(root, ['--print'], { SONIC_SOURCE_DIGEST: manifest.sourceDigest });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not match the full source checkout');
    const digest = runWriter(root, ['--digest'], { SONIC_SOURCE_DIGEST: manifest.sourceDigest });
    expect(digest.status).not.toBe(0);
    expect(verify(root).stderr).toContain('Source digest mismatch');
  });

  it('requires the exact index and manifest identity, not just a matching aggregate digest', () => {
    const root = fixture();
    const manifest = snapshot(root);
    const original = readFileSync(join(root, 'release-files.json'), 'utf8');
    const index = JSON.parse(original);
    index.files.pop();
    put(root, 'release-files.json', JSON.stringify(index));
    expect(verify(root).stderr).toContain('complete input list');
    index.files.unshift(index.files[0]);
    put(root, 'release-files.json', JSON.stringify(index));
    expect(verify(root).stderr).toContain('index mismatch');
    put(root, 'release-files.json', original);
    put(root, 'release.json', JSON.stringify({ ...manifest, buildTime: '2026-11-03T00:00:00.000Z' }));
    expect(verify(root).stderr).toContain('metadata mismatch');
  });

  it('detects added source files and unindexed archive payloads', () => {
    const root = fixture();
    snapshot(root);
    put(root, 'functions/added.ts', 'export const changed = true;');
    expect(verify(root).stderr).toContain('Source digest mismatch');
    rmSync(join(root, 'functions/added.ts'));
    put(root, 'unexpected.txt', 'not in the release');
    expect(verify(root).stderr).toContain('Unindexed file');
  });

  it('excludes credentials/history/reports/caches before reading or copying, and rejects them in an extracted archive', () => {
    const root = fixture();
    const initial = collectReleaseInputs(root);
    const excluded = [
      '.env', 'functions/.env.private', 'player/.env.production', 'player/src/private.key',
      'functions/credentials.json', 'player/e2e/storage-state.json', 'player/e2e/cookies.json',
      '.git/history', 'scripts/audit_independent_qa_results.json', 'reports/run.log',
      'functions/reports/result.json', 'player/node_modules/private.js', 'player/dist/index.html',
      'player/src/auto-import/eslintrc-auto-import.json', 'functions/cache/item.json',
    ];
    for (const name of excluded) put(root, name, 'SYNTHETIC_PRIVATE_TEST_VALUE');
    expect(collectReleaseInputs(root)).toEqual(initial);
    const extracted = temporary();
    copyReleaseInputs(root, extracted, initial.files);
    for (const name of excluded) expect(existsSync(join(extracted, name)), name).toBe(false);
    expect(JSON.stringify(initial)).not.toContain('SYNTHETIC_PRIVATE_TEST_VALUE');
    snapshot(extracted);
    put(extracted, '.env', 'SYNTHETIC_PRIVATE_TEST_VALUE');
    expect(verify(extracted).stderr).toContain('Unindexed file');
  });

  it('rejects hard-linked inputs instead of reading through a link', () => {
    const root = fixture();
    const outside = temporary();
    put(outside, 'test-value', 'SYNTHETIC_PRIVATE_TEST_VALUE');
    linkSync(join(outside, 'test-value'), join(root, 'functions/linked.ts'));
    expect(() => collectReleaseInputs(root)).toThrow(/Hard link not allowed/);
  });

  it('does not mistake a partial frontend digest for a verified complete checkout', () => {
    const root = temporary();
    mkdirSync(join(root, 'scripts'));
    for (const name of ['write-release-manifest.mjs', 'release-inputs.mjs']) cpSync(join(repo, 'scripts', name), join(root, 'scripts', name));
    put(root, 'player/src/example.ts');
    const supplied = { SONIC_SOURCE_DIGEST: 'b'.repeat(64), SONIC_RELEASE_ID: 'release-fixture' };
    expect(runWriter(root, ['--print'], supplied).status).not.toBe(0);
    const partial = runWriter(root, ['--partial-docker-stage', '--print'], supplied);
    expect(partial.status, partial.stderr).toBe(0);
    expect(JSON.parse(partial.stdout).sourceDigest).toBe(supplied.SONIC_SOURCE_DIGEST);
    expect(Object.keys(JSON.parse(partial.stdout)).sort()).toEqual(['schemaVersion', 'baseCommit', 'sourceDigest', 'releaseId', 'buildTime', 'dirty'].sort());
    expect(partial.stderr).toContain('supplied identity only');
    expect(runWriter(root, ['--partial-docker-stage', '--digest'], supplied).status).not.toBe(0);
    expect(runWriter(root, ['--partial-docker-stage', '--print'], { ...supplied, SONIC_BUILD_TIME: '' }).status).not.toBe(0);
  });

  it('round-trips a fixture tarball and refuses stale builds and archive overwrite', () => {
    const root = fixture();
    const build = runWriter(root, ['--output', 'dist/release.json']);
    expect(build.status, build.stderr).toBe(0);
    const command = [join(root, 'scripts/package-release.mjs')];
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', env: { ...process.env, SONIC_SOURCE_DIGEST: '' } });
    expect(result.status, result.stderr).toBe(0);
    const descriptor = JSON.parse(result.stdout);
    directories.push(descriptor.staging);
    expect(descriptor.sha256).toBe(createHash('sha256').update(readFileSync(descriptor.archive)).digest('hex'));
    const extracted = temporary();
    const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
    execFileSync(tar, ['-xzf', descriptor.archive, '-C', extracted]);
    expect(verify(extracted).status).toBe(0);
    const again = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('refusing overwrite');
    put(root, '.dockerignore', 'tampered');
    const stale = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8' });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('Source digest mismatch');
  });

  it('uses only the evidenced Node base digest and an explicitly partial frontend metadata step', () => {
    const expected = 'node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914';
    for (const file of ['Dockerfile', 'Dockerfile.ncm']) {
      const source = readFileSync(join(repo, file), 'utf8');
      const bases = [...source.matchAll(/^FROM (\S+)/gm)].map(match => match[1]);
      expect(bases.length).toBeGreaterThan(0);
      expect(bases.every(base => base === expected)).toBe(true);
    }
    const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--partial-docker-stage');
    expect(dockerfile).toContain('player/pnpm-workspace.yaml player/.npmrc');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('RUN npm ci');
    expect(readFileSync(join(repo, '.dockerignore'), 'utf8')).toContain('!Dockerfile.ncm');
  });
});

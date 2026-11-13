import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { verifyProductionPagesBinding } from '../scripts/pages-release-lib.mjs';
import { onRequest as health } from '../functions/api/sonic/engine/health';
import { resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';

const execFileAsync = promisify(execFile);

const repo = resolve(import.meta.dirname, '..');
const script = join(repo, 'scripts', 'verify-deployed-release.mjs');
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalEngineCircuitForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sonic-deployed-verify-'));
  dirs.push(root);
  mkdirSync(join(root, 'dist'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    baseCommit: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64),
    releaseId: 'a'.repeat(12) + '-123456abcdef',
    buildTime: '2026-11-05T00:00:00.000Z',
    dirty: false,
  };
  writeFileSync(join(root, 'dist', 'release.json'), JSON.stringify(manifest));
  return { root, manifest };
}

const artifactDigest = 'c'.repeat(64);
const productionEngine = 'https://engine.example.test';
const productionProject = 'sonic-prod';
const cloudflarePath = `/client/v4/accounts/${'a'.repeat(32)}/pages/projects/${productionProject}`;
const productionEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fixture-api-token',
  SONIC_PRODUCTION_RATE_LIMIT_NAMESPACE_ID: 'd'.repeat(32),
  SONIC_PRODUCTION_ACCESS_NAMESPACE_ID: 'c'.repeat(32),
  CF_PAGES_PROJECT: productionProject, CF_PAGES_BRANCH: 'main',
  SONIC_ACCESS_MODE: 'invite', SONIC_ALLOWED_SOURCES: 'netease,qq',
};

function productionProjectResponse(overrides: Record<string, string> = {}) {
  return {
    name: productionProject, production_branch: 'main', subdomain: `${productionProject}.pages.dev`,
    deployment_configs: { production: { durable_object_namespaces: { SONIC_RATE_LIMIT_BUCKETS: { namespace_id: 'd'.repeat(32) },
      SONIC_ACCESS_BUCKETS: { namespace_id: 'c'.repeat(32) } }, env_vars: { SONIC_INVITE_CODES: { type: 'secret_text' }, ...Object.fromEntries(Object.entries({
      SONIC_LOCAL_ENGINE_URL: productionEngine, SONIC_ACCESS_MODE: 'invite', SONIC_ENV: 'production', SONIC_REQUIRE_DURABLE_INVITES: '1',
      SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'qq, netease', ...overrides,
    }).map(([key, value]) => [key, { type: 'plain_text', value }])) } } },
  };
}

type ServeOptions = {
  dirty?: boolean; access?: string; healthRedirect?: string; manifestRedirect?: string;
  engine?: boolean; compiled?: boolean; erasureRecoveryVersion?: number; peer?: Record<string, unknown>;
};

function engineRelease(manifest: Record<string, unknown>) {
  return {
    releaseCommit: manifest.baseCommit, releaseId: manifest.releaseId, sourceDigest: manifest.sourceDigest,
    buildTime: manifest.buildTime, dirty: false, engineIdentityCompiled: true,
  };
}

async function serve(manifest: Record<string, unknown>, options: ServeOptions = {}) {
  const engineSecret = 's'.repeat(48);
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/release.json')) {
      if (options.manifestRedirect) {
        response.writeHead(302, { Location: options.manifestRedirect });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-sonic-release': String(manifest.releaseId) });
      response.end(JSON.stringify(manifest));
      return;
    }
    // The Pages router is case-insensitive; mimic that so the verifier's
    // negative probes exercise the real policy shape.
    const pathname = (request.url || '/').split('?')[0].replace(/\/+$/, '').toLowerCase();
    if (pathname === '/api/sonic/engine/health') {
      if (request.headers['x-sonic-engine-key'] !== engineSecret) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ brand: 'Sonic', error: { code: 'ENGINE_UNAUTHORIZED' } }));
        return;
      }
      if (options.healthRedirect) {
        response.writeHead(307, { Location: options.healthRedirect });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-sonic-release': String(manifest.releaseId) });
      response.end(JSON.stringify({
        ok: true,
        runtime: options.engine ? 'linux-engine' : 'cf-pages',
        release: { ...engineRelease(manifest), dirty: options.dirty ?? false,
          engineIdentityCompiled: options.engine ? options.compiled ?? true : undefined, pagesArtifactDigest: artifactDigest },
        readiness: { contentPolicy: { ok: true }, access: { ok: true, mode: options.access || 'invite', explicit: true },
          identity: { ok: true, configured: true, required: true } },
        recommendEngine: options.engine && { storageKind: 'sqlite', storageHealthy: true, disk: { ok: true },
          erasureRecoveryVersion: options.erasureRecoveryVersion ?? 1 },
        enginePeer: request.url?.includes('verifyEngine=1') ? options.peer : undefined,
      }));
      return;
    }
    if (pathname === '/api/sonic/recommend/trending') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ brand: 'Sonic', error: { code: 'ACCESS_REQUIRED' } }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function runVerifier(root: string, base: string, overrides: Record<string, string> = {}, engineOnly = false) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...(engineOnly ? ['--engine-only'] : []), base], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SONIC_ENGINE_SECRET: 's'.repeat(48), SONIC_DEPLOY_ENV: '',
        SONIC_ACCESS_MODE: '', SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: '', SONIC_ALLOWED_SOURCES: '',
        SONIC_DEPLOY_VERIFY_ENGINE_URL: '', ...overrides },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { status: typeof error?.code === 'number' ? error.code : 1, stdout: error?.stdout || '', stderr: error?.stderr || '' };
  }
}

describe('deployed release verification', () => {
  it.each(['canonical', 'custom', 'pending', 'wrong-domain'] as const)('validates Pages origin ownership (%s)', async kind => {
    const hostname = kind === 'canonical' ? `${productionProject}.pages.dev` : 'production.example.test';
    const cloudflare = vi.fn(async (input: string | URL, init: RequestInit) => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.cloudflare.com');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-api-token');
      expect(new Headers(init.headers).has('x-sonic-engine-key')).toBe(false);
      expect(init.redirect).toBe('error');
      if (url.pathname === cloudflarePath) return Response.json({ success: true, result: productionProjectResponse() });
      expect(url.pathname).toBe(`${cloudflarePath}/domains/${hostname}`);
      return Response.json({ success: true, result: {
        name: kind === 'wrong-domain' ? 'other.example.test' : hostname, status: kind === 'pending' ? 'pending' : 'active',
      } });
    });
    vi.stubGlobal('fetch', cloudflare);
    const verification = verifyProductionPagesBinding({ pagesOrigin: `https://${hostname}`, engineOrigin: productionEngine, env: productionEnv });
    if (kind === 'canonical' || kind === 'custom') await expect(verification).resolves.toBeUndefined();
    else await expect(verification).rejects.toThrow('not an active domain');
    expect(cloudflare).toHaveBeenCalledTimes(kind === 'canonical' ? 1 : 2);
  });

  it.each([
    ['SONIC_LOCAL_ENGINE_URL', 'https://other.example.test', 'Engine binding'],
    ['SONIC_ENABLE_LOCAL_ENGINE', '0', 'Engine binding'],
    ['SONIC_ENV', '', 'Pages runtime and production environment'],
    ['SONIC_ENV', 'preview', 'Pages runtime and production environment'],
    ['SONIC_RUNTIME', 'linux-engine', 'Pages runtime and production environment'],
    ['SONIC_ACCESS_MODE', 'open', 'access mode'],
    ['SONIC_REQUIRE_DURABLE_INVITES', '0', 'SONIC_ACCESS_BUCKETS namespace'],
    ['SONIC_CONTENT_POLICY', 'default', 'source allowlist'],
    ['SONIC_ALLOWED_SOURCES', 'netease', 'source allowlist'],
    ['SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT', '0', 'rate-limit policy'],
    ['SONIC_RATE_LIMIT_FAIL_CLOSED', '0', 'rate-limit policy'],
  ])('checks configured production policy before probing hosts (%s)', async (key, value, reason) => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true, result: productionProjectResponse({ [key]: value }) }));
    await expect(verifyProductionPagesBinding({ pagesOrigin: `https://${productionProject}.pages.dev`, engineOrigin: productionEngine, env: productionEnv }))
      .rejects.toThrow(reason);
  });

  it('rejects a missing or different Durable Object namespace', async () => {
    for (const id of [undefined, 'e'.repeat(32)]) {
      const project = productionProjectResponse();
      vi.stubGlobal('fetch', async () => Response.json({ success: true, result: project }));
      await expect(verifyProductionPagesBinding({ engineOrigin: productionEngine, env: { ...productionEnv, SONIC_PRODUCTION_RATE_LIMIT_NAMESPACE_ID: id } }))
        .rejects.toThrow('SONIC_RATE_LIMIT_BUCKETS');
    }
    await expect(verifyProductionPagesBinding({ engineOrigin: productionEngine, env: { ...productionEnv, SONIC_PRODUCTION_ACCESS_NAMESPACE_ID: 'd'.repeat(32) } }))
      .rejects.toThrow('SONIC_ACCESS_BUCKETS namespace');
  });

  it('treats remote verification as production by default and refuses an unowned origin before sending an Engine key', async () => {
    const { root } = fixture();
    const preload = join(root, 'mock-cloudflare.mjs');
    const networkLog = join(root, 'network.log');
    const host = 'unowned.example.test';
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (input, init) => {
        const { origin, pathname } = new URL(input);
        appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({ origin, pathname, engineKey: new Headers(init?.headers).has('x-sonic-engine-key') }) + '\\n');
        if (origin !== 'https://api.cloudflare.com') throw new Error('Unexpected non-Cloudflare probe');
        if (pathname === ${JSON.stringify(cloudflarePath)}) return Response.json({ success: true, result: ${JSON.stringify(productionProjectResponse())} });
        return Response.json({ success: false }, { status: 404 });
      };`);
    const result = await runVerifier(root, `https://${host}`, {
      ...productionEnv, SONIC_DEPLOY_VERIFY_ENGINE_URL: productionEngine, SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: artifactDigest,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to verify the production Pages project or domain');
    expect(readFileSync(networkLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { origin: 'https://api.cloudflare.com', pathname: cloudflarePath, engineKey: false },
      { origin: 'https://api.cloudflare.com', pathname: `${cloudflarePath}/domains/${host}`, engineKey: false },
    ]);
  });

  it('requires a distinct Engine origin for production verification', async () => {
    const { root } = fixture();
    const result = await runVerifier(root, 'https://sonic.example.com', { SONIC_DEPLOY_ENV: 'production' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SONIC_DEPLOY_VERIFY_ENGINE_URL');
  });

  it.each([
    [{ compiled: false }, 'compiled release identity'],
    [{ erasureRecoveryVersion: 0 }, 'erasure recovery protection'],
    [{}, ''],
  ] as const)('preflights the running Engine before uploading Pages (%o)', async (options, failure) => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest, { engine: true, ...options });
    try {
      const result = await runVerifier(root, base, {}, true);
      if (failure) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(failure);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, engineOrigin: base });
      }
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it.each([true, false])('checks the Engine that Pages actually reaches (matching=%s)', async (matches) => {
    const { root, manifest } = fixture();
    const engine = await serve(manifest, { engine: true });
    const pages = await serve(manifest, { peer: { ok: true, origin: engine.base, runtime: 'linux-engine', storageKind: 'sqlite',
      erasureRecoveryVersion: 1, release: { ...engineRelease(manifest), sourceDigest: matches ? manifest.sourceDigest : 'd'.repeat(64) } } });
    try {
      const result = await runVerifier(root, pages.base, { SONIC_DEPLOY_VERIFY_ENGINE_URL: engine.base });
      expect(result.status, result.stderr).toBe(matches ? 0 : 1);
      if (!matches) expect(result.stderr).toContain('Pages Engine peer release differs');
    } finally {
      await Promise.all([pages.server, engine.server].map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
    }
  });

  it('returns a protected Pages peer probe using only the configured service credential', async () => {
    const { manifest } = fixture();
    const origin = 'https://engine.release-probe.example';
    const path = '/api/sonic/engine/health';
    const key = 'a'.repeat(48);
    const outbound = vi.fn(async () => Response.json({ ok: true, runtime: 'linux-engine', release: engineRelease(manifest),
      readiness: { identity: { ok: true, required: true, configured: true } },
      recommendEngine: { storageKind: 'sqlite', storageHealthy: true, disk: { ok: true }, erasureRecoveryVersion: 1 } }));
    vi.stubGlobal('fetch', outbound);
    const env = { SONIC_LOCAL_ENGINE_URL: origin, SONIC_ENGINE_SECRET: key, SONIC_ACCESS_MODE: 'open' };
    const url = `https://pages.release-probe.example${path}?verifyEngine=1`;
    expect((await health({ request: new Request(url), env })).status).toBe(401);
    expect(outbound).not.toHaveBeenCalled();
    const response = await health({ request: new Request(url, { headers: { 'X-Sonic-Engine-Key': key, Cookie: 'test=opaque' } }), env });
    expect(response.status).toBe(200);
    expect((await response.json()).enginePeer).toMatchObject({ ok: true, origin, erasureRecoveryVersion: 1,
      runtime: 'linux-engine', release: { engineIdentityCompiled: true } });
    const [target, options] = outbound.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(target).toBe(origin + path);
    expect(headers.get('x-sonic-engine-key')).toBe(key);
    expect(headers.has('cookie')).toBe(false);
    expect(options.redirect).toBe('manual');
  });

  it('accepts a live release whose identity, health and policy match the manifest', async () => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest);
    try {
      const result = await runVerifier(root, base, { SONIC_ACCESS_MODE: 'invite', SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: artifactDigest });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"ok":true');
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('rejects a live deployment that reports a dirty release', async () => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest, { dirty: true });
    try {
      const result = await runVerifier(root, base);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('dirty');
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('rejects a mismatched access mode and Pages artifact digest', async () => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest, { access: 'open' });
    try {
      const result = await runVerifier(root, base, { SONIC_ACCESS_MODE: 'invite', SONIC_DEPLOY_EXPECTED_ARTIFACT_DIGEST: 'd'.repeat(64) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expected mode');
      expect(result.stderr).toContain('artifact digest does not match');
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it.each(['healthRedirect', 'manifestRedirect'] as const)('refuses %s without requesting the target', async (kind) => {
    const { root, manifest } = fixture();
    let requests = 0;
    const sink = http.createServer((_, res) => { requests += 1; res.writeHead(200).end(); });
    await new Promise<void>(resolveListen => sink.listen(0, '127.0.0.1', resolveListen));
    const address = sink.address();
    if (!address || typeof address !== 'object') throw new Error('redirect server did not start');
    const { server, base } = await serve(manifest, { [kind]: `http://127.0.0.1:${address.port}/redirect` });
    try {
      const result = await runVerifier(root, base);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('returned a redirect');
      expect(requests).toBe(0);
    } finally {
      await Promise.all([server, sink].map(item => new Promise<void>(resolveClose => item.close(() => resolveClose()))));
    }
  });
});

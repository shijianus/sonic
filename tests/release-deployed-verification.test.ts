import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
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
    expect(options.redirect).toBe('error');
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

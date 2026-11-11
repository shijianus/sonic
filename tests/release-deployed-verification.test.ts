import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repo = resolve(import.meta.dirname, '..');
const script = join(repo, 'scripts', 'verify-deployed-release.mjs');
const dirs: string[] = [];

afterEach(() => {
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

async function serve(manifest: Record<string, unknown>, dirty: boolean) {
  const engineSecret = 's'.repeat(48);
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/release.json')) {
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
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        release: { releaseId: manifest.releaseId, dirty },
        readiness: { contentPolicy: { ok: true }, access: { ok: true, mode: 'invite' } },
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

async function runVerifier(root: string, base: string) {
  try {
    const result = await execFileAsync(process.execPath, [script, base], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, SONIC_ENGINE_SECRET: 's'.repeat(48) },
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { status: typeof error?.code === 'number' ? error.code : 1, stdout: error?.stdout || '', stderr: error?.stderr || '' };
  }
}

describe('deployed release verification', () => {
  it('accepts a live release whose identity, health and policy match the manifest', async () => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest, false);
    try {
      const result = await runVerifier(root, base);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"ok":true');
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });

  it('rejects a live deployment that reports a dirty release', async () => {
    const { root, manifest } = fixture();
    const { server, base } = await serve(manifest, true);
    try {
      const result = await runVerifier(root, base);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('dirty');
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  });
});

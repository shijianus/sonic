import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSonicServer } from '../server/index';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

async function startServer(
  root: string,
  extraEnv: Record<string, any> = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createSonicServer(root, {
    SONIC_RUNTIME: 'linux-engine',
    SONIC_ENGINE_SECRET: 'engine_secret_must_be_32_characters_long_minimum!',
    SONIC_RECOMMEND_DB_PATH: 'memory',
    ...extraEnv,
  } as any);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function rawRequest(port: number, requestPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Node static server hardening', () => {
  it('serves the SPA with nosniff/frame protections and never escapes the static root', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-static-'));
    const root = path.join(parent, 'dist');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>sonic-test</title>');
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'TOP-SECRET-DO-NOT-SERVE');

    const { port, close } = await startServer(root);
    cleanup.push(async () => {
      await close();
      fs.rmSync(parent, { recursive: true, force: true });
    });

    const index = await rawRequest(port, '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('sonic-test');
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    expect(index.headers['x-frame-options']).toBe('DENY');

    for (const traversal of ['/../secret.txt', '/..%2F..%2Fsecret.txt', '/..\\..\\secret.txt']) {
      const res = await rawRequest(port, traversal);
      expect(res.body, traversal).not.toContain('TOP-SECRET-DO-NOT-SERVE');
    }
  });

  it('preserves multiple Set-Cookie headers on the Node HTTP adapter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-cookie-'));
    fs.writeFileSync(path.join(root, 'index.html'), 'ok');
    const { port, close } = await startServer(root, {
      EPOMAIL_BASE_URL: 'https://mail.example.com',
      EPOMAIL_CLIENT_ID: 'client_123',
      EPOMAIL_CLIENT_SECRET: 'secret_123',
      EPOMAIL_REDIRECT_URI: 'https://sonic.example.com/api/auth/callback',
    });
    cleanup.push(async () => {
      await close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      headers: { 'X-Sonic-Engine-Key': 'engine_secret_must_be_32_characters_long_minimum!' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const cookies = (res.headers as any).getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c: string) => c.startsWith('sonic_oauth_state='))).toBe(true);
    expect(cookies.some((c: string) => c.startsWith('sonic_oauth_verifier='))).toBe(true);
  });

  it('reports not-ready when a persistent DB path is configured but the store is in memory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-health-'));
    fs.writeFileSync(path.join(root, 'index.html'), 'ok');
    const store = new MemoryRecommendStore();
    const { port, close } = await startServer(root, {
      SONIC_RECOMMEND_DB_PATH: '/app/data/sonic-recommend.sqlite',
      RECOMMEND_STORE: store,
    });
    cleanup.push(async () => {
      await close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/sonic/engine/health`, {
      headers: { 'X-Sonic-Engine-Key': 'engine_secret_must_be_32_characters_long_minimum!' },
    });
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.recommendEngine.storageKind).toBe('memory');
    expect(body.recommendEngine.persistenceExpected).toBe(true);
    expect(body.recommendEngine.storageHealthy).toBe(false);
  });
});

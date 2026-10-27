import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createSonicServer } from '../server/index';

const ENGINE_SECRET = 'engine_integration_secret_abcdefghijklmnopqrstuvwxyz';

describe('Linux engine route gate', () => {
  let server: Server;
  let baseUrl: string;
  let staticDir: string;
  const previous: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['SONIC_RUNTIME', 'SONIC_ENGINE_SECRET', 'SONIC_NCM_API_URL', 'SONIC_LOCAL_ENGINE_URL']) {
      previous[key] = process.env[key];
    }
    process.env.SONIC_RUNTIME = 'linux-engine';
    process.env.SONIC_ENGINE_SECRET = ENGINE_SECRET;
    delete process.env.SONIC_NCM_API_URL;
    delete process.env.SONIC_LOCAL_ENGINE_URL;

    staticDir = mkdtempSync(join(tmpdir(), 'sonic-engine-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>sonic</title>static-ok');
    server = createSonicServer(staticDir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (server as any).closeAllConnections?.();
    rmSync(staticDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects every business route without the engine key, regardless of Host', async () => {
    for (const path of [
      '/api',
      '/api/music/search?q=test',
      '/api/music/stream?id=1',
      '/api/sonic/engine/health',
      '/proxy/',
      '/palette/',
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: {
          Host: 'localhost:8080',
          'X-Sonic-Client-IP': '198.51.100.99',
        },
      });
      expect(response.status, path).toBe(401);
    }
  });

  it('rejects a wrong engine key', async () => {
    const response = await fetch(`${baseUrl}/api`, {
      headers: { 'X-Sonic-Engine-Key': 'wrong-key' },
    });
    expect(response.status).toBe(401);
  });

  it('allows authorized business routes and health checks', async () => {
    const api = await fetch(`${baseUrl}/api`, {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET },
    });
    expect(api.status).toBe(200);

    const health = await fetch(`${baseUrl}/api/sonic/engine/health`, {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET },
    });
    expect(health.status).toBe(200);
    const payload = await health.json() as any;
    expect(payload.ok).toBe(true);
  });

  it('keeps static frontend assets public', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('static-ok');
  });
});

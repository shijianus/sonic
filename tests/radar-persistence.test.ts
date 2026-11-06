import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: vi.fn(),
  store: vi.fn(),
  subject: vi.fn(),
  config: vi.fn(),
}));

vi.mock('../functions/_lib/sonic/local-engine', async (original) => ({
  ...await original<typeof import('../functions/_lib/sonic/local-engine')>(),
  callLocalEngineJson: mocks.engine,
}));
vi.mock('../functions/_lib/sonic/recommend', async (original) => ({
  ...await original<typeof import('../functions/_lib/sonic/recommend')>(),
  getRecommendStore: mocks.store,
}));
vi.mock('../functions/_lib/sonic/authenticated-subject', () => ({
  resolveAuthenticatedSubject: mocks.subject,
}));
vi.mock('../functions/_lib/sonic/config', async (original) => ({
  ...await original<typeof import('../functions/_lib/sonic/config')>(),
  getSonicConfig: mocks.config,
}));

import { onRequest } from '../functions/api/sonic/recommend/radar-album';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';

const env = {
  SONIC_ENV: 'test',
  SONIC_RATE_LIMIT_ANON_RPM: '10000',
} as any;

const request = () => new Request('https://sonic.test/api/sonic/recommend/radar-album', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
  body: JSON.stringify({
    title: 'Radar',
    tracks: [{ id: '1001', title: 'Track', artist: 'Artist' }],
    signals: { topArtists: ['Artist'], recentQueries: [], totalReplays: 1 },
  }),
});

beforeEach(() => {
  resetRateLimitsForTest();
  mocks.engine.mockReset();
  mocks.store.mockReset();
  mocks.subject.mockReset().mockResolvedValue('usr_test');
  mocks.config.mockReset().mockReturnValue({ enableLocalEngine: false, engineTimeoutMs: 1000 });
});

describe('radar album POST persistence contract', () => {
  it('rejects an Edge memory store instead of acknowledging a temporary sync', async () => {
    mocks.store.mockReturnValue({ kind: 'memory', saveUserRadarProfile: vi.fn() });
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(503);
    expect((await response.json())?.error?.code).toBe('RADAR_STORAGE_UNAVAILABLE');
  });

  it('accepts a durable SQLite store and confirms persistence', async () => {
    const saveUserRadarProfile = vi.fn();
    mocks.store.mockReturnValue({ kind: 'sqlite', saveUserRadarProfile });
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(200);
    expect(saveUserRadarProfile).toHaveBeenCalledWith('usr_test', expect.any(String));
    expect((await response.json())?.meta).toMatchObject({
      storageKind: 'sqlite',
      persistenceConfirmed: true,
    });
  });

  it('maps a SQLite write failure to 503', async () => {
    mocks.store.mockReturnValue({
      kind: 'sqlite',
      saveUserRadarProfile: () => { throw new Error('disk full'); },
    });
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(503);
  });

  it('rejects an engine response that does not confirm SQLite persistence', async () => {
    mocks.config.mockReturnValue({ enableLocalEngine: true, engineTimeoutMs: 1000 });
    mocks.engine.mockResolvedValue({
      ok: true,
      status: 200,
      data: { brand: 'Sonic', ok: true },
      latencyMs: 1,
      circuitState: 'CLOSED',
    });
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(503);
  });

  it('accepts an engine response that confirms SQLite persistence', async () => {
    mocks.config.mockReturnValue({ enableLocalEngine: true, engineTimeoutMs: 1000 });
    mocks.engine.mockResolvedValue({
      ok: true,
      status: 200,
      data: { brand: 'Sonic', ok: true, meta: { storageKind: 'sqlite' } },
      latencyMs: 1,
      circuitState: 'CLOSED',
    });
    const response = await onRequest({ request: request(), env });
    expect(response.status).toBe(200);
    expect((await response.json())?.meta).toMatchObject({
      storageKind: 'sqlite',
      persistenceConfirmed: true,
    });
  });
});

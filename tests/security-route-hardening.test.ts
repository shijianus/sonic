// Regression coverage for the 2026-11-06 audit:
// - Pages route matching is case-insensitive, so policy checks must canonicalize.
// - Engine 4xx responses must not poison the shared circuit breaker.
// - Staging bootstrap must not become a protocol-relative open redirect.
// - Client search text must not resolve through Object.prototype.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalPolicyPath,
  checkEngineAccess,
  checkStagingAccessGate,
  hasValidEngineSecret,
  isSameOriginRequest,
  requiresEngineAuth,
  resetRateLimitsForTest,
} from '../functions/_lib/sonic/security';
import { requireAccess, revokeAccessSession } from '../functions/_lib/sonic/access';
import {
  callLocalEngineJson,
  getLocalEngineCircuitSnapshot,
  resetLocalEngineCircuitForTest,
} from '../functions/_lib/sonic/local-engine';
import { expandQueryAliases } from '../functions/_lib/sonic/recommend/text-norm';
import { isKeyRevocationKvEnabled } from '../functions/_lib/auth';
import { onRequest as eventsHandler, resetEventIngestQuotaForTest } from '../functions/api/sonic/events';
import { SqliteRecommendStore } from '../server/recommend-sqlite';

const inviteEnv = {
  SONIC_ENV: 'production',
  SONIC_ACCESS_MODE: 'invite',
  SONIC_ACCESS_SECRET: 'x'.repeat(48),
} as any;

const engineEnv = {
  SONIC_LOCAL_ENGINE_URL: 'https://engine.example.com',
  SONIC_ENGINE_SECRET: 'e'.repeat(40),
} as any;

const request = (path: string, init?: RequestInit) =>
  new Request(`https://sonic.example.com${path}`, init);

beforeEach(() => {
  resetLocalEngineCircuitForTest();
  resetRateLimitsForTest();
  resetEventIngestQuotaForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalEngineCircuitForTest();
});

describe('canonical policy paths', () => {
  it('normalizes case, trailing slashes and safe percent-encoding', () => {
    expect(canonicalPolicyPath('/API/Sonic/Engine/Health')).toBe('/api/sonic/engine/health');
    expect(canonicalPolicyPath('/api/sonic/engine/health///')).toBe('/api/sonic/engine/health');
    expect(canonicalPolicyPath('/api/%73onic/engine/health')).toBe('/api/sonic/engine/health');
    expect(canonicalPolicyPath('/')).toBe('/');
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(() => canonicalPolicyPath('/api/%E0%A4%A')).not.toThrow();
  });
});

describe('invite gate case variants', () => {
  it.each([
    '/API/sonic/recommend/trending',
    '/Api/sonic/recommend/trending',
    '/api/sonic/recommend/trending',
    '/API/sonic/events',
  ])('rejects %s without an invite session', async (path) => {
    const response = await requireAccess(request(path), inviteEnv);
    expect(response?.status).toBe(401);
    expect((await response!.json())?.error?.code).toBe('ACCESS_REQUIRED');
  });

  it('keeps the access lifecycle endpoints reachable regardless of case', async () => {
    expect(await requireAccess(request('/api/access/session'), inviteEnv)).toBeNull();
    expect(await requireAccess(request('/Api/access/session'), inviteEnv)).toBeNull();
  });
});

describe('engine auth case variants', () => {
  const protectedEnv = {
    SONIC_REQUIRE_ENGINE_AUTH: '1',
    SONIC_ENGINE_SECRET: 'e'.repeat(40),
  } as any;

  it.each([
    '/api/sonic/engine/health',
    '/api/Sonic/Engine/Health',
    '/API/sonic/engine/health',
    '/Api/Sonic/Resolve/Stream',
  ])('requires the engine key for %s', (path) => {
    expect(requiresEngineAuth(request(path), protectedEnv)).toBe(true);
  });

  it('rejects a mixed-case engine request without the key', () => {
    const denied = checkEngineAccess(request('/Api/Sonic/Engine/Health'), protectedEnv);
    expect(denied?.status).toBe(401);
  });

  it('allows a mixed-case engine request with the key', () => {
    const allowed = checkEngineAccess(
      request('/Api/Sonic/Engine/Health', { headers: { 'X-Sonic-Engine-Key': 'e'.repeat(40) } }),
      protectedEnv,
    );
    expect(allowed).toBeNull();
  });
});

describe('staging bootstrap redirect', () => {
  it('does not emit a protocol-relative Location for a leading double slash', () => {
    const token = 'staging-token-0123456789';
    const response = checkStagingAccessGate(
      request(`//evil.example/path?staging_token=${encodeURIComponent(token)}`),
      { SONIC_STAGING_ACCESS_TOKEN: token } as any,
    );
    expect(response?.status).toBe(302);
    const location = response!.headers.get('location') || '';
    expect(location.startsWith('//')).toBe(false);
    expect(location.startsWith('/evil.example/path')).toBe(true);
    expect(location.includes('staging_token')).toBe(false);
  });
});

describe('circuit breaker cannot be poisoned by anonymous request outcomes', () => {
  it('keeps the circuit closed after repeated 401/403 responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    for (let i = 0; i < 5; i += 1) await callLocalEngineJson('/api/access/status', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('CLOSED');
    expect(getLocalEngineCircuitSnapshot(engineEnv).consecutiveFailures).toBe(0);
  });

  it('does not instantly open on a single application-level 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 502 })));
    await callLocalEngineJson('/api/playlist/detail', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('CLOSED');
  });

  it('still opens on repeated 5xx and immediately on Cloudflare origin failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 502 })));
    for (let i = 0; i < 3; i += 1) await callLocalEngineJson('/api/playlist/detail', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('OPEN');

    resetLocalEngineCircuitForTest();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 530 })));
    await callLocalEngineJson('/api/playlist/detail', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('OPEN');
  });
});

describe('search input hardening', () => {
  it('never expands Object.prototype members into query variants', () => {
    for (const query of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const expanded = expandQueryAliases(query);
      expect(expanded.expandedQueries.every((value) => typeof value === 'string')).toBe(true);
    }
  });

  it('reports a non-durable access revocation when no repository is configured', async () => {
    const result = await revokeAccessSession(request('/api/access/session'), inviteEnv);
    expect(result).toEqual({ revoked: false, durable: false });
  });
});

describe('key revocation default', () => {
  const kv = { get: async () => null, put: async () => undefined } as any;

  it('is enabled when a KV binding exists and no explicit switch is set', () => {
    expect(isKeyRevocationKvEnabled({ SONIC_KEY_REVOCATION_KV: kv } as any)).toBe(true);
  });

  it('honors an explicit opt-out', () => {
    expect(
      isKeyRevocationKvEnabled({ SONIC_KEY_REVOCATION_KV: kv, SONIC_ENABLE_KEY_REVOCATION: '0' } as any),
    ).toBe(false);
  });
});

describe('anonymous event ingestion quota', () => {
  it('rejects a batch that exceeds the per-subject window', async () => {
    const store = new SqliteRecommendStore();
    const env = { SONIC_ENV: 'staging', SONIC_ACCESS_MODE: 'open', SONIC_RECOMMEND_OFFLINE: '1', RECOMMEND_STORE: store };
    const batch = JSON.stringify({
      events: Array.from({ length: 50 }, (_, index) => ({
        type: 'play_progress',
        track: { id: '186016' },
        progress: 0.6,
        eventId: `evt_quota_${index}`,
      })),
    });
    const send = () => eventsHandler({
      request: new Request('https://sonic.example/api/sonic/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sonic-anon-id': 'anon_quota_test_12345678',
        },
        body: batch,
      }),
      env,
    });

    try {
      for (let i = 0; i < 12; i += 1) {
        const response = await send();
        expect(response.status).toBe(200);
        await response.text();
      }
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: { code: 'EVENT_QUOTA_EXCEEDED' } });
    } finally {
      store.close();
    }
  });
});

describe('engine secret rotation', () => {
  const secret = 'e'.repeat(40);
  const prevSecret = 'p'.repeat(40);
  const rotationEnv = {
    SONIC_ENGINE_SECRET: secret,
    SONIC_ENGINE_SECRET_PREV: prevSecret,
  } as any;

  it('accepts the primary engine secret', () => {
    expect(hasValidEngineSecret(
      request('/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': secret } }),
      rotationEnv,
    )).toBe(true);
  });

  it('accepts the previous engine secret during rotation', () => {
    expect(hasValidEngineSecret(
      request('/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': prevSecret } }),
      rotationEnv,
    )).toBe(true);
  });

  it('rejects an unknown key even when rotation is configured', () => {
    expect(hasValidEngineSecret(
      request('/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': 'z'.repeat(40) } }),
      rotationEnv,
    )).toBe(false);
  });

  it('ignores _PREV when it is too short', () => {
    const env = { SONIC_ENGINE_SECRET: secret, SONIC_ENGINE_SECRET_PREV: 'short' } as any;
    expect(hasValidEngineSecret(
      request('/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': 'short' } }),
      env,
    )).toBe(false);
  });
});

describe('isSameOriginRequest strict mode', () => {
  it('returns true in default mode when no browser headers are present', () => {
    const req = new Request('https://sonic.example.com/api/sonic/events', { method: 'POST' });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it('returns false in strict mode when no browser headers are present', () => {
    const req = new Request('https://sonic.example.com/api/sonic/events', { method: 'POST' });
    expect(isSameOriginRequest(req, true)).toBe(false);
  });

  it('returns true in strict mode when Origin matches', () => {
    const req = new Request('https://sonic.example.com/api/sonic/events', {
      method: 'POST',
      headers: { Origin: 'https://sonic.example.com' },
    });
    expect(isSameOriginRequest(req, true)).toBe(true);
  });

  it('returns false in strict mode when Origin does not match', () => {
    const req = new Request('https://sonic.example.com/api/sonic/events', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(isSameOriginRequest(req, true)).toBe(false);
  });
});

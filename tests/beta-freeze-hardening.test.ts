// Regressions for the 2026-11-06 beta-freeze audit (P0-1/P0-2, P1-1..P1-8).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../functions/_lib/types';

import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { fetchProviderUrl, fetchProviderDirect, isAllowedProviderHost, readBoundedProviderJson } from '../functions/_lib/sonic/provider-fetch';
import { computeContentPolicyEpoch } from '../functions/_lib/sonic/licensing';
import { buildStreamCacheIdentifier } from '../functions/_lib/sonic/native-protocols';
import { buildSonicCacheKey, getSonicCachedJson, putSonicCachedJson, clearSonicMemoryCacheForTest } from '../functions/_lib/sonic/cache';
import { corsHeaders } from '../functions/_lib/http';
import { buildSessionCookie, buildClearSessionCookie, SONIC_SESSION_COOKIE, SONIC_SESSION_COOKIE_HOST_PREFIXED, readCookieWithHostPrefix } from '../functions/_lib/auth';
import { buildAccessSessionCookie, buildClearAccessSessionCookie, SONIC_ACCESS_COOKIE } from '../functions/_lib/sonic/access';
import {
  checkStagingAccessGate,
  evaluateGatewayRateLimit,
  resetRateLimitsForTest,
  resetStagingFailureLimiterForTest,
  acquireStreamSlot,
  releaseStreamSlot,
  getStreamSlotLimit,
} from '../functions/_lib/sonic/security';
import { getEngineIdentityReadiness, verifyEngineIdentity } from '../functions/_lib/sonic/engine-identity';
import { onRequest as accessInvite } from '../functions/api/access/invite';
import { onRequest as eventsRoute, resetEventIngestQuotaForTest } from '../functions/api/sonic/events';

const HTTPS_URL = new URL('https://sonic.example.org/x');
const HTTP_URL = new URL('http://localhost:8787/x');

beforeEach(() => {
  resetRateLimitsForTest();
  resetEventIngestQuotaForTest();
  resetStagingFailureLimiterForTest();
});
afterEach(() => {
  clearSonicMemoryCacheForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('P0-1: SQLite storage budget', () => {
  it('sets max_page_count from the configured byte budget', async () => {
    vi.resetModules();
    process.env.SONIC_RECOMMEND_DB_MAX_BYTES = String(4 * 1024 * 1024);
    const { SqliteRecommendStore } = await import('../server/recommend-sqlite');
    const store = new SqliteRecommendStore(':memory:');
    const row = (store as any).db.prepare('PRAGMA max_page_count').get() as { max_page_count: number };
    expect(row.max_page_count).toBe(Math.floor((4 * 1024 * 1024) / 4096));
    store.close();
    delete process.env.SONIC_RECOMMEND_DB_MAX_BYTES;
  });

  it('maps a full SQLite file to SQLITE_FULL on insert', async () => {
    vi.resetModules();
    const { SqliteRecommendStore } = await import('../server/recommend-sqlite');
    const store = new SqliteRecommendStore(':memory:');
    (store as any).db.exec('CREATE TABLE filler (v TEXT);');
    const { page_count: currentPages } = (store as any).db.prepare('PRAGMA page_count').get() as { page_count: number };
    // One page of headroom: a couple of 2 KB rows then SQLITE_FULL.
    (store as any).db.exec(`PRAGMA max_page_count = ${Number(currentPages) + 1};`);
    let full = false;
    try {
      for (let i = 0; i < 5000; i++) {
        (store as any).db.prepare('INSERT INTO filler (v) VALUES (?)').run('x'.repeat(2000));
      }
    } catch (err: any) {
      full = err?.code === 'SQLITE_FULL' || /full/i.test(String(err?.message));
    }
    expect(full).toBe(true);
    store.close();
  });

  it('expires anonymous rows after the shortened retention window', () => {
    vi.resetModules();
    process.env.SONIC_ANON_EVENT_RETENTION_DAYS = '7';
    return import('../server/recommend-sqlite').then(({ SqliteRecommendStore }) => {
      const store = new SqliteRecommendStore(':memory:', 90);
      const now = Date.now();
      const DAY = 86_400_000;
      store.recordEvent({ eventId: 'a1', subjectKey: 'anon_aaaaaaaaaaaa', type: 'play_start', weight: 1, createdAt: now - 8 * DAY });
      store.recordEvent({ eventId: 'u1', subjectKey: 'usr_111111111111', type: 'play_start', weight: 1, createdAt: now - 8 * DAY });
      store.recordEvent({ eventId: 'a2', subjectKey: 'anon_bbbbbbbbbbbb', type: 'play_start', weight: 1, createdAt: now - 1 * DAY });
      store.pruneRetention();
      expect(store.getUserEvents('anon_aaaaaaaaaaaa', 100, 0)).toHaveLength(0);
      expect(store.getUserEvents('usr_111111111111', 100, 0)).toHaveLength(1);
      expect(store.getUserEvents('anon_bbbbbbbbbbbb', 100, 0)).toHaveLength(1);
      store.close();
      delete process.env.SONIC_ANON_EVENT_RETENTION_DAYS;
    });
  });

  it('enforces absolute row caps by evicting the oldest anonymous rows', async () => {
    vi.resetModules();
    process.env.SONIC_RECOMMEND_MAX_EVENT_ROWS = '25';
    const { SqliteRecommendStore } = await import('../server/recommend-sqlite');
    const store = new SqliteRecommendStore(':memory:', 365);
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      store.recordEvent({ eventId: `e${i}`, subjectKey: 'anon_0000000000cap', type: 'play_start', weight: 1, createdAt: now - (100 - i) * 1000 });
    }
    store.pruneRetention();
    // Oldest five rows are gone; the newest 25 survive.
    const kept = store.getUserEvents('anon_0000000000cap', 1000, 0);
    expect(kept).toHaveLength(25);
    expect(kept.every((e) => Number(e.eventId.slice(1)) >= 5)).toBe(true);
    store.close();
    delete process.env.SONIC_RECOMMEND_MAX_EVENT_ROWS;
  });

  it('refuses new entities beyond the hard cap but refreshes known rows', async () => {
    vi.resetModules();
    process.env.SONIC_RECOMMEND_MAX_ENTITIES = '2';
    const { SqliteRecommendStore } = await import('../server/recommend-sqlite');
    const store = new SqliteRecommendStore(':memory:', 90);
    const now = Date.now();
    for (const id of ['mv_a', 'mv_b']) {
      store.upsertEntity({ id, type: 'mv', title: id, source: 'netease', sourceId: id, createdAt: now, updatedAt: now, payload: {} });
    }
    store.upsertEntity({ id: 'mv_c', type: 'mv', title: 'overflow', source: 'netease', sourceId: 'c', createdAt: now, updatedAt: now, payload: {} });
    expect(store.getEntity('mv_c')).toBeNull();
    // Refreshing a known row stays allowed and does not create a new one.
    store.upsertEntity({ id: 'mv_a', type: 'mv', title: 'a-refreshed', source: 'netease', sourceId: 'mv_a', createdAt: now, updatedAt: now, payload: {} });
    expect(store.getEntity('mv_a')?.title).toBe('a-refreshed');
    expect(store.getEntity('mv_b')).not.toBeNull();
    store.close();
    delete process.env.SONIC_RECOMMEND_MAX_ENTITIES;
  });

  it('prunes entities and orphaned relations with the retention window', async () => {
    vi.resetModules();
    const { SqliteRecommendStore } = await import('../server/recommend-sqlite');
    const store = new SqliteRecommendStore(':memory:', 7);
    const now = Date.now();
    const DAY = 86_400_000;
    store.upsertEntity({ id: 'mv_old', type: 'mv', title: 'Old', source: 'netease', sourceId: '1', createdAt: now - 30 * DAY, updatedAt: now - 30 * DAY, payload: {} });
    store.upsertEntity({ id: 'mv_new', type: 'mv', title: 'New', source: 'netease', sourceId: '2', createdAt: now, updatedAt: now, payload: {} });
    store.upsertEntityRelation({ parentId: 'mv_old', parentType: 'mv', childId: 'trk_1', childType: 'track', relationType: 'video_of', createdAt: now - 30 * DAY });
    store.upsertEntityRelation({ parentId: 'mv_new', parentType: 'mv', childId: 'trk_2', childType: 'track', relationType: 'video_of', createdAt: now });
    store.pruneRetention();
    expect(store.getEntity('mv_old')).toBeNull();
    expect(store.getEntity('mv_new')).not.toBeNull();
    expect(store.getEntityRelations('mv_old')).toHaveLength(0);
    expect(store.getEntityRelations('mv_new')).toHaveLength(1);
    store.close();
  });

  it('surfaces disk-budget refusal as a typed error', async () => {
    vi.resetModules();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const { SqliteRecommendStore, RecommendStoreBudgetExceededError } = await import('../server/recommend-sqlite');
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sonic-budget-'));
    const store = new SqliteRecommendStore(nodePath.join(dir, 't.sqlite'), 90);
    // Prime the 30s disk-check cache with a "below threshold" verdict.
    (store as any).lastDiskCheckOk = false;
    (store as any).lastDiskCheckAt = Date.now();
    expect(() => store.recordEvent({ eventId: 'x1', subjectKey: 'anon_xxxxxxxxxxxx', type: 'play_start', weight: 1, createdAt: Date.now() }))
      .toThrow(RecommendStoreBudgetExceededError);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('P0-1: memory store entity caps', () => {
  it('evicts the oldest entity/relation beyond the configured ceiling', () => {
    const store = new MemoryRecommendStore(90, { entities: 3, entityRelations: 2 });
    for (let i = 0; i < 4; i++) {
      store.upsertEntity({ id: `mv_${i}`, type: 'mv', title: `T${i}`, source: 'netease', sourceId: String(i), createdAt: i, updatedAt: i, payload: {} });
    }
    expect(store.getEntity('mv_0')).toBeNull();
    expect(store.getEntity('mv_3')).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      store.upsertEntityRelation({ parentId: `mv_${i}`, parentType: 'mv', childId: `trk_${i}`, childType: 'track', relationType: 'video_of', createdAt: i });
    }
    // First relation evicted once the third arrives.
    expect(store.getEntityRelations('mv_0')).toHaveLength(0);
    expect(store.getEntityRelations('mv_2')).toHaveLength(1);
  });
});

describe('P0-2: prohibited sidecar switches', () => {
  it('docker-compose hardcodes the sidecar unblock flag', async () => {
    const fs = await import('node:fs');
    const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf-8');
    const ncmService = compose.split('sonic-engine:')[0];
    expect(ncmService).toContain('ENABLE_UNBLOCK: "false"');
    expect(ncmService).not.toContain('${SONIC_ENABLE_UNBLOCK');
  });

  it('engine startup refuses PROHIBITED switches in production', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf-8'));
    expect(src).toContain('SONIC_ENABLE_UNBLOCK');
    expect(src).toContain('PROHIBITED content source switches are enabled in production');
  });
});

describe('P1-2: provider fetch boundary', () => {
  it('allowlists provider host families only', () => {
    expect(isAllowedProviderHost('music.163.com')).toBe(true);
    expect(isAllowedProviderHost('api.amll.dev')).toBe(true);
    expect(isAllowedProviderHost('lrclib.net')).toBe(true);
    expect(isAllowedProviderHost('music-api.gdstudio.xyz')).toBe(true);
    expect(isAllowedProviderHost('127.0.0.1')).toBe(false);
    expect(isAllowedProviderHost('internal.host.local')).toBe(false);
    expect(isAllowedProviderHost('evil.com')).toBe(false);
  });

  it('does not follow a provider redirect to a non-allowlisted host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest/meta-data' } })));
    await expect(fetchProviderUrl('https://music.163.com/api', {}, 2000)).rejects.toThrow('redirect target');
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1);
  });

  it('does not follow a provider redirect to plain http', async () => {
    let hops = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      hops += 1;
      return new Response(null, { status: 301, headers: { Location: 'http://music.163.com/downgrade' } });
    }));
    await expect(fetchProviderUrl('https://music.163.com/api', {}, 2000)).rejects.toThrow();
    expect(hops).toBe(1);
  });

  it('strips cookies on a cross-origin redirect hop', async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('cookie'));
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { Location: 'https://lrclib.net/next' } });
      }
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    }));
    const res = await fetchProviderUrl('https://music.163.com/api', { headers: { Cookie: 'NETEASE_COOKIE=secret' } }, 2000);
    expect(res.ok).toBe(true);
    expect(seen[0]).toContain('NETEASE_COOKIE=secret');
    expect(seen[1]).toBeNull();
  });

  it('rejects disallowed hosts and never fetches them', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchProviderDirect('https://evil.com/api')).rejects.toThrow('authorized HTTPS host');
    await expect(fetchProviderDirect('http://music.163.com/api')).rejects.toThrow('authorized HTTPS host');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('bounds provider JSON reads', async () => {
    const big = new Response('x'.repeat(100), { headers: { 'Content-Length': '100' } });
    await expect(readBoundedProviderJson(big, 10)).rejects.toThrow('size limit');
    const ok = new Response('{"a":1}');
    await expect(readBoundedProviderJson(ok, 1024)).resolves.toEqual({ a: 1 });
  });
});

describe('P1-3: per-IP stream concurrency', () => {
  it('caps concurrent streams per client IP and releases them', () => {
    const ip = '203.0.113.99';
    const limit = getStreamSlotLimit();
    for (let i = 0; i < limit; i++) expect(acquireStreamSlot(ip)).toBe(true);
    expect(acquireStreamSlot(ip)).toBe(false);
    releaseStreamSlot(ip);
    expect(acquireStreamSlot(ip)).toBe(true);
    for (let i = 0; i < limit + 5; i++) releaseStreamSlot(ip);
    expect(acquireStreamSlot(ip)).toBe(true);
    releaseStreamSlot(ip);
  });
});

describe('P1-4: identity secret rotation via _PREV', () => {
  const baseEnv = {
    SONIC_RUNTIME: 'linux-engine',
    SONIC_ENGINE_SECRET: 'engine_service_secret_at_least_32ch',
    SONIC_SECRET: 'signing_secret_also_at_least_32ch!!!',
  } as unknown as AppEnv;

  it('verifies assertions signed with the previous identity secret', async () => {
    const prev = 'previous_identity_secret_at_least_32ch!!';
    const env = { ...baseEnv, SONIC_ENGINE_IDENTITY_SECRET_PREV: prev } as AppEnv;
    // Sign with the PREVIOUS secret directly (simulating a rolling deploy).
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(prev), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = { v: 1, sub: null, mode: 'public', consent: false, method: 'GET', path: '/api/sonic/events', iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 20 };
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`sonic-engine-identity-v1.${encoded}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const request = new Request('https://engine.internal/api/sonic/events', {
      method: 'GET',
      headers: { 'X-Sonic-Engine-Key': baseEnv.SONIC_ENGINE_SECRET as string, 'X-Sonic-Verified-Identity': `${encoded}.${sigB64}` },
    });
    expect((await verifyEngineIdentity(request, env))?.mode).toBe('public');
    // Without the previous secret the same assertion is rejected.
    expect(await verifyEngineIdentity(request, baseEnv)).toBeNull();
    expect(getEngineIdentityReadiness(env).previousConfigured).toBe(true);
  });

  it('rejects a previous secret that reuses another service secret', () => {
    const env = { ...baseEnv, SONIC_ENGINE_IDENTITY_SECRET_PREV: baseEnv.SONIC_ENGINE_SECRET } as AppEnv;
    expect(getEngineIdentityReadiness(env).previousConfigured).toBe(false);
  });
});

describe('P1-5: CORS allowlist hygiene', () => {
  it('never exposes engine/staging credential headers to browsers', () => {
    const allow = corsHeaders().get('Access-Control-Allow-Headers') || '';
    expect(allow).not.toContain('X-Sonic-Engine-Key');
    expect(allow).not.toContain('X-Sonic-Staging-Token');
    expect(allow).not.toContain('X-Shijianus-Device-Id');
    expect(allow).not.toBe('*');
  });

  it('proxy and palette OPTIONS use explicit allowlists', async () => {
    const fs = await import('node:fs');
    for (const file of ['functions/proxy.ts', 'functions/palette.ts']) {
      const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
      expect(src).not.toContain('"Access-Control-Allow-Headers": "*"');
    }
  });
});

describe('P1-6: __Host- cookie prefix', () => {
  it('writes the prefixed name on secure origins and the legacy name locally', () => {
    const secureCookie = buildSessionCookie('tok123', new Date(Date.now() + 60_000).toISOString(), HTTPS_URL);
    expect(secureCookie).toContain('__Host-sonic_session=');
    expect(secureCookie).toContain('Secure');
    expect(secureCookie).not.toContain('Domain=');
    const localCookie = buildSessionCookie('tok123', new Date(Date.now() + 60_000).toISOString(), HTTP_URL);
    expect(localCookie).toContain('sonic_session=');
    expect(localCookie).not.toContain('__Host-');
  });

  it('reads both names with host-prefix priority', () => {
    const request = new Request('https://sonic.example.org/', { headers: { Cookie: `${SONIC_SESSION_COOKIE}=legacy; ${SONIC_SESSION_COOKIE_HOST_PREFIXED}=hosted` } });
    expect(readCookieWithHostPrefix(request, SONIC_SESSION_COOKIE, SONIC_SESSION_COOKIE_HOST_PREFIXED)).toBe('hosted');
    const legacyOnly = new Request('https://sonic.example.org/', { headers: { Cookie: `${SONIC_SESSION_COOKIE}=legacy` } });
    expect(readCookieWithHostPrefix(legacyOnly, SONIC_SESSION_COOKIE, SONIC_SESSION_COOKIE_HOST_PREFIXED)).toBe('legacy');
  });

  it('clears both names as independent Set-Cookie headers', () => {
    const cleared = buildClearSessionCookie(HTTPS_URL);
    expect(Array.isArray(cleared)).toBe(true);
    expect(cleared.some((c) => c.startsWith('__Host-sonic_session='))).toBe(true);
    expect(cleared.some((c) => c.startsWith('sonic_session='))).toBe(true);
  });

  it('applies the same discipline to the access cookie', () => {
    const secure = buildAccessSessionCookie('acc', Date.now() + 60_000, HTTPS_URL);
    expect(secure).toContain('__Host-sonic_access=');
    const cleared = buildClearAccessSessionCookie(HTTPS_URL);
    expect(cleared.some((c) => c.startsWith(`__Host-${SONIC_ACCESS_COOKIE}=`))).toBe(true);
    expect(cleared.some((c) => c.startsWith(`${SONIC_ACCESS_COOKIE}=`))).toBe(true);
  });
});

describe('P1-7: cache keys bound to policy epoch and environment', () => {
  it('stream identifiers change when the content policy changes', () => {
    const base = { source: 'netease', id: '1001', quality: '320' };
    const enabled = computeContentPolicyEpoch({ SONIC_ENV: 'test' } as AppEnv);
    const disabled = computeContentPolicyEpoch({ SONIC_ENV: 'test', SONIC_ENABLE_NETEASE: '0' } as AppEnv);
    expect(enabled).not.toBe(disabled);
    expect(buildStreamCacheIdentifier({ ...base, policyEpoch: enabled })).not.toBe(buildStreamCacheIdentifier({ ...base, policyEpoch: disabled }));
  });

  it('scopes cache keys by SONIC_ENV', async () => {
    const prodEnv = { SONIC_ENV: 'production' } as AppEnv;
    const stageEnv = { SONIC_ENV: 'staging' } as AppEnv;
    await putSonicCachedJson('unit-ns', 'ident-A', { marker: 'prod' }, 60, 120, prodEnv);
    const fromProd = await getSonicCachedJson<{ marker: string }>('unit-ns', 'ident-A', prodEnv);
    expect(fromProd?.value?.marker).toBe('prod');
    expect(buildSonicCacheKey('ns', 'id')).toContain('sonic:');
    const fromStaging = await getSonicCachedJson<{ marker: string }>('unit-ns', 'ident-A', stageEnv);
    expect(fromStaging).toBeNull();
    const devHit = await getSonicCachedJson<{ marker: string }>('unit-ns', 'ident-A', {} as AppEnv);
    expect(devHit).toBeNull();
    clearSonicMemoryCacheForTest();
  });
});

describe('P1-8: invite redemption under SONIC_REQUIRE_AUTH=1', () => {
  it('keeps the access lifecycle reachable for anonymous visitors', async () => {
    const decision = await evaluateGatewayRateLimit(
      new Request('https://sonic.example.org/api/access/session', { headers: { 'CF-Connecting-IP': '203.0.113.77' } }),
      { SONIC_REQUIRE_AUTH: '1' } as AppEnv,
      'access-session',
      { allowAnonymous: true },
    );
    expect(decision.allowed).toBe(true);
    const denied = await evaluateGatewayRateLimit(
      new Request('https://sonic.example.org/api/sonic/search', { headers: { 'CF-Connecting-IP': '203.0.113.78' } }),
      { SONIC_REQUIRE_AUTH: '1' } as AppEnv,
      'api',
    );
    expect(denied.allowed).toBe(false);
    expect(denied.backend).toBe('auth-gate');
  });

  it('invite redeem endpoint answers without auth headers', async () => {
    const res = await accessInvite({
      request: new Request('https://sonic.example.org/api/access/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.90' },
        body: JSON.stringify({ code: 'SHORT' }),
      }),
      env: { SONIC_ACCESS_MODE: 'invite', SONIC_REQUIRE_AUTH: '1' } as AppEnv,
    });
    // Not 401 AUTH_REQUIRED: the request reaches the invite logic (invalid code).
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe('INVITE_INVALID');
  });
});

describe('P2-14: staging token failure budget', () => {
  const stagingEnv = { SONIC_STAGING_ACCESS_TOKEN: 'staging-token-16-char' } as AppEnv;
  const attempt = () => checkStagingAccessGate(
    new Request('https://staging.example.org/', { headers: { 'CF-Connecting-IP': '203.0.113.200' } }),
    stagingEnv,
  );

  it('rate-limits repeated invalid staging tokens per IP', () => {
    for (let i = 0; i < 10; i++) {
      const denied = attempt();
      expect(denied?.status).toBe(401);
    }
    const limited = attempt();
    expect(limited?.status).toBe(429);
    expect((limited?.headers.get('Retry-After') || '')).toBeTruthy();
  });

  it('a valid token resets the failure budget', () => {
    for (let i = 0; i < 10; i++) expect(attempt()?.status).toBe(401);
    const valid = checkStagingAccessGate(
      new Request('https://staging.example.org/', {
        headers: { 'CF-Connecting-IP': '203.0.113.200', 'X-Sonic-Staging-Token': 'staging-token-16-char' },
      }),
      stagingEnv,
    );
    expect(valid).toBeNull();
    // Same IP: success cleared the previous failures, so the budget restarts.
    for (let i = 0; i < 10; i++) expect(attempt()?.status).toBe(401);
    expect(attempt()?.status).toBe(429);
  });
});

describe('P0-1: events daily quota', () => {
  it('rejects event batches beyond the daily per-IP ceiling', async () => {
    const env = { SONIC_EVENTS_DAILY_PER_IP: '10', SONIC_EVENTS_DAILY_PER_SUBJECT: '10' } as AppEnv;
    const makeRequest = () => new Request('https://sonic.example.org/api/sonic/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.50',
        'X-Sonic-Anon-Id': 'anon_quotatest1',
        // Public zero-tracking mode: no store write, quota logic still runs.
        'X-Sonic-Personalization': '0',
      },
      body: JSON.stringify({ events: Array.from({ length: 6 }, (_, i) => ({ type: 'play_start', eventId: `q${i}` })) }),
    });
    const first = await eventsRoute({ request: makeRequest(), env });
    expect(first.status).toBe(200);
    const second = await eventsRoute({ request: makeRequest(), env });
    expect(second.status).toBe(429);
    expect(((await second.json()) as any).error.code).toBe('EVENT_DAILY_QUOTA_EXCEEDED');
  });
});

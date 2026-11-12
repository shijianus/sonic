import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../functions/_lib/auth';
import type { AppEnv } from '../functions/_lib/types';
import { onRequest as pagesMiddleware } from '../functions/_middleware';
import { onRequest as redeemInvite } from '../functions/api/access/invite';
import { onRequest as readAccessSession } from '../functions/api/access/session';
import { onRequest as logoutAccess } from '../functions/api/access/logout';
import { onRequest as events, resetEventIngestQuotaForTest } from '../functions/api/sonic/events';
import { onRequest as health } from '../functions/api/sonic/engine/health';
import { callLocalEngineJson, resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';
import { ENGINE_IDENTITY_HEADER, ENGINE_IDENTITY_REQUIRED_HEADER, issueEngineIdentity, getEngineIdentityReadiness } from '../functions/_lib/sonic/engine-identity';
import { resolveUserIdentity } from '../functions/_lib/sonic/recommend/identity';
import { SqliteRecommendStore } from '../server/recommend-sqlite';
import { SqliteAccessStore } from '../server/access-store';
import { sanitizeInboundHeaders } from '../server/request-adapter';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { verifyAuthenticatedIdentity, verifyEvents, verifyLegacyAccess, verifyRelease, withInviteAccess } from '../scripts/verify-staging-live.mjs';

const serviceKey = 'followup-service-key-at-least-32-characters-long';
const assertionKey = 'followup-identity-key-at-least-32-characters-long';
const userKey = 'followup-user-key-at-least-32-characters-long';
const stores: SqliteRecommendStore[] = [];
const shared = { SONIC_ENGINE_SECRET: serviceKey, SONIC_ENGINE_IDENTITY_SECRET: assertionKey, SONIC_REQUIRE_ENGINE_IDENTITY: '1', SONIC_ENV: 'test', SONIC_RATE_LIMIT_ANON_RPM: '10000' };
const publicIdentity = { mode: 'public' as const, subjectKey: null, personalizationEnabled: false, isAuthenticated: false };
const authenticated = { mode: 'authenticated' as const, subjectKey: 'usr_' + 'a'.repeat(24), personalizationEnabled: true, isAuthenticated: true };
const edge = (): AppEnv => ({ ...shared, SONIC_RUNTIME: 'cf-pages', SONIC_LOCAL_ENGINE_URL: 'https://engine.followup.test', SONIC_SECRET: userKey, RECOMMEND_STORE: new MemoryRecommendStore() });
function engine(): AppEnv {
  const store = new SqliteRecommendStore(':memory:');
  stores.push(store);
  return { ...shared, SONIC_RUNTIME: 'linux-engine', SONIC_RECOMMEND_DB_PATH: 'memory', RECOMMEND_STORE: store };
}
function incoming(method = 'POST', query = '', headers: Record<string, string> = {}) {
  return new Request('https://edge.followup.test/api/sonic/events' + query, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': 'anon_followup_subject_0001', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify({ events: [{ type: 'search', query: 'followup identity', eventId: 'followup_identity_event' }] }) } : {}),
  });
}
function engineHop(env: AppEnv) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => events({ request: new Request(String(url), init), env }));
}
afterEach(() => {
  vi.restoreAllMocks();
  resetLocalEngineCircuitForTest();
  resetEventIngestQuotaForTest();
  for (const store of stores.splice(0)) store.close();
});

describe('Live Staging access probes against Pages handlers', () => {
  const base = 'https://edge.invite.test';
  const code = 'disposable-fixture-invite-code';
  const manifest = { releaseId: 'invite-fixture-release' };
  const protectedUrl = `${base}/api/music/search?q=Sonic&source=synthetic&count=1`;
  const staging: AppEnv = { SONIC_ENV: 'staging', SONIC_RELEASE_ID: manifest.releaseId, SONIC_RATE_LIMIT_ANON_RPM: '10000' };
  const inviteEnv: AppEnv = {
    ...staging, SONIC_ACCESS_MODE: 'invite', SONIC_INVITE_CODES: code,
    SONIC_ACCESS_SECRET: 'fixture-access-key-at-least-32-characters',
  };

  function usePages(env: AppEnv) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(String(url), init);
      expect(new URL(request.url).origin).toBe(base);
      return pagesMiddleware({ request, env, next: async () => {
        switch (new URL(request.url).pathname) {
          case '/': return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
          case '/api/access/redeem': return redeemInvite({ request, env });
          case '/api/access/session': return readAccessSession({ request, env });
          case '/api/access/logout': return logoutAccess({ request, env });
          case '/api/music/search': return Response.json({ ok: true });
          default: return new Response(null, { status: 404 });
        }
      } });
    });
  }

  it('retains the legacy token and browser bootstrap path', async () => {
    const token = 'fixture-legacy-staging-token';
    usePages({ ...staging, SONIC_STAGING_ACCESS_TOKEN: token });
    await expect(verifyLegacyAccess(base, { SONIC_STAGING_ACCESS_TOKEN: token }, manifest))
      .resolves.toEqual({ 'X-Sonic-Staging-Token': token });
  });

  it('redeems a signed Pages invite, verifies protected access and rejects expiry as 401', async () => {
    usePages(inviteEnv);
    const result = await withInviteAccess(base, code, manifest, async (headers: Record<string, string>) => {
      expect((await fetch(protectedUrl, { headers })).status).toBe(200);
      const session = await (await fetch(`${base}/api/access/session`, { headers })).json();
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(session.expiresAt));
      try {
        const expired = await fetch(protectedUrl, { headers });
        expect(expired.status).toBe(401);
        expect(await expired.json()).toMatchObject({ error: { code: 'ACCESS_REQUIRED' } });
      } finally { now.mockRestore(); }
      return 'checked';
    });
    expect(result).toEqual({ result: 'checked', inviteSessionRevocationDurable: false });
  });

  it('blocks before redeeming when no disposable code is supplied or the invite gate is open', async () => {
    const fetchPages = usePages({ ...inviteEnv, SONIC_ACCESS_MODE: 'open' });
    const verify = vi.fn();
    await expect(withInviteAccess(base, undefined, manifest, verify)).rejects.toThrow('STAGING_TEST_INVITE_CODE_REQUIRED');
    expect(fetchPages).not.toHaveBeenCalled();
    await expect(withInviteAccess(base, code, manifest, verify)).rejects.toThrow('STAGING_INVITE_MODE_UNVERIFIED');
    expect(fetchPages.mock.calls.some(([url]) => String(url).endsWith('/api/access/redeem'))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([false, true])('revokes a durable disposable session when a candidate check fails: %s', async fail => {
    const temp = mkdtempSync(join(tmpdir(), 'sonic-staging-invite-'));
    const access = new SqliteAccessStore(join(temp, 'access.sqlite'), code);
    usePages({ ...inviteEnv, SONIC_ACCESS_STORE: access });
    let cookie = '';
    try {
      const run = withInviteAccess(base, code, manifest, async (headers: Record<string, string>) => {
        cookie = headers.Cookie;
        expect((await fetch(protectedUrl, { headers })).status).toBe(200);
        if (fail) throw new Error('candidate check failed');
        return 'checked';
      });
      if (fail) await expect(run).rejects.toThrow('candidate check failed');
      else await expect(run).resolves.toEqual({ result: 'checked', inviteSessionRevocationDurable: true });
      expect(cookie).toMatch(/^__Host-sonic_access=/);
      expect((await fetch(protectedUrl, { headers: { Cookie: cookie } })).status).toBe(401);
    } finally {
      access.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe('Live Staging release probes', () => {
  const base = 'https://edge.followup.test';
  const peer = 'https://engine.followup.test';
  const secrets = { SONIC_ENGINE_SECRET: serviceKey, SONIC_ENGINE_IDENTITY_SECRET: assertionKey, SONIC_SECRET: userKey };

  it('checks stale and current epochs through both identity modes and clears the test subjects', async () => {
    const edgeEnv = edge();
    const engineEnv = engine();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(String(url), init);
      return events({ request, env: new URL(request.url).origin === base ? edgeEnv : engineEnv });
    });
    await verifyEvents(base, peer, {}, secrets);
    await verifyAuthenticatedIdentity(base, peer, {}, secrets);
    expect(engineEnv.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('rejects a stale event acknowledged by Pages and still clears temporary data', async () => {
    const edgeEnv = edge();
    const engineEnv = engine();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(String(url), init);
      const isPages = new URL(request.url).origin === base;
      const response = await events({ request, env: isPages ? edgeEnv : engineEnv });
      return isPages && response.status === 409 ? new Response(response.body, { headers: response.headers }) : response;
    });
    await expect(verifyEvents(base, peer, {}, secrets)).rejects.toThrow('STALE_EVENT_EPOCH_NOT_REJECTED');
    expect(engineEnv.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('captures live release proof only for a private, compiled and writable matching Engine', async () => {
    const manifest = { schemaVersion: 1, baseCommit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), releaseId: 'staging-check', buildTime: '2026-11-12T00:00:00.000Z', dirty: false };
    const pagesArtifactDigest = 'c'.repeat(64);
    const identity = { ok: true, configured: true, required: true };
    let compiled = true;
    let writable = true;
    let recoveryVersion: number | undefined = 1;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(String(url), init);
      const target = new URL(request.url);
      const isPages = target.origin === base;
      const headers = { 'x-sonic-release': manifest.releaseId };
      if (target.pathname === '/release.json') return Response.json(manifest, { headers });
      if (!request.headers.has('x-sonic-engine-key')) return Response.json({ error: { code: 'ENGINE_UNAUTHORIZED' } }, { status: 401 });
      return Response.json({
        ok: true,
        runtime: isPages ? 'cf-pages' : 'linux-engine',
        release: { ...manifest, releaseCommit: manifest.baseCommit, environment: 'staging', pagesArtifactDigest, engineIdentityCompiled: compiled },
        readiness: { identity },
        recommendEngine: { storageKind: 'sqlite', persistenceExpected: true, storageHealthy: true, disk: { writable }, erasureRecoveryVersion: recoveryVersion },
      }, { headers });
    });
    await expect(verifyRelease(base, peer, {}, secrets, manifest)).resolves.toMatchObject({ pagesArtifactDigest, engineStorage: 'sqlite', engineErasureRecoveryVersion: 1, engineRelease: { baseCommit: manifest.baseCommit, engineIdentityCompiled: true } });
    compiled = false;
    await expect(verifyRelease(base, peer, {}, secrets, manifest)).rejects.toThrow('ENGINE_RELEASE_IDENTITY_MISMATCH');
    compiled = true;
    writable = false;
    await expect(verifyRelease(base, peer, {}, secrets, manifest)).rejects.toThrow('STAGING_ENGINE_STORAGE_NOT_WRITABLE');
    writable = true;
    recoveryVersion = undefined;
    await expect(verifyRelease(base, peer, {}, secrets, manifest)).rejects.toThrow('STAGING_ENGINE_ERASURE_RECOVERY_UNVERIFIED');
  });
});

describe('Follow-up identity and consent over the actual events hop', () => {
  it.each(['?personalize=0', '?personalization=off', '?personalize=on&personalization=false', '?personalize=1&personalize=0'])('does not persist an opted-out query %s', async query => {
    const authority = engine();
    const hop = engineHop(authority);
    const response = await events({ request: incoming('POST', query), env: edge() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1, storageKind: 'none' } });
    expect(hop).not.toHaveBeenCalled();
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('keeps header opt-out authoritative without forwarding credentials or events', async () => {
    const authority = engine();
    const hop = engineHop(authority);
    const response = await events({ request: incoming('POST', '', { 'X-Sonic-Personalization': 'off', Cookie: 'ignored=value', 'X-Sonic-Key': 'not-a-user-token', 'X-Sonic-Context': 'e30' }), env: edge() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1, storageKind: 'none' } });
    expect(hop).not.toHaveBeenCalled();
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('preserves opt-out on the legacy anonymous hop without an independent key', async () => {
    const authority = { ...engine(), SONIC_REQUIRE_ENGINE_IDENTITY: '0', SONIC_ENGINE_IDENTITY_SECRET: '' };
    engineHop(authority);
    const response = await events({ request: incoming('POST', '?personalize=0'), env: { ...edge(), SONIC_REQUIRE_ENGINE_IDENTITY: '0', SONIC_ENGINE_IDENTITY_SECRET: '' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { accepted: 0, ignoredByPrivacy: 1 } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('rejects mismatched signing keys instead of acknowledging an ignored authenticated write', async () => {
    const env = edge();
    const session = await createSession(env, { email: 'followup@example.invalid', name: 'Followup', avatar: '' });
    const authority = { ...engine(), SONIC_ENGINE_IDENTITY_SECRET: 'different-identity-key-at-least-32-characters' };
    engineHop(authority);
    const response = await events({ request: incoming('POST', '', { 'X-Sonic-Key': session.apiKey }), env });
    expect(response.status).toBe(503);
    expect(response.headers.get('x-sonic-degraded')).toBe('1');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toMatchObject({ error: { code: 'ENGINE_IDENTITY_UNAVAILABLE' } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('rejects dropped required assertions even when an anonymous header is present', async () => {
    const authority = engine();
    engineHop(authority);
    const assertion = await issueEngineIdentity(authenticated, 'POST', '/api/sonic/events', shared);
    const response = await events({ request: incoming('POST', '', { 'X-Sonic-Engine-Key': serviceKey, [ENGINE_IDENTITY_REQUIRED_HEADER]: '1', [ENGINE_IDENTITY_HEADER]: assertion!.slice(0, -3) }), env: authority });
    expect(response.status).toBe(503);
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
    const missing = await events({ request: incoming('POST', '', { 'X-Sonic-Engine-Key': serviceKey, [ENGINE_IDENTITY_REQUIRED_HEADER]: '1' }), env: authority });
    expect(missing.status).toBe(503);
  });

  it('does not trust client-supplied assertion headers on public Edge', async () => {
    const assertion = await issueEngineIdentity(authenticated, 'GET', '/api/sonic/events', shared);
    const request = new Request('https://edge.followup.test/api/sonic/events', { headers: { [ENGINE_IDENTITY_HEADER]: assertion!, [ENGINE_IDENTITY_REQUIRED_HEADER]: '1' } });
    expect(await resolveUserIdentity(request, edge())).toMatchObject(publicIdentity);
  });

  it('accepts valid authenticated writes without sharing the user signing secret with Engine', async () => {
    const env = edge();
    const authority = engine();
    const session = await createSession(env, { email: 'followup-valid@example.invalid', name: 'Valid', avatar: '' });
    engineHop(authority);
    const response = await events({ request: incoming('POST', '', { 'X-Sonic-Key': session.apiKey }), env });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { privacyMode: 'authenticated', accepted: 1, storageKind: 'sqlite' } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(1);
  });

  it('isolates signed subject and visitor IP quotas through the Engine request adapter', async () => {
    const authority = { ...engine(), SONIC_EVENTS_DAILY_PER_IP: '2', SONIC_EVENTS_DAILY_PER_SUBJECT: '1' };
    const env = edge();
    const hop = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const forwarded = new Headers(init?.headers);
      expect(forwarded.has(ENGINE_IDENTITY_HEADER)).toBe(true);
      expect(forwarded.has('x-sonic-anon-id')).toBe(false);
      const headers = sanitizeInboundHeaders(Object.fromEntries(forwarded), '127.0.0.1');
      return events({ request: new Request(String(url), { ...init, headers }), env: authority });
    });
    const submit = (subject: string, ip: string, optOut = false) => events({
      request: incoming('POST', '', {
        'CF-Connecting-IP': ip,
        'X-Sonic-Anon-Id': `anon_quota_subject_${subject}`,
        'X-Sonic-Event-Target': optOut ? 'public' : 'anonymous-opt-in',
        ...(optOut ? { 'X-Sonic-Personalization': 'off' } : {}),
      }),
      env,
    });

    for (let i = 0; i < 3; i++) {
      const response = await submit('aaaa', '203.0.113.10', true);
      expect(await response.json()).toMatchObject({ data: { accepted: 0, ignoredByPrivacy: 1 } });
    }
    expect(hop).not.toHaveBeenCalled();
    expect((await submit('aaaa', '203.0.113.10')).status).toBe(200);
    const sameSubject = await submit('aaaa', '203.0.113.10');
    expect(sameSubject.status).toBe(429);
    expect(sameSubject.headers.get('Retry-After')).toBe('3600');
    expect(await sameSubject.json()).toMatchObject({ error: { code: 'EVENT_DAILY_QUOTA_EXCEEDED' } });
    expect((await submit('aaaa', '203.0.113.11')).status).toBe(429);
    expect((await submit('bbbb', '203.0.113.10')).status).toBe(200);
    expect((await submit('cccc', '203.0.113.10')).status).toBe(429);
    expect((await submit('cccc', '203.0.113.11')).status).toBe(200);
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(3);
  });

  it.each(['Pages with Engine', 'local SQLite'])('checks the intended event target before ingestion (%s)', async (runtime) => {
    const authority = engine();
    const throughEngine = runtime === 'Pages with Engine';
    const env = throughEngine ? edge() : { ...edge(), SONIC_LOCAL_ENGINE_URL: '', RECOMMEND_STORE: authority.RECOMMEND_STORE };
    const hop = engineHop(authority);
    const accountA = await createSession(env, { email: 'events-a@example.invalid', name: 'A', avatar: '' });
    const accountB = await createSession(env, { email: 'events-b@example.invalid', name: 'B', avatar: '' });
    const cookieA = { Cookie: `sonic_session=${accountA.apiKey}`, Origin: 'https://edge.followup.test' };
    const cookieB = { Cookie: `sonic_session=${accountB.apiKey}`, Origin: 'https://edge.followup.test' };
    const target = 'X-Sonic-Event-Target';
    for (const headers of [
      { ...cookieB, [target]: 'anonymous-opt-in' },
      { ...cookieB, [target]: `account:${accountA.id}` },
      { [target]: `account:${accountA.id}` },
      { ...cookieB, [target]: 'account:' },
      cookieB,
      { ...cookieB, Cookie: 'sonic_session=invalid' },
    ]) {
      const response = await events({ request: incoming('POST', '', headers), env });
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ error: { code: 'EVENT_INGEST_IDENTITY_MISMATCH' } });
    }
    expect(hop).not.toHaveBeenCalled();
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);

    const guest = await events({ request: incoming('POST', '', { [target]: 'anonymous-opt-in' }), env });
    expect(guest.status).toBe(200);
    expect(await guest.json()).toMatchObject({ data: { privacyMode: 'anonymous-opt-in', accepted: 1 } });
    const account = await events({ request: incoming('POST', '', { ...cookieA, [target]: `account:${accountA.id}` }), env });
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ data: { privacyMode: 'authenticated', accepted: 1 } });
    if (throughEngine) {
      const forwarded = new Headers(hop.mock.calls[1]?.[1]?.headers);
      for (const name of [target, 'Cookie', 'X-Sonic-Anon-Id']) expect(forwarded.has(name)).toBe(false);
      expect(forwarded.has(ENGINE_IDENTITY_HEADER)).toBe(true);
    }
    for (const [headers, count] of [[{}, 1], [cookieA, 1], [cookieB, 0]] as const) {
      const response = await events({ request: incoming('GET', '', headers), env });
      expect(await response.json()).toMatchObject({ data: { totalEvents: count } });
    }
  });

  it.each(['Pages with Engine', 'local SQLite'])('returns a private event marker only for the requested verified account (%s)', async (runtime) => {
    const authority = engine();
    const throughEngine = runtime === 'Pages with Engine';
    const env = throughEngine ? edge() : { ...edge(), SONIC_LOCAL_ENGINE_URL: '', RECOMMEND_STORE: authority.RECOMMEND_STORE };
    const hop = engineHop(authority);
    const accountA = await createSession(env, { email: 'epoch-a@example.invalid', name: 'A', avatar: '' });
    const accountB = await createSession(env, { email: 'epoch-b@example.invalid', name: 'B', avatar: '' });
    const cookieA = { Cookie: `sonic_session=${accountA.apiKey}`, Origin: 'https://edge.followup.test' };
    const cookieB = { Cookie: `sonic_session=${accountB.apiKey}`, Origin: 'https://edge.followup.test' };
    const target = 'X-Sonic-Event-Target';
    const eventTarget = `account:${accountA.id}`;
    const lookup = (headers: Record<string, string>) => events({ request: incoming('GET', '?view=event-epoch', headers), env });

    for (const headers of [cookieA, { [target]: eventTarget }, { ...cookieB, [target]: eventTarget },
      { ...cookieA, [target]: eventTarget, 'X-Sonic-Personalization': 'off' }]) {
      const mismatch = await lookup(headers);
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toMatchObject({ error: { code: 'EVENT_IDENTITY_MISMATCH' } });
    }
    expect(hop).not.toHaveBeenCalled();
    expect(await (await lookup({ ...cookieA, [target]: eventTarget })).json()).toEqual({
      brand: 'Sonic', data: { eventTarget, eventEpoch: null },
    });
    const erased = await events({ request: incoming('DELETE', '', { ...cookieA, 'X-Sonic-Erasure-Target': eventTarget }), env });
    expect(erased.status).toBe(200);
    const { data } = await erased.json();
    const current = await lookup({ ...cookieA, [target]: eventTarget });
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe('private, no-store');
    expect(data.eventEpoch).toMatch(/^[a-f0-9]{32}$/);
    expect(await current.json()).toEqual({ brand: 'Sonic', data: { eventTarget, eventEpoch: data.eventEpoch } });
    if (throughEngine) {
      const [url, init] = hop.mock.calls[0];
      expect(String(url)).toContain('?view=event-epoch');
      const forwarded = new Headers(init?.headers);
      expect(forwarded.has('Cookie')).toBe(false);
      expect(forwarded.has(ENGINE_IDENTITY_HEADER)).toBe(true);
    }
  });

  it('refuses a legacy public acknowledgement for an opt-in subject', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ brand: 'Sonic', data: { ok: true, privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1, storageKind: 'none' } }));
    const response = await events({ request: incoming(), env: edge() });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ENGINE_IDENTITY_UNAVAILABLE' } });
  });

  it('keeps an unscoped Cookie write public if revocation storage recovers before forwarding', async () => {
    const authority = engine();
    const get = vi.fn().mockRejectedValueOnce(new Error('revocation storage unavailable'))
      .mockRejectedValueOnce(new Error('revocation storage unavailable')).mockResolvedValue(null);
    const env = { ...edge(), SONIC_KEY_REVOCATION_KV: { get, put: vi.fn() } };
    const session = await createSession(env, { email: 'events-recovery@example.invalid', name: 'Recovery', avatar: '' });
    const request = incoming('POST', '', { Cookie: `sonic_session=${session.apiKey}`, Origin: 'https://edge.followup.test' });
    request.headers.delete('X-Sonic-Anon-Id');
    engineHop(authority);

    const response = await events({ request, env });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1 } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('does not turn an unavailable authoritative GET into an empty memory history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('offline', { status: 530 }));
    const response = await events({ request: incoming('GET'), env: edge() });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-sonic-degraded')).toBe('1');
    expect(await response.json()).toMatchObject({ error: { code: 'EVENT_STORAGE_UNAVAILABLE' }, meta: { retryable: true } });
  });

  it('handles opted-out GET and DELETE as public without touching another subject', async () => {
    const authority = engine();
    engineHop(authority);
    await events({ request: incoming(), env: edge() });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(1);
    const read = await events({ request: incoming('GET', '?personalization=off'), env: edge() });
    expect(await read.json()).toMatchObject({ data: { privacyMode: 'public', totalEvents: 0 } });
    const deleted = await events({ request: incoming('DELETE', '?personalize=false', { 'X-Sonic-Erasure-Target': 'public' }), env: edge() });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { privacyMode: 'public', cleared: false, removedEvents: 0 } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(1);
  });

  it.each(['Pages with Engine', 'local SQLite'])('checks the intended erasure target before mutation (%s)', async (runtime) => {
    const authority = engine();
    const throughEngine = runtime === 'Pages with Engine';
    const env = throughEngine ? edge() : { ...edge(), SONIC_LOCAL_ENGINE_URL: '', RECOMMEND_STORE: authority.RECOMMEND_STORE };
    const hop = engineHop(authority);
    const accountA = await createSession(env, { email: 'erasure-a@example.invalid', name: 'A', avatar: '' });
    const accountB = await createSession(env, { email: 'erasure-b@example.invalid', name: 'B', avatar: '' });
    const cookieA = { Cookie: `sonic_session=${accountA.apiKey}`, Origin: 'https://edge.followup.test' };
    const cookieB = { Cookie: `sonic_session=${accountB.apiKey}`, Origin: 'https://edge.followup.test' };
    const target = 'X-Sonic-Erasure-Target';
    const subjects = [{}, cookieA, cookieB];
    const readCounts = async () => Promise.all(subjects.map(async (headers) => {
      const response = await events({ request: incoming('GET', '', headers), env });
      expect(response.status).toBe(200);
      return (await response.json()).data.totalEvents;
    }));

    const seedHeaders = [
      { 'X-Sonic-Event-Target': 'anonymous-opt-in' },
      { ...cookieA, 'X-Sonic-Event-Target': `account:${accountA.id}` },
      { ...cookieB, 'X-Sonic-Event-Target': `account:${accountB.id}` },
    ];
    for (const headers of seedHeaders) {
      expect((await events({ request: incoming('POST', '', headers), env })).status).toBe(200);
    }
    expect(await readCounts()).toEqual([1, 1, 1]);
    hop.mockClear();
    for (const headers of [
      { ...cookieB, [target]: 'anonymous-opt-in' },
      { ...cookieB, [target]: `account:${accountA.id}` },
      { ...cookieB, [target]: 'public' },
      { ...cookieB, [target]: 'account:' },
      { [target]: `account:${accountA.id}` },
      cookieB,
    ]) {
      const response = await events({ request: incoming('DELETE', '', headers), env });
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ error: { code: 'EVENT_ERASURE_IDENTITY_MISMATCH' } });
    }
    expect(hop).not.toHaveBeenCalled();
    expect(await readCounts()).toEqual([1, 1, 1]);

    hop.mockClear();
    const cleared = await events({
      request: incoming('DELETE', '', { ...cookieA, [target]: `account:${accountA.id}` }), env,
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ data: { privacyMode: 'authenticated', cleared: true, removedEvents: 1 } });
    if (throughEngine) {
      const forwarded = new Headers(hop.mock.calls[0]?.[1]?.headers);
      for (const name of [target, 'Cookie', 'X-Sonic-Anon-Id']) expect(forwarded.has(name)).toBe(false);
      expect(forwarded.has(ENGINE_IDENTITY_HEADER)).toBe(true);
    }
    expect(await readCounts()).toEqual([1, 0, 1]);

    const guestCleared = await events({ request: incoming('DELETE', '', { [target]: 'anonymous-opt-in' }), env });
    expect(guestCleared.status).toBe(200);
    expect(await guestCleared.json()).toMatchObject({ data: { privacyMode: 'anonymous-opt-in', cleared: true, removedEvents: 1 } });
    expect(await readCounts()).toEqual([0, 0, 1]);

    const keyCleared = await events({ request: incoming('DELETE', '', { 'X-Sonic-Key': accountB.apiKey }), env });
    expect(keyCleared.status).toBe(200);
    expect(await readCounts()).toEqual([0, 0, 0]);
  });

  it.each(['POST', 'DELETE'])('refuses to forward a checked stored target without a signed identity (%s)', async (method) => {
    const hop = vi.spyOn(globalThis, 'fetch');
    const env = { ...edge(), SONIC_REQUIRE_ENGINE_IDENTITY: '0', SONIC_ENGINE_IDENTITY_SECRET: '' };
    const target = method === 'POST' ? 'X-Sonic-Event-Target' : 'X-Sonic-Erasure-Target';
    const response = await events({
      request: incoming(method, '', { [target]: 'anonymous-opt-in' }), env,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ENGINE_IDENTITY_UNAVAILABLE' } });
    expect(hop).not.toHaveBeenCalled();
  });

  it('fails required configuration before a network request and reports missing readiness', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const env = { ...edge(), SONIC_ENGINE_IDENTITY_SECRET: '' };
    const response = await callLocalEngineJson('/api/sonic/events', env, { request: incoming('GET') });
    expect(response).toMatchObject({ ok: false, status: 503, errorCode: 'ENGINE_IDENTITY_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    expect(getEngineIdentityReadiness({ ...env, SONIC_REQUIRE_ENGINE_IDENTITY: '0', SONIC_ENV: 'production' })).toMatchObject({ required: true, configured: false, ok: false });
    const request = new Request('https://engine.followup.test/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': serviceKey } });
    const result = await health({ request, env: { ...engine(), SONIC_ENGINE_IDENTITY_SECRET: '' } });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ readiness: { identity: { required: true, configured: false, ok: false } } });
  });
});

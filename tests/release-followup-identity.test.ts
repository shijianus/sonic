import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../functions/_lib/auth';
import type { AppEnv } from '../functions/_lib/types';
import { onRequest as events } from '../functions/api/sonic/events';
import { onRequest as health } from '../functions/api/sonic/engine/health';
import { callLocalEngineJson, resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';
import { ENGINE_IDENTITY_HEADER, ENGINE_IDENTITY_REQUIRED_HEADER, issueEngineIdentity, requireValidEngineIdentity, getEngineIdentityReadiness } from '../functions/_lib/sonic/engine-identity';
import { resolveUserIdentity } from '../functions/_lib/sonic/recommend/identity';
import { SqliteRecommendStore } from '../server/recommend-sqlite';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';

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
afterEach(() => { vi.restoreAllMocks(); resetLocalEngineCircuitForTest(); for (const store of stores.splice(0)) store.close(); });

describe('Follow-up identity and consent over the actual events hop', () => {
  it.each(['?personalize=0', '?personalization=off', '?personalize=on&personalization=false', '?personalize=1&personalize=0'])('does not persist an opted-out query %s', async query => {
    const authority = engine();
    engineHop(authority);
    const response = await events({ request: incoming('POST', query), env: edge() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1, storageKind: 'none' } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(0);
  });

  it('keeps header opt-out authoritative and removes raw credentials and identity hints', async () => {
    const authority = engine();
    const seen: Headers[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push(new Headers(init?.headers));
      return events({ request: new Request(String(url), init), env: authority });
    });
    const response = await events({ request: incoming('POST', '', { 'X-Sonic-Personalization': 'off', Cookie: 'ignored=value', 'X-Sonic-Key': 'not-a-user-token', 'X-Sonic-Context': 'e30' }), env: edge() });
    expect(response.status).toBe(200);
    expect(seen[0].get('x-sonic-personalization')).toBe('off');
    for (const name of ['authorization', 'cookie', 'x-sonic-key', 'x-sonic-anon-id', 'x-sonic-context']) expect(seen[0].has(name)).toBe(false);
    expect(await requireValidEngineIdentity(new Request('https://engine.followup.test/api/sonic/events', { method: 'POST', headers: seen[0] }), authority)).toMatchObject(publicIdentity);
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

  it('refuses a legacy public acknowledgement for an opt-in subject', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ brand: 'Sonic', data: { ok: true, privacyMode: 'public', accepted: 0, ignoredByPrivacy: 1, storageKind: 'none' } }));
    const response = await events({ request: incoming(), env: edge() });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'ENGINE_IDENTITY_UNAVAILABLE' } });
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
    const deleted = await events({ request: incoming('DELETE', '?personalize=false'), env: edge() });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { privacyMode: 'public', cleared: false, removedEvents: 0 } });
    expect(authority.RECOMMEND_STORE.getStats().eventCount).toBe(1);
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

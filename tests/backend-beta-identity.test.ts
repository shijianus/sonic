import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENGINE_IDENTITY_HEADER, issueEngineIdentity, verifyEngineIdentity } from '../functions/_lib/sonic/engine-identity';
import { resolveUserIdentity } from '../functions/_lib/sonic/recommend/identity';
import { createSession } from '../functions/_lib/auth';
import { callLocalEngineJson, resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';

const shared = { SONIC_ENGINE_SECRET: 'service-test-key-at-least-32-characters-long', SONIC_ENGINE_IDENTITY_SECRET: 'identity-test-key-at-least-32-characters-long' };
const identity = { mode: 'authenticated' as const, subjectKey: 'usr_' + 'a'.repeat(24), isAuthenticated: true, personalizationEnabled: true };
const engineEnv = { ...shared, SONIC_RUNTIME: 'linux-engine' };
const now = 1793577600000;
const request = (assertion: string, path = '/api/sonic/events', method = 'POST') => new Request(`https://engine.example${path}`, { method, headers: { 'X-Sonic-Engine-Key': shared.SONIC_ENGINE_SECRET, [ENGINE_IDENTITY_HEADER]: assertion } });
afterEach(() => { vi.unstubAllGlobals(); resetLocalEngineCircuitForTest(); });

describe('Signed internal subject identity', () => {
  it('preserves the verified subject without exposing user tokens or email', async () => {
    const assertion = await issueEngineIdentity(identity, 'POST', '/api/sonic/events', shared, now);
    expect(assertion).toBeTruthy();
    expect(assertion).not.toContain('email');
    expect(await verifyEngineIdentity(request(assertion!), engineEnv, now)).toMatchObject(identity);
    expect(await verifyEngineIdentity(request(assertion!), { ...engineEnv, SONIC_ENGINE_IDENTITY_SECRET: 'wrong-key-with-at-least-32-characters' }, now)).toBeNull();
  });

  it('rejects tampering, expiry, method/path/query changes and public Edge assertions', async () => {
    const assertion = (await issueEngineIdentity(identity, 'POST', '/api/sonic/events?a=1', shared, now))!;
    expect(await verifyEngineIdentity(request(assertion, '/api/sonic/events?a=1'), engineEnv, now + 31000)).toBeNull();
    expect(await verifyEngineIdentity(request(assertion, '/api/sonic/events?a=1', 'DELETE'), engineEnv, now)).toBeNull();
    expect(await verifyEngineIdentity(request(assertion, '/api/sonic/events?a=2'), engineEnv, now)).toBeNull();
    expect(await verifyEngineIdentity(request(assertion, '/api/sonic/events?a=1'), { ...engineEnv, SONIC_RUNTIME: 'cf-pages' }, now)).toBeNull();
    expect(await verifyEngineIdentity(request(assertion.slice(0, -1) + (assertion.endsWith('a') ? 'b' : 'a'), '/api/sonic/events?a=1'), engineEnv, now)).toBeNull();
    const missingServiceKey = request(assertion, '/api/sonic/events?a=1');
    missingServiceKey.headers.delete('X-Sonic-Engine-Key');
    expect(await verifyEngineIdentity(missingServiceKey, engineEnv, now)).toBeNull();
  });

  it('never overrides explicit opt-out or trusts a forged client subject header', async () => {
    const assertion = (await issueEngineIdentity(identity, 'GET', '/api/sonic/events', shared))!;
    const optedOut = request(assertion, '/api/sonic/events', 'GET');
    optedOut.headers.set('X-Sonic-Personalization', 'off');
    expect(await resolveUserIdentity(optedOut, engineEnv)).toMatchObject({ mode: 'public', subjectKey: null, personalizationEnabled: false });
    expect(await resolveUserIdentity(new Request('https://public.example/api/sonic/events', { headers: { [ENGINE_IDENTITY_HEADER]: assertion } }), { ...shared, SONIC_RUNTIME: 'cf-pages' })).toMatchObject({ mode: 'public', subjectKey: null });
  });

  it('forwards a verified Edge session to an Engine without rotating or sharing the user signing key', async () => {
    const edgeEnv = { ...shared, SONIC_RUNTIME: 'cf-pages', SONIC_LOCAL_ENGINE_URL: 'https://engine.example', SONIC_SECRET: 'edge-user-signing-secret-at-least-32-characters' };
    const session = await createSession(edgeEnv, { id: 'test-user', email: 'existing-user@example.com', name: 'Existing user', avatar: '', role: 'user' });
    const incoming = new Request('https://sonic.example/api/sonic/events', { headers: { 'X-Sonic-Key': session.apiKey } });
    const expected = await resolveUserIdentity(incoming, edgeEnv);
    const seen = { rawCredentials: false, assertion: false };
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request | URL, init: RequestInit) => {
      const forwarded = new Request(String(input), init);
      seen.rawCredentials = forwarded.headers.has('X-Sonic-Key') || forwarded.headers.has('Cookie') || forwarded.headers.has('Authorization');
      seen.assertion = forwarded.headers.has(ENGINE_IDENTITY_HEADER);
      const verified = await resolveUserIdentity(forwarded, engineEnv);
      return new Response(JSON.stringify({ brand: 'Sonic', data: { subjectKey: verified.subjectKey, mode: verified.mode, privacyMode: verified.mode } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const response = await callLocalEngineJson<any>('/api/sonic/events', edgeEnv, { request: incoming });
    expect(response.ok).toBe(true);
    expect(response.data.data).toEqual({ subjectKey: expected.subjectKey, mode: 'authenticated', privacyMode: 'authenticated' });
    expect(seen).toEqual({ rawCredentials: false, assertion: true });
  });
});

describe('Account library read and retry contracts', () => {
  it('requires the browser library to target the currently verified cookie account', async () => {
    const { onRequest } = await import('../functions/api/account/library');
    const { SqliteAccountStore } = await import('../server/account-store');
    const store = new SqliteAccountStore(':memory:');
    try {
      const env = { SONIC_ENV: 'test', SONIC_SECRET: 'test-account-library-user-signing-key-32-chars', ACCOUNT_STORE: store };
      const account = await createSession(env, { id: 'first-reader', name: 'Reader', email: 'first@example.test', avatar: '', role: 'user' });
      const request = (method: string, target?: string, bearer = false) => new Request('https://library.example/api/account/library', {
        method, headers: {
          ...(bearer ? { Authorization: 'Bearer ' + account.apiKey } : { Cookie: 'sonic_session=' + account.apiKey }),
          ...(target === undefined ? {} : { 'X-Sonic-Account-Target': target }),
          Origin: 'https://library.example',
        },
        ...(method === 'POST' ? { body: JSON.stringify({ operationId: 'first-edit', baseVersion: 0,
          operations: [{ collection: 'likedSongs', type: 'upsert', id: '1', value: { name: 'One' } }] }) } : {}),
      });
      for (const method of ['GET', 'POST']) {
        for (const target of [undefined, 'second-reader']) {
          const result = await onRequest({ request: request(method, target), env });
          expect(result.status).toBe(409);
          expect((await result.json()).error.code).toBe('ACCOUNT_IDENTITY_MISMATCH');
        }
      }
      const saved = await onRequest({ request: request('POST', account.id), env });
      expect(saved.status).toBe(200);
      const data = await onRequest({ request: request('GET', account.id), env });
      expect((await data.json()).data.likedSongs).toMatchObject([{ id: '1', name: 'One' }]);
      expect((await onRequest({ request: request('GET', undefined, true), env })).status).toBe(200);
    } finally { store.close(); }
  });

  it('recognizes identical legacy retries after a lost receipt and rejects changed operations', async () => {
    const { SqliteAccountStore } = await import('../server/account-store');
    const store = new SqliteAccountStore(':memory:');
    try {
      const subject = 'usr_' + '5'.repeat(24);
      const original = { operationId: 'lost-response', baseVersion: 0, operations: [{
        collection: 'likedSongs' as const, type: 'upsert' as const, id: 'one', value: { id: 'one', name: 'One' },
      }] };
      expect(store.applyLibraryMutation(subject, original).version).toBe(1);
      const retry = { ...original, baseVersion: 1 };
      expect(store.applyLibraryMutation(subject, retry)).toMatchObject({ replayed: true, version: 1 });
      expect(() => store.applyLibraryMutation(subject, { ...retry, operations: [{ ...original.operations[0], value: { id: 'one', name: 'Different' } }] }))
        .toThrowError(/operationId already used/);
      expect(store.getLibrary(subject)).toMatchObject({ version: 1, likedSongs: [{ id: 'one', name: 'One' }] });
    } finally { store.close(); }
  });
});

import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSession } from '../functions/_lib/auth';
import { onRequest as revoke } from '../functions/api/auth/revoke';
import { callLocalEngineJson } from '../functions/_lib/sonic/local-engine';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import type { AppEnv } from '../functions/_lib/types';
import { onRequest } from '../functions/api/music/ecs';
import { createSonicServer } from '../server/index';

const path = '/api/music/ecs';
const origin = 'https://player.example';
const base = {
  SONIC_RUNTIME: 'cf-pages', SONIC_ENV: 'test', SONIC_ACCESS_MODE: 'open',
  SONIC_SECRET: 'test-only-ECS-pages-signing-key-valid-length',
  SONIC_ENGINE_SECRET: 'test-only-ECS-engine-service-key-valid-length',
  SONIC_ENGINE_IDENTITY_SECRET: 'test-only-ECS-inter-service-identity-signing-key',
  SONIC_ECS_MASTER_KEY: '12'.repeat(32),
  SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'synthetic,netease',
  SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1', SONIC_ENABLE_NETEASE: '1',
  SONIC_ECS_DOWNLOAD_SOURCES: 'synthetic', SONIC_ECS_EXPORT_SOURCES: 'synthetic',
};

function request(body: object, headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, ...headers,
  }, body: JSON.stringify(body) });
}

async function post(body: object, env: AppEnv = base, headers?: Record<string, string>) {
  const response = await onRequest({ request: request(body, headers), env });
  return { status: response.status, headers: response.headers, data: await response.json() };
}

function account() {
  return createSession(base, { id: 'ecs-listener', name: 'Listener', email: 'listener@example.test', avatar: '' });
}

async function issue(env: AppEnv = base, source = 'synthetic', tier = 2) {
  const result = await post({ action: 'issue', source, tier }, env);
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toContain('no-store');
  expect(result.data).toMatchObject({ source, tier, key: expect.stringMatching(/^[\w-]{43}$/), ticket: expect.any(String) });
  return result.data;
}

describe('ECS license and export policy', () => {
  it.each([1, 2, 3])('issues and reopens a guest ECS%s ticket, with a new content key per file', async tier => {
    const grant = await issue(base, 'synthetic', tier);
    const next = await issue(base, 'synthetic', tier);
    expect(next.key).not.toBe(grant.key);
    expect(next.ticket).not.toBe(grant.ticket);
    const played = await post({ action: 'play', ticket: grant.ticket });
    expect(played.status).toBe(200);
    expect(played.headers.get('cache-control')).toContain('no-store');
    expect(played.data).toEqual({ key: grant.key, tier, source: 'synthetic' });
  });

  it('reserves high export for original and high archives', async () => {
    const grant = await issue(base, 'synthetic', 3);
    const session = await account();
    const response = await post({ action: 'export', target: 'high', ticket: grant.ticket }, base, { Cookie: 'sonic_session=' + session.apiKey });
    expect(response.status).toBe(403);
    expect(response.data.error.code).toBe('ECS_HIGHER_QUALITY_UNAVAILABLE');
  });

  it('uses the intersection of the download grant and current content policy', async () => {
    const body = { action: 'issue', source: 'netease', tier: 1 };
    expect(await post(body)).toMatchObject({ status: 403, data: { error: { code: 'DOWNLOAD_NOT_PERMITTED' } } });
    const allowed = { ...base, SONIC_ECS_DOWNLOAD_SOURCES: 'netease' };
    const grant = await issue(allowed, 'netease', 1);
    const withdrawn = { ...allowed, SONIC_ALLOWED_SOURCES: 'synthetic' };
    for (const env of [base, withdrawn]) {
      const play = await post({ action: 'play', ticket: grant.ticket }, env);
      expect(play).toMatchObject({ status: 403, data: { error: { code: 'DOWNLOAD_NOT_PERMITTED' } } });
      expect(play.data).not.toHaveProperty('key');
    }
    expect((await post(body, withdrawn)).status).toBe(403);
  });

  it('requires a verified session and independent source permission for all three export targets', async () => {
    const grant = await issue();
    const member = await account();
    const cookie = { Cookie: 'sonic_session=' + member.apiKey };
    for (const target of ['original', 'high', 'standard']) {
      const body = { action: 'export', ticket: grant.ticket, target };
      const guest = await post(body);
      expect(guest).toMatchObject({ status: 401, data: { error: { code: 'ACCOUNT_REQUIRED' } } });
      expect(guest.data).not.toHaveProperty('key');
      const disallowed = await post(body, { ...base, SONIC_ECS_EXPORT_SOURCES: 'netease' }, cookie);
      expect(disallowed).toMatchObject({ status: 403, data: { error: { code: 'EXPORT_NOT_PERMITTED' } } });
      const ok = await post(body, base, cookie);
      expect(ok).toMatchObject({ status: 200, data: { key: grant.key, tier: 2, source: 'synthetic' } });
    }
    const invalid = await post({ action: 'export', ticket: grant.ticket, target: 'unknown' }, base, cookie);
    expect(invalid).toMatchObject({ status: 400, data: { error: { code: 'INVALID_EXPORT_TARGET' } } });
  });

  it('requires same-origin browser context for account-cookie exports', async () => {
    const member = await account();
    const grant = await issue();
    const body = { action: 'export', target: 'original', ticket: grant.ticket };
    const crossSite = await post(body, base, { Cookie: 'sonic_session=' + member.apiKey, Origin: 'https://another.example' });
    expect(crossSite.status).toBe(403);
    expect(crossSite.data).not.toHaveProperty('key');
    const noOrigin = request(body, { Cookie: 'sonic_session=' + member.apiKey });
    noOrigin.headers.delete('Origin');
    expect((await onRequest({ request: noOrigin, env: base })).status).toBe(403);
  });

  it('rejects cross-origin guest issuance and browser-marked cross-site playback', async () => {
    const ticket = (await issue()).ticket;
    for (const body of [{ action: 'issue', tier: 1, source: 'synthetic' }, { action: 'play', ticket }]) {
      for (const headers of [{ Origin: 'https://another.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const result = await post(body, base, headers);
        expect(result).toMatchObject({ status: 403, data: { error: { code: 'ORIGIN_NOT_PERMITTED' } } });
        expect(result.data).not.toHaveProperty('key');
      }
    }
  });

  it('requires a current account session after revocation, while guest play remains available', async () => {
    const entries = new Map<string, string>();
    const env = { ...base, SONIC_KEY_REVOCATION_KV: {
      get: async (key: string) => entries.get(key) || null,
      put: async (key: string, value: string) => { entries.set(key, value); },
    } };
    const member = await account();
    const cookie = { Cookie: 'sonic_session=' + member.apiKey };
    const { ticket } = await issue(env);
    const body = { action: 'export', target: 'original', ticket };
    expect((await post(body, env, cookie)).status).toBe(200);
    const revoked = await revoke({ request: new Request(origin + '/api/auth/revoke', {
      method: 'POST', headers: { 'X-Sonic-Key': member.apiKey, Origin: origin },
    }), env });
    expect(revoked.status).toBe(200);
    expect(await post(body, env, cookie)).toMatchObject({ status: 401, data: { error: { code: 'ACCOUNT_REQUIRED' } } });
    expect((await post({ action: 'play', ticket }, env)).status).toBe(200);
  });

  it('reads previous-key tickets only during rotation and writes new tickets under the current key', async () => {
    const old = await issue();
    const next = { ...base, SONIC_ECS_MASTER_KEY: '34'.repeat(32) };
    const overlap = { ...next, SONIC_ECS_MASTER_KEY_PREV: base.SONIC_ECS_MASTER_KEY };
    expect((await post({ action: 'play', ticket: old.ticket }, overlap)).data.key).toBe(old.key);
    const fresh = await issue(overlap);
    expect((await post({ action: 'play', ticket: fresh.ticket }, next)).data.key).toBe(fresh.key);
    for (const [ticket, env] of [[old.ticket, next], [fresh.ticket, base]] as const) {
      expect(await post({ action: 'play', ticket }, env)).toMatchObject({ status: 400, data: { error: { code: 'INVALID_ECS_LICENSE' } } });
    }
    expect((await post({ action: 'issue', tier: 1, source: 'synthetic' }, { ...base, SONIC_ECS_MASTER_KEY: '' })).status).toBe(503);
  });

  it('rejects truncated or altered tickets without returning a key', async () => {
    const issued = await issue();
    const [nonce, ciphertext] = issued.ticket.split('.');
    // Alter a full sextet of authenticated ciphertext (not unused base64 padding bits).
    const changed = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    for (const ticket of [nonce, nonce + '.' + changed]) {
      const result = await post({ action: 'play', ticket });
      expect(result).toMatchObject({ status: 400, data: { error: { code: 'INVALID_ECS_LICENSE' } } });
      expect(result.data).not.toHaveProperty('key');
    }
  });

  it('routes an Edge-verified account to the Node Engine independently of personalization consent', async () => {
    const server = createSonicServer(undefined, {
      ...base, SONIC_REQUIRE_ENGINE_IDENTITY: '1', RECOMMEND_STORE: new MemoryRecommendStore(),
      SONIC_SECRET: 'test-only-separate-engine-local-session-key',
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const engine = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      const edge = { ...base, SONIC_LOCAL_ENGINE_URL: engine, SONIC_ENABLE_LOCAL_ENGINE: '1' };
      const issued = await issue();
      const body = { action: 'export', ticket: issued.ticket, target: 'original' };
      const member = await account();
      const options = { method: 'POST', body: JSON.stringify(body) };
      const guest = await callLocalEngineJson(path, edge, { ...options, request: request(body) });
      expect(guest.status).toBe(401);
      const signed = await callLocalEngineJson(path, edge, { ...options,
        request: request(body, { Cookie: 'sonic_session=' + member.apiKey, 'X-Sonic-Personalization': 'off' }),
      });
      expect(signed).toMatchObject({ ok: true, status: 200, data: { key: issued.key, source: 'synthetic', tier: 2 } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSession,
  OAUTH_STATE_REGEX,
  PKCE_VERIFIER_REGEX,
  resetKeyRevocationCacheForTest,
  resetOAuthStateReplayCacheForTest,
  verifyAuth,
} from '../functions/_lib/auth';
import { onRequest as handleAuthLogin } from '../functions/api/auth/login';
import { onRequest as handleAuthCallback } from '../functions/api/auth/callback';
import { onRequest as handleAuthUser } from '../functions/api/auth/user';
import { onRequest as handleAuthKey } from '../functions/api/auth/key';
import { onRequest as handleAuthLogout } from '../functions/api/auth/logout';
import { onRequest as handleAuthRevoke } from '../functions/api/auth/revoke';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';
import { guardGatewayRequest } from '../functions/_lib/sonic/route-helpers';

const SECRET = 'super_secret_sonic_key_2026_primary_abcdef123456';
const STATE = 'A'.repeat(43);
const VERIFIER = 'B'.repeat(43);
const REDIRECT_URI = 'https://sonic.example.com/api/auth/callback';

function env(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    EPOMAIL_BASE_URL: 'https://mail.example.com',
    EPOMAIL_CLIENT_ID: 'client_123',
    EPOMAIL_CLIENT_SECRET: 'secret_123',
    EPOMAIL_REDIRECT_URI: REDIRECT_URI,
    SONIC_SECRET: SECRET,
    ...overrides,
  };
}

function callbackRequest(query: string, cookies?: string): Request {
  return new Request(`https://sonic.example.com/api/auth/callback?${query}`, {
    headers: cookies ? { Cookie: cookies } : undefined,
  });
}

function setCookies(res: Response): string[] {
  return typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [];
}

function mockOAuthProvider() {
  const calls: Array<{ url: string; body?: string; headers?: Headers }> = [];
  const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    if (url.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'provider_access_token_123456' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/oauth/userinfo')) {
      return new Response(
        JSON.stringify({
          id: 'epomail-user-1',
          email: 'alice@example.com',
          name: 'Alice',
          email_verified: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unexpected upstream', { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  resetRateLimitsForTest();
  resetOAuthStateReplayCacheForTest();
  resetKeyRevocationCacheForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth login: state + PKCE transaction', () => {
  it('issues a 256-bit state, S256 challenge and HttpOnly transaction cookies', async () => {
    const res = await handleAuthLogin({
      request: new Request('https://sonic.example.com/api/auth/login?mode=json'),
      env: env() as any,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const authorize = new URL(json.authorizeUrl);
    expect(authorize.origin).toBe('https://mail.example.com');
    expect(authorize.pathname).toBe('/oauth/authorize');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get('state')).toMatch(OAUTH_STATE_REGEX);
    expect(authorize.searchParams.get('code_verifier')).toBeNull();

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/api/auth');
    }
    expect(cookies.some((c) => c.startsWith('sonic_oauth_state='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sonic_oauth_verifier='))).toBe(true);
  });

  it('rejects a non-HTTPS OAuth base URL instead of sending the client secret in cleartext', async () => {
    const res = await handleAuthLogin({
      request: new Request('https://sonic.example.com/api/auth/login'),
      env: env({ EPOMAIL_BASE_URL: 'http://mail.example.com' }) as any,
    });
    expect(res.status).toBe(400);
  });
});

describe('OAuth callback: state, PKCE, code exchange and session delivery', () => {
  it('exchanges the code with the PKCE verifier and delivers the session only via HttpOnly cookie', async () => {
    const { calls } = mockOAuthProvider();
    const res = await handleAuthCallback({
      request: callbackRequest(`code=authorization_code_123&state=${STATE}`, [
        `sonic_oauth_state=${STATE}`,
        `sonic_oauth_verifier=${VERIFIER}`,
      ].join('; ')),
      env: env() as any,
    });

    expect(res.status).toBe(302);
    const location = res.headers.get('Location') || '';
    expect(location).toBe('https://sonic.example.com/?auth=success');
    expect(location).not.toContain('apiKey');
    expect(location).not.toContain('session=');
    expect(location).not.toContain('sonic_live_v2');

    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(tokenCall).toBeTruthy();
    const tokenBody = JSON.parse(tokenCall!.body || '{}');
    expect(tokenBody.grant_type).toBe('authorization_code');
    expect(tokenBody.code).toBe('authorization_code_123');
    expect(tokenBody.code_verifier).toBe(VERIFIER);
    expect(tokenBody.client_secret).toBe('secret_123');

    const userCall = calls.find((c) => c.url.endsWith('/oauth/userinfo'));
    expect(userCall?.headers?.get('authorization')).toBe('Bearer provider_access_token_123456');

    const cookies = setCookies(res);
    const sessionCookie = cookies.find((c) => c.startsWith('sonic_session='));
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(cookies.some((c) => c.startsWith('sonic_oauth_state=;'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sonic_oauth_verifier=;'))).toBe(true);

    const token = sessionCookie!.split(';')[0].slice('sonic_session='.length);
    const auth = await verifyAuth(
      new Request('https://sonic.example.com/api/auth/user', {
        headers: { Cookie: `sonic_session=${token}` },
      }),
      env() as any,
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.source).toBe('cookie');
    expect(auth.user?.email).toBe('alice@example.com');
  });

  it('fails closed when the PKCE verifier cookie is missing', async () => {
    const { fetchMock } = mockOAuthProvider();
    const res = await handleAuthCallback({
      request: callbackRequest(`code=authorization_code_123&state=${STATE}`, `sonic_oauth_state=${STATE}`),
      env: env() as any,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('OAUTH_PKCE_MISSING');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched state without contacting the provider', async () => {
    const { fetchMock } = mockOAuthProvider();
    const res = await handleAuthCallback({
      request: callbackRequest(`code=abc&state=${STATE}`, `sonic_oauth_state=${'C'.repeat(43)}; sonic_oauth_verifier=${VERIFIER}`),
      env: env() as any,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('OAUTH_STATE_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects replay of an already-used state', async () => {
    const { fetchMock } = mockOAuthProvider();
    const req = () =>
      callbackRequest(`code=authorization_code_123&state=${STATE}`, [
        `sonic_oauth_state=${STATE}`,
        `sonic_oauth_verifier=${VERIFIER}`,
      ].join('; '));

    const first = await handleAuthCallback({ request: req(), env: env() as any });
    expect(first.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const replay = await handleAuthCallback({ request: req(), env: env() as any });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe('OAUTH_STATE_REPLAYED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears transaction cookies and never creates a session on provider denial', async () => {
    const { fetchMock } = mockOAuthProvider();
    const res = await handleAuthCallback({
      request: callbackRequest('error=access_denied&state=ignored'),
      env: env() as any,
    });
    expect(res.status).toBe(400);
    const cookies = setCookies(res);
    expect(cookies.some((c) => c.startsWith('sonic_session='))).toBe(false);
    expect(cookies.some((c) => c.startsWith('sonic_oauth_state=;'))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a verified-email=false account', async () => {
    vi.stubGlobal('fetch', async (input: any) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'provider_access_token_123456' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ email: 'alice@example.com', email_verified: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const res = await handleAuthCallback({
      request: callbackRequest(`code=authorization_code_123&state=${STATE}`, [
        `sonic_oauth_state=${STATE}`,
        `sonic_oauth_verifier=${VERIFIER}`,
      ].join('; ')),
      env: env() as any,
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('OAUTH_EXCHANGE_FAILED');
    expect(setCookies(res).some((c) => c.startsWith('sonic_session='))).toBe(false);
  });
});

describe('Session-backed API key management', () => {
  async function loginSession() {
    mockOAuthProvider();
    const res = await handleAuthCallback({
      request: callbackRequest(`code=authorization_code_123&state=${STATE}`, [
        `sonic_oauth_state=${STATE}`,
        `sonic_oauth_verifier=${VERIFIER}`,
      ].join('; ')),
      env: env() as any,
    });
    const cookie = setCookies(res).find((c) => c.startsWith('sonic_session='))!;
    return cookie.split(';')[0];
  }

  it('returns profile without the bearer key and exposes the key only on the key endpoint', async () => {
    const cookie = await loginSession();
    const req = () =>
      new Request('https://sonic.example.com/api/auth/user', {
        headers: { Cookie: cookie },
      });

    const userRes = await handleAuthUser({ request: req(), env: env() as any });
    expect(userRes.status).toBe(200);
    const userJson = await userRes.json();
    expect(userJson.user.email).toBe('alice@example.com');
    expect(userJson.user.apiKey).toBeUndefined();

    const keyRes = await handleAuthKey({ request: req(), env: env() as any });
    expect(keyRes.status).toBe(200);
    const keyJson = await keyRes.json();
    expect(keyJson.apiKey).toMatch(/^sonic_live_v2\./);
  });

  it('requires an explicit header credential to re-issue a key (cookie alone is insufficient)', async () => {
    const cookie = await loginSession();
    const cookieOnly = await handleAuthKey({
      request: new Request('https://sonic.example.com/api/auth/key', {
        method: 'POST',
        headers: { Cookie: cookie },
      }),
      env: env() as any,
    });
    expect(cookieOnly.status).toBe(403);
    expect((await cookieOnly.json()).error.code).toBe('REAUTH_REQUIRED');

    const key = (await (
      await handleAuthKey({
        request: new Request('https://sonic.example.com/api/auth/key', {
          headers: { Cookie: cookie },
        }),
        env: env() as any,
      })
    ).json()).apiKey;

    const withHeader = await handleAuthKey({
      request: new Request('https://sonic.example.com/api/auth/key', {
        method: 'POST',
        headers: { 'X-Sonic-Key': key },
      }),
      env: env() as any,
    });
    expect(withHeader.status).toBe(200);
    const reissued = await withHeader.json();
    expect(reissued.apiKey).toMatch(/^sonic_live_v2\./);
    expect(reissued.apiKey).not.toBe(key);
    expect(setCookies(withHeader).some((c) => c.startsWith('sonic_session='))).toBe(true);
  });

  it('logout clears the HttpOnly session cookie', async () => {
    const cookie = await loginSession();
    const res = await handleAuthLogout({
      request: new Request('https://sonic.example.com/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie },
      }),
      env: env() as any,
    });
    expect(res.status).toBe(200);
    const cookies = setCookies(res);
    expect(cookies.some((c) => c.startsWith('sonic_session=;'))).toBe(true);
    expect(cookies.some((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('rejects cross-site cookie-authenticated writes', async () => {
    const cookie = await loginSession();
    const crossSite = await guardGatewayRequest(
      new Request('https://sonic.example.com/api/sonic/events', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://evil.example' },
      }),
      env(),
      'csrf-test',
    );
    expect(crossSite?.status).toBe(403);
    expect((await crossSite!.json()).error.code).toBe('CSRF_REJECTED');

    const sameOrigin = await guardGatewayRequest(
      new Request('https://sonic.example.com/api/sonic/events', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://sonic.example.com' },
      }),
      env(),
      'csrf-test',
    );
    expect(sameOrigin).toBeNull();
  });
});

describe('Optional KV-backed API key revocation', () => {
  function mockKv() {
    const store = new Map<string, string>();
    return {
      store,
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
  }

  function kvEnv(kv: any, overrides: Record<string, any> = {}) {
    return env({
      SONIC_ENABLE_KEY_REVOCATION: '1',
      SONIC_KEY_REVOCATION_KV: kv,
      ...overrides,
    });
  }

  async function issue(environment: any) {
    return createSession(environment as any, {
      email: 'revoke-me@example.com',
      name: 'Revoke Me',
      avatar: '',
    });
  }

  it('revokes the exact jti and rejects it across a cold cache', async () => {
    const kv = mockKv();
    const environment = kvEnv(kv);
    const session = await issue(environment);

    const res = await handleAuthRevoke({
      request: new Request('https://sonic.example.com/api/auth/revoke', {
        method: 'POST',
        headers: { 'X-Sonic-Key': session.apiKey, Origin: 'https://sonic.example.com' },
      }),
      env: environment as any,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revoked).toBe(true);
    expect(kv.store.size).toBe(1);

    const warm = await verifyAuth(
      new Request('https://sonic.example.com/api/x', {
        headers: { 'X-Sonic-Key': session.apiKey },
      }),
      environment as any,
    );
    expect(warm.authenticated).toBe(false);

    resetKeyRevocationCacheForTest();
    const cold = await verifyAuth(
      new Request('https://sonic.example.com/api/x', {
        headers: { 'X-Sonic-Key': session.apiKey },
      }),
      environment as any,
    );
    expect(cold.authenticated).toBe(false);
  });

  it('revokes the old key when rotating through POST /api/auth/key', async () => {
    const kv = mockKv();
    const environment = kvEnv(kv);
    const oldSession = await issue(environment);

    const res = await handleAuthKey({
      request: new Request('https://sonic.example.com/api/auth/key', {
        method: 'POST',
        headers: { 'X-Sonic-Key': oldSession.apiKey },
      }),
      env: environment as any,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.oldKeyRevoked).toBe(true);
    expect(body.apiKey).not.toBe(oldSession.apiKey);

    expect(
      (
        await verifyAuth(
          new Request('https://sonic.example.com/api/x', {
            headers: { 'X-Sonic-Key': oldSession.apiKey },
          }),
          environment as any,
        )
      ).authenticated,
    ).toBe(false);
    expect(
      (
        await verifyAuth(
          new Request('https://sonic.example.com/api/x', {
            headers: { 'X-Sonic-Key': body.apiKey },
          }),
          environment as any,
        )
      ).authenticated,
    ).toBe(true);
  });

  it('revokes the session jti on logout when the KV store is enabled', async () => {
    const kv = mockKv();
    const environment = kvEnv(kv);
    const session = await issue(environment);

    const res = await handleAuthLogout({
      request: new Request('https://sonic.example.com/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `sonic_session=${session.apiKey}`,
          Origin: 'https://sonic.example.com',
        },
      }),
      env: environment as any,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).serverRevoked).toBe(true);
    resetKeyRevocationCacheForTest();
    expect(
      (
        await verifyAuth(
          new Request('https://sonic.example.com/api/x', {
            headers: { Cookie: `sonic_session=${session.apiKey}` },
          }),
          environment as any,
        )
      ).authenticated,
    ).toBe(false);
  });

  it('returns 501 rather than pretending revocation succeeded without a configured store', async () => {
    const environment = env();
    const session = await issue(environment);
    const res = await handleAuthRevoke({
      request: new Request('https://sonic.example.com/api/auth/revoke', {
        method: 'POST',
        headers: { 'X-Sonic-Key': session.apiKey },
      }),
      env: environment as any,
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('REVOCATION_STORE_NOT_CONFIGURED');
  });

  it('fails closed when an enabled revocation store read fails', async () => {
    const kv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {},
    };
    const environment = kvEnv(kv);
    const session = await issue(environment);
    const res = await verifyAuth(
      new Request('https://sonic.example.com/api/x', {
        headers: { 'X-Sonic-Key': session.apiKey },
      }),
      environment as any,
    );
    expect(res.authenticated).toBe(false);
  });
});

describe('OAuth helper invariants', () => {
  it('PKCE verifier regex accepts 43-128 base64url characters only', () => {
    expect(PKCE_VERIFIER_REGEX.test('B'.repeat(43))).toBe(true);
    expect(PKCE_VERIFIER_REGEX.test('B'.repeat(128))).toBe(true);
    expect(PKCE_VERIFIER_REGEX.test('B'.repeat(42))).toBe(false);
    expect(PKCE_VERIFIER_REGEX.test(`${'B'.repeat(42)}=`)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  base64UrlEncode,
  base64UrlDecode,
  buildAuthorizeUrl,
  createSession,
  getEpomailConfig,
  MAX_SESSION_TTL_SEC,
  stringToBase64Url,
  verifyAuth,
} from '../functions/_lib/auth';
import { sha256Bytes } from '../functions/_lib/sonic/crypto';
import {
  evaluateAuthRateLimit,
  evaluateGatewayRateLimit,
  getForwardedClientIp,
  getPublicClientIp,
  getRateBucketCountForTest,
  getRateBucketMaxForTest,
  getAllowedMusicDomains,
  hostMatchesDomain,
  isBlockedIpv6,
  isBlockedSsrfHost,
  getActiveProxyFetchesForTest,
  requireEngineSecret,
  resetProxyConcurrencyForTest,
  resetRateLimitsForTest,
  safeFetch,
  validateSafeUrl,
} from '../functions/_lib/sonic/security';
import {
  buildStreamedProxyResponse,
  readBodyWithLimit,
  ResponseLimitError,
} from '../functions/_lib/sonic/proxy-safety';
import { onRequest as handleAuthCallback } from '../functions/api/auth/callback';
import { onRequest as handleAuthLogin } from '../functions/api/auth/login';
import { onRequest as handleCover } from '../functions/api/music/cover';
import { onRequest as handleStream } from '../functions/api/music/stream';
import { onRequest as handleForward } from '../functions/api/sonic/forward';

const VALID_SECRET = 'sonic_test_secret_primary_abcdefghijklmnopqrstuvwxyz';
const OTHER_SECRET = 'sonic_test_secret_other_zyxwvutsrqponmlkjihgfedcba';
const ENGINE_SECRET = 'engine_test_secret_abcdefghijklmnopqrstuvwxyz';
const ALLOWED_DOMAINS = ['music.126.net', 'qqmusic.qq.com'];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function makeKey(
  payload: Record<string, unknown>,
  secret = VALID_SECRET,
): Promise<string> {
  const payloadB64 = stringToBase64Url(JSON.stringify(payload));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`v1.${payloadB64}`));
  return `sonic_live_v1.${payloadB64}.${base64UrlEncode(new Uint8Array(sig))}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    sub: 'epomail:user-123',
    email: 'alice@example.com',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

function authRequest(key: string): Request {
  return new Request('https://sonic.example/api/music/search', {
    headers: { 'X-Sonic-Key': key },
  });
}

function cookieHeaders(response: Response): string[] {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
}

describe('API key authentication', () => {
  it('accepts a valid signed key and returns the trusted sub as user.id', async () => {
    const key = await makeKey(validPayload());
    const result = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
    expect(result.authenticated).toBe(true);
    expect(result.user?.id).toBe('epomail:user-123');
    expect(result.user?.email).toBe('alice@example.com');
    expect(result.user?.role).toBe('user');
  });

  it('is stateless: repeated verification returns the same identity', async () => {
    const key = await makeKey(validPayload());
    const first = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
    const second = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
    expect(first.user?.id).toBe('epomail:user-123');
    expect(second.user?.id).toBe(first.user?.id);
  });

  it('rejects a key signed by another secret, random signatures and tampered payloads', async () => {
    const payload = validPayload();
    const validKey = await makeKey(payload);
    const parts = validKey.split('.');
    const randomSig = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    const tamperedPayload = stringToBase64Url(JSON.stringify({ ...payload, email: 'attacker@example.com' }));

    for (const key of [
      await makeKey(payload, OTHER_SECRET),
      `sonic_live_v1.${parts[1]}.${randomSig}`,
      `sonic_live_v1.${tamperedPayload}.${parts[2]}`,
    ]) {
      const result = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
      expect(result.authenticated).toBe(false);
    }
  });

  it('rejects expired, future-issued, inverted and overlong-lifetime payloads', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      { iat: now - 7200, exp: now - 60 },
      { iat: now + 3600, exp: now + 7200 },
      { iat: now, exp: now },
      { iat: now, exp: now + MAX_SESSION_TTL_SEC + 1 },
    ];
    for (const overrides of cases) {
      const key = await makeKey(validPayload(overrides));
      const result = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
      expect(result.authenticated).toBe(false);
    }
  });

  it('rejects missing or wrongly typed payload fields', async () => {
    const base = validPayload();
    const cases: Record<string, unknown>[] = [
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'sub')),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'email')),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'iat')),
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'exp')),
      { ...base, sub: 42 },
      { ...base, email: 42 },
      { ...base, iat: 'now' },
      { ...base, exp: String(base.exp) },
      { ...base, v: 2 },
      { ...base, sub: 'bad sub with spaces' },
      { ...base, email: 'not-an-email' },
    ];
    for (const payload of cases) {
      const key = await makeKey(payload);
      const result = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
      expect(result.authenticated).toBe(false);
    }
  });

  it('rejects malformed encodings, oversized payloads and oversized tokens', async () => {
    const malformed = [
      'sonic_live_v1.%%%.sig',
      'sonic_live_v1.onlyonepart',
      'sonic_live_v1..',
      `sonic_live_v1.${'a'.repeat(3000)}.${'b'.repeat(43)}`,
      'a'.repeat(5000),
    ];
    for (const key of malformed) {
      const result = await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET });
      expect(result.authenticated).toBe(false);
    }

    const padded = await makeKey(validPayload());
    const parts = padded.split('.');
    const paddedSig = `${parts[2].slice(0, 42)}${parts[2].slice(42)}==`;
    expect((await verifyAuth(authRequest(`sonic_live_v1.${parts[1]}.${paddedSig}`), { SONIC_SECRET: VALID_SECRET })).authenticated).toBe(false);
  });

  it('rejects legacy base64-email and unsigned keys', async () => {
    const encodedEmail = btoa('victim@example.com').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    for (const key of [
      `sonic_live_${encodedEmail}_deadbeef`,
      `solara_live_${encodedEmail}_deadbeef`,
    ]) {
      expect((await verifyAuth(authRequest(key), { SONIC_SECRET: VALID_SECRET })).authenticated).toBe(false);
    }
  });

  it('fails closed without a sufficiently long signing secret', async () => {
    const key = await makeKey(validPayload());
    expect((await verifyAuth(authRequest(key), {})).authenticated).toBe(false);
    expect((await verifyAuth(authRequest(key), { SONIC_SECRET: 'short' })).authenticated).toBe(false);
    await expect(createSession({}, {
      sub: 'user-1',
      email: 'alice@example.com',
      name: 'Alice',
      avatar: '',
    })).rejects.toThrow('SONIC_SECRET');
    await expect(createSession({ SOLARA_SECRET: VALID_SECRET }, {
      sub: 'user-1',
      email: 'alice@example.com',
      name: 'Alice',
      avatar: '',
    })).rejects.toThrow('SONIC_SECRET');
  });

  it('supports rotation, then rejects the retired secret', async () => {
    const key = await makeKey(validPayload());
    expect((await verifyAuth(authRequest(key), {
      SONIC_SECRET: OTHER_SECRET,
      SONIC_SECRET_PREV: VALID_SECRET,
    })).authenticated).toBe(true);
    expect((await verifyAuth(authRequest(key), { SONIC_SECRET: OTHER_SECRET })).authenticated).toBe(false);
  });

  it('creates a session whose payload has sub/iat/exp and never trusts role input', async () => {
    const session = await createSession({ SONIC_SECRET: VALID_SECRET }, {
      sub: 'trusted-sub',
      email: 'alice@example.com',
      name: 'Alice',
      avatar: '',
      role: 'admin',
    } as any);
    expect(session.id).toBe('trusted-sub');
    expect(session.role).toBe('user');
    const [, payloadB64] = session.apiKey.split('.');
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
    expect(payload).toMatchObject({
      v: 1,
      sub: 'trusted-sub',
      email: 'alice@example.com',
    });
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(Number.isInteger(payload.exp)).toBe(true);
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.kid).toBeUndefined();

    const verified = await verifyAuth(authRequest(session.apiKey), { SONIC_SECRET: VALID_SECRET });
    expect(verified.user?.id).toBe('trusted-sub');
  });

  it('disables query keys unless explicitly enabled', async () => {
    const session = await createSession({ SONIC_SECRET: VALID_SECRET }, {
      sub: 'query-user',
      email: 'query@example.com',
      name: 'Query',
      avatar: '',
    });
    const request = new Request(`https://sonic.example/api/music/search?api_key=${encodeURIComponent(session.apiKey)}`);
    expect((await verifyAuth(request, { SONIC_SECRET: VALID_SECRET })).authenticated).toBe(false);
    expect((await verifyAuth(request, {
      SONIC_SECRET: VALID_SECRET,
      SONIC_ALLOW_QUERY_KEY: '1',
    })).authenticated).toBe(true);
  });
});

describe('OAuth state, PKCE and redirect policy', () => {
  const oauthEnv = {
    EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
    EPOMAIL_CLIENT_ID: 'client-id',
    EPOMAIL_CLIENT_SECRET: 'client-secret',
    EPOMAIL_REDIRECT_URI: 'https://sonic.example/api/auth/callback',
    SONIC_SECRET: VALID_SECRET,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('login generates random state, S256 challenge and hardened cookies', async () => {
    const response = await handleAuthLogin({
      request: new Request('https://sonic.example/api/auth/login'),
      env: oauthEnv,
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') || '');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')?.length).toBe(43);
    const state = location.searchParams.get('state') || '';
    expect(state.length).toBe(43);

    const cookies = cookieHeaders(response).join('\n');
    expect(cookies).toContain(`sonic_oauth_state=${state}`);
    expect(cookies).toContain('sonic_oauth_verifier=');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('Path=/api/auth');
    expect(cookies).toContain('Max-Age=600');
  });

  it('login rejects an origin outside the allowlist when no fixed redirect is set', async () => {
    const response = await handleAuthLogin({
      request: new Request('https://evil.example/api/auth/login'),
      env: {
        ...oauthEnv,
        EPOMAIL_REDIRECT_URI: '',
        SONIC_ALLOWED_ORIGINS: 'https://sonic.example',
      },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-HTTPS provider base URL', async () => {
    const config = getEpomailConfig({
      ...oauthEnv,
      EPOMAIL_BASE_URL: 'http://mail.example',
    });
    expect(config.baseUrl).toBe('');
    expect(() => buildAuthorizeUrl(
      { ...oauthEnv, EPOMAIL_BASE_URL: 'http://mail.example' },
      'https://sonic.example',
      's'.repeat(43),
      'c'.repeat(43),
    )).toThrow('OAuth configuration');
  });

  it('callback rejects missing, mismatched, error and missing-verifier requests with cookie clearing', async () => {
    const base = 'https://sonic.example/api/auth/callback';
    const clearCheck = (response: Response) => {
      expect(response.status).toBe(400);
      const cookies = cookieHeaders(response).join('\n');
      expect(cookies).toContain('sonic_oauth_state=;');
      expect(cookies).toContain('sonic_oauth_verifier=;');
    };

    clearCheck(await handleAuthCallback({
      request: new Request(`${base}?code=c&state=s`),
      env: oauthEnv,
    }));

    clearCheck(await handleAuthCallback({
      request: new Request(`${base}?code=c&state=attacker`, {
        headers: { Cookie: 'sonic_oauth_state=victim; sonic_oauth_verifier=v' },
      }),
      env: oauthEnv,
    }));

    clearCheck(await handleAuthCallback({
      request: new Request(`${base}?error=access_denied&state=${'s'.repeat(43)}`, {
        headers: { Cookie: `sonic_oauth_state=${'s'.repeat(43)}` },
      }),
      env: oauthEnv,
    }));

    clearCheck(await handleAuthCallback({
      request: new Request(`${base}?code=c&state=${'s'.repeat(43)}`, {
        headers: { Cookie: `sonic_oauth_state=${'s'.repeat(43)}` },
      }),
      env: oauthEnv,
    }));
  });

  it('completes a mocked login, sends the PKCE verifier and clears cookies', async () => {
    const state = 's'.repeat(43);
    const verifier = 'v'.repeat(43);
    let tokenBody = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) {
        tokenBody = String(init?.body || '');
        return jsonResponse({ access_token: 'access-token' });
      }
      if (url.endsWith('/oauth/userinfo')) {
        return jsonResponse({ sub: 'epomail:alice', email: 'Alice@Example.com', name: 'Alice' });
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleAuthCallback({
      request: new Request(`https://sonic.example/api/auth/callback?code=code-1&state=${state}`, {
        headers: {
          Accept: 'application/json',
          Cookie: `sonic_oauth_state=${state}; sonic_oauth_verifier=${verifier}`,
        },
      }),
      env: oauthEnv,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.session.email).toBe('alice@example.com');
    expect(body.session.id).toBe('epomail:alice');
    expect(tokenBody).toContain(`"code_verifier":"${verifier}"`);
    expect((await verifyAuth(authRequest(body.session.apiKey), { SONIC_SECRET: VALID_SECRET })).authenticated).toBe(true);

    const cookies = cookieHeaders(response).join('\n');
    expect(cookies).toContain('sonic_oauth_state=;');
    expect(cookies).toContain('sonic_oauth_verifier=;');
    expect(cookies).toContain('Max-Age=0');
  });
});

describe('SSRF and URL validation', () => {
  it('uses a real SHA-256 implementation for constant-time secret/state comparison', () => {
    const expected = createHash('sha256').update('sonic-secret-parity').digest('hex');
    expect(Buffer.from(sha256Bytes('sonic-secret-parity')).toString('hex')).toBe(expected);
  });

  it('blocks private, loopback, link-local, reserved and metadata addresses', () => {
    const blocked = [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.0.1',
      '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '2130706433', '0x7f.0.0.1', '0x7f.1', '0177.0.0.1',
      'localhost', 'sub.localhost', 'service.internal',
      '::1', '::', '::ffff:127.0.0.1', '::127.0.0.1',
      'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
      '64:ff9b::127.0.0.1', '2001:db8::1', '2002:7f00:1::', '2001::1', '3fff::1',
    ];
    for (const host of blocked) {
      expect(isBlockedSsrfHost(host), host).toBe(true);
    }
    for (const host of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', 'music.126.net']) {
      expect(isBlockedSsrfHost(host), host).toBe(false);
    }
    expect(isBlockedIpv6('not-an-ip')).toBe(true);
  });

  it('matches allowlisted suffixes on label boundaries only', () => {
    expect(hostMatchesDomain('cdn.music.126.net', 'music.126.net')).toBe(true);
    expect(hostMatchesDomain('music.126.net', 'music.126.net')).toBe(true);
    expect(hostMatchesDomain('evil-music.126.net', 'music.126.net')).toBe(false);
    expect(hostMatchesDomain('music.126.net.evil.com', 'music.126.net')).toBe(false);
    expect(validateSafeUrl('https://music.126.net/a.mp3', { allowedDomains: ALLOWED_DOMAINS }).valid).toBe(true);
    expect(validateSafeUrl('https://evil-music.126.net/a.mp3', { allowedDomains: ALLOWED_DOMAINS }).valid).toBe(false);
  });

  it('rejects non-HTTPS, userinfo, non-standard ports and disallowed hosts', () => {
    expect(validateSafeUrl('http://music.126.net/a.mp3').valid).toBe(false);
    expect(validateSafeUrl('https://user:pass@music.126.net/a.mp3').valid).toBe(false);
    expect(validateSafeUrl('https://music.126.net:8443/a.mp3').valid).toBe(false);
    expect(validateSafeUrl('https://music.126.net:443/a.mp3', { allowedDomains: ALLOWED_DOMAINS }).valid).toBe(true);
    expect(validateSafeUrl('https://127.0.0.1/a.mp3').valid).toBe(false);
    expect(validateSafeUrl('https://[::1]/a.mp3').valid).toBe(false);
    expect(getAllowedMusicDomains({})).toContain('music.126.net');
    expect(getAllowedMusicDomains({ SONIC_ALLOWED_MUSIC_DOMAINS: 'cdn.example.com' })).toEqual(['cdn.example.com']);
    expect(getAllowedMusicDomains({ SONIC_ALLOWED_MUSIC_DOMAINS: '***' })).toEqual([]);
    expect(validateSafeUrl('https://evil.example/a.mp3', { allowedDomains: [] }).valid).toBe(false);
  });

  it('safeFetch revalidates every redirect, blocks downgrade and strips credentials', async () => {
    const redirectToInternal = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://127.0.0.1/evil' },
    }));    vi.stubGlobal('fetch', redirectToInternal);
    await expect(safeFetch('https://music.126.net/a', undefined, {
      allowedDomains: ALLOWED_DOMAINS,
    })).rejects.toThrow('SSRF check rejected');
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://music.126.net/a' },
    })));
    await expect(safeFetch('https://music.126.net/a', undefined, {
      allowedDomains: ALLOWED_DOMAINS,
      allowHttp: true,
    })).rejects.toThrow('Protocol downgrade');
    vi.unstubAllGlobals();

    const captured = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeInstanceOf(Headers);
      const headers = init?.headers as Headers;
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-sonic-engine-key')).toBe(false);
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', captured);
    const response = await safeFetch('https://music.126.net/a', {
      headers: {
        Cookie: 'session=secret',
        Authorization: 'Bearer secret',
        'X-Sonic-Engine-Key': 'secret',
      },
    }, { allowedDomains: ALLOWED_DOMAINS });
    expect(await response.text()).toBe('ok');
    expect(captured).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://music.126.net/b' },
    })));
    await expect(safeFetch('https://music.126.net/a', undefined, {
      allowedDomains: ALLOWED_DOMAINS,
      maxRedirects: 0,
    })).rejects.toThrow('Too many redirects');
    vi.unstubAllGlobals();
  });

  it('caps concurrent outbound fetches per isolate', async () => {
    resetProxyConcurrencyForTest();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate;
      return new Response('ok', { status: 200 });
    }));

    try {
      const first = safeFetch('https://music.126.net/a', undefined, {
        allowedDomains: ALLOWED_DOMAINS,
        maxConcurrency: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(safeFetch('https://music.126.net/b', undefined, {
        allowedDomains: ALLOWED_DOMAINS,
        maxConcurrency: 1,
      })).rejects.toThrow('concurrency');
      release();
      await expect(first).resolves.toBeInstanceOf(Response);
      expect(getActiveProxyFetchesForTest()).toBe(0);
    } finally {
      resetProxyConcurrencyForTest();
      vi.unstubAllGlobals();
    }
  });
});

describe('Proxy response policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters headers, enforces MIME and preserves Range/HEAD semantics', async () => {
    const upstreamHeaders = {
      'content-type': 'audio/mpeg',
      'content-range': 'bytes 0-3/100',
      'accept-ranges': 'bytes',
      'content-length': '4',
      'set-cookie': 'evil=1; Path=/',
      'x-upstream-secret': 'leak',
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: upstreamHeaders,
    })));

    const response = await handleStream({
      request: new Request('https://sonic.example/api/music/stream?target=https%3A%2F%2Fmusic.126.net%2Fa.mp3', {
        headers: { Range: 'bytes=0-3' },
      }),
      env: {},
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/100');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-upstream-secret')).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(4);

    const headResponse = await handleStream({
      request: new Request('https://sonic.example/api/music/stream?target=https%3A%2F%2Fmusic.126.net%2Fa.mp3', {
        method: 'HEAD',
      }),
      env: {},
    });
    expect(headResponse.status).toBe(206);
    expect(headResponse.body).toBeNull();
  });

  it('rejects active content from stream and cover upstreams', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<script>alert(1)</script>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));
    const streamResponse = await handleStream({
      request: new Request('https://sonic.example/api/music/stream?target=https%3A%2F%2Fmusic.126.net%2Fa.mp3'),
      env: {},
    });
    expect(streamResponse.status).toBe(415);
    expect(await streamResponse.text()).not.toContain('<script>');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg onload="alert(1)"></svg>', {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    })));
    const coverResponse = await handleCover({
      request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fmusic.126.net%2Fa.svg'),
      env: {},
    });
    expect(coverResponse.status).toBe(200);
    expect(coverResponse.headers.get('x-sonic-cover-fallback')).toBe('svg');
    expect(await coverResponse.text()).not.toContain('onload=');
  });

  it('serves only raster images, with real byte length and HEAD without a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg; charset=binary',
        'content-length': '9999',
        'set-cookie': 'evil=1',
      },
    })));
    const response = await handleCover({
      request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fmusic.126.net%2Fa.jpg'),
      env: {},
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('3');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await response.arrayBuffer()).byteLength).toBe(3);

    const headResponse = await handleCover({
      request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fmusic.126.net%2Fa.jpg', {
        method: 'HEAD',
      }),
      env: {},
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.body).toBeNull();
  });

  it('disables arbitrary asset forwarding by default and whitelists it when enabled', async () => {
    const disabled = await handleForward({
      request: new Request('https://sonic.example/api/sonic/forward?url=https%3A%2F%2Fmusic.126.net%2Fa.mp3'),
      env: {},
    });
    expect(disabled.status).toBe(403);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': '3',
        'set-cookie': 'evil=1',
      },
    })));
    const enabled = await handleForward({
      request: new Request('https://sonic.example/api/sonic/forward?type=audio&url=https%3A%2F%2Fmusic.126.net%2Fa.mp3'),
      env: { SONIC_ENABLE_ASSET_FORWARD: '1' },
      waitUntil: () => {},
    });
    expect(enabled.status).toBe(200);
    expect(enabled.headers.get('set-cookie')).toBeNull();
    expect(enabled.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await enabled.arrayBuffer()).byteLength).toBe(3);
  });

  it('enforces actual byte limits for buffered and streamed responses', async () => {
    const buffered = new Response(new Uint8Array(32), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    await expect(readBodyWithLimit(buffered, 16)).rejects.toBeInstanceOf(ResponseLimitError);

    const declaredTooLarge = new Response(new Uint8Array(4), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '9999' },
    });
    await expect(readBodyWithLimit(declaredTooLarge, 16)).rejects.toBeInstanceOf(ResponseLimitError);

    const upstream = new Response(new Uint8Array(32), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
    const proxied = buildStreamedProxyResponse(upstream, {
      kind: 'audio',
      maxBytes: 16,
      isHead: false,
      cacheControl: 'public, max-age=1',
    });
    await expect(readBodyWithLimit(proxied, 1024)).rejects.toBeInstanceOf(ResponseLimitError);
  });
});

describe('Client IP trust and rate limiting', () => {
  beforeEach(() => resetRateLimitsForTest());

  it('ignores spoofed X-Sonic-Client-IP for public callers', async () => {
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '2' };
    const request = (forwarded: string) => new Request('https://sonic.example/api/test', {
      headers: { 'CF-Connecting-IP': '198.51.100.10', 'X-Sonic-Client-IP': forwarded },
    });
    expect(getPublicClientIp(request('1.2.3.4'))).toBe('198.51.100.10');
    expect((await evaluateGatewayRateLimit(request('1.2.3.4'), env, 'ip-test')).allowed).toBe(true);
    expect((await evaluateGatewayRateLimit(request('5.6.7.8'), env, 'ip-test')).allowed).toBe(true);
    expect((await evaluateGatewayRateLimit(request('9.10.11.12'), env, 'ip-test')).allowed).toBe(false);
  });

  it('trusts forwarded client IPs only with a valid engine secret', () => {
    const env = { SONIC_ENGINE_SECRET: ENGINE_SECRET };
    const untrusted = new Request('https://sonic.example/api/test', {
      headers: { 'X-Sonic-Engine-Key': 'wrong', 'X-Sonic-Client-IP': '198.51.100.77' },
    });
    expect(getForwardedClientIp(untrusted, env)).toBe('unknown');
    const trusted = new Request('https://sonic.example/api/test', {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET, 'X-Sonic-Client-IP': '198.51.100.77' },
    });
    expect(getForwardedClientIp(trusted, env)).toBe('198.51.100.77');
    const invalid = new Request('https://sonic.example/api/test', {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET, 'X-Sonic-Client-IP': 'not-an-ip; evil' },
    });
    expect(getForwardedClientIp(invalid, env)).toBe('unknown');
  });

  it('keys authenticated limits on stable user.id, not client IP', async () => {
    const session = await createSession({ SONIC_SECRET: VALID_SECRET }, {
      sub: 'rate-user',
      email: 'rate@example.com',
      name: 'Rate',
      avatar: '',
    });
    const env = { SONIC_SECRET: VALID_SECRET, SONIC_RATE_LIMIT_AUTH_RPM: '1' };
    const request = (ip: string) => new Request('https://sonic.example/api/test', {
      headers: { 'CF-Connecting-IP': ip, 'X-Sonic-Key': session.apiKey },
    });
    expect((await evaluateGatewayRateLimit(request('198.51.100.1'), env, 'user-rate')).allowed).toBe(true);
    expect((await evaluateGatewayRateLimit(request('198.51.100.2'), env, 'user-rate')).allowed).toBe(false);
  });

  it('never exceeds the hard bucket capacity', async () => {
    const max = getRateBucketMaxForTest();
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '1000' };
    for (let i = 0; i < max + 128; i++) {
      const octet4 = (i % 254) + 1;
      const octet3 = Math.floor(i / 254) % 254;
      const ip = `198.18.${octet3}.${octet4}`;
      await evaluateGatewayRateLimit(
        new Request('https://sonic.example/api/test', { headers: { 'CF-Connecting-IP': ip } }),
        env,
        'capacity',
      );
    }
    expect(getRateBucketCountForTest()).toBeLessThanOrEqual(max);
  });

  it('reports KV as best-effort scope instead of a strict global quota', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
    };
    const decision = await evaluateGatewayRateLimit(
      new Request('https://sonic.example/api/test', { headers: { 'CF-Connecting-IP': '198.51.100.20' } }),
      { SONIC_RATE_LIMIT_ANON_RPM: '10', RATE_LIMIT_KV: kv },
      'kv-test',
    );
    expect(decision.scope).toBe('kv');
    expect(decision.allowed).toBe(true);
  });
});

describe('Engine credential enforcement', () => {
  it('fails closed on missing/short secrets and rejects invalid keys', () => {
    const request = new Request('https://sonic.example/api/test', {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET },
    });
    expect(requireEngineSecret(request, {})?.status).toBe(503);
    expect(requireEngineSecret(request, { SONIC_ENGINE_SECRET: 'short' })?.status).toBe(503);
    expect(requireEngineSecret(new Request('https://sonic.example/api/test', {
      headers: { 'X-Sonic-Engine-Key': 'wrong' },
    }), { SONIC_ENGINE_SECRET: ENGINE_SECRET })?.status).toBe(401);
    expect(requireEngineSecret(request, { SONIC_ENGINE_SECRET: ENGINE_SECRET })).toBeNull();
  });
});

describe('OAuth endpoint throttling', () => {
  const oauthEnv = {
    EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
    EPOMAIL_CLIENT_ID: 'client-id',
    EPOMAIL_CLIENT_SECRET: 'client-secret',
    EPOMAIL_REDIRECT_URI: 'https://sonic.example/api/auth/callback',
    SONIC_SECRET: VALID_SECRET,
  };

  beforeEach(() => resetRateLimitsForTest());

  it('rejects the 31st callback from one client IP while login stays reachable', async () => {
    const callback = (ip: string) => new Request(
      'https://sonic.example/api/auth/callback?code=c&state=s',
      { headers: { 'CF-Connecting-IP': ip } },
    );

    let lastStatus = 0;
    for (let i = 0; i < 30; i += 1) {
      lastStatus = (await handleAuthCallback({
        request: callback('198.51.100.240'),
        env: oauthEnv,
      })).status;
    }
    expect(lastStatus).toBe(400);

    const blocked = await handleAuthCallback({
      request: callback('198.51.100.240'),
      env: oauthEnv,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    const otherIp = await handleAuthCallback({
      request: callback('198.51.100.241'),
      env: oauthEnv,
    });
    expect(otherIp.status).toBe(400);

    const login = await handleAuthLogin({
      request: new Request('https://sonic.example/api/auth/login', {
        headers: { 'CF-Connecting-IP': '198.51.100.240' },
      }),
      env: oauthEnv,
    });
    expect(login.status).toBe(302);
  });

  it('ignores SONIC_REQUIRE_AUTH and cannot be widened by credentials', async () => {
    const env = { SONIC_REQUIRE_AUTH: '1', SONIC_SECRET: VALID_SECRET };
    const request = () => new Request('https://sonic.example/api/auth/login', {
      headers: { 'CF-Connecting-IP': '198.51.100.242' },
    });

    const decisions = [];
    for (let i = 0; i < 3; i += 1) {
      decisions.push(await evaluateAuthRateLimit(request(), env, 'auth-unit', 2));
    }

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, false]);
    expect(decisions[2].tier).toBe('anonymous');
  });

  it('does not reset the bucket when X-Sonic-Client-IP is spoofed', async () => {
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '1000' };
    const request = (spoof: string) => new Request('https://sonic.example/api/auth/login', {
      headers: { 'CF-Connecting-IP': '198.51.100.243', 'X-Sonic-Client-IP': spoof },
    });

    const first = await evaluateAuthRateLimit(request('1.1.1.1'), env, 'auth-spoof', 1);
    const second = await evaluateAuthRateLimit(request('2.2.2.2'), env, 'auth-spoof', 1);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });
});

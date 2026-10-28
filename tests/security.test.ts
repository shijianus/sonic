import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  verifyAuth,
  base64UrlEncode,
  base64UrlDecode,
  deriveKeyId,
  stringToBase64Url,
} from '../functions/_lib/auth';
import {
  getPublicClientIp,
  getForwardedClientIp,
  evaluateGatewayRateLimit,
  resetRateLimitsForTest,
  isBlockedSsrfHost,
  validateSafeUrl,
  safeFetch,
} from '../functions/_lib/sonic/security';
import { onRequest as handleAuthCallback } from '../functions/api/auth/callback';

const VALID_SECRET_1 = 'super_secret_sonic_key_2026_primary_abcdef123456'; // >= 32 chars
const VALID_SECRET_2 = 'super_secret_sonic_key_2026_rotated_xyz789012345'; // >= 32 chars
const SHORT_SECRET = 'short_secret_123'; // < 32 chars

function decodeJsonPart(part: string): any {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function buildToken(
  secret: string,
  header: Record<string, any>,
  payload: Record<string, any>,
): Promise<string> {
  const headerB64 = stringToBase64Url(JSON.stringify(header));
  const payloadB64 = stringToBase64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`sonic_live_v2.${headerB64}.${payloadB64}`),
  );
  return `sonic_live_v2.${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function requestWithKey(apiKey: string): Request {
  return new Request('https://sonic.epocanvas.tech/api/music/search', {
    headers: { 'X-Sonic-Key': apiKey },
  });
}

describe('Task 1 & Task 2: API Key Signature, Rotation & Revocation', () => {
  beforeEach(() => {
    resetRateLimitsForTest();
  });

  it('rejects forged sonic_live_<base64(email)>_xxx keys and legacy solara_live_* keys', async () => {
    const b64Email = btoa('victim@epocanvas.com').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const forged = `sonic_live_${b64Email}_arbitrary_sig_123456`;
    const legacy = 'solara_live_ZGV2ZWxvcGVyQGVwb2NhbnZhcy5jb20_d41d8cd98f00b204e9800998ecf8427e';

    const forgedRes = await verifyAuth(requestWithKey(forged), { SONIC_SECRET: VALID_SECRET_1 });
    expect(forgedRes.authenticated).toBe(false);

    const legacyRes = await verifyAuth(
      new Request('https://sonic.epocanvas.tech/api/music/search', {
        headers: { 'X-CFSolara-Key': legacy },
      }),
      { SONIC_SECRET: VALID_SECRET_1 },
    );
    expect(legacyRes.authenticated).toBe(false);
  });

  it('issues v2 tokens with sub/iat/exp/jti/kid claims and verifies them', async () => {
    const env = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(env, {
      email: 'alice@epocanvas.com',
      name: 'Alice',
      avatar: '',
      role: 'developer',
      id: 'usr_alice_001',
    });

    const parts = session.apiKey.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('sonic_live_v2');

    const header = decodeJsonPart(parts[1]);
    const payload = decodeJsonPart(parts[2]);
    expect(header).toMatchObject({ alg: 'HS256', typ: 'sonic-api-key', v: 2 });
    expect(header.kid).toBe(deriveKeyId(VALID_SECRET_1));
    expect(payload.sub).toBe('alice@epocanvas.com');
    expect(payload.kid).toBe(header.kid);
    expect(payload.iat).toBeTypeOf('number');
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.jti).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(payload.role).toBe('developer');

    const res = await verifyAuth(requestWithKey(session.apiKey), env);
    expect(res.authenticated).toBe(true);
    expect(res.user?.email).toBe('alice@epocanvas.com');
    expect(res.user?.id).toBe('usr_alice_001');
    expect(res.user?.role).toBe('developer');
  });

  it('rejects tampered payload claims even when the original signature is kept', async () => {
    const env = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(env, {
      email: 'original@epocanvas.com',
      name: 'Original',
      avatar: '',
    });
    const parts = session.apiKey.split('.');
    const payload = decodeJsonPart(parts[2]);
    payload.sub = 'attacker@epocanvas.com';
    const tampered = `${parts[0]}.${parts[1]}.${stringToBase64Url(JSON.stringify(payload))}.${parts[3]}`;

    const res = await verifyAuth(requestWithKey(tampered), env);
    expect(res.authenticated).toBe(false);
  });

  it('rejects a modified signature', async () => {
    const env = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(env, {
      email: 'sig@epocanvas.com',
      name: 'Sig',
      avatar: '',
    });
    const parts = session.apiKey.split('.');
    const signature = parts[3];
    const altered = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    const res = await verifyAuth(requestWithKey(parts.slice(0, 3).concat(altered).join('.')), env);
    expect(res.authenticated).toBe(false);
  });

  it('rejects expired tokens signed with a valid secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const kid = deriveKeyId(VALID_SECRET_1);
    const token = await buildToken(
      VALID_SECRET_1,
      { alg: 'HS256', typ: 'sonic-api-key', v: 2, kid },
      {
        sub: 'expired@epocanvas.com',
        iat: now - 3600,
        exp: now - 60,
        jti: 'expired-jti-0123456789',
        kid,
        role: 'user',
        uid: 'usr_expired',
      },
    );

    const res = await verifyAuth(requestWithKey(token), { SONIC_SECRET: VALID_SECRET_1 });
    expect(res.authenticated).toBe(false);
  });

  it('rejects v1 tokens even when their HMAC signature is valid', async () => {
    const payload = stringToBase64Url(
      JSON.stringify({
        v: 1,
        email: 'legacy@epocanvas.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        kid: 'current',
      }),
    );
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(VALID_SECRET_1),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${payload}`));
    const v1Token = `sonic_live_v1.${payload}.${base64UrlEncode(new Uint8Array(sig))}`;

    const res = await verifyAuth(requestWithKey(v1Token), { SONIC_SECRET: VALID_SECRET_1 });
    expect(res.authenticated).toBe(false);
  });

  it('supports kid-based rotation with SONIC_SECRET_PREV and rejects retired keys', async () => {
    const envPrimary = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(envPrimary, {
      email: 'rotate@epocanvas.com',
      name: 'Rotate',
      avatar: '',
    });

    const envRotated = {
      SONIC_SECRET: VALID_SECRET_2,
      SONIC_SECRET_PREV: VALID_SECRET_1,
    };
    const rotated = await verifyAuth(requestWithKey(session.apiKey), envRotated);
    expect(rotated.authenticated).toBe(true);
    expect(rotated.user?.email).toBe('rotate@epocanvas.com');

    const retired = await verifyAuth(requestWithKey(session.apiKey), {
      SONIC_SECRET: VALID_SECRET_2,
    });
    expect(retired.authenticated).toBe(false);
  });

  it('supports explicit kid labels during rotation', async () => {
    const oldEnv = { SONIC_SECRET: VALID_SECRET_1, SONIC_SECRET_KID: 'prod-2026-01' };
    const session = await createSession(oldEnv, {
      email: 'kid@epocanvas.com',
      name: 'Kid',
      avatar: '',
    });

    const newEnv = {
      SONIC_SECRET: VALID_SECRET_2,
      SONIC_SECRET_KID: 'prod-2026-02',
      SONIC_SECRET_PREV: VALID_SECRET_1,
      SONIC_SECRET_PREV_KID: 'prod-2026-01',
    };
    const res = await verifyAuth(requestWithKey(session.apiKey), newEnv);
    expect(res.authenticated).toBe(true);
  });

  it('rejects a token whose kid is not configured', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await buildToken(
      VALID_SECRET_1,
      { alg: 'HS256', typ: 'sonic-api-key', v: 2, kid: 'unknown-kid' },
      {
        sub: 'unknown@epocanvas.com',
        iat: now,
        exp: now + 3600,
        jti: 'unknown-kid-jti-0123456789',
        kid: 'unknown-kid',
        role: 'user',
      },
    );
    const res = await verifyAuth(requestWithKey(token), { SONIC_SECRET: VALID_SECRET_1 });
    expect(res.authenticated).toBe(false);
  });

  it('revokes tokens by jti, subject and minimum iat without a memory-cache bypass', async () => {
    const env = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(env, {
      email: 'revoke@epocanvas.com',
      name: 'Revoke',
      avatar: '',
    });
    const payload = decodeJsonPart(session.apiKey.split('.')[2]);

    const first = await verifyAuth(requestWithKey(session.apiKey), env);
    expect(first.authenticated).toBe(true);

    const revokedJti = await verifyAuth(requestWithKey(session.apiKey), {
      ...env,
      SONIC_REVOKED_JTIS: payload.jti,
    });
    expect(revokedJti.authenticated).toBe(false);

    const revokedSub = await verifyAuth(requestWithKey(session.apiKey), {
      ...env,
      SONIC_REVOKED_SUBS: 'REVOKE@epocanvas.com',
    });
    expect(revokedSub.authenticated).toBe(false);

    const minIat = await verifyAuth(requestWithKey(session.apiKey), {
      ...env,
      SONIC_TOKEN_MIN_IAT: String(payload.iat + 10),
    });
    expect(minIat.authenticated).toBe(false);
  });

  it('fails closed when the signing secret is missing or short', async () => {
    const req = requestWithKey('sonic_live_v2.payload.sig.more');
    expect((await verifyAuth(req, {})).authenticated).toBe(false);
    expect((await verifyAuth(req, { SONIC_SECRET: SHORT_SECRET })).authenticated).toBe(false);

    await expect(
      createSession({}, { email: 'test@epocanvas.com', name: 'Test', avatar: '' }),
    ).rejects.toThrow('SONIC_SECRET is not configured or shorter than 32 characters');

    await expect(
      createSession({ SONIC_SECRET: SHORT_SECRET }, { email: 'test@epocanvas.com', name: 'Test', avatar: '' }),
    ).rejects.toThrow('SONIC_SECRET is not configured or shorter than 32 characters');
  });

  it('never accepts API keys from the URL query string, even with the old opt-in flag', async () => {
    const env = { SONIC_SECRET: VALID_SECRET_1 };
    const session = await createSession(env, {
      email: 'query_user@epocanvas.com',
      name: 'Query User',
      avatar: '',
    });
    const url = `https://sonic.epocanvas.tech/api/music/search?api_key=${encodeURIComponent(session.apiKey)}`;

    expect((await verifyAuth(new Request(url), env)).authenticated).toBe(false);
    expect(
      (await verifyAuth(new Request(url), { ...env, SONIC_ALLOW_QUERY_KEY: '1' })).authenticated,
    ).toBe(false);
  });
});

describe('Task 3: OAuth State CSRF & Security', () => {
  it('returns 400 when OAuth callback state is missing or mismatched', async () => {
    const env = {
      EPOMAIL_CLIENT_ID: 'client_123',
      EPOMAIL_CLIENT_SECRET: 'secret_123',
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.tech/api/auth/callback',
      SONIC_SECRET: VALID_SECRET_1,
    };

    // 1. Missing state in query param
    const reqNoState = new Request('https://sonic.epocanvas.tech/api/auth/callback?code=mock_code', {
      headers: { Cookie: 'sonic_oauth_state=valid_random_state_123' },
    });
    const resNoState = await handleAuthCallback({ request: reqNoState, env });
    expect(resNoState.status).toBe(400);

    // 2. Missing cookie state
    const reqNoCookie = new Request('https://sonic.epocanvas.tech/api/auth/callback?code=mock_code&state=valid_random_state_123');
    const resNoCookie = await handleAuthCallback({ request: reqNoCookie, env });
    expect(resNoCookie.status).toBe(400);

    // 3. Mismatched state (attacker forged request)
    const reqMismatch = new Request('https://sonic.epocanvas.tech/api/auth/callback?code=mock_code&state=attacker_state', {
      headers: { Cookie: 'sonic_oauth_state=victim_legit_state' },
    });
    const resMismatch = await handleAuthCallback({ request: reqMismatch, env });
    expect(resMismatch.status).toBe(400);
    const json = await resMismatch.json();
    expect(json.error).toContain('CSRF');
  });
});

describe('Task 4: Rate Limiting & Client IP Spoofing Prevention', () => {
  beforeEach(() => {
    resetRateLimitsForTest();
  });

  it('ignores X-Sonic-Client-IP for anonymous requests and keys on CF-Connecting-IP', async () => {
    const env = {
      SONIC_RATE_LIMIT_ANON_RPM: '2',
      SONIC_SECRET: VALID_SECRET_1,
    };

    const makeReq = () =>
      new Request('https://sonic.epocanvas.tech/api/test', {
        headers: {
          'CF-Connecting-IP': '198.51.100.10',
          'X-Sonic-Client-IP': '1.2.3.4', // Spoofed
        },
      });

    expect(getPublicClientIp(makeReq())).toBe('198.51.100.10');

    const d1 = await evaluateGatewayRateLimit(makeReq(), env, 'test-ip-spoof');
    expect(d1.allowed).toBe(true);

    const req2 = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        'X-Sonic-Client-IP': '5.6.7.8',
      },
    });
    const d2 = await evaluateGatewayRateLimit(req2, env, 'test-ip-spoof');
    expect(d2.allowed).toBe(true);

    const req3 = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        'X-Sonic-Client-IP': '9.10.11.12',
      },
    });
    const d3 = await evaluateGatewayRateLimit(req3, env, 'test-ip-spoof');
    expect(d3.allowed).toBe(false);
  });

  it('only trusts X-Sonic-Client-IP when request has a valid Engine Key', async () => {
    const engineSecret = 'engine_secret_must_be_32_characters_long_minimum!';
    const env = { SONIC_ENGINE_SECRET: engineSecret };

    const reqUntrusted = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: {
        'X-Sonic-Engine-Key': 'wrong_key',
        'X-Sonic-Client-IP': '198.51.100.77',
      },
    });
    expect(getForwardedClientIp(reqUntrusted, env)).toBe('unknown');

    const reqTrusted = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: {
        'X-Sonic-Engine-Key': engineSecret,
        'X-Sonic-Client-IP': '198.51.100.77',
      },
    });
    expect(getForwardedClientIp(reqTrusted, env)).toBe('198.51.100.77');

    const reqBadIp = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: {
        'X-Sonic-Engine-Key': engineSecret,
        'X-Sonic-Client-IP': 'not-an-ip; evil',
      },
    });
    expect(getForwardedClientIp(reqBadIp, env)).toBe('unknown');
  });
});

describe('Task 5: SSRF Triple Validation & Canonicalization', () => {
  it('blocks all private, loopback, and metadata IP representations', () => {
    expect(isBlockedSsrfHost('127.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('2130706433')).toBe(true); // Decimal 127.0.0.1
    expect(isBlockedSsrfHost('0x7f.0.0.1')).toBe(true);  // Hex dotted
    expect(isBlockedSsrfHost('0x7f.1')).toBe(true);      // Hex compact
    expect(isBlockedSsrfHost('[::ffff:127.0.0.1]')).toBe(true); // IPv4-mapped IPv6
    expect(isBlockedSsrfHost('::ffff:127.0.0.1')).toBe(true);

    expect(isBlockedSsrfHost('169.254.169.254')).toBe(true);

    expect(isBlockedSsrfHost('localhost')).toBe(true);
    expect(isBlockedSsrfHost('localhost.')).toBe(true);
    expect(isBlockedSsrfHost('sub.localhost')).toBe(true);

    expect(isBlockedSsrfHost('10.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('172.16.0.1')).toBe(true);
    expect(isBlockedSsrfHost('172.31.255.255')).toBe(true);
    expect(isBlockedSsrfHost('192.168.1.1')).toBe(true);
    expect(isBlockedSsrfHost('203.0.113.10')).toBe(true); // TEST-NET-3

    expect(isBlockedSsrfHost('m701.music.126.net')).toBe(false);
    expect(isBlockedSsrfHost('y.qq.com')).toBe(false);
  });

  it('blocks internal and unsafe IPv6 ranges', () => {
    for (const ip of [
      '::',
      '::1',
      'fd00::1',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '100::1',
      '2001::1',
      '2002:c0a8:0101::1',
      '64:ff9b::10.0.0.1',
      '::ffff:192.168.1.1',
      '::7f00:1',
    ]) {
      expect(isBlockedSsrfHost(ip), ip).toBe(true);
    }
    expect(isBlockedSsrfHost('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedSsrfHost('::ffff:8.8.8.8')).toBe(false);
  });

  it('rejects URLs with userinfo', () => {
    const res = validateSafeUrl('https://user:pass@m701.music.126.net/audio.mp3');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('userinfo');
  });

  it('enforces domain whitelist suffix and blocks whitelist bypass attempts', () => {
    const allowed = ['music.com'];
    expect(validateSafeUrl('https://cdn.music.com/song.mp3', { allowedDomains: allowed }).valid).toBe(true);
    const bypass = validateSafeUrl('https://evil-music.com/song.mp3', { allowedDomains: allowed });
    expect(bypass.valid).toBe(false);
    expect(bypass.error).toContain('allowed domain whitelist');
  });

  it('rejects redirects to internal networks in safeFetch', async () => {
    await expect(
      safeFetch('http://127.0.0.1/evil', undefined, { allowHttp: false }),
    ).rejects.toThrow('SSRF check rejected');
  });
});

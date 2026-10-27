// scripts/test-auth-compatibility.mjs
// Compatibility checks for the signed sonic_live_v1 API key format.

import {
  createSession,
  extractAuthCredentials,
  verifyAuth,
  buildAuthorizeUrl,
  getEpomailConfig,
  stringToBase64Url,
  base64UrlEncode,
} from '../functions/_lib/auth.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function decodePayload(apiKey) {
  const [, payload] = apiKey.split('.');
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

async function signPayload(payload, secret) {
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

async function runAuthTests() {
  console.log('=== Running Sonic Auth Compatibility Test Suite ===\n');

  const PRIMARY_SECRET = 'sonic_secure_test_secret_32chars_long_12345';
  const ROTATED_SECRET = 'sonic_prev_test_secret_32chars_long_abcde';

  console.log('1. OAuth config and authorize URL');
  {
    const env = {
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_CLIENT_ID: 'sonic_client_app',
      EPOMAIL_CLIENT_SECRET: 'sonic_secret_xyz',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.com/api/auth/callback',
    };
    const config = getEpomailConfig(env);
    assert(config.baseUrl === 'https://mail.epocanvas.com', 'Base URL parsed');
    assert(config.redirectUri === 'https://sonic.epocanvas.com/api/auth/callback', 'Fixed redirect URI preserved');

    const state = 's'.repeat(43);
    const challenge = 'c'.repeat(43);
    const authUrl = new URL(buildAuthorizeUrl(env, 'https://sonic.epocanvas.com', state, challenge));
    assert(authUrl.pathname === '/oauth/authorize', 'Authorize pathname is correct');
    assert(authUrl.searchParams.get('state') === state, 'State preserved');
    assert(authUrl.searchParams.get('code_challenge') === challenge, 'PKCE challenge present');
    assert(authUrl.searchParams.get('code_challenge_method') === 'S256', 'PKCE method is S256');
  }

  console.log('\n2. Signed key creation and payload contract');
  const env = { SONIC_SECRET: PRIMARY_SECRET };
  const userInfo = {
    sub: 'epomail:developer-001',
    email: 'developer@epocanvas.com',
    name: 'Epo Developer',
    avatar: 'https://mail.epocanvas.com/avatar/dev.png',
  };
  const session = await createSession(env, userInfo);
  const payload = decodePayload(session.apiKey);
  assert(session.id === userInfo.sub, 'Session id equals trusted sub');
  assert(session.apiKey.startsWith('sonic_live_v1.'), 'Key has v1 prefix');
  assert(payload.v === 1 && payload.sub === userInfo.sub, 'Payload has version and sub');
  assert(payload.email === userInfo.email, 'Payload has email');
  assert(Number.isInteger(payload.iat) && Number.isInteger(payload.exp), 'Payload has integer iat/exp');
  assert(payload.exp > payload.iat, 'exp is after iat');

  console.log('\n3. Credential extraction');
  {
    const req1 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': session.apiKey },
    });
    assert(extractAuthCredentials(req1, env).apiKey === session.apiKey, 'Extracted from X-Sonic-Key');
    const req2 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { Authorization: `Bearer ${session.apiKey}` },
    });
    assert(extractAuthCredentials(req2, env).apiKey === session.apiKey, 'Extracted from Bearer token');
    const req3 = new Request(`https://sonic.epocanvas.com/api/test?api_key=${session.apiKey}`);
    assert(extractAuthCredentials(req3, env).apiKey === undefined, 'Query key disabled by default');
    assert(
      extractAuthCredentials(req3, { ...env, SONIC_ALLOW_QUERY_KEY: '1' }).apiKey === session.apiKey,
      'Query key accepted only when explicitly enabled',
    );
  }

  console.log('\n4. Signature verification and tamper rejection');
  {
    const req = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': session.apiKey },
    });
    const ok1 = await verifyAuth(req, env);
    const ok2 = await verifyAuth(req, env);
    assert(ok1.authenticated && ok2.authenticated, 'Valid key verifies repeatedly (stateless)');
    assert(ok1.user?.id === userInfo.sub && ok2.user?.id === userInfo.sub, 'Cold/hot user.id is stable');

    const tamperedEmail = await signPayload(
      { ...payload, email: 'attacker@epocanvas.com' },
      'a_different_secret_that_is_32_chars_long!!',
    );
    const tamperedReq = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': tamperedEmail },
    });
    assert((await verifyAuth(tamperedReq, env)).authenticated === false, 'Payload signed by a different key is rejected');

    const expired = await signPayload(
      { ...payload, iat: payload.iat - 100, exp: Math.floor(Date.now() / 1000) - 60 },
      PRIMARY_SECRET,
    );
    const expiredReq = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': expired },
    });
    assert((await verifyAuth(expiredReq, env)).authenticated === false, 'Expired key is rejected');

    const legacy = `sonic_live_${btoa(userInfo.email).replace(/=/g, '')}_deadbeef`;
    const legacyReq = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': legacy },
    });
    assert((await verifyAuth(legacyReq, env)).authenticated === false, 'Legacy base64-email key is rejected');
  }

  console.log('\n5. Secret rotation and fail-closed behavior');
  {
    const req = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': session.apiKey },
    });
    assert(
      (await verifyAuth(req, { SONIC_SECRET: ROTATED_SECRET, SONIC_SECRET_PREV: PRIMARY_SECRET })).authenticated,
      'Previous secret verifies during rotation',
    );
    assert(
      (await verifyAuth(req, { SONIC_SECRET: ROTATED_SECRET })).authenticated === false,
      'Retired secret no longer verifies',
    );
    assert((await verifyAuth(req, {})).authenticated === false, 'Missing secret fails closed');
    assert(
      (await verifyAuth(req, { SONIC_SECRET: 'short_key_123' })).authenticated === false,
      'Short secret fails closed',
    );

    let solaraRejected = false;
    try {
      await createSession({ SOLARA_SECRET: PRIMARY_SECRET }, userInfo);
    } catch {
      solaraRejected = true;
    }
    assert(solaraRejected, 'Legacy SOLARA_SECRET fallback is removed');
  }

  console.log(`\n========================================`);
  console.log(`Auth Compatibility Test Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAuthTests().catch((err) => {
  console.error('Fatal auth test error:', err);
  process.exit(1);
});

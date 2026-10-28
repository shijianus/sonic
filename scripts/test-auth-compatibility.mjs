// scripts/test-auth-compatibility.mjs
// Security regression suite for the v2 signed API key format (functions/_lib/auth.ts).
// Unsafe legacy behaviors (unsigned keys, v1 keys, query-string keys, cache-only sessions)
// are expected to fail here.

import {
  createSession,
  extractAuthCredentials,
  verifyAuth,
  buildAuthorizeUrl,
  getEpomailConfig,
  stringToBase64Url,
  base64UrlEncode,
  base64UrlDecode,
  deriveKeyId,
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

function decodeJsonPart(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function buildToken(secret, header, payload) {
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

async function runAuthTests() {
  console.log('=== Running Sonic v2 Auth Security Test Suite ===\n');

  const PRIMARY_SECRET = 'sonic_secure_test_secret_32chars_long_12345';
  const SECONDARY_SECRET = 'solara_secure_test_secret_32chars_long_67890';
  const ROTATED_SECRET = 'sonic_prev_test_secret_32chars_long_abcde';

  console.log('1. Testing OAuth Config & Authorize URL Generation');
  {
    const env = {
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_CLIENT_ID: 'sonic_client_app',
      EPOMAIL_CLIENT_SECRET: 'sonic_secret_xyz',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.com/api/auth/callback',
    };
    const config = getEpomailConfig(env);
    assert(config.baseUrl === 'https://mail.epocanvas.com', 'Base URL parsed');
    assert(config.clientId === 'sonic_client_app', 'Client ID matched');
    assert(config.redirectUri === 'https://sonic.epocanvas.com/api/auth/callback', 'Redirect URI matched');

    const authUrl = buildAuthorizeUrl(env, 'https://sonic.epocanvas.com', 'custom_state_123', 'mock_challenge');
    const parsedUrl = new URL(authUrl);
    assert(parsedUrl.pathname === '/oauth/authorize', 'Authorize pathname is correct');
    assert(parsedUrl.searchParams.get('client_id') === 'sonic_client_app', 'Authorize client_id parameter matches');
    assert(parsedUrl.searchParams.get('state') === 'custom_state_123', 'Custom state preserved');
    assert(parsedUrl.searchParams.get('code_challenge') === 'mock_challenge', 'PKCE code_challenge added');
  }

  console.log('\n2. Testing Session Creation & sonic_live_v2 API Key Generation');
  let testSession;
  let testPayload;
  {
    const env = { SONIC_SECRET: PRIMARY_SECRET };
    testSession = await createSession(env, {
      id: 'usr_epocanvas_001',
      email: 'developer@epocanvas.com',
      name: 'Epo Developer',
      avatar: 'https://mail.epocanvas.com/avatar/dev.png',
      role: 'developer',
    });

    assert(testSession.id === 'usr_epocanvas_001', 'User ID preserved');
    assert(testSession.email === 'developer@epocanvas.com', 'User email preserved');
    assert(testSession.apiKey.startsWith('sonic_live_v2.'), 'API key has sonic_live_v2. prefix');

    const parts = testSession.apiKey.split('.');
    assert(parts.length === 4, 'API key has v2, header, payload and signature segments');
    const header = decodeJsonPart(parts[1]);
    testPayload = decodeJsonPart(parts[2]);
    assert(header.alg === 'HS256' && header.typ === 'sonic-api-key', 'Header declares HS256 API key type');
    assert(header.kid === deriveKeyId(PRIMARY_SECRET), 'Header kid is derived from the signing secret');
    assert(testPayload.sub === 'developer@epocanvas.com', 'Payload subject matches email');
    assert(testPayload.kid === header.kid, 'Payload kid matches header kid');
    assert(Number.isSafeInteger(testPayload.iat) && Number.isSafeInteger(testPayload.exp), 'iat/exp present');
    assert(typeof testPayload.jti === 'string' && testPayload.jti.length >= 16, 'jti present');
  }

  console.log('\n3. Testing Secret Priority & Fallback');
  {
    const user = { email: 'fallback@epocanvas.com', name: 'Fallback User', avatar: '' };
    const sessionSolara = await createSession({ SOLARA_SECRET: SECONDARY_SECRET }, user);
    assert(sessionSolara.apiKey.startsWith('sonic_live_v2.'), 'Key generated using SOLARA_SECRET fallback');
    const sessionBoth = await createSession({ SONIC_SECRET: PRIMARY_SECRET, SOLARA_SECRET: SECONDARY_SECRET }, user);
    assert(sessionBoth.apiKey.startsWith('sonic_live_v2.'), 'Key generated with both secrets present');
  }

  console.log('\n4. Testing Credential Extraction (Headers Only)');
  {
    const req1 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Sonic-Key': 'sonic_live_v2.header.payload.sig' },
    });
    assert(extractAuthCredentials(req1).apiKey === 'sonic_live_v2.header.payload.sig', 'Extracted from X-Sonic-Key');

    const req2 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-CFSolara-Key': 'sonic_live_v2.header.payload.sig' },
    });
    assert(extractAuthCredentials(req2).apiKey === 'sonic_live_v2.header.payload.sig', 'Extracted from X-CFSolara-Key');

    const req3 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { 'X-Api-Key': 'sonic_live_v2.header.payload.sig' },
    });
    assert(extractAuthCredentials(req3).apiKey === 'sonic_live_v2.header.payload.sig', 'Extracted from X-Api-Key');

    const req4 = new Request('https://sonic.epocanvas.com/api/test', {
      headers: { Authorization: 'Bearer sonic_live_v2.header.payload.sig' },
    });
    const ext4 = extractAuthCredentials(req4);
    assert(ext4.apiKey === 'sonic_live_v2.header.payload.sig', 'Extracted from Bearer token');
    assert(ext4.token === 'sonic_live_v2.header.payload.sig', 'Bearer token string preserved');

    const req5 = new Request('https://sonic.epocanvas.com/api/test?api_key=sonic_live_v2.header.payload.sig');
    assert(extractAuthCredentials(req5).apiKey === undefined, 'Query param api_key is never accepted');
    assert(
      extractAuthCredentials(req5, { SONIC_ALLOW_QUERY_KEY: '1' }).apiKey === undefined,
      'Legacy query-key opt-in is ignored',
    );
  }

  console.log('\n5. Testing v2 Signature Verification');
  {
    const env = { SONIC_SECRET: PRIMARY_SECRET };
    const req = new Request('https://sonic.epocanvas.com/api/music/search?q=test', {
      headers: { 'X-Sonic-Key': testSession.apiKey },
    });
    const res = await verifyAuth(req, env);
    assert(res.authenticated === true, 'Valid v2 session authenticated');
    assert(res.user?.email === 'developer@epocanvas.com', 'Session user email matches');
    assert(res.user?.apiKey === testSession.apiKey, 'Session user apiKey matches');
  }

  console.log('\n6. Testing Cross-Header Verification');
  {
    const env = { SONIC_SECRET: PRIMARY_SECRET };
    const resSolara = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/search?q=test', {
        headers: { 'X-CFSolara-Key': testSession.apiKey },
      }),
      env,
    );
    assert(resSolara.authenticated === true, 'v2 key authenticated via X-CFSolara-Key');

    const resBearer = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/search?q=test', {
        headers: { Authorization: `Bearer ${testSession.apiKey}` },
      }),
      env,
    );
    assert(resBearer.authenticated === true, 'v2 key authenticated via Bearer token');
  }

  console.log('\n7. Testing Secret Rotation & Revocation');
  {
    const envRotated = {
      SONIC_SECRET: ROTATED_SECRET,
      SONIC_SECRET_PREV: PRIMARY_SECRET,
    };
    const resRotated = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/stream?id=123', {
        headers: { 'X-Sonic-Key': testSession.apiKey },
      }),
      envRotated,
    );
    assert(resRotated.authenticated === true, 'Key verified via SONIC_SECRET_PREV during rotation');

    const resRetired = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/stream?id=123', {
        headers: { 'X-Sonic-Key': testSession.apiKey },
      }),
      { SONIC_SECRET: ROTATED_SECRET },
    );
    assert(resRetired.authenticated === false, 'Retired secret no longer verifies old keys');

    const resRevoked = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/stream?id=123', {
        headers: { 'X-Sonic-Key': testSession.apiKey },
      }),
      { SONIC_SECRET: PRIMARY_SECRET, SONIC_REVOKED_JTIS: testPayload.jti },
    );
    assert(resRevoked.authenticated === false, 'Revoked jti is rejected without a cache bypass');
  }

  console.log('\n8. Testing Rejection of Legacy & Forged Keys');
  {
    const legacyEmail = 'legacy_tester@epocanvas.com';
    const enc = btoa(legacyEmail).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const legacySolara = `solara_live_${enc}_d41d8cd98f00b204e9800998ecf8427e`;
    const legacySonic = `sonic_live_${enc}_a1b2c3d4e5f67890123456789abcdef0`;

    const resSolara = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/test', { headers: { 'X-CFSolara-Key': legacySolara } }),
      { SONIC_SECRET: PRIMARY_SECRET },
    );
    assert(resSolara.authenticated === false, 'Legacy solara_live_ key is rejected');

    const resSonic = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/test', { headers: { 'X-Sonic-Key': legacySonic } }),
      { SONIC_SECRET: PRIMARY_SECRET },
    );
    assert(resSonic.authenticated === false, 'Legacy unsigned sonic_live_ key is rejected');

    const now = Math.floor(Date.now() / 1000);
    const v1Payload = stringToBase64Url(
      JSON.stringify({ v: 1, email: 'v1@epocanvas.com', exp: now + 3600, kid: 'current' }),
    );
    const v1Key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(PRIMARY_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const v1Sig = await crypto.subtle.sign('HMAC', v1Key, new TextEncoder().encode(`v1.${v1Payload}`));
    const v1Token = `sonic_live_v1.${v1Payload}.${base64UrlEncode(new Uint8Array(v1Sig))}`;
    const resV1 = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/test', { headers: { 'X-Sonic-Key': v1Token } }),
      { SONIC_SECRET: PRIMARY_SECRET },
    );
    assert(resV1.authenticated === false, 'Signed v1 key is rejected (re-login required)');

    const noSig = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/test', { headers: { 'X-Sonic-Key': 'sonic_live_v2.onlyonepart' } }),
      { SONIC_SECRET: PRIMARY_SECRET },
    );
    assert(noSig.authenticated === false, 'Truncated v2 key is rejected');
  }

  console.log('\n9. Testing Negative & Edge Cases');
  {
    const env = { SONIC_SECRET: PRIMARY_SECRET };

    const emptyRes = await verifyAuth(new Request('https://sonic.epocanvas.com/api/music/search'), env);
    assert(emptyRes.authenticated === false, 'Request with no auth is rejected');

    const invalidPrefixRes = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/search', {
        headers: { 'X-Sonic-Key': 'random_prefix_abc123' },
      }),
      env,
    );
    assert(invalidPrefixRes.authenticated === false, 'Invalid key prefix is rejected');

    const malformedRes = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/search', {
        headers: { 'X-Sonic-Key': 'sonic_live_v2.%%%notbase64%%%.sig.more' },
      }),
      env,
    );
    assert(malformedRes.authenticated === false, 'Malformed base64 is rejected gracefully');

    const shortRes = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/music/search', {
        headers: { 'X-Sonic-Key': testSession.apiKey },
      }),
      { SONIC_SECRET: 'short_key_123' },
    );
    assert(shortRes.authenticated === false, 'Secret shorter than 32 chars rejects authentication');

    const now = Math.floor(Date.now() / 1000);
    const unknownKid = await buildToken(
      PRIMARY_SECRET,
      { alg: 'HS256', typ: 'sonic-api-key', v: 2, kid: 'unknown-kid' },
      {
        sub: 'unknown@epocanvas.com',
        iat: now,
        exp: now + 3600,
        jti: 'unknown-kid-test-0123456789',
        kid: 'unknown-kid',
        role: 'user',
      },
    );
    const unknownRes = await verifyAuth(
      new Request('https://sonic.epocanvas.com/api/test', { headers: { 'X-Sonic-Key': unknownKid } }),
      env,
    );
    assert(unknownRes.authenticated === false, 'Unknown kid is rejected');
  }

  console.log(`\n========================================`);
  console.log(`Auth Security Test Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAuthTests().catch((err) => {
  console.error('Fatal auth test error:', err);
  process.exit(1);
});

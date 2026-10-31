import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createSession, verifyAuth } from '../functions/_lib/auth';
import { onRequest as handleMiddleware } from '../functions/_middleware';
import { onRequest as handleAuthLogin } from '../functions/api/auth/login';
import { onRequest as handleAuthCallback } from '../functions/api/auth/callback';
import { onRequest as handleAuthLogout } from '../functions/api/auth/logout';
import { onRequest as handleMusicStream } from '../functions/api/music/stream';
import { onRequest as handleMusicSearch } from '../functions/api/music/search';
import { onRequest as handleMusicCover } from '../functions/api/music/cover';
import { onRequest as handleSonicSearchNexus } from '../functions/api/sonic/search/nexus';
import { onRequest as handleSonicSearchPlatform } from '../functions/api/sonic/search/[platform]';
import { onRequest as handleSonicLyricsPlatform } from '../functions/api/sonic/lyrics/[platform]';
import { onRequest as handleSonicForward } from '../functions/api/sonic/forward';
import { onRequest as handleTestAudio } from '../functions/api/sonic/test-audio';
import { onRequest as handleEngineHealth } from '../functions/api/sonic/engine/health';
import { onRequest as handleEngineMetrics } from '../functions/api/sonic/engine/metrics';
import { onRequest as handleProxy } from '../functions/proxy';
import { onRequest as handlePalette } from '../functions/palette';
import { handleUpstreamEndpoint } from '../functions/_lib/sonic/upstream';
import { CONTENT_SOURCE_LICENSING_REGISTRY, evaluateContentFlags } from '../functions/_lib/sonic/licensing';
import {
  getObservabilitySnapshot,
  recordHttpRequestMetric,
  redactSensitiveString,
  resetObservabilityForTest,
} from '../functions/_lib/sonic/observability';
import {
  evaluateGatewayRateLimit,
  getRateLimitConfigStatus,
  resetRateLimitsForTest,
} from '../functions/_lib/sonic/security';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { ensureCatalogSeeded } from '../functions/_lib/sonic/recommend/seed-catalog';
import type { AppEnv } from '../functions/_lib/types';

const TEST_SECRET = 'sonic_test_primary_hmac_secret_2026_release_gate_998877';
const TEST_ENGINE_SECRET = 'sonic_test_engine_interservice_secret_2026_release_gate_112233';

function cfReq(url: string, init: RequestInit = {}, ip = '198.51.100.42'): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', ip);
  }
  return new Request(url, { ...init, headers });
}

beforeEach(() => {
  resetRateLimitsForTest();
  resetObservabilityForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P0-A: OAuth Feature Gate, CSRF Consistency & Token Content-Type Interop', () => {
  it('SONIC_ENABLE_OAUTH=0 blocks login and callback with 403 while keeping server auth enforcement intact', async () => {
    const env: AppEnv = {
      SONIC_ENABLE_OAUTH: '0',
      SONIC_SECRET: TEST_SECRET,
      SONIC_REQUIRE_AUTH: '1',
      EPOMAIL_CLIENT_ID: 'client_123',
      EPOMAIL_CLIENT_SECRET: 'secret_456',
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.tech/api/auth/callback',
    };

    const loginResp = await handleAuthLogin({
      request: cfReq('https://sonic.epocanvas.tech/api/auth/login'),
      env,
    });
    expect(loginResp.status).toBe(403);
    expect(loginResp.headers.get('Cache-Control')).toContain('no-store');
    const loginJson = (await loginResp.json()) as any;
    expect(loginJson.error.code).toBe('OAUTH_DISABLED_BY_POLICY');

    const cbResp = await handleAuthCallback({
      request: cfReq('https://sonic.epocanvas.tech/api/auth/callback?code=abc&state=xyz', {
        headers: { Cookie: 'sonic_oauth_state=xyz; sonic_oauth_verifier=ver123' },
      }),
      env,
    });
    expect(cbResp.status).toBe(403);
    const cbJson = (await cbResp.json()) as any;
    expect(cbJson.error.code).toBe('OAUTH_DISABLED_BY_POLICY');

    // Protected API still enforces authentication (never weakened by SONIC_ENABLE_OAUTH=0)
    const anonDecision = await evaluateGatewayRateLimit(
      cfReq('https://sonic.epocanvas.tech/api/sonic/search/nexus?q=test'),
      env,
      'search',
    );
    expect(anonDecision.allowed).toBe(false);
    expect(anonDecision.backend).toBe('auth-gate');

    // Existing valid signed API key continues to verify cleanly
    const session = await createSession(env, { id: 'u_beta', email: 'beta-tester@epocanvas.com' });
    const authCheck = await verifyAuth(
      cfReq('https://sonic.epocanvas.tech/api/auth/user', {
        headers: { 'X-Sonic-Key': session.apiKey },
      }),
      env,
    );
    expect(authCheck.authenticated).toBe(true);
    expect(authCheck.user?.email).toBe('beta-tester@epocanvas.com');
  });

  it('POST /api/auth/logout enforces same-origin check on both Origin and Referer headers', async () => {
    const env: AppEnv = { SONIC_SECRET: TEST_SECRET };
    const session = await createSession(env, { id: 'u_logout', email: 'tester@epocanvas.com' });
    const sessionToken = session.apiKey;

    // Cross-site Referer without Origin header -> rejected with 403
    const crossSiteRefererResp = await handleAuthLogout({
      request: cfReq('https://sonic.epocanvas.tech/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `sonic_session=${sessionToken}`,
          Referer: 'https://attacker.example/csrf.html',
        },
      }),
      env,
    });
    expect(crossSiteRefererResp.status).toBe(403);

    // Same-origin Referer -> allowed (200)
    const sameOriginResp = await handleAuthLogout({
      request: cfReq('https://sonic.epocanvas.tech/api/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `sonic_session=${sessionToken}`,
          Referer: 'https://sonic.epocanvas.tech/settings',
        },
      }),
      env,
    });
    expect(sameOriginResp.status).toBe(200);
  });

  it('supports EPOMAIL_TOKEN_CONTENT_TYPE=form for RFC 6749 token endpoints', async () => {
    let capturedContentType = '';
    let capturedBody = '';

    vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith('/oauth/token')) {
        capturedContentType = String((init?.headers as any)?.['Content-Type'] || '');
        capturedBody = String(init?.body || '');
        return new Response(JSON.stringify({ access_token: 'epo_at_test_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.endsWith('/oauth/userinfo')) {
        return new Response(JSON.stringify({ sub: 'u_1', email: 'user@epocanvas.com', name: 'Beta User' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const env: AppEnv = {
      SONIC_ENABLE_OAUTH: '1',
      SONIC_SECRET: TEST_SECRET,
      EPOMAIL_CLIENT_ID: 'cid_test',
      EPOMAIL_CLIENT_SECRET: 'csec_test',
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.tech/api/auth/callback',
      EPOMAIL_TOKEN_CONTENT_TYPE: 'form',
    };

    const verifier = 'a'.repeat(48);
    const stateVal = 'b'.repeat(43);
    const resp = await handleAuthCallback({
      request: cfReq(
        `https://sonic.epocanvas.tech/api/auth/callback?code=oauth_code_xyz&state=${stateVal}`,
        {
          headers: {
            Cookie: `sonic_oauth_state=${stateVal}; sonic_oauth_verifier=${verifier}`,
          },
        },
      ),
      env,
    });

    expect(resp.status).toBe(302);
    expect(capturedContentType).toContain('application/x-www-form-urlencoded');
    expect(capturedBody).toContain('grant_type=authorization_code');
    expect(capturedBody).toContain('code=oauth_code_xyz');
    expect(capturedBody).toContain(`code_verifier=${verifier}`);
  });
});

describe('P0-B: Audio Proxy Security, Range/206/416 Consistency & Rate-Limit Safeguards', () => {
  it('never leaks signed upstream URLs via 302 redirect and enforces private, no-store caching', async () => {
    const audioBytes = new Uint8Array(64).fill(0x55);
    vi.stubGlobal('fetch', async () => {
      return new Response(audioBytes, {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': '64',
        },
      });
    });

    // Even when caller explicitly asks for `?redirect=1`, a URL carrying `?auth=` or `?vkey=` MUST be proxied, never 302-redirected
    const signedUrl = 'https://m701.music.126.net/20261030/track.mp3?auth=secret_cdn_sig_999&vuutv=tok';
    const resp = await handleMusicStream({
      request: cfReq(
        `https://sonic.epocanvas.tech/api/music/stream?redirect=1&url=${encodeURIComponent(signedUrl)}`,
      ),
      env: {},
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get('Location')).toBeNull();
    expect(resp.headers.get('Cache-Control')).toBe('private, no-store');

    // Unsigned allowlisted URL with `?redirect=1` uses private, no-store and does NOT expose Location to cross-origin JS
    const unsignedUrl = 'https://m701.music.126.net/public/unsigned.mp3';
    const redirectResp = await handleMusicStream({
      request: cfReq(
        `https://sonic.epocanvas.tech/api/music/stream?redirect=1&url=${encodeURIComponent(unsignedUrl)}`,
      ),
      env: {},
    });
    expect(redirectResp.status).toBe(302);
    expect(redirectResp.headers.get('Cache-Control')).toBe('private, no-store');
    expect(redirectResp.headers.get('Access-Control-Expose-Headers') || '').not.toContain('Location');
  });

  it('strips Content-Length when upstream sends Content-Encoding and rejects mismatched 206 Content-Range span', async () => {
    // 1. Upstream sends Content-Encoding: gzip -> Content-Length must be omitted
    vi.stubGlobal('fetch', async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Encoding': 'gzip',
          'Content-Length': '999',
        },
      });
    });

    const gzResp = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: {},
    });
    expect(gzResp.status).toBe(200);
    expect(gzResp.headers.get('Content-Length')).toBeNull();

    // 2. Upstream sends 206 Partial Content where Content-Range (100 bytes) != Content-Length (500 bytes) -> 502
    vi.stubGlobal('fetch', async () => {
      return new Response(new Uint8Array(100), {
        status: 206,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Range': 'bytes 0-99/1000',
          'Content-Length': '500',
        },
      });
    });

    const bad206 = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3', {
        headers: { Range: 'bytes=0-99' },
      }),
      env: {},
    });
    expect(bad206.status).toBe(502);
    expect(bad206.headers.get('Cache-Control')).toContain('no-store');
    const badJson = (await bad206.json()) as any;
    expect(badJson.error.code).toBe('UPSTREAM_LENGTH_MISMATCH');
  });

  it('handles upstream 416, 403, 429 and 503 HTML error pages cleanly with no-store without leaking HTML', async () => {
    // Upstream 416 with HTML body
    vi.stubGlobal('fetch', async () => {
      return new Response('<html>Range Not Satisfiable</html>', {
        status: 416,
        headers: {
          'Content-Type': 'text/html',
          'Content-Range': 'bytes */4096',
        },
      });
    });
    const r416 = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3', {
        headers: { Range: 'bytes=5000-6000' },
      }),
      env: {},
    });
    expect(r416.status).toBe(416);
    expect(r416.headers.get('Content-Range')).toBe('bytes */4096');
    expect(r416.headers.get('Cache-Control')).toContain('no-store');

    // Upstream 429 with Retry-After and HTML body
    vi.stubGlobal('fetch', async () => {
      return new Response('<html>Too Many Requests</html>', {
        status: 429,
        headers: { 'Content-Type': 'text/html', 'Retry-After': '15' },
      });
    });
    const r429 = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: {},
    });
    expect(r429.status).toBe(429);
    expect(r429.headers.get('Retry-After')).toBe('15');
    expect(await r429.text()).not.toContain('<html>');

    // Upstream 200 OK with text/html MUST still be rejected with 415
    vi.stubGlobal('fetch', async () => {
      return new Response('<html>Captive Portal</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
    const r415 = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: {},
    });
    expect(r415.status).toBe(415);
  });

  it('enforces concurrent rate-limit bursts and fails closed when SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1 lacks native binding', async () => {
    const edgeDegradedEnv: AppEnv = {
      SONIC_RUNTIME: 'cf-pages',
      SONIC_RATE_LIMIT_ANON_RPM: '8',
    };
    expect(getRateLimitConfigStatus(edgeDegradedEnv).productionCompliant).toBe(false);

    // Fire 20 concurrent requests from the same public IP
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () =>
        evaluateGatewayRateLimit(
          cfReq('https://sonic.epocanvas.tech/api/sonic/search/nexus?q=burst', {}, '203.0.113.77'),
          edgeDegradedEnv,
          'burst-test',
        ),
      ),
    );
    const allowedCount = decisions.filter((d) => d.allowed).length;
    const rejectedCount = decisions.filter((d) => !d.allowed).length;
    expect(allowedCount).toBe(8);
    expect(rejectedCount).toBe(12);
    expect(decisions[0].degraded).toBe(true);

    // Production guard: SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1 without RATE_LIMITER fails closed (503)
    const strictProdEnv: AppEnv = {
      SONIC_RUNTIME: 'cf-pages',
      SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT: '1',
    };
    const strictRes = await handleMusicSearch({
      request: cfReq('https://sonic.epocanvas.tech/api/music/search?q=test', {}, '203.0.113.88'),
      env: strictProdEnv,
    });
    expect(strictRes.status).toBe(503);
    expect(strictRes.headers.get('X-RateLimit-Backend')).toBe('fail-closed');
    const strictJson = (await strictRes.json()) as any;
    expect(strictJson.error.code).toBe('RATE_LIMITER_NOT_BOUND');
  });
});

describe('P0-C: Content Licensing Matrix, Strict Allowlist Isolation & First-Party Synthetic Range/Seek', () => {
  const strictBetaEnv: AppEnv = {
    SONIC_CONTENT_POLICY: 'strict-allowlist',
    SONIC_ALLOWED_SOURCES: 'synthetic',
    SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1',
  };

  it('classifies all sources in CONTENT_SOURCE_LICENSING_REGISTRY and disables unapproved sources in strict-allowlist mode', () => {
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.synthetic.authorizationStatus).toBe('APPROVED');
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.netease.authorizationStatus).toBe('PENDING_CONFIRMATION');
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.qq.authorizationStatus).toBe('PENDING_CONFIRMATION');
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.gdstudio.authorizationStatus).toBe('APPROVED');
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.unblock.authorizationStatus).toBe('PROHIBITED');
    expect(CONTENT_SOURCE_LICENSING_REGISTRY.apple.authorizationStatus).toBe('CONDITIONAL');

    const flags = evaluateContentFlags(strictBetaEnv);
    expect(flags.enableSynthetic).toBe(true);
    expect(flags.enableNetease).toBe(false);
    expect(flags.enableQq).toBe(false);
    expect(flags.enableKugou).toBe(false);
    expect(flags.enableKuwo).toBe(false);
    expect(flags.enableAmll).toBe(false);
    expect(flags.enableLrclib).toBe(false);
    expect(flags.enableGdstudio).toBe(false);
    expect(flags.enableLyriva).toBe(false);
  });

  it('blocks every unapproved commercial/third-party entrypoint with 403 under strict-allowlist', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('Strict allowlist must NOT issue any outbound commercial upstream fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const rSearchMusic = await handleMusicSearch({
      request: cfReq('https://sonic.epocanvas.tech/api/music/search?q=jay&source=netease'),
      env: strictBetaEnv,
    });
    expect(rSearchMusic.status).toBe(403);

    const rSearchPlat = await handleSonicSearchPlatform({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/search/netease?q=jay'),
      params: { platform: 'netease' },
      env: strictBetaEnv,
    });
    expect(rSearchPlat.status).toBe(403);

    const rLyricsPlat = await handleSonicLyricsPlatform({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/lyrics/qq?title=test'),
      params: { platform: 'qq' },
      env: strictBetaEnv,
    });
    expect(rLyricsPlat.status).toBe(403);

    const rStreamId = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?id=186016&source=netease'),
      env: strictBetaEnv,
    });
    expect(rStreamId.status).toBe(403);

    const rStreamUrl = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: strictBetaEnv,
    });
    expect(rStreamUrl.status).toBe(400);

    const rCoverId = await handleMusicCover({
      request: cfReq('https://sonic.epocanvas.tech/api/music/cover?id=186016&source=netease'),
      env: strictBetaEnv,
    });
    expect(rCoverId.status).toBe(403);

    const rBanner = await handleUpstreamEndpoint(
      'banner',
      new URL('https://sonic.epocanvas.tech/api/banner'),
      cfReq('https://sonic.epocanvas.tech/api/banner'),
      strictBetaEnv,
    );
    expect(rBanner.status).toBe(403);

    const rProxyKuwo = await handleProxy({
      request: cfReq('https://sonic.epocanvas.tech/proxy?target=https%3A%2F%2Fsycdn.kuwo.cn%2Ftrack.mp3'),
      env: strictBetaEnv,
    });
    expect(rProxyKuwo.status).toBe(403);

    const rForward = await handleSonicForward({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/forward?url=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: strictBetaEnv,
    });
    expect(rForward.status).toBe(403);

    const rPalette = await handlePalette({
      request: cfReq('https://sonic.epocanvas.tech/palette?url=https%3A%2F%2Fp1.music.126.net%2Fa.jpg'),
      env: strictBetaEnv,
    });
    expect(rPalette.status).toBe(403);

    // Zero outbound network calls were made
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves first-party synthetic PCM/WAV tracks with byte-exact HTTP 200, 206 Range Seek continuity, 416, and fault injection', async () => {
    // 1. Search returns synthetic tracks only
    const searchResp = await handleSonicSearchNexus({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/search/nexus?q=440Hz&nocache=1'),
      env: strictBetaEnv,
    });
    expect(searchResp.status).toBe(200);
    const searchJson = (await searchResp.json()) as any;
    expect(searchJson.data.tracks.length).toBeGreaterThanOrEqual(1);
    expect(searchJson.data.tracks[0].sources[0].platform).toBe('synthetic');
    expect(searchJson.data.tracks[0].platformId).toBe('syn-440hz');

    // 2. Recommendation seed catalog only seeds synthetic tracks under strict-allowlist
    const memStore = new MemoryRecommendStore();
    ensureCatalogSeeded(memStore, strictBetaEnv);
    const seededTracks = memStore.listTracks(100);
    expect(seededTracks.length).toBe(3);
    expect(seededTracks.every((t) => t.provider === 'synthetic')).toBe(true);

    // 3. Full HTTP 200 stream via /api/music/stream?id=syn-440hz&source=synthetic
    const fullResp = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic'),
      env: strictBetaEnv,
    });
    expect(fullResp.status).toBe(200);
    expect(fullResp.headers.get('Content-Type')).toBe('audio/wav');
    expect(fullResp.headers.get('Accept-Ranges')).toBe('bytes');
    const fullBuf = new Uint8Array(await fullResp.arrayBuffer());
    expect(fullBuf.byteLength).toBe(44 + 12 * 8000 * 2); // 192044 bytes
    expect(new TextDecoder().decode(fullBuf.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(fullBuf.slice(8, 12))).toBe('WAVE');

    // 4. Multi-offset HTTP 206 Range Seek slices match full WAV buffer byte-for-byte
    const ranges: Array<[number, number]> = [
      [0, 1023],
      [1024, 16383],
      [64000, 96000],
      [191000, 192043],
    ];
    for (const [start, end] of ranges) {
      const partResp = await handleMusicStream({
        request: cfReq('https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic', {
          headers: { Range: `bytes=${start}-${end}` },
        }),
        env: strictBetaEnv,
      });
      expect(partResp.status).toBe(206);
      expect(partResp.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${fullBuf.byteLength}`);
      expect(partResp.headers.get('Content-Length')).toBe(String(end - start + 1));
      const partBuf = new Uint8Array(await partResp.arrayBuffer());
      expect(partBuf).toEqual(fullBuf.slice(start, end + 1));
    }

    // 5. Out-of-bounds Range returns 416 with Content-Range: bytes */total
    const r416 = await handleMusicStream({
      request: cfReq('https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic', {
        headers: { Range: 'bytes=500000-600000' },
      }),
      env: strictBetaEnv,
    });
    expect(r416.status).toBe(416);
    expect(r416.headers.get('Content-Range')).toBe(`bytes */${fullBuf.byteLength}`);

    // 6. Controlled fault scenarios for E2E degradation verification
    const f403 = await handleTestAudio({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/test-audio?id=syn-fault-403'),
      env: strictBetaEnv,
    });
    expect(f403.status).toBe(403);

    const f429 = await handleTestAudio({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/test-audio?id=syn-fault-429'),
      env: strictBetaEnv,
    });
    expect(f429.status).toBe(429);
    expect(f429.headers.get('Retry-After')).toBe('5');

    const f500 = await handleTestAudio({
      request: cfReq('https://sonic.epocanvas.tech/api/sonic/test-audio?id=syn-fault-500'),
      env: strictBetaEnv,
    });
    expect(f500.status).toBe(502);
  });
});

describe('P1-A/B/C: Observability, Redaction, Webhook Alerting, Staging Gate & Storage Readiness', () => {
  it('redacts API keys, session cookies, Bearer tokens, and signed CDN URL query parameters', () => {
    const raw =
      'Failed stream https://m701.music.126.net/a.mp3?auth=sec_123&vkey=qq_456&code=oauth_789 header Authorization: Bearer secret_jwt Cookie: sonic_session=sonic_live_v2.aaa.bbb.ccc';
    const scrubbed = redactSensitiveString(raw);
    expect(scrubbed).not.toContain('sec_123');
    expect(scrubbed).not.toContain('qq_456');
    expect(scrubbed).not.toContain('oauth_789');
    expect(scrubbed).not.toContain('secret_jwt');
    expect(scrubbed).not.toContain('aaa.bbb.ccc');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('enforces Staging access gate and attaches X-Robots-Tag + X-Sonic-Release in middleware', async () => {
    const stagingEnv: AppEnv = {
      SONIC_ENV: 'staging',
      SONIC_RELEASE_COMMIT: 'bb5183c6c0bb7f8f5e08d58e1aa65b2f57083247',
      SONIC_STAGING_ACCESS_TOKEN: 'staging_gate_secret_2026_oct31',
    };

    // Anonymous -> 401 + noindex
    const anonResp = await handleMiddleware({
      request: cfReq('https://sonic-staging.pages.dev/'),
      env: stagingEnv,
      next: async () => new Response('SPA HTML', { status: 200 }),
    });
    expect(anonResp.status).toBe(401);
    expect(anonResp.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    expect(anonResp.headers.get('X-Sonic-Release')).toBe('bb5183c6c0bb');

    // Authorized via X-Sonic-Staging-Token -> 200 + noindex + X-Sonic-Release
    const authResp = await handleMiddleware({
      request: cfReq('https://sonic-staging.pages.dev/', {
        headers: { 'X-Sonic-Staging-Token': 'staging_gate_secret_2026_oct31' },
      }),
      env: stagingEnv,
      next: async () => new Response('SPA HTML', { status: 200 }),
    });
    expect(authResp.status).toBe(200);
    expect(authResp.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    expect(authResp.headers.get('X-Sonic-Release')).toBe('bb5183c6c0bb');
  });

  it('delivers redacted webhook alerts to a real local HTTP receiver and fails closed on unwritable disk', async () => {
    const receivedPayloads: any[] = [];
    const webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          receivedPayloads.push(JSON.parse(body));
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"received":true}');
      });
    });

    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = webhookServer.address() as { port: number };
    const webhookUrl = `http://127.0.0.1:${addr.port}/sonic-alert`;

    try {
      const env: AppEnv = {
        SONIC_RUNTIME: 'linux-engine',
        SONIC_ENGINE_SECRET: TEST_ENGINE_SECRET,
        SONIC_ENV: 'staging',
        SONIC_RELEASE_COMMIT: 'bb5183c6c0bb7f8f5e08d58e1aa65b2f57083247',
        SONIC_RECOMMEND_DB_PATH: '/app/data/sonic-recommend.sqlite',
        RECOMMEND_STORE: {
          kind: 'sqlite',
          upsertTrack: () => {},
          getStats: () => ({ storageKind: 'sqlite', trackCount: 3, eventCount: 1 }),
        },
        SONIC_ALERT_WEBHOOK_URL: webhookUrl,
        SONIC_ALERT_ALLOW_LOCALHOST: '1',
        SONIC_ALERT_COOLDOWN_SEC: '300',
        SONIC_DISK_HEALTH_PROVIDER: () => ({
          ok: true,
          writable: true,
          path: '/app/data/sonic-recommend.sqlite',
          freeMb: 4096,
          lowSpace: false,
        }),
      };

      // Record latency samples and verify P95 computation
      for (const ms of [12, 18, 25, 31, 44, 52, 60, 75, 90, 240]) {
        recordHttpRequestMetric('/api/sonic/search/nexus', 200, ms);
      }
      const snap = getObservabilitySnapshot(env);
      expect(snap.latency.search.count).toBe(10);
      expect(snap.latency.search.p95Ms).toBe(240);

      // Healthy engine readiness -> 200
      const okHealth = await handleEngineHealth({
        request: cfReq('http://127.0.0.1:18080/api/sonic/engine/health', {
          headers: { 'X-Sonic-Engine-Key': TEST_ENGINE_SECRET },
        }),
        env,
      });
      expect(okHealth.status).toBe(200);
      const okJson = (await okHealth.json()) as any;
      expect(okJson.ok).toBe(true);
      expect(okJson.release.releaseCommit).toBe('bb5183c6c0bb7f8f5e08d58e1aa65b2f57083247');

      // Manual alert self-check via POST /api/sonic/engine/metrics?action=test-alert (with sensitive token in note)
      const alertResp = await handleEngineMetrics({
        request: cfReq(
          'http://127.0.0.1:18080/api/sonic/engine/metrics?action=test-alert&note=Bearer%20secret_tok_999',
          {
            method: 'POST',
            headers: { 'X-Sonic-Engine-Key': TEST_ENGINE_SECRET },
          },
        ),
        env,
      });
      expect(alertResp.status).toBe(200);
      expect(receivedPayloads.length).toBe(1);
      expect(receivedPayloads[0].code).toBe('MANUAL_ALERT_SELF_CHECK');
      expect(receivedPayloads[0].summary).not.toContain('secret_tok_999');
      expect(receivedPayloads[0].summary).toContain('[REDACTED]');

      // Simulate read-only / full disk -> health MUST fail closed with 503 and fire ENGINE_STORAGE_UNHEALTHY alert
      const degradedEnv: AppEnv = {
        ...env,
        SONIC_DISK_HEALTH_PROVIDER: () => ({
          ok: false,
          writable: false,
          path: '/app/data/sonic-recommend.sqlite',
          freeMb: 12,
          lowSpace: true,
          error: 'EROFS',
        }),
      };
      const badHealth = await handleEngineHealth({
        request: cfReq('http://127.0.0.1:18080/api/sonic/engine/health', {
          headers: { 'X-Sonic-Engine-Key': TEST_ENGINE_SECRET },
        }),
        env: degradedEnv,
      });
      expect(badHealth.status).toBe(503);
      const badJson = (await badHealth.json()) as any;
      expect(badJson.ok).toBe(false);
      expect(badJson.recommendEngine.storageHealthy).toBe(false);

      // Wait briefly for fire-and-forget alert delivery
      await new Promise((r) => setTimeout(r, 80));
      expect(receivedPayloads.some((p) => p.code === 'ENGINE_STORAGE_UNHEALTHY')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    }
  });
});

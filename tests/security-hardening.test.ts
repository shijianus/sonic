import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBlockedSsrfHost,
  validateSafeUrl,
  safeFetch,
  buildSafeUpstreamResponseHeaders,
  evaluateAuthRateLimit,
  resetRateLimitsForTest,
} from '../functions/_lib/sonic/security';
import { parseSearchParams, parseLyricsParams, readBoundedRequestBody } from '../functions/_lib/sonic/route-helpers';
import { readBoundedArrayBuffer } from '../functions/palette';
import { onRequest as handleProxy } from '../functions/proxy';
import { onRequest as handlePalette } from '../functions/palette';
import { onRequest as handleAuthLogin } from '../functions/api/auth/login';
import { onRequest as handleMusicStream } from '../functions/api/music/stream';
import { onRequest as handleMusicCover } from '../functions/api/music/cover';
import { onRequest as handleSonicForward } from '../functions/api/sonic/forward';
import { corsHeaders } from '../functions/_lib/http';

const VALID_SECRET = 'super_secret_sonic_key_2026_primary_abcdef123456';

function cfRequest(url: string, init: RequestInit = {}, ip = '198.51.100.20'): Request {
  const headers = new Headers(init.headers);
  headers.set('CF-Connecting-IP', ip);
  return new Request(url, { ...init, headers });
}

beforeEach(() => {
  resetRateLimitsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SSRF: IPv4-compatible IPv6 literals', () => {
  it('blocks deprecated ::/96 addresses that embed loopback/private IPv4 hosts', () => {
    expect(isBlockedSsrfHost('::7f00:1')).toBe(true); // ::127.0.0.1
    expect(isBlockedSsrfHost('[::7f00:1]')).toBe(true);
    expect(isBlockedSsrfHost('::a00:1')).toBe(true); // ::10.0.0.1
    expect(isBlockedSsrfHost('::c0a8:101')).toBe(true); // ::192.168.1.1
    expect(isBlockedSsrfHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('still allows public IPv6 destinations', () => {
    expect(isBlockedSsrfHost('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedSsrfHost('2a03:2880:f10e:83:face:b00c:0:25de')).toBe(false);
  });

  it('rejects a URL whose host is normalised into a private IPv4-compatible address', () => {
    const res = validateSafeUrl('https://[::127.0.0.1]/secret');
    expect(res.valid).toBe(false);
  });
});

describe('safeFetch: redirect re-validation', () => {
  it('rejects a redirect that points at an internal address', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } }),
    );

    await expect(
      safeFetch('https://m701.music.126.net/a.mp3', undefined, {
        allowedDomains: ['music.126.net'],
      }),
    ).rejects.toThrow('SSRF check rejected');
  });

  it('rejects an https -> http protocol downgrade during redirect', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'http://m701.music.126.net/a.mp3' } }),
    );

    await expect(
      safeFetch('https://m701.music.126.net/a.mp3', undefined, {
        allowedDomains: ['music.126.net'],
      }),
    ).rejects.toThrow('downgrade');
  });
});

describe('Proxy: Kuwo audio redirects stay inside the allowlist', () => {
  it('returns 502 instead of following a redirect to loopback', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/evil' } }),
    );

    const res = await handleProxy({
      request: cfRequest('https://sonic.epocanvas.tech/proxy?target=https%3A%2F%2Fm.kuwo.cn%2Fa.mp3'),
      env: { SONIC_SECRET: VALID_SECRET } as any,
    });

    expect(res.status).toBe(502);
  });

  it('rejects non-Kuwo targets without emitting an upstream request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await handleProxy({
      request: cfRequest('https://sonic.epocanvas.tech/proxy?target=https%3A%2F%2Fevil.example%2Fa.mp3'),
      env: { SONIC_SECRET: VALID_SECRET } as any,
    });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Upstream response header relay', () => {
  it('strips Set-Cookie, Content-Encoding and server fingerprints', () => {
    const upstream = new Headers({
      'content-type': 'audio/mpeg',
      'content-range': 'bytes 0-1023/4096',
      'accept-ranges': 'bytes',
      etag: '"abc"',
      'content-encoding': 'gzip',
      'content-length': '512',
      'set-cookie': 'sonic_oauth_state=forged; Path=/api/auth',
      server: 'nginx/1.25',
      'x-powered-by': 'Express',
    });

    const headers = buildSafeUpstreamResponseHeaders(upstream, {
      'Access-Control-Allow-Origin': '*',
    });

    expect(headers.get('content-type')).toBe('audio/mpeg');
    expect(headers.get('content-range')).toBe('bytes 0-1023/4096');
    expect(headers.get('accept-ranges')).toBe('bytes');
    expect(headers.get('etag')).toBe('"abc"');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('content-encoding')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('server')).toBeNull();
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('keeps Content-Length when the body was not encoded', () => {
    const headers = buildSafeUpstreamResponseHeaders(
      new Headers({ 'content-type': 'image/jpeg', 'content-length': '1024' }),
    );
    expect(headers.get('content-length')).toBe('1024');
  });
});

describe('Palette: bounded resource consumption', () => {
  it('rejects an oversized declared payload before reading it', async () => {
    const res = new Response('x', {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(16 * 1024 * 1024) },
    });
    await expect(readBoundedArrayBuffer(res, 8 * 1024 * 1024)).rejects.toThrow('exceeds');
  });

  it('stops reading a stream that exceeds the limit', async () => {
    const chunk = new Uint8Array(4096);
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent >= 8) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = new Response(stream, { headers: { 'content-type': 'image/jpeg' } });
    await expect(readBoundedArrayBuffer(res, 8192)).rejects.toThrow('exceeds');
  });

  it('returns 413 for an oversized upstream image', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('tiny', {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(32 * 1024 * 1024) },
      }),
    );

    const res = await handlePalette({
      request: cfRequest(
        'https://sonic.epocanvas.tech/palette?image=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg',
      ),
      env: {} as any,
    });

    expect(res.status).toBe(413);
  });

  it('rate-limits palette requests', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { headers: { 'content-type': 'image/jpeg' } }));
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '1' } as any;
    const url = 'https://sonic.epocanvas.tech/palette?image=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg';

    const first = await handlePalette({ request: cfRequest(url), env });
    expect(first.status).not.toBe(429);

    const second = await handlePalette({ request: cfRequest(url), env });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('Auth endpoints: unauthenticated rate limiting', () => {
  it('allows 30 attempts per IP then returns 429, ignoring spoofed client IP headers', async () => {
    const env = { SONIC_REQUIRE_AUTH: '1', SONIC_SECRET: VALID_SECRET } as any;
    for (let i = 0; i < 30; i += 1) {
      const decision = await evaluateAuthRateLimit(
        cfRequest('https://sonic.epocanvas.tech/api/auth/login', {
          headers: { 'X-Sonic-Client-IP': `10.0.0.${i}` },
        }),
        env,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.tier).toBe('anonymous');
    }

    const blocked = await evaluateAuthRateLimit(
      cfRequest('https://sonic.epocanvas.tech/api/auth/login'),
      env,
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(30);
  });

  it('applies the limiter to /api/auth/login even when REQUIRE_AUTH is set', async () => {
    const env = {
      SONIC_REQUIRE_AUTH: '1',
      EPOMAIL_CLIENT_ID: 'client_123',
      EPOMAIL_CLIENT_SECRET: 'secret_123',
      EPOMAIL_BASE_URL: 'https://mail.epocanvas.com',
      EPOMAIL_REDIRECT_URI: 'https://sonic.epocanvas.tech/api/auth/callback',
    } as any;

    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await handleAuthLogin({
        request: cfRequest('https://sonic.epocanvas.tech/api/auth/login'),
        env,
      });
      lastStatus = res.status;
      if (i === 0) expect(res.status).toBe(302);
    }

    expect(lastStatus).toBe(429);
  });
});

describe('Input length caps', () => {
  it('caps search queries at 256 characters', () => {
    const url = new URL(`https://sonic.epocanvas.tech/api/sonic/search?q=${'a'.repeat(5000)}`);
    expect(parseSearchParams(url).query.length).toBe(256);
  });

  it('caps lyrics title/artist/id fields', () => {
    const url = new URL(
      `https://sonic.epocanvas.tech/api/sonic/lyrics/nexus?title=${'t'.repeat(5000)}&artist=${'a'.repeat(5000)}&platformId=${'1'.repeat(5000)}`,
    );
    const params = parseLyricsParams(url);
    expect(params.title?.length).toBe(200);
    expect(params.artist?.length).toBe(200);
    expect(params.platformId?.length).toBe(128);
  });
});

describe('Asset proxies: active content is never served from the Sonic origin', () => {
  it('rejects an HTML upstream on the audio stream proxy', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<html><script>alert(1)</script></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const res = await handleMusicStream({
      request: cfRequest('https://sonic.epocanvas.tech/api/music/stream?target=https%3A%2F%2Fy.qq.com%2F'),
      env: {} as any,
    });

    expect(res.status).toBe(415);
    expect(await res.text()).not.toContain('<script>');
  });

  it('relays real audio with nosniff and a sandboxing CSP', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('ID3-audio-bytes', {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' },
      }),
    );

    const res = await handleMusicStream({
      request: cfRequest('https://sonic.epocanvas.tech/api/music/stream?target=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
      env: {} as any,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await res.text()).toBe('ID3-audio-bytes');
  });

  it('never relays third-party SVG from the cover proxy', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }),
    );

    const res = await handleMusicCover({
      request: cfRequest('https://sonic.epocanvas.tech/api/music/cover?url=https%3A%2F%2Fy.qq.com%2Fx.svg'),
      env: {} as any,
    });

    const text = await res.text();
    expect(res.headers.get('X-Sonic-Cover-Fallback')).toBe('svg');
    expect(text).not.toContain('onload');
  });

  it('rejects an HTML upstream on the generic forward gateway', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('<html><script>alert(1)</script></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const res = await handleSonicForward({
      request: cfRequest('https://sonic.epocanvas.tech/api/sonic/forward?url=https%3A%2F%2Fy.qq.com%2F'),
      env: {} as any,
      waitUntil: undefined,
    });

    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json.error?.code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('hardens every JSON API response with nosniff and frame-ancestors', () => {
    const headers = corsHeaders();
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});

describe('Bounded request body reader', () => {
  it('rejects a body larger than the limit while streaming', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const request = new Request('https://sonic.epocanvas.tech/api/sonic/events', {
      method: 'POST',
      body,
      duplex: 'half',
    } as any);
    const result = await readBoundedRequestBody(request, 1024);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('returns the decoded text for an in-limit body', async () => {
    const request = new Request('https://sonic.epocanvas.tech/api/sonic/events', {
      method: 'POST',
      body: '{"events":[]}',
    });
    const result = await readBoundedRequestBody(request, 1024);
    expect(result).toEqual({ ok: true, text: '{"events":[]}' });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkEngineAccess,
  requiresEngineAuth,
  evaluateGatewayRateLimit,
  resetRateLimitsForTest,
  getRateLimitBucketCountForTest,
  setSafeFetchHostResolver,
  resetSafeFetchStateForTest,
  safeFetch,
} from '../functions/_lib/sonic/security';
import {
  ENGINE_INTERNAL_ORIGIN,
  normalizeSocketIp,
  sanitizeInboundHeaders,
  toWebRequest,
} from '../server/request-adapter';

const ENGINE_SECRET = 'engine_secret_must_be_32_characters_long_minimum!';

function engineEnv(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    SONIC_RUNTIME: 'linux-engine',
    SONIC_ENGINE_SECRET: ENGINE_SECRET,
    ...overrides,
  };
}

function nodeRequest(
  url: string,
  headers: Record<string, string> = {},
  socketAddress = '203.0.113.50',
): Request {
  return toWebRequest({
    url,
    method: 'GET',
    headers,
    socket: { remoteAddress: socketAddress },
  } as any);
}

describe('P0-2: Linux engine enforces service auth regardless of Host', () => {
  const engineRoutes = [
    '/api/music/search?q=test',
    '/api/music/stream?id=1',
    '/api/music/cover?id=1',
    '/api/sonic/search',
    '/api/sonic/forward?q=test',
    '/api/auth/user',
    '/api',
    '/proxy?types=search&name=test',
    '/palette?image=https%3A%2F%2Fp1.music.126.net%2Fa.jpg',
  ];

  it('rejects every engine API route without the service key', () => {
    for (const route of engineRoutes) {
      const req = new Request(`http://127.0.0.1${route}`, {
        headers: {
          Host: 'localhost',
          'X-Forwarded-Host': 'sonic.epocanvas.tech',
          'X-Forwarded-Proto': 'https',
        },
      });
      expect(requiresEngineAuth(req, engineEnv()), route).toBe(true);
      const denied = checkEngineAccess(req, engineEnv());
      expect(denied?.status, route).toBe(401);
    }
  });

  it('cannot be bypassed by spoofing an engine hostname or proxy headers', () => {
    const req = new Request('http://engine-sonic.epocanvas.tech/api/music/search?q=test', {
      headers: {
        'X-Forwarded-Host': 'localhost',
        'X-Forwarded-Proto': 'http',
        'X-Real-IP': '127.0.0.1',
        Forwarded: 'host=localhost;proto=http',
      },
    });
    expect(checkEngineAccess(req, engineEnv())?.status).toBe(401);
  });

  it('accepts the exact service key and keeps static assets public', () => {
    const allowed = new Request('http://127.0.0.1/api/music/search?q=test', {
      headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET },
    });
    expect(checkEngineAccess(allowed, engineEnv())).toBeNull();

    const staticAsset = new Request('http://127.0.0.1/assets/app.js');
    expect(requiresEngineAuth(staticAsset, engineEnv())).toBe(false);
    expect(checkEngineAccess(staticAsset, engineEnv())).toBeNull();
  });

  it('fails closed with 503 when the engine secret is not configured', () => {
    const req = new Request('http://127.0.0.1/api/music/search?q=test');
    const res = checkEngineAccess(req, { SONIC_RUNTIME: 'linux-engine' });
    expect(res?.status).toBe(503);
  });

  it('leaves public Pages routes open while protecting engine-only routes', () => {
    const env = { SONIC_RUNTIME: 'cf-pages', SONIC_ENGINE_SECRET: ENGINE_SECRET };
    const publicReq = new Request('https://sonic.epocanvas.tech/api/music/search?q=test', {
      headers: { Host: 'engine-sonic.evil', 'X-Forwarded-Host': 'engine-sonic.evil' },
    });
    expect(checkEngineAccess(publicReq, env)).toBeNull();

    const healthReq = new Request('https://sonic.epocanvas.tech/api/sonic/engine/health', {
      headers: { 'X-Forwarded-Host': 'localhost' },
    });
    expect(checkEngineAccess(healthReq, env)?.status).toBe(401);
  });
});

describe('P0-2: Node adapter strips untrusted proxy identity headers', () => {
  it('derives the URL from the request path, not Host or X-Forwarded-*', () => {
    const req = nodeRequest(
      'https://attacker.example/api/music/search?q=test',
      {
        host: 'engine-sonic.evil',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        'x-real-ip': '1.2.3.4',
        'x-sonic-hop': 'cf-pages',
      },
      '203.0.113.50',
    );

    expect(new URL(req.url).origin).toBe(ENGINE_INTERNAL_ORIGIN);
    expect(new URL(req.url).pathname).toBe('/api/music/search');
    expect(req.headers.get('host')).toBeNull();
    expect(req.headers.get('x-forwarded-host')).toBeNull();
    expect(req.headers.get('x-forwarded-proto')).toBeNull();
    expect(req.headers.get('x-forwarded-for')).toBeNull();
    expect(req.headers.get('forwarded')).toBeNull();
    expect(req.headers.get('x-real-ip')).toBeNull();
    expect(req.headers.get('x-sonic-hop')).toBeNull();
  });

  it('overwrites a forged CF-Connecting-IP with the actual socket address', () => {
    const req = nodeRequest('/api/music/search', { 'cf-connecting-ip': '1.2.3.4' }, '::ffff:203.0.113.51');
    expect(req.headers.get('cf-connecting-ip')).toBe('203.0.113.51');
    expect(normalizeSocketIp('::ffff:203.0.113.51')).toBe('203.0.113.51');
    expect(normalizeSocketIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('preserves end-user auth headers and the service key', () => {
    const headers = sanitizeInboundHeaders(
      {
        'x-sonic-key': 'user-key',
        'x-sonic-engine-key': ENGINE_SECRET,
        authorization: 'Bearer user-token',
      },
      '203.0.113.52',
    );
    expect(headers.get('x-sonic-key')).toBe('user-key');
    expect(headers.get('x-sonic-engine-key')).toBe(ENGINE_SECRET);
    expect(headers.get('authorization')).toBe('Bearer user-token');
  });
});

describe('P0-4: client IP spoofing cannot bypass rate limits', () => {
  beforeEach(() => {
    resetRateLimitsForTest();
  });

  it('keys Node requests on the socket IP even when the client forges CF-Connecting-IP', async () => {
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '1' };
    const first = nodeRequest('/api/music/search', { 'cf-connecting-ip': '1.1.1.1' }, '198.51.100.60');
    const second = nodeRequest('/api/music/search', { 'cf-connecting-ip': '8.8.8.8' }, '198.51.100.60');

    const d1 = await evaluateGatewayRateLimit(first, env, 'socket-ip');
    const d2 = await evaluateGatewayRateLimit(second, env, 'socket-ip');
    expect(d1.allowed).toBe(true);
    expect(d2.allowed).toBe(false);
  });

  it('honors a Cloudflare native RATE_LIMITER binding', async () => {
    const calls: string[] = [];
    const env = {
      RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          calls.push(key);
          return { success: false };
        },
      },
    };
    const req = new Request('https://sonic.epocanvas.tech/api/test', {
      headers: { 'CF-Connecting-IP': '198.51.100.70' },
    });
    const decision = await evaluateGatewayRateLimit(req, env, 'native');
    expect(decision.allowed).toBe(false);
    expect(calls[0]).toContain('native:');
  });

  it('keeps the in-memory bucket table strictly bounded under identity churn', async () => {
    const env = { SONIC_RATE_LIMIT_ANON_RPM: '10000' };
    for (let i = 0; i < 4200; i += 1) {
      const ip = `203.0.${Math.floor(i / 256)}.${i % 256}`;
      const req = new Request('https://sonic.epocanvas.tech/api/test', {
        headers: { 'CF-Connecting-IP': ip },
      });
      await evaluateGatewayRateLimit(req, env, 'capacity');
    }
    const count = getRateLimitBucketCountForTest();
    expect(count).toBeGreaterThanOrEqual(4096);
    expect(count).toBeLessThanOrEqual(4097);
  });
});

describe('P0-3: DNS rebinding, response size and redirect limits', () => {
  beforeEach(() => {
    resetSafeFetchStateForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSafeFetchStateForTest();
  });

  it('rejects a hostname that resolves to loopback or a private address', async () => {
    setSafeFetchHostResolver(async () => ['127.0.0.1']);
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ['music.com'] }),
    ).rejects.toThrow('forbidden address');

    setSafeFetchHostResolver(async () => ['93.184.216.34', '10.0.0.8']);
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ['music.com'] }),
    ).rejects.toThrow('forbidden address');
  });

  it('fails closed when DNS resolution fails or returns no records', async () => {
    setSafeFetchHostResolver(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ['music.com'] }),
    ).rejects.toThrow('DNS resolution failed');

    setSafeFetchHostResolver(async () => []);
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ['music.com'] }),
    ).rejects.toThrow('no addresses');
  });

  it('allows a public resolution and still validates redirect targets', async () => {
    setSafeFetchHostResolver(async () => ['93.184.216.34']);
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }),
    );
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ['music.com'] }),
    ).rejects.toThrow('SSRF check rejected');
  });

  it('rejects declared and streamed responses above maxBytes', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('tiny', { headers: { 'content-length': '2048' } }),
    );
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, {
        allowedDomains: ['music.com'],
        maxBytes: 1024,
      }),
    ).rejects.toThrow('exceeds');

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', async () => new Response(stream));
    const res = await safeFetch('https://cdn.music.com/a.mp3', undefined, {
      allowedDomains: ['music.com'],
      maxBytes: 1024,
    });
    await expect(res.text()).rejects.toThrow('exceeds');
  });

  it('stops after the configured number of redirects', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, { status: 302, headers: { location: 'https://cdn.music.com/next.mp3' } }),
    );
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, {
        allowedDomains: ['music.com'],
        maxRedirects: 2,
      }),
    ).rejects.toThrow('Too many redirects');
  });
});

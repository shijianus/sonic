import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBlockedSsrfHost,
  resetSafeFetchStateForTest,
  safeFetch,
  setSafeFetchHostResolver,
  SONIC_ALLOWED_MUSIC_DOMAINS,
  validateSafeUrl,
} from '../functions/_lib/sonic/security';
import { probeStreamPhysicalQuality, fetchProviderUrl } from '../functions/_lib/sonic/native-protocols';

const ALLOWED = ['music.com'];

beforeEach(() => {
  resetSafeFetchStateForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSafeFetchStateForTest();
});

describe('SSRF: special IPv6 representations', () => {
  it('blocks IPv4-translated addresses (::ffff:0:a.b.c.d) that hide loopback/private IPv4', () => {
    expect(isBlockedSsrfHost('::ffff:0:127.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:0:10.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:0:169.254.169.254')).toBe(true);
    expect(isBlockedSsrfHost('[::ffff:0:192.168.1.1]')).toBe(true);
  });

  it('blocks IPv4-mapped addresses (::ffff:a.b.c.d) that hide loopback/private IPv4', () => {
    expect(isBlockedSsrfHost('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedSsrfHost('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks 0.0.0.0, [::], and unspecified addresses', () => {
    expect(isBlockedSsrfHost('0.0.0.0')).toBe(true);
    expect(isBlockedSsrfHost('[::]')).toBe(true);
    expect(isBlockedSsrfHost('::')).toBe(true);
  });

  it('blocks decimal and hex obfuscated IPv4 loopback (2130706433, 0x7f000001)', () => {
    expect(isBlockedSsrfHost('2130706433')).toBe(true);
    expect(isBlockedSsrfHost('0x7f000001')).toBe(true);
    expect(isBlockedSsrfHost('0x7f.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('0177.0.0.1')).toBe(true);
  });

  it('blocks decimal and hex obfuscated private IPs', () => {
    expect(isBlockedSsrfHost('0xA9FEA9FE')).toBe(true);
    expect(isBlockedSsrfHost('0x0A000001')).toBe(true);
    expect(isBlockedSsrfHost('0xC0A80001')).toBe(true);
  });

  it('still allows public IPv4-translated addresses', () => {
    expect(isBlockedSsrfHost('::ffff:0:8.8.8.8')).toBe(false);
  });

  it('rejects non-HTTP protocols and malformed hosts', () => {
    expect(validateSafeUrl('file:///etc/passwd').valid).toBe(false);
    expect(validateSafeUrl('gopher://music.com/').valid).toBe(false);
    expect(validateSafeUrl('https://exa mple.com/').valid).toBe(false);
    expect(validateSafeUrl('https://music.com:8443/a.mp3').valid).toBe(false);
    expect(validateSafeUrl('https://user:pass@music.com/a.mp3').valid).toBe(false);
  });
});

describe('safeFetch: credential isolation', () => {
  it('strips client credentials and Sonic identity headers before calling upstream', async () => {
    let seen: Headers | undefined;
    vi.stubGlobal('fetch', async (_input: any, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('audio', {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });

    await safeFetch(
      'https://cdn.music.com/a.mp3',
      {
        headers: {
          Authorization: 'Bearer user-token',
          Cookie: 'sonic_session=secret',
          'X-Api-Key': 'secret',
          'X-Sonic-Key': 'secret',
          'X-CFSolara-Key': 'secret',
          'X-Sonic-Engine-Key': 'secret',
          'X-Sonic-Anon-Id': 'anon_12345678',
          'X-Sonic-Context': 'context',
          'X-Sonic-Personalization': 'on',
          'X-Sonic-Client-IP': '203.0.113.9',
          Range: 'bytes=0-1023',
          'User-Agent': 'Sonic-Test',
        },
      },
      { allowedDomains: ALLOWED },
    );

    expect(seen?.get('authorization')).toBeNull();
    expect(seen?.get('cookie')).toBeNull();
    expect(seen?.get('x-api-key')).toBeNull();
    expect(seen?.get('x-sonic-key')).toBeNull();
    expect(seen?.get('x-cfsolara-key')).toBeNull();
    expect(seen?.get('x-sonic-engine-key')).toBeNull();
    expect(seen?.get('x-sonic-anon-id')).toBeNull();
    expect(seen?.get('x-sonic-context')).toBeNull();
    expect(seen?.get('x-sonic-personalization')).toBeNull();
    expect(seen?.get('x-sonic-client-ip')).toBeNull();
    expect(seen?.get('range')).toBe('bytes=0-1023');
    expect(seen?.get('user-agent')).toBe('Sonic-Test');
  });
});

describe('safeFetch: DNS and redirect boundaries', () => {
  it('re-resolves and validates every redirect hop', async () => {
    const resolved: string[] = [];
    setSafeFetchHostResolver(async (hostname) => {
      resolved.push(hostname);
      return hostname === 'cdn.music.com' ? ['93.184.216.34'] : ['10.0.0.5'];
    });
    vi.stubGlobal('fetch', async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.music.com/private' },
      }),
    );

    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ALLOWED }),
    ).rejects.toThrow('forbidden address');
    expect(resolved).toEqual(['cdn.music.com', 'evil.music.com']);
  });

  it('rejects a redirect to a host outside the allowlist', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.org/steal' },
      }),
    );
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ALLOWED }),
    ).rejects.toThrow('not in allowed domain whitelist');
  });

  it('stops redirect loops at the configured limit', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.music.com/loop.mp3' },
      });
    });
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, {
        allowedDomains: ALLOWED,
        maxRedirects: 2,
      }),
    ).rejects.toThrow('Too many redirects');
    expect(calls).toBe(3);
  });

  it('rejects HTTPS to HTTP protocol downgrade on redirects', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://cdn.music.com/downgraded.mp3' },
      }),
    );
    await expect(
      safeFetch('https://cdn.music.com/a.mp3', undefined, { allowedDomains: ALLOWED }),
    ).rejects.toThrow('Protocol downgrade');
  });

  it('aborts when the upstream does not respond before the deadline', async () => {
    vi.stubGlobal('fetch', (_input: any, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) return reject(new Error('missing signal'));
        if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    });

    await expect(
      safeFetch('https://cdn.music.com/slow.mp3', undefined, {
        allowedDomains: ALLOWED,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts a response body that stalls after headers', async () => {
    const stalled = new ReadableStream({
      start() {
        // Never enqueue and never close.
      },
    });
    vi.stubGlobal('fetch', async () =>
      new Response(stalled, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    );

    const res = await safeFetch('https://cdn.music.com/stall.mp3', undefined, {
      allowedDomains: ALLOWED,
      maxBytes: 1024,
      bodyIdleTimeoutMs: 25,
    });
    await expect(res.text()).rejects.toThrow('idle timeout');
  });
});

describe('SSRF: provider allowlist boundaries', () => {
  const check = (url: string) =>
    validateSafeUrl(url, { allowHttp: false, allowedDomains: SONIC_ALLOWED_MUSIC_DOMAINS });

  it('accepts the music CDN hosts actually used by the gateway', () => {
    expect(check('https://ws.stream.qqmusic.qq.com/a.mp3').valid).toBe(true);
    expect(check('https://y.qq.com/a.mp3').valid).toBe(true);
    expect(check('https://p1.music.126.net/a.jpg').valid).toBe(true);
    expect(check('https://interface3.music.163.com/api').valid).toBe(true);
  });

  it('does not widen to unrelated apex-domain services', () => {
    expect(check('https://mail.qq.com/').valid).toBe(false);
    expect(check('https://mail.163.com/').valid).toBe(false);
    expect(check('https://evil.qq.com.example.org/').valid).toBe(false);
  });
});

describe('SSRF: physical stream probes use the shared safeFetch policy', () => {
  it('rejects a metadata-service URL without issuing an outbound request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeStreamPhysicalQuality(
      'https://169.254.169.254/latest/meta-data',
      'https://y.qq.com/',
      100,
      200,
      320,
    );
    expect(result).toEqual({ streamType: 'unavailable', totalBytes: 0, ratio: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a provider redirect to a private address instead of following it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/internal.mp3' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await probeStreamPhysicalQuality(
      'https://ws.stream.qqmusic.qq.com/a.mp3',
      'https://y.qq.com/',
      100,
      200,
      320,
    );
    expect(result).toEqual({ streamType: 'unavailable', totalBytes: 0, ratio: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Provider redirect hardening', () => {
  it('follows an allowed cross-origin provider redirect but strips cookies', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), headers });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://m701.music.126.net/redirected' },
        });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const response = await fetchProviderUrl('https://music.163.com/api', {
      headers: { Cookie: 'MUSIC_U=secret', 'X-Real-IP': '1.2.3.4' },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('cookie')).toBe('MUSIC_U=secret');
    expect(calls[1].headers.get('cookie')).toBeNull();
    expect(calls[1].headers.get('x-real-ip')).toBeNull();
  });

  it('keeps cookies on a same-origin redirect', async () => {
    const calls: Array<{ headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        return new Response(null, { status: 307, headers: { location: '/next' } });
      }
      return new Response('ok', { status: 200 });
    }));
    await fetchProviderUrl('https://music.163.com/a', { headers: { Cookie: 'sid=1' } });
    expect(calls[1].headers.get('cookie')).toBe('sid=1');
  });

  it('rejects external and downgrade redirect targets', async () => {
    for (const location of ['https://evil.example/path', 'http://127.0.0.1/internal', 'https://169.254.169.254/latest']) {
      const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(fetchProviderUrl('https://music.163.com/api')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('caps the redirect chain', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: `/hop-${++n}` },
    })));
    await expect(fetchProviderUrl('https://music.163.com/start')).rejects.toThrow('Too many provider redirects');
    expect(n).toBe(4);
  });
});

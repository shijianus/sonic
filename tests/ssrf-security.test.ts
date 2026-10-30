import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isBlockedSsrfHost,
  resetSafeFetchStateForTest,
  safeFetch,
  setSafeFetchHostResolver,
  SONIC_ALLOWED_MUSIC_DOMAINS,
  validateSafeUrl,
} from '../functions/_lib/sonic/security';

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

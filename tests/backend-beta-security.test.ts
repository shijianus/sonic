import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../functions/_lib/types';
import { getSonicConfig } from '../functions/_lib/sonic/config';
import { evaluateContentFlags, getAllowedMediaDomains, isSourceEnabledByPolicy } from '../functions/_lib/sonic/licensing';
import {
  checkEngineAccess,
  hasSensitiveMediaQuery,
  normalizeEnginePathname,
  resetRateLimitsForTest,
  resetSafeFetchStateForTest,
  safeFetch,
  validateSafeUrl,
} from '../functions/_lib/sonic/security';
import { onRequest as stream } from '../functions/api/music/stream';
import { onRequest as forward } from '../functions/api/sonic/forward';
import { onRequest as proxy } from '../functions/proxy';
import { onRequest as palette } from '../functions/palette';
import { onRequest as cover } from '../functions/api/music/cover';
import { onRequest as testAudio } from '../functions/api/sonic/test-audio';

const SECRET = 'engine_secret_at_least_32_characters_long';
const MEDIA = 'https://m701.music.126.net/a.mp3';
const OPTIONS = { allowedDomains: ['music.126.net'], bodyIdleTimeoutMs: 1000 };
const responses: Response[] = [];
const request = (path: string, init?: RequestInit) => new Request(`https://sonic.example.org${path}`, init);
const remember = (response: Response) => { responses.push(response); return response; };
const audio = (headers: HeadersInit = {}) => new Response('audio', {
  headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=600', ...Object.fromEntries(new Headers(headers)) },
});

beforeEach(() => {
  resetRateLimitsForTest();
  resetSafeFetchStateForTest();
});
afterEach(async () => {
  await Promise.all(responses.splice(0).map((r) => r.body?.cancel().catch(() => {})));
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSafeFetchStateForTest();
});

describe('public beta: equivalent engine paths have one authentication boundary', () => {
  it.each(['/proxy', '/palette', '/api/music/palette', '/api/sonic/forward', '/api'])('%s authenticates every trailing-slash spelling', (path) => {
    for (const suffix of ['', '/', '///']) {
      const raw = `${path}${suffix}`;
      expect(normalizeEnginePathname(raw)).toBe(path);
      for (const env of [
        { SONIC_RUNTIME: 'linux-engine', SONIC_ENGINE_SECRET: SECRET },
        { SONIC_REQUIRE_ENGINE_AUTH: '1', SONIC_ENGINE_SECRET: SECRET },
      ]) {
        expect(checkEngineAccess(request(raw), env)?.status).toBe(401);
        expect(checkEngineAccess(request(raw, { headers: { 'X-Sonic-Engine-Key': SECRET } }), env)).toBeNull();
      }
    }
  });
  it('handlers deny slash aliases before fetching and still accept the key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = { SONIC_RUNTIME: 'linux-engine', SONIC_ENGINE_SECRET: SECRET };
    for (const [handler, path] of [[proxy, '/proxy///'], [palette, '/palette/'], [palette, '/api/music/palette///']] as const) {
      expect((await handler({ request: request(path), env })).status).toBe(401);
      const allowed = await handler({ request: request(path, { headers: { 'X-Sonic-Engine-Key': SECRET } }), env });
      expect(allowed.status).toBe(400); // Missing input, not missing service credentials.
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('public beta: actual capability allowlists', () => {
  it.each([undefined, 'audio', 'cover', 'lyrics', 'catalog'] as const)('does not allow vendor apex services for capability %s', (capability) => {
    for (const env of [{}, { SONIC_CONTENT_POLICY: 'strict-allowlist', SONIC_ALLOWED_SOURCES: 'gdstudio' }]) {
      const allowedDomains = getAllowedMediaDomains(env, capability);
      expect(allowedDomains.length).toBeGreaterThan(0);
      for (const host of ['qq.com', 'mail.qq.com', '163.com', 'mail.163.com', '126.net', 'mail.126.net', 'evil.qq.com.example.org']) {
        expect(validateSafeUrl(`https://${host}/`, { allowedDomains }).valid, host).toBe(false);
      }
    }
  });
  it('preserves required audio, MV, cover and lyrics hosts while separating capabilities', () => {
    const allowed = (url: string, capability: 'audio' | 'cover' | 'lyrics') => validateSafeUrl(url, { allowedDomains: getAllowedMediaDomains({}, capability) }).valid;
    expect(allowed(MEDIA, 'audio')).toBe(true);
    expect(allowed('https://ws.stream.qqmusic.qq.com/a.mp3', 'audio')).toBe(true);
    expect(allowed('https://vodkgeyttp8.vod.126.net/cloudmusic/a.mp4', 'audio')).toBe(true);
    expect(allowed('https://p1.music.126.net/a.jpg', 'cover')).toBe(true);
    expect(allowed('https://y.gtimg.cn/music/photo_new/a.jpg', 'cover')).toBe(true);
    expect(allowed('https://api.amll.dev/a.ttml', 'lyrics')).toBe(true);
    expect(allowed('https://lrclib.net/api/get', 'audio')).toBe(false);
    expect(allowed('https://y.qq.com/', 'cover')).toBe(false);
    expect(getAllowedMediaDomains({ SONIC_CONTENT_POLICY: 'strict-allowlist' })).toEqual([]);
  });
  it('blocks unrelated vendor domains before external forwarding', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const host of ['mail.qq.com', 'mail.163.com', 'mail.126.net']) {
      const r = await forward({ request: request(`/api/sonic/forward?url=${encodeURIComponent(`https://${host}/`)}`), env: {} });
      expect(r.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('public beta: signed URLs across redirects', () => {
  it.each(['auth_key', 'vkey', 'auth', 'vuutv', 'dis_k', 'accesskey', 'access_token', 'x-amz-signature'])('detects decoded and mixed-case %s parameter names', (name) => {
    const encoded = [...name.toUpperCase()].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
    expect(hasSensitiveMediaQuery(new URL(`${MEDIA}?${name}=secret`))).toBe(true);
    expect(hasSensitiveMediaQuery(new URL(`${MEDIA}?${encoded}=secret`))).toBe(true);
  });
  it('preserves Response API and exposes opt-in final target with cumulative sensitivity only in memory', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/signed?%61uth_key=secret' } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/public.mp3' } }))
      .mockResolvedValueOnce(audio());
    vi.stubGlobal('fetch', fetchSpy);
    const response = remember(await safeFetch(MEDIA, undefined, { ...OPTIONS, includeMetadata: true }));
    expect(response).toBeInstanceOf(Response);
    expect((response as any).finalUrl.href).toBe('https://m701.music.126.net/public.mp3');
    expect((response as any).sensitive).toBe(true);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(JSON.stringify([...response.headers])).not.toContain('secret');
    expect(await response.text()).toBe('audio');
  });
  it.each([stream, forward])('never public-caches a final signed hop', async (handler) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/a.mp3?%64is_k=private-signature' } }))
      .mockResolvedValueOnce(audio()));
    const r = remember(await handler({ request: request(`/api/music/stream?url=${encodeURIComponent(MEDIA)}`), env: {} }));
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r.headers.get('Location')).toBeNull();
    expect(await r.text()).toBe('audio');
  });
  it('redirect mode proxies instead of exposing a final signed Location', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/a.mp3?%76uutv=secret' } }))
      .mockResolvedValueOnce(audio()));
    const r = remember(await stream({ request: request(`/api/music/stream?mode=redirect&url=${encodeURIComponent(MEDIA)}`), env: {} }));
    expect(r.status).toBe(200);
    expect(r.headers.get('Location')).toBeNull();
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('unsigned CORS-safe redirect mode still works after validating the complete chain', async () => {
    vi.stubGlobal('fetch', async () => audio());
    const r = await stream({ request: request(`/api/music/stream?mode=redirect&url=${encodeURIComponent(MEDIA)}`), env: {} });
    expect(r.status).toBe(302);
    expect(r.headers.get('Location')).toBe(MEDIA);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('legacy proxy and cover inherit encoded redirect sensitivity and preserve downstream abort', async () => {
    for (const [handler, path, url, contentType] of [
      [proxy, '/proxy?target=', 'https://sycdn.kuwo.cn/a.mp3', 'audio/mpeg'],
      [cover, '/api/music/cover?url=', 'https://p1.music.126.net/a.jpg', 'image/jpeg'],
    ] as const) {
      const canceled = vi.fn();
      const controller = new AbortController();
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: '/signed?%61uth_key=secret' } }))
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: canceled }), { headers: { 'Content-Type': contentType, 'Cache-Control': 'public' } })));
      const r = remember(await handler({ request: request(`${path}${encodeURIComponent(url)}`, { signal: controller.signal }), env: {} }));
      expect(r.status).toBe(200);
      expect(r.headers.get('Cache-Control')).toBe('private, no-store');
      controller.abort();
      await Promise.resolve();
      expect(canceled).toHaveBeenCalledTimes(1);
    }
  });
});

describe('public beta: independent first-byte and active-body budgets', () => {
  it('retains 64 first-byte slots and rejects the 65th pending fetch', async () => {
    const releases: Array<(r: Response) => void> = [];
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => releases.push(resolve)));
    const pending = Array.from({ length: 64 }, () => safeFetch(MEDIA, undefined, OPTIONS));
    await Promise.resolve();
    await expect(safeFetch(MEDIA, undefined, OPTIONS)).rejects.toThrow('concurrency limit');
    releases.forEach((resolve) => resolve(new Response(null, { status: 204 })));
    await Promise.all(pending);
  });
  it('bounds 65 unfinished bodies even after headers finish; cancellation frees exactly one slot', async () => {
    const canceled = vi.fn();
    const fetchSpy = vi.fn(async () => new Response(new ReadableStream({ cancel: canceled })));
    vi.stubGlobal('fetch', fetchSpy);
    const held = await Promise.all(Array.from({ length: 64 }, async () => remember(await safeFetch(MEDIA, undefined, OPTIONS))));
    await expect(safeFetch(MEDIA, undefined, OPTIONS)).rejects.toThrow('body concurrency limit');
    await held[0].body!.cancel();
    const next = remember(await safeFetch(MEDIA, undefined, OPTIONS));
    expect(next.status).toBe(200);
    await expect(safeFetch(MEDIA, undefined, OPTIONS)).rejects.toThrow('body concurrency limit');
    expect(canceled).toHaveBeenCalled();
  });
  it('completion, body error and oversized responses release slots rather than leaking across requests', async () => {
    vi.stubGlobal('fetch', async () => audio());
    for (let i = 0; i < 70; i++) expect(await (await safeFetch(MEDIA, undefined, OPTIONS)).text()).toBe('audio');
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.error(new Error('broken')); } })));
    for (let i = 0; i < 70; i++) await expect((await safeFetch(MEDIA, undefined, OPTIONS)).text()).rejects.toThrow('broken');
    vi.stubGlobal('fetch', async () => new Response('xx', { headers: { 'Content-Length': '2' } }));
    for (let i = 0; i < 70; i++) await expect(safeFetch(MEDIA, undefined, { ...OPTIONS, maxBytes: 1 })).rejects.toThrow('exceeds');
    vi.stubGlobal('fetch', async () => audio());
    expect(await (await safeFetch(MEDIA, undefined, OPTIONS)).text()).toBe('audio');
  });
  it('HEAD and null bodies do not consume body slots, including an unexpected HEAD body', async () => {
    const canceled = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel: canceled })));
    for (let i = 0; i < 70; i++) {
      const r = await safeFetch(MEDIA, { method: 'HEAD' }, OPTIONS);
      expect(r.body).toBeNull();
    }
    expect(canceled).toHaveBeenCalledTimes(70);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    for (let i = 0; i < 70; i++) expect((await safeFetch(MEDIA, undefined, OPTIONS)).status).toBe(204);
  });
  it('an abort after headers cancels upstream, errors downstream, and releases the budget', async () => {
    const canceled = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ cancel: canceled })));
    for (let i = 0; i < 70; i++) {
      const controller = new AbortController();
      const r = await safeFetch(MEDIA, { signal: controller.signal }, OPTIONS);
      const reading = r.text();
      controller.abort();
      await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(canceled).toHaveBeenCalledTimes(70);
  });
  it('maxBytes=0 does not disable activity bounds or idle cleanup for unread bodies', async () => {
    vi.useFakeTimers();
    const canceled = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1)); }, cancel: canceled })));
    const held = await Promise.all(Array.from({ length: 64 }, () => safeFetch(MEDIA, undefined, { ...OPTIONS, maxBytes: 0, bodyIdleTimeoutMs: 10 })));
    await expect(safeFetch(MEDIA, undefined, { ...OPTIONS, maxBytes: 0 })).rejects.toThrow('body concurrency limit');
    await vi.advanceTimersByTimeAsync(11);
    for (const r of held) await expect(r.text()).rejects.toThrow('idle timeout');
    expect(canceled).toHaveBeenCalledTimes(65); // The refused 65th response is canceled as well.
    vi.stubGlobal('fetch', async () => audio());
    expect(await (await safeFetch(MEDIA, undefined, OPTIONS)).text()).toBe('audio');
  });
  it('stream and forward expose overload as retryable 503 without changing the error envelope', async () => {
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream()));
    await Promise.all(Array.from({ length: 64 }, async () => remember(await safeFetch(MEDIA, undefined, OPTIONS))));
    for (const handler of [stream, forward]) {
      const r = await handler({ request: request(`/api/music/stream?url=${encodeURIComponent(MEDIA)}`), env: {} });
      expect(r.status).toBe(503);
      expect(r.headers.get('Retry-After')).toBeTruthy();
      expect((await r.json() as any).error.code).toBe('UPSTREAM_BUSY');
    }
  });
});

describe('public beta: synthetic source production gate', () => {
  it.each(['default', 'strict-allowlist'])('denies explicit production flags and allowlist in %s mode', async (policy) => {
    const env: AppEnv = { SONIC_ENV: '  PRODUCTION ', SONIC_CONTENT_POLICY: policy, SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1', SONIC_ALLOWED_SOURCES: 'synthetic' };
    expect(evaluateContentFlags(env).enableSynthetic).toBe(false);
    expect(isSourceEnabledByPolicy('synthetic', env)).toBe(false);
    expect(getSonicConfig(env).enableSynthetic).toBe(false);
    for (const id of ['syn-440hz', 'syn-fault-500']) {
      const r = await testAudio({ request: request(`/api/sonic/test-audio?id=${id}`), env });
      expect(r.status).toBe(403);
      expect((await r.json() as any).error.code).toBe('SOURCE_DISABLED_BY_POLICY');
    }
  });
  it('keeps the default closed and explicitly enabled staging test audio functional', async () => {
    expect(getSonicConfig({}).enableSynthetic).toBe(false);
    expect((await testAudio({ request: request('/api/sonic/test-audio?id=syn-440hz'), env: {} })).status).toBe(403);
    const env = { SONIC_ENV: 'staging', SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: '1' };
    const r = await testAudio({ request: request('/api/sonic/test-audio?id=syn-440hz', { headers: { Range: 'bytes=0-43' } }), env });
    expect(r.status).toBe(206);
    expect(new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()).slice(0, 4))).toBe('RIFF');
  });
});

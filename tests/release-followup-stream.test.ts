import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../functions/_lib/types';

const { engineMock } = vi.hoisted(() => ({ engineMock: vi.fn() }));
vi.mock('../functions/_lib/sonic/local-engine', async (original) => ({
  ...await original<typeof import('../functions/_lib/sonic/local-engine')>(),
  callLocalEngineJson: engineMock,
}));

import { buildStreamCacheIdentifier, resolvePlayableStream, type ResolvedStreamInfo } from '../functions/_lib/sonic/native-protocols';
import { clearSonicMemoryCacheForTest, getSonicCachedJson, putSonicCachedJson } from '../functions/_lib/sonic/cache';
import { onRequest as stream } from '../functions/api/music/stream';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';

const env: AppEnv = {
  SONIC_ENV: 'test', SONIC_LOCAL_ENGINE_URL: 'https://engine.invalid',
  SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_ENABLE_FREE_CROSS_MATCH: '0',
  SONIC_ENABLE_GDSTUDIO: '0', SONIC_ENABLE_QQ: '0', SONIC_ENABLE_KUGOU: '0', SONIC_ENABLE_KUWO: '0',
};
const info = (name: string, extra: Partial<ResolvedStreamInfo> = {}): ResolvedStreamInfo => ({
  url: `https://m701.music.126.net/${name}.mp3`, provider: 'local-qq', via: 'local-engine:free-match',
  isTrial: false, streamType: 'full', corsSafe: true, degraded: false, attempts: [],
  resolvedSource: 'qq', resolvedId: 'qq-real-id', resolvedTitle: 'Resolved title', resolvedArtist: 'Resolved artist',
  ...extra,
});
const engineSuccess = (value: ResolvedStreamInfo) => ({ ok: true, data: { ok: true, data: value }, latencyMs: 1, status: 200, circuitState: 'CLOSED' });
const engineFailure = () => ({ ok: false, data: { ok: false }, error: 'unavailable', latencyMs: 1, status: 503, circuitState: 'OPEN', skippedByCircuit: true });
const opts = { id: '1001', source: 'netease', quality: '320', title: 'Track', artist: 'Artist' };
const cacheId = buildStreamCacheIdentifier(opts);
const request = (query = '', init: RequestInit = {}) => new Request(`https://sonic.test/api/music/stream?id=1001&source=netease&title=Track&artist=Artist${query}`, init);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  clearSonicMemoryCacheForTest();
  resetRateLimitsForTest();
  engineMock.mockReset().mockResolvedValue(engineSuccess(info('fresh')));
  vi.stubGlobal('fetch', vi.fn(async (_input, init?: RequestInit) => new Response(init?.method === 'HEAD' ? null : new Uint8Array([1, 2, 3, 4]), {
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '4' },
  })));
});
afterEach(() => {
  clearSonicMemoryCacheForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('release follow-up scoped stream cache retry', () => {
  it('an explicit retry bypasses fresh resolution and replaces its successful provider/ID mapping', async () => {
    engineMock.mockResolvedValueOnce(engineSuccess(info('expired'))).mockResolvedValueOnce(engineSuccess(info('renewed', { resolvedId: 'new-provider-id' })));
    expect((await resolvePlayableStream(opts, env))?.url).toContain('expired');
    expect((await resolvePlayableStream(opts, env))?.url).toContain('expired');
    expect(engineMock).toHaveBeenCalledTimes(1);
    const fresh = await resolvePlayableStream({ ...opts, nocache: true }, env);
    expect(fresh).toMatchObject({ resolvedSource: 'qq', resolvedId: 'new-provider-id' });
    expect(fresh?.url).toContain('renewed');
    expect(engineMock.mock.calls[1][0]).toContain('nocache=1');
    const cached = await resolvePlayableStream(opts, env);
    expect(cached?.url).toContain('renewed');
    expect(cached).toMatchObject({ resolvedSource: 'qq', resolvedId: 'new-provider-id' });
    expect(engineMock).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a stale failed URL when a fresh retry sees an unavailable engine', async () => {
    vi.useFakeTimers();
    await putSonicCachedJson('stream-url-v1', cacheId, info('stale-expired'), 1, 1200, env);
    await vi.advanceTimersByTimeAsync(1001);
    engineMock.mockResolvedValue(engineFailure());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } })));
    const stale = await resolvePlayableStream(opts, env);
    expect(stale?.url).toContain('stale-expired');
    const fresh = await resolvePlayableStream({ ...opts, nocache: true }, env);
    expect(fresh?.url).toBe('');
    expect(fresh?.streamType).toBe('unavailable');
    expect(fresh?.attempts.some(attempt => attempt.via.startsWith('stale-cache:'))).toBe(false);
  });

  it('a failed resolution is not cached as success, and fresh retry recovers the cache', async () => {
    engineMock.mockResolvedValueOnce(engineFailure());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } })));
    const failed = await resolvePlayableStream(opts, env);
    expect(failed?.url).toBe('');
    expect(await getSonicCachedJson('stream-url-v1', cacheId, env)).toBeNull();
    engineMock.mockResolvedValue(engineSuccess(info('recovered')));
    const recovered = await resolvePlayableStream({ ...opts, nocache: true }, env);
    expect(recovered?.url).toContain('recovered');
    expect((await resolvePlayableStream(opts, env))?.url).toBe(recovered?.url);
    expect(engineMock).toHaveBeenCalledTimes(2);
  });

  it.each(['&nocache=0', '&nocache=', '&nocache=true', '&retry=1&ts=123', '&_t=123', '&bypass=1'])('does not globally bypass caches for %s', async query => {
    await resolvePlayableStream(opts, env);
    const response = await stream({ request: request(query), env });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(engineMock).toHaveBeenCalledTimes(1);
  });

  it('nocache=1 at the playback endpoint propagates refresh but preserves stream headers and metadata shape', async () => {
    await resolvePlayableStream(opts, env);
    engineMock.mockResolvedValue(engineSuccess(info('endpoint-fresh', { resolvedId: 'fresh-qq-id', streamType: 'trial', isTrial: true, trialDuration: 30 })));
    const response = await stream({ request: request('&nocache=1', { method: 'HEAD' }), env });
    expect(response.status).toBe(200);
    expect(engineMock).toHaveBeenCalledTimes(2);
    expect(response.headers.get('x-sonic-resolved-source')).toBe('qq');
    expect(response.headers.get('x-sonic-resolved-id')).toBe('fresh-qq-id');
    expect(decodeURIComponent(response.headers.get('x-sonic-resolved-title')!)).toBe('Resolved title');
    expect(response.headers.get('x-sonic-stream-type')).toBe('trial');
    expect(response.headers.get('x-sonic-trial-duration')).toBe('30');
    expect(response.headers.get('access-control-expose-headers')).toContain('X-Sonic-Resolved-Id');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });

  it('does not synthesize another provider+original-ID pair from incomplete resolver metadata', async () => {
    engineMock.mockResolvedValue(engineSuccess(info('no-id', { resolvedId: undefined })));
    const response = await stream({ request: request('&nocache=1'), env });
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-sonic-resolved-source')).toBeNull();
    expect(response.headers.get('x-sonic-resolved-id')).toBeNull();
    expect(response.headers.get('x-sonic-provider')).toBe('local-qq');
  });

  it('keeps the existing unavailable error shape after a fresh miss', async () => {
    engineMock.mockResolvedValue(engineFailure());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } })));
    const response = await stream({ request: request('&nocache=1'), env });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-sonic-stream-type')).toBe('unavailable');
    expect(await response.json()).toMatchObject({
      brand: 'Sonic', error: { code: 'STREAM_NOT_FOUND', message: '当前曲目暂无可用音源或受版权限制' },
      meta: { cached: false, cacheLevel: 'none', provider: 'none', attempts: expect.any(Array) },
    });
  });
});

describe('release follow-up retry cancellation', () => {
  it('caller cancellation prevents fallback, cache writes and fabricated endpoint failures', async () => {
    const parent = new AbortController();
    const entered = deferred<AbortSignal>();
    engineMock.mockImplementation((_path, _env, options) => new Promise((_resolve, reject) => {
      entered.resolve(options.signal);
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const pending = stream({ request: request('&nocache=1', { signal: parent.signal }), env });
    const signal = await entered.promise;
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await assertion;
    expect(signal.aborted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(await getSonicCachedJson('stream-url-v1', cacheId, env)).toBeNull();
  });

  it('ignores an older cancelled success so it cannot overwrite the newer fresh result', async () => {
    const parent = new AbortController();
    const old = deferred<any>();
    engineMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(engineSuccess(info('current')));
    const first = resolvePlayableStream({ ...opts, nocache: true, signal: parent.signal }, env);
    await vi.waitFor(() => expect(engineMock).toHaveBeenCalledTimes(1));
    parent.abort();
    await resolvePlayableStream({ ...opts, nocache: true }, env);
    const assertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    old.resolve(engineSuccess(info('late-old')));
    await assertion;
    expect((await resolvePlayableStream(opts, env))?.url).toContain('current');
    expect(engineMock).toHaveBeenCalledTimes(2);
  });

  it('native provider retry propagates caller cancellation and starts no external fallback', async () => {
    const parent = new AbortController();
    const entered = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal!;
      entered.resolve(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const pending = resolvePlayableStream({ ...opts, nocache: true, signal: parent.signal }, { ...env, SONIC_ENABLE_LOCAL_ENGINE: '0' });
    const signal = await entered.promise;
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await assertion;
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getSonicCachedJson('stream-url-v1', cacheId, env)).toBeNull();
  });
});

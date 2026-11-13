import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { createDecipheriv } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { toWebRequest } from '../server/request-adapter';
import { createSonicServer, drainSonicServer, shutdownSonicServer, withRecommendStartupLock } from '../server/index';
import { createServerRecommendStore } from '../server/recommend-sqlite';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import {
  callLocalEngineJson, callLocalEngineStream, getLocalEngineCircuitSnapshot,
  resetLocalEngineCircuitForTest, fetchWithRuntimeBudget,
} from '../functions/_lib/sonic/local-engine';
import { resolvePlayableStream, callNeteaseLinuxApi } from '../functions/_lib/sonic/native-protocols';
import { handleUpstreamEndpoint } from '../functions/_lib/sonic/upstream';
import {
  putSonicCachedJson, getSonicCachedJson, getSonicMemoryCacheStats,
  clearSonicMemoryCacheForTest, withSonicJsonSingleFlight,
} from '../functions/_lib/sonic/cache';
import { getObservabilitySnapshot, resetObservabilityForTest, getReleaseReadiness } from '../functions/_lib/sonic/observability';
import { onRequest as health } from '../functions/api/sonic/engine/health';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';
import { handleNexusLyricsRequest } from '../functions/api/sonic/lyrics/nexus';
import { handleNexusSearchRequest } from '../functions/_lib/sonic/route-helpers';
import { onRequest as handleSonicForward } from '../functions/api/sonic/forward';
import { neteaseProvider } from '../functions/_lib/sonic/providers/netease';

const key = 'runtime-test-service-key-32-characters-long';
const engineEnv = { SONIC_LOCAL_ENGINE_URL: 'https://engine.example.com', SONIC_ENGINE_SECRET: key, SONIC_CB_FAILURE_THRESHOLD: '1', SONIC_CB_COOLDOWN_MS: '100' };
const cleanup: Array<() => Promise<void> | void> = [];
const realFetch = globalThis.fetch;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return (server.address() as AddressInfo).port;
}
function nodeGet(port: number, requestPath: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath, headers: { 'X-Sonic-Engine-Key': key } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode!, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
beforeEach(() => {
  resetLocalEngineCircuitForTest(); resetObservabilityForTest(); clearSonicMemoryCacheForTest(); resetRateLimitsForTest();
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
  clearSonicMemoryCacheForTest();
});

describe('backend beta request cancellation', () => {
  it('keeps complete IncomingMessage close alive, aborts socket disconnect, and removes listeners after finish', async () => {
    const requests: Request[] = [];
    let raw: http.IncomingMessage;
    const reached = deferred<void>();
    const server = http.createServer((req, res) => {
      raw = req;
      const request = toWebRequest(req, res);
      requests.push(request);
      req.resume();
      req.on('end', () => { reached.resolve(); if (req.url === '/ok') setTimeout(() => res.end('ok'), 25); });
    });
    const port = await listen(server);
    const client = http.get(`http://127.0.0.1:${port}/pending`);
    client.on('error', () => {});
    await reached.promise;
    await wait(20);
    expect(raw!.complete).toBe(true);
    expect(requests[0].signal.aborted).toBe(false);
    client.destroy();
    await vi.waitFor(() => expect(requests[0].signal.aborted).toBe(true));
    expect(raw!.listenerCount('aborted')).toBe(0);
    await nodeGet(port, '/ok');
    expect(requests[1].signal.aborted).toBe(false);
    expect(raw!.listenerCount('aborted')).toBe(0);
  });

  it('cancels native provider resolution before response headers on a real HTTP client disconnect', async () => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const fetchMock = vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      started.resolve(signal);
      signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const server = createSonicServer(os.tmpdir(), { SONIC_ENV: 'test', SONIC_ENGINE_SECRET: key, SONIC_RECOMMEND_DB_PATH: 'memory', RECOMMEND_STORE: new MemoryRecommendStore(), SONIC_ENABLE_GDSTUDIO: '0' });
    const port = await listen(server);
    const client = http.get({ host: '127.0.0.1', port, path: '/api/sonic/resolve/stream?id=123&source=netease&nocache=1', headers: { 'X-Sonic-Engine-Key': key } });
    client.on('error', () => {});
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    client.destroy();
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    await wait(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['search', 'lyrics'])('cancels real HTTP nexus %s work through the adapter and legacy fallback boundaries', async (kind) => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const fetchMock = vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started.resolve(init.signal!);
      init.signal!.addEventListener('abort', () => { aborted.resolve(); reject(init.signal!.reason); }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const server = createSonicServer(os.tmpdir(), {
      SONIC_ENV: 'test', SONIC_ENGINE_SECRET: key, SONIC_RECOMMEND_DB_PATH: 'memory', RECOMMEND_STORE: new MemoryRecommendStore(),
      SONIC_ENABLE_NETEASE: kind === 'search' ? '1' : '0', SONIC_ENABLE_KUGOU: kind === 'lyrics' ? '1' : '0',
      SONIC_ENABLE_QQ: '0', SONIC_ENABLE_GDSTUDIO: '0', SONIC_ENABLE_AMLL: '0', SONIC_ENABLE_LRCLIB: '0', SONIC_ENABLE_LYRIVA: '0',
    });
    const port = await listen(server);
    const requestPath = kind === 'search' ? '/api/sonic/search/nexus?q=runtime-disconnect&nocache=1' : '/api/sonic/lyrics/nexus?title=runtime-disconnect&artist=runtime&nocache=1';
    const client = http.get({ host: '127.0.0.1', port, path: requestPath, headers: { 'X-Sonic-Engine-Key': key } });
    client.on('error', () => {});
    const signal = await started.promise;
    client.destroy();
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    await wait(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('combines a provider deadline with a caller signal and does not launch fallback after cancellation', async () => {
    const parent = new AbortController();
    const started = deferred<void>();
    const fetchMock = vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started.resolve();
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = resolvePlayableStream({ id: '123', source: 'netease', signal: parent.signal, nocache: true }, { SONIC_ENABLE_GDSTUDIO: '0' });
    await started.promise;
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);

    const timeout = callNeteaseLinuxApi({ url: 'test' }, { SONIC_TIMEOUT_MS: '500' }, new AbortController().signal);
    await expect(timeout).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('backend beta lyrics timeout contract', () => {
  it.each([false, true])('returns HTTP 200 with prior lyrics=%s after the total budget expires and starts no fallback', async (withPriorLyrics) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const env = {
      SONIC_ENV: 'test', SONIC_TIMEOUT_MS: '500', SONIC_ENABLE_AMLL: '1',
      SONIC_ENABLE_KUGOU: '1', SONIC_ENABLE_LRCLIB: '1', SONIC_ENABLE_LYRIVA: '1',
      SONIC_ENABLE_GDSTUDIO: '0', RECOMMEND_STORE: new MemoryRecommendStore(),
    };
    if (withPriorLyrics) {
      vi.spyOn(neteaseProvider, 'getLyrics').mockResolvedValue({
        provider: 'netease', matchLevel: 'MEDIUM', matchScore: 60, qualityScore: 50,
        data: {
          provider: 'netease', level: 'word', sourceQuality: 'interpolated',
          track: { title: 'runtime-timeout', artist: 'runtime', album: '' },
          plainLyrics: 'Keep this lyric', syncedLyrics: [{ text: 'Keep this lyric', startMs: 0, durationMs: 3000, words: [] }],
          rawTtml: '', ttmlMetadata: {}, instrumental: false, sourceId: '123', sourceUrl: '',
        },
      });
    }
    let providerSignal!: AbortSignal;
    const fetchMock = vi.fn((_input: any, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      providerSignal = init.signal!;
      providerSignal.addEventListener('abort', () => reject(providerSignal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const endpoint = withPriorLyrics
      ? 'https://sonic.test/api/sonic/lyrics/nexus?title=runtime-timeout&artist=runtime&platform=netease&platformId=123&nocache=1'
      : 'https://sonic.test/api/sonic/lyrics/nexus?title=runtime-timeout&artist=runtime&nocache=1';
    const request = new Request(endpoint, { signal: parent.signal });
    const pending = handleNexusLyricsRequest(request, env);
    await vi.advanceTimersByTimeAsync(501);
    const response = await pending;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.level).toBe(withPriorLyrics ? 'word' : 'none');
    expect(body.data.plainLyrics).toBe(withPriorLyrics ? 'Keep this lyric' : '');
    expect(body.data.syncedLyrics).toHaveLength(withPriorLyrics ? 1 : 0);
    expect(body.meta.attempts.some((attempt: any) => attempt.ok === false && /timeout/i.test(attempt.error || ''))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerSignal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(getEventListeners(request.signal, 'abort')).toHaveLength(0);
    if (withPriorLyrics) expect(body.data.syncedLyrics[0].words.length).toBeGreaterThan(0);
  });
});

describe('Nexus search deadlines', () => {
  const env = { SONIC_ENV: 'test', SONIC_TIMEOUT_MS: '500', SONIC_ENABLE_GDSTUDIO: '0' };
  const request = (signal?: AbortSignal) => new Request('https://sonic.test/api/sonic/search/nexus?q=deadline-test', { signal });

  beforeEach(async () => {
    await import('../functions/_lib/sonic/nexus-search');
    vi.useFakeTimers();
  });

  it.each(['nexus', 'forward'])('%s records each upstream timeout even before the search budget expires', async route => {
    const fetchMock = vi.fn((input: string) => {
      const url = new URL(input);
      if (url.hostname === 'u.y.qq.com' || url.pathname.endsWith('/client_search_cp')) return Promise.resolve(Response.json({}));
      return new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new DOMException('provider transport deadline', 'TimeoutError')), 499);
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = route === 'nexus' ? handleNexusSearchRequest(request(), env) :
      handleSonicForward({ request: new Request('https://sonic.test/api/sonic/forward?q=deadline-test'), env });
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;
    const { data, meta } = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data.tracks).toEqual([]);
    expect(meta.attempts.map(({ provider, ok, errorCode }: any) => [provider, ok, errorCode])).toEqual([
      ['netease', false, 'UPSTREAM_TIMEOUT'], ['qq', false, 'UPSTREAM_TIMEOUT'], ['kugou', false, 'UPSTREAM_TIMEOUT'],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a completed provider when other bodies stall and does not cache the incomplete search', async () => {
    const cancelled = vi.fn();
    const fetchMock = vi.fn(async (input: string) => {
      if (new URL(input).hostname === 'c.y.qq.com') {
        return Response.json({ data: { song: { list: [{ songmid: 'quick-qq', songname: 'Quick', singer: [] }] } } });
      }
      return new Response(new ReadableStream({ cancel: cancelled }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const settled = vi.fn();
    const pending = handleNexusSearchRequest(request(), env).then(response => { settled(); return response; });
    await vi.advanceTimersByTimeAsync(500);
    expect(cancelled).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    const response = await pending;
    const { data, meta } = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(data.tracks.map((track: any) => track.platformId)).toEqual(['quick-qq']);
    expect(meta.attempts.map(({ provider, ok, errorCode }: any) => [provider, ok, errorCode])).toEqual([
      ['netease', false, 'UPSTREAM_TIMEOUT'], ['qq', true, undefined], ['kugou', false, 'UPSTREAM_TIMEOUT'],
    ]);
    const retried = handleNexusSearchRequest(request(), env);
    await vi.advanceTimersByTimeAsync(500);
    await retried;
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('cancels outstanding provider bodies on client disconnect', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }))));
    const parent = new AbortController();
    const pending = handleNexusSearchRequest(request(parent.signal), env);
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    expect(cancelled).toHaveBeenCalledTimes(3);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('records an Engine timeout at the total deadline without launching direct providers', async () => {
    const fetchMock = vi.fn(async () => new Response(new ReadableStream()));
    vi.stubGlobal('fetch', fetchMock);
    const pending = handleNexusSearchRequest(request(), { ...env, ...engineEnv, SONIC_ENGINE_TIMEOUT_MS: '500' });
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).meta.attempts).toMatchObject([{ provider: 'local-engine', ok: false, errorCode: 'UPSTREAM_TIMEOUT' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('backend beta circuit generations and body lifecycle', () => {
  it.each(['json', 'stream'])('does not let an older %s success close a newer OPEN generation', async (kind) => {
    const older = deferred<Response>();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => ++calls === 1 ? older.promise : Promise.resolve(new Response('outage', { status: 530 }))));
    const pending = kind === 'json' ? callLocalEngineJson('/a', engineEnv) : callLocalEngineStream('/a', engineEnv);
    await callLocalEngineJson('/b', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('OPEN');
    older.resolve(new Response(kind === 'json' ? '{"ok":true}' : 'audio'));
    const result = await pending;
    if ('response' in result) await result.response!.text();
    expect(result.ok).toBe(true);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('OPEN');
  });

  it('permits only the current half-open probe to recover after body EOF', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 530 })));
    await callLocalEngineJson('/fail', engineEnv);
    await vi.advanceTimersByTimeAsync(101);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } })));
    vi.stubGlobal('fetch', fetchMock);
    const probe = await callLocalEngineStream('/probe', engineEnv);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('HALF_OPEN');
    expect((await callLocalEngineJson('/blocked', engineEnv)).skippedByCircuit).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const read = probe.response!.text();
    controller.enqueue(new TextEncoder().encode('audio')); controller.close();
    await read;
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('CLOSED');
    expect(getObservabilitySnapshot().stream.body.engine).toMatchObject({ started: 1, completed: 1, active: 0 });
  });

  it('does not count a client AbortError as a failure and releases a cancelled half-open probe', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 530 })));
    await callLocalEngineJson('/fail', engineEnv);
    await vi.advanceTimersByTimeAsync(101);
    const parent = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const result = callLocalEngineJson('/probe', engineEnv, { request: new Request('https://client.test', { signal: parent.signal }) });
    parent.abort();
    expect((await result).error).toContain('cancelled');
    expect(getLocalEngineCircuitSnapshot(engineEnv).consecutiveFailures).toBe(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    expect((await callLocalEngineJson('/next', engineEnv)).ok).toBe(true);
    expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('CLOSED');
  });

  it('lets a healthy stream pass the former 8s cutoff and counts success only at EOF', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }))));
    const stream = await callLocalEngineStream('/audio', engineEnv);
    const reader = stream.response!.body!.getReader();
    const chunk = reader.read(); controller.enqueue(new Uint8Array([1])); await chunk;
    expect(getObservabilitySnapshot().stream.body.engine.completed).toBe(0);
    await vi.advanceTimersByTimeAsync(9_000);
    const next = reader.read(); controller.enqueue(new Uint8Array([2])); await next;
    controller.close(); await reader.read();
    expect(getObservabilitySnapshot().stream.body.engine).toMatchObject({ completed: 1, timeout: 0, active: 0 });
  });

  it.each(['first-byte', 'idle', 'total', 'body-error', 'cancel'])('settles body once for %s and cleans parent listeners', async (mode) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: cancelled }))));
    const stream = await callLocalEngineStream('/audio', { ...engineEnv, SONIC_STREAM_FIRST_BYTE_TIMEOUT_MS: '20', SONIC_STREAM_IDLE_TIMEOUT_MS: '30', SONIC_STREAM_TOTAL_TIMEOUT_MS: '100' }, { signal: parent.signal });
    const reader = stream.response!.body!.getReader();
    if (mode !== 'first-byte') { const first = reader.read(); controller.enqueue(new Uint8Array([1])); await first; }
    if (mode === 'cancel') { await reader.cancel(); }
    else {
      const reading = reader.read();
      if (mode === 'total') {
        await vi.advanceTimersByTimeAsync(20);
        controller.enqueue(new Uint8Array([2]));
        await reading;
        // No pending pull: idle is paused by downstream backpressure, total is not.
        await vi.advanceTimersByTimeAsync(81);
        await expect(reader.read()).rejects.toMatchObject({ name: 'TimeoutError', message: 'Request total timeout (100ms)' });
      } else {
        const assertion = expect(reading).rejects.toBeDefined();
        if (mode === 'body-error') controller.error(new Error('truncated'));
        else await vi.advanceTimersByTimeAsync(mode === 'idle' ? 31 : 21);
        await assertion;
      }
    }
    const metrics = getObservabilitySnapshot().stream.body.engine;
    expect(metrics.active).toBe(0);
    expect(metrics.completed).toBe(0);
    expect(metrics.cancelled + metrics.error + metrics.timeout).toBe(1);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    if (mode === 'cancel') expect(getLocalEngineCircuitSnapshot(engineEnv).consecutiveFailures).toBe(0);
    else expect(getLocalEngineCircuitSnapshot(engineEnv).state).toBe('OPEN');
  });

  it('enforces JSON timeout during the body even after response headers arrived', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream())));
    const pending = callLocalEngineJson('/slow', engineEnv, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).error).toContain('timeout');
  });
});

describe('backend beta bounded cache and singleflight', () => {
  it('accounts UTF-8 and resident strings, evicts LRU, and removes replaced large entries', async () => {
    const env = { SONIC_CACHE_MAX_BYTES: '1100' };
    await putSonicCachedJson('beta', 'a', '汉'.repeat(80), 30, 30, env);
    await putSonicCachedJson('beta', 'b', '汉'.repeat(80), 30, 30, env);
    await getSonicCachedJson('beta', 'a', env);
    await putSonicCachedJson('beta', 'c', '汉'.repeat(80), 30, 30, env);
    expect(getSonicMemoryCacheStats().bytes).toBeLessThanOrEqual(1100);
    expect(await getSonicCachedJson('beta', 'b', env)).toBeNull();
    await putSonicCachedJson('beta', 'a', 'x'.repeat(600_000), 30, 30, env);
    expect(await getSonicCachedJson('beta', 'a', env)).toBeNull();
    clearSonicMemoryCacheForTest();
    expect(getSonicMemoryCacheStats().bytes).toBe(0);
  });

  it('coalesces callers, isolates subscriber cancellation, and aborts upstream when the last caller leaves', async () => {
    const value = deferred<number>();
    let signal!: AbortSignal;
    const load = vi.fn((s: AbortSignal) => { signal = s; return value.promise; });
    const parent = new AbortController();
    const a = withSonicJsonSingleFlight('shared', load, parent.signal);
    const b = withSonicJsonSingleFlight('shared', load);
    await Promise.resolve();
    const assertion = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort(); await assertion;
    expect(signal.aborted).toBe(false);
    value.resolve(7); expect(await b).toBe(7); expect(load).toHaveBeenCalledTimes(1);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    const last = new AbortController();
    const c = withSonicJsonSingleFlight('last', (s) => { signal = s; return new Promise(() => {}); }, last.signal);
    await Promise.resolve(); const cancelled = expect(c).rejects.toBeDefined(); last.abort(); await cancelled;
    expect(signal.aborted).toBe(true); expect(getSonicMemoryCacheStats().inFlight).toBe(0);
  });

  it('coalesces a real hotspot in commercial upstream JSON calls', async () => {
    const payload = deferred<Response>();
    const fetchMock = vi.fn(() => payload.promise);
    vi.stubGlobal('fetch', fetchMock);
    const url = new URL('https://sonic.test/api/banner');
    const a = handleUpstreamEndpoint('banner', url, new Request(url), {});
    const b = handleUpstreamEndpoint('banner', url, new Request(url), {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    payload.resolve(new Response('{"banners":[]}'));
    expect((await a).status).toBe(200); expect((await b).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  { endpoint: 'top/song', field: 'data', provider: 'https://music.163.com/api/v1/discovery/new/songs' },
  { endpoint: 'toplist', field: 'list', provider: 'https://music.163.com/api/toplist/detail' },
])('chart catalog response for $endpoint', ({ endpoint, field, provider }) => {
  const url = new URL(`https://sonic.test/api/${endpoint}`);
  const request = () => handleUpstreamEndpoint(endpoint, url, new Request(url), { SONIC_ENV: 'test', SONIC_ENABLE_LOCAL_ENGINE: '0' });

  it.each([
    { label: 'empty', list: [] },
    { label: 'populated', list: [{ id: 42, name: 'Chart item' }] },
  ])('preserves valid $label results', async ({ list }) => {
    const fetchMock = vi.fn(async () => Response.json({ code: 200, [field]: list }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await request();
    expect(fetchMock).toHaveBeenCalledWith(provider, expect.anything());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 200, brand: 'Sonic', [field]: list });
  });

  it.each(['network', 'http', 'invalid-json', 'missing-list', 'provider-code'])('returns a retryable failure for %s', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('fixture provider offline');
      if (failure === 'http') return Response.json({ [field]: [] }, { status: 429 });
      if (failure === 'invalid-json') return new Response('invalid JSON');
      if (failure === 'missing-list') return Response.json({ code: 200 });
      return Response.json({ code: 500, [field]: [] });
    }));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toMatchObject({ code: 503, error: { code: 'CHART_UPSTREAM_UNAVAILABLE' } });
  });
});

describe('new-song regions', () => {
  const providerUrl = 'https://music.163.com/weapi/v1/discovery/new/songs';
  const defaultUrl = 'https://music.163.com/api/v1/discovery/new/songs';
  const sidecarEnv = { SONIC_NCM_API_URL: 'http://ncm:3000', SONIC_REAL_IP: '203.0.113.10' };
  const request = (search: string, env = {}, endpoint = 'top/song') => {
    const url = new URL(`https://sonic.test/api/${endpoint}${search}`);
    return handleUpstreamEndpoint(endpoint, url, new Request(url), { SONIC_ENV: 'test', SONIC_ENABLE_LOCAL_ENGINE: '0', ...env });
  };

  it.each([7, 96, 8, 16])('encodes region %i in the direct WEAPI request', async (areaId) => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      if (array instanceof Uint8Array) array.set(Array.from({ length: 16 }, (_, i) => i));
      return array;
    });
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => Response.json({ data: [{ id: areaId, dt: 180000 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await request(`?type=${areaId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: areaId, dt: 180000, duration: 180 }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe(providerUrl);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const body = new URLSearchParams(String(init.body));
    // RSA_NO_PADDING output for the reversed fixture key and sidecar 4.41.1's public key.
    expect(body.get('encSecKey')).toBe('d15a1683c992095d0c234c19966605c5c5964911268bbeda8cb8d08d834913e59d53b32358903a121b5fca784c1f5ae44951fd02524df58ecc98e52cc7cf8689b42c2e93ddf05b0592512d87f5960467e2f086c018849d76014d323500e30f13ef4cafbb0cf5a66731a3f1776c75ca35d0062dac70a3e33245afabcf47938487');
    const decrypt = (ciphertext: string, key: string) => {
      const decipher = createDecipheriv('aes-128-cbc', key, '0102030405060708');
      return Buffer.concat([decipher.update(ciphertext, 'base64'), decipher.final()]).toString();
    };
    const firstLayer = decrypt(body.get('params')!, 'abcdefghijklmnop');
    expect(JSON.parse(decrypt(firstLayer, '0CoJUm6Qyw8W8jud'))).toEqual({ areaId, total: true, e_r: false, csrf_token: '' });
  });

  it('preserves the region and excludes caller-provided transport options on the sidecar hop', async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ code: 200, data: [{ id: 8, duration: 180 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await request('?type=8&type=16&domain=https%3A%2F%2Funtrusted.test&crypto=api', sidecarEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Sonic-Provider')).toBe('local-netease');
    expect(await response.json()).toMatchObject({ data: [{ id: 8, dt: 180000, duration: 180 }] });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://ncm:3000/top/song?type=8&realIP=203.0.113.10', expect.anything());
  });

  it.each([
    { transport: 'default API', query: '', env: {} },
    { transport: 'regional WEAPI', query: '?type=7', env: {} },
    { transport: 'regional sidecar', query: '?type=7', env: sidecarEnv },
  ])('normalizes song durations from the $transport', async ({ query, env }) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 200, data: [
      { id: 1, duration: 180.5 },
      { id: 2, duration: 180500 },
      { id: 3, dt: 180500 },
      { id: 4, duration: 180, dt: 180500 },
      { id: 5, duration: 3600 },
      { id: 6, dt: 1500 },
      { id: 7 },
    ] })));
    const response = await request(query, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [
      { id: 1, duration: 180.5, dt: 180500 },
      { id: 2, duration: 180.5, dt: 180500 },
      { id: 3, duration: 180.5, dt: 180500 },
      { id: 4, duration: 180.5, dt: 180500 },
      { id: 5, duration: 3600, dt: 3600000, durationMs: 3600000 },
      { id: 6, duration: 1.5, dt: 1500, durationMs: 1500 },
      { id: 7, duration: 0, dt: 0, durationMs: 0 },
    ] });
  });

  it('returns retryable failure when both regional transports fail without substituting default songs', async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({}, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await request('?type=16', sidecarEnv);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'CHART_UPSTREAM_UNAVAILABLE' } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://ncm:3000/top/song?type=16&realIP=203.0.113.10',
      providerUrl,
    ]);
  });

  it('preserves default and personalized requests without invoking a regional transport', async () => {
    const fetchMock = vi.fn(async (_input: string) => Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    for (const [query, endpoint] of [['', 'top/song'], ['?type=0', 'top/song'], ['?type=96', 'personalized/newsong']]) {
      const response = await request(query, sidecarEnv, endpoint);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: [] });
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([defaultUrl, defaultUrl, defaultUrl]);
  });

  it('rejects unsupported region values without requesting any upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await request('?type=7invalid', sidecarEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_CHART_REGION' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chart catalog deadlines', () => {
  it('returns a retryable failure when the provider exhausts the gateway budget', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const url = new URL('https://sonic.test/api/top/song');
    const response = await handleUpstreamEndpoint('top/song', url, new Request(url), { SONIC_ENV: 'test', SONIC_TIMEOUT_MS: '500' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CHART_UPSTREAM_UNAVAILABLE' } });
  });

  it('keeps the shared Engine circuit available after a chart provider failure', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === `${engineEnv.SONIC_LOCAL_ENGINE_URL}/api/top/song`) {
        return Response.json({ brand: 'Sonic', code: 503, error: { code: 'CHART_UPSTREAM_UNAVAILABLE' } }, { status: 503 });
      }
      if (input === `${engineEnv.SONIC_LOCAL_ENGINE_URL}/api/banner`) return Response.json({ code: 200, banners: [] });
      throw new Error('fixture chart provider offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...engineEnv, SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_ENV: 'test' };
    const chartsUrl = new URL('https://sonic.test/api/top/song');
    const chartResponse = await handleUpstreamEndpoint('top/song', chartsUrl, new Request(chartsUrl), env);
    expect(chartResponse.status).toBe(503);
    expect(getLocalEngineCircuitSnapshot(env)).toMatchObject({ state: 'CLOSED', consecutiveFailures: 0 });

    const bannerUrl = new URL('https://sonic.test/api/banner');
    const bannerResponse = await handleUpstreamEndpoint('banner', bannerUrl, new Request(bannerUrl), env);
    expect(bannerResponse.status).toBe(200);
    expect(bannerResponse.headers.get('x-sonic-provider')).toBe('local-engine');
  });
});

describe('backend beta readiness, drain and maintenance', () => {
  const base = { SONIC_ENV: 'test', SONIC_RUNTIME: 'linux-engine', SONIC_ENGINE_SECRET: key, SONIC_RECOMMEND_DB_PATH: 'memory', RECOMMEND_STORE: new MemoryRecommendStore() };
  const healthRequest = () => new Request('https://engine.test/api/sonic/engine/health', { headers: { 'X-Sonic-Engine-Key': key } });
  it('distinguishes optional sidecar degradation, required sidecar, storage, and release failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));
    const optional = await health({ request: healthRequest(), env: { ...base, SONIC_NCM_API_URL: 'http://ncm:3000' } });
    expect(optional.status).toBe(200); expect((await optional.json()).readiness.degraded).toBe(true);
    expect((await health({ request: healthRequest(), env: { ...base, SONIC_NCM_REQUIRED: '1' } })).status).toBe(503);
    expect((await health({ request: healthRequest(), env: { ...base, SONIC_ENV: 'production', SONIC_RELEASE_COMMIT: 'unknown' } })).status).toBe(503);
    const brokenDisk = await health({ request: healthRequest(), env: { ...base, SONIC_RECOMMEND_DB_PATH: 'not-used.sqlite', SONIC_DISK_HEALTH_PROVIDER: () => { throw new Error('EIO'); } } });
    expect(brokenDisk.status).toBe(503);
    const release = { SONIC_ENV: 'production', SONIC_RELEASE_COMMIT: 'a'.repeat(40), SONIC_BUILD_TIME: '2026-11-02T00:00:00Z', SONIC_RELEASE_DIRTY: '1' };
    expect(getReleaseReadiness(release).ok).toBe(false);
    expect(getReleaseReadiness({ ...release, SONIC_RELEASE_ID: 'beta-123', SONIC_SOURCE_DIGEST: 'b'.repeat(64) }).ok).toBe(true);
  });

  it('reports draining readiness and refuses new work on an existing HTTP connection while its current request drains', async () => {
    const started = deferred<void>(); const body = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return body.promise; }));
    const server = createSonicServer(os.tmpdir(), base);
    const port = await listen(server);
    const socket = net.connect(port, '127.0.0.1');
    cleanup.push(() => socket.destroy());
    let output = '';
    socket.setEncoding('utf8'); socket.on('data', (chunk) => output += chunk); socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(`GET /api/banner HTTP/1.1\r\nHost: localhost\r\nX-Sonic-Engine-Key: ${key}\r\n\r\n`);
    await started.promise;
    const drained = drainSonicServer(server, 1000);
    socket.write(`GET /api/sonic/engine/health HTTP/1.1\r\nHost: localhost\r\nX-Sonic-Engine-Key: ${key}\r\n\r\nGET /api/banner HTTP/1.1\r\nHost: localhost\r\nX-Sonic-Engine-Key: ${key}\r\nConnection: close\r\n\r\n`);
    await wait(20);
    body.resolve(new Response('{"banners":[]}'));
    await drained;
    await vi.waitFor(() => expect(output).toContain('ENGINE_DRAINING'));
    expect(output).toContain('engine_draining');
    expect(output).toContain('HTTP/1.1 200');
    expect(output.match(/HTTP\/1.1 503/g)).toHaveLength(2);
  });

  it('aborts outstanding work at the configured drain deadline and closes a temporary SQLite store afterward', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-runtime-db-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const store: any = createServerRecommendStore(path.join(dir, 'test.sqlite'));
    const close = vi.spyOn(store, 'close');
    cleanup.push(() => store.close());
    const started = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      started.resolve(init.signal!); init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const server = createSonicServer(os.tmpdir(), { ...base, RECOMMEND_STORE: store, SONIC_RECOMMEND_DB_PATH: path.join(dir, 'test.sqlite') });
    const port = await listen(server);
    const client = http.get({ host: '127.0.0.1', port, path: '/api/banner', headers: { 'X-Sonic-Engine-Key': key } });
    client.on('error', () => {});
    const signal = await started.promise;
    const shutdown = shutdownSonicServer(server, store, 60);
    expect(close).not.toHaveBeenCalled(); expect(signal.aborted).toBe(false);
    await shutdown;
    expect(signal.aborted).toBe(true); expect(close).toHaveBeenCalledTimes(1);
  });

  it('holds the same maintenance lock during startup, preserves a restore lock, and cleans up failed initialization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-runtime-lock-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = path.join(dir, 'test.sqlite'); const lock = `${db}.maintenance-lock`;
    withRecommendStartupLock(db, () => expect(fs.existsSync(lock)).toBe(true));
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => withRecommendStartupLock(db, () => { throw new Error('init-failed'); })).toThrow('init-failed');
    expect(fs.existsSync(lock)).toBe(false);
    fs.mkdirSync(lock);
    expect(() => withRecommendStartupLock(db, () => {})).toThrow();
    expect(fs.existsSync(lock)).toBe(true);
    expect(withRecommendStartupLock('memory', () => 42)).toBe(42);
  });

  it('applies an idle deadline to a real slow response body after receiving headers', async () => {
    vi.stubGlobal('fetch', realFetch);
    const upstream = http.createServer((_req, res) => { res.writeHead(200); res.write('first'); });
    const port = await listen(upstream);
    const response = await fetchWithRuntimeBudget(`http://127.0.0.1:${port}/slow`, {}, { timeoutMs: 1000, firstByteTimeoutMs: 300, bodyIdleTimeoutMs: 30 });
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError', message: 'Upstream body idle timeout' });
  });
});

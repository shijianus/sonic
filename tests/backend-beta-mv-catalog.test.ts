import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpstreamEndpoint } from '../functions/_lib/sonic/upstream';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { computeMvEntityId } from '../functions/_lib/sonic/recommend/entity-store';
import { clearSonicMemoryCacheForTest } from '../functions/_lib/sonic/cache';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';
import { resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';

beforeEach(() => { clearSonicMemoryCacheForTest(); resetRateLimitsForTest(); resetLocalEngineCircuitForTest(); });
afterEach(() => { vi.unstubAllGlobals(); clearSonicMemoryCacheForTest(); });
const requestFor = (endpoint: string, query = '') => new Request(`https://sonic.example/api/${endpoint}${query}`);
const envFor = (store: MemoryRecommendStore) => ({ RECOMMEND_STORE: store, SONIC_ENV: 'test', SONIC_ENABLE_LOCAL_ENGINE: '0' });

describe('Verified server MV catalog and stream binding', () => {
  it('registers a successful provider MV detail for external-ID recommendation feedback', async () => {
    const store = new MemoryRecommendStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { id: 10880673, name: 'Verified video', artistName: 'Verified artist', duration: 180000, cover: 'https://p1.music.126.net/cover.jpg' } }), { headers: { 'Content-Type': 'application/json' } })));
    const request = requestFor('mv/detail', '?id=10880673');
    const response = await handleUpstreamEndpoint('mv/detail', new URL(request.url), request, envFor(store));
    expect(response.status).toBe(200);
    expect(store.getEntity(computeMvEntityId('netease', '10880673'))).toMatchObject({ type: 'mv', source: 'netease', sourceId: '10880673', title: 'Verified video', duration: 180 });
  });

  it('does not invent an unrelated video when the selected MV has no stream', async () => {
    const store = new MemoryRecommendStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { id: 10880673, brs: {} } }), { headers: { 'Content-Type': 'application/json' } })));
    const request = requestFor('mv/url', '?id=10880673');
    const response = await handleUpstreamEndpoint('mv/url', new URL(request.url), request, envFor(store));
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.data.url).toBe('');
    expect(data.error.code).toBe('MV_STREAM_UNAVAILABLE');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a provider response for a different MV instead of returning its stream', async () => {
    const store = new MemoryRecommendStore();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { id: 999, brs: { 1080: 'https://example.invalid/wrong.mp4' } } }), { headers: { 'Content-Type': 'application/json' } })));
    const request = requestFor('mv/url', '?id=10880673');
    const response = await handleUpstreamEndpoint('mv/url', new URL(request.url), request, envFor(store));
    expect(response.status).toBe(404);
    expect((await response.json()).data.url).toBe('');
  });

  it('returns a retryable failure when the MV provider fails', async () => {
    const store = new MemoryRecommendStore();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fixture provider offline'); }));
    const request = requestFor('mv/url', '?id=10880673');
    const response = await handleUpstreamEndpoint('mv/url', new URL(request.url), request, envFor(store));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    expect((await response.json()).data.url).toBe('');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteGorseUserData,
  fetchGorseNeighbors,
  fetchGorseRecommendations,
  fetchListenBrainzSimilarArtists,
  isGorseEnabled,
  searchMeilisearchIds,
} from '../functions/_lib/sonic/recommend/external-adapters';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('optional external adapter boundaries', () => {
  it('rejects service base URLs carrying credentials or query material', () => {
    expect(isGorseEnabled({ SONIC_GORSE_URL: 'https://user:secret@gorse.example' })).toBe(false);
    expect(isGorseEnabled({ SONIC_GORSE_URL: 'https://gorse.example/?token=leak' })).toBe(false);
    expect(isGorseEnabled({ SONIC_GORSE_URL: 'https://gorse.example/#secret' })).toBe(false);
    expect(isGorseEnabled({ SONIC_GORSE_URL: 'https://gorse.example' })).toBe(true);
    expect(isGorseEnabled({ SONIC_GORSE_URL: 'http://127.0.0.1:8088' })).toBe(true);
  });

  it('does not parse an oversized Gorse erasure response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ignored', {
      status: 200,
      headers: { 'content-length': String(65 * 1024) },
    }));
    await expect(deleteGorseUserData('anon:oversized-erasure', { SONIC_GORSE_URL: 'https://gorse.example' }))
      .resolves.toBe('failed');
  });

  it('fails closed on an oversized Gorse recommendation response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ignored', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }));
    await expect(fetchGorseRecommendations('anon:oversized', 10, { SONIC_GORSE_URL: 'https://gorse.example' })).resolves.toEqual([]);
  });

  it('fails closed on an oversized Gorse neighbor response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ignored', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }));
    await expect(fetchGorseNeighbors('track:oversized', 10, { SONIC_GORSE_URL: 'https://gorse.example' })).resolves.toEqual([]);
  });

  it('fails closed on an oversized Meilisearch response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ignored', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }));
    await expect(searchMeilisearchIds('oversized', 10, { SONIC_MEILISEARCH_URL: 'https://meili.example' })).resolves.toEqual([]);
  });

  it('fails closed on an oversized ListenBrainz response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ignored', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }));
    await expect(fetchListenBrainzSimilarArtists('oversized artist', {
      SONIC_ENABLE_LISTENBRAINZ: '1',
    })).resolves.toEqual([]);
  });
});

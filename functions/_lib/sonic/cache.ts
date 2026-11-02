// Sonic Gateway — Unified Multi-Tier Cache with `sonic:` Prefix & Stale-If-Error Support
// Works across Cloudflare Edge Cache API (`caches.default`), optional Workers KV (`env.KV`), and Linux Node 22 LRU memory.

import type { AppEnv } from '../types';
import type { SonicCacheLevel } from './types';

interface MemoryCacheEntry {
  json: string;
  freshUntil: number;
  staleUntil: number;
  bytes: number;
}

const MAX_MEMORY_ENTRIES = 1500;
const MAX_MEMORY_VALUE_BYTES = 512 * 1024;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const memoryLru = new Map<string, MemoryCacheEntry>();
let memoryBytes = 0;

function memoryBudget(env?: AppEnv): number {
  const configured = Number(env?.SONIC_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MEMORY_BYTES;
}

function deleteMemoryEntry(key: string): void {
  const entry = memoryLru.get(key);
  if (entry) memoryBytes -= entry.bytes;
  memoryLru.delete(key);
}

function touchMemoryLru(key: string, entry: MemoryCacheEntry, maxBytes = DEFAULT_MEMORY_BYTES): void {
  deleteMemoryEntry(key);
  if (entry.bytes > maxBytes) return;
  while (memoryLru.size >= MAX_MEMORY_ENTRIES || memoryBytes + entry.bytes > maxBytes) {
    const oldestKey = memoryLru.keys().next().value;
    if (oldestKey === undefined) break;
    deleteMemoryEntry(oldestKey);
  }
  memoryLru.set(key, entry);
  memoryBytes += entry.bytes;
}

export function buildSonicCacheKey(namespace: string, identifier: string): string {
  // Encode the whole identifier so user-controlled ':' / '=' characters cannot collide
  // with the field separators used by callers.
  const cleanId = encodeURIComponent(identifier.trim().replace(/\s+/g, '_'));
  return `sonic:${namespace}:${cleanId}`;
}

function getEdgeCache(): any | null {
  try {
    return typeof caches !== 'undefined' ? (caches as any).default || null : null;
  } catch {
    return null;
  }
}

function toSyntheticCacheRequest(sonicKey: string, tier: 'fresh' | 'stale'): Request {
  const encoded = encodeURIComponent(sonicKey);
  return new Request(`https://sonic-cache.internal/${tier}/${encoded}`, { method: 'GET' });
}

export interface CacheHitResult<T> {
  value: T;
  cacheLevel: SonicCacheLevel;
  stale: boolean;
  key: string;
}

export async function getSonicCachedJson<T>(
  namespace: string,
  identifier: string,
  env?: AppEnv,
  options?: { allowStale?: boolean },
): Promise<CacheHitResult<T> | null> {
  const key = buildSonicCacheKey(namespace, identifier);
  const now = Date.now();
  const allowStale = Boolean(options?.allowStale);

  // 1. Fast in-memory LRU check (active on Linux Engine & warm Workers isolate)
  const mem = memoryLru.get(key);
  if (mem) {
    if (now <= mem.freshUntil) {
      touchMemoryLru(key, mem, memoryBudget(env));
      try {
        return { value: JSON.parse(mem.json) as T, cacheLevel: 'memory', stale: false, key };
      } catch {
        deleteMemoryEntry(key);
      }
    } else if (allowStale && now <= mem.staleUntil) {
      try {
        return { value: JSON.parse(mem.json) as T, cacheLevel: 'memory-stale', stale: true, key };
      } catch {
        deleteMemoryEntry(key);
      }
    } else if (now > mem.staleUntil) {
      deleteMemoryEntry(key);
    }
  }

  // 2. Cloudflare Edge Cache API (`caches.default`)
  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const freshHit = await edgeCache.match(toSyntheticCacheRequest(key, 'fresh'));
      if (freshHit) {
        const value = (await freshHit.json()) as T;
        return { value, cacheLevel: 'cf-cache', stale: false, key };
      }
      if (allowStale) {
        const staleHit = await edgeCache.match(toSyntheticCacheRequest(key, 'stale'));
        if (staleHit) {
          const value = (await staleHit.json()) as T;
          return { value, cacheLevel: 'cf-cache-stale', stale: true, key };
        }
      }
    } catch {}
  }

  // 3. Optional KV binding (`sonic:` prefix)
  if (env?.KV && typeof env.KV.get === 'function') {
    try {
      const raw = await env.KV.get(key);
      if (raw) {
        const parsed = JSON.parse(raw) as { v: T; f: number; s: number };
        if (parsed && now <= parsed.f) {
          return { value: parsed.v, cacheLevel: 'kv', stale: false, key };
        }
        if (allowStale && parsed && now <= parsed.s) {
          return { value: parsed.v, cacheLevel: 'kv', stale: true, key };
        }
      }
    } catch {}
  }

  return null;
}

export async function putSonicCachedJson<T>(
  namespace: string,
  identifier: string,
  value: T,
  freshTtlSec: number,
  staleTtlSec: number,
  env?: AppEnv,
  waitUntil?: (promise: Promise<any>) => void,
): Promise<void> {
  const key = buildSonicCacheKey(namespace, identifier);
  const now = Date.now();
  const effectiveStaleSec = Math.max(freshTtlSec, staleTtlSec);
  const json = JSON.stringify(value);

  // 1. Populate bounded in-memory LRU (large payloads go only to edge/KV storage)
  const bytes = (json.length + key.length) * 2 + encoder.encode(json).byteLength + encoder.encode(key).byteLength;
  deleteMemoryEntry(key);
  if (encoder.encode(json).byteLength <= MAX_MEMORY_VALUE_BYTES) {
    touchMemoryLru(key, {
      json, bytes,
      freshUntil: now + freshTtlSec * 1000,
      staleUntil: now + effectiveStaleSec * 1000,
    }, memoryBudget(env));
  }

  const tasks: Promise<any>[] = [];

  // 2. Populate Cloudflare Edge Cache (fresh + stale backup)
  const edgeCache = getEdgeCache();
  if (edgeCache) {
    tasks.push(
      edgeCache
        .put(
          toSyntheticCacheRequest(key, 'fresh'),
          new Response(json, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': `public, max-age=${freshTtlSec}, s-maxage=${freshTtlSec}`,
            },
          }),
        )
        .catch(() => {}),
    );
    if (effectiveStaleSec > freshTtlSec) {
      tasks.push(
        edgeCache
          .put(
            toSyntheticCacheRequest(key, 'stale'),
            new Response(json, {
              status: 200,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': `public, max-age=${effectiveStaleSec}, s-maxage=${effectiveStaleSec}`,
              },
            }),
          )
          .catch(() => {}),
      );
    }
  }

  // 3. Optional KV write
  if (env?.KV && typeof env.KV.put === 'function') {
    tasks.push(
      env.KV.put(
        key,
        JSON.stringify({ v: value, f: now + freshTtlSec * 1000, s: now + effectiveStaleSec * 1000 }),
        { expirationTtl: effectiveStaleSec },
      ).catch(() => {}),
    );
  }

  if (tasks.length > 0) {
    const all = Promise.allSettled(tasks);
    if (typeof waitUntil === 'function') {
      waitUntil(all);
    } else {
      await all;
    }
  }
}

interface JsonFlight {
  controller: AbortController;
  promise: Promise<any>;
  subscribers: number;
}
const jsonFlights = new Map<string, JsonFlight>();

// Bound both distinct work and listeners per hot key. Each caller owns its own
// cancellation; the shared upstream is aborted only when every caller leaves.
export function withSonicJsonSingleFlight<T>(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (key.length > 16_384) return Promise.reject(new Error('JSON flight key exceeds limit'));
  let flight = jsonFlights.get(key);
  if (!flight) {
    if (jsonFlights.size >= 128) return Promise.reject(new Error('JSON upstream capacity exceeded'));
    const controller = new AbortController();
    flight = { controller, promise: Promise.resolve().then(() => load(controller.signal)), subscribers: 0 };
    jsonFlights.set(key, flight);
    const owned = flight;
    void flight.promise.finally(() => {
      if (jsonFlights.get(key) === owned) jsonFlights.delete(key);
    }).catch(() => {});
  }
  if (flight.subscribers >= 128) return Promise.reject(new Error('JSON upstream waiters exceeded'));
  const owned = flight;
  owned.subscribers += 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      owned.subscribers -= 1;
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      reject(signal?.reason);
      if (owned.subscribers === 0) {
        if (jsonFlights.get(key) === owned) jsonFlights.delete(key);
        owned.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    owned.promise.then(
      (value) => { if (finish()) resolve(value); },
      (error) => { if (finish()) reject(error); },
    );
  });
}

export function getSonicMemoryCacheStats() {
  return { entries: memoryLru.size, bytes: memoryBytes, inFlight: jsonFlights.size };
}

export function clearSonicMemoryCacheForTest(): void {
  memoryLru.clear();
  memoryBytes = 0;
  for (const flight of jsonFlights.values()) flight.controller.abort();
  jsonFlights.clear();
}

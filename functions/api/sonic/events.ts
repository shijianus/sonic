// POST / DELETE / GET /api/sonic/events
// Privacy-First User Behavior Feedback & Preference Management Endpoint
// - POST: Ingest batch or single behavior event (`play_start`, `play_progress`, `play_complete`, `skip`, `replay`, `favorite`, `dislike`, `search`, `search_click`)
// - DELETE: One-click deletion of all server-side events/preferences for the current user or anonymous ID
// - GET: Inspect current privacy mode and high-level preference profile summary (no raw PII)

import type { AppEnv } from '../../_lib/types';
import { jsonResponse, handleOptions } from '../../_lib/http';
import { getSonicConfig } from '../../_lib/sonic/config';
import { callLocalEngineJson } from '../../_lib/sonic/local-engine';
import { buildGatewayHeaders, guardGatewayRequest, readBoundedRequestBody, sonicError } from '../../_lib/sonic/route-helpers';
import { getPublicClientIp } from '../../_lib/sonic/security';
import { sha256Hex } from '../../_lib/sonic/crypto';
import {
  buildUserPreferenceProfile,
  clearUserRecommendationData,
  clearUserRecommendationDataAndExternal,
  getRecommendStore,
  ingestBehaviorEvents,
  normalizeBehaviorEventInput,
  resolveUserIdentity,
  type SonicBehaviorEventInput,
} from '../../_lib/sonic/recommend';

const MAX_BODY_BYTES = 64 * 1024;
// Events are the only anonymous write surface that feeds global popularity.
// Bound both the network identity (IP) and the claimed subject so a single
// client cannot amplify the store by replaying large batches.
const EVENT_QUOTA_WINDOW_MS = 60_000;
const EVENT_QUOTA_PER_IP = 4_000;
const EVENT_QUOTA_PER_SUBJECT = 600;
const MAX_EVENT_QUOTA_BUCKETS = 4096;
const eventQuotaBuckets = new Map<string, { count: number; resetAt: number }>();

// Per-minute quotas alone still allow ~5.76M events/day/IP. Daily UTC-day
// buckets (best-effort per isolate on Pages; durable on the single-process
// Engine) cut that ceiling, while the SQLite row caps / max_page_count remain
// the hard backstop (audit P0-1).
const DEFAULT_DAILY_EVENT_QUOTA_PER_IP = 200_000;
const DEFAULT_DAILY_EVENT_QUOTA_PER_SUBJECT = 50_000;
const MAX_DAILY_QUOTA_BUCKETS = 4096;
const dailyQuotaBuckets = new Map<string, { count: number; resetAt: number }>();

function dailyQuotaLimit(envValue: unknown, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function bumpDailyEventQuota(key: string, limit: number, count: number, now = Date.now()): boolean {
  let bucket = dailyQuotaBuckets.get(key);
  const resetAt = nextUtcMidnight(now);
  if (!bucket || bucket.resetAt !== resetAt) {
    if (dailyQuotaBuckets.size >= MAX_DAILY_QUOTA_BUCKETS) {
      for (const [candidate, value] of dailyQuotaBuckets) {
        if (value.resetAt !== resetAt) dailyQuotaBuckets.delete(candidate);
      }
      if (dailyQuotaBuckets.size >= MAX_DAILY_QUOTA_BUCKETS) {
        const oldest = dailyQuotaBuckets.keys().next().value;
        if (oldest) dailyQuotaBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt };
    dailyQuotaBuckets.set(key, bucket);
  }
  bucket.count += count;
  return bucket.count <= limit;
}

function bumpEventQuota(key: string, limit: number, count: number, now = Date.now()): boolean {
  let bucket = eventQuotaBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (eventQuotaBuckets.size >= MAX_EVENT_QUOTA_BUCKETS) {
      for (const [candidate, value] of eventQuotaBuckets) {
        if (now >= value.resetAt) eventQuotaBuckets.delete(candidate);
      }
      if (eventQuotaBuckets.size >= MAX_EVENT_QUOTA_BUCKETS) {
        const oldest = eventQuotaBuckets.keys().next().value;
        if (oldest) eventQuotaBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + EVENT_QUOTA_WINDOW_MS };
    eventQuotaBuckets.set(key, bucket);
  }
  bucket.count += count;
  return bucket.count <= limit;
}

export function resetEventIngestQuotaForTest(): void {
  eventQuotaBuckets.clear();
  dailyQuotaBuckets.clear();
}
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization, Cookie, X-Sonic-Key, X-CFSolara-Key, X-Sonic-Anon-Id, X-Sonic-Personalization',
};

function storageUnavailable(start: number, circuitState?: string): Response {
  const response = sonicError('EVENT_STORAGE_UNAVAILABLE', 'Event storage unavailable; retry with the same event IDs', 503, {
    provider: 'sonic-events', latencyMs: Date.now() - start, degraded: true, retryable: true, circuitState,
  });
  for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
  response.headers.set('Retry-After', '3');
  return response;
}

function erasureIncomplete(data: Record<string, unknown>): Response {
  const response = jsonResponse({
    brand: 'Sonic', error: { code: 'EVENT_ERASURE_INCOMPLETE', message: 'Some recommendation data could not be removed; retry deletion' },
    data, meta: { degraded: true, retryable: true, provider: 'sonic-events' },
  }, { status: 503, headers: buildGatewayHeaders(PRIVATE_HEADERS, true) });
  response.headers.set('Retry-After', '3');
  return response;
}

function storageBudgetExceeded(start: number): Response {
  const response = sonicError(
    'EVENT_STORAGE_BUDGET_EXCEEDED',
    'Event storage budget exhausted; ingestion temporarily refused',
    507,
    { provider: 'sonic-events', latencyMs: Date.now() - start, degraded: true, retryable: false },
  );
  for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
  response.headers.set('Retry-After', '600');
  return response;
}

function engineRejected(result: { status?: number; data?: any; errorCode?: string }, start: number, circuitState?: string): Response {
  if (result.errorCode === 'ENGINE_IDENTITY_UNAVAILABLE') {
    const response = sonicError('ENGINE_IDENTITY_UNAVAILABLE', 'Verified inter-service identity is unavailable', 503, {
      provider: 'sonic-events', degraded: true, retryable: true, circuitState,
    });
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
    response.headers.set('Retry-After', '3');
    return response;
  }
  if (result.data?.error?.code === 'EVENT_ERASURE_INCOMPLETE') return erasureIncomplete(result.data.data || {});
  if (result.data?.error?.code === 'EVENT_STORAGE_BUDGET_EXCEEDED') return storageBudgetExceeded(start);
  if (result.status && result.status >= 400 && result.status < 500 && result.data?.brand === 'Sonic' && result.data?.error?.code) {
    return jsonResponse(result.data, { status: result.status, headers: buildGatewayHeaders(PRIVATE_HEADERS, false, circuitState) });
  }
  return storageUnavailable(start, circuitState);
}

export async function onRequest({
  request,
  env,
}: {
  request: Request;
  env: AppEnv;
  waitUntil?: (promise: Promise<any>) => void;
}): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const method = request.method.toUpperCase();
  if (method !== 'POST' && method !== 'DELETE' && method !== 'GET') {
    return sonicError('METHOD_NOT_ALLOWED', 'Only GET, POST, and DELETE allowed', 405);
  }

  const guardResp = await guardGatewayRequest(request, env, 'sonic-events');
  if (guardResp) return guardResp;

  const start = Date.now();
  const config = getSonicConfig(env);
  const privateHeaders = PRIVATE_HEADERS;

  if (method === 'GET') {
    if (config.enableLocalEngine) {
      const engineRes = await callLocalEngineJson<any>('/api/sonic/events', env, {
        request,
        method: 'GET',
        timeoutMs: config.engineTimeoutMs,
      });
      if (engineRes.ok && engineRes.data?.brand === 'Sonic' &&
          (engineRes.data.data?.storageKind === 'sqlite' ||
            (engineRes.data.data?.privacyMode === 'public' && engineRes.data.data?.totalEvents === 0))) {
        return jsonResponse(engineRes.data, {
          status: 200,
          headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
        });
      }
      return engineRejected(engineRes, start, engineRes.circuitState);
    }

    const identity = await resolveUserIdentity(request, env);
    const store = getRecommendStore(env);
    if (identity.subjectKey && store.kind !== 'sqlite') return storageUnavailable(start);
    let profile: ReturnType<typeof buildUserPreferenceProfile>;
    try {
      profile = buildUserPreferenceProfile(identity, store);
    } catch {
      return storageUnavailable(start);
    }
    return jsonResponse(
      {
        brand: 'Sonic',
        data: {
          privacyMode: identity.mode,
          personalizationEnabled: identity.personalizationEnabled,
          totalEvents: profile.totalEvents,
          likedCount: profile.likedTrackIds.size,
          dislikedCount: profile.blockedTrackIds.size,
          topArtists: Object.entries(profile.longTermArtists)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([name]) => name),
          topGenres: Object.entries(profile.genreAffinities)
            .filter(([, w]) => w > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([genre]) => genre),
          recentQueries: profile.recentQueries.slice(0, 6),
          storageKind: store.kind,
        },
        meta: {
          cached: false,
          cacheLevel: 'none',
          latencyMs: Date.now() - start,
          provider: 'sonic-events',
        },
      },
      { status: 200, headers: buildGatewayHeaders(privateHeaders) },
    );
  }

  if (method === 'DELETE') {
    if (config.enableLocalEngine) {
      const engineRes = await callLocalEngineJson<any>('/api/sonic/events', env, {
        request, method: 'DELETE', timeoutMs: config.engineTimeoutMs, signal: request.signal,
      });
      if (engineRes.ok && engineRes.data?.brand === 'Sonic' &&
          ((engineRes.data?.data?.cleared === true && engineRes.data.data.storageKind === 'sqlite') ||
            (engineRes.data?.data?.privacyMode === 'public' && engineRes.data.data.cleared === false && engineRes.data.data.removedEvents === 0)) &&
          Number.isInteger(engineRes.data.data.removedEvents) && engineRes.data.data.removedEvents >= 0) {
        // Authority's result/count, never an Edge OR-success. Clear stale local
        // read-fallback data only after the durable deletion is acknowledged.
        try { clearUserRecommendationData(await resolveUserIdentity(request, env), env); } catch {}
        return jsonResponse(engineRes.data, { status: 200, headers: buildGatewayHeaders(privateHeaders, false, engineRes.circuitState) });
      }
      return engineRejected(engineRes, start, engineRes.circuitState);
    }
    const identity = await resolveUserIdentity(request, env);
    if (identity.subjectKey && getRecommendStore(env).kind !== 'sqlite') return storageUnavailable(start);
    try {
      const localClear = await clearUserRecommendationDataAndExternal(identity, env);
      if (identity.subjectKey && !localClear.cleared) return erasureIncomplete({ ...localClear, privacyMode: identity.mode });
      return jsonResponse({
        brand: 'Sonic',
        data: { ...localClear, privacyMode: identity.mode },
        meta: { cached: false, cacheLevel: 'none', latencyMs: Date.now() - start, provider: 'sonic-events' },
      }, { status: 200, headers: buildGatewayHeaders(privateHeaders) });
    } catch {
      return storageUnavailable(start);
    }
  }

  // POST: Parse & validate JSON payload
  const bodyResult = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (bodyResult.ok === false) {
    return bodyResult.reason === 'too_large'
      ? sonicError('PAYLOAD_TOO_LARGE', 'Event payload exceeds 64KB limit', 413)
      : sonicError('INVALID_BODY', 'Failed to read request body', 400);
  }
  const rawText = bodyResult.text;

  let parsed: any;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    return sonicError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }

  const rawEvents: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.events)
      ? parsed.events
      : parsed?.type || parsed?.action
        ? [parsed]
        : [];

  if (rawEvents.length === 0) {
    return sonicError('EMPTY_EVENTS', 'Provide `events` array or single event object with valid `type` or `action`', 400);
  }

  const validEvents: SonicBehaviorEventInput[] = [];
  for (const ev of rawEvents.slice(0, 50)) {
    const normalized = normalizeBehaviorEventInput(ev);
    if (normalized.error) return sonicError(normalized.error, 'Invalid event action or entity reference', 400);
    validEvents.push(normalized.event);
  }

  if (validEvents.length === 0) {
    return sonicError('INVALID_EVENT_TYPE', 'No valid event types or actions found in payload', 400);
  }

  const quotaNow = Date.now();
  const clientIp = getPublicClientIp(request);
  const rawAnonId = (request.headers.get('x-sonic-anon-id') || '').trim();
  const subjectQuotaKey = /^anon_[A-Za-z0-9_-]{8,64}$/.test(rawAnonId)
    ? `anon:${sha256Hex(rawAnonId).slice(0, 32)}`
    : `ip:${clientIp}`;
  if (
    !bumpEventQuota(`ip:${clientIp}`, EVENT_QUOTA_PER_IP, validEvents.length, quotaNow) ||
    !bumpEventQuota(subjectQuotaKey, EVENT_QUOTA_PER_SUBJECT, validEvents.length, quotaNow)
  ) {
    const limited = sonicError(
      'EVENT_QUOTA_EXCEEDED',
      'Event ingestion quota exceeded; retry in a minute',
      429,
      { provider: 'sonic-events' },
    );
    limited.headers.set('Retry-After', '60');
    return limited;
  }
  if (
    !bumpDailyEventQuota(`dip:${clientIp}`, dailyQuotaLimit(env?.SONIC_EVENTS_DAILY_PER_IP, DEFAULT_DAILY_EVENT_QUOTA_PER_IP), validEvents.length, quotaNow) ||
    !bumpDailyEventQuota(`dsub:${subjectQuotaKey}`, dailyQuotaLimit(env?.SONIC_EVENTS_DAILY_PER_SUBJECT, DEFAULT_DAILY_EVENT_QUOTA_PER_SUBJECT), validEvents.length, quotaNow)
  ) {
    const limited = sonicError(
      'EVENT_DAILY_QUOTA_EXCEEDED',
      'Daily event ingestion quota exceeded; retry tomorrow',
      429,
      { provider: 'sonic-events' },
    );
    limited.headers.set('Retry-After', '3600');
    return limited;
  }

  // Primary Hop: forward to Linux VPS Sonic Engine when configured
  let degraded = false;
  let circuitState: string | undefined;
  if (config.enableLocalEngine) {
    const engineRes = await callLocalEngineJson<any>('/api/sonic/events', env, {
      request,
      method: 'POST',
      body: JSON.stringify({ events: validEvents }),
      timeoutMs: config.engineTimeoutMs,
      signal: request.signal,
    });
    circuitState = engineRes.circuitState;
    if (engineRes.ok && engineRes.data?.brand === 'Sonic' && engineRes.data?.data?.ok === true &&
        (engineRes.data.data.storageKind === 'sqlite' ||
          (engineRes.data.data.storageKind === 'none' && engineRes.data.data.ignoredByPrivacy === validEvents.length))) {
      return jsonResponse(
        {
          ...engineRes.data,
          meta: {
            ...engineRes.data.meta,
            latencyMs: Date.now() - start,
            via: 'local-engine',
            circuitState: 'CLOSED',
          },
        },
        {
          status: 200,
          headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
        },
      );
    }
    return engineRejected(engineRes, start, circuitState);
  }

  const identity = await resolveUserIdentity(request, env);
  if (identity.personalizationEnabled && identity.subjectKey && getRecommendStore(env).kind !== 'sqlite') {
    return storageUnavailable(start);
  }
  let result: Awaited<ReturnType<typeof ingestBehaviorEvents>>;
  try {
    result = await ingestBehaviorEvents(validEvents, identity, env);
  } catch (err: any) {
    if (err?.code === 'RECOMMEND_STORE_BUDGET_EXCEEDED') return storageBudgetExceeded(start);
    return storageUnavailable(start);
  }

  return jsonResponse(
    {
      brand: 'Sonic',
      data: {
        ok: true,
        privacyMode: identity.mode,
        ...result,
      },
      meta: {
        cached: false,
        cacheLevel: 'none',
        latencyMs: Date.now() - start,
        provider: 'sonic-events',
        degraded,
        ...(degraded ? { circuitState } : {}),
      },
    },
    {
      status: 200,
      headers: buildGatewayHeaders(privateHeaders, degraded, circuitState),
    },
  );
}

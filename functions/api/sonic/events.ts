// POST / DELETE / GET /api/sonic/events
// Privacy-First User Behavior Feedback & Preference Management Endpoint
// - POST: Ingest batch or single behavior event (`play_start`, `play_progress`, `play_complete`, `skip`, `replay`, `favorite`, `dislike`, `search`, `search_click`)
// - DELETE: One-click deletion of all server-side events/preferences for the current user or anonymous ID
// - GET: Inspect current privacy mode and high-level preference profile summary (no raw PII)

import type { AppEnv } from '../../_lib/types';
import { extractAuthCredentials } from '../../_lib/auth';
import { jsonResponse, handleOptions } from '../../_lib/http';
import { getSonicConfig } from '../../_lib/sonic/config';
import { callLocalEngineJson } from '../../_lib/sonic/local-engine';
import { buildGatewayHeaders, guardGatewayRequest, readBoundedRequestBody, sonicError } from '../../_lib/sonic/route-helpers';
import { extractClientIp } from '../../_lib/sonic/security';
import { EventEpochMismatchError, isEventEpoch } from '../../_lib/sonic/recommend/event-epoch';
import {
  buildUserPreferenceProfile,
  clearUserRecommendationData,
  clearUserRecommendationDataAndExternal,
  getRecommendStore,
  ingestBehaviorEvents,
  normalizeBehaviorEventInput,
  resolveUserIdentity,
  type SonicBehaviorEventInput,
  type UserIdentityContext,
} from '../../_lib/sonic/recommend';

const MAX_BODY_BYTES = 64 * 1024;
const ERASURE_TARGET_HEADER = 'X-Sonic-Erasure-Target';
const INGEST_TARGET_HEADER = 'X-Sonic-Event-Target';
// Events are the only anonymous write surface that feeds global popularity.
// Bound both the network identity (IP) and the claimed subject so a single
// client cannot amplify the store by replaying large batches.
const EVENT_QUOTA_WINDOW_MS = 60_000;
const EVENT_QUOTA_PER_IP = 4_000;
const EVENT_QUOTA_PER_SUBJECT = 600;
const MAX_EVENT_QUOTA_BUCKETS = 4096;
type EventQuotaBucket = { count: number; resetAt: number };
const minuteIpBuckets = new Map<string, EventQuotaBucket>();
const minuteSubjectBuckets = new Map<string, EventQuotaBucket>();

// Per-minute quotas alone still allow ~5.76M events/day/IP. Daily UTC-day
// buckets in the process that writes SQLite cut that ceiling. SQLite row
// caps and max_page_count remain the hard backstop across restarts.
const DEFAULT_DAILY_EVENT_QUOTA_PER_IP = 200_000;
const DEFAULT_DAILY_EVENT_QUOTA_PER_SUBJECT = 50_000;
const dailyIpBuckets = new Map<string, EventQuotaBucket>();
const dailySubjectBuckets = new Map<string, EventQuotaBucket>();

function dailyQuotaLimit(envValue: unknown, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function getEventQuotaBucket(buckets: Map<string, EventQuotaBucket>, key: string, now: number, resetAt: number): EventQuotaBucket {
  const active = buckets.get(key);
  if (active && now < active.resetAt) return active;
  if (active) buckets.delete(key);
  if (buckets.size >= MAX_EVENT_QUOTA_BUCKETS) {
    for (const [candidate, value] of buckets) {
      if (now >= value.resetAt) buckets.delete(candidate);
    }
    const oldest = buckets.keys().next().value;
    if (buckets.size >= MAX_EVENT_QUOTA_BUCKETS && oldest !== undefined) buckets.delete(oldest);
  }
  const bucket = { count: 0, resetAt };
  buckets.set(key, bucket);
  return bucket;
}

export function resetEventIngestQuotaForTest(): void {
  for (const buckets of [minuteIpBuckets, minuteSubjectBuckets, dailyIpBuckets, dailySubjectBuckets]) buckets.clear();
}
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization, Cookie, X-Sonic-Key, X-CFSolara-Key, X-Sonic-Anon-Id, X-Sonic-Personalization',
};

const QUOTA_RETRY_AFTER = { EVENT_QUOTA_EXCEEDED: '60', EVENT_DAILY_QUOTA_EXCEEDED: '3600' } as const;
type EventQuotaError = keyof typeof QUOTA_RETRY_AFTER;

function consumeEventQuota(request: Request, env: AppEnv, subjectKey: string, count: number): EventQuotaError | null {
  const now = Date.now();
  const ip = extractClientIp(request, env);
  const minute = now + EVENT_QUOTA_WINDOW_MS;
  const minuteIp = getEventQuotaBucket(minuteIpBuckets, ip, now, minute);
  if (minuteIp.count + count > EVENT_QUOTA_PER_IP) return 'EVENT_QUOTA_EXCEEDED';
  const minuteSubject = getEventQuotaBucket(minuteSubjectBuckets, subjectKey, now, minute);
  if (minuteSubject.count + count > EVENT_QUOTA_PER_SUBJECT) return 'EVENT_QUOTA_EXCEEDED';

  const daily = nextUtcMidnight(now);
  const dailyIp = getEventQuotaBucket(dailyIpBuckets, ip, now, daily);
  if (dailyIp.count + count > dailyQuotaLimit(env.SONIC_EVENTS_DAILY_PER_IP, DEFAULT_DAILY_EVENT_QUOTA_PER_IP)) return 'EVENT_DAILY_QUOTA_EXCEEDED';
  const dailySubject = getEventQuotaBucket(dailySubjectBuckets, subjectKey, now, daily);
  if (dailySubject.count + count > dailyQuotaLimit(env.SONIC_EVENTS_DAILY_PER_SUBJECT, DEFAULT_DAILY_EVENT_QUOTA_PER_SUBJECT)) {
    return 'EVENT_DAILY_QUOTA_EXCEEDED';
  }

  // Check all limits before charging any bucket. A rejected subject must not
  // keep spending the shared IP budget of other users on that network.
  for (const bucket of [minuteIp, minuteSubject, dailyIp, dailySubject]) bucket.count += count;
  return null;
}

function eventQuotaRejected(code: EventQuotaError, circuitState?: string): Response {
  const message = code === 'EVENT_QUOTA_EXCEEDED'
    ? 'Event ingestion quota exceeded; retry in a minute'
    : 'Daily event ingestion quota exceeded; retry tomorrow';
  const response = sonicError(code, message, 429, { provider: 'sonic-events', circuitState });
  for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
  response.headers.set('Retry-After', QUOTA_RETRY_AFTER[code]);
  return response;
}

function eventIngested(identity: UserIdentityContext, result: Awaited<ReturnType<typeof ingestBehaviorEvents>>, start: number): Response {
  return jsonResponse({
    brand: 'Sonic',
    data: { ok: true, privacyMode: identity.mode, ...result },
    meta: { cached: false, cacheLevel: 'none', latencyMs: Date.now() - start, provider: 'sonic-events', degraded: false },
  }, { status: 200, headers: buildGatewayHeaders(PRIVATE_HEADERS) });
}

function matchesEventTarget(target: string, identity: UserIdentityContext): boolean {
  return identity.mode === 'authenticated'
    ? Boolean(identity.userId && target === `account:${identity.userId}`)
    : target === identity.mode;
}

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
  const code = result.data?.error?.code;
  if (code === 'EVENT_ERASURE_INCOMPLETE') return erasureIncomplete(result.data.data || {});
  if (code === 'EVENT_STORAGE_BUDGET_EXCEEDED') return storageBudgetExceeded(start);
  if (result.status === 429 && result.data?.brand === 'Sonic' && (code === 'EVENT_QUOTA_EXCEEDED' || code === 'EVENT_DAILY_QUOTA_EXCEEDED')) {
    return eventQuotaRejected(code, circuitState);
  }
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
    let eventEpoch: string | null | undefined;
    try {
      profile = buildUserPreferenceProfile(identity, store);
      if (identity.subjectKey) eventEpoch = store.getEventEpoch?.(identity.subjectKey) ?? null;
    } catch {
      return storageUnavailable(start);
    }
    return jsonResponse(
      {
        brand: 'Sonic',
        data: {
          privacyMode: identity.mode,
          eventEpoch,
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
    const identity = await resolveUserIdentity(request, env);
    const target = request.headers.get(ERASURE_TARGET_HEADER);
    const needsTarget = identity.mode === 'authenticated' && extractAuthCredentials(request).source === 'cookie';
    if (target === null ? needsTarget : !matchesEventTarget(target, identity)) {
      return jsonResponse({
        brand: 'Sonic',
        error: { code: 'EVENT_ERASURE_IDENTITY_MISMATCH', message: 'Refresh your session before retrying recommendation data deletion' },
      }, { status: 409, headers: buildGatewayHeaders(privateHeaders) });
    }
    if (config.enableLocalEngine) {
      const engineRes = await callLocalEngineJson<any>('/api/sonic/events', env, {
        request, method: 'DELETE', timeoutMs: config.engineTimeoutMs, signal: request.signal,
        ...(target !== null ? { resolvedIdentity: identity } : {}),
      });
      const erasure = engineRes.data?.data;
      if (engineRes.ok && engineRes.data?.brand === 'Sonic' &&
          erasure?.privacyMode === identity.mode &&
          Number.isSafeInteger(erasure.removedEvents) && erasure.removedEvents >= 0 &&
          (identity.mode === 'public'
            ? erasure.cleared === false && erasure.removedEvents === 0
            : erasure.cleared === true && erasure.storageKind === 'sqlite' && isEventEpoch(erasure.eventEpoch))) {
        // Authority's result/count, never an Edge OR-success. Clear stale local
        // read-fallback data only after the durable deletion is acknowledged.
        try { clearUserRecommendationData(identity, env); } catch {}
        return jsonResponse(engineRes.data, { status: 200, headers: buildGatewayHeaders(privateHeaders, false, engineRes.circuitState) });
      }
      return engineRejected(engineRes, start, engineRes.circuitState);
    }
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
  const suppliedEpoch: unknown = parsed?.eventEpoch ?? null;
  let eventEpoch: string | null = null;
  if (suppliedEpoch !== null) {
    if (!isEventEpoch(suppliedEpoch)) {
      return sonicError('INVALID_EVENT_EPOCH', 'eventEpoch must be a current recommendation event marker', 400);
    }
    eventEpoch = suppliedEpoch;
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

  const identity = await resolveUserIdentity(request, env);
  const target = request.headers.get(INGEST_TARGET_HEADER);
  const needsTarget = identity.mode !== 'public' && extractAuthCredentials(request).source === 'cookie';
  if (target === null ? needsTarget : !matchesEventTarget(target, identity)) {
    return jsonResponse({
      brand: 'Sonic',
      error: { code: 'EVENT_INGEST_IDENTITY_MISMATCH', message: 'The behavior batch does not match the current session' },
    }, { status: 409, headers: buildGatewayHeaders(privateHeaders) });
  }

  // Public requests still pass validation and the normal gateway rate limit.
  // Their event payloads need neither a persistence budget nor an Engine hop.
  if (!identity.personalizationEnabled || !identity.subjectKey) {
    return eventIngested(identity, { accepted: 0, deduplicated: 0, ignoredByPrivacy: validEvents.length, storageKind: 'none' }, start);
  }

  // The authoritative writer enforces the persistence quota once, including
  // requests arriving from different Pages isolates.
  if (config.enableLocalEngine) {
    const engineRes = await callLocalEngineJson<any>('/api/sonic/events', env, {
      request,
      method: 'POST',
      body: JSON.stringify({ events: validEvents, ...(eventEpoch === null ? {} : { eventEpoch }) }),
      timeoutMs: config.engineTimeoutMs,
      signal: request.signal,
      ...(target !== null ? { resolvedIdentity: identity } : {}),
    });
    const circuitState = engineRes.circuitState;
    if (engineRes.ok && engineRes.data?.brand === 'Sonic' && engineRes.data?.data?.ok === true &&
        engineRes.data.data.storageKind === 'sqlite') {
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

  const store = getRecommendStore(env);
  if (store.kind !== 'sqlite' || !store.withEventEpoch) return storageUnavailable(start);
  const quotaError = consumeEventQuota(request, env, identity.subjectKey, validEvents.length);
  if (quotaError) return eventQuotaRejected(quotaError);

  try {
    return eventIngested(identity, await ingestBehaviorEvents(validEvents, identity, env, eventEpoch), start);
  } catch (err: any) {
    if (err instanceof EventEpochMismatchError) {
      return jsonResponse({
        brand: 'Sonic',
        error: { code: 'EVENT_EPOCH_MISMATCH', message: err.message },
        data: { eventEpoch: err.eventEpoch, privacyMode: identity.mode },
      }, { status: 409, headers: buildGatewayHeaders(privateHeaders) });
    }
    if (err?.code === 'RECOMMEND_STORE_BUDGET_EXCEEDED') return storageBudgetExceeded(start);
    return storageUnavailable(start);
  }
}

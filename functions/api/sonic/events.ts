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
  } catch {
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

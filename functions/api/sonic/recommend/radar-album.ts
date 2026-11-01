// GET / POST /api/sonic/recommend/radar-album
// EpoMail 1:1 Cloud Sync Endpoint for Compact User Radar Album Profile
// Unauthenticated / Guest requests are strictly kept on client local-first.

import type { AppEnv } from '../../../_lib/types';
import { jsonResponse, handleOptions } from '../../../_lib/http';
import { getSonicConfig } from '../../../_lib/sonic/config';
import { callLocalEngineJson } from '../../../_lib/sonic/local-engine';
import {
  buildGatewayHeaders,
  guardGatewayRequest,
  readBoundedRequestBody,
  sonicError,
} from '../../../_lib/sonic/route-helpers';
import {
  getRecommendStore,
  resolveUserIdentity,
} from '../../../_lib/sonic/recommend';

const MAX_RADAR_PAYLOAD_BYTES = 8 * 1024; // Strictly bounded: max 8KB for strongest signals only

export async function onRequest({
  request,
  env,
}: {
  request: Request;
  env: AppEnv;
}): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return sonicError('METHOD_NOT_ALLOWED', 'Only GET and POST allowed', 405);
  }

  const guardResp = await guardGatewayRequest(request, env, 'sonic-recommend');
  if (guardResp) return guardResp;

  const start = Date.now();
  const identity = await resolveUserIdentity(request, env);
  const config = getSonicConfig(env);
  const privateHeaders = {
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization, Cookie, X-Sonic-Key, X-CFSolara-Key, X-Sonic-Anon-Id',
  };

  // Only users authenticated via EpoMail OAuth have cloud DB sync support
  const isAuthenticatedUser = identity.mode === 'authenticated' && !!identity.userId;

  if (method === 'GET') {
    if (!isAuthenticatedUser) {
      return jsonResponse(
        {
          brand: 'Sonic',
          data: null,
          note: 'guest_local_only',
        },
        {
          status: 200,
          headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
        },
      );
    }

    if (config.enableLocalEngine) {
      const engineRes = await callLocalEngineJson<any>('/api/sonic/recommend/radar-album', env, {
        request,
        method: 'GET',
        timeoutMs: config.engineTimeoutMs,
      });
      if (engineRes.ok && engineRes.data?.brand === 'Sonic') {
        return jsonResponse(engineRes.data, {
          status: 200,
          headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
        });
      }
    }

    const store = getRecommendStore(env);
    const profile = store.getUserRadarProfile?.(identity.subjectKey) || null;
    let parsedData = null;
    if (profile?.payloadJson) {
      try {
        parsedData = JSON.parse(profile.payloadJson);
      } catch {}
    }

    return jsonResponse(
      {
        brand: 'Sonic',
        data: parsedData,
        syncedAt: profile?.updatedAt || null,
        meta: {
          latencyMs: Date.now() - start,
          subjectKey: identity.subjectKey,
        },
      },
      {
        status: 200,
        headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
      },
    );
  }

  // Method POST: Sync compact profile to Cloud DB
  if (!isAuthenticatedUser) {
    return sonicError(
      'UNAUTHORIZED',
      'Cloud sync requires an authenticated EpoMail account; guest profiles remain local-first',
      401,
    );
  }

  const bodyResult = await readBoundedRequestBody(request, MAX_RADAR_PAYLOAD_BYTES);
  if (!bodyResult.ok) {
    const isTooLarge = (bodyResult as { ok: false; reason: string }).reason === 'too_large';
    return sonicError(
      isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'READ_ERROR',
      isTooLarge ? 'Payload exceeds 8KB limit' : 'Failed to read body',
      isTooLarge ? 413 : 400,
    );
  }

  let payloadObj: any;
  try {
    payloadObj = JSON.parse(bodyResult.text);
    if (!payloadObj || typeof payloadObj !== 'object') throw new Error('invalid_object');
  } catch {
    return sonicError('INVALID_PAYLOAD', 'Body must be valid JSON object under 8KB', 400);
  }

  // Sanitize and keep strictly strongest signals
  const sanitized = {
    title: String(payloadObj.title || '专属雷达 · 猜你喜欢').slice(0, 80),
    subtitle: String(payloadObj.subtitle || '').slice(0, 120),
    coverUrl: String(payloadObj.coverUrl || '').slice(0, 300),
    tracks: Array.isArray(payloadObj.tracks)
      ? payloadObj.tracks.slice(0, 20).map((t: any) => ({
          id: String(t.id || ''),
          title: String(t.title || t.name || '').slice(0, 100),
          artist: String(t.artist || '').slice(0, 80),
          cover: String(t.cover || '').slice(0, 300),
          duration: Number(t.duration || 0),
          tag: String(t.tag || '推荐').slice(0, 20),
          replayed: !!t.replayed,
        }))
      : [],
    signals: {
      topArtists: Array.isArray(payloadObj.signals?.topArtists)
        ? payloadObj.signals.topArtists.slice(0, 10).map((a: unknown) => String(a).slice(0, 60))
        : [],
      recentQueries: Array.isArray(payloadObj.signals?.recentQueries)
        ? payloadObj.signals.recentQueries.slice(0, 8).map((q: unknown) => String(q).slice(0, 60))
        : [],
      totalReplays: Number(payloadObj.signals?.totalReplays || 0),
    },
    updatedAt: Date.now(),
  };

  const payloadJson = JSON.stringify(sanitized);

  if (config.enableLocalEngine) {
    await callLocalEngineJson<any>('/api/sonic/recommend/radar-album', env, {
      request,
      method: 'POST',
      body: payloadJson,
      timeoutMs: config.engineTimeoutMs,
    });
  }

  const store = getRecommendStore(env);
  store.saveUserRadarProfile?.(identity.subjectKey, payloadJson);

  return jsonResponse(
    {
      brand: 'Sonic',
      ok: true,
      syncedAt: sanitized.updatedAt,
      trackCount: sanitized.tracks.length,
    },
    {
      status: 200,
      headers: buildGatewayHeaders(privateHeaders, false, 'CLOSED'),
    },
  );
}

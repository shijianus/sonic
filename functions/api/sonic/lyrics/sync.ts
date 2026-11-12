// GET /api/sonic/lyrics/sync
// Sonic Gateway — High-Precision Synchronized Lyrics Endpoint for Blogs & External Widgets
// Supports format: 'sonic' (default), 'lrc', 'ttml', 'json'

import type { SonicLyricsResponse } from '../../../_lib/sonic/types';
import { parseLyricsParams, sonicError, handleOptions, LYRICS_CACHE_CONTROL } from '../../../_lib/sonic/route-helpers';
import { resolveNexusLyrics } from '../../../_lib/sonic/nexus-lyrics';
import { jsonResponse } from '../../../_lib/http';
import { sonicLinesToLrc, sonicLinesToTtml } from '../../../_lib/sonic/utils';
import { checkEngineAccess, evaluateGatewayRateLimit, buildRateLimitErrorResponse } from '../../../_lib/sonic/security';

export async function onRequest({ request, env }: any): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(
      { brand: 'Sonic', error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      { status: 405 },
    );
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'sonic-lyrics-sync');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const url = new URL(request.url);
  const params = parseLyricsParams(url);
  const format = (url.searchParams.get('format') || 'sonic').toLowerCase();

  const hasId = params.ncmMusicId || params.qqMusicId || params.appleMusicId || params.spotifyId || params.isrc || params.platformId;
  if (!params.title && !params.artist && !hasId) {
    return sonicError('MISSING_PARAMS', 'At least one of: title, artist, or platformId is required', 400, {
      provider: 'sync',
    });
  }

  const startTime = Date.now();
  try {
    const result = await resolveNexusLyrics(params, env, { request });
    const latencyMs = Date.now() - startTime;

    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'X-Sonic-Cache': 'MISS',
      'X-Sonic-Provider': result.provider,
      'X-Sonic-Level': result.data.level,
      'Cache-Control': LYRICS_CACHE_CONTROL,
    };

    if (format === 'lrc') {
      const lrcText = result.data.plainLyrics && /\[\d{2}:\d{2}/.test(result.data.plainLyrics)
        ? result.data.plainLyrics
        : sonicLinesToLrc(result.data.syncedLyrics, result.data.track.title, result.data.track.artist);
      return new Response(lrcText, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }

    if (format === 'ttml') {
      const ttmlContent = result.data.rawTtml || sonicLinesToTtml(result.data.syncedLyrics, result.data.track.title, result.data.track.artist);
      return new Response(ttmlContent, {
        status: 200,
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/ttml+xml; charset=utf-8',
        },
      });
    }

    if (format === 'json') {
      const simplified = {
        title: result.data.track.title,
        artist: result.data.track.artist,
        album: result.data.track.album,
        instrumental: result.data.instrumental,
        provider: result.provider,
        level: result.data.level,
        lyrics: result.data.syncedLyrics.map((l) => ({
          time: l.startMs,
          duration: l.durationMs,
          text: l.text,
          words: l.words,
        })),
      };
      return jsonResponse(simplified, { status: 200, headers: baseHeaders });
    }

    // Default: 'sonic' format
    const response: SonicLyricsResponse = {
      brand: 'Sonic',
      data: result.data,
      meta: {
        cached: false,
        cacheLevel: 'none',
        qualityScore: result.qualityScore,
        matchLevel: result.matchLevel,
        matchScore: result.matchScore,
        latencyMs,
        requested: params.prefer || 'auto',
        provider: result.provider,
        attempts: result.attempts,
      },
    };

    return jsonResponse(response, { status: 200, headers: baseHeaders });
  } catch (err: any) {
    request.signal.throwIfAborted();
    const latencyMs = Date.now() - startTime;
    return sonicError('SYNC_ERROR', err?.message || 'Failed to sync lyrics', 500, {
      provider: 'sync',
      latencyMs,
    });
  }
}

// GET /api/sonic/forward
// Sonic Gateway — Unified Aggregation Forwarding Gateway
// Supports multi-type forwarding: lyrics sync, search aggregation, and external asset proxying.

import { parseLyricsParams, parseSearchParams, sonicError, handleOptions, LYRICS_CACHE_CONTROL } from '../../_lib/sonic/route-helpers';
import { resolveNexusLyrics } from '../../_lib/sonic/nexus-lyrics';
import { searchNexus } from '../../_lib/sonic/nexus-search';
import { UPSTREAM_TIMEOUT } from '../../_lib/sonic/request-budget';
import { jsonResponse } from '../../_lib/http';
import { sonicLinesToLrc, sonicLinesToTtml } from '../../_lib/sonic/utils';
import { SONIC_UA } from '../../_lib/sonic/config';
import { getAllowedMediaDomains, type ContentCapability } from '../../_lib/sonic/licensing';
import { isMediaContentType, withMediaStreamLimit } from '../../_lib/sonic/media-concurrency';
import { recordLicensingBlockMetric, redactSensitiveString } from '../../_lib/sonic/observability';
import {
  checkEngineAccess,
  evaluateGatewayRateLimit,
  buildRateLimitErrorResponse,
  buildSafeUpstreamResponseHeaders,
  validateSafeUrl,
  safeFetch,
  hasSensitiveMediaQuery,
  isSafeFetchCapacityError,
} from '../../_lib/sonic/security';

// Everything relayed here is served from the Sonic origin. Reject document-capable types
// (HTML, XHTML, SVG) so an allowlisted host cannot become a same-origin script vector.
const FORWARDABLE_TEXTUAL_TYPES = new Set([
  'text/plain',
  'text/xml',
  'application/xml',
  'application/json',
  'application/ttml+xml',
  'application/ttml',
  'application/lrc',
]);

function isForwardableAssetType(contentType: string | null, capability?: ContentCapability): boolean {
  if (capability === 'audio') return isMediaContentType(contentType);
  const value = (contentType || '').split(';')[0].trim().toLowerCase();
  const isRaster = value.startsWith('image/') && value !== 'image/svg+xml' && value !== 'image/svg';
  if (capability === 'cover') return isRaster;
  if (capability === 'catalog') return value === 'application/json' || value === 'text/plain';
  if (capability === 'lyrics') return FORWARDABLE_TEXTUAL_TYPES.has(value);
  return isRaster || FORWARDABLE_TEXTUAL_TYPES.has(value);
}

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
  const rl = await evaluateGatewayRateLimit(request, env, 'sonic-forward');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || '').trim().toLowerCase();
  const targetUrl = url.searchParams.get('url') || url.searchParams.get('target');

  // Case 1: External URL Proxy / Forwarding (e.g. lyrics URL, audio stream, covers)
  if (targetUrl) {
    const capability = type === 'video' ? 'audio' :
      type === 'audio' || type === 'cover' || type === 'lyrics' || type === 'catalog' ? type : undefined;
    const respond = () => forwardAsset(targetUrl, capability);
    return capability === 'audio' ? withMediaStreamLimit(request, env, respond) : respond();
  }

  async function forwardAsset(target: string, capability?: ContentCapability): Promise<Response> {
    try {
      const allowedDomains = getAllowedMediaDomains(env, capability);
      if (allowedDomains.length === 0) {
        recordLicensingBlockMetric('forward-url');
        return sonicError(
          'SOURCE_DISABLED_BY_POLICY',
          'External asset forwarding is disabled by strict server content policy',
          403,
          { provider: 'forward' },
        );
      }

      const valResult = validateSafeUrl(target, {
        allowHttp: false,
        allowedDomains,
      });
      if (!valResult.valid || !valResult.url) {
        return sonicError(
          'INVALID_TARGET',
          valResult.error || 'Only public https URLs matching allowed music domains are permitted',
          400,
          { provider: 'forward' },
        );
      }

      const forwardHeaders = new Headers();
      forwardHeaders.set('User-Agent', SONIC_UA);
      const h = valResult.url.hostname.toLowerCase();
      if (h === 'gtimg.cn' || h.endsWith('.gtimg.cn') || h === 'qq.com' || h.endsWith('.qq.com')) {
        forwardHeaders.set('Referer', 'https://y.qq.com/');
      } else if (
        h === '126.net' ||
        h.endsWith('.126.net') ||
        h === '163.com' ||
        h.endsWith('.163.com')
      ) {
        forwardHeaders.set('Referer', 'https://music.163.com/');
      } else if (h === 'kugou.com' || h.endsWith('.kugou.com')) {
        forwardHeaders.set('Referer', 'https://www.kugou.com/');
      } else if (h === 'kuwo.cn' || h.endsWith('.kuwo.cn')) {
        forwardHeaders.set('Referer', 'https://www.kuwo.cn/');
      }

      const range = request.headers.get('Range');
      if (range) forwardHeaders.set('Range', range);

      const forwardMaxBytes = (capability === 'audio' ? 128 : capability === 'cover' ? 16 : 8) * 1024 * 1024;
      const upstreamResp = await safeFetch(
        valResult.url,
        {
          method: request.method,
          headers: forwardHeaders,
          signal: request.signal,
        },
        {
          allowHttp: false,
          allowedDomains,
          maxRedirects: 3,
          timeoutMs: 15000,
          maxBytes: forwardMaxBytes,
          includeMetadata: true,
          // Audio forwards share the media pool so slow streams cannot starve
          // cover/JSON proxying (audit P1-3).
          pool: capability === 'audio' ? 'media' : 'json',
        },
      );

      const upstreamSensitive = Boolean(upstreamResp.sensitive);
      const finalTargetUrl = upstreamResp.finalUrl || valResult.url;

      if (!upstreamResp.ok && upstreamResp.status !== 206) {
        upstreamResp.body?.cancel().catch(() => {});
        return sonicError(
          'UPSTREAM_ASSET_UNAVAILABLE',
          `Upstream asset returned HTTP ${upstreamResp.status}`,
          upstreamResp.status >= 400 && upstreamResp.status < 500 ? upstreamResp.status : 502,
          { provider: 'forward' },
        );
      }

      // Relay only asset-safe headers: upstream Set-Cookie must never be planted on the Sonic
      // origin, and Content-Encoding must not be forwarded for an already-decoded body.
      if (!isForwardableAssetType(upstreamResp.headers.get('content-type'), capability)) {
        upstreamResp.body?.cancel().catch(() => {});
        return sonicError(
          'UNSUPPORTED_CONTENT_TYPE',
          'Upstream content type does not match the requested asset type. Use type=audio for media.',
          415,
          { provider: 'forward' },
        );
      }

      const responseHeaders = buildSafeUpstreamResponseHeaders(upstreamResp.headers, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'X-Sonic-Forwarded': 'true',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      });
      const upstreamCc = (upstreamResp.headers.get('cache-control') || '').toLowerCase();
      if (
        capability === 'lyrics' || upstreamSensitive || hasSensitiveMediaQuery(finalTargetUrl) ||
        upstreamCc.includes('private') ||
        upstreamCc.includes('no-store')
      ) {
        responseHeaders.set('Cache-Control', LYRICS_CACHE_CONTROL);
      }

      return new Response(upstreamResp.body, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: responseHeaders,
      });
    } catch (err: any) {
      request.signal.throwIfAborted();
      if (isSafeFetchCapacityError(err)) {
        const busy = sonicError('UPSTREAM_BUSY', 'Upstream capacity is temporarily exhausted', 503, {
          provider: 'forward',
        });
        busy.headers.set('Retry-After', '1');
        return busy;
      }
      return sonicError('FORWARD_ERROR', redactSensitiveString(err?.message || 'Failed to forward request to target'), 502, {
        provider: 'forward',
      });
    }
  }

  // Case 2: Search Forwarding (type=search or q is present without lyrics identifiers)
  const query = url.searchParams.get('q') || url.searchParams.get('keyword');
  if (type === 'search' || (query && !url.searchParams.has('title') && !url.searchParams.has('platformId'))) {
    const { page, count } = parseSearchParams(url);
    if (!query) {
      return sonicError('MISSING_QUERY', 'Search keyword (q or keyword) is required', 400, {
        provider: 'forward',
      });
    }

    const startTime = Date.now();
    try {
      const result = await searchNexus(query, { page, count, signal: request.signal }, env);
      const latencyMs = Date.now() - startTime;
      const timedOut = result.attempts.some(attempt => attempt.errorCode === UPSTREAM_TIMEOUT);

      return jsonResponse(
        {
          brand: 'Sonic',
          data: result.data,
          meta: {
            cached: false,
            cacheLevel: 'none',
            latencyMs,
            provider: 'nexus',
            forwarded: true,
            attempts: result.attempts,
          },
        },
        {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Cache-Control': timedOut ? 'no-store' : 'public, max-age=3600',
            'X-Sonic-Cache': 'MISS',
            'X-Sonic-Provider': 'nexus',
          },
        },
      );
    } catch (err: any) {
      request.signal.throwIfAborted();
      return sonicError('SEARCH_ERROR', redactSensitiveString(err?.message || 'Search forward failed'), 502, {
        provider: 'forward',
      });
    }
  }

  // Case 3: Lyrics Synchronization Forwarding (Default mode)
  const lyricsParams = parseLyricsParams(url);
  const format = (url.searchParams.get('format') || 'sonic').toLowerCase();

  const hasId = lyricsParams.ncmMusicId || lyricsParams.qqMusicId || lyricsParams.appleMusicId || lyricsParams.spotifyId || lyricsParams.isrc || lyricsParams.platformId;
  if (!lyricsParams.title && !lyricsParams.artist && !hasId) {
    return sonicError('MISSING_PARAMS', 'At least one of: title, artist, or platformId is required for lyrics forward', 400, {
      provider: 'forward',
    });
  }

  const startTime = Date.now();
  try {
    const result = await resolveNexusLyrics(lyricsParams, env, { request });
    const latencyMs = Date.now() - startTime;

    const baseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'X-Sonic-Cache': 'MISS',
      'X-Sonic-Provider': result.provider,
      'X-Sonic-Level': result.data.level,
      'X-Sonic-Forwarded': 'true',
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
    const response = {
      brand: 'Sonic',
      data: result.data,
      meta: {
        cached: false,
        cacheLevel: 'none',
        qualityScore: result.qualityScore,
        matchLevel: result.matchLevel,
        matchScore: result.matchScore,
        latencyMs,
        requested: lyricsParams.prefer || 'auto',
        provider: result.provider,
        attempts: result.attempts,
        forwarded: true,
      },
    };

    return jsonResponse(response, { status: 200, headers: baseHeaders });
  } catch (err: any) {
    request.signal.throwIfAborted();
    const latencyMs = Date.now() - startTime;
    return sonicError('FORWARD_LYRICS_ERROR', redactSensitiveString(err?.message || 'Lyrics forward failed'), 500, {
      provider: 'forward',
      latencyMs,
    });
  }
}

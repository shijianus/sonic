import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import { getUniversalLyrics } from '../../_lib/music';
import { checkEngineAccess, evaluateGatewayRateLimit, buildRateLimitErrorResponse } from '../../_lib/sonic/security';
import { LYRICS_CACHE_CONTROL } from '../../_lib/sonic/route-helpers';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv; waitUntil?: (promise: Promise<any>) => void }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'music-lyric');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const url = new URL(request.url);
  const id = url.searchParams.get('id')?.trim().slice(0, 128) || undefined;
  const source = url.searchParams.get('source')?.trim().slice(0, 32) || 'netease';
  const title = (url.searchParams.get('title') || url.searchParams.get('name'))?.trim().slice(0, 200) || undefined;
  const artist = (url.searchParams.get('artist') || url.searchParams.get('singer'))?.trim().slice(0, 200) || undefined;
  const album = url.searchParams.get('album')?.trim().slice(0, 200) || undefined;
  const q = (url.searchParams.get('q') || url.searchParams.get('keyword'))?.trim().slice(0, 256) || undefined;
  const durationStr = url.searchParams.get('duration');
  const duration = durationStr ? parseFloat(durationStr) : undefined;

  if (!id && !title && !artist && !q) {
    return errorResponse('缺少歌词查询参数 (Parameter id, title, artist or q is required)', 400);
  }

  const format = url.searchParams.get('format')?.toLowerCase() || 'json';

  let cleanId = id;
  let effectiveSource = source;
  if (cleanId?.startsWith('qq:')) {
    cleanId = cleanId.slice(3);
    effectiveSource = 'tencent';
  } else if (cleanId?.startsWith('kugou:')) {
    cleanId = cleanId.slice(6);
    effectiveSource = 'kugou';
  } else if (cleanId && /^00[a-zA-Z0-9]{12}$/.test(cleanId) && effectiveSource === 'netease') {
    effectiveSource = 'tencent';
  } else if (cleanId && /^[a-fA-F0-9]{32}$/.test(cleanId) && effectiveSource === 'netease') {
    effectiveSource = 'kugou';
  }

  try {
    const lyricPayload = await getUniversalLyrics(env, {
      id: cleanId,
      source: effectiveSource,
      title,
      artist,
      q,
      duration,
      signal: request.signal,
    });

    const cacheHeaders = {
      'Cache-Control': LYRICS_CACHE_CONTROL,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    };

    let response: Response;

    if (format === 'ttml' || format === 'xml') {
      response = new Response(lyricPayload.ttml || '', {
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          ...cacheHeaders,
        },
      });
    } else if (format === 'elrc' || format === 'lrc' || format === 'text') {
      response = new Response(lyricPayload.elrc || lyricPayload.rawLyric || '', {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...cacheHeaders,
        },
      });
    } else {
      let standardLrc = '';
      if (lyricPayload.lines && lyricPayload.lines.length > 0) {
        standardLrc = lyricPayload.lines
          .map((line) => {
            const totalSec = Math.max(0, (line.time || (line.timeSec ? line.timeSec * 1000 : 0)) / 1000);
            const mins = Math.floor(totalSec / 60);
            const secs = (totalSec % 60).toFixed(2);
            const timeStr = `${String(mins).padStart(2, '0')}:${secs.padStart(5, '0')}`;
            return `[${timeStr}]${line.text}`;
          })
          .join('\n');
      } else if (lyricPayload.rawLyric && !lyricPayload.rawLyric.startsWith('{')) {
        standardLrc = lyricPayload.rawLyric;
      }

      response = jsonResponse(
        {
          code: 200,
          ...lyricPayload,
          album: album || undefined,
          // Standard NetEase Cloud client compatibility
          lrc: {
            version: 1,
            lyric: standardLrc,
          },
          klyric: {
            version: 1,
            lyric: '',
          },
          tlyric: {
            version: 1,
            lyric: '',
          },
          romalrc: {
            version: 1,
            lyric: '',
          },
          // 向前兼容历史字段与开放生态
          lyric: lyricPayload.rawLyric,
          parsed: lyricPayload.lines,
          elrc: lyricPayload.elrc,
          ttml: lyricPayload.ttml,
        },
        200,
        cacheHeaders,
      );
    }

    return response;
  } catch (err: any) {
    request.signal.throwIfAborted();
    console.error('[Sonic Music Lyric Error]', err);
    return errorResponse(err?.message || '获取歌词失败', 502, {
      'Cache-Control': 'public, max-age=30',
      'Access-Control-Allow-Origin': '*',
    });
  }
}


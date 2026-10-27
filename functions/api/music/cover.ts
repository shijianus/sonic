import { handleOptions } from '../../_lib/http';
import { fetchMusicProvider } from '../../_lib/music';
import { getSonicConfig } from '../../_lib/sonic/config';
import {
  callNeteaseLinuxApi,
  resolveKugouCoverUrl,
  resolveNeteaseCoverUrl,
  resolveQQCoverUrl,
} from '../../_lib/sonic/native-protocols';
import {
  checkEngineAccess,
  evaluateGatewayRateLimit,
  buildRateLimitErrorResponse,
  getAllowedMusicDomains,
  hostMatchesDomain,
  safeFetch,
  validateSafeUrl,
} from '../../_lib/sonic/security';
import {
  getContentType,
  isAllowedContentType,
  parseByteLimit,
  parseConcurrency,
  parseMaxRedirects,
  parseTimeoutMs,
  readBodyWithLimit,
} from '../../_lib/sonic/proxy-safety';
import type { AppEnv } from '../../_lib/types';

const DEFAULT_COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <defs>
    <linearGradient id="sonicCoverGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="50%" stop-color="#ec4899"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="300" height="300" rx="28" fill="url(#sonicCoverGrad)"/>
  <circle cx="150" cy="150" r="54" fill="rgba(255,255,255,0.18)"/>
  <path d="M142 118v46a18 18 0 1 0 12 17v-40l24-7v-16z" fill="#ffffff"/>
</svg>`;

function coverHeaders(contentType: string, contentLength: number): Headers {
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
}

function svgResponse(degraded = false, isHead = false): Response {
  const body = new TextEncoder().encode(DEFAULT_COVER_SVG);
  const headers = coverHeaders('image/svg+xml; charset=utf-8', body.byteLength);
  headers.set('Cache-Control', 'public, max-age=3600');
  headers.set('X-Sonic-Cover-Fallback', 'svg');
  if (degraded) headers.set('X-Sonic-Degraded', '1');
  return new Response(isHead ? null : body, { status: 200, headers });
}

function getRefererForHost(hostname: string): string {
  if (hostMatchesDomain(hostname, 'qqmusic.qq.com') || hostMatchesDomain(hostname, 'y.qq.com') || hostMatchesDomain(hostname, 'gtimg.cn')) {
    return 'https://y.qq.com/';
  }
  if (hostMatchesDomain(hostname, 'music.126.net') || hostMatchesDomain(hostname, 'vod.126.net') || hostMatchesDomain(hostname, 'music.163.com')) {
    return 'https://music.163.com/';
  }
  if (hostMatchesDomain(hostname, 'kugou.com')) return 'https://www.kugou.com/';
  if (hostMatchesDomain(hostname, 'kuwo.cn')) return 'https://www.kuwo.cn/';
  return '';
}

async function proxyImage(
  imageUrl: string,
  providerTag: string,
  env: AppEnv,
  isHead: boolean,
): Promise<Response | null> {
  const allowedDomains = getAllowedMusicDomains(env);
  const valResult = validateSafeUrl(imageUrl, { allowHttp: false, allowedDomains });
  if (!valResult.valid || !valResult.url) return null;

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
  };
  const referer = getRefererForHost(valResult.url.hostname);
  if (referer) headers.Referer = referer;

  try {
    const upstream = await safeFetch(
      valResult.url,
      { method: isHead ? 'HEAD' : 'GET', headers },
      {
        allowHttp: false,
        allowedDomains,
        maxRedirects: parseMaxRedirects(env.SONIC_PROXY_MAX_REDIRECTS),
        timeoutMs: parseTimeoutMs(env.SONIC_PROXY_TIMEOUT_MS, 6000),
        maxConcurrency: parseConcurrency(env.SONIC_PROXY_MAX_CONCURRENCY),
      },
    );

    if (!upstream.ok) {
      upstream.body?.cancel().catch(() => {});
      return null;
    }

    const contentType = getContentType(upstream);
    if (!isAllowedContentType(contentType, 'image')) {
      upstream.body?.cancel().catch(() => {});
      return null;
    }

    if (isHead) {
      const length = parseInt(upstream.headers.get('content-length') || '0', 10) || 0;
      upstream.body?.cancel().catch(() => {});
      const responseHeaders = coverHeaders(contentType, length);
      responseHeaders.set('X-Sonic-Provider', providerTag);
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    const bytes = await readBodyWithLimit(
      upstream,
      parseByteLimit(env.SONIC_COVER_MAX_BYTES, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    );
    const responseHeaders = coverHeaders(contentType, bytes.byteLength);
    responseHeaders.set('X-Sonic-Provider', providerTag);
    return new Response(bytes, { status: 200, headers: responseHeaders });
  } catch {
    return null;
  }
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const isHead = request.method === 'HEAD';
  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'music-cover');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const cfg = getSonicConfig(env);
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url') || url.searchParams.get('target');
  const id = url.searchParams.get('id') || '';
  const source = (url.searchParams.get('source') || 'netease').toLowerCase();
  const artist = url.searchParams.get('artist') || '';
  const cleanId = id.trim();
  const pPrefix = cfg.runtime === 'linux-engine' ? 'local-' : '';

  if (targetUrl) {
    const proxied = await proxyImage(targetUrl, `${pPrefix}proxy`, env, isHead);
    if (proxied) return proxied;
  }

  if (cleanId) {
    if (cleanId.startsWith('http://') || cleanId.startsWith('https://')) {
      const proxied = await proxyImage(cleanId, `${pPrefix}url`, env, isHead);
      if (proxied) return proxied;
    }

    if (source === 'netease' || source === 'ncm' || source === 'sonic' || (source === 'gdstudio' && /^\d+$/.test(cleanId))) {
      const picUrl = await resolveNeteaseCoverUrl(cleanId, env);
      if (picUrl) {
        const proxied = await proxyImage(picUrl, `${pPrefix}netease`, env, isHead);
        if (proxied) return proxied;
      }

      if (cfg.enableGdstudio) {
        try {
          const picData = await fetchMusicProvider(env, { types: 'pic', id: cleanId, source: 'netease' });
          if (picData?.url && typeof picData.url === 'string') {
            const proxied = await proxyImage(picData.url, 'gdstudio', env, isHead);
            if (proxied) return proxied;
          }
        } catch {}
      }
    }

    if (source === 'qq' || source === 'tencent') {
      const qqPicUrl = await resolveQQCoverUrl(cleanId, env);
      if (qqPicUrl) {
        const proxied = await proxyImage(qqPicUrl, `${pPrefix}qq`, env, isHead);
        if (proxied) return proxied;
      }
      const singerPhotoUrl = `https://y.gtimg.cn/music/photo_new/T001R300x300M000${cleanId}.jpg`;
      const proxiedSinger = await proxyImage(singerPhotoUrl, `${pPrefix}qq-singer`, env, isHead);
      if (proxiedSinger) return proxiedSinger;
    }

    if (source === 'kugou') {
      const kgPicUrl = await resolveKugouCoverUrl(cleanId, env);
      if (kgPicUrl) {
        const proxied = await proxyImage(kgPicUrl, `${pPrefix}kugou`, env, isHead);
        if (proxied) return proxied;
      }
    }
  }

  if (artist && artist.trim()) {
    const cleanArtist = artist.trim().split(/[/&,、]/)[0]?.trim() || artist.trim();
    if (cfg.ncmApiUrl) {
      try {
        const aRes = await fetch(
          `${cfg.ncmApiUrl}/cloudsearch?keywords=${encodeURIComponent(cleanArtist)}&type=100&limit=1&realIP=${encodeURIComponent(cfg.realIp)}`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (aRes.ok) {
          const aJson = (await aRes.json()) as any;
          const aItem = aJson?.result?.artists?.[0];
          const artPic = aItem?.img1v1Url || aItem?.picUrl;
          if (artPic) {
            const proxied = await proxyImage(String(artPic).replace('http://', 'https://'), `${pPrefix}netease-artist`, env, isHead);
            if (proxied) return proxied;
          }
        }
      } catch {}
    }

    try {
      const artJson = await callNeteaseLinuxApi(
        {
          method: 'POST',
          url: 'http://music.163.com/api/cloudsearch/pc',
          params: { s: cleanArtist, type: 100, limit: 1, offset: 0 },
        },
        env,
        AbortSignal.timeout(4500),
      );
      const aItem = artJson?.result?.artists?.[0];
      const artPic = aItem?.img1v1Url || aItem?.picUrl;
      if (artPic) {
        const proxied = await proxyImage(String(artPic).replace('http://', 'https://'), `${pPrefix}netease-artist`, env, isHead);
        if (proxied) return proxied;
      }
    } catch {}
  }

  return svgResponse(false, isHead);
}

export const onRequestGet = onRequest;

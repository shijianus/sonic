// Sonic Gateway — Commercial Upstream Aggregation & Desensitization
// Bridges standard music platform requests (home, playlists, MVs, charts, artists) to high-availability upstreams,
// with complete desensitization, privacy anonymization, and Edge CDN caching.

import { jsonResponse, handleOptions } from '../http';
import { BRAND_PRODUCT } from '../brand';
import { getSonicConfig, SONIC_UA } from './config';
import { callLocalEngineJson } from './local-engine';
import { checkEngineAccess, evaluateGatewayRateLimit, buildRateLimitErrorResponse } from './security';
import { recordLicensingBlockMetric } from './observability';
import { callNeteaseLinuxApi, callNeteaseEapi } from './native-protocols';
import { getSonicCachedJson, putSonicCachedJson } from './cache';
import type { AppEnv } from '../types';

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(8000),
  });
}

function buildUpstreamHeaders(realIp: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://music.163.com',
    'Accept': '*/*',
    'Cookie': 'os=pc; appver=2.9.7;',
  };
  if (realIp) headers['X-Real-IP'] = realIp;
  return headers;
}

// Popular curated artists with high-res avatars
// Popular curated artists with high-res avatars
const TOP_ARTISTS_CATALOG = [
  { id: 6452, name: '周杰伦', picUrl: 'https://p2.music.126.net/NWv6PtSBkyWZzqbJVzBr7g==/109951169164936450.jpg', musicSize: 420, albumSize: 38 },
  { id: 3684, name: '林俊杰', picUrl: 'https://p2.music.126.net/78q0jUUJ0h08GxAs2G-tCA==/109951168529051968.jpg', musicSize: 390, albumSize: 35 },
  { id: 2116, name: '陈奕迅', picUrl: 'https://p2.music.126.net/5KJI2mq0G0OQHQaAfAJfwg==/109951173289563385.jpg', musicSize: 380, albumSize: 42 },
  { id: 5781, name: '薛之谦', picUrl: 'https://p2.music.126.net/Z2x6knGRr7eRrZeOlgCngA==/109951172414270313.jpg', musicSize: 210, albumSize: 18 },
  { id: 7763, name: 'G.E.M.邓紫棋', picUrl: 'https://y.gtimg.cn/music/photo_new/T001R300x300M000001fNHEf1SFEFN.jpg', musicSize: 260, albumSize: 24 },
  { id: 4292, name: '李荣浩', picUrl: 'https://p2.music.126.net/FlL7wkN6VBoGTj3Df7s2_w==/109951170316908673.jpg', musicSize: 180, albumSize: 15 },
  { id: 5771, name: '许嵩', picUrl: 'https://p2.music.126.net/FLHG9Ou-sIq9F6dPe7SuNw==/109951169440811453.jpg', musicSize: 195, albumSize: 16 },
  { id: 29051613, name: '郑润泽', picUrl: 'https://p2.music.126.net/BtXjoRNLCZjoSV-3Ag3M0Q==/109951164458656122.jpg', musicSize: 130, albumSize: 10 },
  { id: 5538, name: '汪苏泷', picUrl: 'https://p2.music.126.net/YrjCHWk_OQhjlc5ycLpY3A==/109951172494696852.jpg', musicSize: 250, albumSize: 20 },
  { id: 2738, name: '方大同', picUrl: 'https://p2.music.126.net/EO_mrK1Hft9DpC5fr9ROIw==/109951169897875877.jpg', musicSize: 180, albumSize: 15 },
  { id: 5196, name: '陶喆', picUrl: 'https://p2.music.126.net/7FWLQ9Vm_po0VS7ptLTFiQ==/109951170606711717.jpg', musicSize: 190, albumSize: 16 },
  { id: 6731, name: '赵雷', picUrl: 'https://p2.music.126.net/j6KWzSdlRKzZUwJnQx3vBA==/3300733912483912.jpg', musicSize: 120, albumSize: 8 },
  { id: 6472, name: '张杰', picUrl: 'https://p2.music.126.net/PxsdyHtM0yMi1cIIDk_MFw==/109951169294511651.jpg', musicSize: 280, albumSize: 25 },
  { id: 1143033, name: '队长', picUrl: 'https://p2.music.126.net/bFUIuxjaooW5dH98_NaAoA==/109951170827419881.jpg', musicSize: 110, albumSize: 9 },
  { id: 31376161, name: '颜人中', picUrl: 'https://p2.music.126.net/M9GvSuKJQyfPKprZaLKt7A==/109951165122696427.jpg', musicSize: 100, albumSize: 8 },
  { id: 9621, name: '王菲', picUrl: 'https://p1.music.126.net/5XK6juNImi6Au60YCCcCtA==/109951170501527382.jpg', musicSize: 310, albumSize: 32 },
];

// Trending hot searches
const HOT_SEARCH_LIST = [
  { searchWord: '周杰伦', score: 988000, iconType: 1, content: '华语流行天王精选作品' },
  { searchWord: '晴天', score: 865000, iconType: 1, content: '故事的小黄花，从出生那年就飘着' },
  { searchWord: '起风了', score: 792000, iconType: 1, content: '我曾难自拔于世界之大' },
  { searchWord: '七里香', score: 721000, iconType: 1, content: '雨下整夜，我的爱溢出就像雨水' },
  { searchWord: '乌梅子酱', score: 654000, iconType: 0, content: '你浅浅的微笑就像乌梅子酱' },
  { searchWord: '孤勇者', score: 593000, iconType: 0, content: '爱你孤身走暗巷' },
  { searchWord: '青花瓷', score: 531000, iconType: 0, content: '天青色等烟雨，而我在等你' },
  { searchWord: '稻香', score: 489000, iconType: 0, content: '回家吧，回到最初的美好' },
  { searchWord: '如愿', score: 452000, iconType: 0, content: '山河无恙，烟火寻常' },
  { searchWord: '突然好想你', score: 418000, iconType: 0, content: '你会在哪里，过得快乐或委屈' },
];

/**
 * Deep desensitize text & objects by replacing third-party provider brands with the product brand
 */
export function desensitizeData<T>(obj: T): T {
  if (!obj) return obj;
  if (typeof obj === 'string') {
    return (obj as string)
      .replace(/网易云音乐/g, BRAND_PRODUCT)
      .replace(/网易出品/g, `${BRAND_PRODUCT} 甄选`)
      .replace(/网易/g, BRAND_PRODUCT)
      .replace(/NetEase/gi, BRAND_PRODUCT) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => desensitizeData(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const copy: any = {};
    for (const [k, v] of Object.entries(obj)) {
      copy[k] = desensitizeData(v);
    }
    return copy;
  }
  return obj;
}

/**
 * Fetch and dispatch upstream endpoints
 */
export async function handleUpstreamEndpoint(
  endpoint: string,
  url: URL,
  request: Request,
  env?: AppEnv,
): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'upstream');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const cfg = getSonicConfig(env);
  const normEndpoint = endpoint.replace(/^\/+|\/+$/g, '').toLowerCase();

  // Discrepancy 7 fix: graceful response for legacy NetEase login status checks in SPA
  if (normEndpoint === 'login/status') {
    return jsonResponse({
      code: 200,
      brand: 'Sonic',
      data: { code: 200, account: null, profile: null },
      authProvider: 'epomail-oauth2',
      oauthEnabled: cfg.enableOAuth,
      loginUrl: '/api/auth/login',
    });
  }

  // Server-side content authorization gate: commercial NetEase catalog routes are blocked
  // whenever `netease` is disabled by policy (e.g. SONIC_CONTENT_POLICY=strict-allowlist).
  if (!cfg.enableNetease) {
    recordLicensingBlockMetric('netease');
    return jsonResponse(
      {
        brand: 'Sonic',
        code: 403,
        error: {
          code: 'SOURCE_DISABLED_BY_POLICY',
          message: "Commercial catalog source 'netease' is disabled by server content policy.",
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Primary Hop (when running on Cloudflare Pages): forward commercial catalog queries to Linux Local Engine
  let degradedHeader = false;
  if (cfg.enableLocalEngine) {
    const engineRes = await callLocalEngineJson<any>(`/api/${normEndpoint}${url.search}`, env, {
      request,
      timeoutMs: cfg.engineTimeoutMs,
    });
    if (engineRes.ok && engineRes.data) {
      return jsonResponse(engineRes.data, {
        headers: {
          'Cache-Control': 'public, max-age=1800',
          'X-Sonic-Provider': 'local-engine',
        },
      });
    }
    degradedHeader = true;
  }

  // Helper: on Linux VPS with internal `ncm-api` container (`NeteaseCloudMusicApiEnhanced`), try encrypted NCM API for rich commercial routes
  const ncmDirectEndpoints = new Set([
    'playlist/detail',
    'playlist/track/all',
    'toplist/detail',
    'song/detail',
    'album',
    'album/new',
    'artist/detail',
    'artist/songs',
    'artist/top/song',
    'artist/album',
    'artist/mv',
    'artists',
    'mv/all',
    'mv/first',
    'mv/detail',
    'mv/url',
    'comment/music',
    'comment/playlist',
    'comment/album',
    'comment/mv',
    'comment/new',
    'comment/hot',
    'simi/playlist',
    'related/playlist',
    'search/suggest',
  ]);
  if (cfg.ncmApiUrl && ncmDirectEndpoints.has(normEndpoint)) {
    try {
      const qs = new URLSearchParams(url.searchParams);
      qs.set('realIP', cfg.realIp);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (env?.NETEASE_COOKIE) headers.Cookie = String(env.NETEASE_COOKIE).trim();
      const ncmResp = await timedFetch(`${cfg.ncmApiUrl}/${normEndpoint}?${qs.toString()}`, {
        headers,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (ncmResp.ok) {
        const ncmData = await ncmResp.json();
        if (ncmData && (ncmData.code === 200 || ncmData.songs || ncmData.playlist || ncmData.data)) {
          return jsonResponse(desensitizeData({ brand: 'Sonic', ...ncmData }), {
            headers: {
              'Cache-Control': 'public, max-age=1800',
              'X-Sonic-Provider': 'local-netease',
            },
          });
        }
      }
    } catch {}
  }

  // 1. Banner
  if (normEndpoint === 'banner') {
    try {
      const resp = await timedFetch('https://music.163.com/api/v2/banner/get?clientType=pc', {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      if (data && data.banners) {
        // 严格屏蔽纯外部商业活动（targetType === 3000 或无有效音乐实体的外链）
        const filtered = data.banners.filter((b: any) => {
          if (b.targetType === 3000) return false;
          const tid = b.targetId || (typeof b.url === 'string' && (b.url.match(/song\/(\d+)/) || b.url.match(/album\/(\d+)/))?.[1]);
          if (!tid) return false;
          // 仅允许单曲(1)、专辑(10)、歌单(1000)、MV(1004)在站内闭环展示
          return [1, 10, 1000, 1004].includes(b.targetType);
        });

        const banners = filtered.map((b: any) => {
          const tid = b.targetId || (typeof b.url === 'string' && (b.url.match(/song\/(\d+)/) || b.url.match(/album\/(\d+)/))?.[1]);
          let internalPath = '';
          if (b.targetType === 1) internalPath = `/song/${tid}?autoplay=1`;
          else if (b.targetType === 10) internalPath = `/album/${tid}?autoplay=1`;
          else if (b.targetType === 1000) internalPath = `/playlist/${tid}`;
          else if (b.targetType === 1004) internalPath = `/mv-player/${tid}`;
          else internalPath = `/song/${tid}?autoplay=1`;

          let cleanTitle = b.typeTitle || '';
          cleanTitle = cleanTitle.replace(/网易|云音乐|首发/g, '').trim();
          if (!cleanTitle) {
            if (b.targetType === 1) cleanTitle = '新歌独家';
            else if (b.targetType === 10) cleanTitle = '新碟独家';
            else if (b.targetType === 1000) cleanTitle = '甄选歌单';
            else if (b.targetType === 1004) cleanTitle = '精选MV';
            else cleanTitle = '独家推荐';
          }

          return {
            ...b,
            targetId: tid,
            url: internalPath, // 替换为纯净的站内路由，绝不泄漏任何 orpheus:// 或外站 URL
            typeTitle: `${BRAND_PRODUCT} ${cleanTitle}`,
          };
        });

        return jsonResponse(
          { code: 200, brand: 'Sonic', banners: desensitizeData(banners) },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      }
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', banners: [] });
  }

  // 2. Playlists (Top / Highquality / Personalized)
  if (normEndpoint === 'top/playlist' || normEndpoint === 'playlist/highquality/list' || normEndpoint === 'personalized') {
    const limit = url.searchParams.get('limit') || '24';
    const cat = url.searchParams.get('cat') || '全部';
    const cacheKey = `top-playlist:${cat}:${limit}`;
    const cached = await getSonicCachedJson<any>('upstream', cacheKey, env);
    if (cached?.value && Array.isArray(cached.value.playlists) && cached.value.playlists.length >= (parseInt(limit, 10) || 24)) {
      return jsonResponse(cached.value, { headers: { 'Cache-Control': 'public, max-age=1800' } });
    }

    let playlists: any[] = [];
    let total = 0;
    let more = false;

    // 1. Primary: LinuxApi encrypted protocol
    try {
      const lRes = await callNeteaseLinuxApi(
        {
          method: 'POST',
          url: 'http://music.163.com/api/playlist/highquality/list',
          params: { cat, limit: parseInt(limit, 10) || 24 },
        },
        env,
      );
      if (lRes && Array.isArray(lRes.playlists) && lRes.playlists.length > 0) {
        playlists = lRes.playlists;
        total = lRes.total || playlists.length;
        more = lRes.more ?? false;
      }
    } catch {}

    // 2. Fallback: plaintext legacy API
    if (playlists.length === 0) {
      try {
        const resp = await timedFetch(`https://music.163.com/api/playlist/highquality/list?limit=${limit}&cat=${encodeURIComponent(cat)}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        if (data && Array.isArray(data.playlists) && data.playlists.length > 0) {
          playlists = data.playlists;
          total = data.total || playlists.length;
          more = data.more ?? false;
        }
      } catch {}
    }

    // 3. Supplement from personalized if playlists count is below requested limit
    if (playlists.length < (parseInt(limit, 10) || 24)) {
      try {
        const pResp = await timedFetch(`https://music.163.com/api/personalized?limit=${limit}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const pData: any = await pResp.json();
        const pList = Array.isArray(pData?.result) ? pData.result : [];
        const seenIds = new Set(playlists.map((p: any) => p.id));
        for (const item of pList) {
          if (item?.id && !seenIds.has(item.id)) {
            playlists.push(item);
            seenIds.add(item.id);
          }
          if (playlists.length >= (parseInt(limit, 10) || 24)) break;
        }
      } catch {}
    }

    const desensitized = (playlists || []).map((p: any) => ({
      ...p,
      copywriter: `${BRAND_PRODUCT} 甄选歌单`,
    }));

    const resultPayload = {
      code: 200,
      brand: 'Sonic',
      playlists: desensitizeData(desensitized),
      total: total || desensitized.length,
      more,
    };

    if (desensitized.length > 0) {
      await putSonicCachedJson('upstream', cacheKey, resultPayload, 1800, 3600, env);
    }

    return jsonResponse(resultPayload, { headers: { 'Cache-Control': 'public, max-age=1800' } });
  }

  // 3. Top Songs / New Songs
  if (normEndpoint === 'top/song' || normEndpoint === 'personalized/newsong') {
    try {
      const resp = await timedFetch('https://music.163.com/api/v1/discovery/new/songs', {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      const songs = (data.data || []).map((s: any) => ({
        ...s,
        duration: s.duration || (s.dt ? Math.floor(s.dt / 1000) : 0),
        dt: s.dt || (s.duration ? s.duration * 1000 : 0),
      }));
      return jsonResponse(
        { code: 200, brand: 'Sonic', data: desensitizeData(songs) },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', data: [] });
  }

  // 4. Artists (Top / List)
  if (normEndpoint === 'top/artists' || normEndpoint === 'artist/list') {
    const limit = parseInt(url.searchParams.get('limit') || '16', 10);
    try {
      const resp = await timedFetch(`https://music.163.com/api/artist/list?categoryCode=1001&limit=${limit}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        if (Array.isArray(data?.artists) && data.artists.length > 0) {
          const artists = data.artists.map((a: any) => ({
            id: a.id,
            name: a.name,
            picUrl: (a.picUrl || a.img1v1Url || '').replace('http://', 'https://'),
            img1v1Url: (a.img1v1Url || a.picUrl || '').replace('http://', 'https://'),
            musicSize: a.musicSize || 0,
            albumSize: a.albumSize || 0,
          }));
          return jsonResponse(
            { code: 200, brand: 'Sonic', artists: desensitizeData(artists), more: data.hasMore ?? false },
            { headers: { 'Cache-Control': 'public, max-age=86400' } },
          );
        }
      }
    } catch {}

    const artists = TOP_ARTISTS_CATALOG.slice(0, limit);
    return jsonResponse(
      { code: 200, brand: 'Sonic', artists: desensitizeData(artists), more: false },
      { headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  }

  // 5. Personalized MV
  if (normEndpoint === 'personalized/mv' || normEndpoint === 'mv/first') {
    const limit = parseInt(url.searchParams.get('limit') || '12', 10) || 12;
    const cacheKey = `mv:${normEndpoint}:${limit}`;
    const cached = await getSonicCachedJson<any>('upstream', cacheKey, env);
    if (cached?.value && Array.isArray(cached.value.result) && cached.value.result.length >= limit) {
      return jsonResponse(cached.value, { headers: { 'Cache-Control': 'public, max-age=3600' } });
    }

    let mvs: any[] = [];
    const seenIds = new Set<string | number>();

    // 1. Try personalized/mv if requested
    if (normEndpoint === 'personalized/mv') {
      try {
        const resp = await timedFetch('https://music.163.com/api/personalized/mv', {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        const list = Array.isArray(data?.result) ? data.result : [];
        for (const item of list) {
          if (item?.id && !seenIds.has(item.id)) {
            mvs.push(item);
            seenIds.add(item.id);
          }
        }
      } catch {}
    }

    // 2. Supplement or primary from mv/first up to limit
    if (mvs.length < limit) {
      try {
        const resp = await timedFetch(`https://music.163.com/api/mv/first?limit=${limit}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.result) ? data.result : []);
        for (const item of list) {
          if (item?.id && !seenIds.has(item.id)) {
            mvs.push(item);
            seenIds.add(item.id);
          }
          if (mvs.length >= limit) break;
        }
      } catch {}
    }

    // 3. Fallback: supplement from mv/all if still below limit
    if (mvs.length < limit) {
      try {
        const resp = await timedFetch(`https://music.163.com/api/mv/all?limit=${limit}&order=%E6%9C%80%E6%96%B0`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        const list = Array.isArray(data?.data) ? data.data : [];
        for (const item of list) {
          if (item?.id && !seenIds.has(item.id)) {
            mvs.push(item);
            seenIds.add(item.id);
          }
          if (mvs.length >= limit) break;
        }
      } catch {}
    }

    const desensitized = desensitizeData(mvs.slice(0, limit));
    const resultPayload = {
      code: 200,
      brand: 'Sonic',
      result: desensitized,
      data: desensitized,
      mvs: desensitized,
    };

    if (desensitized.length > 0) {
      await putSonicCachedJson('upstream', cacheKey, resultPayload, 1800, 3600, env);
    }

    return jsonResponse(resultPayload, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  }

  // 6. MV All
  if (normEndpoint === 'mv/all') {
    const limit = url.searchParams.get('limit') || '24';
    const offset = url.searchParams.get('offset') || '0';
    const order = url.searchParams.get('order') || '最新';
    let type = url.searchParams.get('type') || '';
    if (['Sonic出品', 'sonic出品', 'Sonic 甄选', 'sonic 甄选', 'netease'].includes(type)) type = '网易出品';

    const cacheKey = `mv:all:${type}:${order}:${limit}:${offset}`;
    const cached = await getSonicCachedJson<any>('upstream', cacheKey, env);
    if (cached?.value && Array.isArray(cached.value.data) && cached.value.data.length > 0) {
      return jsonResponse(cached.value, { headers: { 'Cache-Control': 'public, max-age=3600' } });
    }

    try {
      let rawList: any[] = [];
      let hasMore = false;
      let totalCount = 0;

      if (type === '网易出品') {
        const resp = await timedFetch(`https://music.163.com/api/mv/exclusive/rcmd?limit=${limit}&offset=${offset}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        rawList = Array.isArray(data?.data) ? data.data : [];
        hasMore = data?.hasMore ?? (rawList.length >= parseInt(limit, 10));
        totalCount = data?.count || rawList.length;
        for (const item of rawList) {
          if (!item.tag) item.tag = 'Sonic 甄选';
        }
      } else if (type === '现场版' || type === '现场' || type === 'live') {
        const sRes = await callNeteaseLinuxApi(
          {
            method: 'POST',
            url: 'http://music.163.com/api/cloudsearch/pc',
            params: {
              s: '现场',
              type: 1004,
              limit: parseInt(limit, 10),
              offset: parseInt(offset, 10),
            },
          },
          env,
        );
        rawList = Array.isArray(sRes?.result?.mvs) ? sRes.result.mvs : [];
        totalCount = sRes?.result?.mvCount || rawList.length;
        hasMore = totalCount > parseInt(offset, 10) + rawList.length;
        for (const item of rawList) {
          if (!item.tag) item.tag = '现场版';
        }
      } else if (type === '官方版' || type === '官方' || type === 'official') {
        const sRes = await callNeteaseLinuxApi(
          {
            method: 'POST',
            url: 'http://music.163.com/api/cloudsearch/pc',
            params: {
              s: '官方版',
              type: 1004,
              limit: parseInt(limit, 10),
              offset: parseInt(offset, 10),
            },
          },
          env,
        );
        rawList = Array.isArray(sRes?.result?.mvs) ? sRes.result.mvs : [];
        totalCount = sRes?.result?.mvCount || rawList.length;
        hasMore = totalCount > parseInt(offset, 10) + rawList.length;
        for (const item of rawList) {
          if (!item.tag) item.tag = '官方版';
        }
      } else if (type === '最新' || type === 'first' || type === 'latest') {
        const resp = await timedFetch(`https://music.163.com/api/mv/first?limit=${limit}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        rawList = Array.isArray(data?.data) ? data.data : [];
        hasMore = rawList.length >= parseInt(limit, 10);
        totalCount = rawList.length;
        for (const item of rawList) {
          if (!item.tag) item.tag = '最新';
        }
      } else {
        const upstreamUrl = `https://music.163.com/api/mv/all?limit=${limit}&offset=${offset}&order=${encodeURIComponent(order)}`;
        const resp = await timedFetch(upstreamUrl, { headers: buildUpstreamHeaders(cfg.realIp) });
        const data: any = await resp.json();
        rawList = Array.isArray(data?.data) ? data.data : [];
        hasMore = data.hasMore ?? false;
        totalCount = data.count || 0;
        for (const item of rawList) {
          if (!item.tag) {
            const name = item.name || item.title || '';
            if (name.includes('现场') || name.includes('Live') || name.includes('LIVE')) {
              item.tag = '现场版';
            } else if (name.includes('官方') || name.includes('Official')) {
              item.tag = '官方版';
            } else if (item.new) {
              item.tag = '最新';
            } else {
              item.tag = '精选';
            }
          }
        }
      }

      // Metadata enrichment: enrich missing desc and publishTime
      const itemsToEnrich = rawList.slice(0, 16).filter((it: any) => it?.id && (!it.publishTime || !it.desc));
      if (itemsToEnrich.length > 0) {
        await Promise.allSettled(
          itemsToEnrich.map(async (item: any) => {
            try {
              const dResp = await timedFetch(`https://music.163.com/api/mv/detail?id=${encodeURIComponent(item.id)}`, {
                headers: buildUpstreamHeaders(cfg.realIp),
                signal: AbortSignal.timeout(1800),
              });
              const dData: any = await dResp.json();
              if (dData?.data?.publishTime && !item.publishTime) item.publishTime = dData.data.publishTime;
              if (dData?.data?.desc && !item.desc) item.desc = dData.data.desc;
              if (dData?.data?.briefDesc && !item.briefDesc) item.briefDesc = dData.data.briefDesc;
            } catch {}
          }),
        );
      }

      const desensitized = desensitizeData(rawList);
      const resultPayload = {
        code: 200,
        brand: 'Sonic',
        data: desensitized,
        hasMore,
        count: totalCount,
      };

      if (desensitized.length > 0) {
        await putSonicCachedJson('upstream', cacheKey, resultPayload, 1800, 3600, env);
      }

      return jsonResponse(resultPayload, { headers: { 'Cache-Control': 'public, max-age=3600' } });
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', data: [], hasMore: false });
  }

  // 7. MV Detail
  if (normEndpoint === 'mv/detail') {
    const id = url.searchParams.get('mvid') || url.searchParams.get('id') || '';
    if (!id) return jsonResponse({ code: 400, message: 'Missing MV id' }, { status: 400 });

    try {
      const resp = await timedFetch(`https://music.163.com/api/mv/detail?id=${encodeURIComponent(id)}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      return jsonResponse(
        { code: 200, brand: 'Sonic', data: desensitizeData(data.data || {}) },
        { headers: { 'Cache-Control': 'public, max-age=7200' } },
      );
    } catch {}
    return jsonResponse({ code: 404, message: 'MV not found' }, { status: 404 });
  }

  // 8. MV Stream URL
  if (normEndpoint === 'mv/url') {
    const id = url.searchParams.get('id') || url.searchParams.get('mvid') || '';
    const r = url.searchParams.get('r') || '1080';
    if (!id) return jsonResponse({ code: 400, message: 'Missing MV id' }, { status: 400 });

    try {
      const resp = await timedFetch(`https://music.163.com/api/mv/detail?id=${encodeURIComponent(id)}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      const brs = data?.data?.brs || {};
      let streamUrl = brs[r] || brs['1080'] || brs['720'] || brs['480'] || brs['240'] || Object.values(brs)[0] || '';

      if (!streamUrl) {
        streamUrl = `https://vodkgeyttp8.vod.126.net/cloudmusic/MjQ3NDQ3MjUw/89a6a279dc2acfcd068b45ce72b1f560/533e4183a709699d566180ed0cd9abe9.mp4`;
      }

      return jsonResponse(
        {
          code: 200,
          brand: 'Sonic',
          data: { id: Number(id), url: streamUrl, r: parseInt(r, 10) || 1080 },
        },
        { headers: { 'Cache-Control': 'public, max-age=7200' } },
      );
    } catch {}
    return jsonResponse({
      code: 200,
      brand: 'Sonic',
      data: {
        id: Number(id),
        url: 'https://vodkgeyttp8.vod.126.net/cloudmusic/MjQ3NDQ3MjUw/89a6a279dc2acfcd068b45ce72b1f560/533e4183a709699d566180ed0cd9abe9.mp4',
        r: 1080,
      },
    });
  }

  // 9. Simi MV
  if (normEndpoint === 'simi/mv') {
    try {
      const resp = await timedFetch('https://music.163.com/api/mv/all?limit=10', { headers: buildUpstreamHeaders(cfg.realIp) });
      const data: any = await resp.json();
      return jsonResponse(
        { code: 200, brand: 'Sonic', mvs: desensitizeData(data.data || []) },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', mvs: [] });
  }

  // 10. Comments (Music / Playlist / Album / MV / Hot / New)
  if (
    normEndpoint === 'comment/new' ||
    normEndpoint === 'comment/music' ||
    normEndpoint === 'comment/playlist' ||
    normEndpoint === 'comment/album' ||
    normEndpoint === 'comment/mv' ||
    normEndpoint === 'comment/hot' ||
    normEndpoint === 'comment'
  ) {
    const rawId = url.searchParams.get('id') || url.searchParams.get('mvid') || '33894312';
    const id = rawId.replace(/^[a-z0-9_-]+:/i, '').trim();
    const limit = url.searchParams.get('limit') || url.searchParams.get('pageSize') || '20';
    const pageNo = parseInt(url.searchParams.get('pageNo') || '1', 10);
    const offset =
      url.searchParams.get('offset') ||
      (url.searchParams.has('pageNo')
        ? String((Math.max(1, pageNo) - 1) * parseInt(limit, 10))
        : '0');
    const before =
      url.searchParams.get('before') ||
      url.searchParams.get('cursor') ||
      url.searchParams.get('beforeTime') ||
      '';

    // Determine upstream resource thread prefix
    // 0: song (R_SO_4_), 1: mv (R_MV_5_), 2: playlist (A_PL_0_), 3: album (R_AL_3_)
    let resourcePrefix = 'R_SO_4_';
    const typeParam = url.searchParams.get('type');
    if (normEndpoint === 'comment/playlist' || typeParam === '2') {
      resourcePrefix = 'A_PL_0_';
    } else if (normEndpoint === 'comment/album' || typeParam === '3') {
      resourcePrefix = 'R_AL_3_';
    } else if (
      normEndpoint.includes('mv') ||
      url.searchParams.has('mvid') ||
      typeParam === '1' ||
      typeParam === '5'
    ) {
      resourcePrefix = 'R_MV_5_';
    } else if (normEndpoint === 'comment/music' || typeParam === '0') {
      resourcePrefix = 'R_SO_4_';
    }

    const threadId = `${resourcePrefix}${id}`;

    // 1. Primary: Direct fetch upstream resource comments
    try {
      const resp = await timedFetch(
        `https://music.163.com/api/v1/resource/comments/${encodeURIComponent(threadId)}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}${before ? `&beforeTime=${encodeURIComponent(before)}` : ''}`,
        {
          headers: buildUpstreamHeaders(cfg.realIp),
        },
      );
      const data: any = await resp.json();
      if (data && (data.code === 200 || Array.isArray(data.comments))) {
        const comments = desensitizeData(data.comments || []);
        const hotComments = desensitizeData(data.hotComments || []);
        const total = Number(data.total ?? comments.length + hotComments.length);
        const more = data.more ?? false;
        return jsonResponse(
          {
            code: 200,
            brand: 'Sonic',
            comments,
            hotComments,
            total,
            more,
            moreHot: data.moreHot ?? false,
            data: {
              comments,
              hotComments,
              total,
              hasMore: more,
            },
          },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      }
    } catch {}

    // 2. Secondary: LinuxApi encrypted protocol fallback
    try {
      const lRes = await callNeteaseLinuxApi(
        {
          method: 'GET',
          url: `http://music.163.com/api/v1/resource/comments/${encodeURIComponent(threadId)}?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}${before ? `&beforeTime=${encodeURIComponent(before)}` : ''}`,
          params: {},
        },
        env,
      );
      if (lRes && (lRes.code === 200 || Array.isArray(lRes.comments))) {
        const comments = desensitizeData(lRes.comments || []);
        const hotComments = desensitizeData(lRes.hotComments || []);
        const total = Number(lRes.total ?? comments.length + hotComments.length);
        const more = lRes.more ?? false;
        return jsonResponse(
          {
            code: 200,
            brand: 'Sonic',
            comments,
            hotComments,
            total,
            more,
            moreHot: lRes.moreHot ?? false,
            data: {
              comments,
              hotComments,
              total,
              hasMore: more,
            },
          },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      }
    } catch {}

    return jsonResponse({
      code: 200,
      brand: 'Sonic',
      comments: [],
      hotComments: [],
      total: 0,
      more: false,
      data: { comments: [], hotComments: [], total: 0, hasMore: false },
    });
  }

  // 11. Toplists / Charts
  if (normEndpoint === 'toplist/detail' || normEndpoint === 'toplist') {
    try {
      const resp = await timedFetch('https://music.163.com/api/toplist/detail', { headers: buildUpstreamHeaders(cfg.realIp) });
      const data: any = await resp.json();
      return jsonResponse(
        {
          code: 200,
          brand: 'Sonic',
          list: desensitizeData(data.list || []),
          artistToplist: desensitizeData(data.artistToplist || {}),
        },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', list: [] });
  }

  // 12. Playlist Detail & Track All
  if (normEndpoint === 'playlist/detail' || normEndpoint === 'playlist/track/all') {
    const rawId = url.searchParams.get('id') || '3778678';
    const id = rawId.replace(/^[a-z0-9_-]+:/i, '').trim();
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

    // Multi-tier cache for raw playlist data
    const playlistCacheKey = `raw-pl:${id}`;
    let p: any = null;
    const cachedPl = await getSonicCachedJson<any>('playlist-detail', playlistCacheKey, env);
    if (cachedPl?.value && (cachedPl.value.name || cachedPl.value.id)) {
      p = cachedPl.value;
    }

    if (!p) {
      // 1. Primary: LinuxApi (/api/v3/playlist/detail)
      try {
        const lRes = await callNeteaseLinuxApi(
          {
            method: 'POST',
            url: 'http://music.163.com/api/v3/playlist/detail',
            params: { id, n: 100, s: 8 },
          },
          env,
        );
        if (lRes && (lRes.code === 200 || lRes.playlist) && (lRes.playlist?.name || lRes.result?.name)) {
          p = lRes.playlist || lRes.result;
        }
      } catch {}

      // 2. Secondary: ncm-api container if available
      if (!p && cfg.ncmApiUrl) {
        try {
          const resp = await timedFetch(
            `${cfg.ncmApiUrl}/playlist/detail?id=${encodeURIComponent(id)}&realIP=${encodeURIComponent(cfg.realIp)}`,
          );
          if (resp.ok) {
            const data: any = await resp.json();
            if (data?.playlist?.name) {
              p = data.playlist;
            }
          }
        } catch {}
      }

      // 3. Fallback: plaintext legacy API
      if (!p) {
        try {
          const resp = await timedFetch(`https://music.163.com/api/playlist/detail?id=${encodeURIComponent(id)}`, {
            headers: buildUpstreamHeaders(cfg.realIp),
          });
          const data: any = await resp.json();
          const cand = data.result || data.playlist;
          if (cand && (cand.name || cand.tracks || cand.trackCount)) {
            p = cand;
          }
        } catch {}
      }

      if (p && (p.name || p.id)) {
        await putSonicCachedJson('playlist-detail', playlistCacheKey, p, 1800, 3600, env);
      }
    }

    if (!p || (!p.name && !p.id && (!p.tracks || p.tracks.length === 0))) {
      return jsonResponse({ code: 404, message: 'Playlist not found' }, { status: 404 });
    }

    if (normEndpoint === 'playlist/track/all') {
      const initialTracks = Array.isArray(p.tracks) ? p.tracks : [];
      const trackIds = Array.isArray(p.trackIds) ? p.trackIds : [];
      let songs: any[] = [];

      // If initial tracks already contains the requested slice
      if (offset + limit <= initialTracks.length) {
        songs = initialTracks.slice(offset, offset + limit);
      } else if (offset < initialTracks.length && (initialTracks.length >= trackIds.length || trackIds.length === 0)) {
        songs = initialTracks.slice(offset, offset + limit);
      } else if (trackIds.length > 0) {
        // Paging into trackIds beyond initialTracks
        const sliceIds = trackIds.slice(offset, offset + limit).map((t: any) => ({ id: t.id || t }));
        if (sliceIds.length > 0) {
          try {
            const songDetailRes = await callNeteaseLinuxApi(
              {
                method: 'POST',
                url: 'http://music.163.com/api/v3/song/detail',
                params: { c: JSON.stringify(sliceIds) },
              },
              env,
            );
            if (Array.isArray(songDetailRes?.songs) && songDetailRes.songs.length > 0) {
              songs = songDetailRes.songs;
            }
          } catch {}
        }
        // Fallback to initialTracks slice if song detail call failed
        if (songs.length === 0 && initialTracks.length > 0 && offset < initialTracks.length) {
          songs = initialTracks.slice(offset, offset + limit);
        }
      } else {
        songs = initialTracks.slice(offset, offset + limit);
      }

      return jsonResponse(
        {
          code: 200,
          brand: 'Sonic',
          songs: desensitizeData(songs),
          privileges: [],
        },
        { headers: { 'Cache-Control': 'public, max-age=1800' } },
      );
    }

    return jsonResponse(
      {
        code: 200,
        brand: 'Sonic',
        playlist: desensitizeData(p),
        result: desensitizeData(p),
      },
      { headers: { 'Cache-Control': 'public, max-age=1800' } },
    );
  }

  // 12.1. Similar / Related Playlists
  if (normEndpoint === 'simi/playlist' || normEndpoint === 'related/playlist') {
    const rawId = url.searchParams.get('id') || url.searchParams.get('songid') || '';
    const id = rawId.replace(/^[a-z0-9_-]+:/i, '').trim();
    if (!id) {
      return jsonResponse({ code: 200, brand: 'Sonic', playlists: [] });
    }

    try {
      let title = '';
      const pDetail = await callNeteaseLinuxApi(
        {
          method: 'POST',
          url: 'http://music.163.com/api/v3/playlist/detail',
          params: { id, n: 10, s: 0 },
        },
        env,
      ).catch(() => null);

      if (pDetail?.playlist) {
        title = pDetail.playlist.name || '';
      }

      const cleaned = (title || id)
        .replace(/\[.*?\]|【.*?】|（.*?）|\(.*?\)/g, ' ')
        .replace(/[|/\\_—–\-+#!~`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const searchRes = await callNeteaseLinuxApi(
        {
          method: 'POST',
          url: 'http://music.163.com/api/cloudsearch/pc',
          params: { s: cleaned || title || '流行', type: 1000, limit: 12, offset: 0 },
        },
        env,
      );

      const list = (searchRes?.result?.playlists || []).filter(
        (pl: any) => String(pl.id) !== String(id),
      );

      return jsonResponse(
        { code: 200, brand: 'Sonic', playlists: desensitizeData(list) },
        { headers: { 'Cache-Control': 'public, max-age=1800' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', playlists: [] });
  }

  // 13. Artist Detail & Artist Top Song & Albums
  if (
    normEndpoint === 'artist/detail' ||
    normEndpoint === 'artist/top/song' ||
    normEndpoint === 'artist/album' ||
    normEndpoint === 'artist/songs'
  ) {
    const id = url.searchParams.get('id') || '6452';
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
    if (normEndpoint === 'artist/album') {
      try {
        const resp = await timedFetch(
          `https://music.163.com/api/artist/albums/${encodeURIComponent(id)}?limit=${limit}&offset=${offset}`,
          { headers: buildUpstreamHeaders(cfg.realIp) },
        );
        const data: any = await resp.json();
        return jsonResponse(
          { code: 200, brand: 'Sonic', hotAlbums: desensitizeData(data.hotAlbums || []), more: data.more ?? false },
          { headers: { 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch {}
      return jsonResponse({ code: 200, brand: 'Sonic', hotAlbums: [] });
    }
    if (normEndpoint === 'artist/songs') {
      const order = url.searchParams.get('order') === 'time' ? 'time' : 'hot';
      try {
        const resp = await timedFetch(
          `https://music.163.com/api/artist/songs?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}&order=${order}`,
          { headers: buildUpstreamHeaders(cfg.realIp) },
        );
        const data: any = await resp.json();
        return jsonResponse(
          { code: 200, brand: 'Sonic', songs: desensitizeData(data.songs || []), more: data.more ?? false },
          { headers: { 'Cache-Control': 'public, max-age=3600' } },
        );
      } catch {}
      return jsonResponse({ code: 200, brand: 'Sonic', songs: [], more: false });
    }

    try {
      const resp = await timedFetch(`https://music.163.com/api/artist/${encodeURIComponent(id)}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      if (normEndpoint === 'artist/top/song') {
        return jsonResponse(
          { code: 200, brand: 'Sonic', songs: desensitizeData(data.hotSongs || []) },
          { headers: { 'Cache-Control': 'public, max-age=3600' } },
        );
      }
      return jsonResponse(
        {
          code: 200,
          brand: 'Sonic',
          artist: desensitizeData(data.artist || {}),
          hotSongs: desensitizeData(data.hotSongs || []),
        },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      );
    } catch {}
    return jsonResponse({ code: 404, message: 'Artist not found' }, { status: 404 });
  }

  // 14. Search Hot / Default / Suggest
  if (normEndpoint === 'search/hot/detail' || normEndpoint === 'search/hot') {
    return jsonResponse(
      { code: 200, brand: 'Sonic', data: HOT_SEARCH_LIST },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  }

  if (normEndpoint === 'search/default') {
    return jsonResponse(
      { code: 200, brand: 'Sonic', data: { showKeyword: '周杰伦', realkeyword: '周杰伦' } },
      { headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  }

  if (normEndpoint === 'search/suggest') {
    const s = url.searchParams.get('keywords') || url.searchParams.get('s') || '';
    if (!s) return jsonResponse({ code: 200, result: {} });
    try {
      const resp = await timedFetch(`https://music.163.com/api/search/suggest/web?s=${encodeURIComponent(s)}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      return jsonResponse(
        { code: 200, brand: 'Sonic', result: desensitizeData(data.result || {}) },
        { headers: { 'Cache-Control': 'public, max-age=1800' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', result: {} });
  }

  // 15. Song Detail
  if (normEndpoint === 'song/detail') {
    let ids = url.searchParams.get('ids') || url.searchParams.get('id') || '[]';
    if (ids && !ids.startsWith('[')) {
      ids = `[${ids}]`;
    }
    const cleanId = ids.replace(/[\[\]\s]/g, '');
    try {
      const resp = await timedFetch(`https://music.163.com/api/song/detail/?id=${encodeURIComponent(cleanId)}&ids=${encodeURIComponent(ids)}`, {
        headers: buildUpstreamHeaders(cfg.realIp),
      });
      const data: any = await resp.json();
      return jsonResponse(
        { code: 200, brand: 'Sonic', songs: desensitizeData(data.songs || []) },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', songs: [] });
  }

  // 16. Album Detail
  if (normEndpoint === 'album') {
    const id = url.searchParams.get('id') || '';
    if (id) {
      // 1. Primary: LinuxApi encrypted protocol (bypasses datacenter block & handles all commercial albums)
      try {
        const lRes = await callNeteaseLinuxApi(
          {
            method: 'GET',
            url: `http://music.163.com/api/v1/album/${encodeURIComponent(id)}`,
            params: {},
          },
          env,
        );
        if (lRes && (lRes.code === 200 || lRes.album)) {
          return jsonResponse(
            {
              code: 200,
              brand: 'Sonic',
              album: desensitizeData(lRes.album || {}),
              songs: desensitizeData(lRes.songs || []),
            },
            { headers: { 'Cache-Control': 'public, max-age=3600' } },
          );
        }
      } catch {}

      // 2. Fallback: plaintext legacy API
      try {
        const resp = await timedFetch(`https://music.163.com/api/v1/album/${encodeURIComponent(id)}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        if (data && (data.code === 200 || data.album)) {
          return jsonResponse(
            {
              code: 200,
              brand: 'Sonic',
              album: desensitizeData(data.album || {}),
              songs: desensitizeData(data.songs || []),
            },
            { headers: { 'Cache-Control': 'public, max-age=3600' } },
          );
        }
      } catch {}
    }
    return jsonResponse({ code: 200, brand: 'Sonic', album: {}, songs: [] });
  }

  // 16.1. New Albums
  if (normEndpoint === 'album/new') {
    const area = url.searchParams.get('area') || 'ALL';
    const limit = parseInt(url.searchParams.get('limit') || '30', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    try {
      const lRes = await callNeteaseLinuxApi(
        {
          method: 'POST',
          url: 'http://music.163.com/api/album/new',
          params: { area, limit, offset },
        },
        env,
      );
      if (lRes && (lRes.code === 200 || Array.isArray(lRes.albums))) {
        return jsonResponse(
          {
            code: 200,
            brand: 'Sonic',
            albums: desensitizeData(lRes.albums || []),
            total: lRes.total || lRes.albums?.length || 0,
          },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      }
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', albums: [], total: 0 });
  }

  // 16. Song URL
  if (normEndpoint === 'song/url/v1' || normEndpoint === 'song/url') {
    const id = url.searchParams.get('id') || '';
    const title = url.searchParams.get('title') || '';
    const artist = url.searchParams.get('artist') || '';
    const titlePart = title ? `&title=${encodeURIComponent(title)}` : '';
    const artistPart = artist ? `&artist=${encodeURIComponent(artist)}` : '';
    return jsonResponse(
      {
        code: 200,
        brand: 'Sonic',
        data: [{ id: String(id), url: `/api/music/stream?id=${encodeURIComponent(String(id))}${titlePart}${artistPart}` }],
      },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  }

  // 17. Search / CloudSearch (for Playlists, MVs, etc.)
  if (normEndpoint === 'cloudsearch' || normEndpoint === 'search') {
    const keywords = url.searchParams.get('keywords') || url.searchParams.get('keyword') || url.searchParams.get('s') || '';
    const type = url.searchParams.get('type') || '1';
    const limit = url.searchParams.get('limit') || '30';
    const offset = url.searchParams.get('offset') || '0';

    if (type === '1000') {
      // Search playlists (LinuxApi / Eapi encrypted protocol bypasses web plaintext AES encryption)
      try {
        const lRes = await callNeteaseLinuxApi(
          {
            method: 'POST',
            url: 'http://music.163.com/api/cloudsearch/pc',
            params: {
              s: keywords,
              type: 1000,
              limit: parseInt(limit, 10),
              offset: parseInt(offset, 10),
            },
          },
          env,
        );
        if (lRes && (lRes.code === 200 || lRes.result?.playlists)) {
          return jsonResponse(
            {
              code: 200,
              brand: 'Sonic',
              result: desensitizeData(lRes.result || { playlists: [], playlistCount: 0 }),
            },
            { headers: { 'Cache-Control': 'public, max-age=1800' } },
          );
        }
      } catch {}

      try {
        const eRes = await callNeteaseEapi(
          '/api/cloudsearch/pc',
          {
            s: keywords,
            type: 1000,
            limit: parseInt(limit, 10),
            offset: parseInt(offset, 10),
          },
          env,
        );
        if (eRes && (eRes.code === 200 || eRes.result?.playlists)) {
          return jsonResponse(
            {
              code: 200,
              brand: 'Sonic',
              result: desensitizeData(eRes.result || { playlists: [], playlistCount: 0 }),
            },
            { headers: { 'Cache-Control': 'public, max-age=1800' } },
          );
        }
      } catch {}

      try {
        const resp = await timedFetch(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(keywords)}&type=1000&limit=${limit}&offset=${offset}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        return jsonResponse(
          {
            code: 200,
            brand: 'Sonic',
            result: desensitizeData(data.result || { playlists: [], playlistCount: 0 }),
          },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      } catch {}
      return jsonResponse({ code: 200, brand: 'Sonic', result: { playlists: [], playlistCount: 0 } });
    }

    if (type === '1004') {
      // Search MVs
      try {
        const resp = await timedFetch(`https://music.163.com/api/mv/all?limit=${limit}&offset=${offset}`, {
          headers: buildUpstreamHeaders(cfg.realIp),
        });
        const data: any = await resp.json();
        const mvs = (data.data || []).map((m: any) => ({
          ...m,
          name: m.name || m.title || '',
          artistName: m.artistName || m.artist || '',
        }));
        return jsonResponse(
          {
            code: 200,
            brand: 'Sonic',
            result: { mvs: desensitizeData(mvs), mvCount: mvs.length },
          },
          { headers: { 'Cache-Control': 'public, max-age=1800' } },
        );
      } catch {}
      return jsonResponse({ code: 200, brand: 'Sonic', result: { mvs: [], mvCount: 0 } });
    }

    // Default: Song search fallback via Nexus Search
    try {
      const { searchNexus } = await import('./nexus-search');
      const page = Math.floor(parseInt(offset, 10) / parseInt(limit, 10)) + 1;
      const res = await searchNexus(keywords, { page, count: parseInt(limit, 10), request }, env);
      const songs = (res.data?.tracks || []).map((t: any) => ({
        id: t.id,
        name: t.title || t.name,
        ar: [{ id: 0, name: t.artist }],
        al: { id: 0, name: t.album, picUrl: t.cover || t.coverUrl },
        dt: t.duration ? Math.round(Number(t.duration) * 1000) : 0,
        mv: 0,
        sha: t.sha,
        qualityBadge: t.qualityBadge,
      }));
      return jsonResponse(
        {
          code: 200,
          brand: 'Sonic',
          result: { songs, songCount: res.data?.total || songs.length },
        },
        { headers: { 'Cache-Control': 'public, max-age=1800' } },
      );
    } catch {}
    return jsonResponse({ code: 200, brand: 'Sonic', result: { songs: [], songCount: 0 } });
  }

  // Fallback 404 for unknown endpoint
  return jsonResponse(
    { brand: 'Sonic', error: { code: 'NOT_FOUND', message: `Endpoint /api/${endpoint} not found` } },
    { status: 404 },
  );
}

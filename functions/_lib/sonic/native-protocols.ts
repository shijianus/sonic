// Sonic Gateway — Shared Native Protocol Engine (NetEase / QQ / Kugou / Kuwo)
// Shared 100% between Linux Local Engine (`server/`) and Cloudflare Pages Functions (`functions/`).
// Zero third-party aggregation API reliance by default; VIP paywall circumvention disabled by default.

import type { AppEnv, SongItem } from '../types';
import type { SonicAttempt, SonicSearchTrack } from './types';
import { getSonicConfig } from './config';
import { getAllowedMediaDomains, computeContentPolicyEpoch, isSourceEnabledByPolicy } from './licensing';
import { buildNeteaseEapiParams, buildNeteaseLinuxApiParams, buildNeteaseWeapiParams } from './crypto';
import { normalizeArtistString, normalizeText, normalizeCjkText, calcLevenshteinSimilarity } from './utils';
import { getSonicCachedJson, putSonicCachedJson } from './cache';
import { safeFetch } from './security';
import { callLocalEngineJson, getLocalEngineCircuitSnapshot, createRuntimeAbortBudget, fetchWithRuntimeBudget, type CircuitState } from './local-engine';
import { redactSensitiveString } from './observability';
import { getSyntheticTrackSpec, getSyntheticWavTotalBytes } from './synthetic-media';
import {
  fetchProviderUrl,
  fetchProviderDirect,
  isAllowedProviderHost,
  readBoundedProviderJson,
} from './provider-fetch';

// Re-exported from the dependency-free provider boundary so existing importers
// (and the provider adapters) keep a single canonical entry point.
export { fetchProviderUrl, fetchProviderDirect, isAllowedProviderHost, readBoundedProviderJson };

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1';

async function nativeFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 8000, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('Invalid provider URL');
  }
  const response =
    url.protocol === 'https:' && isAllowedProviderHost(url.hostname)
      ? await fetchProviderUrl(input, init, timeoutMs, signal)
      : await fetchWithRuntimeBudget(input, { ...init, redirect: 'error' }, { timeoutMs, signals: [signal] });
  if (!response.ok) void response.body?.cancel().catch(() => {});
  return response;
}

function providerLabel(base: string, env?: AppEnv): string {
  return getSonicConfig(env).runtime === 'linux-engine' ? `local-${base}` : base;
}

function viaLabel(env?: AppEnv, sub?: string): string {
  const base = getSonicConfig(env).runtime === 'linux-engine' ? 'local-engine' : 'cf-direct';
  return sub ? `${base}:${sub}` : base;
}

function toHttpsIfSafe(rawUrl: string): string {
  if (!rawUrl) return '';
  if (
    rawUrl.startsWith('http://') &&
    /(music\.126\.net|gtimg\.cn|kugou\.com|qqmusic\.qq\.com|kuwo\.cn)/i.test(rawUrl)
  ) {
    return rawUrl.replace(/^http:\/\//i, 'https://');
  }
  return rawUrl;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. NETEASE NATIVE PROTOCOLS (`ncm-api` internal container + `linuxapi` + `eapi`)
// ═══════════════════════════════════════════════════════════════════════

export async function callNeteaseLinuxApi(
  innerPayload: Record<string, any>,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<any> {
  const cfg = getSonicConfig(env);
  const eparams = buildNeteaseLinuxApiParams(innerPayload);
  const cookieParts = ['os=linux', 'appver=1.2.1.198277'];
  if (env?.NETEASE_COOKIE) {
    cookieParts.push(String(env.NETEASE_COOKIE).trim());
  }

  const resp = await nativeFetch('https://music.163.com/api/linux/forward', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://music.163.com/',
      'X-Real-IP': cfg.realIp,
      'X-Forwarded-For': cfg.realIp,
      Cookie: cookieParts.join('; '),
    },
    body: `eparams=${eparams}`,
  }, cfg.timeoutMs, signal);
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`NetEase linuxapi HTTP ${resp.status}`);
  }
  return readBoundedProviderJson(resp);
}

export async function callNeteaseEapi(
  apiPath: string,
  payload: Record<string, any>,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<any> {
  const cfg = getSonicConfig(env);
  const fullPayload = {
    ...payload,
    header: JSON.stringify({
      os: 'pc',
      appver: '2.9.7',
      requestId: `${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    }),
  };
  const params = buildNeteaseEapiParams(apiPath, fullPayload);
  const cookieParts = ['os=pc', 'appver=2.9.7'];
  if (env?.NETEASE_COOKIE) {
    cookieParts.push(String(env.NETEASE_COOKIE).trim());
  }

  const eapiEndpoint = `https://interface3.music.163.com/eapi${apiPath.replace(/^\/api/, '')}`;
  const resp = await nativeFetch(eapiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `${DESKTOP_UA} NeteaseMusicDesktop/2.9.7.199711`,
      Referer: 'https://music.163.com/',
      'X-Real-IP': cfg.realIp,
      'X-Forwarded-For': cfg.realIp,
      Cookie: cookieParts.join('; '),
    },
    body: `params=${params}`,
  }, cfg.timeoutMs, signal);
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    throw new Error(`NetEase eapi HTTP ${resp.status}`);
  }
  return readBoundedProviderJson(resp);
}

export async function fetchNeteaseRegionalTopSongs(areaId: number, env?: AppEnv, signal?: AbortSignal): Promise<unknown> {
  const cfg = getSonicConfig(env);
  // Match the pinned NCM sidecar 4.41.1 top_song module's WEAPI contract.
  const envelope = await buildNeteaseWeapiParams({ areaId, total: true, e_r: false, csrf_token: '' });
  const response = await fetchWithRuntimeBudget('https://music.163.com/weapi/v1/discovery/new/songs', {
    method: 'POST',
    // A redirect could discard the form body and silently remove the region.
    redirect: 'error',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DESKTOP_UA,
      Referer: 'https://music.163.com/',
      'X-Real-IP': cfg.realIp,
      Cookie: 'os=pc; appver=2.9.7;',
    },
    body: new URLSearchParams(envelope).toString(),
  }, { timeoutMs: cfg.timeoutMs, signals: [signal] });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`NetEase WEAPI top songs HTTP ${response.status}`);
  }
  return readBoundedProviderJson(response);
}

function mapNeteaseSongToSonicTrack(item: any): SonicSearchTrack {
  const platformId = String(item.id || '');
  const rawDt = item.dt ?? item.duration ?? 0;
  const durationSec = typeof rawDt === 'number' ? (rawDt > 1000 ? Math.round(rawDt / 1000) : Math.round(rawDt)) : 0;
  const artistsArr = item.ar || item.artists || [];
  const artist = Array.isArray(artistsArr)
    ? normalizeArtistString(artistsArr.map((a: any) => a?.name).filter(Boolean).join(' / '))
    : normalizeArtistString(String(item.artist || '未知歌手'));
  const albumObj = item.al || item.album || {};
  const album = String(albumObj.name || '');
  const rawCover = albumObj.picUrl ? toHttpsIfSafe(String(albumObj.picUrl)) : '';
  const rawArtistPic = artistsArr?.[0]?.img1v1Url || artistsArr?.[0]?.picUrl || '';
  const artistPic = rawArtistPic ? toHttpsIfSafe(String(rawArtistPic)) : '';
  const picId = String(albumObj.pic_str || albumObj.pic || albumObj.id || platformId);
  const cover =
    rawCover ||
    artistPic ||
    (platformId ? `/api/music/cover?id=${encodeURIComponent(platformId)}&source=netease&artist=${encodeURIComponent(artist)}` : '');

  return {
    id: `netease:${platformId}`,
    title: String(item.name || '未知歌曲'),
    name: String(item.name || '未知歌曲'),
    artist: artist || '未知歌手',
    album,
    duration: durationSec,
    cover,
    coverUrl: cover,
    artistPic: artistPic || cover,
    platform: 'netease',
    platformId,
    sources: [
      {
        platform: 'netease',
        platformId,
        duration: durationSec,
      },
    ],
    picId,
    lyricId: platformId,
    urlId: platformId,
    source: 'netease',
  };
}

export async function searchNeteaseNative(
  query: string,
  count = 20,
  page = 1,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<{ tracks: SonicSearchTrack[]; via: string }> {
  const cfg = getSonicConfig(env);
  const offset = Math.max(0, (page - 1) * count);

  // 1. On Linux VPS with internal NeteaseCloudMusicApiEnhanced container (`ncm-api`)
  if (cfg.ncmApiUrl) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (env?.NETEASE_COOKIE) headers.Cookie = String(env.NETEASE_COOKIE).trim();
      const u = `${cfg.ncmApiUrl}/cloudsearch?keywords=${encodeURIComponent(query)}&type=1&limit=${count}&offset=${offset}&realIP=${encodeURIComponent(cfg.realIp)}`;
      const res = await nativeFetch(u, {
        headers,
        signal,
      }, cfg.timeoutMs);
      if (res.ok) {
        const json = (await res.json()) as any;
        const songs = json?.result?.songs;
        if (Array.isArray(songs) && songs.length > 0) {
          return {
            tracks: songs.map(mapNeteaseSongToSonicTrack),
            via: viaLabel(env, 'ncm-api'),
          };
        }
      }
    } catch { signal?.throwIfAborted(); }
  }

  // 2. Pure-TS encrypted `linuxapi` (`cloudsearch/pc`) — works identically on Linux & Cloudflare Workers
  const lJson = await callNeteaseLinuxApi(
    {
      method: 'POST',
      url: 'http://music.163.com/api/cloudsearch/pc',
      params: { s: query, type: 1, limit: count, offset },
    },
    env,
    signal,
  );
  const songs = lJson?.result?.songs;
  if (Array.isArray(songs) && songs.length > 0) {
    return {
      tracks: songs.map(mapNeteaseSongToSonicTrack),
      via: viaLabel(env, 'linuxapi'),
    };
  }

  return { tracks: [], via: viaLabel(env, 'linuxapi') };
}

export async function resolveNeteaseCoverUrl(id: string, env?: AppEnv, signal?: AbortSignal): Promise<string> {
  const cleanId = id.replace(/^netease:/i, '').trim();
  if (!/^\d+$/.test(cleanId)) return '';
  const cfg = getSonicConfig(env);

  if (cfg.ncmApiUrl) {
    try {
      const res = await nativeFetch(`${cfg.ncmApiUrl}/song/detail?ids=${encodeURIComponent(cleanId)}&realIP=${encodeURIComponent(cfg.realIp)}`, {
        signal,
      }, 4500);
      if (res.ok) {
        const json = (await res.json()) as any;
        const pic = json?.songs?.[0]?.al?.picUrl;
        if (pic) return toHttpsIfSafe(String(pic));
      }
    } catch { signal?.throwIfAborted(); }
  }

  try {
    const numId = Number(cleanId);
    const json = await callNeteaseLinuxApi(
      {
        method: 'POST',
        url: 'http://music.163.com/api/v3/song/detail',
        params: {
          c: JSON.stringify([{ id: numId }]),
          ids: JSON.stringify([numId]),
        },
      },
      env,
      signal,
    );
    const pic = json?.songs?.[0]?.al?.picUrl || json?.songs?.[0]?.album?.picUrl;
    if (pic) return toHttpsIfSafe(String(pic));
  } catch { signal?.throwIfAborted(); }

  try {
    const eJson = await callNeteaseEapi(
      '/api/v3/song/detail',
      {
        c: JSON.stringify([{ id: Number(cleanId) }]),
        ids: JSON.stringify([Number(cleanId)]),
      },
      env,
      signal,
    );
    const pic = eJson?.songs?.[0]?.al?.picUrl;
    if (pic) return toHttpsIfSafe(String(pic));
  } catch { signal?.throwIfAborted(); }

  try {
    const dRes = await nativeFetch(
      `https://music.163.com/api/song/detail/?id=${encodeURIComponent(cleanId)}&ids=%5B${encodeURIComponent(cleanId)}%5D`,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Referer: 'https://music.163.com/',
        },
        signal,
      }, 4500);
    if (dRes.ok) {
      const dJson = (await dRes.json()) as any;
      const pic = dJson?.songs?.[0]?.album?.picUrl || dJson?.songs?.[0]?.al?.picUrl || dJson?.songs?.[0]?.artists?.[0]?.picUrl;
      if (pic) return toHttpsIfSafe(String(pic));
    }
  } catch { signal?.throwIfAborted(); }

  return '';
}

// ═══════════════════════════════════════════════════════════════════════
// 2. QQ MUSIC NATIVE PROTOCOLS (`musicu.fcg` Detail / Cover / `CgiGetVkey`)
// ═══════════════════════════════════════════════════════════════════════

export async function resolveQQCoverUrl(idOrMid: string, env?: AppEnv, signal?: AbortSignal): Promise<string> {
  const clean = idOrMid.replace(/^(qq|tencent):/i, '').trim();
  if (!clean) return '';

  // 1. Resolve `songmid` / `songid` -> `albummid` via `music.pf_song_detail_svr`
  try {
    const isNumeric = /^\d+$/.test(clean);
    const body = {
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
      songinfo: {
        method: 'get_song_detail_yqq',
        module: 'music.pf_song_detail_svr',
        param: isNumeric ? { song_id: Number(clean) } : { song_mid: clean },
      },
    };
    const res = await nativeFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://y.qq.com/',
        Origin: 'https://y.qq.com',
        'User-Agent': DESKTOP_UA,
      },
      body: JSON.stringify(body),
      signal,
    }, 4000);
    if (res.ok) {
      const json = (await res.json()) as any;
      const albumMid = json?.songinfo?.data?.track_info?.album?.mid;
      const singerMid = json?.songinfo?.data?.track_info?.singer?.[0]?.mid;
      if (albumMid && albumMid !== '00000000000000') {
        return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`;
      }
      if (singerMid) {
        return `https://y.gtimg.cn/music/photo_new/T001R300x300M000${singerMid}.jpg`;
      }
    }
  } catch { signal?.throwIfAborted(); }

  // 2. Fallback: treat `clean` itself as `albummid` (proxyImage GET will verify 200 image/*)
  if (/^[0-9A-Za-z]{10,20}$/.test(clean)) {
    return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${clean}.jpg`;
  }

  return '';
}

// ═══════════════════════════════════════════════════════════════════════
// 3. KUGOU & KUWO NATIVE PROTOCOLS
// ═══════════════════════════════════════════════════════════════════════

export async function resolveKugouCoverUrl(hash: string, env?: AppEnv, signal?: AbortSignal): Promise<string> {
  const cleanHash = hash.replace(/^kugou:/i, '').trim().toLowerCase();
  if (!cleanHash) return '';
  try {
    const headers: Record<string, string> = {
      Referer: 'https://m.kugou.com/',
      'User-Agent': MOBILE_UA,
    };
    if (env?.KUGOU_COOKIE) headers.Cookie = String(env.KUGOU_COOKIE).trim();
    const res = await nativeFetch(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(cleanHash)}`, {
      headers,
      signal,
    }, 4500);
    if (res.ok) {
      const json = (await res.json()) as any;
      const rawImg = json?.album_img || json?.imgUrl || '';
      if (rawImg) {
        return toHttpsIfSafe(String(rawImg).replace('{size}', '400'));
      }
    }
  } catch { signal?.throwIfAborted(); }
  return '';
}

export async function searchKuwoNative(
  query: string,
  count = 20,
  page = 1,
  signal?: AbortSignal,
): Promise<SonicSearchTrack[]> {
  try {
    const pn = Math.max(0, page - 1);
    const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=${pn}&rn=${count}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1`;
    const res = await nativeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Sonic/2.2.0' },
      signal,
    }, 6000);
    if (!res.ok) return [];
    const rawText = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = JSON.parse(rawText.replace(/'/g, '"'));
    }
    const list = Array.isArray(json?.abslist) ? json.abslist : [];
    return list
      .map((it: any): SonicSearchTrack | null => {
        const rid = String(it.MUSICRID || it.DC_TARGETID || '').replace(/^MUSIC_/i, '').trim();
        if (!rid) return null;
        const title = String(it.SONGNAME || it.NAME || '未知歌曲').replace(/&nbsp;/g, ' ');
        const artist = normalizeArtistString(String(it.ARTIST || '未知歌手').replace(/&/g, ' / '));
        const album = String(it.ALBUM || '');
        const duration = parseInt(String(it.DURATION || '0'), 10) || 0;
        const htsPic = it.web_albumpic_short
          ? `https://img2.kuwo.cn/star/albumcover/${String(it.web_albumpic_short).replace(/^120\//, '500/')}`
          : '';
        const cover = htsPic || `/api/music/cover?artist=${encodeURIComponent(artist)}&source=kuwo`;
        return {
          id: `kuwo:${rid}`,
          title,
          name: title,
          artist,
          album,
          duration,
          cover,
          coverUrl: cover,
          platform: 'kuwo',
          platformId: rid,
          sources: [{ platform: 'kuwo', platformId: rid, duration }],
          source: 'kuwo',
          lyricId: rid,
          urlId: rid,
        };
      })
      .filter((x: SonicSearchTrack | null): x is SonicSearchTrack => Boolean(x));
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}

export async function fetchKuwoLyricsNative(rid: string, signal?: AbortSignal): Promise<string> {
  const cleanRid = rid.replace(/^kuwo:/i, '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(cleanRid)) return '';
  try {
    const res = await nativeFetch(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(cleanRid)}`, {
      headers: { Referer: 'https://m.kuwo.cn/', 'User-Agent': MOBILE_UA },
      signal,
    }, 5000);
    if (!res.ok) return '';
    const json = (await res.json()) as any;
    const lrclist = json?.data?.lrclist;
    if (!Array.isArray(lrclist) || lrclist.length === 0) return '';
    return lrclist
      .map((line: any) => {
        const secNum = parseFloat(String(line.time || '0')) || 0;
        const mins = Math.floor(secNum / 60);
        const secs = (secNum % 60).toFixed(2).padStart(5, '0');
        return `[${String(mins).padStart(2, '0')}:${secs}]${String(line.lineLyric || '').trim()}`;
      })
      .join('\n');
  } catch {
    signal?.throwIfAborted();
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. UNIFIED STREAM RESOLUTION (`resolvePlayableStream`)
// ═══════════════════════════════════════════════════════════════════════

export interface ResolvedStreamInfo {
  url: string;
  provider: string;
  via: string;
  isTrial: boolean;
  streamType?: 'full' | 'trial' | 'unavailable';
  trialDuration?: number;
  br?: number;
  size?: number;
  contentType?: string;
  referer?: string;
  corsSafe: boolean;
  degraded: boolean;
  degradedReason?: string;
  circuitState?: CircuitState;
  attempts: SonicAttempt[];
  resolvedSource?: string;
  resolvedId?: string;
  resolvedTitle?: string;
  resolvedArtist?: string;
}

function mapQualityToNeteaseLevel(quality: string): { level: string; encodeType: string } {
  const q = String(quality || '320').toLowerCase();
  if (q === 'flac' || q === 'lossless' || q === '999') {
    return { level: 'lossless', encodeType: 'flac' };
  }
  if (q === '320' || q === 'exhigh') {
    return { level: 'exhigh', encodeType: 'mp3' };
  }
  if (q === '192' || q === 'higher') {
    return { level: 'higher', encodeType: 'mp3' };
  }
  return { level: 'standard', encodeType: 'mp3' };
}

async function resolveNeteaseSingleStream(
  songId: string,
  quality: string,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<{
  url: string;
  isTrial: boolean;
  trialDuration?: number;
  br?: number;
  size?: number;
  contentType?: string;
  via: string;
} | null> {
  const cleanId = songId.replace(/^netease:/i, '').trim();
  if (!/^\d+$/.test(cleanId)) return null;
  const cfg = getSonicConfig(env);
  const { level, encodeType } = mapQualityToNeteaseLevel(quality);

  // 1. Try internal `ncm-api` container on Linux VPS first
  if (cfg.ncmApiUrl) {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (env?.NETEASE_COOKIE) headers.Cookie = String(env.NETEASE_COOKIE).trim();
      const u = `${cfg.ncmApiUrl}/song/url/v1?id=${encodeURIComponent(cleanId)}&level=${encodeURIComponent(level)}&realIP=${encodeURIComponent(cfg.realIp)}`;
      const res = await nativeFetch(u, { headers, signal }, cfg.timeoutMs);
      if (res.ok) {
        const json = (await res.json()) as any;
        const item = json?.data?.[0];
        if (item?.url && typeof item.url === 'string') {
          const type = String(item.type || '').toLowerCase();
          const isTrial = Boolean(item.freeTrialInfo);
          const trialDuration = isTrial && item.freeTrialInfo ? Math.max(0, (item.freeTrialInfo.end || 30) - (item.freeTrialInfo.start || 0)) : (isTrial ? 30 : undefined);
          return {
            url: toHttpsIfSafe(item.url),
            isTrial,
            trialDuration,
            br: typeof item.br === 'number' ? item.br : undefined,
            size: typeof item.size === 'number' ? item.size : undefined,
            contentType: type === 'flac' ? 'audio/flac' : 'audio/mpeg',
            via: viaLabel(env, 'ncm-api'),
          };
        }
      }
    } catch { signal?.throwIfAborted(); }
  }

  // 2. Pure-TS `eapi` `/api/song/enhance/player/url/v1`
  const eJson = await callNeteaseEapi(
    '/api/song/enhance/player/url/v1',
    {
      ids: JSON.stringify([Number(cleanId)]),
      level,
      encodeType,
    },
    env,
    signal,
  );
  const item = eJson?.data?.[0];
  if (item?.url && typeof item.url === 'string') {
    const type = String(item.type || '').toLowerCase();
    const isTrial = Boolean(item.freeTrialInfo);
    const trialDuration = isTrial && item.freeTrialInfo ? Math.max(0, (item.freeTrialInfo.end || 30) - (item.freeTrialInfo.start || 0)) : (isTrial ? 30 : undefined);
    return {
      url: toHttpsIfSafe(item.url),
      isTrial,
      trialDuration,
      br: typeof item.br === 'number' ? item.br : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
      contentType: type === 'flac' ? 'audio/flac' : 'audio/mpeg',
      via: viaLabel(env, 'eapi'),
    };
  }
  return null;
}

async function resolveQQSingleStream(
  mid: string,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<{ url: string; via: string } | null> {
  const cleanMid = mid.replace(/^(qq|tencent):/i, '').trim();
  if (!cleanMid) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Referer: 'https://y.qq.com/',
    Origin: 'https://y.qq.com',
    'User-Agent': DESKTOP_UA,
  };
  if (env?.QQ_COOKIE) headers.Cookie = String(env.QQ_COOKIE).trim();

  const res = await nativeFetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: '358840384',
          songmid: [cleanMid],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20',
        },
      },
    }),
    signal,
  }, 5000);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const info = json?.req_0?.data?.midurlinfo?.[0];
  if (!info?.purl) return null;

  const sips: string[] = Array.isArray(json?.req_0?.data?.sip) ? json.req_0.data.sip : [];
  const httpsSip = sips.find((s) => s.startsWith('https://')) || 'https://ws.stream.qqmusic.qq.com/';
  return {
    url: `${httpsSip}${info.purl}`,
    via: viaLabel(env, 'qq-vkey'),
  };
}

async function resolveKugouSingleStream(
  hash: string,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<{ url: string; size?: number; via: string } | null> {
  const cleanHash = hash.replace(/^kugou:/i, '').trim().toLowerCase();
  if (!cleanHash) return null;
  const headers: Record<string, string> = {
    Referer: 'https://m.kugou.com/',
    'User-Agent': MOBILE_UA,
  };
  if (env?.KUGOU_COOKIE) headers.Cookie = String(env.KUGOU_COOKIE).trim();

  const res = await nativeFetch(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(cleanHash)}`, {
    headers,
    signal,
  }, 5000);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  if (!json?.url || typeof json.url !== 'string') return null;
  return {
    url: toHttpsIfSafe(json.url),
    size: typeof json.fileSize === 'number' ? json.fileSize : undefined,
    via: viaLabel(env, 'kugou-playinfo'),
  };
}

async function resolveKuwoSingleStream(
  rid: string,
  env?: AppEnv,
  signal?: AbortSignal,
): Promise<{ url: string; size?: number; via: string } | null> {
  const cleanRid = rid.replace(/^kuwo:/i, '').replace(/^MUSIC_/i, '').trim();
  if (!/^\d+$/.test(cleanRid)) return null;

  const antiRes = await nativeFetch(
    `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${encodeURIComponent(cleanRid)}&format=mp3&response=url`,
    {
      headers: {
        'User-Agent': 'okhttp/3.10.0',
        Referer: 'https://www.kuwo.cn/',
      },
      signal,
    }, 5000);
  if (!antiRes.ok) return null;
  const rawUrl = (await antiRes.text()).trim();
  if (!rawUrl.startsWith('http')) return null;

  // Reject Kuwo's 181KB copyright/region voice prompt clip (`/nf/resource/.../588957081.mp3`)
  if (/\/nf\/resource\//i.test(rawUrl) || rawUrl.includes('588957081.mp3')) {
    return null;
  }

  const finalUrl = toHttpsIfSafe(rawUrl);
  // Verify byte length via 1-byte Range probe to guarantee full-length real audio (>= 350 KB)
  try {
    const probe = await safeFetch(
    finalUrl,
    {
      headers: { Range: 'bytes=0-0', Referer: 'https://www.kuwo.cn/', 'User-Agent': DESKTOP_UA },
      signal,
    },
    {
      allowHttp: false,
      allowedDomains: ['kuwo.cn'],
      maxRedirects: 1,
      timeoutMs: 4000,
      maxBytes: 64 * 1024,
    },
  );
    const cr = probe.headers.get('content-range') || '';
    const cl = probe.headers.get('content-length') || '';
    probe.body?.cancel?.().catch(() => {});
    const m = cr.match(/\/(\d+)$/);
    const totalBytes = m ? parseInt(m[1], 10) : parseInt(cl, 10) || 0;
    if ((probe.status !== 200 && probe.status !== 206) || totalBytes < 350_000) {
      return null;
    }
    return {
      url: finalUrl,
      size: totalBytes,
      via: viaLabel(env, 'kuwo-antiserver'),
    };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

export function evaluateStreamTypeByRelativeBytes(
  totalBytes: number,
  expectedDurationSec?: number,
  nominalBitrateKbps = 320,
): { streamType: 'full' | 'trial' | 'unavailable'; ratio: number; baselineBytes: number } {
  if (!totalBytes || totalBytes <= 0) {
    return { streamType: 'unavailable', ratio: 0, baselineBytes: 0 };
  }
  // 1. Strict rejection of known fake prompt audio clips
  // Kuwo fake 11s prompt audio is exactly 181,521 bytes
  if (totalBytes === 181521) {
    return { streamType: 'unavailable', ratio: 0, baselineBytes: 0 };
  }

  // 2. Determine effective duration: fallback to 200s if unknown or suspiciously short
  const duration = expectedDurationSec && expectedDurationSec > 30 ? expectedDurationSec : 200;

  // 3. Lowest acceptable bitrate for full audio streaming
  // For requested/nominal bitrate (e.g. 320kbps), full track must deliver at least 55% of nominal bitrate,
  // and never below 96kbps (12 KB/s) absolute floor.
  const effBitrateKbps = Math.max(96, nominalBitrateKbps * 0.55);
  const baselineBytes = Math.round(duration * ((effBitrateKbps * 1000) / 8));

  const ratio = totalBytes / baselineBytes;

  // If actual bytes are >= 85% of baseline bytes, it is a full stream;
  // otherwise it is a trial preview.
  const isFull = ratio >= 0.85;

  return {
    streamType: isFull ? 'full' : 'trial',
    ratio,
    baselineBytes,
  };
}

export async function probeStreamPhysicalQuality(
  url: string,
  referer?: string,
  timeoutMs = 2000,
  expectedDurationSec?: number,
  nominalBitrateKbps = 320,
  signal?: AbortSignal,
  env?: AppEnv,
): Promise<{ streamType: 'full' | 'trial' | 'unavailable'; totalBytes: number; ratio: number }> {
  try {
    const headers: Record<string, string> = {
      Range: 'bytes=0-0',
      'User-Agent': DESKTOP_UA,
    };
    if (referer) headers.Referer = referer;
    // A probe reads only headers and cancels the body immediately, so it must
    // not be rejected when a CDN ignores `Range` and advertises the full file
    // size in Content-Length (maxBytes would abort before we can inspect it).
    const res = await safeFetch(
      url,
      { headers, signal },
      {
        allowHttp: false,
        allowedDomains: getAllowedMediaDomains(env, 'audio'),
        maxRedirects: 2,
        timeoutMs,
        maxBytes: 0,
      },
    );
    const cr = res.headers.get('content-range') || '';
    const cl = res.headers.get('content-length') || '';
    res.body?.cancel?.().catch(() => {});

    if (res.status !== 200 && res.status !== 206) {
      return { streamType: 'unavailable', totalBytes: 0, ratio: 0 };
    }
    const m = cr.match(/\/(\d+)$/);
    const total = m ? parseInt(m[1], 10) : parseInt(cl, 10);
    const totalBytes = isNaN(total) ? 0 : total;

    const evaluation = evaluateStreamTypeByRelativeBytes(totalBytes, expectedDurationSec, nominalBitrateKbps);
    return {
      streamType: evaluation.streamType,
      totalBytes,
      ratio: evaluation.ratio,
    };
  } catch {
    signal?.throwIfAborted();
    return { streamType: 'unavailable', totalBytes: 0, ratio: 0 };
  }
}

export function titlesMatchStrictly(targetTitle: string, candidateTitle: string): boolean {
  const tNorm = normalizeCjkText(targetTitle);
  const cNorm = normalizeCjkText(candidateTitle);
  if (!tNorm || !cNorm) return false;

  // Anti-mismatch keyword exclusions: candidate must not be live/remix/cover/accompaniment/clip/ringtone unless target was
  const negativeKeywords = [
    'live', '现场', 'remix', '伴奏', 'instrumental', 'cover', '翻唱', 'dj',
    'karaoke', 'k歌', '伴唱', '铃声', '剪辑', '片段', 'preview', '试听',
    'demo', '纯音乐', '纯享', '慢摇', '加长版', '加快版', '变调', '减速版',
  ];
  const tLower = targetTitle.toLowerCase();
  const cLower = candidateTitle.toLowerCase();
  for (const kw of negativeKeywords) {
    if (!tNorm.includes(kw) && !tLower.includes(kw) && (cNorm.includes(kw) || cLower.includes(kw))) {
      return false;
    }
  }

  if (tNorm === cNorm) return true;
  if (cNorm.startsWith(tNorm) && cNorm.length <= tNorm.length + 4) return true;

  // Check base titles (stripped of bracketed/parenthetical subtitles)
  const stripParentheses = (s: string) => s.replace(/\s*[\(\[（【{][^\)\]）】}]+[\)\]）】}]/g, '').trim();
  const tBase = normalizeCjkText(stripParentheses(targetTitle));
  const cBase = normalizeCjkText(stripParentheses(candidateTitle));
  if (tBase && cBase && tBase === cBase) return true;

  return false;
}

export function artistsMatchStrictly(targetArtist: string, candidateArtist: string, minSimilarity = 0.85): boolean {
  if (!targetArtist) return true;
  const tNorm = normalizeCjkText(targetArtist);
  const cNorm = normalizeCjkText(candidateArtist);
  if (!tNorm || !cNorm) return false;
  if (tNorm === cNorm) return true;

  // Multi-artist collaboration split matching (e.g. "周杰伦 / 费玉清" matches "周杰伦")
  const splitArtists = (s: string) => s.split(/[\/&,、与和+]/).map((a) => normalizeCjkText(a)).filter(Boolean);
  const tList = splitArtists(targetArtist);
  const cList = splitArtists(candidateArtist);
  if (tList.some((t) => cList.some((c) => t === c))) {
    return true;
  }

  // Short Chinese/CJK artist names (<= 4 chars) must match exactly to prevent "周杰" matching "周杰伦"
  if (tNorm.length <= 4 && cNorm.length <= 4) {
    return false;
  }

  const sim = calcLevenshteinSimilarity(targetArtist, candidateArtist);
  return sim >= minSimilarity;
}

export interface ResolveStreamOptions {
  id: string;
  source?: string;
  quality?: string;
  title?: string;
  artist?: string;
  durationSec?: number;
  allowTrial?: boolean;
  nocache?: boolean;
  request?: Request;
  signal?: AbortSignal;
}

export async function resolvePlayableStream(
  opts: ResolveStreamOptions,
  env?: AppEnv,
): Promise<ResolvedStreamInfo | null> {
  const budget = createRuntimeAbortBudget([opts.signal, opts.request?.signal], getSonicConfig(env).timeoutMs);
  try {
    budget.signal.throwIfAborted();
    const result = await resolvePlayableStreamWithinBudget({ ...opts, signal: budget.signal }, env);
    budget.signal.throwIfAborted();
    return result;
  } finally {
    budget.dispose();
  }
}

export interface StreamCacheIdentityInput {
  source: string;
  id: string;
  quality?: string;
  title?: string;
  artist?: string;
  allowTrial?: boolean;
  durationSec?: number;
  policyEpoch?: string;
}

/**
 * JSON tuple encoding keeps user-controlled separators (`:`, `=`) inside their
 * own field instead of letting them alias another field boundary. The content
 * policy epoch is part of the key: disabling a source (or flipping any licensing
 * flag) must not leave the previous resolution playable from cache.
 */
export function buildStreamCacheIdentifier(input: StreamCacheIdentityInput): string {
  return JSON.stringify([
    'stream-url-v2',
    String(input.source || '').toLowerCase(),
    String(input.id || ''),
    String(input.quality || '320').toLowerCase(),
    normalizeText(input.title || ''),
    normalizeText(input.artist || ''),
    input.allowTrial === false ? 0 : 1,
    Number(input.durationSec) || 0,
    String(input.policyEpoch || ''),
  ]);
}

async function resolvePlayableStreamWithinBudget(
  opts: ResolveStreamOptions,
  env?: AppEnv,
): Promise<ResolvedStreamInfo | null> {
  const cfg = getSonicConfig(env);
  const signal = opts.signal;
  signal?.throwIfAborted();
  let cleanId = String(opts.id || '').trim();
  let cleanSource = String(opts.source || 'netease').toLowerCase().trim();
  if (cleanId.includes(':')) {
    const parts = cleanId.split(':');
    cleanSource = (parts[0] || cleanSource).toLowerCase();
    cleanId = parts.slice(1).join(':');
  }
  if (cleanSource === 'tencent') cleanSource = 'qq';
  if (cleanSource === 'syn' || cleanSource === 'test') cleanSource = 'synthetic';
  if (cleanSource === 'ncm' || cleanSource === 'sonic') {
    cleanSource = !cfg.enableNetease && cfg.enableSynthetic ? 'synthetic' : 'netease';
  }

  const quality = String(opts.quality || '320').toLowerCase();
  const nominalBr = quality === '128' ? 128 : quality === 'flac' ? 800 : 320;
  const allowTrial = opts.allowTrial !== false;
  const policyEpoch = computeContentPolicyEpoch(env);
  const cacheId = buildStreamCacheIdentifier({
    source: cleanSource,
    id: cleanId,
    quality,
    title: opts.title,
    artist: opts.artist,
    allowTrial,
    durationSec: opts.durationSec,
    policyEpoch,
  });
  // A cached resolution must never outrank the current licensing policy: a hit
  // for a source disabled after the entry was stored is discarded on sight.
  const cacheHitAllowedByPolicy = isSourceEnabledByPolicy(cleanSource, env);

  // 1. Fresh cache check (8 minutes — well within signed CDN token TTL)
  if (!opts.nocache && cacheHitAllowedByPolicy) {
    const cached = await getSonicCachedJson<ResolvedStreamInfo>('stream-url-v1', cacheId, env);
    if (cached && cached.value?.url) {
      return {
        ...cached.value,
        attempts: [
          ...(cached.value.attempts || []),
          { provider: cached.value.provider, via: `cache:${cached.cacheLevel}`, ok: true, ms: 0 },
        ],
      };
    }
  }

  const attempts: SonicAttempt[] = [];
  let degraded = false;
  let degradedReason: string | undefined;
  let circuitState: CircuitState | undefined;

  // 2. If running on Cloudflare Pages with Linux Local Engine configured: call VPS first!
  let engineRes: { ok: boolean; data?: { ok: boolean; data?: ResolvedStreamInfo; attempts?: SonicAttempt[]; error?: string }; attempts?: SonicAttempt[]; error?: string; latencyMs: number; status?: number; skippedByCircuit?: boolean; circuitState: CircuitState } | undefined;
  if (cfg.enableLocalEngine) {
    const q = new URLSearchParams({
      id: cleanId,
      source: cleanSource,
      quality,
    });
    if (opts.title) q.set('title', opts.title);
    if (opts.artist) q.set('artist', opts.artist);
    if (opts.durationSec) q.set('duration', String(opts.durationSec));
    if (!allowTrial) q.set('allowTrial', '0');
    if (opts.nocache) q.set('nocache', '1');

    engineRes = await callLocalEngineJson<{ ok: boolean; data?: ResolvedStreamInfo; attempts?: SonicAttempt[]; error?: string }>(
      `/api/sonic/resolve/stream?${q.toString()}`,
      env,
      { request: opts.request, signal, timeoutMs: cfg.engineTimeoutMs },
    );
    circuitState = engineRes.circuitState;

    if (engineRes.ok && engineRes.data?.data?.url) {
      const resolved = engineRes.data.data;
      const mergedAttempts: SonicAttempt[] = [
        { provider: 'local-engine', via: 'local-engine', ok: true, ms: engineRes.latencyMs },
        ...(resolved.attempts || []),
      ];
      const finalInfo: ResolvedStreamInfo = {
        ...resolved,
        degraded: false,
        circuitState: 'CLOSED',
        attempts: mergedAttempts,
      };
      signal?.throwIfAborted();
      await putSonicCachedJson('stream-url-v1', cacheId, finalInfo, 480, 1200, env);
      return finalInfo;
    }

    // Engine unreachable / 5xx / circuit OPEN -> enter explicit degraded mode!
    if (engineRes.skippedByCircuit || !engineRes.status || engineRes.status >= 500) {
      degraded = true;
      degradedReason = engineRes.error || 'local_engine_unavailable';
      attempts.push({
        provider: 'local-engine',
        via: 'local-engine',
        ok: false,
        ms: engineRes.latencyMs,
        error: degradedReason,
      });

      // A playback retry must not silently replay the failed signed URL from stale cache.
      const staleHit = opts.nocache || !cacheHitAllowedByPolicy
        ? null
        : await getSonicCachedJson<ResolvedStreamInfo>('stream-url-v1', cacheId, env, { allowStale: true });
      if (staleHit?.value?.url) {
        return {
          ...staleHit.value,
          degraded: true,
          degradedReason: `served_stale_cache (${degradedReason})`,
          circuitState,
          attempts: [
            ...attempts,
            { provider: staleHit.value.provider, via: `stale-cache:${staleHit.cacheLevel}`, ok: true, ms: 0 },
          ],
        };
      }
    } else if (engineRes.data?.attempts) {
      // Local engine did not resolve a playable stream — record its attempts and proceed to Cloudflare native & external fallback
      attempts.push(...engineRes.data.attempts);
    }
  }

  // 3. Local / Direct Native Protocol Resolution
  let trialCandidate: ResolvedStreamInfo | null = null;

  if (cleanId) {
    const pStart = Date.now();
    const pLabel = providerLabel(cleanSource, env);
    try {
      if (cleanSource === 'synthetic' && cfg.enableSynthetic) {
        const isFaultId = /^syn-fault-(403|429|500|timeout)$/.test(cleanId);
        const spec = isFaultId ? null : getSyntheticTrackSpec(cleanId);
        if (spec || isFaultId) {
          let origin = 'https://sonic.internal';
          try {
            if (opts.request) origin = new URL(opts.request.url).origin;
          } catch { signal?.throwIfAborted(); }
          const totalBytes = spec ? getSyntheticWavTotalBytes(spec) : 0;
          attempts.push({ provider: pLabel, via: viaLabel(env, 'synthetic-pcm'), ok: true, ms: Date.now() - pStart });
          return {
            url: `${origin}/api/sonic/test-audio?id=${encodeURIComponent(spec ? spec.id : cleanId)}`,
            provider: pLabel,
            via: viaLabel(env, 'synthetic-pcm'),
            isTrial: false,
            streamType: 'full',
            br: 128,
            size: totalBytes,
            contentType: 'audio/wav',
            corsSafe: true,
            degraded,
            degradedReason,
            circuitState,
            attempts,
            resolvedSource: 'synthetic',
            resolvedId: spec ? spec.id : cleanId,
            resolvedTitle: spec?.title || opts.title || 'Synthetic Test Audio',
            resolvedArtist: spec?.artist || opts.artist || 'Sonic Acoustic Lab',
          };
        }
        attempts.push({
          provider: pLabel,
          via: viaLabel(env, 'synthetic-pcm'),
          ok: false,
          ms: Date.now() - pStart,
          error: 'Synthetic track ID not found',
        });
      } else if (cleanSource === 'netease' && cfg.enableNetease) {
        const ne = await resolveNeteaseSingleStream(cleanId, quality, env, signal);
        if (ne?.url && !ne.isTrial) {
          attempts.push({ provider: pLabel, via: ne.via, ok: true, ms: Date.now() - pStart });
          const out: ResolvedStreamInfo = {
            url: ne.url,
            provider: pLabel,
            via: ne.via,
            isTrial: false,
            streamType: 'full',
            br: ne.br,
            size: ne.size,
            contentType: ne.contentType,
            corsSafe: true,
            degraded: false,
            degradedReason: undefined,
            circuitState,
            attempts,
            resolvedSource: 'netease',
            resolvedId: cleanId,
            resolvedTitle: opts.title || undefined,
            resolvedArtist: opts.artist || undefined,
          };
          signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
          return out;
        } else if (ne?.url && ne.isTrial) {
          attempts.push({
            provider: pLabel,
            via: ne.via,
            ok: allowTrial,
            ms: Date.now() - pStart,
            error: 'VIP/fee=1 track returned trial preview only (unblock disabled)',
          });
          if (allowTrial) {
            trialCandidate = {
              url: ne.url,
              provider: pLabel,
              via: ne.via,
              isTrial: true,
              streamType: 'trial',
              trialDuration: ne.trialDuration || 30,
              br: ne.br,
              size: ne.size,
              contentType: ne.contentType,
              corsSafe: true,
              degraded,
              degradedReason,
              circuitState,
              attempts: [...attempts],
              resolvedSource: 'netease',
              resolvedId: cleanId,
              resolvedTitle: opts.title || undefined,
              resolvedArtist: opts.artist || undefined,
            };
          }
        } else {
          attempts.push({ provider: pLabel, via: viaLabel(env), ok: false, ms: Date.now() - pStart, error: 'No direct URL returned' });
        }
      } else if (cleanSource === 'qq' && cfg.enableQq) {
        const qq = await resolveQQSingleStream(cleanId, env, signal);
        if (qq?.url) {
          const probe = await probeStreamPhysicalQuality(qq.url, 'https://y.qq.com/', 2000, opts.durationSec, nominalBr, signal, env);
          const isFull = probe.streamType === 'full';
          attempts.push({ provider: pLabel, via: qq.via, ok: true, ms: Date.now() - pStart });
          const out: ResolvedStreamInfo = {
            url: qq.url,
            provider: pLabel,
            via: qq.via,
            isTrial: !isFull,
            streamType: isFull ? 'full' : 'trial',
            trialDuration: isFull ? undefined : 30,
            contentType: 'audio/mp4',
            referer: 'https://y.qq.com/',
            corsSafe: false,
            degraded: false,
            degradedReason: undefined,
            circuitState,
            attempts,
            resolvedSource: 'qq',
            resolvedId: cleanId,
            resolvedTitle: opts.title || undefined,
            resolvedArtist: opts.artist || undefined,
          };
          if (isFull) {
            signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
            return out;
          } else if (allowTrial) {
            trialCandidate = out;
          }
        }
        attempts.push({ provider: pLabel, via: viaLabel(env, 'qq-vkey'), ok: false, ms: Date.now() - pStart, error: 'Empty vkey purl (region or VIP restricted)' });
      } else if (cleanSource === 'kugou' && cfg.enableKugou) {
        const kg = await resolveKugouSingleStream(cleanId, env, signal);
        if (kg?.url) {
          const probe = await probeStreamPhysicalQuality(kg.url, 'https://m.kugou.com/', 2000, opts.durationSec, nominalBr, signal, env);
          const sizeEval = typeof kg.size === 'number' ? evaluateStreamTypeByRelativeBytes(kg.size, opts.durationSec, nominalBr) : null;
          const isFull = probe.streamType === 'full' || sizeEval?.streamType === 'full';
          attempts.push({ provider: pLabel, via: kg.via, ok: true, ms: Date.now() - pStart });
          const out: ResolvedStreamInfo = {
            url: kg.url,
            provider: pLabel,
            via: kg.via,
            isTrial: !isFull,
            streamType: isFull ? 'full' : 'trial',
            trialDuration: isFull ? undefined : 30,
            size: probe.totalBytes || kg.size,
            contentType: 'audio/mpeg',
            corsSafe: true,
            degraded: false,
            degradedReason: undefined,
            circuitState,
            attempts,
            resolvedSource: 'kugou',
            resolvedId: cleanId,
            resolvedTitle: opts.title || undefined,
            resolvedArtist: opts.artist || undefined,
          };
          if (isFull) {
            signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
            return out;
          } else if (allowTrial) {
            trialCandidate = out;
          }
        }
        attempts.push({ provider: pLabel, via: viaLabel(env, 'kugou-playinfo'), ok: false, ms: Date.now() - pStart, error: 'Empty playInfo url (VIP or region restricted)' });
      } else if (cleanSource === 'kuwo' && cfg.enableKuwo) {
        const kw = await resolveKuwoSingleStream(cleanId, env, signal);
        if (kw?.url) {
          attempts.push({ provider: pLabel, via: kw.via, ok: true, ms: Date.now() - pStart });
          const out: ResolvedStreamInfo = {
            url: kw.url,
            provider: pLabel,
            via: kw.via,
            isTrial: false,
            streamType: 'full',
            size: kw.size,
            contentType: 'audio/mpeg',
            referer: 'https://www.kuwo.cn/',
            corsSafe: false,
            degraded: false,
            degradedReason: undefined,
            circuitState,
            attempts,
            resolvedSource: 'kuwo',
            resolvedId: cleanId,
            resolvedTitle: opts.title || undefined,
            resolvedArtist: opts.artist || undefined,
          };
          signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
          return out;
        }
        attempts.push({ provider: pLabel, via: viaLabel(env, 'kuwo-antiserver'), ok: false, ms: Date.now() - pStart, error: 'Restricted or rejected 181KB region prompt' });
      }
    } catch (err: any) {
      signal?.throwIfAborted();
      attempts.push({ provider: pLabel, via: viaLabel(env), ok: false, ms: Date.now() - pStart, error: redactSensitiveString(err?.message || 'Native stream error') });
    }
  }

  // 4. Fast External Source Fallback (GDStudio Direct ID Lookup)
  const isCommercialSource =
    cleanSource === 'netease' ||
    cleanSource === 'qq' ||
    cleanSource === 'sonic' ||
    cleanSource === 'kugou' ||
    cleanSource === 'kuwo';
  const allowExternal =
    cfg.enableGdstudio &&
    isCommercialSource &&
    isSourceEnabledByPolicy(cleanSource, env) &&
    (degraded || Boolean(engineRes?.skippedByCircuit) || !engineRes?.ok);

  if (allowExternal && cleanId) {
    const gdStart = Date.now();
    const gdSource =
      cleanSource === 'qq' ? 'tencent' : cleanSource === 'sonic' || cleanSource === 'ncm' ? 'netease' : cleanSource;
    try {
      const gdUrl = new URL(cfg.upstreamGdstudio);
      gdUrl.searchParams.set('s', Math.random().toString(36).substring(2, 15));
      gdUrl.searchParams.set('types', 'url');
      gdUrl.searchParams.set('id', cleanId);
      gdUrl.searchParams.set('source', gdSource);
      gdUrl.searchParams.set('br', quality);
      const gdRes = await safeFetch(
        gdUrl,
        {
          headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://music.gdstudio.xyz/' },
          signal,
        },
        {
          allowHttp: false,
          allowedDomains: [gdUrl.hostname],
          maxRedirects: 2,
          timeoutMs: 10000,
          maxBytes: 1024 * 1024,
        },
      );
      if (gdRes.ok) {
        const gdData = (await gdRes.json()) as any;
        if (gdData?.url && typeof gdData.url === 'string' && gdData.url.startsWith('http')) {
          attempts.push({ provider: 'gdstudio', via: 'external-source', ok: true, ms: Date.now() - gdStart });
          const finalUrl = toHttpsIfSafe(gdData.url);
          const isNeteaseCdn = finalUrl.includes('music.126.net');
          const out: ResolvedStreamInfo = {
            url: finalUrl,
            provider: 'gdstudio',
            via: 'external-source',
            isTrial: false,
            streamType: 'full',
            corsSafe: isNeteaseCdn,
            degraded: false,
            circuitState,
            attempts,
            resolvedSource: gdSource === 'tencent' ? 'qq' : gdSource,
            resolvedId: cleanId,
            resolvedTitle: opts.title || undefined,
            resolvedArtist: opts.artist || undefined,
          };
          signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
          return out;
        }
      }
    } catch (err: any) {
      signal?.throwIfAborted();
      attempts.push({ provider: 'gdstudio', via: 'external-source', ok: false, ms: Date.now() - gdStart, error: redactSensitiveString(err?.message) });
    }
  }

  // 5. Legitimate Free-Catalog Cross-Platform Match (ONLY matches genuinely free full songs; never bypasses VIP DRM)
  let trackTitle = opts.title || '';
  let trackArtist = opts.artist || '';
  if (!trackTitle && cleanId && cleanSource === 'netease') {
    try {
      const dRes = await nativeFetch(
        `https://music.163.com/api/song/detail/?id=${encodeURIComponent(cleanId)}&ids=%5B${encodeURIComponent(cleanId)}%5D`,
        {
          headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://music.163.com/' },
          signal,
        }, 2000);
      if (dRes.ok) {
        const dJson = (await dRes.json()) as any;
        const songObj = dJson?.songs?.[0];
        if (songObj?.name) {
          trackTitle = String(songObj.name);
          if (Array.isArray(songObj.artists) && songObj.artists[0]?.name) {
            trackArtist = String(songObj.artists[0].name);
          }
        }
      }
    } catch { signal?.throwIfAborted(); }
  }
  const searchKeywords = [trackTitle, trackArtist].filter(Boolean).join(' ').trim();
  if (cfg.enableFreeCrossMatch && searchKeywords && trackTitle) {
    const budgetMs = cfg.crossMatchBudgetMs;
    const matchStart = Date.now();
    const isBudgetExceeded = () => Date.now() - matchStart >= budgetMs;

    // 4a. Try NetEase free catalog (`fee=0/8`, non-trial) if primary wasn't NetEase
    if (cleanSource !== 'netease' && cfg.enableNetease && !isBudgetExceeded()) {
      const sStart = Date.now();
      const label = providerLabel('netease', env);
      try {
        const neSearch = await searchNeteaseNative(searchKeywords, 5, 1, env, signal);
        const match = neSearch.tracks.find(
          (t) =>
            titlesMatchStrictly(trackTitle, t.title) &&
            artistsMatchStrictly(trackArtist, t.artist, cfg.crossMatchArtistSimilarity) &&
            (!opts.durationSec || !t.duration || Math.abs(t.duration - opts.durationSec) <= cfg.crossMatchDurationToleranceSec),
        );
        if (match) {
          const neStream = await resolveNeteaseSingleStream(match.platformId, quality, env, signal);
          if (neStream?.url && !neStream.isTrial) {
            const probe = await probeStreamPhysicalQuality(neStream.url, undefined, 2000, match.duration || opts.durationSec, nominalBr, signal, env);
            if (probe.streamType === 'full') {
              attempts.push({ provider: label, via: `${neStream.via}:free-match`, ok: true, ms: Date.now() - sStart });
              const out: ResolvedStreamInfo = {
                url: neStream.url,
                provider: label,
                via: `${neStream.via}:free-match`,
                isTrial: false,
                streamType: 'full',
                br: neStream.br,
                size: probe.totalBytes || neStream.size,
                contentType: neStream.contentType,
                corsSafe: true,
                degraded: false,
                degradedReason: undefined,
                circuitState,
                attempts,
                resolvedSource: 'netease',
                resolvedId: match.platformId,
                resolvedTitle: match.title,
                resolvedArtist: match.artist,
              };
              signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
              return out;
            }
          }
        }
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: 'No verified free full-length match' });
      } catch (err: any) {
        signal?.throwIfAborted();
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: redactSensitiveString(err?.message) });
      }
    }

    // 4b. Try Kugou genuinely free (`privilege=0`) tracks
    if (cleanSource !== 'kugou' && cfg.enableKugou && !isBudgetExceeded()) {
      const sStart = Date.now();
      const label = providerLabel('kugou', env);
      try {
        const timeoutRemaining = Math.min(3000, Math.max(500, budgetMs - (Date.now() - matchStart)));
        const kgRes = await nativeFetch(
          `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(searchKeywords)}&page=1&pagesize=5&showtype=1`,
          { headers: { 'User-Agent': DESKTOP_UA }, signal }, timeoutRemaining);
        if (kgRes.ok) {
          const kgJson = (await kgRes.json()) as any;
          const freeItem = (kgJson?.data?.info || []).find(
            (it: any) =>
              (it.privilege === 0 || it.privilege === 8) &&
              titlesMatchStrictly(trackTitle, String(it.songname || '')) &&
              artistsMatchStrictly(trackArtist, String(it.singername || ''), cfg.crossMatchArtistSimilarity) &&
              (!opts.durationSec || !it.duration || Math.abs(it.duration - opts.durationSec) <= cfg.crossMatchDurationToleranceSec),
          );
          if (freeItem?.hash) {
            const kgStream = await resolveKugouSingleStream(freeItem.hash, env, signal);
            if (kgStream?.url) {
              const probe = await probeStreamPhysicalQuality(kgStream.url, 'https://m.kugou.com/', 2000, freeItem.duration || opts.durationSec, nominalBr, signal, env);
              if (probe.streamType === 'full') {
                attempts.push({ provider: label, via: `${kgStream.via}:free-match`, ok: true, ms: Date.now() - sStart });
                const out: ResolvedStreamInfo = {
                  url: kgStream.url,
                  provider: label,
                  via: `${kgStream.via}:free-match`,
                  isTrial: false,
                  streamType: 'full',
                  size: probe.totalBytes || kgStream.size,
                  contentType: 'audio/mpeg',
                  corsSafe: true,
                  degraded: false,
                  degradedReason: undefined,
                  circuitState,
                  attempts,
                  resolvedSource: 'kugou',
                  resolvedId: freeItem.hash,
                  resolvedTitle: String(freeItem.songname || trackTitle),
                  resolvedArtist: String(freeItem.singername || trackArtist),
                };
                signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
                return out;
              }
            }
          }
        }
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: 'No verified free full-length match' });
      } catch (err: any) {
        signal?.throwIfAborted();
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: redactSensitiveString(err?.message) });
      }
    }

    // 4c. Try Kuwo verified free full-length tracks (rejects `/nf/resource/` 181KB clips!)
    if (cleanSource !== 'kuwo' && cfg.enableKuwo && !isBudgetExceeded()) {
      const sStart = Date.now();
      const label = providerLabel('kuwo', env);
      try {
        const kwTracks = await searchKuwoNative(searchKeywords, 4, 1, signal);
        for (const kt of kwTracks) {
          if (isBudgetExceeded()) break;
          if (
            titlesMatchStrictly(trackTitle, kt.title) &&
            artistsMatchStrictly(trackArtist, kt.artist, cfg.crossMatchArtistSimilarity) &&
            (!opts.durationSec || !kt.duration || Math.abs(kt.duration - opts.durationSec) <= cfg.crossMatchDurationToleranceSec)
          ) {
            const kwStream = await resolveKuwoSingleStream(kt.platformId, env, signal);
            if (kwStream?.url) {
              const probe = await probeStreamPhysicalQuality(kwStream.url, 'https://www.kuwo.cn/', 2000, kt.duration || opts.durationSec, nominalBr, signal, env);
              if (probe.streamType === 'full') {
                attempts.push({ provider: label, via: `${kwStream.via}:free-match`, ok: true, ms: Date.now() - sStart });
                const out: ResolvedStreamInfo = {
                  url: kwStream.url,
                  provider: label,
                  via: `${kwStream.via}:free-match`,
                  isTrial: false,
                  streamType: 'full',
                  size: probe.totalBytes || kwStream.size,
                  contentType: 'audio/mpeg',
                  referer: 'https://www.kuwo.cn/',
                  corsSafe: false,
                  degraded: false,
                  degradedReason: undefined,
                  circuitState,
                  attempts,
                  resolvedSource: 'kuwo',
                  resolvedId: kt.platformId,
                  resolvedTitle: kt.title,
                  resolvedArtist: kt.artist,
                };
                signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
                return out;
              }
            }
          }
        }
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: 'No verified full-length free stream' });
      } catch (err: any) {
        signal?.throwIfAborted();
        attempts.push({ provider: label, via: viaLabel(env, 'free-match'), ok: false, ms: Date.now() - sStart, error: redactSensitiveString(err?.message) });
      }
    }
  }

  // 5. External Source Fallback (GDStudio / Cloudflare Independent External Resolution)
  if (allowExternal && (cleanId || trackTitle || searchKeywords)) {
    const gdStart = Date.now();
    const gdSource =
      cleanSource === 'qq' ? 'tencent' : cleanSource === 'sonic' || cleanSource === 'ncm' ? 'netease' : cleanSource;
    try {
      // 5a. Direct ID Lookup via External Source
      if (cleanId) {
        const gdUrl = new URL(cfg.upstreamGdstudio);
        gdUrl.searchParams.set('s', Math.random().toString(36).substring(2, 15));
        gdUrl.searchParams.set('types', 'url');
        gdUrl.searchParams.set('id', cleanId);
        gdUrl.searchParams.set('source', gdSource);
        gdUrl.searchParams.set('br', quality);
        const gdRes = await safeFetch(
          gdUrl,
          {
            headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://music.gdstudio.xyz/' },
          signal,
          },
          {
            allowHttp: false,
            allowedDomains: [gdUrl.hostname],
            maxRedirects: 2,
            timeoutMs: 12000,
            maxBytes: 1024 * 1024,
          },
        );
        if (gdRes.ok) {
          const gdData = (await gdRes.json()) as any;
          if (gdData?.url && typeof gdData.url === 'string' && gdData.url.startsWith('http')) {
            attempts.push({ provider: 'gdstudio', via: 'external-source', ok: true, ms: Date.now() - gdStart });
            const finalUrl = toHttpsIfSafe(gdData.url);
            const isNeteaseCdn = finalUrl.includes('music.126.net');
            const out: ResolvedStreamInfo = {
              url: finalUrl,
              provider: 'gdstudio',
              via: 'external-source',
              isTrial: false,
              streamType: 'full',
              corsSafe: isNeteaseCdn,
              degraded: false,
              circuitState,
              attempts,
              resolvedSource: gdSource === 'tencent' ? 'qq' : gdSource,
              resolvedId: cleanId,
              resolvedTitle: trackTitle || undefined,
              resolvedArtist: trackArtist || undefined,
            };
            signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
            return out;
          }
        }
      }

      // 5b. Search-Assisted External Match (STRICT TRIPLE VERIFICATION GATE)
      // Must strictly match Title, Artist, and Duration tolerance to prevent mismatching covers or random songs!
      if (searchKeywords && trackTitle) {
        const gdSearchUrl = new URL(cfg.upstreamGdstudio);
        gdSearchUrl.searchParams.set('s', Math.random().toString(36).substring(2, 15));
        gdSearchUrl.searchParams.set('types', 'search');
        gdSearchUrl.searchParams.set('name', searchKeywords);
        gdSearchUrl.searchParams.set('source', 'netease');
        gdSearchUrl.searchParams.set('count', '6');
        const searchRes = await safeFetch(
          gdSearchUrl,
          {
            headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://music.gdstudio.xyz/' },
          signal,
          },
          {
            allowHttp: false,
            allowedDomains: [gdSearchUrl.hostname],
            maxRedirects: 2,
            timeoutMs: 8000,
            maxBytes: 1024 * 1024,
          },
        );
        if (searchRes.ok) {
          const searchData = (await searchRes.json()) as any;
          if (Array.isArray(searchData) && searchData.length > 0) {
            // Find candidate passing strict title, artist similarity, and duration check
            const matchedCandidate = searchData.find((item: any) => {
              if (!item || !item.id) return false;
              const cTitle = String(item.name || item.title || '').trim();
              const cArtist = String(
                Array.isArray(item.artists)
                  ? item.artists.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).join(' / ')
                  : (item.artist || item.singer || '')
              ).trim();
              if (!titlesMatchStrictly(trackTitle, cTitle)) return false;
              if (trackArtist && !artistsMatchStrictly(trackArtist, cArtist, cfg.crossMatchArtistSimilarity)) return false;
              if (opts.durationSec && item.duration) {
                const dSec = typeof item.duration === 'number'
                  ? (item.duration > 1000 ? Math.round(item.duration / 1000) : item.duration)
                  : 0;
                if (dSec > 0 && Math.abs(dSec - opts.durationSec) > cfg.crossMatchDurationToleranceSec) return false;
              }
              return true;
            });

            if (matchedCandidate && matchedCandidate.id) {
              const matchedId = String(matchedCandidate.id);
              const matchedTitle = String(matchedCandidate.name || matchedCandidate.title || trackTitle);
              const matchedArtist = String(
                Array.isArray(matchedCandidate.artists)
                  ? matchedCandidate.artists.map((a: any) => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).join(' / ')
                  : (matchedCandidate.artist || matchedCandidate.singer || trackArtist)
              );

              const gdUrl2 = new URL(cfg.upstreamGdstudio);
              gdUrl2.searchParams.set('s', Math.random().toString(36).substring(2, 15));
              gdUrl2.searchParams.set('types', 'url');
              gdUrl2.searchParams.set('id', matchedId);
              gdUrl2.searchParams.set('source', 'netease');
              gdUrl2.searchParams.set('br', quality);
              const gdRes2 = await safeFetch(
                gdUrl2,
                {
                  headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://music.gdstudio.xyz/' },
          signal,
                },
                {
                  allowHttp: false,
                  allowedDomains: [gdUrl2.hostname],
                  maxRedirects: 2,
                  timeoutMs: 12000,
                  maxBytes: 1024 * 1024,
                },
              );
              if (gdRes2.ok) {
                const gdData2 = (await gdRes2.json()) as any;
                if (gdData2?.url && typeof gdData2.url === 'string' && gdData2.url.startsWith('http')) {
                  attempts.push({ provider: 'gdstudio', via: 'external-search-match', ok: true, ms: Date.now() - gdStart });
                  const finalUrl2 = toHttpsIfSafe(gdData2.url);
                  const isNeteaseCdn2 = finalUrl2.includes('music.126.net');
                  const out: ResolvedStreamInfo = {
                    url: finalUrl2,
                    provider: 'gdstudio',
                    via: 'external-search-match',
                    isTrial: false,
                    streamType: 'full',
                    corsSafe: isNeteaseCdn2,
                    degraded: false,
                    circuitState,
                    attempts,
                    resolvedSource: 'netease',
                    resolvedId: matchedId,
                    resolvedTitle: matchedTitle,
                    resolvedArtist: matchedArtist,
                  };
                  signal?.throwIfAborted();
          await putSonicCachedJson('stream-url-v1', cacheId, out, 480, 1200, env);
                  return out;
                }
              }
            } else {
              attempts.push({ provider: 'gdstudio', via: 'external-search-match', ok: false, ms: Date.now() - gdStart, error: `No verified title/artist match for "${trackTitle}" by "${trackArtist}"` });
            }
          }
        }
      }

      attempts.push({ provider: 'gdstudio', via: 'external-source', ok: false, ms: Date.now() - gdStart, error: 'External source did not return a playable stream' });
    } catch (err: any) {
      signal?.throwIfAborted();
      attempts.push({ provider: 'gdstudio', via: 'external-source', ok: false, ms: Date.now() - gdStart, error: redactSensitiveString(err?.message) });
    }
  }

  // 6. If only official NetEase trial clip exists and caller permits trial playback, return it honestly marked
  if (trialCandidate && allowTrial) {
    return {
      ...trialCandidate,
      streamType: 'trial',
      isTrial: true,
      trialDuration: trialCandidate.trialDuration || 30,
      attempts,
    };
  }

  return {
    url: '',
    provider: 'none',
    via: viaLabel(env),
    isTrial: false,
    streamType: 'unavailable',
    corsSafe: false,
    degraded,
    degradedReason,
    circuitState,
    attempts,
  };
}

export function sonicTrackToLegacySongItem(t: SonicSearchTrack): SongItem {
  return {
    id: t.platformId || t.id.replace(/^[a-z]+:/i, ''),
    name: t.name || t.title,
    artist: t.artist,
    album: t.album,
    source: t.platform === 'sonic' ? 'netease' : t.platform,
    picId: t.picId || t.platformId,
    lyricId: t.lyricId || t.platformId,
    urlId: t.urlId || t.platformId,
    coverUrl: t.coverUrl || t.cover,
    duration: t.duration,
    sources: t.sources,
    streamType: t.platform === 'netease' && (t as any).isVip ? 'trial' : 'full',
  };
}

export { getLocalEngineCircuitSnapshot };

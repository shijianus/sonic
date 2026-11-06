// Sonic Local Engine — Linux Node.js 22 HTTP Server
// Shares 100% of protocol, lyrics (KRC/QRC/YRC/TTML), cover, palette, auth & security logic with Cloudflare Pages `functions/`.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { AppEnv } from '../functions/_lib/types';
import dns from 'node:dns/promises';
import {
  checkEngineAccess,
  checkStagingAccessGate,
  normalizeEnginePathname,
  setSafeFetchHostResolver,
} from '../functions/_lib/sonic/security';
import {
  getReleaseMetadata,
  getReleaseReadiness,
  classifyRouteGroup,
  recordStreamBodyMetric,
  recordHttpRequestMetric,
  redactSensitiveString,
} from '../functions/_lib/sonic/observability';
import { handleOptions } from '../functions/_lib/http';
import { checkEngineIdentityAccess } from '../functions/_lib/sonic/engine-identity';
import { getAccessMode, requireAccess } from '../functions/_lib/sonic/access';
import { getContentPolicyReadiness } from '../functions/_lib/sonic/licensing';
import { toWebRequest, abortWebRequest } from './request-adapter';

// Route handlers shared directly from `functions/`
import { onRequest as handleProxy } from '../functions/proxy';
import { onRequest as handlePalette } from '../functions/palette';
import { onRequest as handleApiIndex } from '../functions/api/index';
import { onRequest as handleApiCatchAll } from '../functions/api/[[path]]';
import { onRequest as handleAuthLogin } from '../functions/api/auth/login';
import { onRequest as handleAuthCallback } from '../functions/api/auth/callback';
import { onRequest as handleAuthKey } from '../functions/api/auth/key';
import { onRequest as handleAuthUser } from '../functions/api/auth/user';
import { onRequest as handleAuthLogout } from '../functions/api/auth/logout';
import { onRequest as handleAuthRevoke } from '../functions/api/auth/revoke';
import { onRequest as handleMusicCover } from '../functions/api/music/cover';
import { onRequest as handleMusicLyric } from '../functions/api/music/lyric';
import { onRequest as handleMusicRandom } from '../functions/api/music/random';
import { onRequest as handleMusicSearch } from '../functions/api/music/search';
import { onRequest as handleMusicStream } from '../functions/api/music/stream';
import { onRequest as handleMusicTicket } from '../functions/api/music/ticket';
import { onRequest as handleEngineHealth } from '../functions/api/sonic/engine/health';
import { onRequest as handleEngineMetrics } from '../functions/api/sonic/engine/metrics';
import { onRequest as handleTestAudio } from '../functions/api/sonic/test-audio';
import { onRequest as handleResolveStream } from '../functions/api/sonic/resolve/stream';
import { onRequest as handleSonicForward } from '../functions/api/sonic/forward';
import { onRequest as handleSonicSearchNexus } from '../functions/api/sonic/search/nexus';
import { onRequest as handleSonicSearchSmart } from '../functions/api/sonic/search/smart';
import { onRequest as handleSonicSearchPlatform } from '../functions/api/sonic/search/[platform]';
import { onRequest as handleSonicRecommendForYou } from '../functions/api/sonic/recommend/for-you';
import { onRequest as handleSonicRecommendTrending } from '../functions/api/sonic/recommend/trending';
import { onRequest as handleSonicRecommendSimilar } from '../functions/api/sonic/recommend/similar';
import { onRequest as handleSonicRecommendDiscover } from '../functions/api/sonic/recommend/discover';
import { onRequest as handleSonicRadarAlbum } from '../functions/api/sonic/recommend/radar-album';
import { onRequest as handleSonicEvents } from '../functions/api/sonic/events';
import { onRequest as handleSonicLyricsNexus } from '../functions/api/sonic/lyrics/nexus';
import { onRequest as handleSonicLyricsSync } from '../functions/api/sonic/lyrics/sync';
import { onRequest as handleSonicLyricsPlatform } from '../functions/api/sonic/lyrics/[platform]';
import { onRequest as handleAccountLibrary } from '../functions/api/account/library';
import { onRequest as handleAccessInvite } from '../functions/api/access/invite';
import { onRequest as handleAccessSession } from '../functions/api/access/session';
import { onRequest as handleAccessLogout } from '../functions/api/access/logout';
import { createServerRecommendStore, probeDiskHealth } from './recommend-sqlite';
import { createServerAccountStore } from './account-store';
import { createServerAccessStore } from './access-store';
import type { RecommendStore } from '../functions/_lib/sonic/recommend/types';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

let serverRecommendStore: RecommendStore | null = null;
let serverRecommendDbKey = '';
let serverAccountStore: ReturnType<typeof createServerAccountStore> | null = null;
let serverAccountDbKey = '';
let serverAccessStore: ReturnType<typeof createServerAccessStore> | null = null;
let serverAccessDbKey = '';

function getOrInitServerAccountStore(dbPath?: string) {
  const desiredKey = (dbPath ?? process.env.SONIC_ACCOUNT_DB_PATH ?? '').trim();
  if (!desiredKey || desiredKey === 'memory' || desiredKey === 'off') {
    throw new Error('SONIC_ACCOUNT_DB_PATH must be a dedicated persistent database path');
  }
  if (!serverAccountStore || serverAccountDbKey !== desiredKey) {
    serverAccountStore?.close();
    serverAccountStore = createServerAccountStore(desiredKey);
    serverAccountDbKey = desiredKey;
  }
  return serverAccountStore;
}

function getOrInitServerAccessStore(dbPath?: string, seedCodes?: string) {
  const desiredKey = (dbPath ?? process.env.SONIC_ACCESS_DB_PATH ?? '').trim();
  if (!desiredKey || desiredKey === 'memory' || desiredKey === 'off') throw new Error('SONIC_ACCESS_DB_PATH must be a dedicated persistent database path');
  if (!serverAccessStore || serverAccessDbKey !== desiredKey) {
    serverAccessStore?.close();
    serverAccessStore = createServerAccessStore(desiredKey, seedCodes ?? process.env.SONIC_INVITE_CODES ?? '');
    serverAccessDbKey = desiredKey;
  }
  return serverAccessStore;
}

function getOrInitServerRecommendStore(dbPath?: string): RecommendStore {
  const desiredKey = (dbPath ?? process.env.SONIC_RECOMMEND_DB_PATH ?? '').trim() || 'default';
  if (!serverRecommendStore || serverRecommendDbKey !== desiredKey) {
    serverRecommendStore = createServerRecommendStore(dbPath);
    serverRecommendDbKey = desiredKey;
  }
  return serverRecommendStore;
}

function buildRuntimeEnv(overrides?: Partial<AppEnv>): AppEnv {
  const env: Record<string, any> = { ...process.env, ...(overrides || {}) };
  // This process is always the Linux engine; a stray SONIC_RUNTIME=cf-pages must not
  // disable the service-auth gate on every API route.
  env.SONIC_RUNTIME = 'linux-engine';
  if (!env.RECOMMEND_STORE) {
    env.RECOMMEND_STORE = getOrInitServerRecommendStore(env.SONIC_RECOMMEND_DB_PATH);
  }
  if (!env.ACCOUNT_STORE && env.SONIC_ACCOUNT_DB_PATH) {
    env.ACCOUNT_STORE = getOrInitServerAccountStore(env.SONIC_ACCOUNT_DB_PATH);
  }
  if (!env.SONIC_ACCESS_STORE && env.SONIC_ACCESS_DB_PATH && String(env.SONIC_ACCESS_MODE || '').toLowerCase() === 'invite') {
    env.SONIC_ACCESS_STORE = getOrInitServerAccessStore(env.SONIC_ACCESS_DB_PATH, env.SONIC_INVITE_CODES);
  }
  if (!env.SONIC_DISK_HEALTH_PROVIDER) {
    const minFreeMb = Math.max(1, parseInt(String(env.SONIC_MIN_FREE_DISK_MB || '64'), 10) || 64);
    env.SONIC_DISK_HEALTH_PROVIDER = () =>
      probeDiskHealth(env.SONIC_RECOMMEND_DB_PATH, minFreeMb, env.RECOMMEND_STORE);
  }
  return env as AppEnv;
}

// Node performs its own DNS lookup before every upstream hop. The shared safeFetch keeps
// an allowlist check for Cloudflare, where hostname resolution is not observable.
setSafeFetchHostResolver(async (hostname: string) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
});

async function sendWebResponse(res: http.ServerResponse, webResp: Response, isHead: boolean, mediaBody = false): Promise<void> {
  if (res.destroyed) {
    void webResp.body?.cancel().catch(() => {});
    return;
  }
  const outHeaders: Record<string, string | string[]> = {};
  webResp.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'set-cookie') {
      const existing = outHeaders[lower];
      if (Array.isArray(existing)) existing.push(value);
      else outHeaders[lower] = [value];
      return;
    }
    outHeaders[lower] = value;
  });
  res.writeHead(webResp.status, webResp.statusText || undefined, outHeaders);
  if (isHead || !webResp.body) {
    void webResp.body?.cancel().catch(() => {});
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(webResp.body as any);
  if (mediaBody) recordStreamBodyMetric('started', 'http');
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (outcome: 'completed' | 'cancelled' | 'error' | 'timeout') => {
      if (settled) return;
      settled = true;
      res.removeListener('close', onClose);
      res.removeListener('finish', onFinish);
      if (mediaBody) recordStreamBodyMetric(outcome, 'http');
      resolve();
    };
    const onClose = () => {
      finish(res.writableFinished ? 'completed' : 'cancelled');
      if (!nodeStream.destroyed) nodeStream.destroy();
    };
    const onFinish = () => finish('completed');
    const onError = (error: any) => {
      finish(error?.name === 'TimeoutError' ? 'timeout' : 'error');
      // A truncated media body cannot be reported as a clean EOF.
      res.destroy();
    };
    res.once('close', onClose);
    res.once('finish', onFinish);
    nodeStream.once('error', onError);
    nodeStream.pipe(res);
  });
}

async function dispatchFunctionRoute(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = normalizeEnginePathname(url.pathname);
  const waitUntil = (p: Promise<any>) => {
    p.catch(() => {});
  };

  if (pathname === '/proxy') {
    return handleProxy({ request, env });
  }
  if (pathname === '/palette' || pathname === '/api/music/palette') {
    return handlePalette({ request, env });
  }

  if (pathname === '/api') {
    return handleApiIndex({ request, env });
  }

  // Auth routes
  if (pathname === '/api/auth/login') return handleAuthLogin({ request, env });
  if (pathname === '/api/auth/callback') return handleAuthCallback({ request, env });
  if (pathname === '/api/auth/key') return handleAuthKey({ request, env });
  if (pathname === '/api/auth/user') return handleAuthUser({ request, env });
  if (pathname === '/api/auth/logout') return handleAuthLogout({ request, env });
  if (pathname === '/api/auth/revoke') return handleAuthRevoke({ request, env });
  if (pathname === '/api/access/invite' || pathname === '/api/access/redeem') return handleAccessInvite({ request, env });
  if (pathname === '/api/access/session' || pathname === '/api/access/status') return handleAccessSession({ request, env });
  if (pathname === '/api/access/logout') return handleAccessLogout({ request, env });
  if (pathname === '/api/account/library') return handleAccountLibrary({ request, env });

  // Music routes & aliases
  if (pathname === '/api/cover' || pathname === '/api/music/cover') {
    return handleMusicCover({ request, env });
  }
  if (
    pathname === '/api/lyric' ||
    pathname === '/api/lyrics' ||
    pathname === '/api/music/lyric' ||
    pathname === '/api/music/lyrics'
  ) {
    return handleMusicLyric({ request, env, waitUntil });
  }
  if (pathname === '/api/music/random') return handleMusicRandom({ request, env });
  if (pathname === '/api/music/search') return handleMusicSearch({ request, env });
  if (pathname === '/api/music/stream') return handleMusicStream({ request, env });
  if (pathname === '/api/music/ticket') return handleMusicTicket({ request, env });

  // Sonic Gateway & Engine routes
  if (pathname === '/api/sonic/engine/health') return handleEngineHealth({ request, env });
  if (pathname === '/api/sonic/engine/metrics') return handleEngineMetrics({ request, env });
  if (pathname === '/api/sonic/test-audio') return handleTestAudio({ request, env });
  if (pathname === '/api/sonic/resolve/stream') return handleResolveStream({ request, env });
  if (pathname === '/api/sonic/forward') return handleSonicForward({ request, env, waitUntil });

  // Intelligent Recommendation & Smart Search routes
  if (pathname === '/api/sonic/recommend/for-you') {
    return handleSonicRecommendForYou({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/recommend/trending') {
    return handleSonicRecommendTrending({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/recommend/similar') {
    return handleSonicRecommendSimilar({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/recommend/discover') {
    return handleSonicRecommendDiscover({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/recommend/radar-album') {
    return handleSonicRadarAlbum({ request, env });
  }
  if (pathname === '/api/sonic/events') {
    return handleSonicEvents({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/search/smart') {
    return handleSonicSearchSmart({ request, env, waitUntil });
  }

  if (pathname === '/api/sonic/search' || pathname === '/api/sonic/search/nexus') {
    return handleSonicSearchNexus({ request, env, waitUntil });
  }
  if (pathname.startsWith('/api/sonic/search/')) {
    let platform: string;
    try {
      platform = decodeURIComponent(pathname.slice('/api/sonic/search/'.length));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    return handleSonicSearchPlatform({ request, params: { platform }, env, waitUntil });
  }

  if (pathname === '/api/sonic/lyrics' || pathname === '/api/sonic/lyrics/nexus') {
    return handleSonicLyricsNexus({ request, env, waitUntil });
  }
  if (pathname === '/api/sonic/lyrics/sync') {
    return handleSonicLyricsSync({ request, env, waitUntil });
  }
  if (pathname.startsWith('/api/sonic/lyrics/')) {
    let platform: string;
    try {
      platform = decodeURIComponent(pathname.slice('/api/sonic/lyrics/'.length));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    return handleSonicLyricsPlatform({ request, params: { platform }, env, waitUntil });
  }

  // Catch-all `/api/*` commercial endpoints (banners, playlists, charts, artists, MVs, comments)
  if (pathname.startsWith('/api/')) {
    let segments: string[];
    try {
      segments = pathname
        .slice('/api/'.length)
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    return handleApiCatchAll({ request, params: { path: segments }, env });
  }

  return null;
}

async function serveStaticAsset(staticRoot: string, pathname: string, isHead: boolean): Promise<Response> {
  const normalizedRoot = path.resolve(staticRoot);
  let safeRel = path.posix.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
  if (safeRel.includes('\\') || safeRel.includes('\0')) {
    return new Response('Not Found', { status: 404 });
  }
  let candidate = path.resolve(normalizedRoot, safeRel || 'index.html');
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const stat = await fsp.stat(candidate);
    if (stat.isDirectory()) {
      candidate = path.resolve(candidate, 'index.html');
    }
  } catch {
    // SPA fallback for client-side routes (only when not requesting a missing asset file with extension)
    const ext = path.extname(safeRel);
    if (!ext || ext === '.html') {
      candidate = path.resolve(normalizedRoot, 'index.html');
    } else {
      return new Response('Not Found', { status: 404 });
    }
  }
  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + path.sep)) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) {
      return new Response('Not Found', { status: 404 });
    }
    const ext = path.extname(candidate).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isImmutable = pathname.startsWith('/assets/') || pathname.startsWith('/static/');
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': STATIC_CONTENT_SECURITY_POLICY,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    };
    if (isHead) {
      return new Response(null, { status: 200, headers });
    }
    const stream = fs.createReadStream(candidate);
    return new Response(Readable.toWeb(stream) as any, { status: 200, headers });
  } catch {
    return new Response('Sonic Local Engine is running (static dist not mounted)', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
  }
}

interface ServerDrainState { draining: boolean; deadlineAt?: number; activeRequests: number; }
const serverDrainers = new WeakMap<http.Server, (timeoutMs?: number) => Promise<void>>();

export function drainSonicServer(server: http.Server, timeoutMs?: number): Promise<void> {
  const drain = serverDrainers.get(server);
  return drain ? drain(timeoutMs) : new Promise((resolve) => server.close(() => resolve()));
}

export async function shutdownSonicServer(server: http.Server, store: { close?: () => void } | null = serverRecommendStore as any, timeoutMs?: number): Promise<void> {
  await drainSonicServer(server, timeoutMs);
  store?.close?.();
  if (serverAccountStore) {
    serverAccountStore.close();
    serverAccountStore = null;
    serverAccountDbKey = '';
  }
  if (serverAccessStore) {
    serverAccessStore.close();
    serverAccessStore = null;
    serverAccessDbKey = '';
  }
}

export function withRecommendStartupLock<T>(dbPath: string | undefined, initialize: () => T): T {
  const configured = (dbPath ?? process.env.SONIC_RECOMMEND_DB_PATH ?? '').trim();
  if (configured === 'memory' || configured === 'off' || configured === ':memory:') return initialize();
  const resolved = path.resolve(configured || path.join(process.cwd(), 'data', 'sonic-recommend.sqlite'));
  const lock = `${resolved}.maintenance-lock`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.mkdirSync(lock); // Existing restore lock must fail closed, without deleting its owner.
  try {
    return initialize();
  } finally {
    fs.rmdirSync(lock);
  }
}

export function createSonicServer(staticRoot = path.resolve(process.cwd(), 'dist'), envOverrides?: Partial<AppEnv>) {
  const drainState: ServerDrainState = { draining: false, activeRequests: 0 };
  const activeRequests = new Map<http.ServerResponse, Request>();
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    let activeEnv: AppEnv | undefined;
    res.on('finish', () => {
      // Structured access log: path only, never query strings or headers.
      let pathname = '/';
      try {
        pathname = new URL(req.url || '/', 'http://engine.internal').pathname;
      } catch {}
      const durationMs = Date.now() - startedAt;
      recordHttpRequestMetric(pathname, res.statusCode, durationMs, activeEnv);
      console.log(
        JSON.stringify({
          type: 'access',
          requestId,
          method: req.method || 'GET',
          path: pathname,
          status: res.statusCode,
          durationMs,
        }),
      );
    });

    try {
      const webReq = toWebRequest(req, res);
      activeRequests.set(res, webReq);
      drainState.activeRequests = activeRequests.size;
      const removeActive = () => {
        activeRequests.delete(res);
        drainState.activeRequests = activeRequests.size;
        res.removeListener('finish', removeActive);
        res.removeListener('close', removeActive);
      };
      res.once('finish', removeActive);
      res.once('close', removeActive);
      const env = buildRuntimeEnv(envOverrides);
      env.SONIC_DRAIN_STATE = drainState;
      activeEnv = env;
      const release = getReleaseMetadata(env);
      if (release.releaseId || release.releaseCommit !== 'unknown') {
        res.setHeader('X-Sonic-Release', release.releaseId || release.releaseCommit.slice(0, 12));
      }
      if (
        release.environment === 'staging' ||
        release.environment === 'preview' ||
        getAccessMode(env) === 'invite' ||
        Boolean(env.SONIC_STAGING_ACCESS_TOKEN && String(env.SONIC_STAGING_ACCESS_TOKEN).trim())
      ) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      }

      if (webReq.method === 'OPTIONS') {
        await sendWebResponse(res, handleOptions(), false);
        return;
      }

      const stagingDenied = checkStagingAccessGate(webReq, env);
      if (stagingDenied) {
        await sendWebResponse(res, stagingDenied, webReq.method === 'HEAD');
        return;
      }

      const accessDenied = await requireAccess(webReq, env);
      if (accessDenied) {
        await sendWebResponse(res, accessDenied, webReq.method === 'HEAD');
        return;
      }

      // Mandatory top-level authentication gate on `engine-sonic.*` and internal engine paths (Condition 2c)
      const engineDenied = checkEngineAccess(webReq, env);
      if (engineDenied) {
        await sendWebResponse(res, engineDenied, webReq.method === 'HEAD');
        return;
      }

      const identityDenied = await checkEngineIdentityAccess(webReq, env);
      if (identityDenied) {
        await sendWebResponse(res, identityDenied, webReq.method === 'HEAD');
        return;
      }

      const pathname = normalizeEnginePathname(new URL(webReq.url).pathname);
      const contentPolicyReadiness = getContentPolicyReadiness(env);
      if (pathname !== '/api/sonic/engine/health' && !contentPolicyReadiness.ok) {
        await sendWebResponse(res, new Response(JSON.stringify({
          brand: 'Sonic', error: {
            code: 'CONTENT_POLICY_MISCONFIGURED',
            message: 'Production requires SONIC_CONTENT_POLICY=strict-allowlist and a reviewed SONIC_ALLOWED_SOURCES list',
            reason: contentPolicyReadiness.reason,
            invalidSources: contentPolicyReadiness.invalidSources,
            effectiveSources: contentPolicyReadiness.effectiveSources,
          },
        }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30', Connection: 'close' } }), webReq.method === 'HEAD');
        return;
      }
      const releaseReadiness = getReleaseReadiness(env);
      if (pathname !== '/api/sonic/engine/health' && (drainState.draining || !releaseReadiness.ok)) {
        await sendWebResponse(res, new Response(JSON.stringify({
          brand: 'Sonic', error: {
            code: drainState.draining ? 'ENGINE_DRAINING' : 'RELEASE_METADATA_REQUIRED',
            message: drainState.draining ? 'Engine is draining' : 'Release metadata is missing or invalid',
          },
        }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5', Connection: 'close' } }), webReq.method === 'HEAD');
        return;
      }
      const apiResp = await dispatchFunctionRoute(webReq, env);
      if (apiResp) {
        await sendWebResponse(res, apiResp, webReq.method === 'HEAD', classifyRouteGroup(pathname) === 'stream');
        return;
      }

      const url = new URL(webReq.url);
      const staticResp = await serveStaticAsset(staticRoot, url.pathname, webReq.method === 'HEAD');
      await sendWebResponse(res, staticResp, webReq.method === 'HEAD');
    } catch (err: any) {
      if (res.destroyed) return;
      console.error(
        JSON.stringify({
          type: 'unhandled_error',
          requestId,
          name: String(err?.name || 'Error'),
          message: redactSensitiveString(String(err?.message || '')).slice(0, 200),
        }),
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            brand: 'Sonic',
            error: { code: 'INTERNAL_ENGINE_ERROR', message: 'Internal engine error' },
          }),
        );
      } else {
        res.end();
      }
    }
  });

  let drainPromise: Promise<void> | undefined;
  serverDrainers.set(server, (overrideTimeoutMs) => {
    if (drainPromise) return drainPromise;
    const configured = Number(overrideTimeoutMs ?? envOverrides?.SONIC_SHUTDOWN_TIMEOUT_MS ?? process.env.SONIC_SHUTDOWN_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
    drainState.draining = true;
    drainState.deadlineAt = Date.now() + timeoutMs;
    drainPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const [response, request] of activeRequests) {
          abortWebRequest(request);
          response.destroy();
        }
        server.closeAllConnections();
      }, timeoutMs);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
      server.closeIdleConnections();
    });
    return drainPromise;
  });

  // Bound slow-client and idle-connection resource consumption.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

// Start server when executed as main entrypoint
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('server/index.ts') ||
    process.argv[1].endsWith('dist-server/index.mjs') ||
    process.argv[1].endsWith('index.mjs'));

if (isMain) {
  // Fail fast when the production database cannot be opened: binding the port while
  // silently using an in-memory store would report healthy and lose data on restart.
  try {
    if (!getReleaseReadiness(process.env as AppEnv).ok) throw new Error('Release metadata is missing or invalid');
    const contentPolicy = getContentPolicyReadiness(process.env as AppEnv);
    if (!contentPolicy.ok) {
      throw new Error(`Content policy is not deployment-ready: ${contentPolicy.reason || 'misconfigured'}`);
    }
    withRecommendStartupLock(process.env.SONIC_RECOMMEND_DB_PATH, () => getOrInitServerRecommendStore());
  } catch (err: any) {
    console.error(`[Sonic Local Engine] Fatal: ${err?.message || err}`);
    process.exit(1);
  }

  const port = parseInt(process.env.PORT || '8080', 10) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  const staticDir = process.env.SONIC_STATIC_DIR || path.resolve(process.cwd(), 'dist');
  const server = createSonicServer(staticDir);

  server.listen(port, host, () => {
    console.log(
      `[Sonic Local Engine] Listening on http://${host}:${port} (runtime=${process.env.SONIC_RUNTIME || 'linux-engine'}, ncmApi=${process.env.SONIC_NCM_API_URL || 'none'})`,
    );
  });

  let shutdownStarted = false;
  const shutdown = async (sig: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`[Sonic Local Engine] Received ${sig}, draining active requests...`);
    try {
      await shutdownSonicServer(server);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

import { corsHeaders, errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import { resolvePlayableStream } from '../../_lib/sonic/native-protocols';
import { callLocalEngineStream, getLocalEngineCircuitSnapshot } from '../../_lib/sonic/local-engine';
import {
  checkEngineAccess,
  evaluateGatewayRateLimit,
  buildRateLimitErrorResponse,
  isBlockedSsrfHost,
  validateSafeUrl,
  safeFetch,
  hasSensitiveMediaQuery,
  isSafeFetchCapacityError,
  extractClientIp,
  hasValidEngineSecret,
} from '../../_lib/sonic/security';
import { isMediaContentType, withMediaStreamLimit } from '../../_lib/sonic/media-concurrency';
import { verifyAuth, readCookie } from '../../_lib/auth';
import {
  buildGrantCookieHeaders,
  checkStreamCorsAndFetchMetadata,
  evaluateStreamGuardQuota,
  getTrackGrantCookieName,
  normalizeTrackFingerprint,
  resolveGuardSubject,
  verifyPlaybackGrantToken,
  verifyStreamTicket,
  type CorsCheckResult,
} from '../../_lib/sonic/ticket';
import { getSonicConfig } from '../../_lib/sonic/config';
import {
  getAllowedMediaDomains,
  isSourceEnabledByPolicy,
  normalizeSourceId,
} from '../../_lib/sonic/licensing';
import {
  recordLicensingBlockMetric,
  recordStreamGuardMetric,
  recordStreamMetric,
  redactSensitiveString,
} from '../../_lib/sonic/observability';
import { serveSyntheticAudioLocally } from '../sonic/test-audio';
import type { AppEnv } from '../../_lib/types';

function sanitizeTargetUrl(rawUrl: string, allowedDomains: string[]): URL | null {
  if (allowedDomains.length === 0) return null;
  const res = validateSafeUrl(rawUrl, {
    allowHttp: false,
    allowedDomains,
  });
  return res.valid && res.url ? res.url : null;
}

function isAllowedDirectTargetHost(hostname: string, allowedDomains: string[]): boolean {
  const h = hostname.toLowerCase().trim().replace(/\.+$/, '');
  if (isBlockedSsrfHost(h)) return false;
  return allowedDomains.some((d) => h === d || h.endsWith('.' + d));
}

// Signed / credentialed provider URLs (auth, vkey, token, expiry, ...) must NEVER enter a
// shared cache, must NEVER be exposed via cross-origin 302 Location headers, and upstream
// `private`/`no-store` directives must never be upgraded.
export const SENSITIVE_STREAM_QUERY =
  /^(?:auth|authorization|token|access[_-]?token|refresh[_-]?token|key|api[_-]?key|apikey|sign|signature|sig|vkey|guid|wmid|expires?|expiry|nonce|session|cookie|uid|userid|user[_-]?id|wssecret|wstime|ekey|ckey|vuutv|dis_k|accesskey|code|x-amz-signature|x-amz-credential|x-amz-security-token|ossaccesskeyid|q-signature)$/i;

export function hasSensitiveStreamQuery(target: URL): boolean {
  return hasSensitiveMediaQuery(target);
}

function streamCacheControl(target: URL, upstreamHeaders: Headers, status: number, sensitive = false): string {
  if (sensitive || hasSensitiveStreamQuery(target)) return 'private, no-store';
  if (status !== 200 && status !== 206) return 'no-store';
  const upstreamCacheControl = (upstreamHeaders.get('cache-control') || '').trim();
  const normalized = upstreamCacheControl.toLowerCase();
  if (normalized.includes('no-store')) return 'private, no-store';
  if (normalized.includes('private')) return upstreamCacheControl;
  return 'public, max-age=600';
}

const VALID_PARTIAL_CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;
const VALID_UNSATISFIABLE_CONTENT_RANGE = /^bytes \*\/(\d+)$/i;

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'music-stream');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  return withMediaStreamLimit(request, env, () => serveStream(request, env));
}

async function serveStream(request: Request, env: AppEnv): Promise<Response> {
  const cfg = getSonicConfig(env);
  const allowedDomains = getAllowedMediaDomains(env, 'audio');
  const url = new URL(request.url);
  const targetParam = url.searchParams.get('target') || url.searchParams.get('url');
  let streamMode = (url.searchParams.get('mode') || (url.searchParams.get('redirect') === '1' ? 'redirect' : '')).toLowerCase();

  // ── Stream Guard Phase 1: Access Control & Ticketing Gate ──
  const guardMode = String(env?.SONIC_STREAM_GUARD || 'off').trim().toLowerCase();
  let isAnonymousGuarded = false;
  let guardSetCookieHeaders: string[] = [];
  let corsCheck: CorsCheckResult | undefined;
  const isStrictCors = String(env?.SONIC_CORS_STRICT || '0').trim() === '1';

  if (guardMode === 'monitor' || guardMode === 'enforce') {
    // Constraint C1: Valid API Key caller completely bypasses Stream Guard checks and CORS restrictions
    const isEngineCaller = hasValidEngineSecret(request, env);
    let hasApiKey = isEngineCaller;
    if (!hasApiKey) {
      const auth = await verifyAuth(request, env);
      if (auth.authenticated && auth.source === 'header') {
        hasApiKey = true;
      }
    }

    if (!hasApiKey) {
      isAnonymousGuarded = true;
      recordStreamGuardMetric({ kind: 'anon_request' });

      const rawCookieHeader = request.headers.get('Cookie');
      if ((rawCookieHeader || '').length > 3072) {
        recordStreamGuardMetric({ kind: 'cookie_too_large' });
        console.warn(
          JSON.stringify({
            type: 'stream_guard_cookie_too_large',
            size: (rawCookieHeader || '').length,
          }),
        );
      }

      // 1. Strict CORS & Fetch-Metadata verification (Constraint C4, C5)
      corsCheck = checkStreamCorsAndFetchMetadata(request, env);
      if (!corsCheck.allowed) {
        if (guardMode === 'enforce') {
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'CORS_FORBIDDEN',
                message: `Cross-origin stream request forbidden by security policy (${corsCheck.reason})`,
              },
            },
            {
              status: 403,
              headers: corsHeaders({
                'Cache-Control': 'no-store',
                ...(isStrictCors && corsCheck.allowOriginHeader
                  ? { 'Access-Control-Allow-Origin': corsCheck.allowOriginHeader, Vary: 'Origin' }
                  : {}),
              }),
            },
          );
        }
        console.warn(`[Stream Guard Monitor] CORS violation: ${corsCheck.reason}`);
      }

      // 2. Extract ticket and grant token from Header, Cookie, or Query param
      const rawTrackParam = url.searchParams.get('id') || url.searchParams.get('target') || '';
      const rawSourceParam = (url.searchParams.get('source') || 'netease').toLowerCase().trim();
      const rawBrParam = url.searchParams.get('br') || url.searchParams.get('quality') || '320';
      const purpose = (url.searchParams.get('purpose') === 'download' ? 'download' : 'play') as 'play' | 'download';
      const durationStr = url.searchParams.get('duration');
      const durationSec = durationStr ? parseFloat(durationStr) : undefined;
      const clientIp = extractClientIp(request, env);

      const tid = normalizeTrackFingerprint(rawTrackParam, rawSourceParam, rawBrParam);
      const grantCookieName = getTrackGrantCookieName(tid);

      const subject = await resolveGuardSubject(request, env);

      const grantToken =
        request.headers.get('x-sonic-grant')?.trim() ||
        readCookie(request, grantCookieName)?.trim() ||
        readCookie(request, 'sonic_play_grant')?.trim() ||
        url.searchParams.get('grant')?.trim() ||
        '';

      const ticket =
        request.headers.get('x-sonic-ticket')?.trim() ||
        readCookie(request, 'sonic_play_ticket')?.trim() ||
        url.searchParams.get('t')?.trim() ||
        url.searchParams.get('ticket')?.trim() ||
        '';

      let guardAuthorized = false;
      let guardFailureCode: string | undefined;

      // Check stateless grant token first (for subsequent Range / seek requests across any isolate)
      if (grantToken) {
        const grantCheck = await verifyPlaybackGrantToken(grantToken, {
          id: rawTrackParam,
          source: rawSourceParam,
          br: rawBrParam,
          purpose,
          sub: subject,
          ip: clientIp,
          env,
        });
        if (grantCheck.valid) {
          guardAuthorized = true;
          recordStreamGuardMetric({ kind: 'grant_hit' });
          if (grantCheck.ipDrift) {
            recordStreamGuardMetric({ kind: 'ip_drift', reason: 'ip_drift' });
          }
        } else {
          guardFailureCode = grantCheck.error;
        }
      }

      // If grantToken wasn't present or failed, check ticket
      if (!guardAuthorized && ticket) {
        const ticketCheck = await verifyStreamTicket(ticket, {
          id: rawTrackParam,
          source: rawSourceParam,
          br: rawBrParam,
          purpose,
          sub: subject,
          ip: clientIp,
          durationSec,
          grantToken,
          env,
        });
        if (ticketCheck.valid) {
          guardAuthorized = true;
          if (ticketCheck.ipDrift) {
            recordStreamGuardMetric({ kind: 'ip_drift', reason: 'ip_drift' });
          }
          if (ticketCheck.grantToken) {
            const expiresAtSec =
              ticketCheck.grant?.expiresAtSec ||
              Math.floor(Date.now() / 1000) + 1800;
            guardSetCookieHeaders = buildGrantCookieHeaders(
              rawCookieHeader,
              {
                tid,
                token: ticketCheck.grantToken,
                expiresAtSec,
              },
              request,
            );
          }
        } else {
          guardFailureCode = ticketCheck.error;
        }
      }

      const mapRejectionReason = (
        code?: string,
      ): 'expired' | 'mismatch' | 'session_mismatch' | 'other' => {
        if (!code) return 'other';
        if (code.includes('EXPIRED')) return 'expired';
        if (code.includes('SESSION_MISMATCH')) return 'session_mismatch';
        if (
          code.includes('MISMATCH') ||
          code.includes('INVALID') ||
          code.includes('SIGNATURE') ||
          code.includes('CORRUPTED') ||
          code.includes('MALFORMED')
        ) {
          return 'mismatch';
        }
        return 'other';
      };

      if (!guardAuthorized) {
        if (!ticket && !grantToken) {
          recordStreamGuardMetric({ kind: 'missing_ticket' });
          if (guardMode === 'enforce') {
            return jsonResponse(
              {
                brand: 'Sonic',
                error: {
                  code: 'STREAM_TICKET_REQUIRED',
                  message: 'Playback ticket is required for anonymous stream access in enforce mode',
                },
              },
              { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
            );
          }
          console.warn(
            JSON.stringify({
              type: 'stream_guard_monitor',
              subject,
              event: 'missing_ticket',
              ip: clientIp,
            }),
          );
        } else {
          recordStreamGuardMetric({
            kind: 'rejection',
            reason: mapRejectionReason(guardFailureCode),
          });
          if (guardMode === 'enforce') {
            return jsonResponse(
              {
                brand: 'Sonic',
                error: {
                  code: guardFailureCode || 'INVALID_TICKET',
                  message: `Invalid or expired stream playback ticket (${guardFailureCode || 'UNAUTHORIZED'})`,
                },
              },
              { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
            );
          }
          console.warn(
            JSON.stringify({
              type: 'stream_guard_monitor',
              subject,
              event: 'rejection',
              reason: guardFailureCode,
              mappedReason: mapRejectionReason(guardFailureCode),
              ip: clientIp,
            }),
          );
        }
      }

      // 3. Sliding-window Quota check
      const quotaCheck = await evaluateStreamGuardQuota(subject, rawTrackParam, purpose, env);
      if (!quotaCheck.allowed) {
        if (guardMode === 'enforce') {
          const h = corsHeaders({
            'Cache-Control': 'no-store',
            'Retry-After': String(quotaCheck.retryAfter || 60),
          });
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'STREAM_QUOTA_EXCEEDED',
                message: 'Stream request quota exceeded, please retry later',
              },
            },
            { status: 429, headers: h },
          );
        }
        console.warn(`[Stream Guard Monitor] Quota exceeded for ${subject}: ${quotaCheck.reason}`);
      }

      // 4. In enforce mode, disable redirect mode to prevent upstream URL exposure
      if (guardMode === 'enforce' && streamMode === 'redirect') {
        streamMode = '';
      }
    }
  }
  let targetUrl: URL | null = null;
  let resolvedProvider = 'proxy-target';
  let resolvedVia = 'direct-param';
  let resolvedTrial = false;
  let resolvedStreamType: 'full' | 'trial' | 'unavailable' = 'full';
  let resolvedTrialDuration = 0;
  let resolvedReferer = '';
  let resolvedCorsSafe = false;
  let degraded = false;
  let degradedReason: string | undefined;
  let circuitState: string | undefined;
  let resolvedSource = '';
  let resolvedTrackId = '';
  let resolvedTitle = '';
  let resolvedArtist = '';

  if (targetParam) {
    targetUrl = sanitizeTargetUrl(targetParam, allowedDomains);
    if (!targetUrl || !isAllowedDirectTargetHost(targetUrl.hostname, allowedDomains)) {
      return errorResponse('Invalid target URL', 400);
    }
    if (targetUrl.hostname.includes('kuwo.cn')) resolvedReferer = 'https://www.kuwo.cn/';
    if (targetUrl.hostname.includes('qq.com')) resolvedReferer = 'https://y.qq.com/';
    if (targetUrl.hostname.endsWith('music.126.net')) resolvedCorsSafe = true;
  } else {
    const rawId = url.searchParams.get('id') || '';
    let id = rawId.trim();
    let source = (url.searchParams.get('source') || 'netease').toLowerCase().trim();
    if (id.includes(':')) {
      const parts = id.split(':');
      source = (parts[0] || source).toLowerCase().trim();
      id = parts.slice(1).join(':');
    }
    const normSource = normalizeSourceId(source);
    const quality = url.searchParams.get('quality') || url.searchParams.get('br') || '320';
    const title = url.searchParams.get('title') || '';
    const artist = url.searchParams.get('artist') || '';
    const durationStr = url.searchParams.get('duration');
    const durationSec = durationStr ? parseFloat(durationStr) : undefined;
    const allowTrial = url.searchParams.get('allowTrial') !== '0';
    // Playback retries opt in explicitly; unrelated query flags never disable caches.
    const nocache = url.searchParams.get('nocache') === '1';

    if (!id && !title) {
      return errorResponse('缺少歌曲标识 (Parameter id or title is required)', 400);
    }

    // Content licensing & policy gate (SONIC-P0-07)
    if (!isSourceEnabledByPolicy(normSource, env)) {
      // Allow 'sonic'/'netease' default param to map to synthetic ONLY when synthetic is enabled and no explicit commercial source was forced
      if ((source === 'sonic' || !url.searchParams.has('source')) && cfg.enableSynthetic) {
        source = 'synthetic';
      } else {
        recordLicensingBlockMetric(normSource);
        return jsonResponse(
          {
            brand: 'Sonic',
            error: {
              code: 'SOURCE_DISABLED_BY_POLICY',
              message: `音源 '${normSource}' 在当前内容授权策略 (${cfg.contentPolicy}) 下已禁用`,
            },
          },
          { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
        );
      }
    }

    try {
      const resolved = await resolvePlayableStream(
        {
          id,
          source,
          quality,
          title,
          artist,
          durationSec,
          allowTrial,
          nocache,
          request,
          signal: request.signal,
        },
        env,
      );

      if (!resolved || !resolved.url) {
        recordStreamMetric('err_404');
        return jsonResponse(
          {
            brand: 'Sonic',
            error: {
              code: 'STREAM_NOT_FOUND',
              message: '当前曲目暂无可用音源或受版权限制',
            },
            degraded: false,
            meta: {
              cached: false,
              cacheLevel: 'none',
              provider: 'none',
              attempts: resolved?.attempts || [],
            },
          },
          {
            status: 404,
            headers: corsHeaders({
              'Cache-Control': 'no-store',
              'X-Sonic-Stream-Type': 'unavailable',
              'Access-Control-Expose-Headers': 'X-Sonic-Stream-Type',
            }),
          },
        );
      }

      recordStreamMetric('resolved_ok');

      // First-party Authorized Synthetic PCM/WAV stream path (Pages -> Tunnel -> Linux Engine -> Synthetic WAV)
      if (
        cfg.enableSynthetic &&
        (resolved.provider === 'synthetic' ||
          resolved.provider === 'local-synthetic' ||
          normalizeSourceId(source) === 'synthetic')
      ) {
        const synId = id || 'syn-440hz';
        const isFaultId = /^syn-fault-/i.test(synId);
        if (cfg.enableLocalEngine && !isFaultId) {
          const engineStream = await callLocalEngineStream(
            `/api/sonic/test-audio?id=${encodeURIComponent(synId)}`,
            env,
            { request, method: request.method as 'GET' | 'HEAD', signal: request.signal },
          );
          if (engineStream.ok && engineStream.response) {
            const outHeaders = new Headers(engineStream.response.headers);
            outHeaders.set('X-Sonic-Provider', 'local-synthetic');
            outHeaders.set('X-Sonic-Via', 'local-engine');
            if (isAnonymousGuarded) {
              outHeaders.set('Cache-Control', 'private, no-store');
              for (const sc of guardSetCookieHeaders) {
                outHeaders.append('Set-Cookie', sc);
              }
              if (isStrictCors) {
                if (corsCheck?.allowOriginHeader) {
                  outHeaders.set('Access-Control-Allow-Origin', corsCheck.allowOriginHeader);
                  outHeaders.append('Vary', 'Origin');
                } else {
                  outHeaders.delete('Access-Control-Allow-Origin');
                }
              }
            }
            if (engineStream.response.status === 206) recordStreamMetric('proxied_206');
            else if (engineStream.response.status === 200) recordStreamMetric('proxied_200');
            return new Response(engineStream.response.body, {
              status: engineStream.response.status,
              headers: outHeaders,
            });
          }
          recordStreamMetric('degraded');
        }
        const fallbackResp = await serveSyntheticAudioLocally(
          synId,
          request.method,
          request.headers.get('Range'),
          cfg.runtime === 'linux-engine' ? 'local-engine' : 'edge-degraded-synthetic',
        );
        const h = new Headers(fallbackResp.headers);
        if (cfg.enableLocalEngine && !isFaultId) {
          h.set('X-Sonic-Degraded', '1');
        }
        if (isAnonymousGuarded) {
          h.set('Cache-Control', 'private, no-store');
          for (const sc of guardSetCookieHeaders) {
            h.append('Set-Cookie', sc);
          }
          if (isStrictCors) {
            if (corsCheck?.allowOriginHeader) {
              h.set('Access-Control-Allow-Origin', corsCheck.allowOriginHeader);
              h.append('Vary', 'Origin');
            } else {
              h.delete('Access-Control-Allow-Origin');
            }
          }
        }
        return new Response(fallbackResp.body, { status: fallbackResp.status, headers: h });
      }

      targetUrl = sanitizeTargetUrl(resolved.url, allowedDomains);
      if (!targetUrl) {
        recordStreamMetric('err_5xx');
        return errorResponse('解析到的音频流地址无效或不在已授权域名白名单内', 502);
      }

      resolvedProvider = resolved.provider;
      resolvedVia = resolved.via;
      resolvedTrial = Boolean(resolved.isTrial || resolved.streamType === 'trial');
      resolvedStreamType = resolved.streamType || (resolvedTrial ? 'trial' : 'full');
      resolvedTrialDuration = resolved.trialDuration || (resolvedTrial ? 30 : 0);
      resolvedReferer = resolved.referer || '';
      resolvedCorsSafe = resolved.corsSafe;
      degraded = resolved.degraded;
      degradedReason = resolved.degradedReason;
      circuitState = resolved.circuitState;
      // A resolver/provider label is not a track namespace. Publish only an atomic
      // verified pair; never combine a fallback provider with the original ID.
      if (resolved.resolvedSource && resolved.resolvedId) {
        resolvedSource = normalizeSourceId(resolved.resolvedSource);
        resolvedTrackId = resolved.resolvedId;
        resolvedTitle = resolved.resolvedTitle || title;
        resolvedArtist = resolved.resolvedArtist || artist;
      }
    } catch (err: any) {
      request.signal.throwIfAborted();
      recordStreamMetric('err_5xx');
      return errorResponse(redactSensitiveString(err?.message || '解析音频流失败'), 502);
    }
  }

  if (!targetUrl) {
    return errorResponse('无法解析音频目标地址', 500);
  }

  // Default: Same-Origin Byte-Range Stream Proxy (preserves CORS `Content-Range`, anti-hotlink `Referer`, and HTTPS)
  try {
    const requestHeaders: Record<string, string> = {
      'User-Agent':
        request.headers.get('User-Agent') ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (resolvedReferer) {
      requestHeaders.Referer = resolvedReferer;
    } else if (targetUrl.hostname.includes('kuwo.cn')) {
      requestHeaders.Referer = 'https://www.kuwo.cn/';
    } else if (targetUrl.hostname.includes('qq.com')) {
      requestHeaders.Referer = 'https://y.qq.com/';
    }

    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      requestHeaders.Range = rangeHeader;
    }

    const upstream = await safeFetch(
      targetUrl,
      {
        method: request.method,
        headers: requestHeaders,
        // 客户端断开时同步取消上游请求；safeFetch 会将其与自身 15s 超时及流式取消组合。
        signal: request.signal,
      },
      {
        allowHttp: false,
        allowedDomains,
        maxRedirects: 3,
        timeoutMs: 15000,
        maxBytes: 256 * 1024 * 1024,
        includeMetadata: true,
        pool: 'media',
      },
    );

    const upstreamSensitive = Boolean(upstream.sensitive);
    const finalTargetUrl = upstream.finalUrl || targetUrl;
    const status = upstream.status;

    // 1. Handle upstream HTTP error statuses explicitly BEFORE content-type checks,
    //    never relaying upstream HTML/XML error bodies and never caching non-200/206 responses.
    if (status === 416) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_416');
      const h416 = corsHeaders({
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      });
      const cr = (upstream.headers.get('content-range') || '').trim();
      if (VALID_UNSATISFIABLE_CONTENT_RANGE.test(cr) || VALID_PARTIAL_CONTENT_RANGE.test(cr)) {
        h416.set('Content-Range', cr);
        h416.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');
      }
      return jsonResponse(
        {
          brand: 'Sonic',
          error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested audio byte range is not satisfiable' },
        },
        { status: 416, headers: h416 },
      );
    }

    if (status === 401 || status === 403) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_403');
      return jsonResponse(
        {
          brand: 'Sonic',
          error: { code: 'UPSTREAM_FORBIDDEN', message: '上游音频 CDN 拒绝访问或签名已过期' },
        },
        { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
      );
    }

    if (status === 404 || status === 410) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_404');
      return jsonResponse(
        {
          brand: 'Sonic',
          error: { code: 'STREAM_NOT_FOUND', message: '上游音频资源不存在或已下架' },
        },
        { status: 404, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
      );
    }

    if (status === 429) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_429');
      const h429 = corsHeaders({ 'Cache-Control': 'no-store' });
      const retryAfter = (upstream.headers.get('retry-after') || '').trim();
      if (/^\d{1,5}$/.test(retryAfter)) {
        h429.set('Retry-After', retryAfter);
      }
      return jsonResponse(
        {
          brand: 'Sonic',
          error: { code: 'UPSTREAM_RATE_LIMITED', message: '上游音频 CDN 触发限流，请稍后重试' },
        },
        { status: 429, headers: h429 },
      );
    }

    if (status >= 500) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_5xx');
      return jsonResponse(
        {
          brand: 'Sonic',
          error: { code: 'UPSTREAM_ERROR', message: `上游音频服务异常 (HTTP ${status})` },
        },
        { status: 502, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
      );
    }

    // 2. Verify active-content safety on 2xx responses
    if (!isMediaContentType(upstream.headers.get('content-type'))) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_415');
      return errorResponse('Upstream returned a non-audio content type', 415);
    }

    if (status !== 200 && status !== 206) {
      upstream.body?.cancel().catch(() => {});
      recordStreamMetric('err_5xx');
      return errorResponse(`Unexpected upstream status ${status}`, 502);
    }

    // 3. Validate Content-Range / Content-Length consistency
    const headers = corsHeaders();
    const hasContentEncoding = upstream.headers.has('content-encoding');
    const rawContentRange = (upstream.headers.get('content-range') || '').trim();
    const rawContentLength = (upstream.headers.get('content-length') || '').trim();

    if (status === 206) {
      const m = rawContentRange.match(VALID_PARTIAL_CONTENT_RANGE);
      if (!m) {
        upstream.body?.cancel().catch(() => {});
        recordStreamMetric('err_5xx');
        return jsonResponse(
          {
            brand: 'Sonic',
            error: { code: 'UPSTREAM_INVALID_RANGE', message: 'Upstream 206 response missing valid Content-Range' },
          },
          { status: 502, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
        );
      }
      const startByte = parseInt(m[1], 10);
      const endByte = parseInt(m[2], 10);
      const totalPart = m[3] === '*' ? null : parseInt(m[3], 10);
      if (
        startByte > endByte ||
        (totalPart !== null && (totalPart <= 0 || endByte >= totalPart))
      ) {
        upstream.body?.cancel().catch(() => {});
        recordStreamMetric('err_5xx');
        return jsonResponse(
          {
            brand: 'Sonic',
            error: { code: 'UPSTREAM_INVALID_RANGE', message: 'Upstream 206 Content-Range bounds are inconsistent' },
          },
          { status: 502, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
        );
      }
      const expectedSpan = endByte - startByte + 1;
      if (!hasContentEncoding && rawContentLength) {
        const declaredLen = parseInt(rawContentLength, 10);
        if (Number.isFinite(declaredLen) && declaredLen !== expectedSpan) {
          upstream.body?.cancel().catch(() => {});
          recordStreamMetric('err_5xx');
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'UPSTREAM_LENGTH_MISMATCH',
                message: 'Upstream Content-Length does not match Content-Range byte span',
              },
            },
            { status: 502, headers: corsHeaders({ 'Cache-Control': 'no-store' }) },
          );
        }
      }
      headers.set('Content-Range', rawContentRange);
      if (!hasContentEncoding) {
        headers.set('Content-Length', rawContentLength || String(expectedSpan));
      }
    } else if (!hasContentEncoding && rawContentLength && /^\d+$/.test(rawContentLength)) {
      headers.set('Content-Length', rawContentLength);
    }

    for (const key of ['content-type', 'accept-ranges', 'etag', 'last-modified']) {
      const val = upstream.headers.get(key);
      if (val) headers.set(key, val);
    }

    if (!headers.has('Accept-Ranges')) {
      headers.set('Accept-Ranges', 'bytes');
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'audio/mpeg');
    }
    if (isAnonymousGuarded) {
      headers.set('Cache-Control', 'private, no-store');
      for (const sc of guardSetCookieHeaders) {
        headers.append('Set-Cookie', sc);
      }
      if (isStrictCors) {
        if (corsCheck?.allowOriginHeader) {
          headers.set('Access-Control-Allow-Origin', corsCheck.allowOriginHeader);
          headers.append('Vary', 'Origin');
        } else {
          headers.delete('Access-Control-Allow-Origin');
        }
      }
    } else {
      headers.set('Cache-Control', streamCacheControl(finalTargetUrl, upstream.headers, status, upstreamSensitive));
    }
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Sonic-Provider', resolvedProvider);
    headers.set('X-Sonic-Via', resolvedVia);
    headers.set('X-Sonic-Stream-Type', resolvedStreamType);
    if (resolvedTrial) headers.set('X-Sonic-Stream-Trial', '1');
    if (resolvedTrialDuration > 0) headers.set('X-Sonic-Trial-Duration', String(resolvedTrialDuration));
    if (degraded) {
      headers.set('X-Sonic-Degraded', '1');
      if (degradedReason) headers.set('X-Sonic-Degraded-Reason', encodeURIComponent(degradedReason));
    }
    if (circuitState) headers.set('X-Sonic-Circuit', circuitState);
    if (resolvedSource) headers.set('X-Sonic-Resolved-Source', resolvedSource);
    if (resolvedTrackId) headers.set('X-Sonic-Resolved-Id', resolvedTrackId);
    if (resolvedTitle) headers.set('X-Sonic-Resolved-Title', encodeURIComponent(resolvedTitle));
    if (resolvedArtist) headers.set('X-Sonic-Resolved-Artist', encodeURIComponent(resolvedArtist));
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Sonic-Provider, X-Sonic-Via, X-Sonic-Stream-Trial, X-Sonic-Stream-Type, X-Sonic-Trial-Duration, X-Sonic-Degraded, X-Sonic-Circuit, X-Sonic-Resolved-Source, X-Sonic-Resolved-Id, X-Sonic-Resolved-Title, X-Sonic-Resolved-Artist',
    );

    // Resolve and validate every redirect before emitting a Location. If any hop was
    // signed, private, or the final host's CORS policy is unknown, reuse the fetched body.
    if (
      streamMode === 'redirect' &&
      resolvedCorsSafe &&
      finalTargetUrl.protocol === 'https:' &&
      finalTargetUrl.origin === targetUrl.origin &&
      !upstreamSensitive &&
      !hasSensitiveStreamQuery(finalTargetUrl) &&
      !/private|no-store/i.test(upstream.headers.get('cache-control') || '')
    ) {
      void upstream.body?.cancel().catch(() => {});
      for (const name of ['Content-Length', 'Content-Range', 'Content-Type', 'ETag', 'Last-Modified', 'Accept-Ranges']) {
        headers.delete(name);
      }
      headers.set('Location', finalTargetUrl.toString());
      headers.set('Cache-Control', 'private, no-store');
      return new Response(null, { status: 302, headers });
    }

    recordStreamMetric(status === 206 ? 'proxied_206' : 'proxied_200');
    return new Response(upstream.body, {
      status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err: any) {
    request.signal.throwIfAborted();
    if (isSafeFetchCapacityError(err)) {
      return jsonResponse(
        { brand: 'Sonic', error: { code: 'UPSTREAM_BUSY', message: 'Upstream capacity is temporarily exhausted' } },
        { status: 503, headers: corsHeaders({ 'Cache-Control': 'no-store', 'Retry-After': '1' }) },
      );
    }
    const rawMsg = String(err?.message || 'Proxy error');
    const isTimeout =
      err?.name === 'TimeoutError' ||
      err?.name === 'AbortError' ||
      /timeout|timed out|aborted/i.test(rawMsg);
    recordStreamMetric(isTimeout ? 'err_timeout' : 'err_5xx');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'STREAM_PROXY_ERROR',
          message: `音频数据流传输错误: ${redactSensitiveString(rawMsg)}`,
        },
      },
      {
        status: isTimeout ? 504 : 502,
        headers: corsHeaders({ 'Cache-Control': 'no-store' }),
      },
    );
  }
}

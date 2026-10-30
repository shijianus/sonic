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
} from '../../_lib/sonic/security';
import { getSonicConfig } from '../../_lib/sonic/config';
import {
  getAllowedMediaDomains,
  isSourceEnabledByPolicy,
  normalizeSourceId,
} from '../../_lib/sonic/licensing';
import {
  recordLicensingBlockMetric,
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

// Proxied bytes are served from the Sonic origin, so HTML/SVG/XML responses must never be relayed.
function isPlayableMediaType(contentType: string | null): boolean {
  const value = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!value) return true;
  return (
    value.startsWith('audio/') ||
    value.startsWith('video/') ||
    value === 'application/octet-stream' ||
    value === 'binary/octet-stream'
  );
}

// Signed / credentialed provider URLs (auth, vkey, token, expiry, ...) must NEVER enter a
// shared cache, must NEVER be exposed via cross-origin 302 Location headers, and upstream
// `private`/`no-store` directives must never be upgraded.
export const SENSITIVE_STREAM_QUERY =
  /^(?:auth|authorization|token|access[_-]?token|refresh[_-]?token|key|api[_-]?key|apikey|sign|signature|sig|vkey|guid|wmid|expires?|expiry|nonce|session|cookie|uid|userid|user[_-]?id|wssecret|wstime|ekey|ckey|x-amz-signature|x-amz-credential|x-amz-security-token|ossaccesskeyid|q-signature)$/i;

export function hasSensitiveStreamQuery(target: URL): boolean {
  return Array.from(target.searchParams.keys()).some((name) => SENSITIVE_STREAM_QUERY.test(name));
}

function streamCacheControl(target: URL, upstreamHeaders: Headers, status: number): string {
  if (status !== 200 && status !== 206) return 'no-store';
  const upstreamCacheControl = (upstreamHeaders.get('cache-control') || '').trim();
  const normalized = upstreamCacheControl.toLowerCase();
  if (normalized.includes('no-store')) return 'no-store';
  if (hasSensitiveStreamQuery(target)) return 'private, no-store';
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

  const cfg = getSonicConfig(env);
  const allowedDomains = getAllowedMediaDomains(env);
  const url = new URL(request.url);
  const targetParam = url.searchParams.get('target') || url.searchParams.get('url');
  const streamMode = (url.searchParams.get('mode') || (url.searchParams.get('redirect') === '1' ? 'redirect' : '')).toLowerCase();
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
    const nocache = url.searchParams.has('nocache');

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
        },
        env,
      );

      if (!resolved || !resolved.url) {
        const snap = getLocalEngineCircuitSnapshot(env);
        const isEngineDegraded = cfg.enableLocalEngine && (snap.state !== 'CLOSED' || Boolean(snap.lastError));

        if (isEngineDegraded) {
          recordStreamMetric('degraded');
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'STREAM_UNAVAILABLE_DEGRADED',
                message: '本地解析引擎暂不可用，边缘降级模式无法获取该曲目音频流',
              },
              degraded: true,
              meta: {
                cached: false,
                cacheLevel: 'none',
                provider: 'none',
                degraded: true,
                degradedReason: snap.lastError || 'local_engine_unavailable',
                circuitState: snap.state,
              },
            },
            {
              status: 503,
              headers: corsHeaders({
                'Cache-Control': 'no-store',
                'X-Sonic-Stream-Type': 'unavailable',
                'X-Sonic-Degraded': '1',
                'X-Sonic-Circuit': snap.state,
                'Access-Control-Expose-Headers':
                  'X-Sonic-Stream-Type, X-Sonic-Degraded, X-Sonic-Circuit, X-Sonic-Provider',
              }),
            },
          );
        }

        recordStreamMetric('err_404');
        return jsonResponse(
          {
            brand: 'Sonic',
            error: {
              code: 'STREAM_NOT_FOUND',
              message: '无法解析可播放音频流（该曲目可能受版权或地区限制）',
            },
            degraded: false,
            meta: {
              cached: false,
              cacheLevel: 'none',
              provider: 'none',
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
        if (cfg.enableLocalEngine) {
          const engineStream = await callLocalEngineStream(
            `/api/sonic/test-audio?id=${encodeURIComponent(synId)}`,
            env,
            { request, method: request.method as 'GET' | 'HEAD', signal: request.signal },
          );
          if (engineStream.ok && engineStream.response) {
            const outHeaders = new Headers(engineStream.response.headers);
            outHeaders.set('X-Sonic-Provider', 'local-synthetic');
            outHeaders.set('X-Sonic-Via', 'local-engine');
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
        if (cfg.enableLocalEngine) {
          const h = new Headers(fallbackResp.headers);
          h.set('X-Sonic-Degraded', '1');
          return new Response(fallbackResp.body, { status: fallbackResp.status, headers: h });
        }
        return fallbackResp;
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
    } catch (err: any) {
      recordStreamMetric('err_5xx');
      return errorResponse(redactSensitiveString(err?.message || '解析音频流失败'), 502);
    }
  }

  if (!targetUrl) {
    return errorResponse('无法解析音频目标地址', 500);
  }

  // Optional Direct 302 Redirect Mode:
  // ONLY allowed when caller passes `?mode=redirect`, CDN is HTTPS + CORS-safe, AND the target URL
  // carries ZERO sensitive/signed query parameters (prevents leaking signed tokens via Location or cache).
  if (
    streamMode === 'redirect' &&
    targetUrl.protocol === 'https:' &&
    resolvedCorsSafe &&
    !hasSensitiveStreamQuery(targetUrl)
  ) {
    const redirectHeaders = corsHeaders();
    redirectHeaders.set('Location', targetUrl.toString());
    redirectHeaders.set('Cache-Control', 'private, no-store');
    redirectHeaders.set('Referrer-Policy', 'no-referrer');
    redirectHeaders.set('X-Sonic-Provider', resolvedProvider);
    redirectHeaders.set('X-Sonic-Via', resolvedVia);
    redirectHeaders.set('X-Sonic-Stream-Type', resolvedStreamType);
    if (resolvedTrial) redirectHeaders.set('X-Sonic-Stream-Trial', '1');
    if (resolvedTrialDuration > 0) redirectHeaders.set('X-Sonic-Trial-Duration', String(resolvedTrialDuration));
    if (degraded) redirectHeaders.set('X-Sonic-Degraded', '1');
    redirectHeaders.set(
      'Access-Control-Expose-Headers',
      'X-Sonic-Provider, X-Sonic-Via, X-Sonic-Stream-Trial, X-Sonic-Stream-Type, X-Sonic-Trial-Duration, X-Sonic-Degraded',
    );
    return new Response(null, { status: 302, headers: redirectHeaders });
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
      },
    );

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
    if (!isPlayableMediaType(upstream.headers.get('content-type'))) {
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
    headers.set('Cache-Control', streamCacheControl(targetUrl, upstream.headers, status));
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
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Sonic-Provider, X-Sonic-Via, X-Sonic-Stream-Trial, X-Sonic-Stream-Type, X-Sonic-Trial-Duration, X-Sonic-Degraded, X-Sonic-Circuit',
    );

    recordStreamMetric(status === 206 ? 'proxied_206' : 'proxied_200');
    return new Response(upstream.body, {
      status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (err: any) {
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

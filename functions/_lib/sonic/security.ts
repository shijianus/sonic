// Sonic Gateway — Inter-Service Authentication & Tiered Rate Limiter
// Enforces:
// 1. Mandatory constant-time X-Sonic-Engine-Key verification on `engine-sonic.*` and internal engine endpoints
// 2. Sliding-window rate limiting at both Edge (Pages -> Engine hop protection) and Engine layers
// 3. SSRF Triple Validation: Protocol (https only), Port (80/443), Host canonicalization (IPv4/IPv6/domain whitelist)

import {
  getAllowedMediaDomains,
} from './licensing';
import type { AppEnv } from '../types';
import { extractAuthCredentials, readCookie, shouldUseSecureCookie, verifyAuth } from '../auth';
import { isEnvEnabled } from './config';
import { isCloudflarePages, isProductionEnvironment } from './environment';
import { jsonResponse } from '../http';
import { sha256Bytes, sha256Hex } from './crypto';
import {
  recordRateLimitMetric,
  redactSensitiveString,
  type RateLimitBackendKind,
} from './observability';

// Provider-specific media boundaries are sourced from the licensing registry. Keep this
// compatibility snapshot for callers that imported the old constant; production call sites
// should use getAllowedMediaDomains(env, capability) so policy flags and capability boundaries
// are applied at request time.
export const SONIC_ALLOWED_MUSIC_DOMAINS = getAllowedMediaDomains();

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  // Compare fixed-length digests so neither content nor length influences timing.
  const hashA = sha256Bytes(a);
  const hashB = sha256Bytes(b);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0;
}

export function hasValidEngineSecret(request: Request, env?: AppEnv): boolean {
  const configured = env?.SONIC_ENGINE_SECRET ? String(env.SONIC_ENGINE_SECRET).trim() : '';
  if (!configured || configured.length < 32) return false;
  const headerKey = request.headers.get('X-Sonic-Engine-Key')?.trim() || '';
  if (!headerKey) return false;
  if (timingSafeEqualStr(headerKey, configured)) return true;
  const previous = (env as any)?.SONIC_ENGINE_SECRET_PREV ? String((env as any).SONIC_ENGINE_SECRET_PREV).trim() : '';
  if (previous && previous.length >= 32 && timingSafeEqualStr(headerKey, previous)) return true;
  return false;
}

export function normalizeEnginePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * Path used for authorization decisions.
 *
 * Cloudflare Pages matches Functions routes case-insensitively (its generated
 * router compiles `path-to-regexp` without `sensitive`), so every security check
 * must make the same decision for `/api/...`, `/API/...` and encoded variants.
 * Never use the raw pathname for an allow/deny decision.
 */
export function canonicalPolicyPath(input: string | Request): string {
  const raw = typeof input === 'string' ? input : new URL(input.url).pathname;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw value when it is not valid percent-encoding; it cannot match
    // a canonical route and therefore fails closed against the /api prefix.
  }
  return decoded.replace(/\/+$/, '').toLowerCase() || '/';
}

export function requiresEngineAuth(request: Request, env?: AppEnv): boolean {
  const pathname = canonicalPolicyPath(request);
  const isEngineSurface =
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/proxy' ||
    pathname === '/palette';

  // The Linux engine is a service-facing process: every API surface it serves requires the
  // inter-service key. Host / X-Forwarded-Host are never consulted, so a client cannot change
  // the auth requirement by rewriting headers.
  if (env?.SONIC_RUNTIME === 'linux-engine') {
    return isEngineSurface;
  }

  if (isEnvEnabled(env?.SONIC_REQUIRE_ENGINE_AUTH, false)) {
    return isEngineSurface;
  }

  // Internal engine-only routes stay protected even on the public Pages edge.
  return pathname.startsWith('/api/sonic/engine/') || pathname.startsWith('/api/sonic/resolve/');
}

export function checkEngineAccess(request: Request, env?: AppEnv): Response | null {
  if (!requiresEngineAuth(request, env)) {
    return null;
  }

  const configured = env?.SONIC_ENGINE_SECRET ? String(env.SONIC_ENGINE_SECRET).trim() : '';
  if (!configured || configured.length < 32) {
    console.error(
      '[Sonic Engine Access] SONIC_ENGINE_SECRET is missing or shorter than 32 characters; rejecting access (fail closed)',
    );
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'ENGINE_MISCONFIGURED',
          message: 'Engine secret is not configured or shorter than 32 characters; anonymous access to engine endpoint is forbidden',
        },
      },
      { status: 503 },
    );
  }

  if (!hasValidEngineSecret(request, env)) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'ENGINE_UNAUTHORIZED',
          message: 'Valid X-Sonic-Engine-Key header is required to access Sonic Local Engine',
        },
      },
      {
        status: 401,
        headers: {
          'WWW-Authenticate': 'SonicEngineKey realm="sonic-local-engine"',
        },
      },
    );
  }

  return null;
}

export const SONIC_STAGING_COOKIE = 'sonic_staging_access';
// __Host- prefix (audit P1-6): the prefixed name is written on secure origins and
// both names are read during the migration window.
export const SONIC_STAGING_COOKIE_HOST_PREFIXED = `__Host-${SONIC_STAGING_COOKIE}`;

// Staging-token brute-force guard (audit P2-14). The staging gate runs BEFORE
// the gateway rate limiter, so invalid token attempts need their own small
// per-IP budget: 10 failures per minute, success resets the counter.
const STAGING_FAILURE_WINDOW_MS = 60_000;
const STAGING_FAILURE_LIMIT = 10;
const stagingFailures = new Map<string, { count: number; resetAt: number }>();

function recordStagingTokenFailure(ip: string): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  let bucket = stagingFailures.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    if (stagingFailures.size >= 2048) {
      for (const [key, value] of stagingFailures) {
        if (now >= value.resetAt) stagingFailures.delete(key);
      }
      while (stagingFailures.size >= 2048) {
        const oldest = stagingFailures.keys().next().value;
        if (!oldest) break;
        stagingFailures.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + STAGING_FAILURE_WINDOW_MS };
    stagingFailures.set(ip, bucket);
  }
  bucket.count += 1;
  return {
    blocked: bucket.count > STAGING_FAILURE_LIMIT,
    retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function resetStagingFailureLimiterForTest(): void {
  stagingFailures.clear();
}

/**
 * Controlled Staging / Preview Access Gate.
 * When `SONIC_STAGING_ACCESS_TOKEN` (>= 16 chars) is configured, anonymous public traffic
 * is rejected with 401 before reaching SPA assets or API routes, and search indexing is blocked.
 */
export function checkStagingAccessGate(request: Request, env?: AppEnv): Response | null {
  // Invite mode owns the browser access lifecycle. Do not stack the legacy shared
  // staging token in front of the invite form or OAuth lifecycle routes.
  if (String(env?.SONIC_ACCESS_MODE || '').trim().toLowerCase() === 'invite') return null;
  const rawToken = env?.SONIC_STAGING_ACCESS_TOKEN ? String(env.SONIC_STAGING_ACCESS_TOKEN).trim() : '';
  if (!rawToken) return null;

  if (rawToken.length < 16) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'STAGING_MISCONFIGURED',
          message: 'SONIC_STAGING_ACCESS_TOKEN must be at least 16 characters when enabled',
        },
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      },
    );
  }

  if (hasValidEngineSecret(request, env)) {
    return null;
  }

  const clientIp = getPublicClientIp(request);

  const headerToken = request.headers.get('X-Sonic-Staging-Token')?.trim() || '';
  if (headerToken && timingSafeEqualStr(headerToken, rawToken)) {
    stagingFailures.delete(clientIp);
    return null;
  }

  const cookieToken = (readCookie(request, SONIC_STAGING_COOKIE_HOST_PREFIXED) ?? readCookie(request, SONIC_STAGING_COOKIE)) || '';
  if (cookieToken && timingSafeEqualStr(cookieToken, rawToken)) {
    stagingFailures.delete(clientIp);
    return null;
  }

  // Browser bootstrap: `?staging_token=<token>` exchanges into an HttpOnly cookie and strips URL param
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('staging_token')?.trim() || '';
  if (queryToken && (request.method === 'GET' || request.method === 'HEAD') && timingSafeEqualStr(queryToken, rawToken)) {
    stagingFailures.delete(clientIp);
    url.searchParams.delete('staging_token');
    const secure = shouldUseSecureCookie(url);
    const secureAttr = secure ? '; Secure' : '';
    const cookieName = secure ? SONIC_STAGING_COOKIE_HOST_PREFIXED : SONIC_STAGING_COOKIE;
    // Collapse leading slashes so a path such as `//evil.example` cannot turn the
    // bootstrap redirect into a protocol-relative cross-origin redirect.
    const safePath = `/${url.pathname.replace(/^\/+/, '')}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: safePath + (url.search || ''),
        // Secure origins write the __Host- name; the legacy name keeps working
        // as a read fallback during the migration window.
        'Set-Cookie': `${cookieName}=${encodeURIComponent(rawToken)}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=86400`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    });
  }

  // Failed header/cookie/query attempts draw from the dedicated per-IP budget
  // before the 401 goes out; exhausted budgets get an explicit 429 (P2-14).
  const failure = recordStagingTokenFailure(clientIp);
  if (failure.blocked) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'STAGING_TOKEN_RATE_LIMITED',
          message: 'Too many invalid staging token attempts; retry later',
        },
      },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(failure.retryAfterSec),
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      },
    );
  }

  return jsonResponse(
    {
      brand: 'Sonic',
      error: {
        code: 'STAGING_ACCESS_REQUIRED',
        message: 'Staging environment is restricted to authorized beta testers (provide X-Sonic-Staging-Token)',
      },
    },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'SonicStagingToken realm="sonic-staging"',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    },
  );
}

// ── IP Extraction and Validation ──

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIpv6Hextets(input: string): number[] | null {
  let value = input.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  if (!value.includes(':')) return null;

  const embeddedV4 = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedV4) {
    const v4 = parseIpv4ToUint32(embeddedV4[1]);
    if (v4 === null) return null;
    const high = ((v4 >>> 16) & 0xffff).toString(16);
    const low = (v4 & 0xffff).toString(16);
    value = `${value.slice(0, value.length - embeddedV4[1].length)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const zeroCount = 8 - head.length - tail.length;
    if (zeroCount < 1) return null;
    groups = [...head, ...Array.from({ length: zeroCount }, () => '0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const hextets: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }
  return hextets;
}

export function isValidIpLiteral(ip: string): boolean {
  const trimmed = ip.trim().replace(/^\[|\]$/g, '');
  return IPV4_REGEX.test(trimmed) || parseIpv6Hextets(trimmed) !== null;
}

export function getPublicClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP')?.trim();
  if (cfIp && isValidIpLiteral(cfIp)) {
    return cfIp.replace(/^\[|\]$/g, '');
  }
  return 'unknown';
}

export function getForwardedClientIp(request: Request, env?: AppEnv): string {
  if (!hasValidEngineSecret(request, env)) {
    return 'unknown';
  }
  const forwarded = request.headers.get('X-Sonic-Client-IP')?.trim();
  if (forwarded && isValidIpLiteral(forwarded)) {
    return forwarded.replace(/^\[|\]$/g, '');
  }
  return 'unknown';
}

export function extractClientIp(request: Request, env?: AppEnv): string {
  return hasValidEngineSecret(request, env)
    ? getForwardedClientIp(request, env)
    : getPublicClientIp(request);
}

export function isSameOriginRequest(request: Request, strict = false): boolean {
  let expectedOrigin = '';
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return false;
  }
  const origin = request.headers.get('origin');
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';
  // In strict mode (cookie-authenticated writes), missing browser headers
  // means we cannot verify origin — reject defensively.
  if (strict) return false;
  // Non-browser clients that manually attach a Cookie and a custom method are allowed;
  // browsers attach Origin/Referer/Sec-Fetch-Site to unsafe requests.
  return true;
}

// ── Sliding-Window Rate Limiter ──

interface WindowCounter {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, WindowCounter>();
const MAX_RATE_BUCKETS = 4096;
const RATE_LIMIT_OVERFLOW_KEY = '__sonic_rate_limit_overflow__';

export interface RateLimitDecision {
  allowed: boolean;
  tier: 'engine' | 'api-key' | 'anonymous';
  limit: number;
  remaining: number;
  resetSec: number;
  backend?: RateLimitBackendKind;
  degraded?: boolean;
}

function requireDistributedRateLimit(env?: AppEnv): boolean {
  // Production Pages deployments must bind the native atomic limiter. Without
  // it, per-isolate memory limits are trivially bypassed by replica fan-out.
  const productionEdge = isCloudflarePages(env) && isProductionEnvironment(env) && env?.SONIC_RUNTIME !== 'linux-engine';
  return isEnvEnabled(env?.SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT, productionEdge);
}

export function getRateLimitConfigStatus(env?: AppEnv): {
  configuredBackend: 'native' | 'kv' | 'memory';
  distributedAtomic: boolean;
  requireDistributed: boolean;
  failClosedOnDegrade: boolean;
  productionCompliant: boolean;
} {
  const hasNative = Boolean((env as any)?.RATE_LIMITER && typeof (env as any).RATE_LIMITER.limit === 'function');
  const kv = env?.RATE_LIMIT_KV || env?.KV;
  const hasKv = Boolean(kv && typeof kv.get === 'function' && typeof kv.put === 'function');
  const configuredBackend = hasNative ? 'native' : hasKv ? 'kv' : 'memory';
  const isSingleNodeEngine = env?.SONIC_RUNTIME === 'linux-engine';
  const distributedAtomic = hasNative || isSingleNodeEngine;
  const requireDistributed = requireDistributedRateLimit(env);
  const failClosedOnDegrade = isEnvEnabled(env?.SONIC_RATE_LIMIT_FAIL_CLOSED, true);
  return {
    configuredBackend,
    distributedAtomic,
    requireDistributed,
    failClosedOnDegrade,
    productionCompliant: distributedAtomic,
  };
}

export async function evaluateGatewayRateLimit(
  request: Request,
  env?: AppEnv,
  scope = 'api',
  options?: { allowAnonymous?: boolean },
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowMs = 60_000;
  const isSingleNodeEngine = env?.SONIC_RUNTIME === 'linux-engine';

  const isEngineCaller = hasValidEngineSecret(request, env);
  const ip = isEngineCaller ? getForwardedClientIp(request, env) : getPublicClientIp(request);

  let tier: 'engine' | 'api-key' | 'anonymous' = 'anonymous';
  // Clamp configured limits to safe range [1, 10000]
  let limit = Math.min(
    10000,
    Math.max(1, parseInt(String(env?.SONIC_RATE_LIMIT_ANON_RPM || '240'), 10) || 240),
  );
  let subject = `anon:${ip}`;

  if (isEngineCaller) {
    tier = 'engine';
    limit = Math.min(20000, Math.max(limit * 2, 600));
    subject = `engine:${ip}`;
  } else {
    const authResult = await verifyAuth(request, env || {});
    if (authResult.authenticated && authResult.user) {
      tier = 'api-key';
      limit = Math.min(
        10000,
        Math.max(1, parseInt(String(env?.SONIC_RATE_LIMIT_AUTH_RPM || '600'), 10) || 600),
      );
      subject = `user:${sha256Hex(authResult.user.email.toLowerCase()).slice(0, 32)}`;
    } else if (isEnvEnabled(env?.SONIC_REQUIRE_AUTH, false) && !options?.allowAnonymous) {
      // Access lifecycle endpoints (invite redeem / session bootstrap / logout)
      // must stay reachable by anonymous visitors even when SONIC_REQUIRE_AUTH=1,
      // otherwise invite mode cannot ever be entered (audit P1-8). They still go
      // through the normal anonymous rate-limit bucket below.
      recordRateLimitMetric({
        allowed: false,
        backend: 'auth-gate',
        degraded: false,
        isAuthRequired: true,
        scope,
        env,
      });
      return {
        allowed: false,
        tier: 'anonymous',
        limit: 0,
        remaining: 0,
        resetSec: 60,
        backend: 'auth-gate',
        degraded: false,
      };
    }
  }

  const bucketKey = `${scope}:${subject}`;

  // Preferred: Cloudflare native Rate Limiting binding (atomic and shared across isolates).
  const nativeLimiter = (env as any)?.RATE_LIMITER;
  if (nativeLimiter && typeof nativeLimiter.limit === 'function') {
    try {
      const outcome = await nativeLimiter.limit({ key: bucketKey });
      if (!outcome || typeof outcome.success !== 'boolean') {
        throw new Error('RATE_LIMITER returned an invalid result');
      }
      recordRateLimitMetric({
        allowed: outcome.success,
        backend: 'native',
        degraded: false,
        scope,
        env,
      });
      return {
        allowed: outcome.success,
        tier,
        limit,
        remaining: outcome.success ? Math.max(0, limit - 1) : 0,
        resetSec: 60,
        backend: 'native',
        degraded: false,
      };
    } catch (nativeErr: any) {
      console.warn(
        '[Sonic RateLimit] Native RATE_LIMITER failed, evaluating policy:',
        redactSensitiveString(nativeErr?.message || nativeErr),
      );
    }
  }

  // Strict production guard: never silently degrade on multi-isolate edge when native limiter is required
  if (
    !isSingleNodeEngine &&
    requireDistributedRateLimit(env) &&
    isEnvEnabled(env?.SONIC_RATE_LIMIT_FAIL_CLOSED, true)
  ) {
    recordRateLimitMetric({
      allowed: false,
      backend: 'fail-closed',
      degraded: true,
      isFailClosed: true,
      scope,
      env,
    });
    return {
      allowed: false,
      tier,
      limit,
      remaining: 0,
      resetSec: 60,
      backend: 'fail-closed',
      degraded: true,
    };
  }

  // Best-effort cross-isolate fallback: Cloudflare KV is not atomic under concurrency, so
  // strict deployments should bind RATE_LIMITER. KV still raises the cost of abuse.
  const kv = env?.RATE_LIMIT_KV || env?.KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const windowMinute = Math.floor(now / windowMs);
      const kvKey = `rl:${bucketKey}:${windowMinute}`;
      const currentCount = parseInt((await kv.get(kvKey)) || '0', 10) || 0;
      const nextCount = currentCount + 1;
      const resetSec = Math.max(1, 60 - (Math.floor(now / 1000) % 60));
      await kv.put(kvKey, String(nextCount), { expirationTtl: 120 });
      const allowed = nextCount <= limit;
      const degraded = !isSingleNodeEngine;
      recordRateLimitMetric({ allowed, backend: 'kv', degraded, scope, env });
      return {
        allowed,
        tier,
        limit,
        remaining: Math.max(0, limit - nextCount),
        resetSec,
        backend: 'kv',
        degraded,
      };
    } catch (kvErr: any) {
      console.warn(
        '[Sonic RateLimit] KV rate limiter fallback to in-memory:',
        redactSensitiveString(kvErr?.message || kvErr),
      );
    }
  }

  // Fallback: In-memory sliding window (atomic inside single-node Linux Engine; isolate-local on Edge)
  const windowResult = bumpInMemoryWindow(bucketKey, limit, now, windowMs);
  const degraded = !isSingleNodeEngine;
  recordRateLimitMetric({
    allowed: windowResult.allowed,
    backend: 'memory',
    degraded,
    scope,
    env,
  });
  return {
    ...windowResult,
    tier,
    backend: 'memory',
    degraded,
  };
}

function purgeExpiredRateBuckets(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
  }
}

function bumpInMemoryWindow(
  bucketKey: string,
  limit: number,
  now: number,
  windowMs = 60_000,
): { allowed: boolean; limit: number; remaining: number; resetSec: number } {
  let key = bucketKey;
  let entry = rateBuckets.get(key);

  if (!entry || now >= entry.resetAt) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      purgeExpiredRateBuckets(now);
    }

    // Never evict a live victim bucket to make room for a new identity: that would let an
    // attacker churn buckets and reset the victim's counter. New identities share one
    // overflow bucket instead, keeping memory strictly bounded.
    if (!rateBuckets.has(key) && rateBuckets.size >= MAX_RATE_BUCKETS) {
      key = RATE_LIMIT_OVERFLOW_KEY;
      entry = rateBuckets.get(key);
    }

    if (entry && now >= entry.resetAt) {
      rateBuckets.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, entry);
    }
  }

  entry.count += 1;
  const remaining = Math.max(0, limit - entry.count);
  const resetSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

  return {
    allowed: entry.count <= limit,
    limit,
    remaining,
    resetSec,
  };
}

// Dedicated limiter for unauthenticated auth endpoints (OAuth login/callback).
// It intentionally ignores SONIC_REQUIRE_AUTH (login must stay reachable for anonymous users)
// and never issues API-key tier upgrades, so a valid key cannot widen the auth-attempt budget.
export async function evaluateAuthRateLimit(
  request: Request,
  env?: AppEnv,
  scope = 'auth',
  limitPerMinute = 30,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const limit = Math.min(1000, Math.max(1, Math.floor(limitPerMinute) || 30));
  const ip = getPublicClientIp(request);
  const bucketKey = `${scope}:ip:${ip}`;
  const isSingleNodeEngine = env?.SONIC_RUNTIME === 'linux-engine';

  const nativeLimiter = (env as any)?.RATE_LIMITER;
  if (nativeLimiter && typeof nativeLimiter.limit === 'function') {
    try {
      const outcome = await nativeLimiter.limit({ key: bucketKey });
      if (!outcome || typeof outcome.success !== 'boolean') {
        throw new Error('RATE_LIMITER returned an invalid result');
      }
      recordRateLimitMetric({
        allowed: outcome.success,
        backend: 'native',
        degraded: false,
        scope,
        env,
      });
      return {
        allowed: outcome.success,
        tier: 'anonymous',
        limit,
        remaining: outcome.success ? Math.max(0, limit - 1) : 0,
        resetSec: 60,
        backend: 'native',
        degraded: false,
      };
    } catch (nativeErr: any) {
      console.warn(
        '[Sonic RateLimit] Auth RATE_LIMITER failed, evaluating policy:',
        redactSensitiveString(nativeErr?.message || nativeErr),
      );
    }
  }

  if (
    !isSingleNodeEngine &&
    requireDistributedRateLimit(env) &&
    isEnvEnabled(env?.SONIC_RATE_LIMIT_FAIL_CLOSED, true)
  ) {
    recordRateLimitMetric({
      allowed: false,
      backend: 'fail-closed',
      degraded: true,
      isFailClosed: true,
      scope,
      env,
    });
    return {
      allowed: false,
      tier: 'anonymous',
      limit,
      remaining: 0,
      resetSec: 60,
      backend: 'fail-closed',
      degraded: true,
    };
  }

  const kv = env?.RATE_LIMIT_KV || env?.KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const windowMinute = Math.floor(now / 60_000);
      const kvKey = `rl:${bucketKey}:${windowMinute}`;
      const currentCount = parseInt((await kv.get(kvKey)) || '0', 10) || 0;
      const nextCount = currentCount + 1;
      await kv.put(kvKey, String(nextCount), { expirationTtl: 120 });
      const allowed = nextCount <= limit;
      const degraded = !isSingleNodeEngine;
      recordRateLimitMetric({ allowed, backend: 'kv', degraded, scope, env });
      return {
        allowed,
        tier: 'anonymous',
        limit,
        remaining: Math.max(0, limit - nextCount),
        resetSec: Math.max(1, 60 - (Math.floor(now / 1000) % 60)),
        backend: 'kv',
        degraded,
      };
    } catch (kvErr: any) {
      console.warn(
        '[Sonic RateLimit] Auth KV rate limiter fallback to in-memory:',
        redactSensitiveString(kvErr?.message || kvErr),
      );
    }
  }

  const mem = bumpInMemoryWindow(bucketKey, limit, now);
  const degraded = !isSingleNodeEngine;
  recordRateLimitMetric({ allowed: mem.allowed, backend: 'memory', degraded, scope, env });
  return { ...mem, tier: 'anonymous', backend: 'memory', degraded };
}

export function buildRateLimitErrorResponse(decision: RateLimitDecision): Response {
  const isAuthRequired = decision.limit === 0;
  const isFailClosed = decision.backend === 'fail-closed';
  const status = isFailClosed ? 503 : isAuthRequired ? 401 : 429;
  const code = isFailClosed
    ? 'RATE_LIMITER_NOT_BOUND'
    : isAuthRequired
      ? 'AUTH_REQUIRED'
      : 'RATE_LIMITED';
  const message = isFailClosed
    ? 'Distributed Cloudflare RATE_LIMITER binding is required in strict mode (SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1)'
    : isAuthRequired
      ? 'API key is required (pass X-Sonic-Key or X-CFSolara-Key or Authorization: Bearer)'
      : `Rate limit exceeded for tier '${decision.tier}' (${decision.limit} req/min)`;

  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Retry-After': String(decision.resetSec),
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(decision.resetSec),
    'X-RateLimit-Tier': decision.tier,
    'X-RateLimit-Backend': decision.backend || 'memory',
  };
  if (decision.degraded) {
    headers['X-RateLimit-Degraded'] = '1';
  }

  return jsonResponse(
    {
      brand: 'Sonic',
      error: {
        code,
        message,
      },
    },
    {
      status,
      headers,
    },
  );
}

export function resetRateLimitsForTest(): void {
  rateBuckets.clear();
}

export function getRateLimitBucketCountForTest(): number {
  return rateBuckets.size;
}

// ── SSRF Triple Validation & Canonicalization ──

export function parseIpv4ToUint32(host: string): number | null {
  const clean = host.trim().replace(/\.+$/, '');
  const parts = clean.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const parsedParts: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let n: number;
    if (/^0x[0-9a-fA-F]+$/i.test(part)) {
      n = parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      n = parseInt(part, 8);
    } else if (/^[0-9]+$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(n) || n < 0) return null;
    parsedParts.push(n);
  }

  let ipInt = 0;
  if (parsedParts.length === 1) {
    if (parsedParts[0] > 0xffffffff) return null;
    ipInt = parsedParts[0] >>> 0;
  } else if (parsedParts.length === 2) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xffffff) return null;
    ipInt = ((parsedParts[0] << 24) | parsedParts[1]) >>> 0;
  } else if (parsedParts.length === 3) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xff || parsedParts[2] > 0xffff) return null;
    ipInt = ((parsedParts[0] << 24) | (parsedParts[1] << 16) | parsedParts[2]) >>> 0;
  } else if (parsedParts.length === 4) {
    if (
      parsedParts[0] > 0xff ||
      parsedParts[1] > 0xff ||
      parsedParts[2] > 0xff ||
      parsedParts[3] > 0xff
    )
      return null;
    ipInt =
      ((parsedParts[0] << 24) |
        (parsedParts[1] << 16) |
        (parsedParts[2] << 8) |
        parsedParts[3]) >>>
      0;
  } else {
    return null;
  }
  return ipInt;
}

export function isBlockedIpv4(ipInt: number): boolean {
  // 0.0.0.0/8 (Current network)
  if ((ipInt >>> 24) === 0) return true;
  // 10.0.0.0/8 (Private RFC1918)
  if ((ipInt >>> 24) === 10) return true;
  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if ((ipInt & 0xffc00000) >>> 0 === 0x64400000) return true;
  // 127.0.0.0/8 (Loopback)
  if ((ipInt >>> 24) === 127) return true;
  // 169.254.0.0/16 (Link Local / Cloud Metadata 169.254.169.254)
  if ((ipInt & 0xffff0000) >>> 0 === 0xa9fe0000) return true;
  // 172.16.0.0/12 (Private RFC1918)
  if ((ipInt & 0xfff00000) >>> 0 === 0xac100000) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if ((ipInt & 0xffffff00) >>> 0 === 0xc0000000) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if ((ipInt & 0xffffff00) >>> 0 === 0xc0000200) return true;
  // 192.88.99.0/24 (6to4 Relay Anycast)
  if ((ipInt & 0xffffff00) >>> 0 === 0xc0586300) return true;
  // 192.168.0.0/16 (Private RFC1918)
  if ((ipInt & 0xffff0000) >>> 0 === 0xc0a80000) return true;
  // 198.18.0.0/15 (Network Interconnect Benchmark Testing)
  if ((ipInt & 0xfffe0000) >>> 0 === 0xc6120000) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if ((ipInt & 0xffffff00) >>> 0 === 0xc6336400) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if ((ipInt & 0xffffff00) >>> 0 === 0xcb007100) return true;
  // 224.0.0.0/4 (Multicast 224-239) and 240.0.0.0/4 (Reserved / Broadcast 240-255)
  if ((ipInt >>> 28) >= 14) return true;

  return false;
}

export function isBlockedIpv6(host: string): boolean {
  const hextets = parseIpv6Hextets(host);
  if (!hextets) return false;

  // :: (unspecified) and ::1 (loopback)
  if (hextets.every((part) => part === 0)) return true;
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) return true;

  // fc00::/7 Unique Local Address
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 Link-Local Unicast
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;
  // fec0::/10 Deprecated Site-Local Unicast
  if ((hextets[0] & 0xffc0) === 0xfec0) return true;
  // ff00::/8 Multicast
  if ((hextets[0] & 0xff00) === 0xff00) return true;

  // 2001:db8::/32 Documentation, 2001:2::/48 Benchmarking
  if (hextets[0] === 0x2001 && (hextets[1] === 0x0db8 || hextets[1] === 0x0002)) return true;
  // 2001::/32 Teredo embeds a client IPv4 address and is not a safe proxy destination
  if (hextets[0] === 0x2001 && hextets[1] === 0) return true;
  // 2001:10::/28 and 2001:20::/28 ORCHID ranges
  if (hextets[0] === 0x2001 && ((hextets[1] & 0xfff0) === 0x0010 || (hextets[1] & 0xfff0) === 0x0020)) {
    return true;
  }
  // 100::/64 Discard-Only prefix
  if (hextets[0] === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  if (hextets.slice(0, 5).every((part) => part === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const v4 = ((hextets[6] << 16) | hextets[7]) >>> 0;
    if (isBlockedIpv4(v4)) return true;
  }

  // IPv4-translated (::ffff:0:a.b.c.d, RFC 6052 / RFC 6145)
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0xffff &&
    hextets[5] === 0
  ) {
    const v4 = ((hextets[6] << 16) | hextets[7]) >>> 0;
    if (isBlockedIpv4(v4)) return true;
  }

  // 2002::/16 6to4 embeds an IPv4 address in the first two hextets
  if (hextets[0] === 0x2002) {
    const v4 = ((hextets[1] << 16) | hextets[2]) >>> 0;
    if (isBlockedIpv4(v4)) return true;
  }

  // 64:ff9b::/32 and 64:ff9b:1::/48 NAT64 translation prefixes
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b) return true;

  return false;
}

export function isBlockedSsrfHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;

  // 1. Hostname checks
  if (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan') ||
    h.endsWith('.corp') ||
    h.endsWith('.home') ||
    h.endsWith('.home.arpa') ||
    h.endsWith('.invalid') ||
    h.endsWith('.test') ||
    h.endsWith('.example') ||
    h.startsWith('engine-sonic.')
  ) {
    return true;
  }

  // 2. Canonical IPv4 check
  const ipv4Int = parseIpv4ToUint32(h);
  if (ipv4Int !== null) {
    return isBlockedIpv4(ipv4Int);
  }

  // 3. IPv6 check — malformed colon-bearing hostnames fail closed
  if (h.includes(':')) {
    return parseIpv6Hextets(h) === null || isBlockedIpv6(h);
  }

  return false;
}

export function validateSafeUrl(
  urlInput: string | URL,
  options?: {
    allowHttp?: boolean;
    allowedDomains?: string[];
  },
): { valid: boolean; url?: URL; error?: string } {
  if (typeof urlInput === 'string' && urlInput.length > 8192) {
    return { valid: false, error: 'URL is too long' };
  }
  let url: URL;
  try {
    url = typeof urlInput === 'string' ? new URL(urlInput) : urlInput;
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // 1. Protocol: https only (unless explicit allowHttp option)
  const isHttps = url.protocol === 'https:';
  const isHttp = url.protocol === 'http:';
  if (!isHttps && (!isHttp || !options?.allowHttp)) {
    return { valid: false, error: 'Only https URLs are permitted' };
  }

  // 2. Userinfo: strictly reject user:pass@
  if (url.username || url.password) {
    return { valid: false, error: 'URL userinfo is strictly forbidden' };
  }

  // 3. Port: only 443 (https) or 80 (http)
  if (url.port) {
    const portNum = parseInt(url.port, 10);
    if (isHttps && portNum !== 443) {
      return { valid: false, error: 'Non-standard port is forbidden' };
    }
    if (isHttp && portNum !== 80) {
      return { valid: false, error: 'Non-standard port is forbidden' };
    }
  }

  // 4. Host canonical SSRF check
  const hostname = url.hostname.toLowerCase().trim().replace(/\.+$/, '');
  if (isBlockedSsrfHost(hostname)) {
    return { valid: false, error: 'Destination host is forbidden by SSRF policy' };
  }

  // 5. Whitelist suffix matching (if specified)
  if (options?.allowedDomains && options.allowedDomains.length > 0) {
    const matched = options.allowedDomains.some((d) => {
      const dom = d.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
      return hostname === dom || hostname.endsWith('.' + dom);
    });
    if (!matched) {
      return { valid: false, error: 'Destination host is not in allowed domain whitelist' };
    }
  }

  return { valid: true, url };
}

// Response headers that are safe to relay from a third-party asset host back to our clients.
// Deliberately excludes Set-Cookie (cookie injection onto the Sonic origin), Content-Encoding
// (bodies are already decoded by fetch), Server/X-Powered-By (topology disclosure) and CSP/HSTS.
const SAFE_UPSTREAM_RESPONSE_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'expires',
  'cache-control',
];

export function buildSafeUpstreamResponseHeaders(
  upstream: Headers,
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(extra);
  for (const key of SAFE_UPSTREAM_RESPONSE_HEADERS) {
    const value = upstream.get(key);
    if (value) headers.set(key, value);
  }
  // Content-Length is only meaningful when the body was not transparently decoded.
  if (!upstream.has('content-encoding')) {
    const length = upstream.get('content-length');
    if (length) headers.set('content-length', length);
  }
  return headers;
}

export type SafeFetchHostResolver = (hostname: string) => Promise<string[]>;

export interface SafeFetchResponse extends Response {
  /** Final validated target, exposed only when safeFetch({ includeMetadata: true }) is used. */
  finalUrl?: URL;
  /** True when the initial URL or any redirect hop carried a credential/signed query. */
  sensitive?: boolean;
}

let safeFetchHostResolver: SafeFetchHostResolver | null = null;

// Two independent upstream pools (audit P1-3). Long-lived slow audio streams
// previously shared 64 slots with cover/JSON proxies, so 64 slow streams could
// 503 every non-streaming request. Media keeps the larger share; JSON stays
// responsive regardless of streaming load.
export type SafeFetchPool = 'media' | 'json';

const SAFE_FETCH_POOL_LIMITS: Record<SafeFetchPool, { fetches: number; bodies: number }> = {
  media: { fetches: 48, bodies: 48 },
  json: { fetches: 16, bodies: 16 },
};

const activeUpstreamFetches: Record<SafeFetchPool, number> = { media: 0, json: 0 };
const activeUpstreamBodies: Record<SafeFetchPool, number> = { media: 0, json: 0 };

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const SENSITIVE_MEDIA_QUERY_NAMES = new Set([
  'auth',
  'auth_key',
  'auth-key',
  'authorization',
  'token',
  'access_token',
  'access-token',
  'accesstoken',
  'refresh_token',
  'refresh-token',
  'refreshtoken',
  'accesskey',
  'secret',
  'key',
  'api_key',
  'api-key',
  'apikey',
  'sign',
  'signature',
  'sig',
  'vkey',
  'guid',
  'wmid',
  'expires',
  'expire',
  'expiry',
  'exp',
  'nonce',
  'session',
  'cookie',
  'uid',
  'userid',
  'user_id',
  'user-id',
  'wssecret',
  'wstime',
  'ekey',
  'ckey',
  'vuutv',
  'dis_k',
  'code',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'ossaccesskeyid',
  'osstoken',
  'q-signature',
]);

function decodeQueryName(name: string): string {
  let current = name;
  // URLSearchParams performs one decode already. A bounded second pass handles a safely
  // encoded parameter name without accepting arbitrary recursive input.
  for (let i = 0; i < 2; i += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current.trim().toLowerCase();
}

export function hasSensitiveMediaQuery(target: URL | string): boolean {
  let url: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return true;
  }
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_MEDIA_QUERY_NAMES.has(decodeQueryName(name))) return true;
  }
  return false;
}

export function setSafeFetchHostResolver(resolver: SafeFetchHostResolver | null): void {
  safeFetchHostResolver = resolver;
}

export function resetSafeFetchStateForTest(): void {
  safeFetchHostResolver = null;
  activeUpstreamFetches.media = 0;
  activeUpstreamFetches.json = 0;
  activeUpstreamBodies.media = 0;
  activeUpstreamBodies.json = 0;
}

/** Test hook: current per-pool occupancy, never leaks secret state. */
export function getSafeFetchPoolStatsForTest(): { fetches: Record<SafeFetchPool, number>; bodies: Record<SafeFetchPool, number> } {
  return {
    fetches: { ...activeUpstreamFetches },
    bodies: { ...activeUpstreamBodies },
  };
}

export class SafeFetchCapacityError extends Error {
  readonly code: 'UPSTREAM_CONCURRENCY' | 'UPSTREAM_BODY_CONCURRENCY';

  constructor(code: 'UPSTREAM_CONCURRENCY' | 'UPSTREAM_BODY_CONCURRENCY') {
    super(code === 'UPSTREAM_CONCURRENCY'
      ? 'Upstream concurrency limit reached'
      : 'Upstream body concurrency limit reached');
    this.name = 'SafeFetchCapacityError';
    this.code = code;
  }
}

export function isSafeFetchCapacityError(error: unknown): error is SafeFetchCapacityError {
  return error instanceof SafeFetchCapacityError;
}

async function assertResolvedHostIsPublic(url: URL): Promise<void> {
  if (!safeFetchHostResolver) return;
  const hostname = url.hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isValidIpLiteral(hostname)) return;

  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      safeFetchHostResolver(hostname),
      new Promise<string[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), 2000);
      }),
    ]);
  } catch {
    throw new Error('SSRF check rejected: DNS resolution failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error('SSRF check rejected: DNS returned no addresses');
  }
  for (const address of addresses) {
    if (!isValidIpLiteral(address) || isBlockedSsrfHost(address)) {
      throw new Error(`SSRF check rejected: ${hostname} resolves to a forbidden address`);
    }
  }
}

function createUpstreamSignal(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; clearTimeout: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let onAbort: (() => void) | undefined;
  if (external) {
    onAbort = () => controller.abort();
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    // The timeout covers connection/header acquisition only; response bodies are bounded by
    // maxBytes so a long audio stream is not cut off mid-track.
    clearTimeout: () => {
      clearTimeout(timer);
      if (external && onAbort) external.removeEventListener('abort', onAbort);
    },
  };
}

function enforceResponseSize(
  response: Response,
  maxBytes: number,
  idleTimeoutMs: number,
  externalSignal: AbortSignal | undefined,
  releaseBodySlot: () => void,
): Response {
  const bounded = Number.isFinite(maxBytes) && maxBytes > 0;
  const declared = Number(response.headers.get('content-length') || '');
  if (bounded && Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    releaseBodySlot();
    return response;
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  let terminated = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (terminated) return;
    terminated = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    releaseBodySlot();
  };
  const fail = (error: unknown) => {
    if (terminated) return;
    finish();
    // Error the consumer immediately, even if an upstream cancel hook never settles.
    controllerRef.error(error);
    void reader.cancel(error).catch(() => {});
  };
  const onExternalAbort = () => fail(externalSignal?.reason || new DOMException('The operation was aborted', 'AbortError'));
  const armIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error(`Upstream body idle timeout after ${idleTimeoutMs}ms`)), idleTimeoutMs);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      armIdleTimer();
      if (externalSignal?.aborted) onExternalAbort();
      else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    },
    async pull(controller) {
      if (terminated) return;
      try {
        const { done, value } = await reader.read();
        if (terminated) return;
        if (done) {
          finish();
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        if (bounded && totalBytes > maxBytes) {
          fail(new Error(`Upstream response exceeds ${maxBytes} bytes`));
          return;
        }
        // The timer also covers a consumer which stops reading under backpressure; a
        // maxBytes=0 caller still cannot pin a slot indefinitely with an unread body.
        if (value.byteLength > 0) armIdleTimer();
        controller.enqueue(value);
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      if (terminated) return;
      finish();
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function setSensitiveCachePolicy(response: Response, sensitive: boolean): Response {
  if (!sensitive) return response;
  try {
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function attachSafeFetchMetadata(response: Response, finalUrl: URL, sensitive: boolean): SafeFetchResponse {
  const out = response as SafeFetchResponse;
  Object.defineProperties(out, {
    finalUrl: { configurable: true, enumerable: false, value: new URL(finalUrl.toString()) },
    sensitive: { configurable: true, enumerable: false, value: sensitive },
  });
  return out;
}

export async function safeFetch(
  targetUrl: string | URL,
  init?: RequestInit,
  options?: {
    allowHttp?: boolean;
    allowedDomains?: string[];
    maxRedirects?: number;
    timeoutMs?: number;
    maxBytes?: number;
    bodyIdleTimeoutMs?: number;
    includeMetadata?: boolean;
    /** Pool selection: long-lived audio streams use 'media' so they cannot starve JSON/cover proxies. */
    pool?: SafeFetchPool;
  },
): Promise<SafeFetchResponse> {
  const maxRedirects = Math.max(0, options?.maxRedirects ?? 3);
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 15000);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const bodyIdleTimeoutMs = Math.max(10, options?.bodyIdleTimeoutMs ?? 30000);
  const deadline = Date.now() + timeoutMs;
  const pool: SafeFetchPool = options?.pool === 'media' ? 'media' : 'json';
  const poolLimits = SAFE_FETCH_POOL_LIMITS[pool];
  let currentUrl = typeof targetUrl === 'string' ? targetUrl : targetUrl.toString();
  let redirectsRemaining = maxRedirects;
  let sensitive = hasSensitiveMediaQuery(currentUrl);

  if (activeUpstreamFetches[pool] >= poolLimits.fetches) {
    throw new SafeFetchCapacityError('UPSTREAM_CONCURRENCY');
  }
  activeUpstreamFetches[pool] += 1;

  try {
    while (true) {
      const valResult = validateSafeUrl(currentUrl, {
        allowHttp: options?.allowHttp,
        allowedDomains: options?.allowedDomains,
      });
      if (!valResult.valid || !valResult.url) {
        throw new Error(`SSRF check rejected: ${valResult.error}`);
      }
      sensitive = sensitive || hasSensitiveMediaQuery(valResult.url);
      await assertResolvedHostIsPublic(valResult.url);

      // Header security: never forward client credentials, cookies or Sonic identity
      // context to an external target.
      const headers = new Headers(init?.headers);
      for (const name of [
        'cookie',
        'authorization',
        'proxy-authorization',
        'x-sonic-engine-key',
        'x-sonic-key',
        'x-cfsolara-key',
        'x-api-key',
        'x-sonic-anon-id',
        'x-sonic-context',
        'x-sonic-personalization',
        'x-sonic-client-ip',
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-real-ip',
        'cf-connecting-ip',
      ]) {
        headers.delete(name);
      }

      const remainingMs = Math.max(1, deadline - Date.now());
      const upstreamSignal = createUpstreamSignal(remainingMs, init?.signal);

      let resp: Response;
      try {
        resp = await fetch(valResult.url.toString(), {
          ...init,
          headers,
          redirect: 'manual',
          signal: upstreamSignal.signal,
        });
      } finally {
        upstreamSignal.clearTimeout();
      }

      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const location = resp.headers.get('location');
        if (!location) {
          const finalResp = setSensitiveCachePolicy(resp, sensitive);
          return options?.includeMetadata
            ? attachSafeFetchMetadata(finalResp, valResult.url, sensitive)
            : finalResp;
        }
        if (redirectsRemaining <= 0) {
          resp.body?.cancel().catch(() => {});
          throw new Error('Too many redirects');
        }
        redirectsRemaining -= 1;

        const nextUrl = new URL(location, valResult.url);
        sensitive = sensitive || hasSensitiveMediaQuery(nextUrl);
        if (valResult.url.protocol === 'https:' && nextUrl.protocol === 'http:') {
          resp.body?.cancel().catch(() => {});
          throw new Error('Protocol downgrade from https to http during redirect is forbidden');
        }
        resp.body?.cancel().catch(() => {});
        currentUrl = nextUrl.toString();
        continue;
      }

      const finalTarget = valResult.url;
      const finalSensitive = sensitive || hasSensitiveMediaQuery(finalTarget);
      const finalResp = setSensitiveCachePolicy(resp, finalSensitive);
      const isHead = (init?.method || 'GET').toUpperCase() === 'HEAD';
      if (isHead) {
        if (finalResp.body) {
          finalResp.body.cancel().catch(() => {});
          const headResp = new Response(null, {
            status: finalResp.status,
            statusText: finalResp.statusText,
            headers: finalResp.headers,
          });
          return options?.includeMetadata
            ? attachSafeFetchMetadata(headResp, finalTarget, finalSensitive)
            : headResp;
        }
        return options?.includeMetadata
          ? attachSafeFetchMetadata(finalResp, finalTarget, finalSensitive)
          : finalResp;
      }

      if (!finalResp.body) {
        return options?.includeMetadata
          ? attachSafeFetchMetadata(finalResp, finalTarget, finalSensitive)
          : finalResp;
      }
      if (activeUpstreamBodies[pool] >= poolLimits.bodies) {
        finalResp.body.cancel().catch(() => {});
        throw new SafeFetchCapacityError('UPSTREAM_BODY_CONCURRENCY');
      }
      activeUpstreamBodies[pool] += 1;
      let wrapped: Response;
      try {
        wrapped = enforceResponseSize(
          finalResp,
          maxBytes,
          bodyIdleTimeoutMs,
          init?.signal ?? undefined,
          () => {
            activeUpstreamBodies[pool] = Math.max(0, activeUpstreamBodies[pool] - 1);
          },
        );
      } catch (error) {
        activeUpstreamBodies[pool] = Math.max(0, activeUpstreamBodies[pool] - 1);
        throw error;
      }
      return options?.includeMetadata
        ? attachSafeFetchMetadata(wrapped, finalTarget, finalSensitive)
        : (wrapped as SafeFetchResponse);
    }
  } finally {
    activeUpstreamFetches[pool] = Math.max(0, activeUpstreamFetches[pool] - 1);
  }
}

// Per-IP concurrent media stream cap (audit P1-3). 64 slow streams from one IP
// must not be able to hold every media pool slot; a handful of concurrent
// streams per client is far above any legitimate player's needs.
const MAX_STREAMS_PER_IP = 4;
const MAX_STREAM_IP_ENTRIES = 4096;
const activeStreamsPerIp = new Map<string, number>();

export function acquireStreamSlot(ip: string): boolean {
  if (!ip) return true;
  const current = activeStreamsPerIp.get(ip) || 0;
  if (current >= MAX_STREAMS_PER_IP) return false;
  if (!current && activeStreamsPerIp.size >= MAX_STREAM_IP_ENTRIES) return false;
  activeStreamsPerIp.set(ip, current + 1);
  return true;
}

export function releaseStreamSlot(ip: string): void {
  if (!ip) return;
  const current = activeStreamsPerIp.get(ip) || 0;
  if (current <= 1) activeStreamsPerIp.delete(ip);
  else activeStreamsPerIp.set(ip, current - 1);
}

export function getStreamSlotLimit(): number {
  return MAX_STREAMS_PER_IP;
}

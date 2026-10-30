// Sonic Gateway — Inter-Service Authentication & Tiered Rate Limiter
// Enforces:
// 1. Mandatory constant-time X-Sonic-Engine-Key verification on `engine-sonic.*` and internal engine endpoints
// 2. Sliding-window rate limiting at both Edge (Pages -> Engine hop protection) and Engine layers
// 3. SSRF Triple Validation: Protocol (https only), Port (80/443), Host canonicalization (IPv4/IPv6/domain whitelist)

import type { AppEnv } from '../types';
import { extractAuthCredentials, verifyAuth } from '../auth';
import { isEnvEnabled } from './config';
import { jsonResponse } from '../http';
import { sha256Bytes, sha256Hex } from './crypto';

// Provider-specific media boundaries. Apex domains such as qq.com / 163.com are deliberately
// absent: they also host mail and other unrelated user content, which would widen the proxy
// surface far beyond music assets. The hosts below cover every upstream referenced in this tree.
export const SONIC_ALLOWED_MUSIC_DOMAINS = [
  'music.126.net',
  'music.163.com',
  'y.qq.com',
  'qqmusic.qq.com',
  'gtimg.cn',
  'qpic.cn',
  'kugou.com',
  'kuwo.cn',
  'lrclib.net',
  'amll.dev',
  'lyriva.xyz',
  'gdstudio.xyz',
];

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
  if (headerKey && timingSafeEqualStr(headerKey, configured)) {
    return true;
  }
  return false;
}

export function requiresEngineAuth(request: Request, env?: AppEnv): boolean {
  const { pathname } = new URL(request.url);
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

export function isSameOriginRequest(request: Request): boolean {
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
}

export async function evaluateGatewayRateLimit(
  request: Request,
  env?: AppEnv,
  scope = 'api',
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowMs = 60_000;

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
    } else if (isEnvEnabled(env?.SONIC_REQUIRE_AUTH, false)) {
      return {
        allowed: false,
        tier: 'anonymous',
        limit: 0,
        remaining: 0,
        resetSec: 60,
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
      return {
        allowed: outcome.success,
        tier,
        limit,
        remaining: outcome.success ? Math.max(0, limit - 1) : 0,
        resetSec: 60,
      };
    } catch (nativeErr) {
      console.warn('[Sonic RateLimit] Native RATE_LIMITER failed, falling back', nativeErr);
    }
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
      return {
        allowed: nextCount <= limit,
        tier,
        limit,
        remaining: Math.max(0, limit - nextCount),
        resetSec,
      };
    } catch (kvErr) {
      console.warn('[Sonic RateLimit] KV rate limiter fallback to in-memory', kvErr);
    }
  }

  // Fallback: In-memory sliding window
  const windowResult = bumpInMemoryWindow(bucketKey, limit, now, windowMs);
  return {
    ...windowResult,
    tier,
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

  const nativeLimiter = (env as any)?.RATE_LIMITER;
  if (nativeLimiter && typeof nativeLimiter.limit === 'function') {
    try {
      const outcome = await nativeLimiter.limit({ key: bucketKey });
      if (!outcome || typeof outcome.success !== 'boolean') {
        throw new Error('RATE_LIMITER returned an invalid result');
      }
      return {
        allowed: outcome.success,
        tier: 'anonymous',
        limit,
        remaining: outcome.success ? Math.max(0, limit - 1) : 0,
        resetSec: 60,
      };
    } catch (nativeErr) {
      console.warn('[Sonic RateLimit] Auth RATE_LIMITER failed, falling back', nativeErr);
    }
  }

  const kv = env?.RATE_LIMIT_KV || env?.KV;
  if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') {
    try {
      const windowMinute = Math.floor(now / 60_000);
      const kvKey = `rl:${bucketKey}:${windowMinute}`;
      const currentCount = parseInt((await kv.get(kvKey)) || '0', 10) || 0;
      const nextCount = currentCount + 1;
      await kv.put(kvKey, String(nextCount), { expirationTtl: 120 });
      return {
        allowed: nextCount <= limit,
        tier: 'anonymous',
        limit,
        remaining: Math.max(0, limit - nextCount),
        resetSec: Math.max(1, 60 - (Math.floor(now / 1000) % 60)),
      };
    } catch (kvErr) {
      console.warn('[Sonic RateLimit] Auth KV rate limiter fallback to in-memory', kvErr);
    }
  }

  return { ...bumpInMemoryWindow(bucketKey, limit, now), tier: 'anonymous' };
}

export function buildRateLimitErrorResponse(decision: RateLimitDecision): Response {
  const isAuthRequired = decision.limit === 0;
  return jsonResponse(
    {
      brand: 'Sonic',
      error: {
        code: isAuthRequired ? 'AUTH_REQUIRED' : 'RATE_LIMITED',
        message: isAuthRequired
          ? 'API key is required (pass X-Sonic-Key or X-CFSolara-Key or Authorization: Bearer)'
          : `Rate limit exceeded for tier '${decision.tier}' (${decision.limit} req/min)`,
      },
    },
    {
      status: isAuthRequired ? 401 : 429,
      headers: {
        'Retry-After': String(decision.resetSec),
        'X-RateLimit-Limit': String(decision.limit),
        'X-RateLimit-Remaining': String(decision.remaining),
        'X-RateLimit-Reset': String(decision.resetSec),
        'X-RateLimit-Tier': decision.tier,
      },
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

let safeFetchHostResolver: SafeFetchHostResolver | null = null;
let activeUpstreamFetches = 0;

const MAX_CONCURRENT_UPSTREAM_FETCHES = 64;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function setSafeFetchHostResolver(resolver: SafeFetchHostResolver | null): void {
  safeFetchHostResolver = resolver;
}

export function resetSafeFetchStateForTest(): void {
  safeFetchHostResolver = null;
  activeUpstreamFetches = 0;
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

function enforceResponseSize(response: Response, maxBytes: number, idleTimeoutMs: number): Response {
  const declared = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let totalBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const readPromise = reader.read();
        const idlePromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Upstream body idle timeout after ${idleTimeoutMs}ms`)),
            idleTimeoutMs,
          );
        });
        const { done, value } = await Promise.race([readPromise, idlePromise]);
        if (timer !== undefined) clearTimeout(timer);
        if (done) {
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          controller.error(new Error(`Upstream response exceeds ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        if (timer !== undefined) clearTimeout(timer);
        await reader.cancel().catch(() => {});
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
  },
): Promise<Response> {
  const maxRedirects = Math.max(0, options?.maxRedirects ?? 3);
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 15000);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const bodyIdleTimeoutMs = Math.max(10, options?.bodyIdleTimeoutMs ?? 30000);
  const deadline = Date.now() + timeoutMs;
  let currentUrl = typeof targetUrl === 'string' ? targetUrl : targetUrl.toString();
  let redirectsRemaining = maxRedirects;

  if (activeUpstreamFetches >= MAX_CONCURRENT_UPSTREAM_FETCHES) {
    throw new Error('Upstream concurrency limit reached');
  }
  activeUpstreamFetches += 1;

  try {
    while (true) {
      const valResult = validateSafeUrl(currentUrl, {
        allowHttp: options?.allowHttp,
        allowedDomains: options?.allowedDomains,
      });
      if (!valResult.valid || !valResult.url) {
        throw new Error(`SSRF check rejected: ${valResult.error}`);
      }
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
          return resp;
        }
        if (redirectsRemaining <= 0) {
          resp.body?.cancel().catch(() => {});
          throw new Error('Too many redirects');
        }
        redirectsRemaining -= 1;

        const nextUrl = new URL(location, valResult.url);
        if (valResult.url.protocol === 'https:' && nextUrl.protocol === 'http:') {
          resp.body?.cancel().catch(() => {});
          throw new Error('Protocol downgrade from https to http during redirect is forbidden');
        }
        resp.body?.cancel().catch(() => {});
        currentUrl = nextUrl.toString();
        continue;
      }

      const isHead = (init?.method || 'GET').toUpperCase() === 'HEAD';
      if (isHead || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        return resp;
      }
      return enforceResponseSize(resp, maxBytes, bodyIdleTimeoutMs);
    }
  } finally {
    // Counts upstream header acquisition. Long response bodies are bounded by maxBytes and
    // intentionally do not hold a slot, so audio downloads cannot exhaust the gate.
    activeUpstreamFetches = Math.max(0, activeUpstreamFetches - 1);
  }
}

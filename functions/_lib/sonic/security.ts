// Sonic Gateway — Inter-Service Authentication, Rate Limiting & SSRF Policy
// Shared by Cloudflare Pages Functions and the Linux Node engine.

import type { AppEnv } from '../types';
import { verifyAuth } from '../auth';
import { isEnvEnabled } from './config';
import { jsonResponse } from '../http';
import { sha256Bytes } from './crypto';

// Exact vendor/CDN suffixes used by the supported sources. Operators can replace
// this list with SONIC_ALLOWED_MUSIC_DOMAINS (comma separated); an explicitly
// configured invalid list fails closed instead of silently widening access.
export const DEFAULT_ALLOWED_MUSIC_DOMAINS = [
  'music.126.net',
  'vod.126.net',
  'music.163.com',
  'interface3.music.163.com',
  'qqmusic.qq.com',
  'y.qq.com',
  'u.y.qq.com',
  'gtimg.cn',
  'qpic.cn',
  'kugou.com',
  'kuwo.cn',
  'lrclib.net',
  'amll.dev',
  'lyriva.xyz',
  'gdstudio.xyz',
];

export const SONIC_ALLOWED_MUSIC_DOMAINS = DEFAULT_ALLOWED_MUSIC_DOMAINS;

function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || domain.length > 253 || domain.includes('*')) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return null;
  }
  return domain;
}

export function getAllowedMusicDomains(env?: AppEnv): string[] {
  const configured = env?.SONIC_ALLOWED_MUSIC_DOMAINS;
  if (configured === undefined || String(configured).trim() === '') {
    return [...DEFAULT_ALLOWED_MUSIC_DOMAINS];
  }
  return String(configured)
    .split(',')
    .map(normalizeDomain)
    .filter((domain): domain is string => Boolean(domain));
}

export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/\.+$/, '');
  const suffix = domain.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const hashA = sha256Bytes(a);
  const hashB = sha256Bytes(b);
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= hashA[i] ^ hashB[i];
  }
  return diff === 0 && a === b;
}

export function hasValidEngineSecret(request: Request, env?: AppEnv): boolean {
  const configured = env?.SONIC_ENGINE_SECRET ? String(env.SONIC_ENGINE_SECRET).trim() : '';
  if (!configured || configured.length < 32) return false;
  const headerKey = request.headers.get('X-Sonic-Engine-Key')?.trim() || '';
  return Boolean(headerKey) && timingSafeEqualStr(headerKey, configured);
}

export function requiresEngineAuth(request: Request, env?: AppEnv): boolean {
  if (isEnvEnabled(env?.SONIC_REQUIRE_ENGINE_AUTH, false)) {
    return true;
  }
  const pathname = new URL(request.url).pathname;
  return pathname === '/api/sonic/engine'
    || pathname.startsWith('/api/sonic/engine/')
    || pathname.startsWith('/api/sonic/resolve/');
}

function engineAuthFailure(env?: AppEnv): Response | null {
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
          message: 'Engine secret is not configured or shorter than 32 characters',
        },
      },
      { status: 503 },
    );
  }
  return null;
}

export function requireEngineSecret(request: Request, env?: AppEnv): Response | null {
  const misconfigured = engineAuthFailure(env);
  if (misconfigured) return misconfigured;
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
        headers: { 'WWW-Authenticate': 'SonicEngineKey realm="sonic-local-engine"' },
      },
    );
  }
  return null;
}

export function checkEngineAccess(request: Request, env?: AppEnv): Response | null {
  if (!requiresEngineAuth(request, env)) return null;
  return requireEngineSecret(request, env);
}

// ── IP Extraction and Validation ──

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIpv4ToUint32(host: string): number | null {
  const clean = host.trim().replace(/\.+$/, '');
  if (!clean) return null;
  const parts = clean.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const parsedParts: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      n = parseInt(part.slice(2), 16);
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

  if (parsedParts.length === 1) {
    if (parsedParts[0] > 0xffffffff) return null;
    return parsedParts[0] >>> 0;
  }
  if (parsedParts.length === 2) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xffffff) return null;
    return ((parsedParts[0] << 24) | parsedParts[1]) >>> 0;
  }
  if (parsedParts.length === 3) {
    if (parsedParts[0] > 0xff || parsedParts[1] > 0xff || parsedParts[2] > 0xffff) return null;
    return ((parsedParts[0] << 24) | (parsedParts[1] << 16) | parsedParts[2]) >>> 0;
  }
  if (
    parsedParts[0] > 0xff
    || parsedParts[1] > 0xff
    || parsedParts[2] > 0xff
    || parsedParts[3] > 0xff
  ) {
    return null;
  }
  return (
    ((parsedParts[0] << 24)
      | (parsedParts[1] << 16)
      | (parsedParts[2] << 8)
      | parsedParts[3]) >>> 0
  );
}

export function isBlockedIpv4(ipInt: number): boolean {
  if ((ipInt >>> 24) === 0) return true; // 0.0.0.0/8
  if ((ipInt >>> 24) === 10) return true; // 10.0.0.0/8
  if (((ipInt & 0xffc00000) >>> 0) === 0x64400000) return true; // 100.64.0.0/10
  if ((ipInt >>> 24) === 127) return true; // 127.0.0.0/8
  if (((ipInt & 0xffff0000) >>> 0) === 0xa9fe0000) return true; // 169.254.0.0/16
  if (((ipInt & 0xfff00000) >>> 0) === 0xac100000) return true; // 172.16.0.0/12
  if (((ipInt & 0xffffff00) >>> 0) === 0xc0000000) return true; // 192.0.0.0/24
  if (((ipInt & 0xffffff00) >>> 0) === 0xc0000200) return true; // 192.0.2.0/24
  if (((ipInt & 0xffffff00) >>> 0) === 0xc0586300) return true; // 192.88.99.0/24
  if (((ipInt & 0xffff0000) >>> 0) === 0xc0a80000) return true; // 192.168.0.0/16
  if (((ipInt & 0xfffe0000) >>> 0) === 0xc6120000) return true; // 198.18.0.0/15
  if (((ipInt & 0xffffff00) >>> 0) === 0xc6336400) return true; // 198.51.100.0/24
  if (((ipInt & 0xffffff00) >>> 0) === 0xcb007100) return true; // 203.0.113.0/24
  if ((ipInt >>> 28) >= 14) return true; // 224.0.0.0/4 + 240.0.0.0/4
  return false;
}

export function parseIpv6ToBigInt(host: string): bigint | null {
  let input = host.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!input || input.includes('%')) return null;

  let ipv4Tail: number | null = null;
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    if (lastColon < 0) return null;
    ipv4Tail = parseIpv4ToUint32(input.slice(lastColon + 1));
    if (ipv4Tail === null) return null;
    input = `${input.slice(0, lastColon + 1)}0:0`;
  }

  const doubleColons = input.split('::').length - 1;
  if (doubleColons > 1) return null;

  let groups: string[];
  if (doubleColons === 1) {
    const [left, right] = input.split('::');
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) return null;
    groups = [...leftGroups, ...Array<string>(missing).fill('0'), ...rightGroups];
  } else {
    groups = input.split(':');
    if (groups.length !== 8) return null;
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  if (ipv4Tail !== null) {
    value = (value & ~0xffffffffn) | BigInt(ipv4Tail >>> 0);
  }
  return value;
}

export function isBlockedIpv6(host: string): boolean {
  const value = parseIpv6ToBigInt(host);
  if (value === null) return true;
  if (value === 0n || value === 1n) return true; // ::, ::1
  if (value >> 32n === 0xffffn) {
    return isBlockedIpv4(Number(value & 0xffffffffn));
  }
  if (value >> 32n === 0n) return true; // IPv4-compatible / low-order specials
  if (value >> 121n === 0x7en) return true; // fc00::/7 ULA
  if (value >> 118n === 0x3fan) return true; // fe80::/10 link-local
  if (value >> 120n === 0xffn) return true; // ff00::/8 multicast
  if (value >> 32n === 0x0064ff9b0000000000000000n) return true; // 64:ff9b::/96 NAT64
  if (value >> 80n === 0x0064ff9b0001n) return true; // 64:ff9b:1::/48 local-use
  if (value >> 64n === 0x0100000000000000n) return true; // 100::/64 discard-only
  if (value >> 96n === 0x20010db8n) return true; // 2001:db8::/32 documentation
  if (value >> 80n === 0x200100020000n) return true; // 2001:2::/48 benchmarking
  if (value >> 100n === 0x02001001n || value >> 100n === 0x02001002n) return true; // ORCHID v1/v2
  if (value >> 96n === 0x20010000n) return true; // 2001::/32 Teredo
  if (value >> 112n === 0x2002n) return true; // 2002::/16 6to4
  if (value >> 108n === 0x3fff0n) return true; // 3fff::/20 documentation
  return false;
}

export function isBlockedSsrfHost(hostname: string): boolean {
  const host = hostname.toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;

  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan')
    || host.endsWith('.corp')
    || host.endsWith('.home')
    || host.endsWith('.home.arpa')
    || host.endsWith('.invalid')
    || host.endsWith('.test')
    || host.endsWith('.example')
    || host.endsWith('.svc')
    || host.endsWith('.cluster.local')
    || host === 'example.com'
    || host === 'example.net'
    || host === 'example.org'
    || host.endsWith('.example.com')
    || host.endsWith('.example.net')
    || host.endsWith('.example.org')
    || host.startsWith('engine-sonic.')
  ) {
    return true;
  }

  const ipv4 = parseIpv4ToUint32(host);
  if (ipv4 !== null) return isBlockedIpv4(ipv4);
  if (host.includes(':')) return isBlockedIpv6(host);
  return false;
}

export function isValidIpLiteral(ip: string): boolean {
  const value = ip.trim().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (IPV4_REGEX.test(value)) return true;
  return value.includes(':') && parseIpv6ToBigInt(value) !== null;
}

function normalizeIpLiteral(ip: string): string | null {
  const value = ip.trim().replace(/^\[|\]$/g, '');
  if (IPV4_REGEX.test(value)) return value;
  const v6 = parseIpv6ToBigInt(value);
  if (v6 === null) return null;
  return value.toLowerCase();
}

export function getPublicClientIp(request: Request, env?: AppEnv): string {
  if (env?.SONIC_RUNTIME === 'linux-engine') {
    const peer = request.headers.get('x-sonic-peer-ip') || '';
    const normalized = normalizeIpLiteral(peer);
    return normalized || 'unknown';
  }
  const cfIp = request.headers.get('CF-Connecting-IP') || '';
  return normalizeIpLiteral(cfIp) || 'unknown';
}

export function getForwardedClientIp(request: Request, env?: AppEnv): string {
  if (!hasValidEngineSecret(request, env)) return 'unknown';
  const forwarded = request.headers.get('X-Sonic-Client-IP') || '';
  return normalizeIpLiteral(forwarded) || 'unknown';
}

export function extractClientIp(request: Request, env?: AppEnv): string {
  return hasValidEngineSecret(request, env)
    ? getForwardedClientIp(request, env)
    : getPublicClientIp(request, env);
}

// ── Rate Limiter ──
// In-memory buckets are per process. Optional KV counters are best-effort and
// read-modify-write is not atomic; they must not be described as a strict
// global quota. Use a Durable Object or provider WAF for that guarantee.

interface WindowCounter {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, WindowCounter>();
const MAX_RATE_BUCKETS = 4096;

export interface RateLimitDecision {
  allowed: boolean;
  tier: 'engine' | 'api-key' | 'anonymous';
  limit: number;
  remaining: number;
  resetSec: number;
  scope: 'memory' | 'kv';
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, parseInt(String(value ?? ''), 10) || fallback));
}

function getOrCreateBucket(key: string, now: number): WindowCounter {
  const existing = rateBuckets.get(key);
  if (existing && now < existing.resetAt) return existing;
  if (existing) rateBuckets.delete(key);

  if (rateBuckets.size >= MAX_RATE_BUCKETS) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now >= bucket.resetAt) rateBuckets.delete(bucketKey);
    }
    while (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest === undefined) break;
      rateBuckets.delete(oldest);
    }
  }

  const entry: WindowCounter = { count: 0, resetAt: now + 60_000 };
  rateBuckets.set(key, entry);
  return entry;
}

export async function evaluateGatewayRateLimit(
  request: Request,
  env?: AppEnv,
  scope = 'api',
): Promise<RateLimitDecision> {
  const now = Date.now();
  const windowMs = 60_000;
  const isEngineCaller = hasValidEngineSecret(request, env);
  const ip = isEngineCaller ? getForwardedClientIp(request, env) : getPublicClientIp(request, env);

  let tier: 'engine' | 'api-key' | 'anonymous' = 'anonymous';
  let limit = parseLimit(env?.SONIC_RATE_LIMIT_ANON_RPM, 240, 10000);
  let subject = `anon:${ip}`;

  if (isEngineCaller) {
    tier = 'engine';
    limit = Math.min(20000, Math.max(limit * 2, 600));
    subject = `engine:${ip}`;
  } else {
    const authResult = await verifyAuth(request, env || {});
    if (authResult.authenticated && authResult.user) {
      tier = 'api-key';
      limit = parseLimit(env?.SONIC_RATE_LIMIT_AUTH_RPM, 600, 10000);
      subject = `user:${authResult.user.id}`;
    } else if (isEnvEnabled(env?.SONIC_REQUIRE_AUTH, false)) {
      return { allowed: false, tier, limit: 0, remaining: 0, resetSec: 60, scope: 'memory' };
    }
  }

  const bucketKey = `${scope}:${subject}`;

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
        scope: 'kv',
      };
    } catch (kvErr) {
      console.warn(
        '[Sonic RateLimit] KV limiter unavailable, using per-process fallback:',
        kvErr instanceof Error ? kvErr.message : 'unknown error',
      );
    }
  }

  const entry = getOrCreateBucket(bucketKey, now);
  entry.count += 1;
  return {
    allowed: entry.count <= limit,
    tier,
    limit,
    remaining: Math.max(0, limit - entry.count),
    resetSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    scope: 'memory',
  };
}

export function buildRateLimitErrorResponse(decision: RateLimitDecision): Response {
  const isAuthRequired = decision.limit === 0;
  return jsonResponse(
    {
      brand: 'Sonic',
      error: {
        code: isAuthRequired ? 'AUTH_REQUIRED' : 'RATE_LIMITED',
        message: isAuthRequired
          ? 'API key is required (pass X-Sonic-Key or Authorization: Bearer)'
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
        'X-RateLimit-Scope': decision.scope,
      },
    },
  );
}

export function resetRateLimitsForTest(): void {
  rateBuckets.clear();
}

export function getRateBucketCountForTest(): number {
  return rateBuckets.size;
}

export function getRateBucketMaxForTest(): number {
  return MAX_RATE_BUCKETS;
}

// ── SSRF URL Validation & Safe Fetch ──

export function validateSafeUrl(
  urlInput: string | URL,
  options?: {
    allowHttp?: boolean;
    allowedDomains?: string[];
  },
): { valid: boolean; url?: URL; error?: string } {
  let url: URL;
  try {
    url = typeof urlInput === 'string' ? new URL(urlInput) : urlInput;
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  const isHttps = url.protocol === 'https:';
  const isHttp = url.protocol === 'http:';
  if (!isHttps && (!isHttp || !options?.allowHttp)) {
    return { valid: false, error: 'Only https URLs are permitted' };
  }
  if (url.username || url.password) {
    return { valid: false, error: 'URL userinfo is strictly forbidden' };
  }
  if (url.port) {
    const portNum = parseInt(url.port, 10);
    if (isHttps && portNum !== 443) {
      return { valid: false, error: 'Non-standard port is forbidden' };
    }
    if (isHttp && portNum !== 80) {
      return { valid: false, error: 'Non-standard port is forbidden' };
    }
  }

  const hostname = url.hostname.toLowerCase().trim().replace(/\.+$/, '');
  if (isBlockedSsrfHost(hostname)) {
    return { valid: false, error: 'Destination host is forbidden by SSRF policy' };
  }

  if (options?.allowedDomains !== undefined) {
    if (options.allowedDomains.length === 0) {
      return { valid: false, error: 'Allowed domain whitelist is empty' };
    }
    const matched = options.allowedDomains.some((domain) => hostMatchesDomain(hostname, domain));
    if (!matched) {
      return { valid: false, error: 'Destination host is not in allowed domain whitelist' };
    }
  }

  return { valid: true, url };
}

export async function safeFetch(
  targetUrl: string | URL,
  init?: RequestInit,
  options?: {
    allowHttp?: boolean;
    allowedDomains?: string[];
    maxRedirects?: number;
    timeoutMs?: number;
    maxConcurrency?: number;
  },
): Promise<Response> {
  const maxRedirects = Math.min(5, Math.max(0, options?.maxRedirects ?? 3));
  const timeoutMs = Math.min(60_000, Math.max(1000, options?.timeoutMs ?? 15000));
  const maxConcurrency = Math.min(256, Math.max(1, options?.maxConcurrency ?? 32));
  let currentUrl = typeof targetUrl === 'string' ? targetUrl : targetUrl.toString();

  let redirectsRemaining = maxRedirects;

  while (true) {
    const valResult = validateSafeUrl(currentUrl, {
      allowHttp: options?.allowHttp,
      allowedDomains: options?.allowedDomains,
    });
    if (!valResult.valid || !valResult.url) {
      throw new Error(`SSRF check rejected: ${valResult.error}`);
    }

    const headers = new Headers(init?.headers);
    headers.delete('cookie');
    headers.delete('authorization');
    headers.delete('proxy-authorization');
    headers.delete('x-sonic-engine-key');
    headers.delete('x-sonic-key');
    headers.delete('x-cfsolara-key');
    headers.delete('x-sonic-client-ip');
    headers.delete('x-sonic-hop');

    if (activeProxyFetches >= maxConcurrency) {
      throw new Error('Proxy concurrency limit reached');
    }
    activeProxyFetches += 1;
    let resp: Response;
    try {
      resp = await fetch(valResult.url.toString(), {
        ...init,
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } finally {
      activeProxyFetches = Math.max(0, activeProxyFetches - 1);
    }

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      if (redirectsRemaining <= 0) throw new Error('Too many redirects');
      redirectsRemaining--;

      const nextUrl = new URL(location, valResult.url);
      if (valResult.url.protocol === 'https:' && nextUrl.protocol === 'http:') {
        throw new Error('Protocol downgrade from https to http during redirect is forbidden');
      }
      resp.body?.cancel().catch(() => {});
      currentUrl = nextUrl.toString();
      continue;
    }

    return resp;
  }
}

let activeProxyFetches = 0;

export function getActiveProxyFetchesForTest(): number {
  return activeProxyFetches;
}

export function resetProxyConcurrencyForTest(): void {
  activeProxyFetches = 0;
}

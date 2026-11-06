// Sonic Gateway — Stream Guard Playback Ticket & Access Control
// Pure TypeScript Web Crypto Implementation (Zero Node-specific dependencies)
// Provides:
// 1. HMAC-SHA256 Playback Ticket issuance and verification (initial exp <= 120s, track binding)
// 2. Playback Grant upgrade on first use: binds to session + trackId, extends TTL to min(duration*2, 30m)
// 3. Anti-theft enforcement: blocks cross-session/stolen ticket reuse while allowing unlimited Range/Seek for the owner session
// 4. Anonymous session cookie issuance & signature verification (sonic_anon_session)
// 5. Cloudflare Turnstile token validation (optional, risk-based)
// 6. Strict CORS & Fetch-Metadata allowlist verification
// 7. Sliding-window distinct-track & download quota evaluation

import type { AppEnv } from '../types';
import {
  base64UrlDecode,
  base64UrlEncode,
  readCookie,
  shouldUseSecureCookie,
  verifyAuth,
} from '../auth';
import { sha256Hex } from './crypto';
import { normalizeSourceId } from './licensing';
import { extractClientIp } from './security';

export const TICKET_PREFIX = 'st_v1';
export const GRANT_PREFIX = 'sg_grant_v1';
export const TICKET_MAX_TTL_SEC = 120;
export const SONIC_ANON_SESSION_COOKIE = 'sonic_anon_session';

export interface PlaybackTicketPayload {
  sub: string;
  tid: string; // "source:id:br"
  p: 'play' | 'download';
  iat: number;
  exp: number;
  nonce: string;
  uip?: string;
  cdh?: string;
}

export interface PlaybackGrantPayload {
  sub: string;
  tid: string; // "source:id:br"
  p: 'play' | 'download';
  iat: number;
  exp: number;
  nonce: string;
  uip?: string;
}

export interface PlaybackGrant {
  grantId: string; // Nonce of the activating ticket
  sub: string; // Bound session subject: e.g. "anon:sess_123" or user email
  tid: string; // Bound track fingerprint: "source:id:br"
  purpose: 'play' | 'download';
  clientIpHash?: string;
  createdAtSec: number;
  expiresAtSec: number;
  lastUsedAtSec: number;
  useCount: number;
}

export function getTrackGrantCookieName(tid: string): string {
  return `sonic_grant_${sha256Hex(tid).slice(0, 12)}`;
}

export const MAX_RETAINED_GRANT_COOKIES = 8;

export interface IncomingGrantCookie {
  name: string;
  iat: number;
  exp: number;
}

export function parseIncomingGrantCookies(rawCookieHeader: string | null): IncomingGrantCookie[] {
  if (!rawCookieHeader) return [];
  const map = new Map<string, IncomingGrantCookie>();
  const parts = rawCookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('sonic_grant_')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!val.startsWith(`${GRANT_PREFIX}.`)) continue;
    try {
      const grantParts = val.split('.');
      if (grantParts.length === 3) {
        const payloadBytes = base64UrlDecode(grantParts[1]);
        const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
        map.set(name, {
          name,
          iat: Number(payload.iat || 0),
          exp: Number(payload.exp || 0),
        });
      }
    } catch {
      map.set(name, { name, iat: 0, exp: 0 });
    }
  }
  return Array.from(map.values());
}

export function checkCookieSecure(requestOrUrlOrSecure?: Request | URL | boolean): boolean {
  if (typeof requestOrUrlOrSecure === 'boolean') return requestOrUrlOrSecure;
  if (!requestOrUrlOrSecure) return true;
  try {
    if (requestOrUrlOrSecure instanceof Request) {
      return shouldUseSecureCookie(new URL(requestOrUrlOrSecure.url));
    }
    if (requestOrUrlOrSecure instanceof URL) {
      return shouldUseSecureCookie(requestOrUrlOrSecure);
    }
  } catch {}
  return true;
}

export function buildGrantCookieHeaders(
  rawCookieHeader: string | null,
  newGrant: {
    tid: string;
    token: string;
    expiresAtSec: number;
  },
  requestOrSecure?: Request | URL | boolean,
): string[] {
  const isSecure = checkCookieSecure(requestOrSecure);
  const secureAttr = isSecure ? '; Secure' : '';
  const nowSec = Math.floor(Date.now() / 1000);
  const remainingLifetimeSec = Math.max(1, newGrant.expiresAtSec - nowSec);
  const currentCookieName = getTrackGrantCookieName(newGrant.tid);
  const newCookieHeader = `${currentCookieName}=${newGrant.token}; Path=/api/music/stream; HttpOnly; SameSite=Lax; Max-Age=${remainingLifetimeSec}${secureAttr}`;

  const incomingGrants = parseIncomingGrantCookies(rawCookieHeader);
  const otherGrants = incomingGrants.filter((g) => g.name !== currentCookieName);
  const maxOthers = MAX_RETAINED_GRANT_COOKIES - 1; // 7
  const setCookieHeaders: string[] = [];

  if (otherGrants.length > maxOthers) {
    otherGrants.sort((a, b) => a.iat - b.iat || a.exp - b.exp);
    const evictCount = otherGrants.length - maxOthers;
    const toEvict = otherGrants.slice(0, evictCount);
    for (const evicted of toEvict) {
      setCookieHeaders.push(
        `${evicted.name}=; Path=/api/music/stream; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureAttr}`,
      );
    }
  }

  setCookieHeaders.push(newCookieHeader);
  return setCookieHeaders;
}

export function normalizeTrackFingerprint(
  id: string,
  source = 'netease',
  br = '320',
): string {
  const cleanId = String(id || '')
    .trim()
    .toLowerCase();
  const cleanSource = normalizeSourceId(source || 'netease');
  const cleanBr = String(br || '320')
    .trim()
    .toLowerCase();
  return `${cleanSource}:${cleanId}:${cleanBr}`;
}

export function getStreamGuardSecret(env?: AppEnv): string {
  return String(env?.SONIC_SECRET || env?.SOLARA_SECRET || '').trim();
}

let warnedMissingKv = false;
export function warnMissingKvOnce(): void {
  if (!warnedMissingKv) {
    warnedMissingKv = true;
    console.warn(
      JSON.stringify({
        type: 'stream_guard_kv_warning',
        note: 'Stream Guard: Cloudflare KV binding (STREAM_GUARD_KV / RATE_LIMIT_KV) is absent; anti-replay and quota operate in isolate-local memory cache (multi-isolate atomicity is not guaranteed).',
      }),
    );
  }
}

// ── Web Crypto HMAC Helpers ──

async function getTicketSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const subkeyMaterial = encoder.encode(`${secret}:sonic-playback-ticket-v1`);
  return crypto.subtle.importKey(
    'raw',
    subkeyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function getAnonSessionKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const subkeyMaterial = encoder.encode(`${secret}:sonic-anon-session-v1`);
  return crypto.subtle.importKey(
    'raw',
    subkeyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function getGrantSigningKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const subkeyMaterial = encoder.encode(`${secret}:sonic-playback-grant-v1`);
  return crypto.subtle.importKey(
    'raw',
    subkeyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ── 1. Anonymous Session Cookie ──

export interface AnonSessionResult {
  sessionId: string;
  isNew: boolean;
  cookieHeader?: string;
}

export async function getOrCreateAnonSession(
  request: Request,
  env?: AppEnv,
): Promise<AnonSessionResult> {
  const secret = getStreamGuardSecret(env);
  const rawCookie = readCookie(request, SONIC_ANON_SESSION_COOKIE);

  if (secret.length >= 32 && rawCookie && rawCookie.includes('.')) {
    const [rawId, rawSig] = rawCookie.split('.');
    if (rawId && rawSig && /^[a-zA-Z0-9_-]{16,64}$/.test(rawId)) {
      try {
        const key = await getAnonSessionKey(secret);
        const sigBytes = base64UrlDecode(rawSig);
        const valid = await crypto.subtle.verify(
          'HMAC',
          key,
          sigBytes as any,
          new TextEncoder().encode(rawId),
        );
        if (valid) {
          return { sessionId: rawId, isNew: false };
        }
      } catch {
        // Invalid signature, generate a new one
      }
    }
  }

  // Issue new session
  const newSessionId = crypto.randomUUID().replace(/-/g, '');
  let cookieHeader: string | undefined;

  if (secret.length >= 32) {
    try {
      const key = await getAnonSessionKey(secret);
      const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(newSessionId),
      );
      const signedVal = `${newSessionId}.${base64UrlEncode(new Uint8Array(sig))}`;
      let isSecure = true;
      try {
        isSecure = shouldUseSecureCookie(new URL(request.url));
      } catch {
        isSecure = true;
      }
      const secureAttr = isSecure ? '; Secure' : '';
      cookieHeader = `${SONIC_ANON_SESSION_COOKIE}=${signedVal}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureAttr}`;
    } catch {
      // Ignore signing error, session will be anonymous without cookie
    }
  }

  return { sessionId: newSessionId, isNew: true, cookieHeader };
}

export async function resolveGuardSubject(
  request: Request,
  env?: AppEnv,
): Promise<string> {
  // 1. Authenticated user (API Key / user session cookie) -> user:<email>
  try {
    const auth = await verifyAuth(request, env || {});
    if (auth.authenticated && auth.user?.email) {
      return `user:${auth.user.email.toLowerCase().trim()}`;
    }
  } catch {}

  // 2. Verified sonic_anon_session cookie (HMAC signed) -> anon:<完整会话ID>
  // Strictly ignores unverified X-Sonic-Anon-Id header
  const secret = getStreamGuardSecret(env);
  const rawCookie = readCookie(request, SONIC_ANON_SESSION_COOKIE);
  if (secret.length >= 32 && rawCookie && rawCookie.includes('.')) {
    const [rawId, rawSig] = rawCookie.split('.');
    if (rawId && rawSig && /^[a-zA-Z0-9_-]{16,64}$/.test(rawId)) {
      try {
        const key = await getAnonSessionKey(secret);
        const sigBytes = base64UrlDecode(rawSig);
        const valid = await crypto.subtle.verify(
          'HMAC',
          key,
          sigBytes as any,
          new TextEncoder().encode(rawId),
        );
        if (valid) {
          return `anon:${rawId}`;
        }
      } catch {}
    }
  }

  // 3. Unauthenticated / No valid session -> anon:ip:<ip哈希>
  const clientIp = extractClientIp(request, env);
  const ipHash = sha256Hex(clientIp).slice(0, 16);
  return `anon:ip:${ipHash}`;
}

// ── 2. Playback Grant Store (Active Playback Authorization) ──

const memoryPlaybackGrants = new Map<string, PlaybackGrant>();
const MAX_MEMORY_GRANTS = 4096;

function pruneMemoryGrants(nowSec: number): void {
  if (memoryPlaybackGrants.size < MAX_MEMORY_GRANTS) return;
  for (const [key, grant] of memoryPlaybackGrants.entries()) {
    if (grant.expiresAtSec <= nowSec) {
      memoryPlaybackGrants.delete(key);
    }
  }
}

export function clearPlaybackGrantsForTest(): void {
  memoryPlaybackGrants.clear();
}

// ── 3. Ticket Issuance & Verification ──

export async function issueStreamTicket(options: {
  id: string;
  source?: string;
  br?: string;
  purpose?: 'play' | 'download';
  sub: string;
  ip?: string;
  cdh?: string;
  ttlSec?: number;
  env?: AppEnv;
}): Promise<string> {
  const secret = getStreamGuardSecret(options.env);
  if (!secret || secret.length < 32) {
    throw new Error(
      'SONIC_SECRET is not configured or shorter than 32 characters',
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    TICKET_MAX_TTL_SEC,
    Math.max(10, options.ttlSec || TICKET_MAX_TTL_SEC),
  );
  const expSec = nowSec + ttl;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const uip = options.ip ? sha256Hex(options.ip).slice(0, 8) : undefined;

  const payload: PlaybackTicketPayload = {
    sub: options.sub,
    tid: normalizeTrackFingerprint(options.id, options.source, options.br),
    p: options.purpose || 'play',
    iat: nowSec,
    exp: expSec,
    nonce,
    ...(uip ? { uip } : {}),
    ...(options.cdh ? { cdh: options.cdh } : {}),
  };

  const payloadB64url = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await getTicketSigningKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${TICKET_PREFIX}.${payloadB64url}`),
  );
  const sigB64url = base64UrlEncode(new Uint8Array(sig));

  return `${TICKET_PREFIX}.${payloadB64url}.${sigB64url}`;
}

export async function issuePlaybackGrantToken(options: {
  tid: string;
  sub: string;
  purpose: 'play' | 'download';
  durationSec?: number;
  nonce?: string;
  ip?: string;
  request?: Request;
  url?: URL;
  isSecure?: boolean;
  env?: AppEnv;
}): Promise<{ token: string; cookieHeader: string; expiresAtSec: number }> {
  const secret = getStreamGuardSecret(options.env);
  if (!secret || secret.length < 32) {
    throw new Error(
      'SONIC_SECRET is not configured or shorter than 32 characters',
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const songDuration = options.durationSec || 180;
  const lifetimeSec =
    options.purpose === 'play'
      ? Math.min(1800, Math.max(300, Math.round(songDuration * 2)))
      : 300;
  const expiresAtSec = nowSec + lifetimeSec;
  const nonce = options.nonce || crypto.randomUUID().replace(/-/g, '');
  const uip = options.ip ? sha256Hex(options.ip).slice(0, 8) : undefined;

  const payload: PlaybackGrantPayload = {
    sub: options.sub,
    tid: options.tid,
    p: options.purpose,
    iat: nowSec,
    exp: expiresAtSec,
    nonce,
    ...(uip ? { uip } : {}),
  };

  const payloadB64url = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await getGrantSigningKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${GRANT_PREFIX}.${payloadB64url}`),
  );
  const sigB64url = base64UrlEncode(new Uint8Array(sig));
  const token = `${GRANT_PREFIX}.${payloadB64url}.${sigB64url}`;

  const isSecure = checkCookieSecure(options.request || options.url || options.isSecure);
  const secureAttr = isSecure ? '; Secure' : '';
  const cookieName = getTrackGrantCookieName(options.tid);
  const cookieHeader = `${cookieName}=${token}; Path=/api/music/stream; HttpOnly; SameSite=Lax; Max-Age=${lifetimeSec}${secureAttr}`;

  return { token, cookieHeader, expiresAtSec };
}

export async function verifyPlaybackGrantToken(
  token: string,
  options: {
    id?: string;
    source?: string;
    br?: string;
    purpose?: 'play' | 'download';
    sub?: string;
    ip?: string;
    env?: AppEnv;
  },
): Promise<{
  valid: boolean;
  error?: string;
  payload?: PlaybackGrantPayload;
  grant?: PlaybackGrant;
  ipDrift?: boolean;
}> {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'MISSING_GRANT_TOKEN' };
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== GRANT_PREFIX) {
    return { valid: false, error: 'INVALID_GRANT_FORMAT' };
  }

  const [, payloadB64url, sigB64url] = parts;
  if (!payloadB64url || !sigB64url) {
    return { valid: false, error: 'MALFORMED_GRANT_PARTS' };
  }

  const secret = getStreamGuardSecret(options.env);
  if (!secret || secret.length < 32) {
    return { valid: false, error: 'SECRET_MISCONFIGURED' };
  }

  let payload: PlaybackGrantPayload;
  try {
    const jsonBytes = base64UrlDecode(payloadB64url);
    payload = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    return { valid: false, error: 'CORRUPTED_GRANT_PAYLOAD' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || nowSec > payload.exp) {
    return { valid: false, error: 'GRANT_EXPIRED' };
  }

  try {
    const key = await getGrantSigningKey(secret);
    const sigBytes = base64UrlDecode(sigB64url);
    const signingInput = new TextEncoder().encode(
      `${GRANT_PREFIX}.${payloadB64url}`,
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as any,
      signingInput,
    );
    if (!valid) {
      return { valid: false, error: 'GRANT_SIGNATURE_MISMATCH' };
    }
  } catch {
    return { valid: false, error: 'SIGNATURE_VERIFICATION_FAILED' };
  }

  const kv = options.env?.STREAM_GUARD_KV || options.env?.RATE_LIMIT_KV || options.env?.KV;
  if (kv && typeof kv.get === 'function') {
    try {
      const revoked = await kv.get(`sg:revoked:${payload.nonce}`);
      if (revoked) {
        return { valid: false, error: 'GRANT_REVOKED' };
      }
    } catch {}
  }

  if (options.id) {
    const expectedTid = normalizeTrackFingerprint(
      options.id,
      options.source,
      options.br,
    );
    const [expectedSource, expectedTrack, expectedBr] = expectedTid.split(':');
    const [payloadSource, payloadTrack, payloadBr] = (payload.tid || '').split(':');
    if (expectedTrack !== payloadTrack) {
      return { valid: false, error: 'TICKET_ID_MISMATCH' };
    }
    if (options.source && expectedSource !== payloadSource) {
      return { valid: false, error: 'TICKET_SOURCE_MISMATCH' };
    }
    if (options.br && payloadBr && expectedBr !== payloadBr) {
      return { valid: false, error: 'TICKET_BITRATE_MISMATCH' };
    }
  }

  if (options.purpose && payload.p !== options.purpose) {
    return { valid: false, error: 'TICKET_PURPOSE_MISMATCH' };
  }

  const currentIpHash = options.ip ? sha256Hex(options.ip).slice(0, 8) : undefined;
  const sessionMatches = Boolean(options.sub && payload.sub && options.sub === payload.sub);
  const ipMatches = Boolean(currentIpHash && payload.uip && currentIpHash === payload.uip);

  let ipDrift = false;
  if (sessionMatches && !ipMatches && currentIpHash && payload.uip) {
    ipDrift = true;
    console.warn(
      JSON.stringify({
        type: 'stream_guard_ip_drift',
        subject: options.sub,
        tid: payload.tid,
        oldIpHash: payload.uip,
        newIpHash: currentIpHash,
        note: 'Client IP drifted in active grant session (e.g. Wi-Fi to cellular); permitted without blocking',
      }),
    );
  } else if ((options.sub || options.ip) && !sessionMatches && !ipMatches) {
    return { valid: false, error: 'TICKET_SESSION_MISMATCH' };
  }

  const grant: PlaybackGrant = {
    grantId: payload.nonce,
    sub: payload.sub,
    tid: payload.tid,
    purpose: payload.p,
    clientIpHash: payload.uip,
    createdAtSec: payload.iat,
    expiresAtSec: payload.exp,
    lastUsedAtSec: nowSec,
    useCount: 1,
  };

  return { valid: true, payload, grant, ipDrift };
}

export async function verifyStreamTicket(
  ticket: string,
  options: {
    id?: string;
    source?: string;
    br?: string;
    purpose?: 'play' | 'download';
    sub?: string;
    ip?: string;
    durationSec?: number;
    grantToken?: string;
    env?: AppEnv;
  },
): Promise<{
  valid: boolean;
  error?: string;
  payload?: PlaybackTicketPayload;
  grant?: PlaybackGrant;
  grantToken?: string;
  grantCookieHeader?: string;
  ipDrift?: boolean;
}> {
  if (!ticket || typeof ticket !== 'string') {
    return { valid: false, error: 'MISSING_TICKET' };
  }

  if (ticket.startsWith(GRANT_PREFIX)) {
    const res = await verifyPlaybackGrantToken(ticket, options);
    return {
      valid: res.valid,
      error: res.error,
      payload: res.payload as any,
      grant: res.grant,
      grantToken: ticket,
      ipDrift: res.ipDrift,
    };
  }

  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX) {
    return { valid: false, error: 'INVALID_TICKET_FORMAT' };
  }

  const [, payloadB64url, sigB64url] = parts;
  if (!payloadB64url || !sigB64url) {
    return { valid: false, error: 'MALFORMED_TICKET_PARTS' };
  }

  const secret = getStreamGuardSecret(options.env);
  if (!secret || secret.length < 32) {
    return { valid: false, error: 'SECRET_MISCONFIGURED' };
  }

  let payload: PlaybackTicketPayload;
  try {
    const jsonBytes = base64UrlDecode(payloadB64url);
    payload = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    return { valid: false, error: 'CORRUPTED_TICKET_PAYLOAD' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const kv = options.env?.STREAM_GUARD_KV || options.env?.RATE_LIMIT_KV || options.env?.KV;
  const kvKey = `sg:grant:${payload.nonce}`;

  // Check if an upgraded Playback Grant already exists (subsequent Range requests)
  let activeGrant: PlaybackGrant | undefined = memoryPlaybackGrants.get(payload.nonce);
  if (!activeGrant && kv && typeof kv.get === 'function') {
    try {
      const kvVal = await kv.get(kvKey);
      if (kvVal) {
        activeGrant = JSON.parse(kvVal);
      }
    } catch {}
  }

  if (!activeGrant && options.grantToken) {
    const grantRes = await verifyPlaybackGrantToken(options.grantToken, options);
    if (grantRes.valid) {
      return {
        valid: true,
        payload: grantRes.payload as any,
        grant: grantRes.grant,
        grantToken: options.grantToken,
      };
    }
  }

  if (activeGrant) {
    // 1. Grant Expiration: grant lifetime extends far beyond the 120s ticket window
    if (nowSec > activeGrant.expiresAtSec) {
      return { valid: false, error: 'TICKET_EXPIRED' };
    }

    // 2. Anti-Theft / Cross-Session Replay Prevention
    // Only the same session/client that activated the ticket is authorized to Range seek
    const currentIpHash = options.ip ? sha256Hex(options.ip).slice(0, 8) : undefined;
    const grantIpHash = activeGrant.clientIpHash ? activeGrant.clientIpHash.slice(0, 8) : undefined;
    const sessionMatches = Boolean(options.sub && activeGrant.sub && options.sub === activeGrant.sub);
    const ipMatches = Boolean(currentIpHash && grantIpHash && currentIpHash === grantIpHash);

    let ipDrift = false;
    if (sessionMatches && !ipMatches && currentIpHash && grantIpHash) {
      ipDrift = true;
      console.warn(
        JSON.stringify({
          type: 'stream_guard_ip_drift',
          subject: options.sub,
          tid: activeGrant.tid,
          oldIpHash: grantIpHash,
          newIpHash: currentIpHash,
          note: 'Client IP drifted in active grant session (e.g. Wi-Fi to cellular); permitted without blocking',
        }),
      );
    } else if ((options.sub || options.ip) && !sessionMatches && !ipMatches) {
      return { valid: false, error: 'TICKET_SESSION_MISMATCH' };
    }

    // 3. Purpose Check
    if (options.purpose && activeGrant.purpose !== options.purpose) {
      return { valid: false, error: 'TICKET_PURPOSE_MISMATCH' };
    }

    // 4. Track Binding Check
    if (options.id) {
      const expectedTid = normalizeTrackFingerprint(
        options.id,
        options.source,
        options.br,
      );
      const [expectedSource, expectedTrack, expectedBr] = expectedTid.split(':');
      const [grantSource, grantTrack, grantBr] = activeGrant.tid.split(':');
      if (expectedTrack !== grantTrack) {
        return { valid: false, error: 'TICKET_ID_MISMATCH' };
      }
      if (options.source && expectedSource !== grantSource) {
        return { valid: false, error: 'TICKET_SOURCE_MISMATCH' };
      }
      if (options.br && grantBr && expectedBr !== grantBr) {
        return { valid: false, error: 'TICKET_BITRATE_MISMATCH' };
      }
    }

    // Valid grant: allow unlimited Range requests for seeking and buffering within the session
    activeGrant.lastUsedAtSec = nowSec;
    activeGrant.useCount += 1;
    return { valid: true, payload, grant: activeGrant, ipDrift };
  }

  // ── First Use of Ticket: Full Cryptographic & Initial TTL Validation ──
  if (!payload.exp || nowSec > payload.exp) {
    return { valid: false, error: 'TICKET_EXPIRED' };
  }
  if (!payload.iat || payload.iat > nowSec + 30) {
    return { valid: false, error: 'TICKET_FUTURE_IAT' };
  }

  // Constant-time HMAC signature verification
  try {
    const key = await getTicketSigningKey(secret);
    const sigBytes = base64UrlDecode(sigB64url);
    const signingInput = new TextEncoder().encode(
      `${TICKET_PREFIX}.${payloadB64url}`,
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as any,
      signingInput,
    );
    if (!valid) {
      return { valid: false, error: 'TICKET_SIGNATURE_MISMATCH' };
    }
  } catch {
    return { valid: false, error: 'SIGNATURE_VERIFICATION_FAILED' };
  }

  // Check track binding (id, source, br)
  if (options.id) {
    const expectedTid = normalizeTrackFingerprint(
      options.id,
      options.source,
      options.br,
    );
    const [expectedSource, expectedTrack, expectedBr] = expectedTid.split(':');
    const [payloadSource, payloadTrack, payloadBr] = (payload.tid || '').split(
      ':',
    );
    if (expectedTrack !== payloadTrack) {
      return { valid: false, error: 'TICKET_ID_MISMATCH' };
    }
    if (options.source && expectedSource !== payloadSource) {
      return { valid: false, error: 'TICKET_SOURCE_MISMATCH' };
    }
    if (options.br && payloadBr && expectedBr !== payloadBr) {
      return { valid: false, error: 'TICKET_BITRATE_MISMATCH' };
    }
  }

  // Check purpose
  if (options.purpose && payload.p !== options.purpose) {
    return { valid: false, error: 'TICKET_PURPOSE_MISMATCH' };
  }

  // Check session on first use
  const currentIpHash = options.ip ? sha256Hex(options.ip).slice(0, 8) : undefined;
  const sessionMatches = Boolean(options.sub && payload.sub && options.sub === payload.sub);
  const ipMatches = Boolean(currentIpHash && payload.uip && currentIpHash === payload.uip);

  let ipDrift = false;
  if (sessionMatches && !ipMatches && currentIpHash && payload.uip) {
    ipDrift = true;
    console.warn(
      JSON.stringify({
        type: 'stream_guard_ip_drift',
        subject: options.sub,
        tid: payload.tid,
        oldIpHash: payload.uip,
        newIpHash: currentIpHash,
        note: 'Client IP drifted on ticket verification (e.g. Wi-Fi to cellular); permitted without blocking',
      }),
    );
  } else if ((options.sub || options.ip) && !sessionMatches && !ipMatches) {
    return { valid: false, error: 'TICKET_SESSION_MISMATCH' };
  }

  // ── Upgrade to Playback Grant on First Successful Verification ──
  // Range playback requires continuous buffer/seek requests over the song duration.
  // Grant lifetime is set to min(songDuration * 2, 30 minutes), default 1800s.
  // Downloads receive a 300s window.
  const songDuration = options.durationSec || 180;
  const grantLifetimeSec =
    payload.p === 'play'
      ? Math.min(1800, Math.max(300, Math.round(songDuration * 2)))
      : 300;

  const newGrant: PlaybackGrant = {
    grantId: payload.nonce,
    sub: options.sub || payload.sub,
    tid: payload.tid,
    purpose: payload.p,
    clientIpHash: options.ip ? sha256Hex(options.ip).slice(0, 16) : undefined,
    createdAtSec: nowSec,
    expiresAtSec: nowSec + grantLifetimeSec,
    lastUsedAtSec: nowSec,
    useCount: 1,
  };

  pruneMemoryGrants(nowSec);
  memoryPlaybackGrants.set(payload.nonce, newGrant);

  if (kv && typeof kv.put === 'function') {
    try {
      await kv.put(kvKey, JSON.stringify(newGrant), {
        expirationTtl: grantLifetimeSec + 60,
      });
    } catch {}
  } else {
    warnMissingKvOnce();
  }

  let issuedToken: string | undefined;
  let issuedCookieHeader: string | undefined;
  try {
    const grantInfo = await issuePlaybackGrantToken({
      tid: payload.tid,
      sub: options.sub || payload.sub,
      purpose: payload.p,
      durationSec: options.durationSec,
      nonce: payload.nonce,
      ip: options.ip,
      env: options.env,
    });
    issuedToken = grantInfo.token;
    issuedCookieHeader = grantInfo.cookieHeader;
  } catch {}

  return {
    valid: true,
    payload,
    grant: newGrant,
    grantToken: issuedToken,
    grantCookieHeader: issuedCookieHeader,
    ipDrift,
  };
}

// ── 4. Strict CORS & Fetch-Metadata Validation ──

export interface CorsCheckResult {
  allowed: boolean;
  reason?: string;
  allowOriginHeader?: string;
}

export function checkStreamCorsAndFetchMetadata(
  request: Request,
  env?: AppEnv,
): CorsCheckResult {
  const origin = request.headers.get('Origin');
  const isStrictCors = String(env?.SONIC_CORS_STRICT || '0').trim() === '1';

  if (!isStrictCors) {
    return { allowed: true, allowOriginHeader: origin || '*' };
  }

  const rawAllowedOrigins = String(
    env?.SONIC_ALLOWED_ORIGINS || env?.SONIC_BASE_URL || '',
  );
  const allowedList = rawAllowedOrigins
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  let isAllowedOrigin = false;
  let matchedOrigin = '';

  if (origin) {
    const normOrigin = origin.trim().toLowerCase();
    try {
      const reqOrigin = new URL(request.url).origin.toLowerCase();
      if (normOrigin === reqOrigin) {
        isAllowedOrigin = true;
        matchedOrigin = origin;
      }
    } catch {}

    if (!isAllowedOrigin) {
      isAllowedOrigin = allowedList.some((allowed) => {
        try {
          const u = new URL(allowed);
          if (u.origin.toLowerCase() === normOrigin) {
            matchedOrigin = origin;
            return true;
          }
          return false;
        } catch {
          if (allowed === normOrigin) {
            matchedOrigin = origin;
            return true;
          }
          return false;
        }
      });
    }

    if (!isAllowedOrigin) {
      return {
        allowed: false,
        reason: 'ORIGIN_FORBIDDEN',
      };
    }
  }

  // Sec-Fetch-Site 判断：cross-site 且 Origin 不在白名单时拒绝
  const fetchSite = request.headers.get('Sec-Fetch-Site')?.toLowerCase().trim();
  if (fetchSite === 'cross-site' && !isAllowedOrigin) {
    return {
      allowed: false,
      reason: 'CROSS_SITE_FETCH_FORBIDDEN',
    };
  }

  // Sec-Fetch-Dest & Sec-Fetch-Site (where supported by browser)
  const fetchDest = request.headers.get('Sec-Fetch-Dest');
  if (
    fetchDest &&
    fetchDest !== 'audio' &&
    fetchDest !== 'empty' &&
    fetchDest !== 'video'
  ) {
    return {
      allowed: false,
      reason: 'FETCH_DEST_NOT_PERMITTED',
    };
  }

  const allowOriginHeader = matchedOrigin || undefined;
  return { allowed: true, allowOriginHeader };
}

// ── 5. Sliding-Window Quota & Anomaly Tracking ──

interface QuotaBucket {
  distinctTracks: Set<string>;
  dailyDownloads: number;
  dayTimestamp: string;
  minuteResetAt: number;
}

const quotaStore = new Map<string, QuotaBucket>();
const MAX_QUOTA_BUCKETS = 4096;

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function evaluateStreamGuardQuota(
  subject: string,
  trackId: string,
  purpose: 'play' | 'download',
  env?: AppEnv,
): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
  const now = Date.now();
  const today = getTodayString();
  const maxDistinctPerMin = 30; // max 30 distinct tracks per minute (prevents crawl scraping)
  const maxAnonDownloadsPerDay = parseInt(
    String(env?.SONIC_ANON_DOWNLOAD_LIMIT_DAILY || '20'),
    10,
  );

  let bucket = quotaStore.get(subject);
  if (!bucket) {
    if (quotaStore.size >= MAX_QUOTA_BUCKETS) {
      const oldestKey = quotaStore.keys().next().value;
      if (oldestKey !== undefined) quotaStore.delete(oldestKey);
    }
    bucket = {
      distinctTracks: new Set(),
      dailyDownloads: 0,
      dayTimestamp: today,
      minuteResetAt: now + 60_000,
    };
    quotaStore.set(subject, bucket);
  }

  // Reset minute window
  if (now > bucket.minuteResetAt) {
    bucket.distinctTracks.clear();
    bucket.minuteResetAt = now + 60_000;
  }

  // Reset daily window
  if (bucket.dayTimestamp !== today) {
    bucket.dailyDownloads = 0;
    bucket.dayTimestamp = today;
  }

  // Check distinct-track crawl limit
  if (trackId) {
    bucket.distinctTracks.add(trackId);
    if (bucket.distinctTracks.size > maxDistinctPerMin) {
      return {
        allowed: false,
        reason: 'RATE_LIMIT_EXCESSIVE_TRACKS',
        retryAfter: Math.ceil((bucket.minuteResetAt - now) / 1000),
      };
    }
  }

  // Check download daily quota
  if (purpose === 'download') {
    const isDownloadGuarded =
      String(env?.SONIC_DOWNLOAD_GUARD || '0').trim() === '1';
    if (isDownloadGuarded) {
      bucket.dailyDownloads += 1;
      if (bucket.dailyDownloads > maxAnonDownloadsPerDay) {
        return {
          allowed: false,
          reason: `Daily download quota of ${maxAnonDownloadsPerDay} tracks exceeded`,
          retryAfter: 3600,
        };
      }
    }
  }

  return { allowed: true };
}

// ── 6. Cloudflare Turnstile Verification (Optional) ──

export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string,
  env?: AppEnv,
): Promise<{ success: boolean; error?: string }> {
  const isEnabled = String(env?.SONIC_TURNSTILE_ENABLED || '0').trim() === '1';
  if (!isEnabled) {
    return { success: true };
  }

  const secretKey = env?.SONIC_TURNSTILE_SECRET_KEY;
  if (!secretKey) {
    return { success: true };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIp) {
      formData.append('remoteip', remoteIp);
    }

    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      },
    );

    const outcome: any = await res.json();
    return {
      success: Boolean(outcome.success),
      error: outcome['error-codes']?.[0],
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'TURNSTILE_VERIFY_FAILED' };
  }
}

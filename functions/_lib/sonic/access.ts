// Sonic access control primitives.
// Invite eligibility is intentionally independent from OAuth/API-key identity.

import { base64UrlDecode, base64UrlEncode, readCookie, shouldUseSecureCookie } from '../auth';
import { jsonResponse } from '../http';
import { hasValidEngineSecret } from './security';
import { sha256Hex } from './crypto';
import type { AppEnv } from '../types';

export const SONIC_ACCESS_COOKIE = 'sonic_access';
export const ACCESS_INVITE_HASH_PREFIX = 'sonic:access:invite:';
export const ACCESS_SESSION_HASH_PREFIX = 'sonic:access:session:';

export const DEFAULT_ACCESS_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;
export const MAX_ACCESS_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const MIN_ACCESS_SESSION_MAX_AGE_SEC = 60;
const MAX_INVITE_CODE_LENGTH = 256;
const MAX_ACCESS_SESSION_TOKEN_LENGTH = 512;
const ACCESS_TOKEN_DOMAIN = 'sonic-access-session-v1.';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type AccessMode = 'open' | 'legacy-staging' | 'invite';

export interface AccessSessionRecord {
  sessionHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface InviteRedemption {
  inviteId: string;
  expiresAt?: number;
}

/**
 * The concrete implementation is supplied by the runtime (SQLite on Node,
 * an atomic binding on Pages). Raw invite/session tokens must never be stored.
 */
export interface AccessRepository {
  redeemInvite(codeHash: string, nowMs: number): Promise<InviteRedemption | null> | InviteRedemption | null;
  redeemInviteAndCreateSession?(codeHash: string, record: AccessSessionRecord, nowMs: number): Promise<InviteRedemption | null> | InviteRedemption | null;
  createSession(record: AccessSessionRecord): Promise<void> | void;
  getSession(sessionHash: string, nowMs: number): Promise<AccessSessionRecord | null> | AccessSessionRecord | null;
  revokeSession?(sessionHash: string, nowMs: number): Promise<void> | void;
}

export interface AccessSessionResult {
  valid: boolean;
  session?: AccessSessionRecord;
  reason?: 'missing' | 'invalid' | 'expired' | 'revoked' | 'store_unavailable';
}

function asTrimmedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function getAccessMode(env?: AppEnv): AccessMode {
  const raw = String(env?.SONIC_ACCESS_MODE || '').trim().toLowerCase();
  if (raw === 'invite' || raw === 'legacy-staging' || raw === 'open') return raw;
  // Missing mode preserves the existing public deployment behavior.
  return 'open';
}

export function getAccessSessionMaxAgeSec(env?: AppEnv): number {
  const raw = Number.parseInt(String(env?.SONIC_ACCESS_SESSION_MAX_AGE_SEC || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ACCESS_SESSION_MAX_AGE_SEC;
  return Math.min(MAX_ACCESS_SESSION_MAX_AGE_SEC, Math.max(MIN_ACCESS_SESSION_MAX_AGE_SEC, Math.floor(raw)));
}

export function getAccessRepository(env?: AppEnv): AccessRepository | null {
  const candidate = (env as any)?.SONIC_ACCESS_STORE || (env as any)?.SONIC_INVITE_KV;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.redeemInvite === 'function' && typeof candidate.createSession === 'function' && typeof candidate.getSession === 'function') return candidate as AccessRepository;
  if (typeof candidate.get === 'function' && typeof candidate.put === 'function') return createKvAccessRepository(candidate);
  return null;
}

function createKvAccessRepository(kv: any): AccessRepository {
  const read = async (key: string) => {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  };
  const write = async (key: string, value: unknown, expiresAt?: number) => {
    const options = expiresAt ? { expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000)) } : undefined;
    await kv.put(key, JSON.stringify(value), options);
  };
  return {
    async redeemInvite(codeHash, nowMs) {
      const row = await read(codeHash);
      if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= nowMs) || Number(row.usedCount || 0) >= Number(row.maxUses || 1)) return null;
      // KV cannot provide atomic compare-and-swap; require a native atomic binding for
      // production invite mode instead of silently overselling a code under concurrency.
      if (typeof kv.atomic !== 'function') throw new Error('Invite KV lacks atomic redemption support');
      const next = { ...row, usedCount: Number(row.usedCount || 0) + 1 };
      await write(codeHash, next, row.expiresAt);
      return { inviteId: String(row.inviteId || codeHash), ...(row.expiresAt ? { expiresAt: Number(row.expiresAt) } : {}) };
    },
    createSession: (record) => write(record.sessionHash, record, record.expiresAt),
    getSession: (sessionHash, nowMs) => read(sessionHash).then((record) => record && record.expiresAt > nowMs ? record : null),
    revokeSession: (sessionHash, nowMs) => write(sessionHash, { ...(read(sessionHash) as any), revokedAt: nowMs }),
  };
}


function normalizeInviteCode(code: unknown): string {
  const value = asTrimmedString(code, MAX_INVITE_CODE_LENGTH);
  if (!value || value.length > MAX_INVITE_CODE_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return '';
  return value;
}

export function hashInviteCode(code: string): string | null {
  const normalized = normalizeInviteCode(code);
  return normalized ? sha256Hex(`sonic-access-invite-v1:${normalized}`) : null;
}

function hashSessionToken(token: string): string | null {
  if (!token || token.length > MAX_ACCESS_SESSION_TOKEN_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(token)) return null;
  return sha256Hex(`sonic-access-session-v1:${token}`);
}

function randomOpaqueToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function accessSecret(env: AppEnv): Promise<CryptoKey | null> {
  const secret = String(env.SONIC_ACCESS_SECRET || '').trim();
  if (secret.length < 32) return null;
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signedSessionToken(record: Omit<AccessSessionRecord, 'sessionHash'>, env: AppEnv): Promise<string | null> {
  const key = await accessSecret(env);
  if (!key) return null;
  const payload = base64UrlEncode(textEncoder.encode(JSON.stringify({ v: 1, iat: record.createdAt, exp: record.expiresAt })));
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(ACCESS_TOKEN_DOMAIN + payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifySignedSession(token: string, env: AppEnv, nowMs: number): Promise<AccessSessionRecord | null> {
  const key = await accessSecret(env);
  if (!key) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const signature = base64UrlDecode(parts[1]);
    const signatureBuffer = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer;
    const data = textEncoder.encode(ACCESS_TOKEN_DOMAIN + parts[0]);
    const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const valid = await crypto.subtle.verify('HMAC', key, signatureBuffer, dataBuffer);
    if (!valid) return null;
    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(parts[0]))) as { v: number; iat: number; exp: number };
    if (payload.v !== 1 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= nowMs || payload.exp - payload.iat > MAX_ACCESS_SESSION_MAX_AGE_SEC * 1000) return null;
    return { sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, sha256Hex(`sonic-access-session-v1:${token}`)), createdAt: payload.iat, expiresAt: payload.exp };
  } catch { return null; }
}


function getStoreKey(prefix: string, hash: string): string {
  return `${prefix}${hash}`;
}

export function readAccessSessionToken(request: Request): string | undefined {
  const token = readCookie(request, SONIC_ACCESS_COOKIE);
  if (!token || token.length > MAX_ACCESS_SESSION_TOKEN_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(token)) return undefined;
  return token;
}

export function buildAccessSessionCookie(token: string, expiresAt: number, requestUrl: URL): string {
  const maxAge = Math.max(0, Math.min(MAX_ACCESS_SESSION_MAX_AGE_SEC, Math.floor((expiresAt - Date.now()) / 1000)));
  const secure = shouldUseSecureCookie(requestUrl) ? '; Secure' : '';
  return `${SONIC_ACCESS_COOKIE}=${encodeURIComponent(token)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function buildClearAccessSessionCookie(requestUrl: URL): string {
  const secure = shouldUseSecureCookie(requestUrl) ? '; Secure' : '';
  return `${SONIC_ACCESS_COOKIE}=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export type AccessRedeemResult =
  | { ok: true; redemption: InviteRedemption; session?: { token: string; record: AccessSessionRecord } }
  | { ok: false; code: 'invalid' | 'store_unavailable' }

export async function redeemAccessInvite(
  env: AppEnv,
  code: string,
  nowMs = Date.now(),
): Promise<AccessRedeemResult> {
  const codeHash = hashInviteCode(code);
  const repository = getAccessRepository(env);
  if (!codeHash && !repository) return { ok: false, code: 'store_unavailable' };
  if (!codeHash) return { ok: false, code: 'invalid' };

  // Pages without a durable store use the independent signed-session path.
  if (!repository) {
    const configured = String(env.SONIC_INVITE_CODES || '').split(',').map(value => value.trim()).filter(Boolean);
    const matched = configured.some(value => hashInviteCode(value) === codeHash);
    if (!matched) return { ok: false, code: 'invalid' };
    const recordBase = {
      createdAt: nowMs,
      expiresAt: nowMs + getAccessSessionMaxAgeSec(env) * 1000,
    };
    const token = await signedSessionToken(recordBase, env);
    if (!token) return { ok: false, code: 'store_unavailable' };
    return {
      ok: true,
      redemption: { inviteId: `env_${codeHash.slice(0, 16)}` },
      session: {
        token,
        record: {
          ...recordBase,
          sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, sha256Hex(`sonic-access-session-v1:${token}`)),
        },
      },
    };
  }

  // A durable repository must redeem and persist the session atomically.
  if (typeof repository.redeemInviteAndCreateSession !== 'function') {
    return { ok: false, code: 'store_unavailable' };
  }
  const token = randomOpaqueToken();
  const hash = hashSessionToken(token);
  if (!hash) return { ok: false, code: 'store_unavailable' };
  const record: AccessSessionRecord = {
    sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash),
    createdAt: nowMs,
    expiresAt: nowMs + getAccessSessionMaxAgeSec(env) * 1000,
  };
  try {
    const redemption = await repository.redeemInviteAndCreateSession(
      getStoreKey(ACCESS_INVITE_HASH_PREFIX, codeHash),
      record,
      nowMs,
    );
    return redemption
      ? { ok: true, redemption, session: { token, record } }
      : { ok: false, code: 'invalid' };
  } catch {
    return { ok: false, code: 'store_unavailable' };
  }
}

export async function createAccessSession(
  env: AppEnv,
  nowMs = Date.now(),
  maxAgeSec = getAccessSessionMaxAgeSec(env),
): Promise<{ token: string; record: AccessSessionRecord } | null> {
  const repository = getAccessRepository(env);
  const recordBase = {
    createdAt: nowMs,
    expiresAt: nowMs + Math.min(MAX_ACCESS_SESSION_MAX_AGE_SEC, Math.max(MIN_ACCESS_SESSION_MAX_AGE_SEC, maxAgeSec * 1000)),
  };
  if (!repository) {
    try {
      const signed = await signedSessionToken(recordBase, env);
      if (!signed) return null;
      return {
        token: signed,
        record: { ...recordBase, sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, sha256Hex(`sonic-access-session-v1:${signed}`)) },
      };
    } catch {
      return null;
    }
  }
  const token = randomOpaqueToken();
  const hash = hashSessionToken(token);
  if (!hash) return null;
  const record: AccessSessionRecord = {
    sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash),
    ...recordBase,
  };
  try {
    if (repository) await repository.createSession(record);
    return { token, record };
  } catch {
    return null;
  }
}

export async function verifyAccessSession(
  request: Request,
  env: AppEnv,
  nowMs = Date.now(),
): Promise<AccessSessionResult> {
  const token = readAccessSessionToken(request);
  if (!token) return { valid: false, reason: 'missing' };
  const hash = hashSessionToken(token);
  const repository = getAccessRepository(env);
  if (!hash) return { valid: false, reason: 'invalid' };
  if (!repository) {
    const signed = await verifySignedSession(token, env, nowMs);
    return signed ? { valid: true, session: signed } : { valid: false, reason: 'store_unavailable' };
  }
  try {
    const session = await repository.getSession(getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash), nowMs);
    if (!session) return { valid: false, reason: 'invalid' };
    if (session.revokedAt && session.revokedAt <= nowMs) return { valid: false, reason: 'revoked' };
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= nowMs) return { valid: false, reason: 'expired' };
    return { valid: true, session };
  } catch {
    return { valid: false, reason: 'store_unavailable' };
  }
}

export async function revokeAccessSession(request: Request, env: AppEnv, nowMs = Date.now()): Promise<void> {
  const token = readAccessSessionToken(request);
  const hash = token ? hashSessionToken(token) : null;
  const repository = getAccessRepository(env);
  if (!hash || !repository?.revokeSession) return;
  try {
    await repository.revokeSession(getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash), nowMs);
  } catch {
    // Cookie clearing remains safe; the next request will fail closed if the store is unavailable.
  }
}

export function accessStatusResponse(request: Request, env: AppEnv): Response | null {
  const mode = getAccessMode(env);
  if (mode === 'open') return null;
  if (mode === 'legacy-staging') return null;
  return null;
}

export async function requireAccess(request: Request, env: AppEnv): Promise<Response | null> {
  const mode = getAccessMode(env);
  if (mode === 'open' || hasValidEngineSecret(request, env)) return null;
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const publicPath =
    path === '/api/access/session' ||
    path === '/api/access/invite' ||
    path === '/api/access/logout' ||
    path === '/api/access/status' ||
    path === '/api/access/redeem' ||
    path === '/api/auth/login' ||
    path === '/api/auth/callback' ||
    path === '/api/auth/logout' ||
    path === '/api/auth/user' ||
    (!path.startsWith('/api/') && path !== '/proxy' && path !== '/palette');
  if (publicPath) return null;
  if (mode === 'legacy-staging') return jsonResponse({ brand: 'Sonic', error: { code: 'STAGING_ACCESS_REQUIRED', message: 'Staging access is required' } }, { status: 401, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
  const status = await verifyAccessSession(request, env);
  if (status.valid) return null;
  return jsonResponse({ brand: 'Sonic', error: { code: status.reason === 'store_unavailable' ? 'ACCESS_STORE_UNAVAILABLE' : 'ACCESS_REQUIRED', message: 'Invite access is required' } }, { status: status.reason === 'store_unavailable' ? 503 : 401, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', ...(status.reason === 'store_unavailable' ? { 'Retry-After': '3' } : {}) } });
}

export function getAccessStoreKeyForTest(prefix: 'invite' | 'session', raw: string): string | null {
  if (prefix === 'invite') {
    const hash = hashInviteCode(raw);
    return hash ? getStoreKey(ACCESS_INVITE_HASH_PREFIX, hash) : null;
  }
  const hash = hashSessionToken(raw);
  return hash ? getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash) : null;
}

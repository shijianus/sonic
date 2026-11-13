// Sonic access control primitives.
// Invite eligibility is intentionally independent from OAuth/API-key identity.

import { base64UrlDecode, base64UrlEncode, readCookie, shouldUseSecureCookie } from '../auth';
import { jsonResponse } from '../http';
import { hasValidEngineSecret, canonicalPolicyPath, timingSafeEqualStr } from './security';
import { isCloudflarePages, isProductionDeployment } from './environment';
import { sha256Hex } from './crypto';
import { isEnvEnabled } from './config';
import { createDurableAccessRepository } from './access-do';
import type { AppEnv } from '../types';

export const SONIC_ACCESS_COOKIE = 'sonic_access';
// __Host- prefix (audit P1-6): the prefixed name is written on secure origins and
// both names are read/cleared during the migration window.
export const SONIC_ACCESS_COOKIE_HOST_PREFIXED = `__Host-${SONIC_ACCESS_COOKIE}`;
export const ACCESS_INVITE_HASH_PREFIX = 'sonic:access:invite:';
export const ACCESS_SESSION_HASH_PREFIX = 'sonic:access:session:';

export const DEFAULT_ACCESS_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;
export const MAX_ACCESS_SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const MIN_ACCESS_SESSION_MAX_AGE_SEC = 60;
const MAX_INVITE_CODE_LENGTH = 256;
// Invite codes are the only credential in Pages-only invite mode. Short codes
// are brute-forceable even behind the rate limiter, so reject them up front.
const MIN_INVITE_CODE_LENGTH = 16;
const MAX_ACCESS_SESSION_TOKEN_LENGTH = 512;
const ACCESS_TOKEN_DOMAIN = 'sonic-access-session-v1.';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type AccessMode = 'open' | 'legacy-staging' | 'invite';
const VALID_ACCESS_MODES = new Set<AccessMode>(['open', 'legacy-staging', 'invite']);

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
  redeemInviteAndCreateSession(codeHash: string, record: AccessSessionRecord, nowMs: number): Promise<InviteRedemption | null> | InviteRedemption | null;
  createSession?(record: AccessSessionRecord): Promise<void> | void;
  getSession(sessionHash: string, nowMs: number): Promise<AccessSessionRecord | null> | AccessSessionRecord | null;
  revokeSession(sessionHash: string, nowMs: number): Promise<void> | void;
  checkReady?(): Promise<void>;
}

export interface AccessSessionResult {
  valid: boolean;
  session?: AccessSessionRecord;
  reason?: 'missing' | 'invalid' | 'expired' | 'revoked' | 'store_unavailable';
}

export function getAccessMode(env?: AppEnv): AccessMode {
  const raw = String(env?.SONIC_ACCESS_MODE || '').trim().toLowerCase();
  if (raw === 'invite' || raw === 'legacy-staging' || raw === 'open') return raw;
  // Missing mode preserves the existing public deployment behavior.
  return 'open';
}

export function isAccessModeExplicit(env?: AppEnv): boolean {
  const raw = String(env?.SONIC_ACCESS_MODE || '').trim().toLowerCase();
  return VALID_ACCESS_MODES.has(raw as AccessMode);
}

export function isAccessModeDeclaredInvalid(env?: AppEnv): boolean {
  const raw = String(env?.SONIC_ACCESS_MODE || '').trim().toLowerCase();
  return Boolean(raw) && !VALID_ACCESS_MODES.has(raw as AccessMode);
}

export function getAccessSessionMaxAgeSec(env?: AppEnv): number {
  const raw = Number.parseInt(String(env?.SONIC_ACCESS_SESSION_MAX_AGE_SEC || ''), 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ACCESS_SESSION_MAX_AGE_SEC;
  return Math.min(MAX_ACCESS_SESSION_MAX_AGE_SEC, Math.max(MIN_ACCESS_SESSION_MAX_AGE_SEC, Math.floor(raw)));
}

export function isDurableInviteRequired(env?: AppEnv): boolean {
  return isEnvEnabled(env?.SONIC_REQUIRE_DURABLE_INVITES, false) ||
    (getAccessMode(env) === 'invite' && (isCloudflarePages(env) || env?.SONIC_RUNTIME === 'cf-pages') && isProductionDeployment(env));
}

function useDurableAccess(env?: AppEnv): boolean {
  return isDurableInviteRequired(env) || env?.SONIC_ACCESS_BUCKETS != null || env?.SONIC_ACCESS_STORE != null;
}

function getAccessRepository(env?: AppEnv): AccessRepository | null {
  if (env?.SONIC_ACCESS_BUCKETS != null) {
    return typeof env.SONIC_ACCESS_BUCKETS.getByName === 'function' ? createDurableAccessRepository(env.SONIC_ACCESS_BUCKETS) : null;
  }
  const candidate = env?.SONIC_ACCESS_STORE;
  return typeof candidate?.getSession === 'function' && typeof candidate?.redeemInviteAndCreateSession === 'function' &&
    typeof candidate?.revokeSession === 'function' ? candidate as AccessRepository : null;
}

function normalizeInviteCode(code: unknown): string {
  const value = typeof code === 'string' ? code.trim() : '';
  if (
    value.length < MIN_INVITE_CODE_LENGTH ||
    value.length > MAX_INVITE_CODE_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) return '';
  return value;
}

export function hashInviteCode(code: string): string | null {
  const normalized = normalizeInviteCode(code);
  return normalized ? sha256Hex(`sonic-access-invite-v1:${normalized}`) : null;
}

function configuredInviteCodes(env: AppEnv): string[] {
  return String(env.SONIC_INVITE_CODES || '').split(',').map(code => code.trim()).filter(Boolean);
}

function isConfiguredInviteHash(env: AppEnv, codeHash: string): boolean {
  let matched = false;
  for (const code of configuredInviteCodes(env)) {
    const configuredHash = hashInviteCode(code);
    if (configuredHash && timingSafeEqualStr(configuredHash, codeHash)) matched = true;
  }
  return matched;
}

export async function getAccessReadiness(env: AppEnv) {
  const mode = getAccessMode(env);
  const required = mode === 'invite';
  const invalid = isAccessModeDeclaredInvalid(env);
  const durableRequired = isDurableInviteRequired(env);
  const storeConfigured = env.SONIC_ACCESS_BUCKETS != null || env.SONIC_ACCESS_STORE != null;
  const repository = required ? getAccessRepository(env) : null;
  const codes = configuredInviteCodes(env);
  const validConfiguredInviteCodes = codes.filter(code => hashInviteCode(code) !== null).length;
  const invalidConfiguredInviteCodes = codes.length - validConfiguredInviteCodes;
  const secretConfigured = String(env.SONIC_ACCESS_SECRET || '').trim().length >= 32;
  let storeUsable = Boolean(repository);
  try { await repository?.checkReady?.(); } catch { storeUsable = false; }
  let backend = 'none';
  if (required && repository) backend = env.SONIC_ACCESS_BUCKETS ? 'durable-object' : 'runtime-store';
  else if (required && !useDurableAccess(env)) backend = 'signed-cookie';
  const inviteReady = invalidConfiguredInviteCodes === 0 && (
    backend === 'runtime-store' ? storeUsable : validConfiguredInviteCodes > 0 && (
      backend === 'durable-object' ? storeUsable : backend === 'signed-cookie' && secretConfigured
    )
  );
  const ok = !invalid && (required ? inviteReady : !durableRequired);
  return { mode, explicit: isAccessModeExplicit(env), invalid, required, durableRequired, backend,
    storeConfigured, storeUsable, singleUse: storeUsable, revocable: storeUsable, secretConfigured,
    configuredInviteCodes: codes.length, validConfiguredInviteCodes, invalidConfiguredInviteCodes, ok };
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

async function verifySignedSession(token: string, key: CryptoKey, nowMs: number): Promise<AccessSessionResult> {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'invalid' };
  try {
    const signature = base64UrlDecode(parts[1]);
    const signatureBuffer = signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer;
    const data = textEncoder.encode(ACCESS_TOKEN_DOMAIN + parts[0]);
    const dataBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const valid = await crypto.subtle.verify('HMAC', key, signatureBuffer, dataBuffer);
    if (!valid) return { valid: false, reason: 'invalid' };
    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(parts[0]))) as { v: number; iat: number; exp: number };
    if (payload.v !== 1 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp - payload.iat > MAX_ACCESS_SESSION_MAX_AGE_SEC * 1000) return { valid: false, reason: 'invalid' };
    if (payload.exp <= nowMs) return { valid: false, reason: 'expired' };
    return { valid: true, session: { sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, sha256Hex(`sonic-access-session-v1:${token}`)), createdAt: payload.iat, expiresAt: payload.exp } };
  } catch { return { valid: false, reason: 'invalid' }; }
}


function getStoreKey(prefix: string, hash: string): string {
  return `${prefix}${hash}`;
}

export function readAccessSessionToken(request: Request): string | undefined {
  const token = readCookie(request, SONIC_ACCESS_COOKIE_HOST_PREFIXED) ?? readCookie(request, SONIC_ACCESS_COOKIE);
  if (!token || token.length > MAX_ACCESS_SESSION_TOKEN_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(token)) return undefined;
  return token;
}

export function buildAccessSessionCookie(token: string, expiresAt: number, requestUrl: URL): string {
  const maxAge = Math.max(0, Math.min(MAX_ACCESS_SESSION_MAX_AGE_SEC, Math.floor((expiresAt - Date.now()) / 1000)));
  const secure = shouldUseSecureCookie(requestUrl);
  const secureAttr = secure ? '; Secure' : '';
  const name = secure ? SONIC_ACCESS_COOKIE_HOST_PREFIXED : SONIC_ACCESS_COOKIE;
  return `${name}=${encodeURIComponent(token)}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function buildClearAccessSessionCookie(requestUrl: URL): string[] {
  const secure = shouldUseSecureCookie(requestUrl);
  const secureAttr = secure ? '; Secure' : '';
  // Clear both names (independent Set-Cookie headers) so a legacy pre-__Host-
  // cookie cannot outlive logout.
  return [
    `${SONIC_ACCESS_COOKIE_HOST_PREFIXED}=; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${SONIC_ACCESS_COOKIE}=; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ];
}

export type AccessRedeemResult =
  | { ok: true; redemption: InviteRedemption; session: { token: string; record: AccessSessionRecord } }
  | { ok: false; code: 'invalid' | 'store_unavailable' }

export async function redeemAccessInvite(
  env: AppEnv,
  code: string,
  nowMs = Date.now(),
): Promise<AccessRedeemResult> {
  const codeHash = hashInviteCode(code);
  const repository = getAccessRepository(env);
  // A malformed/too-short code is just invalid; never disclose whether the
  // server has a durable access store.
  if (!codeHash) return { ok: false, code: 'invalid' };

  // Pages without a durable store use the independent signed-session path.
  if (!repository) {
    if (useDurableAccess(env)) return { ok: false, code: 'store_unavailable' };
    if (!isConfiguredInviteHash(env, codeHash)) return { ok: false, code: 'invalid' };
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

  // Pages verifies the configured secret locally. Only the digest is sent to the object.
  if (env.SONIC_ACCESS_BUCKETS && !isConfiguredInviteHash(env, codeHash)) return { ok: false, code: 'invalid' };
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
  const boundedMaxAgeSec = Math.min(
    MAX_ACCESS_SESSION_MAX_AGE_SEC,
    Math.max(MIN_ACCESS_SESSION_MAX_AGE_SEC, Math.floor(maxAgeSec)),
  );
  const recordBase = {
    createdAt: nowMs,
    expiresAt: nowMs + boundedMaxAgeSec * 1000,
  };
  if (!repository) {
    if (useDurableAccess(env)) return null;
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
  if (!repository.createSession) return null;
  const token = randomOpaqueToken();
  const hash = hashSessionToken(token);
  if (!hash) return null;
  const record: AccessSessionRecord = {
    sessionHash: getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash),
    ...recordBase,
  };
  try {
    await repository.createSession(record);
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
    if (useDurableAccess(env)) return { valid: false, reason: 'store_unavailable' };
    const key = await accessSecret(env).catch(() => null);
    return key ? verifySignedSession(token, key, nowMs) : { valid: false, reason: 'store_unavailable' };
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

export interface AccessSessionRevocation {
  /** True only when a durable store confirmed the revocation. */
  revoked: boolean;
  /** True when access requires durable revocation; only revoked confirms success. */
  durable: boolean;
  /** A token was present but durable revocation could not be confirmed. */
  unavailable: boolean;
}

export async function revokeAccessSession(
  request: Request,
  env: AppEnv,
  nowMs = Date.now(),
): Promise<AccessSessionRevocation> {
  const token = readAccessSessionToken(request);
  const hash = token ? hashSessionToken(token) : null;
  const repository = getAccessRepository(env);
  const durable = useDurableAccess(env);
  if (!hash || !repository) return { revoked: false, durable, unavailable: Boolean(hash && durable) };
  try {
    await repository.revokeSession(getStoreKey(ACCESS_SESSION_HASH_PREFIX, hash), nowMs);
    return { revoked: true, durable: true, unavailable: false };
  } catch {
    // Cookie clearing remains safe; the next request will fail closed if the store is unavailable.
    return { revoked: false, durable: true, unavailable: true };
  }
}

export async function requireAccess(request: Request, env: AppEnv): Promise<Response | null> {
  if (hasValidEngineSecret(request, env)) return null;
  // An explicitly configured but unknown mode is a typo, not an invitation to
  // fall back to public access. Reject it in every environment.
  if (isAccessModeDeclaredInvalid(env)) {
    return jsonResponse(
      { brand: 'Sonic', error: { code: 'ACCESS_MODE_INVALID', message: 'SONIC_ACCESS_MODE must be one of open, invite or legacy-staging' } },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Retry-After': '30' } },
    );
  }
  // A production edge deployment must state its access policy explicitly. A
  // missing variable previously fell back to public/open access, which would
  // silently remove the invite gate from a restricted beta.
  const mode = getAccessMode(env);
  if ((isProductionDeployment(env) && !isAccessModeExplicit(env)) || (isDurableInviteRequired(env) && mode !== 'invite')) {
    return jsonResponse(
      { brand: 'Sonic', error: { code: 'ACCESS_MODE_MISCONFIGURED', message: 'Production requires an explicit access mode; durable invitations require invite mode' } },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Retry-After': '30' } },
    );
  }
  if (mode === 'open') return null;
  const path = canonicalPolicyPath(request);
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
    (path !== '/api' && !path.startsWith('/api/') && path !== '/proxy' && path !== '/palette');
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

import type { AppEnv, UserSession } from './types';
import { sha256Hex } from './sonic/crypto';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getEpomailConfig(env: AppEnv, requestOrigin?: string) {
  const baseUrl = (env.EPOMAIL_BASE_URL || '').replace(/\/+$/, '');
  const clientId = env.EPOMAIL_CLIENT_ID ? String(env.EPOMAIL_CLIENT_ID).trim() : '';
  const clientSecret = env.EPOMAIL_CLIENT_SECRET ? String(env.EPOMAIL_CLIENT_SECRET).trim() : '';

  let redirectUri = env.EPOMAIL_REDIRECT_URI ? String(env.EPOMAIL_REDIRECT_URI).trim() : '';
  if (!redirectUri && requestOrigin) {
    const allowedOrigins = (env.SONIC_ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    const originLower = requestOrigin.toLowerCase();
    if (allowedOrigins.includes(originLower)) {
      redirectUri = `${requestOrigin}/api/auth/callback`;
    }
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    redirectUri,
    authorizeUrl: baseUrl ? `${baseUrl}/oauth/authorize` : '',
    tokenUrl: baseUrl ? `${baseUrl}/oauth/token` : '',
    userInfoUrl: baseUrl ? `${baseUrl}/oauth/userinfo` : '',
  };
}

export function buildAuthorizeUrl(
  env: AppEnv,
  origin: string,
  state: string,
  codeChallenge?: string,
): string {
  const config = getEpomailConfig(env, origin);
  if (!config.baseUrl || !config.clientId || !config.redirectUri) {
    throw new Error('OAuth configuration missing (EPOMAIL_BASE_URL, EPOMAIL_CLIENT_ID, or valid redirectUri)');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile email',
    state,
  });

  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  return `${config.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(
  env: AppEnv,
  origin: string,
  code: string,
  codeVerifier?: string,
): Promise<{ accessToken: string; idToken?: string }> {
  const config = getEpomailConfig(env, origin);
  if (!config.baseUrl || !config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error('OAuth configuration incomplete for token exchange');
  }

  const bodyPayload: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  };

  if (codeVerifier) {
    bodyPayload.code_verifier = codeVerifier;
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Sonic OAuth Error] Epomail token exchange failed (${response.status}): ${errorText}`);
    throw new Error('Epomail token exchange failed');
  }

  const data = (await response.json()) as { access_token: string; id_token?: string };
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
  };
}

export async function fetchUserInfo(
  env: AppEnv,
  accessToken: string,
): Promise<{ email: string; name: string; avatar: string; role?: string; id?: string }> {
  const config = getEpomailConfig(env);
  if (!config.userInfoUrl) {
    throw new Error('OAuth userInfo URL not configured');
  }

  const response = await fetch(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    console.error(`[Sonic OAuth Error] Epomail userInfo request failed (${response.status})`);
    throw new Error('Epomail userInfo request failed');
  }

  const user = (await response.json()) as Record<string, any>;
  return {
    id: String(user.id || user.sub || user.email || ''),
    email: String(user.email || '').trim().toLowerCase(),
    name: String(user.name || user.username || user.nickname || user.email || 'Epomail User'),
    avatar: String(user.avatar || user.picture || ''),
    role: String(user.role || 'user'),
  };
}

// ── Base64URL Helpers (UTF-8 safe) ──

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function stringToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export function base64UrlToString(str: string): string {
  return new TextDecoder().decode(base64UrlDecode(str));
}

// ── Versioned HMAC API Keys ──
//
// Format: sonic_live_v2.<headerB64url>.<payloadB64url>.<sigB64url>
// Header:  { alg: "HS256", typ: "sonic-api-key", v: 2, kid }
// Payload: { sub, iat, exp, jti, kid, role, uid }
// Signature: HMAC-SHA256 over "sonic_live_v2.<headerB64url>.<payloadB64url>"
//
// v1 keys (and the pre-v1 unsigned sonic_live_*/solara_live_* format) are intentionally
// rejected: they carry no iat/jti/kid and cannot participate in rotation or revocation.

const TOKEN_PREFIX = 'sonic_live_v2';
const TOKEN_VERSION = 2;
const TOKEN_TYPE = 'sonic-api-key';
const TOKEN_MAX_LENGTH = 8192;
const TOKEN_HEADER_MAX_BYTES = 512;
const TOKEN_PAYLOAD_MAX_BYTES = 4096;
const SIGNATURE_BYTES = 32;
const MAX_TOKEN_LIFETIME_SEC = 90 * 86400;
const CLOCK_SKEW_SEC = 120;
const KID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const JTI_REGEX = /^[A-Za-z0-9_-]{16,128}$/;
const UID_REGEX = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ROLE_REGEX = /^[A-Za-z0-9_-]{1,32}$/;

export interface AuthSigningKey {
  kid: string;
  secret: string;
}

export interface AuthKeyMaterial {
  primary: AuthSigningKey;
  previous?: AuthSigningKey;
  revokedJtis: Set<string>;
  revokedSubs: Set<string>;
  minIat: number;
}

export function deriveKeyId(secret: string): string {
  return `k_${sha256Hex(secret).slice(0, 12)}`;
}

function resolveKeyId(configured: unknown, secret: string): string {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return KID_REGEX.test(value) ? value : deriveKeyId(secret);
}

function parseCsvSet(raw: unknown, isValid: (value: string) => boolean, max: number): Set<string> {
  const result = new Set<string>();
  if (typeof raw !== 'string' || !raw.trim()) return result;
  for (const item of raw.split(',')) {
    const value = item.trim();
    if (!value || !isValid(value)) continue;
    result.add(value);
    if (result.size >= max) break;
  }
  return result;
}

export function getAuthSecrets(env: AppEnv): AuthKeyMaterial | null {
  const primarySecret = (env.SONIC_SECRET || env.SOLARA_SECRET || '').trim();
  if (primarySecret.length < 32) {
    return null;
  }

  const primary: AuthSigningKey = {
    kid: resolveKeyId(env.SONIC_SECRET_KID, primarySecret),
    secret: primarySecret,
  };

  const prevRaw = env.SONIC_SECRET_PREV ? String(env.SONIC_SECRET_PREV).trim() : '';
  const previous: AuthSigningKey | undefined =
    prevRaw.length >= 32 && prevRaw !== primarySecret
      ? {
          kid: resolveKeyId(env.SONIC_SECRET_PREV_KID, prevRaw),
          secret: prevRaw,
        }
      : undefined;

  const minIatRaw = parseInt(String(env.SONIC_TOKEN_MIN_IAT || '0'), 10);
  const minIat = Number.isFinite(minIatRaw) && minIatRaw > 0 ? Math.floor(minIatRaw) : 0;

  const revokedSubs = new Set(
    Array.from(
      parseCsvSet(env.SONIC_REVOKED_SUBS, (v) => v.length <= 254 && EMAIL_REGEX.test(v), 2048),
      (value) => value.toLowerCase(),
    ),
  );

  return {
    primary,
    previous,
    revokedJtis: parseCsvSet(env.SONIC_REVOKED_JTIS, (v) => JTI_REGEX.test(v), 2048),
    revokedSubs,
    minIat,
  };
}

function sanitizeRole(value: unknown): string {
  const role = typeof value === 'string' ? value.trim() : '';
  return ROLE_REGEX.test(role) ? role : 'user';
}

function sanitizeUid(value: unknown): string | undefined {
  const uid = typeof value === 'string' ? value.trim() : '';
  return UID_REGEX.test(uid) ? uid : undefined;
}

function deriveUserId(email: string): string {
  return `usr_${sha256Hex(`sonic-uid-v1:${email}`).slice(0, 16)}`;
}

function decodeTokenPart(input: string, maxBytes: number): Uint8Array | null {
  if (!input || input.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    const bytes = base64UrlDecode(input);
    if (bytes.byteLength > maxBytes || base64UrlEncode(bytes) !== input) return null;
    return bytes;
  } catch {
    return null;
  }
}

function decodeJsonPart(input: string, maxBytes: number): Record<string, any> | null {
  const bytes = decodeTokenPart(input, maxBytes);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface ParsedApiKey {
  headerB64: string;
  payloadB64: string;
  header: Record<string, any>;
  payload: Record<string, any>;
  signature: Uint8Array;
}

function parseApiKey(apiKey: string): ParsedApiKey | null {
  if (!apiKey || apiKey.length > TOKEN_MAX_LENGTH) return null;
  if (!apiKey.startsWith(`${TOKEN_PREFIX}.`)) return null;

  const parts = apiKey.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;

  const [, headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const header = decodeJsonPart(headerB64, TOKEN_HEADER_MAX_BYTES);
  const payload = decodeJsonPart(payloadB64, TOKEN_PAYLOAD_MAX_BYTES);
  const signature = decodeTokenPart(sigB64, SIGNATURE_BYTES);
  if (!header || !payload || !signature || signature.byteLength !== SIGNATURE_BYTES) return null;

  if (header.v !== TOKEN_VERSION || header.alg !== 'HS256' || header.typ !== TOKEN_TYPE) return null;
  if (typeof header.kid !== 'string' || !KID_REGEX.test(header.kid)) return null;
  if (typeof payload.kid !== 'string' || payload.kid !== header.kid) return null;
  if (typeof payload.sub !== 'string' || !EMAIL_REGEX.test(payload.sub)) return null;
  if (typeof payload.jti !== 'string' || !JTI_REGEX.test(payload.jti)) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) return null;

  return { headerB64, payloadB64, header, payload, signature };
}

async function signHmac(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as any));
}

async function verifyHmac(secret: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // crypto.subtle.verify performs a constant-time comparison internally.
  return crypto.subtle.verify('HMAC', key, signature as any, data as any);
}

let warnedMissingSecret = false;

export async function createSession(
  env: AppEnv,
  userInfo: { email: string; name: string; avatar: string; role?: string; id?: string },
): Promise<UserSession> {
  const secrets = getAuthSecrets(env);
  if (!secrets) {
    console.error(
      '[Sonic Auth] Cannot issue API Key: SONIC_SECRET / SOLARA_SECRET is missing or shorter than 32 characters',
    );
    throw new Error('SONIC_SECRET is not configured or shorter than 32 characters');
  }

  const email = String(userInfo.email || '').trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    throw new Error('Invalid email format for user session');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 30 * 86400;
  const jti = crypto.randomUUID();
  const role = sanitizeRole(userInfo.role);
  const uid = sanitizeUid(userInfo.id) || deriveUserId(email);

  const headerObj = {
    alg: 'HS256',
    typ: TOKEN_TYPE,
    v: TOKEN_VERSION,
    kid: secrets.primary.kid,
  };
  const payloadObj = {
    sub: email,
    iat: nowSec,
    exp: expSec,
    jti,
    kid: secrets.primary.kid,
    role,
    uid,
  };

  const headerB64url = stringToBase64Url(JSON.stringify(headerObj));
  const payloadB64url = stringToBase64Url(JSON.stringify(payloadObj));
  const signingInput = new TextEncoder().encode(
    `${TOKEN_PREFIX}.${headerB64url}.${payloadB64url}`,
  );
  const signature = await signHmac(secrets.primary.secret, signingInput);
  const apiKey = `${TOKEN_PREFIX}.${headerB64url}.${payloadB64url}.${base64UrlEncode(signature)}`;

  return {
    id: uid,
    email,
    name: userInfo.name || email.split('@')[0],
    avatar: userInfo.avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(email)}`,
    role,
    apiKey,
    createdAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

export function extractAuthCredentials(request: Request): { token?: string; apiKey?: string } {
  const headerKey =
    request.headers.get('x-sonic-key') ||
    request.headers.get('x-cfsolara-key') ||
    request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization') || '';

  let bearerToken: string | undefined;
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.substring(7).trim();
  }

  // API keys are never accepted from the URL query string: query strings leak into
  // access logs, browser history, Referer headers and CDN caches.
  return {
    token: bearerToken,
    apiKey: headerKey?.trim() || bearerToken || undefined,
  };
}

export async function verifyAuth(
  request: Request,
  env: AppEnv,
): Promise<{ authenticated: boolean; user?: UserSession; isRateLimited?: boolean }> {
  const { apiKey } = extractAuthCredentials(request);
  if (!apiKey) {
    return { authenticated: false };
  }

  const secrets = getAuthSecrets(env);
  if (!secrets) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.error(
        '[Sonic Auth] SONIC_SECRET / SOLARA_SECRET is missing or shorter than 32 characters; rejecting authentication (fail closed)',
      );
    }
    return { authenticated: false };
  }

  const parsed = parseApiKey(apiKey);
  if (!parsed) {
    return { authenticated: false };
  }

  const candidates = [secrets.primary, secrets.previous].filter(
    (key): key is AuthSigningKey => Boolean(key) && key!.kid === parsed.header.kid,
  );
  if (candidates.length === 0) {
    return { authenticated: false };
  }

  const signingInput = new TextEncoder().encode(
    `${TOKEN_PREFIX}.${parsed.headerB64}.${parsed.payloadB64}`,
  );

  let signatureValid = false;
  try {
    for (const candidate of candidates) {
      if (await verifyHmac(candidate.secret, signingInput, parsed.signature)) {
        signatureValid = true;
        break;
      }
    }
  } catch {
    return { authenticated: false };
  }

  if (!signatureValid) {
    return { authenticated: false };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const { payload } = parsed;
  if (payload.exp <= nowSec) return { authenticated: false };
  if (payload.iat > nowSec + CLOCK_SKEW_SEC) return { authenticated: false };
  if (payload.exp <= payload.iat) return { authenticated: false };
  if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SEC) return { authenticated: false };
  if (secrets.minIat > 0 && payload.iat < secrets.minIat) return { authenticated: false };

  const email = payload.sub.trim().toLowerCase();
  if (secrets.revokedSubs.has(email)) return { authenticated: false };
  if (secrets.revokedJtis.has(payload.jti)) return { authenticated: false };

  const uid = sanitizeUid(payload.uid) || deriveUserId(email);

  return {
    authenticated: true,
    user: {
      id: uid,
      email,
      name: email.split('@')[0],
      avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(email)}`,
      role: sanitizeRole(payload.role),
      apiKey,
      createdAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
  };
}

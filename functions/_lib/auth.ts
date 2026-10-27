import type { AppEnv, UserSession } from './types';
import { isEnvEnabled } from './sonic/config';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_SESSION_TTL_SEC = 90 * 86400;
export const MIN_SIGNING_SECRET_LENGTH = 32;

const API_KEY_PREFIX = 'sonic_live_v1';
const API_KEY_MAX_LENGTH = 4096;
const PAYLOAD_MAX_B64_LENGTH = 2048;
const CLOCK_SKEW_SEC = 300;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const SUB_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const CODE_VERIFIER_REGEX = /^[A-Za-z0-9_-]{43,128}$/;

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function parseHttpsOrigin(value: string): string | null {
  const url = parseHttpsUrl(value);
  if (!url) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

function getAllowedOrigins(env: AppEnv): string[] {
  return String(env.SONIC_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => parseHttpsOrigin(origin.trim()))
    .filter((origin): origin is string => Boolean(origin));
}

export function getEpomailConfig(env: AppEnv, requestOrigin?: string) {
  const rawBaseUrl = String(env.EPOMAIL_BASE_URL || '').trim().replace(/\/+$/, '');
  const parsedBaseUrl = rawBaseUrl ? parseHttpsUrl(rawBaseUrl) : null;
  const baseUrl = parsedBaseUrl ? parsedBaseUrl.toString().replace(/\/+$/, '') : '';
  const clientId = env.EPOMAIL_CLIENT_ID ? String(env.EPOMAIL_CLIENT_ID).trim() : '';
  const clientSecret = env.EPOMAIL_CLIENT_SECRET ? String(env.EPOMAIL_CLIENT_SECRET).trim() : '';
  const allowedOrigins = getAllowedOrigins(env);

  let redirectUri = '';
  if (env.EPOMAIL_REDIRECT_URI) {
    const configured = parseHttpsUrl(String(env.EPOMAIL_REDIRECT_URI).trim());
    if (configured && (allowedOrigins.length === 0 || allowedOrigins.includes(configured.origin))) {
      redirectUri = configured.toString();
    }
  } else if (requestOrigin) {
    const origin = parseHttpsOrigin(requestOrigin);
    if (origin && allowedOrigins.includes(origin)) {
      redirectUri = `${origin}/api/auth/callback`;
    }
  }

  return {
    baseUrl,
    clientId,
    clientSecret,
    redirectUri,
    allowedOrigins,
    authorizeUrl: baseUrl ? `${baseUrl}/oauth/authorize` : '',
    tokenUrl: baseUrl ? `${baseUrl}/oauth/token` : '',
    userInfoUrl: baseUrl ? `${baseUrl}/oauth/userinfo` : '',
  };
}

export function buildAuthorizeUrl(
  env: AppEnv,
  origin: string,
  state: string,
  codeChallenge: string,
): string {
  if (!state || state.length < 32 || !BASE64URL_REGEX.test(state)) {
    throw new Error('OAuth state must be a cryptographically random base64url value');
  }
  if (!codeChallenge || codeChallenge.length !== 43 || !BASE64URL_REGEX.test(codeChallenge)) {
    throw new Error('OAuth PKCE code_challenge is required');
  }

  const config = getEpomailConfig(env, origin);
  if (!config.baseUrl || !config.clientId || !config.redirectUri) {
    throw new Error('OAuth configuration missing (EPOMAIL_BASE_URL, EPOMAIL_CLIENT_ID, or valid redirectUri)');
  }
  if (!parseHttpsOrigin(config.baseUrl)) {
    throw new Error('EPOMAIL_BASE_URL must be an absolute https URL');
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return `${config.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(
  env: AppEnv,
  origin: string,
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; idToken?: string }> {
  if (!code || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error('Invalid OAuth authorization code');
  }
  if (!CODE_VERIFIER_REGEX.test(codeVerifier || '')) {
    throw new Error('Invalid OAuth PKCE code_verifier');
  }

  const config = getEpomailConfig(env, origin);
  if (!config.baseUrl || !config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error('OAuth configuration incomplete for token exchange');
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error(`[Sonic OAuth Error] Epomail token exchange failed (${response.status})`);
    throw new Error('Epomail token exchange failed');
  }

  const data = (await response.json()) as unknown;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid Epomail token response');
  }
  const record = data as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || !record.access_token || record.access_token.length > 4096) {
    throw new Error('Invalid access_token in Epomail response');
  }
  return {
    accessToken: record.access_token,
    idToken: typeof record.id_token === 'string' ? record.id_token : undefined,
  };
}

export interface TrustedUserInfo {
  sub: string;
  email: string;
  name: string;
  avatar: string;
}

export async function fetchUserInfo(env: AppEnv, accessToken: string): Promise<TrustedUserInfo> {
  const config = getEpomailConfig(env);
  if (!config.userInfoUrl) {
    throw new Error('OAuth userInfo URL not configured');
  }
  if (!accessToken || accessToken.length > 4096) {
    throw new Error('Invalid access token');
  }

  const response = await fetch(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error(`[Sonic OAuth Error] Epomail userInfo request failed (${response.status})`);
    throw new Error('Epomail userInfo request failed');
  }

  const user = (await response.json()) as unknown;
  if (!user || typeof user !== 'object') {
    throw new Error('Invalid Epomail userInfo response');
  }
  const record = user as Record<string, unknown>;
  const email = String(record.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    throw new Error('Epomail userInfo did not contain a valid email');
  }

  const rawSub = record.sub ?? record.id ?? email;
  const sub = String(rawSub).trim();
  if (!SUB_REGEX.test(sub)) {
    throw new Error('Epomail userInfo did not contain a valid stable subject');
  }

  const rawName = String(record.name || record.username || record.nickname || email.split('@')[0]);
  const name = rawName.slice(0, 128);

  return {
    sub,
    email,
    name,
    avatar: normalizeAvatarUrl(record.avatar ?? record.picture),
  };
}

function normalizeAvatarUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = parseHttpsUrl(value.trim());
  return url ? url.toString() : '';
}

// ── Base64URL Helpers (UTF-8 safe) ──

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_REGEX.test(str)) {
    throw new Error('Invalid base64url input');
  }
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function stringToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export function base64UrlToString(str: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(str));
}

export function getAuthSecrets(env: AppEnv): { primary: string; prev?: string } | null {
  const primary = String(env.SONIC_SECRET || '').trim();
  if (primary.length < MIN_SIGNING_SECRET_LENGTH) {
    return null;
  }
  const rawPrev = String(env.SONIC_SECRET_PREV || '').trim();
  const prev = rawPrev.length >= MIN_SIGNING_SECRET_LENGTH ? rawPrev : undefined;
  return { primary, prev };
}

async function importHmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function createSession(env: AppEnv, userInfo: TrustedUserInfo): Promise<UserSession> {
  const secrets = getAuthSecrets(env);
  if (!secrets) {
    console.error(
      '[Sonic Auth] Cannot issue API Key: SONIC_SECRET is missing or shorter than 32 characters',
    );
    throw new Error('SONIC_SECRET is not configured or shorter than 32 characters');
  }

  const email = String(userInfo.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_REGEX.test(email)) {
    throw new Error('Invalid email format for user session');
  }
  const sub = String(userInfo.sub || '').trim();
  if (!SUB_REGEX.test(sub)) {
    throw new Error('Invalid stable subject for user session');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + 30 * 86400;
  const payloadB64url = stringToBase64Url(
    JSON.stringify({ v: 1, sub, email, iat: nowSec, exp: expSec }),
  );
  const dataToSign = `v1.${payloadB64url}`;
  const cryptoKey = await importHmacKey(secrets.primary, 'sign');
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(dataToSign));
  const sigB64url = base64UrlEncode(new Uint8Array(signatureBuffer));

  const apiKey = `${API_KEY_PREFIX}.${payloadB64url}.${sigB64url}`;
  const displayName = String(userInfo.name || email.split('@')[0]).slice(0, 128);
  const avatar = normalizeAvatarUrl(userInfo.avatar)
    || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(email)}`;

  return {
    id: sub,
    email,
    name: displayName,
    avatar,
    role: 'user',
    apiKey,
    createdAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

export function extractAuthCredentials(
  request: Request,
  env?: AppEnv,
): { token?: string; apiKey?: string } {
  const url = new URL(request.url);
  const allowQueryKey = isEnvEnabled(env?.SONIC_ALLOW_QUERY_KEY, false);
  const queryKey = allowQueryKey
    ? url.searchParams.get('api_key') || url.searchParams.get('key')
    : null;

  const headerKey =
    request.headers.get('x-sonic-key') ||
    request.headers.get('x-cfsolara-key') ||
    request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization') || '';

  let bearerToken: string | undefined;
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.substring(7).trim();
  }

  const apiKey = headerKey?.trim() || bearerToken || queryKey?.trim() || undefined;

  return {
    token: bearerToken,
    apiKey,
  };
}

function isValidPayload(payload: unknown, nowSec: number): payload is {
  v: 1;
  sub: string;
  email: string;
  iat: number;
  exp: number;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  if (record.v !== 1) return false;
  if (typeof record.sub !== 'string' || !SUB_REGEX.test(record.sub)) return false;
  if (
    typeof record.email !== 'string'
    || record.email.length > 254
    || !EMAIL_REGEX.test(record.email)
  ) return false;
  if (!Number.isInteger(record.iat) || !Number.isInteger(record.exp)) return false;
  const iat = record.iat as number;
  const exp = record.exp as number;
  if (iat < 0 || exp <= iat) return false;
  if (exp - iat > MAX_SESSION_TTL_SEC) return false;
  if (iat > nowSec + CLOCK_SKEW_SEC) return false;
  if (exp <= nowSec) return false;
  return true;
}

export async function verifyAuth(
  request: Request,
  env: AppEnv,
): Promise<{ authenticated: boolean; user?: UserSession; isRateLimited?: boolean }> {
  const { apiKey } = extractAuthCredentials(request, env);
  if (!apiKey) {
    return { authenticated: false };
  }
  if (apiKey.length > API_KEY_MAX_LENGTH) {
    return { authenticated: false };
  }

  const secrets = getAuthSecrets(env);
  if (!secrets) {
    console.error(
      '[Sonic Auth] SONIC_SECRET is missing or shorter than 32 characters; rejecting authentication (fail closed)',
    );
    return { authenticated: false };
  }

  const parts = apiKey.split('.');
  if (parts.length !== 3 || parts[0] !== API_KEY_PREFIX) {
    return { authenticated: false };
  }

  const [, payloadB64url, sigB64url] = parts;
  if (
    !BASE64URL_REGEX.test(payloadB64url)
    || !BASE64URL_REGEX.test(sigB64url)
    || payloadB64url.length > PAYLOAD_MAX_B64_LENGTH
    || sigB64url.length !== 43
  ) {
    return { authenticated: false };
  }

  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = base64UrlDecode(sigB64url);
  } catch {
    return { authenticated: false };
  }
  if (sigBytes.length !== 32) {
    return { authenticated: false };
  }

  const dataToVerify = new TextEncoder().encode(`v1.${payloadB64url}`);
  let isValid = false;
  try {
    const primaryKey = await importHmacKey(secrets.primary, 'verify');
    isValid = await crypto.subtle.verify('HMAC', primaryKey, sigBytes, dataToVerify);
    if (!isValid && secrets.prev) {
      const prevKey = await importHmacKey(secrets.prev, 'verify');
      isValid = await crypto.subtle.verify('HMAC', prevKey, sigBytes, dataToVerify);
    }
  } catch {
    return { authenticated: false };
  }
  if (!isValid) {
    return { authenticated: false };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlToString(payloadB64url));
  } catch {
    return { authenticated: false };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!isValidPayload(payload, nowSec)) {
    return { authenticated: false };
  }

  const email = payload.email.toLowerCase();
  const user: UserSession = {
    id: payload.sub,
    email,
    name: email.split('@')[0],
    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(email)}`,
    role: 'user',
    apiKey,
    createdAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };

  return { authenticated: true, user };
}

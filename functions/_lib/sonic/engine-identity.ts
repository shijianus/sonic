import type { AppEnv } from '../types';
import type { UserIdentityContext } from './recommend/types';
import { base64UrlDecode, base64UrlEncode } from '../auth';
import { getSonicConfig, isEnvEnabled } from './config';
import { hasValidEngineSecret } from './security';

export const ENGINE_IDENTITY_HEADER = 'X-Sonic-Verified-Identity';
export const ENGINE_IDENTITY_REQUIRED_HEADER = 'X-Sonic-Identity-Required';
const DOMAIN = 'sonic-engine-identity-v1.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface IdentityAssertion {
  v: 1;
  sub: string | null;
  mode: 'authenticated' | 'anonymous-opt-in' | 'public';
  consent: boolean;
  // Account authorization is NOT personalization consent. Never sent to recommendation routes.
  accountSub?: string;
  method: string;
  path: string;
  iat: number;
  exp: number;
}

export class EngineIdentityError extends Error {
  readonly code = 'ENGINE_IDENTITY_UNAVAILABLE';
  constructor() {
    super('Verified inter-service identity is unavailable');
    this.name = 'EngineIdentityError';
  }
}

async function keyFor(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

function isAcceptableSecret(secret: string, env?: AppEnv): boolean {
  const reused = [env?.SONIC_ENGINE_SECRET, env?.SONIC_SECRET, env?.SOLARA_SECRET, env?.SONIC_SECRET_PREV]
    .some(value => Boolean(value) && String(value).trim() === secret);
  return secret.length >= 32 && !reused;
}

function secretFor(env?: AppEnv): string | undefined {
  const secret = String(env?.SONIC_ENGINE_IDENTITY_SECRET || '').trim();
  return isAcceptableSecret(secret, env) ? secret : undefined;
}

/**
 * Rotation window key (audit P1-4). During a rolling Pages/Engine deploy the old
 * identity secret may still sign in-flight assertions; the previous value is
 * accepted for verification only and never used for signing.
 */
function previousSecretFor(env?: AppEnv): string | undefined {
  const secret = String(env?.SONIC_ENGINE_IDENTITY_SECRET_PREV || '').trim();
  if (!isAcceptableSecret(secret, env)) return undefined;
  if (secret === secretFor(env)) return undefined;
  return secret;
}

export function getEngineIdentityReadiness(env?: AppEnv) {
  const config = getSonicConfig(env);
  const productionHop = String(env?.SONIC_ENV || '').trim().toLowerCase() === 'production' &&
    (config.runtime === 'linux-engine' || config.enableLocalEngine);
  const required = productionHop || isEnvEnabled(env?.SONIC_REQUIRE_ENGINE_IDENTITY, false);
  const configured = Boolean(secretFor(env));
  const previousConfigured = Boolean(previousSecretFor(env));
  const invalid = Boolean(String(env?.SONIC_ENGINE_IDENTITY_SECRET || '').trim()) && !configured;
  return { required, configured, previousConfigured, ok: !invalid && (!required || configured) };
}

function pathFor(value: string): string {
  const url = new URL(value, 'https://engine.internal');
  return `${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
}

export async function issueEngineIdentity(
  identity: UserIdentityContext,
  method: string,
  path: string,
  env?: AppEnv,
  nowMs = Date.now(),
  accountSubject?: string | null,
): Promise<string | null> {
  const secret = secretFor(env);
  if (!secret) return null;
  const consent = Boolean(identity.subjectKey && identity.personalizationEnabled && identity.mode !== 'public');
  if (accountSubject && (!isAccountIdentityPath(path) || !/^usr_[a-f0-9]{24,64}$/.test(accountSubject))) throw new EngineIdentityError();
  const now = Math.floor(nowMs / 1000);
  const payload: IdentityAssertion = {
    v: 1, sub: consent ? identity.subjectKey : null, mode: consent ? identity.mode : 'public', consent,
    method: method.toUpperCase(), path: pathFor(path), iat: now, exp: now + 30,
    ...(accountSubject ? { accountSub: accountSubject } : {}),
  };
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret, 'sign'), encoder.encode(DOMAIN + encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export function isAccountIdentityPath(path: string): boolean {
  const pathname = new URL(path, 'https://engine.internal').pathname;
  return pathname.startsWith('/api/account/') || pathname === '/api/sonic/recommend/radar-album';
}

async function verifyAssertion(request: Request, env?: AppEnv, nowMs = Date.now()): Promise<IdentityAssertion | null> {
  const secret = secretFor(env);
  const previousSecret = previousSecretFor(env);
  if ((!secret && !previousSecret) || env?.SONIC_RUNTIME !== 'linux-engine' || !hasValidEngineSecret(request, env)) return null;
  const assertion = request.headers.get(ENGINE_IDENTITY_HEADER) || '';
  if (!assertion || assertion.length > 2048) return null;
  try {
    const parts = assertion.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[a-zA-Z0-9_-]+$/.test(part))) return null;
    const signature = base64UrlDecode(parts[1]);
    if (signature.byteLength !== 32 || base64UrlEncode(signature) !== parts[1]) return null;
    const signedPayload = encoder.encode(DOMAIN + parts[0]);
    // The primary key signs; the previous key only verifies in-flight assertions
    // from before a rotation, so the rolling window never breaks inter-service calls.
    const verified = (secret && await crypto.subtle.verify('HMAC', await keyFor(secret, 'verify'), new Uint8Array(signature), signedPayload)) ||
      (previousSecret && await crypto.subtle.verify('HMAC', await keyFor(previousSecret, 'verify'), new Uint8Array(signature), signedPayload));
    if (!verified) return null;
    const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[0]))) as IdentityAssertion;
    const now = Math.floor(nowMs / 1000);
    if (payload.v !== 1 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now + 5 || payload.exp <= now || payload.exp - payload.iat > 30 || payload.iat > payload.exp) return null;
    if (payload.method !== request.method || payload.path !== pathFor(request.url)) return null;
    if (payload.accountSub !== undefined && (!isAccountIdentityPath(request.url) || typeof payload.accountSub !== 'string' || !/^usr_[a-f0-9]{24,64}$/.test(payload.accountSub))) return null;
    if (payload.mode === 'public') {
      if (payload.consent !== false || payload.sub !== null) return null;
      return payload;
    }
    if (payload.consent !== true || typeof payload.sub !== 'string' || !/^(?:usr|anon)_[a-f0-9]{16,64}$/.test(payload.sub) || !['authenticated', 'anonymous-opt-in'].includes(payload.mode)) return null;
    if ((payload.mode === 'authenticated') !== payload.sub.startsWith('usr_')) return null;
    return payload;
  } catch { return null; }
}

export async function verifyEngineIdentity(request: Request, env?: AppEnv, nowMs = Date.now()): Promise<UserIdentityContext | null> {
  const payload = await verifyAssertion(request, env, nowMs);
  if (!payload) return null;
  return {
    mode: payload.mode, subjectKey: payload.sub, personalizationEnabled: payload.consent,
    isAuthenticated: payload.mode === 'authenticated',
  };
}

export async function verifyEngineAccountSubject(request: Request, env?: AppEnv): Promise<string | null> {
  if (!isAccountIdentityPath(request.url)) return null;
  const payload = await verifyAssertion(request, env);
  // Older recommendation-only assertions do not grant account-library access.
  return payload?.accountSub || null;
}

export async function requireValidEngineIdentity(request: Request, env?: AppEnv): Promise<UserIdentityContext | null> {
  if (env?.SONIC_RUNTIME !== 'linux-engine') return null;
  const presented = request.headers.has(ENGINE_IDENTITY_HEADER) || request.headers.has(ENGINE_IDENTITY_REQUIRED_HEADER);
  const personalized = ['authorization', 'x-sonic-key', 'x-cfsolara-key', 'x-api-key', 'x-sonic-anon-id', 'x-sonic-context']
    .some(header => Boolean(request.headers.get(header))) || /(?:^|;\s*)(?:__Host-)?sonic_session=/.test(request.headers.get('cookie') || '');
  if (!presented && !(getEngineIdentityReadiness(env).required && personalized)) return null;
  const identity = await verifyEngineIdentity(request, env);
  if (!identity) throw new EngineIdentityError();
  return identity;
}

export async function checkEngineIdentityAccess(request: Request, env?: AppEnv): Promise<Response | null> {
  try {
    await requireValidEngineIdentity(request, env);
    return null;
  } catch (error) {
    if (!(error instanceof EngineIdentityError)) throw error;
    return new Response(JSON.stringify({
      brand: 'Sonic', error: { code: error.code, message: error.message },
      meta: { degraded: true, retryable: true },
    }), { status: 503, headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'Retry-After': '3', 'X-Sonic-Degraded': '1',
    } });
  }
}

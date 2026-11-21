import { handleOptions, jsonResponse } from '../../_lib/http';
import type { AppEnv } from '../../_lib/types';
import { resolveAuthenticatedSubject } from '../../_lib/sonic/authenticated-subject';
import { isSourceEnabledByPolicy, normalizeSourceId } from '../../_lib/sonic/licensing';
import { guardGatewayRequest, readBoundedRequestBody } from '../../_lib/sonic/route-helpers';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization, Origin' };
const context = new TextEncoder().encode('EpoCanvasSonic offline license v1');
const supported = new Set(['netease', 'qq', 'kugou', 'kuwo', 'synthetic']);
type License = { source: string; tier: number; key: string };

function reply(status: number, body: object) { return jsonResponse(body, { status, headers }); }
function error(status: number, code: string) { return reply(status, { error: { code } }); }

function encode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function decode(data: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function master(value: unknown): Promise<CryptoKey | null> {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) return null;
  const bytes = Uint8Array.from(value.match(/../g)!, hex => parseInt(hex, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function permitted(source: string, list: unknown, env: AppEnv): boolean {
  const sources = String(list ?? 'synthetic').split(',').map(s => normalizeSourceId(s.trim()));
  return supported.has(source) && sources.includes(source) && isSourceEnabledByPolicy(source, env);
}
async function open(ticket: string, env: AppEnv, current: CryptoKey): Promise<License | null> {
  if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{50,400}$/.test(ticket)) return null;
  const [nonce, sealed] = ticket.split('.');
  for (const key of [current, await master(env.SONIC_ECS_MASTER_KEY_PREV)]) {
    if (!key) continue;
    try {
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(nonce), additionalData: context }, key, decode(sealed));
      const data: License = JSON.parse(new TextDecoder().decode(bytes));
      if (supported.has(data.source) && [1, 2, 3].includes(data.tier) && /^[\w-]{43}$/.test(data.key)) return data;
    } catch { /* Try the preceding deployment key during rotation. */ }
  }
  return null;
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
  const origin = request.headers.get('Origin');
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)) {
    return error(403, 'ORIGIN_NOT_PERMITTED');
  }
  const denied = await guardGatewayRequest(request, env, 'music-ecs');
  if (denied) return denied;
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'JSON_REQUIRED');
  const body = await readBoundedRequestBody(request, 2048);
  if (body.ok === false) return error(body.reason === 'too_large' ? 413 : 400, 'INVALID_ECS_REQUEST');
  let input;
  try { input = JSON.parse(body.text); } catch { return error(400, 'INVALID_JSON'); }
  if (!input || !['issue', 'play', 'export'].includes(input.action)) return error(400, 'INVALID_ECS_ACTION');
  if (input.action === 'export') {
    if (!await resolveAuthenticatedSubject(request, env)) return error(401, 'ACCOUNT_REQUIRED');
    if (!['original', 'high', 'standard'].includes(input.target)) return error(400, 'INVALID_EXPORT_TARGET');
  }
  const key = await master(env.SONIC_ECS_MASTER_KEY);
  if (!key) return error(503, 'ECS_KEY_NOT_CONFIGURED');
  if (input.action === 'issue') {
    if (typeof input.source !== 'string' || ![1, 2, 3].includes(input.tier)) return error(400, 'INVALID_ECS_METADATA');
    const source = normalizeSourceId(input.source);
    if (!permitted(source, env.SONIC_ECS_DOWNLOAD_SOURCES, env)) return error(403, 'DOWNLOAD_NOT_PERMITTED');
    const license: License = { source, tier: input.tier, key: encode(crypto.getRandomValues(new Uint8Array(32))) };
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: context }, key, new TextEncoder().encode(JSON.stringify(license)));
    return reply(200, { ticket: encode(nonce) + '.' + encode(new Uint8Array(sealed)), ...license });
  }
  const license = typeof input.ticket === 'string' && await open(input.ticket, env, key);
  if (!license) return error(400, 'INVALID_ECS_LICENSE');
  if (!permitted(license.source, env.SONIC_ECS_DOWNLOAD_SOURCES, env)) return error(403, 'DOWNLOAD_NOT_PERMITTED');
  if (input.action === 'export' && !permitted(license.source, env.SONIC_ECS_EXPORT_SOURCES, env)) return error(403, 'EXPORT_NOT_PERMITTED');
  if (input.action === 'export' && input.target === 'high' && license.tier === 3) {
    return error(403, 'ECS_HIGHER_QUALITY_UNAVAILABLE');
  }
  return reply(200, license);
}

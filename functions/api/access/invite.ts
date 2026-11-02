import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateGatewayRateLimit,
} from '../../_lib/sonic/security';
import {
  buildAccessSessionCookie,
  createAccessSession,
  getAccessMode,
  redeemAccessInvite,
} from '../../_lib/sonic/access';
import type { AppEnv } from '../../_lib/types';

const MAX_BODY_BYTES = 4096;
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
};

async function readInviteCode(request: Request): Promise<string> {
  const length = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return '';
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return '';
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return typeof payload.code === 'string' ? payload.code : typeof payload.invite === 'string' ? payload.invite : '';
  } catch {
    return '';
  }
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405);
  const rl = await evaluateGatewayRateLimit(request, env, 'access-invite');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);
  if (getAccessMode(env) !== 'invite') {
    return jsonResponse(
      { brand: 'Sonic', ok: false, error: { code: 'ACCESS_MODE_NOT_INVITE', message: 'Invite access is not enabled' } },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }

  const code = await readInviteCode(request);
  const redemption = await redeemAccessInvite(env, code);
  if (redemption.ok === false) {
    const storeUnavailable = redemption.code === 'store_unavailable';
    return jsonResponse(
      {
        brand: 'Sonic',
        ok: false,
        error: {
          code: storeUnavailable ? 'ACCESS_STORE_UNAVAILABLE' : 'INVITE_INVALID',
          message: storeUnavailable ? 'Access store is unavailable' : 'Invite code is invalid or unavailable',
        },
      },
      { status: storeUnavailable ? 503 : 401, headers: NO_STORE_HEADERS },
    );
  }

  const session = redemption.session || await createAccessSession(env);
  if (!session) {
    return jsonResponse(
      { brand: 'Sonic', ok: false, error: { code: 'ACCESS_STORE_UNAVAILABLE', message: 'Access store is unavailable' } },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  const headers = new Headers(NO_STORE_HEADERS);
  headers.set('Vary', 'Cookie');
  headers.append('Set-Cookie', buildAccessSessionCookie(session.token, session.record.expiresAt, new URL(request.url)));
  return jsonResponse(
    { brand: 'Sonic', ok: true, access: true, expiresAt: new Date(session.record.expiresAt).toISOString() },
    { headers },
  );
}

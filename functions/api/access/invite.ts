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
import { readBoundedRequestBody } from '../../_lib/sonic/route-helpers';
import type { AppEnv } from '../../_lib/types';

const MAX_BODY_BYTES = 4096;
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
};

type InviteCodeResult =
  | { ok: true; code: string }
  | { ok: false; status: number; errorCode: string; message: string };

async function readInviteCode(request: Request): Promise<InviteCodeResult> {
  const body = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (body.ok === false) {
    return body.reason === 'too_large'
      ? { ok: false, status: 413, errorCode: 'PAYLOAD_TOO_LARGE', message: 'Payload exceeds 4KB limit' }
      : { ok: false, status: 400, errorCode: 'READ_ERROR', message: 'Failed to read request body' };
  }
  try {
    const payload = JSON.parse(body.text) as Record<string, unknown>;
    return {
      ok: true,
      code: typeof payload.code === 'string' ? payload.code : typeof payload.invite === 'string' ? payload.invite : '',
    };
  } catch {
    return { ok: false, status: 400, errorCode: 'INVALID_PAYLOAD', message: 'Body must be a valid JSON object' };
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

  const body = await readInviteCode(request);
  if (body.ok === false) {
    return jsonResponse(
      { brand: 'Sonic', ok: false, error: { code: body.errorCode, message: body.message } },
      { status: body.status, headers: NO_STORE_HEADERS },
    );
  }
  const redemption = await redeemAccessInvite(env, body.code);
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

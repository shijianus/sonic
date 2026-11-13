import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildClearAccessSessionCookie,
  getAccessMode,
  revokeAccessSession,
} from '../../_lib/sonic/access';
import { isSameOriginRequest } from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie',
};

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405);
  if (!isSameOriginRequest(request, true)) return errorResponse('Cross-site access logout rejected', 403);

  const revocation = await revokeAccessSession(request, env);
  const headers = new Headers(NO_STORE_HEADERS);
  for (const cookie of buildClearAccessSessionCookie(new URL(request.url))) headers.append('Set-Cookie', cookie);
  return jsonResponse(
    {
      brand: 'Sonic',
      ok: !revocation.unavailable,
      access: getAccessMode(env) === 'open',
      // Clearing the browser cookie always happens; only a durable repository
      // can invalidate a captured token. Report the honest state instead of
      // implying server-side revocation when it is stateless.
      revoked: revocation.revoked,
      serverRevoked: revocation.revoked,
      revocationDurable: revocation.durable,
      ...(revocation.unavailable ? {
        error: { code: 'ACCESS_STORE_UNAVAILABLE', message: 'Browser cookie cleared; server-side revocation could not be confirmed' },
      } : {}),
    },
    { status: revocation.unavailable ? 503 : 200, headers },
  );
}

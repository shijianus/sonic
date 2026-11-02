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
  if (!isSameOriginRequest(request)) return errorResponse('Cross-site access logout rejected', 403);

  await revokeAccessSession(request, env);
  const headers = new Headers(NO_STORE_HEADERS);
  headers.append('Set-Cookie', buildClearAccessSessionCookie(new URL(request.url)));
  return jsonResponse({ brand: 'Sonic', ok: true, access: getAccessMode(env) === 'open' }, { headers });
}

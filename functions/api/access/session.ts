import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import { getAccessMode, verifyAccessSession } from '../../_lib/sonic/access';
import type { AppEnv } from '../../_lib/types';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie',
};

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse('Method not allowed', 405);

  const mode = getAccessMode(env);
  if (mode === 'open') return jsonResponse({ brand: 'Sonic', ok: true, access: true, mode }, { headers: NO_STORE_HEADERS });
  if (mode === 'legacy-staging') {
    return jsonResponse({ brand: 'Sonic', ok: true, access: false, mode }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const result = await verifyAccessSession(request, env);
  if (!result.valid) {
    return jsonResponse(
      { brand: 'Sonic', ok: false, access: false, mode, error: { code: result.reason === 'store_unavailable' ? 'ACCESS_STORE_UNAVAILABLE' : 'ACCESS_REQUIRED', message: 'Access session is required' } },
      { status: result.reason === 'store_unavailable' ? 503 : 401, headers: NO_STORE_HEADERS },
    );
  }
  return jsonResponse(
    { brand: 'Sonic', ok: true, access: true, mode, expiresAt: new Date(result.session!.expiresAt).toISOString() },
    { headers: NO_STORE_HEADERS },
  );
}

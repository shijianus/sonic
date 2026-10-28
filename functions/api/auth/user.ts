import { verifyAuth } from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateGatewayRateLimit,
} from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  const rl = await evaluateGatewayRateLimit(request, env, 'auth-user');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const auth = await verifyAuth(request, env);
  if (!auth.authenticated || !auth.user) {
    return errorResponse('未登录或 API Key 无效 (Unauthorized)', 401);
  }

  return jsonResponse(
    {
      ok: true,
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        avatar: auth.user.avatar,
        role: auth.user.role,
        createdAt: auth.user.createdAt,
        expiresAt: auth.user.expiresAt,
      },
      credentialSource: auth.source,
      links: {
        key: '/api/auth/key',
        logout: '/api/auth/logout',
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        Vary: 'Authorization, X-Sonic-Key, X-CFSolara-Key, X-Api-Key, Cookie',
      },
    },
  );
}

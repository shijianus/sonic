import { buildClearSessionCookie, revokeJtiInKv, verifyAuth } from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateGatewayRateLimit,
} from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return errorResponse('Method not allowed', 405);

  const rl = await evaluateGatewayRateLimit(request, env, 'auth-revoke');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const auth = await verifyAuth(request, env);
  if (!auth.authenticated || !auth.user) {
    return errorResponse('未登录或未提供有效身份凭证 (Unauthorized)', 401);
  }
  // Revocation is a high-risk action: require an explicit header credential, not a
  // browser Cookie alone, and revoke the exact jti that was authenticated.
  if (auth.source !== 'header') {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'REAUTH_REQUIRED',
          message:
            '撤销 API Key 需要通过 X-Sonic-Key / Authorization 请求头提供当前密钥，Cookie 会话本身不足',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!auth.tokenId || !auth.tokenExpiresAt) {
    return errorResponse('当前凭证缺少可撤销的 jti/exp', 400);
  }

  const result = await revokeJtiInKv(env, auth.tokenId, auth.tokenExpiresAt);
  if (!result.ok) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code:
            result.error === 'not_configured'
              ? 'REVOCATION_STORE_NOT_CONFIGURED'
              : 'REVOCATION_STORE_UNAVAILABLE',
          message:
            result.error === 'not_configured'
              ? '未配置 SONIC_KEY_REVOCATION_KV / SONIC_ENABLE_KEY_REVOCATION，无法执行实时撤销；请使用 SONIC_REVOKED_JTIS 并重新部署'
              : '撤销存储写入失败，当前密钥未被实时撤销',
        },
      },
      { status: result.error === 'not_configured' ? 501 : 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const headers = new Headers({
    'Cache-Control': 'no-store',
    Vary: 'Authorization, X-Sonic-Key, X-CFSolara-Key, X-Api-Key, Cookie',
  });
  headers.append('Set-Cookie', buildClearSessionCookie(new URL(request.url)));

  return jsonResponse(
    {
      ok: true,
      revoked: true,
      jti: auth.tokenId,
      propagation:
        '本 isolate 立即生效；其他 isolate 通过 30 秒短缓存传播。浏览器 Cookie 已清除。',
    },
    { headers },
  );
}

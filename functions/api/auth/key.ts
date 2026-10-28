import {
  buildSessionCookie,
  createSession,
  isKeyRevocationKvEnabled,
  revokeJtiInKv,
  verifyAuth,
} from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateGatewayRateLimit,
} from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, X-Sonic-Key, X-CFSolara-Key, X-Api-Key, Cookie',
};

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const rl = await evaluateGatewayRateLimit(request, env, 'auth-key');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const auth = await verifyAuth(request, env);
  if (!auth.authenticated || !auth.user) {
    return errorResponse('未登录或未提供有效身份凭证 (Unauthorized)', 401);
  }

  // Re-issuing a bearer credential is a high-risk action: require the caller to prove
  // possession through an explicit auth header, not merely an ambient session cookie.
  if (request.method === 'POST' && auth.source !== 'header') {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'REAUTH_REQUIRED',
          message:
            'API Key 重新签发需要通过 X-Sonic-Key / Authorization 请求头提供当前有效密钥，Cookie 会话本身不足',
        },
      },
      { status: 403, headers: PRIVATE_HEADERS },
    );
  }

  if (request.method === 'POST') {
    try {
      const newSession = await createSession(env, {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        avatar: auth.user.avatar,
        role: auth.user.role,
      });

      // With a revocation store configured, re-issuing a key also revokes the old jti.
      let oldKeyRevoked = false;
      if (isKeyRevocationKvEnabled(env)) {
        if (!auth.tokenId || !auth.tokenExpiresAt) {
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'TOKEN_METADATA_MISSING',
                message: '无法确定当前密钥的 jti/exp，已拒绝轮换以避免签发并行有效密钥',
              },
            },
            { status: 500, headers: PRIVATE_HEADERS },
          );
        }
        const revoked = await revokeJtiInKv(env, auth.tokenId, auth.tokenExpiresAt);
        if (!revoked.ok) {
          return jsonResponse(
            {
              brand: 'Sonic',
              error: {
                code: 'REVOCATION_STORE_UNAVAILABLE',
                message: '旧密钥撤销失败，已拒绝返回新密钥；当前密钥仍然有效，请重试',
              },
            },
            { status: 503, headers: PRIVATE_HEADERS },
          );
        }
        oldKeyRevoked = true;
      }

      const responseHeaders = new Headers(PRIVATE_HEADERS);
      responseHeaders.append(
        'Set-Cookie',
        buildSessionCookie(newSession.apiKey, newSession.expiresAt, new URL(request.url)),
      );

      return jsonResponse(
        {
          ok: true,
          apiKey: newSession.apiKey,
          expiresAt: newSession.expiresAt,
          oldKeyRevoked,
          message: oldKeyRevoked
            ? '新 API Key 生成成功，旧密钥已实时撤销'
            : '新 API Key 生成成功；未配置撤销存储，旧密钥仍会在其自然过期前有效',
        },
        { headers: responseHeaders },
      );
    } catch {
      return jsonResponse(
        {
          brand: 'Sonic',
          error: {
            code: 'AUTH_SECRET_MISCONFIGURED',
            message: 'API Key signing secret is not configured or shorter than 32 characters',
          },
        },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
  }

  return jsonResponse(
    {
      ok: true,
      apiKey: auth.user.apiKey,
      expiresAt: auth.user.expiresAt,
      usage: {
        rateLimit: 'Authenticated tier: SONIC_RATE_LIMIT_AUTH_RPM (default 600 requests/minute)',
        allowedSources: ['netease', 'kuwo', 'qq'],
        allowedBitrates: ['128', '192', '320', 'flac'],
      },
      instructions:
        '在外部专案的请求头中添加 X-Sonic-Key: <your_api_key> (亦兼容 X-CFSolara-Key 或 Authorization: Bearer <your_api_key>) 即可使用 epocanvas sonic 全量音乐 API。',
    },
    { headers: PRIVATE_HEADERS },
  );
}

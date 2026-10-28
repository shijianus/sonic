import {
  base64UrlEncode,
  buildAuthorizeUrl,
  getEpomailConfig,
  OAUTH_TRANSACTION_MAX_AGE_SEC,
  shouldUseSecureCookie,
  SONIC_OAUTH_STATE_COOKIE,
  SONIC_OAUTH_VERIFIER_COOKIE,
} from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateAuthRateLimit,
} from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  const rl = await evaluateAuthRateLimit(request, env, 'auth-login');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  // Fail closed if OAuth credentials are not configured
  if (!env.EPOMAIL_CLIENT_ID || !env.EPOMAIL_CLIENT_SECRET) {
    return errorResponse(
      'OAuth 服务未正确配置 (EPOMAIL_CLIENT_ID 或 EPOMAIL_CLIENT_SECRET 缺失)',
      503,
    );
  }

  const url = new URL(request.url);
  const redirectMode = url.searchParams.get('mode') === 'json' ? 'json' : 'redirect';

  // Validate redirect URI origin against config or allowed origins whitelist
  const config = getEpomailConfig(env, url.origin);
  if (!config.baseUrl || !config.redirectUri) {
    return errorResponse(
      '未配置合法重定向地址 (EPOMAIL_REDIRECT_URI 缺失/非 HTTPS 且请求来源不在 SONIC_ALLOWED_ORIGINS 白名单)',
      400,
    );
  }

  // 1. Generate >= 128-bit cryptographically secure random state (256-bit)
  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64UrlEncode(stateBytes);

  // 2. PKCE: generate 256-bit random code_verifier and S256 code_challenge
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes);
  const challengeHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(challengeHash));

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(env, url.origin, state, codeChallenge);
  } catch (err: any) {
    return errorResponse(err?.message || '构建授权跳转链接失败', 500);
  }

  const secureAttr = shouldUseSecureCookie(url) ? '; Secure' : '';
  const cookieSuffix = `; HttpOnly${secureAttr}; SameSite=Lax; Path=/api/auth; Max-Age=${OAUTH_TRANSACTION_MAX_AGE_SEC}`;
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Pragma: 'no-cache',
  });
  headers.append('Set-Cookie', `${SONIC_OAUTH_STATE_COOKIE}=${state}${cookieSuffix}`);
  headers.append('Set-Cookie', `${SONIC_OAUTH_VERIFIER_COOKIE}=${codeVerifier}${cookieSuffix}`);

  if (redirectMode === 'json') {
    return jsonResponse({ ok: true, authorizeUrl }, { headers });
  }

  headers.set('Location', authorizeUrl);
  return new Response(null, {
    status: 302,
    headers,
  });
}

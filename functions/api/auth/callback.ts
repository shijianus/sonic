import {
  buildClearSessionCookie,
  buildSessionCookie,
  consumeOAuthState,
  createSession,
  exchangeCode,
  fetchUserInfo,
  getEpomailConfig,
  OAUTH_STATE_REGEX,
  PKCE_VERIFIER_REGEX,
  readCookie,
  shouldUseSecureCookie,
  SONIC_OAUTH_STATE_COOKIE,
  SONIC_OAUTH_VERIFIER_COOKIE,
} from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import {
  buildRateLimitErrorResponse,
  evaluateAuthRateLimit,
  timingSafeEqualStr,
} from '../../_lib/sonic/security';
import type { AppEnv } from '../../_lib/types';

function clearOAuthCookies(requestUrl: URL): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Pragma: 'no-cache',
  });
  const secureAttr = shouldUseSecureCookie(requestUrl) ? '; Secure' : '';
  const suffix = `; HttpOnly${secureAttr}; SameSite=Lax; Path=/api/auth; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  headers.append('Set-Cookie', `${SONIC_OAUTH_STATE_COOKIE}=${suffix}`);
  headers.append('Set-Cookie', `${SONIC_OAUTH_VERIFIER_COOKIE}=${suffix}`);
  return headers;
}

function oauthFailure(
  message: string,
  status: number,
  headers: Headers,
  code = 'OAUTH_FAILED',
): Response {
  return jsonResponse(
    { brand: 'Sonic', ok: false, error: { code, message } },
    { status, headers },
  );
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  // Bounds unauthenticated upstream token-exchange amplification.
  const rl = await evaluateAuthRateLimit(request, env, 'auth-callback');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  // Fail closed if OAuth credentials are not configured
  if (!env.EPOMAIL_CLIENT_ID || !env.EPOMAIL_CLIENT_SECRET) {
    return errorResponse(
      'OAuth 服务未正确配置 (EPOMAIL_CLIENT_ID 或 EPOMAIL_CLIENT_SECRET 缺失)',
      503,
    );
  }

  const url = new URL(request.url);
  const clearHeaders = clearOAuthCookies(url);
  const code = url.searchParams.get('code');
  const rawError = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (rawError) {
    const safeError = /^[a-z0-9_]{1,64}$/i.test(rawError) ? rawError : 'oauth_error';
    return oauthFailure(`Epomail 授权失败: ${safeError}`, 400, clearHeaders, 'OAUTH_DENIED');
  }

  // 1. Verify OAuth state (CSRF) using the HttpOnly transaction cookie
  const cookieState = readCookie(request, SONIC_OAUTH_STATE_COOKIE);
  if (
    !state ||
    !OAUTH_STATE_REGEX.test(state) ||
    !cookieState ||
    !OAUTH_STATE_REGEX.test(cookieState) ||
    !timingSafeEqualStr(state, cookieState)
  ) {
    return oauthFailure(
      '无效或已过期的登录 state 标识 (OAuth CSRF 校验失败)',
      400,
      clearHeaders,
      'OAUTH_STATE_INVALID',
    );
  }

  // 2. PKCE is mandatory: login always issues a verifier; a missing/malformed verifier
  // must never silently downgrade the authorization-code exchange.
  const codeVerifier = readCookie(request, SONIC_OAUTH_VERIFIER_COOKIE);
  if (!codeVerifier || !PKCE_VERIFIER_REGEX.test(codeVerifier)) {
    return oauthFailure(
      '缺少或无效的 PKCE code_verifier，登录事务已拒绝',
      400,
      clearHeaders,
      'OAUTH_PKCE_MISSING',
    );
  }

  if (!code || code.length > 2048 || /[\u0000-\u0020\u007f]/.test(code)) {
    return oauthFailure(
      '缺少或格式错误的授权码 (Invalid authorization code)',
      400,
      clearHeaders,
      'OAUTH_CODE_INVALID',
    );
  }

  // 3. Redirect URI must still be valid for this deployment
  const config = getEpomailConfig(env, url.origin);
  if (!config.baseUrl || !config.redirectUri) {
    return oauthFailure(
      '未配置合法重定向地址或请求来源未授权',
      400,
      clearHeaders,
      'OAUTH_REDIRECT_INVALID',
    );
  }

  if (!consumeOAuthState(state)) {
    return oauthFailure(
      '登录 state 已被使用，请重新发起登录 (OAuth state replay)',
      400,
      clearHeaders,
      'OAUTH_STATE_REPLAYED',
    );
  }

  try {
    const { accessToken } = await exchangeCode(env, url.origin, code, codeVerifier);
    const userInfo = await fetchUserInfo(env, accessToken);
    const session = await createSession(env, userInfo);

    // Session is carried by an HttpOnly cookie; it is never placed in the redirect URL.
    clearHeaders.append('Set-Cookie', buildSessionCookie(session.apiKey, session.expiresAt, url));

    const acceptsJson =
      request.headers.get('Accept')?.includes('application/json') ||
      url.searchParams.get('format') === 'json';

    if (acceptsJson) {
      return jsonResponse(
        {
          ok: true,
          session,
          message: 'Epomail OAuth 登录成功',
        },
        { headers: clearHeaders },
      );
    }

    const targetUrl = new URL('/', new URL(config.redirectUri).origin);
    targetUrl.searchParams.set('auth', 'success');
    clearHeaders.set('Location', targetUrl.toString());
    return new Response(null, {
      status: 302,
      headers: clearHeaders,
    });
  } catch (err: any) {
    console.error(
      '[Sonic Auth Callback Error]',
      String(err?.name || 'Error'),
      String(err?.message || '').slice(0, 200),
    );
    const isMisconfig = String(err?.message || '').includes('SONIC_SECRET');
    return oauthFailure(
      isMisconfig
        ? 'API Key signing secret is not configured or shorter than 32 characters'
        : 'OAuth 登录授权处理失败',
      isMisconfig ? 503 : 500,
      clearHeaders,
      isMisconfig ? 'AUTH_SECRET_MISCONFIGURED' : 'OAUTH_EXCHANGE_FAILED',
    );
  }
}

import {
  base64UrlEncode,
  buildAuthorizeUrl,
  getEpomailConfig,
} from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import type { AppEnv } from '../../_lib/types';

const OAUTH_COOKIE_MAX_AGE = 600;

function setOAuthCookies(headers: Headers, state: string, verifier: string): void {
  headers.append(
    'Set-Cookie',
    `sonic_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=${OAUTH_COOKIE_MAX_AGE}`,
  );
  headers.append(
    'Set-Cookie',
    `sonic_oauth_verifier=${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=${OAUTH_COOKIE_MAX_AGE}`,
  );
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  if (!env.EPOMAIL_CLIENT_ID || !env.EPOMAIL_CLIENT_SECRET) {
    return errorResponse(
      'OAuth 服务未正确配置 (EPOMAIL_CLIENT_ID 或 EPOMAIL_CLIENT_SECRET 缺失)',
      503,
    );
  }

  const url = new URL(request.url);
  const redirectMode = url.searchParams.get('mode') === 'json' ? 'json' : 'redirect';
  const config = getEpomailConfig(env, url.origin);
  if (!config.baseUrl || !config.redirectUri) {
    return errorResponse(
      '未配置合法重定向地址 (EPOMAIL_BASE_URL / EPOMAIL_REDIRECT_URI 缺失且请求来源不在 SONIC_ALLOWED_ORIGINS 白名单)',
      400,
    );
  }

  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(challengeHash));

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(env, url.origin, state, codeChallenge);
  } catch (err) {
    console.error('[Sonic OAuth Login] Failed to build authorize URL:', err instanceof Error ? err.message : 'unknown');
    return errorResponse('OAuth 授权配置无效', 503);
  }

  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  setOAuthCookies(headers, state, codeVerifier);

  if (redirectMode === 'json') {
    return jsonResponse({ ok: true, authorizeUrl }, { headers });
  }

  headers.set('Location', authorizeUrl);
  return new Response(null, { status: 302, headers });
}

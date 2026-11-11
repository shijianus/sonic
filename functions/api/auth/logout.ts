import {
  buildClearSessionCookie,
  isKeyRevocationKvEnabled,
  revokeJtiInKv,
  shouldUseSecureCookie,
  verifyAuth,
  SONIC_OAUTH_STATE_COOKIE,
  SONIC_OAUTH_VERIFIER_COOKIE,
} from '../../_lib/auth';
import { errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import { recordOAuthMetric } from '../../_lib/sonic/observability';
import { isSameOriginRequest, SONIC_STAGING_COOKIE } from '../../_lib/sonic/security';
import { buildClearAccessSessionCookie, revokeAccessSession } from '../../_lib/sonic/access';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const url = new URL(request.url);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (!isSameOriginRequest(request, true) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
    return errorResponse('Cross-site logout request rejected', 403);
  }
  recordOAuthMetric('logout');

  const headers = new Headers({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  for (const cookie of buildClearSessionCookie(url)) headers.append('Set-Cookie', cookie);
  const secureAttr = shouldUseSecureCookie(url) ? '; Secure' : '';
  const pendingSuffix = `; HttpOnly${secureAttr}; SameSite=Lax; Path=/api/auth; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  headers.append('Set-Cookie', `${SONIC_OAUTH_STATE_COOKIE}=${pendingSuffix}`);
  headers.append('Set-Cookie', `${SONIC_OAUTH_VERIFIER_COOKIE}=${pendingSuffix}`);
  // Logout is a full session end, not only an identity logout: the beta access
  // cookie and the legacy staging cookie must not survive it on a shared device.
  for (const cookie of buildClearAccessSessionCookie(url)) headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', `${SONIC_STAGING_COOKIE}=${pendingSuffix.replace('Path=/api/auth', 'Path=/')}`);
  const accessRevocation = await revokeAccessSession(request, env);

  // Best-effort server-side revocation: clearing the Cookie alone does not invalidate
  // an already exported API key. Only possible when a KV revocation store is configured.
  let serverRevoked = false;
  let revocationWarning: string | undefined;
  if (isKeyRevocationKvEnabled(env)) {
    const auth = await verifyAuth(request, env);
    if (auth.authenticated && auth.tokenId && auth.tokenExpiresAt) {
      const result = await revokeJtiInKv(env, auth.tokenId, auth.tokenExpiresAt);
      serverRevoked = result.ok;
      if (!result.ok) revocationWarning = '撤销存储写入失败，已导出的 API Key 可能仍然有效';
    }
  }

  return jsonResponse(
    {
      ok: true,
      serverRevoked,
      accessRevoked: accessRevocation.revoked,
      accessRevocationDurable: accessRevocation.durable,
      ...(revocationWarning ? { revocationWarning } : {}),
      message: '已退出当前浏览器会话',
      revocationNote: serverRevoked
        ? '当前会话对应的 jti 已写入实时撤销存储'
        : '浏览器 Cookie 已清除；如需立即吊销已导出的 API Key，请配置 SONIC_KEY_REVOCATION_KV，或将 jti 加入 SONIC_REVOKED_JTIS 后重新部署',
    },
    { headers },
  );
}

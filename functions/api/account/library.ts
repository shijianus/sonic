import type { AppEnv } from '../../_lib/types';
import { jsonResponse, handleOptions } from '../../_lib/http';
import { ACCOUNT_COLLECTIONS, ACCOUNT_LIMITS, AccountError, getAccountStore, normalizeAccountMutation } from '../../_lib/account/library';
import { resolveAuthenticatedSubject } from '../../_lib/sonic/authenticated-subject';
import { EngineIdentityError } from '../../_lib/sonic/engine-identity';
import { getSonicConfig } from '../../_lib/sonic/config';
import { callLocalEngineJson } from '../../_lib/sonic/local-engine';
import { guardGatewayRequest, readBoundedRequestBody } from '../../_lib/sonic/route-helpers';

const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie, X-Sonic-Key, X-CFSolara-Key, X-Api-Key' };
function failure(error: unknown): Response {
  const known = error instanceof AccountError;
  const status = known ? error.status : 503;
  const code = known ? error.code : error instanceof EngineIdentityError ? error.code : 'ACCOUNT_STORAGE_UNAVAILABLE';
  return jsonResponse({ brand: 'Sonic', error: { code, message: known ? error.message : 'Persistent account storage unavailable' },
    ...(known && error.currentVersion !== undefined ? { currentVersion: error.currentVersion } : {}),
    ...(status === 503 ? { meta: { degraded: true, retryable: true } } : {}),
  }, { status, headers: { ...HEADERS, ...(status === 503 ? { 'Retry-After': '3', 'X-Sonic-Degraded': '1' } : {}) } });
}
export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'POST') return failure(new AccountError('METHOD_NOT_ALLOWED', 'Only GET and POST allowed', 405));
  try {
    const denied = await guardGatewayRequest(request, env, 'sonic-account');
    if (denied) { for (const [key, value] of Object.entries(HEADERS)) denied.headers.set(key, value); return denied; }
    const subject = await resolveAuthenticatedSubject(request, env);
    if (!subject) return failure(new AccountError('UNAUTHORIZED', 'An authenticated account is required', 401));
    let mutation: ReturnType<typeof normalizeAccountMutation> | undefined;
    if (request.method === 'POST') {
      const body = await readBoundedRequestBody(request, ACCOUNT_LIMITS.bodyBytes);
      if (body.ok === false) return failure(new AccountError(body.reason === 'too_large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY', 'Cannot read account payload', body.reason === 'too_large' ? 413 : 400));
      let parsed: unknown;
      try { parsed = JSON.parse(body.text); } catch { return failure(new AccountError('INVALID_JSON', 'Body must be JSON')); }
      mutation = normalizeAccountMutation(parsed);
    }
    if (getSonicConfig(env).enableLocalEngine) {
      const result = await callLocalEngineJson<any>('/api/account/library', env, { request, method: request.method as 'GET' | 'POST', ...(mutation ? { body: JSON.stringify(mutation) } : {}) });
      if (result.ok && result.data?.brand === 'Sonic' && result.data?.meta?.storageKind === 'sqlite') {
        const data = result.data.data;
        const valid = mutation ? data?.operationId === mutation.operationId && Number.isSafeInteger(data?.version) && data.version === mutation.baseVersion + 1
          : data?.schemaVersion === 1 && Number.isSafeInteger(data?.version) && data.version >= 0 && Array.isArray(data.tombstones) && ACCOUNT_COLLECTIONS.every(key => Array.isArray(data[key]));
        if (valid) return jsonResponse({ ...result.data, meta: { ...result.data.meta, persistenceConfirmed: true } }, { headers: HEADERS });
      }
      if (result.status && result.status >= 400 && result.status < 500 && result.data?.brand === 'Sonic' && typeof result.data?.error?.code === 'string') return jsonResponse(result.data, { status: result.status, headers: HEADERS });
      if (result.errorCode === 'ENGINE_IDENTITY_UNAVAILABLE') throw new EngineIdentityError();
      return failure(null); // Never acknowledge an Edge-memory fallback.
    }
    const store = getAccountStore(env);
    const data = mutation ? await store.applyLibraryMutation(subject, mutation) : await store.getLibrary(subject);
    return jsonResponse({ brand: 'Sonic', data, meta: { storageKind: 'sqlite', persistenceConfirmed: true } }, { headers: HEADERS });
  } catch (error) { return failure(error); }
}

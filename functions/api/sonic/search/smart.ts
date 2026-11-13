// GET /api/sonic/search/smart
// Hybrid Multi-Field CJK/English/Pinyin/Alias/Typo Search + Autocomplete Suggestions + Bounded Personalization
// Preserves 100% track schema compatibility with `/api/sonic/search/nexus`.

import type { AppEnv } from '../../../_lib/types';
import { jsonResponse, handleOptions } from '../../../_lib/http';
import { getSonicConfig } from '../../../_lib/sonic/config';
import { getSonicCachedJson, putSonicCachedJson } from '../../../_lib/sonic/cache';
import { callLocalEngineJson } from '../../../_lib/sonic/local-engine';
import { UPSTREAM_TIMEOUT } from '../../../_lib/sonic/request-budget';
import { hasSearchTimeout, restrictsSearchCaching } from '../../../_lib/sonic/search-cache-policy';
import type { SonicAttempt } from '../../../_lib/sonic/types';
import {
  buildGatewayHeaders,
  guardGatewayRequest,
  parseSearchParams,
  sonicError,
} from '../../../_lib/sonic/route-helpers';
import {
  buildPrivacySafeCacheHeaders,
  executeSmartSearch,
  executeSmartSuggest,
  resolveUserIdentity,
} from '../../../_lib/sonic/recommend';

// v1 could contain partial provider results, even from a no-store Engine response.
const SMART_SEARCH_CACHE = 'search-smart-v2';

export async function onRequest({
  request,
  env,
  waitUntil,
}: {
  request: Request;
  env: AppEnv;
  waitUntil?: (promise: Promise<any>) => void;
}): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return sonicError('METHOD_NOT_ALLOWED', 'Only GET/HEAD allowed', 405);
  }

  const guardResp = await guardGatewayRequest(request, env, 'sonic-search');
  if (guardResp) return guardResp;

  const start = Date.now();
  const url = new URL(request.url);
  const mode = (url.searchParams.get('mode') || 'search').trim().toLowerCase();
  const { query, page, count, nocache } = parseSearchParams(url);
  const identity = await resolveUserIdentity(request, env);
  const { headers: privacyHeaders, allowSharedCache } = buildPrivacySafeCacheHeaders(
    request,
    identity,
    env,
    600,
  );
  const config = getSonicConfig(env);
  const responseCacheHeaders = (noStore = false) => noStore || nocache
    ? { ...privacyHeaders, 'Cache-Control': 'private, no-store' }
    : privacyHeaders;

  // Fast Autocomplete Suggest Mode (`?mode=suggest&q=...`)
  if (mode === 'suggest') {
    if (config.enableLocalEngine) {
      const engineRes = await callLocalEngineJson<any>(
        `/api/sonic/search/smart${url.search}`,
        env,
        { request, timeoutMs: Math.min(1800, config.engineTimeoutMs) },
      );
      request.signal.throwIfAborted();
      if (engineRes.ok && engineRes.data?.brand === 'Sonic') {
        return jsonResponse(engineRes.data, {
          status: 200,
          headers: buildGatewayHeaders(
            { ...responseCacheHeaders(restrictsSearchCaching(engineRes.cacheControl)), 'X-Sonic-Provider': 'smart-suggest' },
            false,
            'CLOSED',
          ),
        });
      }
    }

    const suggestions = executeSmartSuggest(query, Math.min(15, count), identity, env);
    return jsonResponse(
      {
        brand: 'Sonic',
        data: {
          query,
          suggestions,
        },
        meta: {
          cached: false,
          cacheLevel: 'none',
          latencyMs: Date.now() - start,
          provider: 'smart-suggest',
        },
      },
      {
        status: 200,
        headers: buildGatewayHeaders({ ...responseCacheHeaders(), 'X-Sonic-Provider': 'smart-suggest' }),
      },
    );
  }

  if (!query) {
    return sonicError('MISSING_QUERY', 'Missing search keyword (Parameter q or keyword is required)', 400, {
      provider: 'smart',
    });
  }

  const personalize = url.searchParams.get('personalize') !== '0';
  const skipLiveUpstream = url.searchParams.get('localOnly') === '1';
  const cacheIdentifier = `q=${query.toLowerCase()}:p=${page}:c=${count}:l=${skipLiveUpstream ? 1 : 0}:z=${personalize ? 1 : 0}`;
  if (allowSharedCache && !nocache) {
    const hit = await getSonicCachedJson<any>(SMART_SEARCH_CACHE, cacheIdentifier, env);
    if (hit?.value) {
      return jsonResponse(
        { ...hit.value, meta: { ...hit.value.meta, cached: true, cacheLevel: hit.cacheLevel } },
        {
          status: 200,
          headers: buildGatewayHeaders({
            ...privacyHeaders,
            'X-Sonic-Cache': 'HIT',
            'X-Sonic-Provider': 'smart',
          }),
        },
      );
    }
  }

  // Primary Hop: Linux VPS Sonic Engine
  let degraded = false;
  let degradedReason: string | undefined;
  let circuitState: string | undefined;
  const engineAttempts: SonicAttempt[] = [];

  if (config.enableLocalEngine) {
    const engineRes = await callLocalEngineJson<any>(
      `/api/sonic/search/smart${url.search}`,
      env,
      { request, timeoutMs: Math.min(config.engineTimeoutMs, config.timeoutMs) },
    );
    request.signal.throwIfAborted();
    circuitState = engineRes.circuitState;
    if (engineRes.ok && engineRes.data?.brand === 'Sonic' && engineRes.data?.data) {
      const body = {
        ...engineRes.data,
        meta: {
          ...engineRes.data.meta,
          cached: false,
          cacheLevel: 'none',
          latencyMs: Date.now() - start,
          via: 'local-engine',
          circuitState: 'CLOSED',
        },
      };
      const noStore = restrictsSearchCaching(engineRes.cacheControl) || hasSearchTimeout(body.meta.attempts);
      if (allowSharedCache && !nocache && !noStore && Array.isArray(body.data.tracks) && body.data.tracks.length > 0) {
        await putSonicCachedJson(SMART_SEARCH_CACHE, cacheIdentifier, body, 600, 7200, env, waitUntil);
      }
      return jsonResponse(body, {
        status: 200,
        headers: buildGatewayHeaders(
          { ...responseCacheHeaders(noStore), 'X-Sonic-Cache': 'MISS', 'X-Sonic-Provider': 'smart' },
          false,
          'CLOSED',
        ),
      });
    }
    degraded = true;
    degradedReason = engineRes.error || 'local_engine_unavailable';
    if (engineRes.errorCode === UPSTREAM_TIMEOUT || engineRes.data?.error?.code === UPSTREAM_TIMEOUT || engineRes.status === 504) {
      engineAttempts.push({ provider: 'local-engine', via: 'local-engine', ok: false, ms: engineRes.latencyMs, errorCode: UPSTREAM_TIMEOUT });
    }
  }

  try {
    const result = await executeSmartSearch(
      query,
      { page, count, personalize, skipLiveUpstream, request },
      identity,
      env,
    );
    request.signal.throwIfAborted();

    const effectiveDegraded = degraded || Boolean(result.degraded);
    const effectiveReason = degradedReason || result.degradedReason;
    const effectiveCircuit = circuitState || result.circuitState;
    const attempts = [...engineAttempts, ...result.attempts];
    const noStore = result.noStore || hasSearchTimeout(attempts);

    const responseBody = {
      brand: 'Sonic',
      data: result.data,
      meta: {
        cached: false,
        cacheLevel: 'none',
        latencyMs: Date.now() - start,
        provider: 'smart',
        degraded: effectiveDegraded,
        ...(effectiveDegraded ? { degradedReason: effectiveReason, circuitState: effectiveCircuit } : {}),
        attempts,
      },
    };

    if (allowSharedCache && !nocache && !noStore && result.data.tracks.length > 0) {
      await putSonicCachedJson(SMART_SEARCH_CACHE, cacheIdentifier, responseBody, 600, 7200, env, waitUntil);
    }

    return jsonResponse(responseBody, {
      status: 200,
      headers: buildGatewayHeaders(
        { ...responseCacheHeaders(noStore), 'X-Sonic-Cache': 'MISS', 'X-Sonic-Provider': 'smart' },
        effectiveDegraded,
        effectiveCircuit,
      ),
    });
  } catch (err: any) {
    request.signal.throwIfAborted();
    return sonicError('SMART_SEARCH_ERROR', err?.message || 'Smart search failed', 502, {
      provider: 'smart',
      latencyMs: Date.now() - start,
      degraded,
      circuitState: circuitState as any,
    });
  }
}

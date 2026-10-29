// Sonic Local Engine — Authenticated Health & Diagnostics Endpoint
// GET /api/sonic/engine/health
// Protected by mandatory `X-Sonic-Engine-Key` (rejects anonymous requests with 401; never exposes secrets/cookies)

import { handleOptions, jsonResponse } from '../../../_lib/http';
import { checkEngineAccess } from '../../../_lib/sonic/security';
import { getSonicConfig } from '../../../_lib/sonic/config';
import { getLocalEngineCircuitSnapshot } from '../../../_lib/sonic/local-engine';
import { getRecommendStore, isGorseEnabled, isMeilisearchEnabled } from '../../../_lib/sonic/recommend';
import type { AppEnv } from '../../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const denied = checkEngineAccess(request, env);
  if (denied) return denied;

  const cfg = getSonicConfig(env);
  let ncmSidecarHealthy: boolean | null = null;
  let ncmSidecarLatencyMs: number | null = null;

  if (cfg.ncmApiUrl) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${cfg.ncmApiUrl}/inner/version`, { signal: AbortSignal.timeout(2000) });
      ncmSidecarHealthy = r.ok;
      ncmSidecarLatencyMs = Date.now() - t0;
    } catch {
      ncmSidecarHealthy = false;
      ncmSidecarLatencyMs = Date.now() - t0;
    }
  }

  // Readiness must reflect the recommendation store actually in use. A persistent
  // deployment that fell back to memory is not ready: reporting ok would hide data loss.
  const store = getRecommendStore(env);
  let recommendStats: Record<string, any> = {};
  let storageError: string | undefined;
  try {
    recommendStats = store.getStats();
  } catch {
    storageError = 'read_failed';
  }
  const configuredDbPath = String(env?.SONIC_RECOMMEND_DB_PATH || '').trim();
  const persistenceExpected =
    configuredDbPath !== '' && configuredDbPath !== 'memory' && configuredDbPath !== 'off';
  const storageHealthy =
    !storageError && (!persistenceExpected || recommendStats.storageKind === 'sqlite');
  const ok = storageHealthy;

  return jsonResponse(
    {
      brand: 'Sonic',
      ok,
      runtime: cfg.runtime,
      timestamp: new Date().toISOString(),
      ncmSidecar: {
        configured: Boolean(cfg.ncmApiUrl),
        healthy: ncmSidecarHealthy,
        latencyMs: ncmSidecarLatencyMs,
      },
      cookiesConfigured: {
        netease: Boolean(env?.NETEASE_COOKIE),
        qq: Boolean(env?.QQ_COOKIE),
        kugou: Boolean(env?.KUGOU_COOKIE),
      },
      flags: {
        enableGdstudio: cfg.enableGdstudio,
        enableLyriva: cfg.enableLyriva,
        enableUnblock: cfg.enableUnblock,
        enableFreeCrossMatch: cfg.enableFreeCrossMatch,
      },
      recommendEngine: {
        ...recommendStats,
        storageHealthy,
        persistenceExpected,
        storageError,
        gorseConfigured: isGorseEnabled(env),
        meilisearchConfigured: isMeilisearchEnabled(env),
      },
      process:
        typeof process !== 'undefined'
          ? {
              nodeVersion: process.version,
              uptimeSec: Math.floor(process.uptime()),
              rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            }
          : undefined,
      circuit: getLocalEngineCircuitSnapshot(env),
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

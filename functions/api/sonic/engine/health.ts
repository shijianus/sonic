// Sonic Local Engine — Authenticated Health & Readiness Endpoint
// GET /api/sonic/engine/health
// Protected by mandatory `X-Sonic-Engine-Key` (rejects anonymous requests with 401; never exposes secrets/cookies)
// Fails closed with HTTP 503 if SQLite fell back to memory, storage is read-only/corrupted, or free disk space is critically low.

import { handleOptions, jsonResponse } from '../../../_lib/http';
import { checkEngineAccess, getRateLimitConfigStatus } from '../../../_lib/sonic/security';
import { getSonicConfig, isEnvEnabled } from '../../../_lib/sonic/config';
import { fetchWithRuntimeBudget } from '../../../_lib/sonic/local-engine';
import { getLicensingAuditSummary } from '../../../_lib/sonic/licensing';
import { getLocalEngineCircuitSnapshot } from '../../../_lib/sonic/local-engine';
import { getEngineIdentityReadiness, requireValidEngineIdentity, EngineIdentityError } from '../../../_lib/sonic/engine-identity';
import {
  getObservabilitySnapshot,
  getReleaseMetadata,
  getReleaseReadiness,
  recordSqliteMetric,
  redactSensitiveString,
  triggerSonicAlert,
} from '../../../_lib/sonic/observability';
import { getRecommendStore, isGorseEnabled, isMeilisearchEnabled } from '../../../_lib/sonic/recommend';
import type { AppEnv } from '../../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const denied = checkEngineAccess(request, env);
  if (denied) return denied;

  const cfg = getSonicConfig(env);
  const release = getReleaseMetadata(env);
  let ncmSidecarHealthy: boolean | null = null;
  let ncmSidecarLatencyMs: number | null = null;

  if (cfg.ncmApiUrl) {
    const t0 = Date.now();
    try {
      const r = await fetchWithRuntimeBudget(`${cfg.ncmApiUrl}/inner/version`, {}, { timeoutMs: 2000, signals: [request.signal] });
      ncmSidecarHealthy = r.ok;
      void r.body?.cancel().catch(() => {});
      ncmSidecarLatencyMs = Date.now() - t0;
    } catch {
      ncmSidecarHealthy = false;
      ncmSidecarLatencyMs = Date.now() - t0;
    }
  }

  // Readiness must reflect the recommendation store AND underlying disk writability/capacity.
  // A persistent deployment that fell back to memory, went read-only, or ran out of disk space
  // is NOT ready: reporting ok would hide silent data loss.
  const store = getRecommendStore(env);
  let recommendStats: Record<string, any> = {};
  let storageError: string | undefined;
  try {
    recommendStats = store.getStats();
  } catch (err: any) {
    storageError = redactSensitiveString(err?.message || 'read_failed');
    recordSqliteMetric('read_error');
  }

  const configuredDbPath = String(env?.SONIC_RECOMMEND_DB_PATH || '').trim();
  const persistenceExpected =
    configuredDbPath !== 'memory' && configuredDbPath !== 'off' && configuredDbPath !== ':memory:' &&
    (configuredDbPath !== '' || cfg.runtime === 'linux-engine' && release.environment === 'production');

  let diskHealth: ReturnType<NonNullable<AppEnv['SONIC_DISK_HEALTH_PROVIDER']>> | undefined;
  try {
    diskHealth = typeof env?.SONIC_DISK_HEALTH_PROVIDER === 'function' ? env.SONIC_DISK_HEALTH_PROVIDER() : undefined;
  } catch (error: any) {
    storageError = redactSensitiveString(error?.message || 'disk_probe_failed');
    recordSqliteMetric('write_error');
  }
  if (persistenceExpected && !diskHealth) storageError = storageError || 'disk_health_unavailable';

  if (persistenceExpected && recommendStats.storageKind !== 'sqlite') {
    recordSqliteMetric('memory_fallback');
    storageError = storageError || 'sqlite_fell_back_to_memory';
  }
  if (persistenceExpected && diskHealth && !diskHealth.ok) {
    recordSqliteMetric('write_error');
    storageError = storageError || diskHealth.error || 'disk_unwritable_or_low_space';
  }

  const storageHealthy =
    !storageError &&
    (!persistenceExpected || recommendStats.storageKind === 'sqlite') &&
    (!persistenceExpected || !diskHealth || diskHealth.ok);

  const sidecarRequired = isEnvEnabled(env.SONIC_NCM_REQUIRED, false);
  const sidecarReady = !sidecarRequired || ncmSidecarHealthy === true;
  const releaseReadiness = getReleaseReadiness(env);
  const identityReadiness = getEngineIdentityReadiness(env);
  let identityVerified = false;
  try {
    identityVerified = Boolean(await requireValidEngineIdentity(request, env));
  } catch (error) {
    if (!(error instanceof EngineIdentityError)) throw error;
    identityReadiness.ok = false;
  }
  const rateLimit = getRateLimitConfigStatus(env);
  const rateLimitReady = !rateLimit.requireDistributed || rateLimit.productionCompliant;
  const draining = Boolean(env.SONIC_DRAIN_STATE?.draining);
  const ok = storageHealthy && sidecarReady && releaseReadiness.ok && identityReadiness.ok && rateLimitReady && !draining;
  const degraded = Boolean(cfg.ncmApiUrl && !sidecarRequired && ncmSidecarHealthy === false);
  const reasons = [
    ...(!storageHealthy ? [storageError || 'storage_unhealthy'] : []),
    ...(!sidecarReady ? ['required_sidecar_unavailable'] : []),
    ...(!releaseReadiness.ok ? [releaseReadiness.error!] : []),
    ...(!identityReadiness.ok ? ['engine_identity_unavailable'] : []),
    ...(!rateLimitReady ? ['distributed_rate_limiter_unavailable'] : []),
    ...(draining ? ['engine_draining'] : []),
  ];

  if (!storageHealthy) {
    void triggerSonicAlert(env, {
      code: 'ENGINE_STORAGE_UNHEALTHY',
      severity: 'critical',
      summary: `Sonic Engine readiness failed: ${storageError || 'storage_unhealthy'} (dbKind=${recommendStats.storageKind || 'unknown'})`,
    });
  }

  if (!sidecarReady || degraded) {
    void triggerSonicAlert(env, {
      code: sidecarRequired ? 'ENGINE_REQUIRED_SIDECAR_UNHEALTHY' : 'ENGINE_SIDECAR_DEGRADED',
      severity: sidecarRequired ? 'critical' : 'warning',
      summary: sidecarRequired ? 'Required NCM sidecar is unavailable' : 'NCM sidecar unavailable; native provider fallback enabled',
    });
  }
  const obs = getObservabilitySnapshot(env);
  const licensing = getLicensingAuditSummary(env);

  return jsonResponse(
    {
      brand: 'Sonic',
      ok,
      liveness: { ok: true },
      readiness: {
        ok, degraded, reasons, draining, deadlineAt: env.SONIC_DRAIN_STATE?.deadlineAt,
        release: releaseReadiness, identity: { ...identityReadiness, requestVerified: identityVerified },
      },
      runtime: cfg.runtime,
      release,
      timestamp: new Date().toISOString(),
      ncmSidecar: {
        configured: Boolean(cfg.ncmApiUrl),
        required: sidecarRequired,
        healthy: ncmSidecarHealthy,
        latencyMs: ncmSidecarLatencyMs,
      },
      cookiesConfigured: {
        netease: Boolean(env?.NETEASE_COOKIE),
        qq: Boolean(env?.QQ_COOKIE),
        kugou: Boolean(env?.KUGOU_COOKIE),
      },
      flags: {
        contentPolicy: cfg.contentPolicy,
        enableOAuth: cfg.enableOAuth,
        enableSynthetic: cfg.enableSynthetic,
        enableGdstudio: cfg.enableGdstudio,
        enableLyriva: cfg.enableLyriva,
        enableUnblock: cfg.enableUnblock,
        enableFreeCrossMatch: cfg.enableFreeCrossMatch,
      },
      licensing: {
        policyMode: licensing.policyMode,
        allowedSources: licensing.allowedSources,
      },
      rateLimit,
      recommendEngine: {
        ...recommendStats,
        storageHealthy,
        persistenceExpected,
        storageError,
        disk: diskHealth,
        gorseConfigured: isGorseEnabled(env),
        meilisearchConfigured: isMeilisearchEnabled(env),
      },
      observability: {
        requests: obs.requests,
        overallP95Ms: obs.latency.overall.p95Ms,
        sqlite: obs.sqlite,
        rateLimitDegradedEvents: obs.rateLimit.degradedEvents,
        alerts: obs.alerts,
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

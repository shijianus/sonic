// Sonic Local Engine — Authenticated Health & Readiness Endpoint
// GET /api/sonic/engine/health
// Protected by mandatory `X-Sonic-Engine-Key` (rejects anonymous requests with 401; never exposes secrets/cookies)
// Fails closed with HTTP 503 if SQLite fell back to memory, storage is read-only/corrupted, or free disk space is critically low.

import { handleOptions, jsonResponse } from '../../../_lib/http';
import {
  buildRateLimitErrorResponse,
  checkEngineAccess,
  evaluateGatewayRateLimit,
  getRateLimitConfigStatus,
} from '../../../_lib/sonic/security';
import { getSonicConfig, isEnvEnabled } from '../../../_lib/sonic/config';
import { callLocalEngineJson, fetchWithRuntimeBudget, getLocalEngineCircuitSnapshot } from '../../../_lib/sonic/local-engine';
import { getLicensingAuditSummary, getContentPolicyReadiness } from '../../../_lib/sonic/licensing';
import {
  getAccessMode,
  getAccessRepository,
  hashInviteCode,
  isAccessModeDeclaredInvalid,
  isAccessModeExplicit,
} from '../../../_lib/sonic/access';
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

interface EnginePeerHealth {
  ok?: boolean;
  runtime?: string;
  release?: ReturnType<typeof getReleaseMetadata>;
  readiness?: {
    identity?: { ok?: boolean; configured?: boolean; required?: boolean };
    contentPolicy?: ReturnType<typeof getContentPolicyReadiness>;
  };
  recommendEngine?: { storageKind?: string; storageHealthy?: boolean; disk?: { ok?: boolean }; erasureRecoveryVersion?: number };
}

async function verifyConfiguredEngine(request: Request, env: AppEnv, engineUrl?: string) {
  const target = engineUrl ? new URL(engineUrl) : undefined;
  if (!target || target.pathname !== '/' || target.search || target.hash || target.origin === new URL(request.url).origin) {
    return { ok: false, origin: target?.origin };
  }
  const probe = await callLocalEngineJson<EnginePeerHealth>('/api/sonic/engine/health', env, {
    method: 'GET', signal: request.signal,
  });
  const health = probe.data;
  const release = health?.release;
  const identity = health?.readiness?.identity;
  const storage = health?.recommendEngine;
  return {
    ok: probe.ok && health?.ok === true && health.runtime === 'linux-engine' &&
      release?.engineIdentityCompiled === true && storage?.erasureRecoveryVersion === 1 &&
      identity?.ok === true && identity.configured === true && identity.required === true &&
      storage?.storageKind === 'sqlite' && storage.storageHealthy === true && storage.disk?.ok === true,
    origin: target.origin,
    status: probe.status,
    runtime: health?.runtime,
    contentPolicy: health?.readiness?.contentPolicy,
    release: release && {
      releaseCommit: release.releaseCommit, sourceDigest: release.sourceDigest, releaseId: release.releaseId,
      buildTime: release.buildTime, dirty: release.dirty, environment: release.environment,
      engineIdentityCompiled: release.engineIdentityCompiled,
    },
    storageKind: storage?.storageKind,
    erasureRecoveryVersion: storage?.erasureRecoveryVersion,
  };
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const denied = checkEngineAccess(request, env);
  if (denied) return denied;

  // Health probes are authenticated but cheap to repeat; bound them as well so a
  // compromised key cannot turn readiness into unbounded DB/sidecar work.
  const rateLimitDecision = await evaluateGatewayRateLimit(request, env, 'engine-health');
  if (!rateLimitDecision.allowed) return buildRateLimitErrorResponse(rateLimitDecision);

  const cfg = getSonicConfig(env);
  const release = getReleaseMetadata(env);
  const enginePeer = cfg.runtime === 'cf-pages' && new URL(request.url).searchParams.get('verifyEngine') === '1'
    ? await verifyConfiguredEngine(request, env, cfg.enableLocalEngine ? cfg.localEngineUrl : undefined)
    : undefined;
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
  const contentPolicyReadiness = getContentPolicyReadiness(env);
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
  const accessMode = getAccessMode(env);
  const accessRepository = getAccessRepository(env);
  const accessStoreUsable = Boolean(accessRepository) && typeof accessRepository?.redeemInviteAndCreateSession === 'function';
  const accessSecretConfigured = String(env.SONIC_ACCESS_SECRET || '').trim().length >= 32;
  const configuredInviteCodes = String(env.SONIC_INVITE_CODES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const validConfiguredInviteCodes = configuredInviteCodes.filter(code => hashInviteCode(code) !== null).length;
  const invalidConfiguredInviteCodes = configuredInviteCodes.length - validConfiguredInviteCodes;
  const signedAccessReady = accessSecretConfigured && validConfiguredInviteCodes > 0;
  const accessReady =
    !isAccessModeDeclaredInvalid(env) &&
    invalidConfiguredInviteCodes === 0 &&
    (accessMode !== 'invite' ||
      (accessRepository ? accessStoreUsable : signedAccessReady));
  const accessReadiness = {
    mode: accessMode,
    explicit: isAccessModeExplicit(env),
    invalid: isAccessModeDeclaredInvalid(env),
    required: accessMode === 'invite',
    storeConfigured: Boolean(accessRepository),
    storeUsable: accessStoreUsable,
    singleUse: Boolean(accessRepository),
    revocable: Boolean(accessRepository?.revokeSession),
    secretConfigured: accessSecretConfigured,
    configuredInviteCodes: configuredInviteCodes.length,
    validConfiguredInviteCodes,
    invalidConfiguredInviteCodes,
    ok: accessReady,
  };
  const draining = Boolean(env.SONIC_DRAIN_STATE?.draining);
  const ok = storageHealthy && sidecarReady && releaseReadiness.ok && contentPolicyReadiness.ok && accessReady && identityReadiness.ok && rateLimitReady && !draining && enginePeer?.ok !== false;
  const degraded = Boolean(cfg.ncmApiUrl && !sidecarRequired && ncmSidecarHealthy === false);
  const reasons = [
    ...(!storageHealthy ? [storageError || 'storage_unhealthy'] : []),
    ...(!sidecarReady ? ['required_sidecar_unavailable'] : []),
    ...(!releaseReadiness.ok ? [releaseReadiness.error!] : []),
    ...(!contentPolicyReadiness.ok ? [`content_policy_${contentPolicyReadiness.reason || 'misconfigured'}`] : []),
    ...(!accessReady ? ['access_misconfigured'] : []),
    ...(!identityReadiness.ok ? ['engine_identity_unavailable'] : []),
    ...(!rateLimitReady ? ['distributed_rate_limiter_unavailable'] : []),
    ...(draining ? ['engine_draining'] : []),
    ...(enginePeer?.ok === false ? ['configured_engine_unavailable'] : []),
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
        contentPolicy: contentPolicyReadiness,
        access: accessReadiness,
      },
      runtime: cfg.runtime,
      release,
      enginePeer,
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

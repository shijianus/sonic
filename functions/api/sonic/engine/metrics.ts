// Sonic Observability & Alert Verification Endpoint
// GET  /api/sonic/engine/metrics              -> Full redacted observability, rate-limit, licensing & storage snapshot
// POST /api/sonic/engine/metrics?action=test-alert -> Fires a real redacted webhook verification alert (fails honestly with 503 if unconfigured)
// Protected by mandatory `X-Sonic-Engine-Key`.

import { handleOptions, jsonResponse } from '../../../_lib/http';
import { getLicensingAuditSummary } from '../../../_lib/sonic/licensing';
import { getLocalEngineCircuitSnapshot } from '../../../_lib/sonic/local-engine';
import {
  getObservabilitySnapshot,
  redactSensitiveString,
  triggerSonicAlert,
} from '../../../_lib/sonic/observability';
import { checkEngineAccess, getRateLimitConfigStatus, evaluateGatewayRateLimit, buildRateLimitErrorResponse } from '../../../_lib/sonic/security';
import type { AppEnv } from '../../../_lib/types';

const TEST_ALERT_WINDOW_MS = 3_600_000;
const TEST_ALERT_MAX_PER_WINDOW = 5;
const testAlertBuckets = new Map<string, { count: number; resetAt: number }>();

function isTestAlertAllowed(ip: string): boolean {
  const now = Date.now();
  let bucket = testAlertBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + TEST_ALERT_WINDOW_MS };
    if (testAlertBuckets.size >= 256) {
      for (const [k, v] of testAlertBuckets) {
        if (now >= v.resetAt) testAlertBuckets.delete(k);
      }
    }
    testAlertBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= TEST_ALERT_MAX_PER_WINDOW;
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const denied = checkEngineAccess(request, env);
  if (denied) return denied;

  // POST test-alert can fire an external webhook, so it must never be an
  // unbounded authenticated action.
  const rateLimit = await evaluateGatewayRateLimit(request, env, 'engine-metrics');
  if (!rateLimit.allowed) return buildRateLimitErrorResponse(rateLimit);

  const url = new URL(request.url);

  if (request.method === 'POST') {
    const action = (url.searchParams.get('action') || 'test-alert').trim().toLowerCase();
    if (action !== 'test-alert') {
      return jsonResponse(
        {
          brand: 'Sonic',
          ok: false,
          error: { code: 'UNSUPPORTED_ACTION', message: "Supported POST action: 'test-alert'" },
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const customNote = redactSensitiveString(url.searchParams.get('note') || '');

    const callerIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!isTestAlertAllowed(callerIp)) {
      return jsonResponse(
        {
          brand: 'Sonic',
          ok: false,
          error: { code: 'TEST_ALERT_RATE_LIMITED', message: `Test-alert is limited to ${TEST_ALERT_MAX_PER_WINDOW} calls per hour` },
        },
        { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '3600' } },
      );
    }

    const summary = customNote
      ? `Operator alert verification self-check: ${customNote}`
      : 'Operator-initiated Sonic alert verification self-check';

    const delivery = await triggerSonicAlert(env, {
      code: 'MANUAL_ALERT_SELF_CHECK',
      severity: 'warning',
      summary,
      bypassCooldown: true,
    });

    return jsonResponse(
      {
        brand: 'Sonic',
        ok: delivery.sent,
        delivery,
        observability: getObservabilitySnapshot(env),
      },
      {
        status: delivery.sent ? 200 : 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(
      { brand: 'Sonic', error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } },
      { status: 405, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const disk = typeof env?.SONIC_DISK_HEALTH_PROVIDER === 'function' ? env.SONIC_DISK_HEALTH_PROVIDER() : undefined;

  return jsonResponse(
    {
      brand: 'Sonic',
      ok: true,
      observability: getObservabilitySnapshot(env),
      rateLimitConfig: getRateLimitConfigStatus(env),
      licensing: getLicensingAuditSummary(env),
      disk,
      circuit: getLocalEngineCircuitSnapshot(env),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}

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
import { checkEngineAccess, getRateLimitConfigStatus } from '../../../_lib/sonic/security';
import type { AppEnv } from '../../../_lib/types';

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();

  const denied = checkEngineAccess(request, env);
  if (denied) return denied;

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

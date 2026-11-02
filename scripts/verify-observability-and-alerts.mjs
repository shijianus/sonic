// Sonic metrics/readiness/alert delivery release check. Self-test uses only in-memory stubs.
//   node scripts/verify-observability-and-alerts.mjs --self-test
//   SONIC_ENGINE_URL=http://127.0.0.1:18080 SONIC_ENGINE_SECRET=... node scripts/verify-observability-and-alerts.mjs
//   Add --metrics-only to inspect metrics without sending an alert; this is not a full release gate.

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

async function readJson(fetchImpl, url, headers, method = 'GET') {
  try {
    const response = await fetchImpl(url, { headers, method, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    try {
      return { ok: response.ok, status: response.status, body: await response.json() };
    } catch {
      return { ok: false, status: response.status, error: 'invalid_json' };
    }
  } catch {
    // Never echo transport errors, which may contain headers or credential-bearing URLs.
    return { ok: false, error: 'request_failed' };
  }
}

function validRelease(release) {
  return Boolean(release && /^[a-f0-9]{7,40}$/i.test(release.releaseCommit || '') &&
    typeof release.buildTime === 'string' && Number.isFinite(Date.parse(release.buildTime)) &&
    (release.dirty === false || release.dirty === true &&
      /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(release.releaseId || '') && /^[a-f0-9]{64}$/i.test(release.sourceDigest || '')));
}

export async function verifyLiveObservability({ env = process.env, metricsOnly = false, fetchImpl = globalThis.fetch } = {}) {
  const failures = [];
  const result = { ok: false, mode: metricsOnly ? 'metrics-only' : 'live', fullGate: false, failures };
  const secret = String(env.SONIC_ENGINE_SECRET || '').trim();
  if (secret.length < 32) return { ...result, failures: ['engine_secret_required'] };

  let base;
  try {
    base = new URL(env.SONIC_ENGINE_URL || 'http://127.0.0.1:18080');
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch {
    return { ...result, failures: ['invalid_engine_url'] };
  }
  const baseUrl = base.toString().replace(/\/+$/, '');
  const headers = { 'X-Sonic-Engine-Key': secret };
  const stagingToken = String(env.SONIC_STAGING_ACCESS_TOKEN || '').trim();
  if (stagingToken) headers['X-Sonic-Staging-Token'] = stagingToken;

  const metricsResponse = await readJson(fetchImpl, `${baseUrl}/api/sonic/engine/metrics`, headers);
  const metrics = metricsResponse.body;
  if (!metricsResponse.ok || metrics?.ok !== true || !metrics.observability || typeof metrics.observability !== 'object') {
    return { ...result, failures: ['metrics_unavailable'], metricsStatus: metricsResponse.status };
  }
  const observability = metrics.observability;
  // Print only selected evidence, not arbitrary remote bodies or webhook URLs.
  const evidence = {
    metricsStatus: metricsResponse.status,
    releaseValid: validRelease(observability.release),
    overallP95Ms: typeof observability.latency?.overall?.p95Ms === 'number' ? observability.latency.overall.p95Ms : null,
    rollingRequests: typeof observability.window?.requests?.total === 'number' ? observability.window.requests.total : null,
    rollingErrorRate5xx: typeof observability.window?.requests?.errorRate5xx === 'number' ? observability.window.requests.errorRate5xx : null,
    alertConfigured: observability.alerts?.configured === true,
  };
  if (metricsOnly) return { ...result, ...evidence, ok: true, alertResult: { sent: false, reason: 'metrics_only_not_checked' } };

  if (!evidence.releaseValid) failures.push('release_metadata_invalid');
  if (metrics.rateLimitConfig?.productionCompliant !== true) failures.push('metrics_rate_limiter_unready');
  if (metrics.disk && (metrics.disk.ok !== true || metrics.disk.writable !== true || metrics.disk.lowSpace === true)) failures.push('metrics_storage_unready');

  const healthResponse = await readJson(fetchImpl, `${baseUrl}/api/sonic/engine/health`, headers);
  const health = healthResponse.body;
  if (!healthResponse.ok || health?.ok !== true || health.readiness?.ok !== true) failures.push('engine_unready');
  if (health?.readiness?.release?.ok !== true || !validRelease(health?.release)) failures.push('release_unready');
  if (health?.readiness?.identity?.ok !== true) failures.push('identity_unready');
  if (health?.recommendEngine?.storageHealthy !== true) failures.push('storage_unready');
  const storage = health?.recommendEngine;
  if (storage?.disk && (storage.disk.ok !== true || storage.disk.writable !== true || storage.disk.lowSpace === true) ||
    storage?.persistenceExpected === true && (storage.storageKind !== 'sqlite' || !storage.disk)) failures.push('storage_probe_unready');
  if (health?.rateLimit?.productionCompliant !== true) failures.push('health_rate_limiter_unready');

  let alertResult = { sent: false, reason: 'webhook_required' };
  if (!evidence.alertConfigured) {
    failures.push('alert_webhook_required');
  } else if (failures.length === 0) {
    const response = await readJson(fetchImpl, `${baseUrl}/api/sonic/engine/metrics?action=test-alert`, headers, 'POST');
    const delivery = response.body?.delivery;
    const delivered = response.ok && response.body?.ok === true && delivery?.sent === true && delivery.reason === 'delivered' &&
      Number.isInteger(delivery.status) && delivery.status >= 200 && delivery.status < 300;
    alertResult = {
      sent: Boolean(delivered),
      reason: delivered ? 'delivered' : 'delivery_failed',
      httpStatus: response.status,
      ...(Number.isInteger(delivery?.status) ? { webhookStatus: delivery.status } : {}),
    };
    if (!delivered) failures.push('alert_delivery_failed');
  } else {
    alertResult = { sent: false, reason: 'readiness_failed_not_sent' };
  }
  const ok = failures.length === 0;
  return { ...result, ...evidence, healthStatus: healthResponse.status, ok, fullGate: ok, alertResult };
}

export async function runSelfTest() {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url);
  const { onRequest: handleEngineMetrics } = await jiti.import('../functions/api/sonic/engine/metrics');
  const { recordHttpRequestMetric, resetObservabilityForTest } = await jiti.import('../functions/_lib/sonic/observability');
  const captured = [];
  const originalFetch = globalThis.fetch;
  const engineSecret = 'self_check_engine_secret_minimum_32_characters_long';
  const env = {
    SONIC_RUNTIME: 'linux-engine', SONIC_ENV: 'test',
    SONIC_RELEASE_COMMIT: 'abcdef1234567890', SONIC_BUILD_TIME: '2026-11-02T00:00:00.000Z', SONIC_RELEASE_DIRTY: '0',
    SONIC_ENGINE_SECRET: engineSecret,
    SONIC_ALERT_WEBHOOK_URL: 'https://stub.example.invalid/webhook',
  };
  const alertRequest = () => new Request('http://engine.test/api/sonic/engine/metrics?action=test-alert&note=stream%3Fauth%3Dsensitive_sig_value', {
    method: 'POST', headers: { 'X-Sonic-Engine-Key': engineSecret },
  });
  try {
    resetObservabilityForTest();
    globalThis.fetch = async (url, init) => {
      assert.equal(url, env.SONIC_ALERT_WEBHOOK_URL);
      captured.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    };
    recordHttpRequestMetric('/api/sonic/search/nexus', 200, 38, env);
    recordHttpRequestMetric('/api/music/stream', 206, 84, env);
    const getResponse = await handleEngineMetrics({ request: new Request('http://engine.test/api/sonic/engine/metrics', {
      headers: { 'X-Sonic-Engine-Key': engineSecret },
    }), env });
    assert.equal(getResponse.status, 200);
    const snapshot = await getResponse.json();
    assert.equal(snapshot.observability.requests.total, 2);
    assert.equal(snapshot.observability.window.requests.total, 2);
    const delivered = await handleEngineMetrics({ request: alertRequest(), env });
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).delivery.sent, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].code, 'MANUAL_ALERT_SELF_CHECK');
    assert.ok(!JSON.stringify(captured[0]).includes('sensitive_sig_value'));

    globalThis.fetch = async () => new Response(null, { status: 502 });
    const failed = await handleEngineMetrics({ request: alertRequest(), env });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).delivery.sent, false);
    const missing = await handleEngineMetrics({ request: alertRequest(), env: { ...env, SONIC_ALERT_WEBHOOK_URL: '' } });
    assert.equal(missing.status, 503);

    const readyHealth = { ok: true, readiness: { ok: true, release: { ok: true }, identity: { ok: true } },
      release: snapshot.observability.release, rateLimit: { productionCompliant: true }, recommendEngine: { storageHealthy: true } };
    let failureStatus = 200;
    let configured = true;
    const fetchStub = async (url, init) => {
      if (init.method === 'POST') return Response.json({ ok: failureStatus === 200,
        delivery: { sent: failureStatus === 200, reason: failureStatus === 200 ? 'delivered' : 'webhook_http_502', status: failureStatus === 200 ? 204 : 502 },
      }, { status: failureStatus });
      if (String(url).endsWith('/health')) return Response.json(readyHealth);
      return Response.json({ ...snapshot, rateLimitConfig: { productionCompliant: true }, observability: {
        ...snapshot.observability, alerts: { configured },
      } });
    };
    assert.equal((await verifyLiveObservability({ env, fetchImpl: fetchStub })).fullGate, true);
    failureStatus = 503;
    assert.equal((await verifyLiveObservability({ env, fetchImpl: fetchStub })).ok, false);
    assert.equal(await runCli({ argv: [], env, fetchImpl: fetchStub, log: () => {} }), 1);
    configured = false;
    assert.equal((await verifyLiveObservability({ env, fetchImpl: fetchStub })).ok, false);
    assert.equal((await verifyLiveObservability({ env, metricsOnly: true, fetchImpl: fetchStub })).fullGate, false);
    return { ok: true, mode: 'self-test', fullGate: false, stubDeliveryVerified: true,
      failingDeliveryRejected: true, missingWebhookRejected: true, redactionVerified: true };
  } finally {
    globalThis.fetch = originalFetch;
    resetObservabilityForTest();
  }
}

export async function runCli({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  try {
    if (argv.some(arg => !['--self-test', '--metrics-only', '--trigger-alert'].includes(arg)) ||
      argv.includes('--metrics-only') && (argv.includes('--self-test') || argv.includes('--trigger-alert'))) {
      log(JSON.stringify({ ok: false, fullGate: false, failures: ['invalid_arguments'] }));
      return 2;
    }
    const result = argv.includes('--self-test') ? await runSelfTest() : await verifyLiveObservability({ env,
      metricsOnly: argv.includes('--metrics-only'), fetchImpl });
    log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch {
    log(JSON.stringify({ ok: false, fullGate: false, failures: ['verification_failed'] }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}

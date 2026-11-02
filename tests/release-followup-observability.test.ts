import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getObservabilitySnapshot,
  recordHttpRequestMetric,
  resetObservabilityForTest,
  triggerSonicAlert,
} from '../functions/_lib/sonic/observability';
import { onRequest as handleMetrics } from '../functions/api/sonic/engine/metrics';
import { runCli, verifyLiveObservability } from '../scripts/verify-observability-and-alerts.mjs';
import type { AppEnv } from '../functions/_lib/types';

const EPOCH = Date.parse('2026-11-02T12:00:00.000Z');
const ENGINE_SECRET = 'observability_stub_engine_secret_1234567890';
const env: AppEnv = {
  SONIC_ENV: 'test', SONIC_RUNTIME: 'linux-engine',
  SONIC_ENGINE_SECRET: ENGINE_SECRET,
  SONIC_RELEASE_COMMIT: 'a'.repeat(40), SONIC_BUILD_TIME: '2026-11-02T00:00:00.000Z',
  SONIC_ALERT_WEBHOOK_URL: 'https://alerts.example.invalid/hook/private-value',
};

let fetchStub: ReturnType<typeof vi.fn>;
let payloads: any[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
  resetObservabilityForTest();
  payloads = [];
  fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
  resetObservabilityForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function record(count: number, status: number, config = env, duration = 20, path = '/api/sonic/search/nexus') {
  for (let n = 0; n < count; n += 1) recordHttpRequestMetric(path, status, duration, config);
}

async function settle() { await Promise.resolve(); await Promise.resolve(); }

function metricsRequest(method = 'POST', config: AppEnv = env, note = '') {
  return handleMetrics({ env: config, request: new Request(`https://engine.example.invalid/api/sonic/engine/metrics?action=test-alert${note ? `&note=${encodeURIComponent(note)}` : ''}`, {
    method, headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET },
  }) });
}

describe('release followup rolling observability and configured alerts', () => {
  it('expires old counts and latency while preserving cumulative totals and uses new failures after healthy history', async () => {
    record(1000, 200);
    vi.setSystemTime(EPOCH + 301_000);
    record(95, 200);
    record(5, 503);
    await settle();
    const snapshot = getObservabilitySnapshot(env);
    expect(snapshot.requests).toMatchObject({ total: 1100, status5xx: 5 });
    expect(snapshot.window).toMatchObject({ windowSec: 300, bucketSec: 1 });
    expect(snapshot.window.requests).toMatchObject({ total: 100, status5xx: 5, errorRate5xx: 0.05 });
    expect(snapshot.window.latency.search).toMatchObject({ count: 100, sampleWindow: 100, p95Ms: 20 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ code: 'HIGH_5XX_ERROR_RATE', severity: 'warning',
      metrics: { window: { requests: { total: 100, status5xx: 5 } } } });
    vi.setSystemTime(EPOCH + 602_000);
    const empty = getObservabilitySnapshot(env).window;
    expect(empty.requests).toMatchObject({ total: 0, status5xx: 0, errorRate5xx: 0 });
    expect(empty.latency.search).toMatchObject({ count: 0, sampleWindow: 0, p95Ms: 0, maxMs: 0 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('uses >2% warning, >5% paging, a minimum request count and a minimum 5xx count by default', async () => {
    record(99, 503);
    expect(fetchStub).not.toHaveBeenCalled();
    resetObservabilityForTest();
    record(98, 200);
    record(2, 503);
    expect(fetchStub).not.toHaveBeenCalled(); // 2%, and fewer than five failures
    resetObservabilityForTest();
    record(245, 200);
    record(5, 503);
    expect(fetchStub).not.toHaveBeenCalled(); // exactly 2% with five failures
    record(1, 503);
    await settle();
    expect(payloads.map(p => p.severity)).toEqual(['warning']);
    resetObservabilityForTest();
    record(95, 200);
    record(5, 503);
    await settle();
    record(1, 503);
    await settle();
    expect(payloads.slice(1).map(p => p.severity)).toEqual(['warning', 'critical']);
    record(30, 503);
    await settle();
    expect(payloads).toHaveLength(3); // no repeated alerts during cooldown
  });

  it('honors configured ratios, severity disabling and rolling-window expiry without timer loops', async () => {
    const config = { ...env, SONIC_ALERT_WINDOW_SEC: '10', SONIC_ALERT_MIN_REQUESTS: '10', SONIC_ALERT_5XX_THRESHOLD: '1',
      SONIC_ALERT_5XX_WARNING_RATIO: '0.1', SONIC_ALERT_5XX_PAGING_RATIO: '0' };
    record(9, 200, config);
    record(1, 502, config);
    expect(fetchStub).not.toHaveBeenCalled();
    record(1, 502, config);
    await settle();
    expect(payloads[0].severity).toBe('warning');
    vi.setSystemTime(EPOCH + 10_000);
    const snapshot = getObservabilitySnapshot(config);
    expect(snapshot.window.requests.total).toBe(0);
    expect(snapshot.window.from).toBe('2026-11-02T12:00:01.000Z');
    const disabled = { ...config, SONIC_ALERT_5XX_WARNING_RATIO: '0' };
    record(100, 503, disabled);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(getObservabilitySnapshot(disabled).alerts.policy).toMatchObject({ warningRatio: 0, pagingRatio: 0 });
  });

  it('expires only the oldest second and keeps exact totals for requests beyond the latency sample cap', () => {
    const config = { ...env, SONIC_ALERT_WEBHOOK_URL: '', SONIC_ALERT_WINDOW_SEC: '10' };
    record(700, 200, config, 10);
    vi.setSystemTime(EPOCH + 1000);
    record(300, 503, config, 90, '/api/music/stream');
    let window = getObservabilitySnapshot(config).window;
    expect(window.requests).toMatchObject({ total: 1000, status5xx: 300, errorRate5xx: 0.3 });
    expect(window.latency.overall.sampleWindow).toBe(512);
    expect(window.latency.search).toMatchObject({ count: 700, sampleWindow: 512 });
    vi.setSystemTime(EPOCH + 10_000);
    window = getObservabilitySnapshot(config).window;
    expect(window.requests).toMatchObject({ total: 300, status5xx: 300, errorRate5xx: 1 });
    expect(window.latency.search).toMatchObject({ count: 0, sampleWindow: 0 });
    expect(window.latency.stream).toMatchObject({ count: 300, sampleWindow: 300 });
    vi.setSystemTime(EPOCH + 11_000);
    expect(getObservabilitySnapshot(config).window.requests.total).toBe(0);
  });

  it('does not enable P95 alerts by default, but evaluates configured route P95 above threshold on successful requests', async () => {
    record(100, 200, env, 10_000);
    expect(fetchStub).not.toHaveBeenCalled();
    resetObservabilityForTest();
    const config = { ...env, SONIC_ALERT_P95_WARNING_MS: '100', SONIC_ALERT_P95_PAGING_MS: '500' };
    record(100, 200, config, 100);
    expect(fetchStub).not.toHaveBeenCalled(); // equality never breaches
    vi.setSystemTime(EPOCH + 1000);
    record(6, 200, config, 200);
    vi.setSystemTime(EPOCH + 2000);
    record(1, 200, config, 200);
    await settle();
    expect(payloads.map(p => [p.code, p.severity])).toEqual([
      ['HIGH_P95_LATENCY_OVERALL', 'warning'], ['HIGH_P95_LATENCY_SEARCH', 'warning'],
    ]);
    vi.setSystemTime(EPOCH + 3000);
    record(100, 200, config, 800);
    vi.setSystemTime(EPOCH + 4000);
    record(1, 200, config, 800);
    await settle();
    expect(payloads.slice(2).map(p => p.severity)).toEqual(['critical', 'critical']);
    vi.setSystemTime(EPOCH + 305_000);
    record(1, 200, config, 800);
    expect(payloads).toHaveLength(4); // expired samples cannot satisfy the volume floor
    expect(getObservabilitySnapshot(config).window.latency.search).toMatchObject({ sampleWindow: 1, p95Ms: 800 });
  });

  it('caps samples and sanitizes bounded configuration instead of allowing unbounded state', () => {
    const config = { ...env, SONIC_ALERT_WEBHOOK_URL: '', SONIC_ALERT_WINDOW_SEC: '999999999',
      SONIC_ALERT_MIN_REQUESTS: 'NaN', SONIC_ALERT_5XX_WARNING_RATIO: '0.2', SONIC_ALERT_5XX_PAGING_RATIO: '0.1',
      SONIC_ALERT_P95_WARNING_MS: 'Infinity' };
    record(1200, 200, config);
    const snapshot = getObservabilitySnapshot(config);
    expect(snapshot.window.windowSec).toBe(3600);
    expect(snapshot.window.latency.overall).toMatchObject({ count: 1200, sampleWindow: 512 });
    expect(snapshot.alerts.policy).toMatchObject({ minRequests: 100, warningRatio: 0.2, pagingRatio: 0.2, warningP95Ms: 0 });
    vi.setSystemTime(EPOCH - 1000);
    record(1, 200, config);
    expect(getObservabilitySnapshot(config).window.requests.total).toBe(1); // backwards clocks reset safely
  });
});

describe('release followup alert transport and endpoint honesty', () => {
  it('reports missing/unsafe webhooks as unconfigured and HTTP errors as unsuccessful delivery', async () => {
    const missing = await metricsRequest('POST', { ...env, SONIC_ALERT_WEBHOOK_URL: '' });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ ok: false, delivery: { sent: false } });
    for (const url of ['http://alerts.example.invalid/hook', 'https://user:password@example.invalid/hook', 'https://10.1.2.3/hook']) {
      const config = { ...env, SONIC_ALERT_WEBHOOK_URL: url };
      expect(getObservabilitySnapshot(config).alerts.configured).toBe(false);
      expect((await metricsRequest('POST', config)).status).toBe(503);
    }
    expect(fetchStub).not.toHaveBeenCalled();
    fetchStub.mockImplementation(async () => new Response(null, { status: 502 }));
    const failure = await metricsRequest();
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({ ok: false, delivery: { sent: false, reason: 'webhook_http_502', status: 502 } });
    expect(getObservabilitySnapshot(env).alerts.failedCount).toBe(1);
  });

  it('redacts configured secrets, cookies, OAuth parameters, headers and webhook paths in every payload field', async () => {
    const secret = 'arbitrary_sensitive_engine_99887766';
    const config = { ...env, SONIC_ENGINE_SECRET: secret, SONIC_STAGING_ACCESS_TOKEN: 'private-staging-value',
      SONIC_ENV: `test ${secret}`, EPOMAIL_CLIENT_SECRET: 'oauth-client-sensitive' };
    const summary = `${secret} private-staging-value oauth-client-sensitive ${config.SONIC_ALERT_WEBHOOK_URL} ` +
      'Bearer signed_jwt sonic_session=private_cookie https://cdn.example/a?auth=cdn_signature&code=oauth_code&state=oauth_state ' +
      'X-Sonic-Engine-Key: header_private\nCookie: other_session=third_party_cookie';
    const delivery = await triggerSonicAlert(config, { code: 'TEST_REDACTION', severity: 'warning', summary });
    expect(delivery.sent).toBe(true);
    const serialized = JSON.stringify(payloads[0]);
    for (const sensitive of [secret, 'private-staging-value', 'oauth-client-sensitive', 'private-value',
      'signed_jwt', 'private_cookie', 'cdn_signature', 'oauth_code', 'oauth_state', 'header_private', 'third_party_cookie']) expect(serialized).not.toContain(sensitive);
    expect(serialized).toContain('[REDACTED]');
    expect(fetchStub.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchStub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    fetchStub.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid' } }));
    expect(await triggerSonicAlert(config, { code: 'REDIRECT', severity: 'warning', summary: 'test' })).toMatchObject({ sent: false, status: 302 });
  });

  it('does not echo credential-bearing network errors and always records failed attempts', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchStub.mockRejectedValue(new Error(`Failed POST ${env.SONIC_ALERT_WEBHOOK_URL} ${ENGINE_SECRET}`));
    expect(await triggerSonicAlert(env, { code: 'NETWORK', severity: 'critical', summary: 'test' })).toEqual({ sent: false, reason: 'network_error' });
    expect(getObservabilitySnapshot(env).alerts).toMatchObject({ failedCount: 1, sentCount: 0 });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-value');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(ENGINE_SECRET);
  });

  it('coalesces concurrent requests, permits critical escalation, and respects explicit zero cooldown', async () => {
    let deliver!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const alert = { code: 'CONCURRENT', severity: 'warning' as const, summary: 'test' };
    const first = triggerSonicAlert(env, alert);
    expect(await triggerSonicAlert(env, alert)).toMatchObject({ sent: false, reason: 'cooldown_active' });
    deliver(new Response(null, { status: 204 }));
    await first;
    fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
    expect((await triggerSonicAlert(env, { ...alert, severity: 'critical' })).sent).toBe(true);
    expect((await triggerSonicAlert(env, alert)).sent).toBe(false);
    vi.setSystemTime(EPOCH + 301_000);
    expect((await triggerSonicAlert(env, alert)).sent).toBe(true);
    const noCooldown = { ...env, SONIC_ALERT_COOLDOWN_SEC: '0' };
    const repeated = { ...alert, code: 'ZERO_COOLDOWN' };
    expect((await triggerSonicAlert(noCooldown, repeated)).sent).toBe(true);
    expect((await triggerSonicAlert(noCooldown, repeated)).sent).toBe(true);
  });

  it('requires engine authentication before disclosing metrics or attempting delivery', async () => {
    const response = await handleMetrics({ env, request: new Request('https://engine.example.invalid/api/sonic/engine/metrics', { method: 'POST' }) });
    expect(response.status).toBe(401);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

function liveFixture() {
  const release = { releaseCommit: 'a'.repeat(40), buildTime: '2026-11-02T00:00:00.000Z', dirty: false };
  const metrics: any = { ok: true, observability: { release, latency: { overall: { p95Ms: 10 } },
    window: { requests: { total: 100, errorRate5xx: 0 } }, alerts: { configured: true } }, rateLimitConfig: { productionCompliant: true } };
  const health: any = { ok: true, readiness: { ok: true, release: { ok: true }, identity: { ok: true } }, release,
    rateLimit: { productionCompliant: true, configuredBackend: 'memory' },
    recommendEngine: { storageHealthy: true, persistenceExpected: true, storageKind: 'sqlite', disk: { ok: true, writable: true } } };
  const delivery: any = { ok: true, delivery: { sent: true, reason: 'delivered', status: 204 } };
  const fixture = { metrics, health, delivery, postStatus: 200, healthStatus: 200, fetch: vi.fn() };
  fixture.fetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json(fixture.delivery, { status: fixture.postStatus });
    if (String(input).endsWith('/health')) return Response.json(fixture.health, { status: fixture.healthStatus });
    return Response.json(fixture.metrics);
  });
  return fixture;
}

describe('release followup live verification fails closed with isolated HTTP stubs', () => {
  it('passes only on healthy release/storage/rate-limiter and actual 2xx alert delivery', async () => {
    const fixture = liveFixture();
    const result = await verifyLiveObservability({ env, fetchImpl: fixture.fetch });
    expect(result).toMatchObject({ ok: true, fullGate: true, alertResult: { sent: true, webhookStatus: 204 } });
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    expect(fixture.fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'X-Sonic-Engine-Key': ENGINE_SECRET } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns nonzero CLI status for absent alert delivery or malformed delivery claims', async () => {
    const fixture = liveFixture();
    fixture.metrics.observability.alerts.configured = false;
    const log = vi.fn();
    expect(await runCli({ argv: [], env, fetchImpl: fixture.fetch, log })).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ ok: false, fullGate: false, failures: ['alert_webhook_required'] });
    expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fixture.metrics.observability.alerts.configured = true;
    for (const delivery of [{ ok: true }, { ok: true, delivery: { sent: 'true', reason: 'delivered', status: 204 } },
      { ok: true, delivery: { sent: true, reason: 'delivered', status: 502 } },
      { ok: false, delivery: { sent: true, reason: 'delivered', status: 204 } }]) {
      fixture.delivery = delivery;
      expect(await runCli({ argv: [], env, fetchImpl: fixture.fetch, log })).toBe(1);
    }
    fixture.delivery = { ok: false, delivery: { sent: false, reason: 'webhook_http_502', status: 502 } };
    fixture.postStatus = 503;
    expect(await verifyLiveObservability({ env, fetchImpl: fixture.fetch })).toMatchObject({ ok: false, fullGate: false,
      failures: ['alert_delivery_failed'], alertResult: { sent: false, httpStatus: 503, webhookStatus: 502 } });
  });

  it.each(['release', 'storage', 'disk', 'rateLimiter', 'identity', 'readiness', 'healthHttp'])('rejects an unready %s without sending a test alert', async (kind) => {
    const fixture = liveFixture();
    if (kind === 'release') { fixture.health.readiness.release.ok = false; fixture.metrics.observability.release.releaseCommit = 'unknown'; }
    if (kind === 'storage') fixture.health.recommendEngine.storageHealthy = false;
    if (kind === 'disk') fixture.health.recommendEngine.disk.writable = false;
    if (kind === 'rateLimiter') fixture.metrics.rateLimitConfig.productionCompliant = 'true';
    if (kind === 'identity') fixture.health.readiness.identity.ok = false;
    if (kind === 'readiness') fixture.health.readiness.ok = false;
    if (kind === 'healthHttp') fixture.healthStatus = 503;
    const result = await verifyLiveObservability({ env, fetchImpl: fixture.fetch });
    expect(result.ok).toBe(false);
    expect(result.fullGate).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(fixture.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(await runCli({ argv: [], env, fetchImpl: fixture.fetch, log: () => {} })).toBe(1);
  });

  it('allows explicit metrics-only inspection without claiming the full gate or attempting alert/health calls', async () => {
    const fixture = liveFixture();
    fixture.metrics.observability.alerts.configured = false;
    fixture.metrics.observability.release.releaseCommit = 'unknown';
    expect(await verifyLiveObservability({ env, metricsOnly: true, fetchImpl: fixture.fetch })).toMatchObject({ ok: true,
      mode: 'metrics-only', fullGate: false, releaseValid: false, alertResult: { sent: false, reason: 'metrics_only_not_checked' } });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(await runCli({ argv: ['--metrics-only', '--trigger-alert'], env, fetchImpl: fixture.fetch, log: () => {} })).toBe(2);
  });

  it('rejects missing auth, HTTP errors, invalid JSON, and network failures without exposing server or transport secrets', async () => {
    const fixture = liveFixture();
    expect(await runCli({ argv: [], env: {}, fetchImpl: fixture.fetch, log: () => {} })).toBe(1);
    expect(fixture.fetch).not.toHaveBeenCalled();
    for (const stub of [async () => new Response('invalid', { status: 200 }),
      async () => Response.json({ ok: true, error: ENGINE_SECRET }, { status: 503 }),
      async () => { throw new Error(ENGINE_SECRET); }]) {
      const result = await verifyLiveObservability({ env, fetchImpl: stub });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(ENGINE_SECRET);
    }
  });

  it('sets the real CLI process exit code for missing webhook, failed delivery, and unready release with no network', () => {
    vi.useRealTimers();
    const script = fileURLToPath(new URL('../scripts/verify-observability-and-alerts.mjs', import.meta.url));
    for (const scenario of ['missing', 'delivery', 'readiness', 'success']) {
      const fixture = liveFixture();
      if (scenario === 'missing') fixture.metrics.observability.alerts.configured = false;
      if (scenario === 'delivery') {
        fixture.postStatus = 503;
        fixture.delivery = { ok: false, delivery: { sent: false, status: 502, reason: 'webhook_http_502' } };
      }
      if (scenario === 'readiness') fixture.health.readiness.release.ok = false;
      const source = `
        process.argv[1] = ${JSON.stringify(script)};
        const fixture = ${JSON.stringify(fixture)};
        globalThis.fetch = async (url, init) => {
          if (init.method === 'POST') return Response.json(fixture.delivery, { status: fixture.postStatus });
          return Response.json(String(url).endsWith('/health') ? fixture.health : fixture.metrics);
        };
        await import(${JSON.stringify(pathToFileURL(script).href)});
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, SONIC_ENGINE_SECRET: ENGINE_SECRET, SONIC_ENGINE_URL: 'https://engine.example.invalid' } });
      expect(run.status).toBe(scenario === 'success' ? 0 : 1);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: scenario === 'success', fullGate: scenario === 'success' });
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('keeps --self-test deterministic, network-free and explicit about failing delivery', () => {
    vi.useRealTimers();
    const script = fileURLToPath(new URL('../scripts/verify-observability-and-alerts.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, '--self-test'], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SONIC_ALERT_WEBHOOK_URL: 'https://never-contact.example.invalid', SONIC_RELEASE_COMMIT: 'do-not-use-process-env' } });
    expect(JSON.parse(output)).toMatchObject({ ok: true, mode: 'self-test', fullGate: false,
      failingDeliveryRejected: true, missingWebhookRejected: true, stubDeliveryVerified: true });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

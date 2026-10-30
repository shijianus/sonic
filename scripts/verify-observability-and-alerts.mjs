#!/usr/bin/env node
// Sonic Observability & Alert Notification Self-Check CLI (SONIC-P1-03)
// Usage:
//   1. Local loopback verification (spins up temporary local webhook receiver):
//        npx jiti scripts/verify-observability-and-alerts.mjs --self-test
//   2. Live Engine / Staging webhook verification:
//        SONIC_ENGINE_URL=http://127.0.0.1:18080 SONIC_ENGINE_SECRET=... node scripts/verify-observability-and-alerts.mjs

import http from 'node:http';
import assert from 'node:assert/strict';

const isSelfTest = process.argv.includes('--self-test');

async function runSelfTest() {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url);
  const { onRequest: handleEngineMetrics } = await jiti.import('../functions/api/sonic/engine/metrics');
  const { recordHttpRequestMetric, resetObservabilityForTest } = await jiti.import(
    '../functions/_lib/sonic/observability'
  );

  resetObservabilityForTest();
  const captured = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const { port } = receiver.address();
  const engineSecret = 'self_check_engine_secret_minimum_32_characters_long';

  try {
    const env = {
      SONIC_RUNTIME: 'linux-engine',
      SONIC_ENV: 'staging',
      SONIC_RELEASE_COMMIT: process.env.SONIC_RELEASE_COMMIT || 'local-self-test',
      SONIC_ENGINE_SECRET: engineSecret,
      SONIC_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook`,
      SONIC_ALERT_ALLOW_LOCALHOST: '1',
    };

    recordHttpRequestMetric('/api/sonic/search/nexus', 200, 38, env);
    recordHttpRequestMetric('/api/music/stream', 206, 84, env);

    const getResp = await handleEngineMetrics({
      request: new Request('http://127.0.0.1:18080/api/sonic/engine/metrics', {
        headers: { 'X-Sonic-Engine-Key': engineSecret },
      }),
      env,
    });
    assert.equal(getResp.status, 200);
    const snapshot = await getResp.json();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.observability.requests.total, 2);

    const postResp = await handleEngineMetrics({
      request: new Request(
        'http://127.0.0.1:18080/api/sonic/engine/metrics?action=test-alert&note=stream%3Fauth%3Dsensitive_sig_value',
        {
          method: 'POST',
          headers: { 'X-Sonic-Engine-Key': engineSecret },
        },
      ),
      env,
    });
    assert.equal(postResp.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].code, 'MANUAL_ALERT_SELF_CHECK');
    assert.ok(!captured[0].summary.includes('sensitive_sig_value'), 'Sensitive query param must be redacted');

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'self-test',
          alertDelivered: true,
          alertCode: captured[0].code,
          redactionVerified: true,
          overallP95Ms: snapshot.observability.latency.overall.p95Ms,
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
}

async function runLiveCheck() {
  const baseUrl = (process.env.SONIC_ENGINE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
  const secret = (process.env.SONIC_ENGINE_SECRET || '').trim();
  if (!secret || secret.length < 32) {
    console.error('ERROR: SONIC_ENGINE_SECRET (>= 32 chars) is required for live metrics/alert verification.');
    process.exit(2);
  }

  const headers = { 'X-Sonic-Engine-Key': secret };
  const StagingToken = (process.env.SONIC_STAGING_ACCESS_TOKEN || '').trim();
  if (StagingToken) headers['X-Sonic-Staging-Token'] = StagingToken;

  const metricsResp = await fetch(`${baseUrl}/api/sonic/engine/metrics`, { headers });
  const metricsJson = await metricsResp.json();
  if (!metricsResp.ok) {
    console.error('Metrics check failed:', metricsResp.status, metricsJson);
    process.exit(1);
  }

  const alertConfigured = Boolean(metricsJson?.observability?.alerts?.configured);
  let alertResult = { sent: false, reason: 'not_configured' };
  if (alertConfigured || process.argv.includes('--trigger-alert')) {
    const triggerResp = await fetch(`${baseUrl}/api/sonic/engine/metrics?action=test-alert`, {
      method: 'POST',
      headers,
    });
    const triggerJson = await triggerResp.json();
    alertResult = triggerJson.delivery || { sent: triggerResp.ok, status: triggerResp.status };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        target: baseUrl,
        release: metricsJson.observability?.release,
        requests: metricsJson.observability?.requests,
        overallP95Ms: metricsJson.observability?.latency?.overall?.p95Ms,
        rateLimitConfig: metricsJson.rateLimitConfig,
        disk: metricsJson.disk,
        alertConfigured,
        alertResult,
      },
      null,
      2,
    ),
  );
}

if (isSelfTest) {
  runSelfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  runLiveCheck().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

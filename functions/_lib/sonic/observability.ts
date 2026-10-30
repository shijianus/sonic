// Sonic Gateway & Linux Engine — Minimal Production/Beta Observability & Redacted Alerting
// Web-standard compatible (Cloudflare Pages Functions + Node.js 22 Linux Engine).
// Strictly enforces secret/token/cookie/signed-URL redaction across metrics, logs, and alerts.

import type { AppEnv } from '../types';
import { isEnvEnabled } from './config';

export type RouteMetricGroup =
  | 'overall'
  | 'search'
  | 'stream'
  | 'lyrics'
  | 'recommend'
  | 'auth'
  | 'cover'
  | 'engine'
  | 'other';

export type RateLimitBackendKind = 'native' | 'kv' | 'memory' | 'auth-gate' | 'fail-closed';

const MAX_LATENCY_SAMPLES = 512;

interface RollingSamples {
  values: number[];
  cursor: number;
  totalCount: number;
  max: number;
}

function createRollingSamples(): RollingSamples {
  return { values: [], cursor: 0, totalCount: 0, max: 0 };
}

function pushSample(ring: RollingSamples, valueMs: number): void {
  const clean = Math.max(0, Math.round(Number.isFinite(valueMs) ? valueMs : 0));
  ring.totalCount += 1;
  if (clean > ring.max) ring.max = clean;
  if (ring.values.length < MAX_LATENCY_SAMPLES) {
    ring.values.push(clean);
  } else {
    ring.values[ring.cursor] = clean;
    ring.cursor = (ring.cursor + 1) % MAX_LATENCY_SAMPLES;
  }
}

function summarizeSamples(ring: RollingSamples): {
  count: number;
  sampleWindow: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
} {
  if (ring.values.length === 0) {
    return { count: 0, sampleWindow: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const sorted = [...ring.values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  return {
    count: ring.totalCount,
    sampleWindow: sorted.length,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: ring.max,
  };
}

interface ObservabilityState {
  bootAtMs: number;
  bootAtIso: string;
  requests: {
    total: number;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
  };
  latency: Record<RouteMetricGroup, RollingSamples>;
  stream: {
    resolvedOk: number;
    proxied200: number;
    proxied206: number;
    errors: {
      '403': number;
      '404': number;
      '415': number;
      '416': number;
      '429': number;
      '5xx': number;
      timeout: number;
      degraded: number;
    };
  };
  oauth: {
    loginStarted: number;
    callbackSuccess: number;
    logoutCount: number;
    revokeCount: number;
    errorsByCode: Record<string, number>;
  };
  rateLimit: {
    allowed: number;
    rejected429: number;
    authRejected401: number;
    failClosed503: number;
    degradedEvents: number;
    backendCounts: Record<RateLimitBackendKind, number>;
  };
  licensing: {
    blockedByPolicy: number;
    blockedBySource: Record<string, number>;
  };
  sqlite: {
    readErrors: number;
    writeErrors: number;
    memoryFallbacks: number;
  };
  alerts: {
    sentCount: number;
    suppressedByCooldown: number;
    failedCount: number;
    lastAlertAt?: string;
    lastAlertCode?: string;
    cooldownUntilByCode: Map<string, number>;
  };
}

function createInitialState(): ObservabilityState {
  const now = Date.now();
  return {
    bootAtMs: now,
    bootAtIso: new Date(now).toISOString(),
    requests: {
      total: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
    },
    latency: {
      overall: createRollingSamples(),
      search: createRollingSamples(),
      stream: createRollingSamples(),
      lyrics: createRollingSamples(),
      recommend: createRollingSamples(),
      auth: createRollingSamples(),
      cover: createRollingSamples(),
      engine: createRollingSamples(),
      other: createRollingSamples(),
    },
    stream: {
      resolvedOk: 0,
      proxied200: 0,
      proxied206: 0,
      errors: {
        '403': 0,
        '404': 0,
        '415': 0,
        '416': 0,
        '429': 0,
        '5xx': 0,
        timeout: 0,
        degraded: 0,
      },
    },
    oauth: {
      loginStarted: 0,
      callbackSuccess: 0,
      logoutCount: 0,
      revokeCount: 0,
      errorsByCode: {},
    },
    rateLimit: {
      allowed: 0,
      rejected429: 0,
      authRejected401: 0,
      failClosed503: 0,
      degradedEvents: 0,
      backendCounts: {
        native: 0,
        kv: 0,
        memory: 0,
        'auth-gate': 0,
        'fail-closed': 0,
      },
    },
    licensing: {
      blockedByPolicy: 0,
      blockedBySource: {},
    },
    sqlite: {
      readErrors: 0,
      writeErrors: 0,
      memoryFallbacks: 0,
    },
    alerts: {
      sentCount: 0,
      suppressedByCooldown: 0,
      failedCount: 0,
      cooldownUntilByCode: new Map<string, number>(),
    },
  };
}

let state: ObservabilityState = createInitialState();
let lastDegradedLogAtMs = 0;

export function resetObservabilityForTest(): void {
  state = createInitialState();
  lastDegradedLogAtMs = 0;
}

// Strict redaction of tokens, API keys, cookies, OAuth codes/verifiers, and signed URL query params.
const SENSITIVE_PARAM_PATTERN =
  /([?&](?:auth|authorization|token|access[_-]?token|refresh[_-]?token|key|api[_-]?key|apikey|sign|signature|sig|vkey|guid|wmid|expires?|expiry|nonce|session|cookie|code|code[_-]?verifier|state|secret|client[_-]?secret|staging[_-]?token)=)[^&#\s"']+/gi;

export function redactSensitiveString(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/sonic_live_[A-Za-z0-9._-]+/g, 'sonic_live_[REDACTED]')
    .replace(/solara_live_[A-Za-z0-9._-]+/g, 'solara_live_[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(sonic_session|sonic_oauth_state|sonic_oauth_verifier|sonic_staging_access)=[^;\s"']+/gi, '$1=[REDACTED]')
    .replace(SENSITIVE_PARAM_PATTERN, '$1[REDACTED]')
    .slice(0, 512);
}

export function classifyRouteGroup(pathname: string): RouteMetricGroup {
  const p = (pathname || '/').toLowerCase();
  if (p.startsWith('/api/auth/')) return 'auth';
  if (p.includes('/stream') || p === '/proxy' || p.startsWith('/api/sonic/test-audio')) return 'stream';
  if (p.includes('/search')) return 'search';
  if (p.includes('/lyric')) return 'lyrics';
  if (p.includes('/recommend') || p === '/api/sonic/events' || p.includes('/random')) return 'recommend';
  if (p.includes('/cover') || p.includes('/palette')) return 'cover';
  if (p.startsWith('/api/sonic/engine/')) return 'engine';
  return 'other';
}

export function getReleaseMetadata(env?: AppEnv): {
  version: string;
  releaseCommit: string;
  environment: string;
  buildTime?: string;
} {
  const e = (env || {}) as Record<string, any>;
  const procEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const rawCommit = String(
    e.SONIC_RELEASE_COMMIT ||
      e.CF_PAGES_COMMIT_SHA ||
      procEnv.SONIC_RELEASE_COMMIT ||
      procEnv.CF_PAGES_COMMIT_SHA ||
      'unknown',
  ).trim();
  const rawEnv = String(
    e.SONIC_ENV ||
      (e.CF_PAGES_BRANCH === 'main' ? 'production' : e.CF_PAGES_BRANCH ? 'staging' : '') ||
      procEnv.SONIC_ENV ||
      procEnv.NODE_ENV ||
      'development',
  ).trim();
  const buildTime = String(e.SONIC_BUILD_TIME || procEnv.SONIC_BUILD_TIME || '').trim() || undefined;
  return {
    version: '2.2.0',
    releaseCommit: /^[a-f0-9]{7,40}$/i.test(rawCommit) ? rawCommit : rawCommit.slice(0, 40) || 'unknown',
    environment: rawEnv || 'development',
    ...(buildTime ? { buildTime } : {}),
  };
}

export function recordHttpRequestMetric(
  pathname: string,
  status: number,
  durationMs: number,
  env?: AppEnv,
): void {
  state.requests.total += 1;
  if (status >= 500) state.requests.status5xx += 1;
  else if (status >= 400) state.requests.status4xx += 1;
  else if (status >= 300) state.requests.status3xx += 1;
  else if (status >= 200) state.requests.status2xx += 1;

  const group = classifyRouteGroup(pathname);
  pushSample(state.latency.overall, durationMs);
  pushSample(state.latency[group], durationMs);

  // Automatic 5xx spike alert check
  if (status >= 500 && env?.SONIC_ALERT_WEBHOOK_URL) {
    const threshold = Math.max(
      1,
      parseInt(String(env.SONIC_ALERT_5XX_THRESHOLD || '5'), 10) || 5,
    );
    const rate = state.requests.total > 0 ? state.requests.status5xx / state.requests.total : 0;
    if (state.requests.status5xx >= threshold && rate >= 0.1) {
      void triggerSonicAlert(env, {
        code: 'HIGH_5XX_ERROR_RATE',
        severity: 'critical',
        summary: `Sonic 5xx threshold breached (${state.requests.status5xx}/${state.requests.total}, ${(
          rate * 100
        ).toFixed(1)}%) on route group ${group}`,
      });
    }
  }
}

export function recordStreamMetric(
  kind:
    | 'resolved_ok'
    | 'proxied_200'
    | 'proxied_206'
    | 'err_403'
    | 'err_404'
    | 'err_415'
    | 'err_416'
    | 'err_429'
    | 'err_5xx'
    | 'err_timeout'
    | 'degraded',
): void {
  switch (kind) {
    case 'resolved_ok':
      state.stream.resolvedOk += 1;
      break;
    case 'proxied_200':
      state.stream.proxied200 += 1;
      break;
    case 'proxied_206':
      state.stream.proxied206 += 1;
      break;
    case 'err_403':
      state.stream.errors['403'] += 1;
      break;
    case 'err_404':
      state.stream.errors['404'] += 1;
      break;
    case 'err_415':
      state.stream.errors['415'] += 1;
      break;
    case 'err_416':
      state.stream.errors['416'] += 1;
      break;
    case 'err_429':
      state.stream.errors['429'] += 1;
      break;
    case 'err_5xx':
      state.stream.errors['5xx'] += 1;
      break;
    case 'err_timeout':
      state.stream.errors.timeout += 1;
      break;
    case 'degraded':
      state.stream.errors.degraded += 1;
      break;
  }
}

export function recordOAuthMetric(
  event: 'login_started' | 'callback_success' | 'logout' | 'revoke' | 'error',
  errorCode?: string,
): void {
  if (event === 'login_started') state.oauth.loginStarted += 1;
  else if (event === 'callback_success') state.oauth.callbackSuccess += 1;
  else if (event === 'logout') state.oauth.logoutCount += 1;
  else if (event === 'revoke') state.oauth.revokeCount += 1;
  else if (event === 'error') {
    const safeCode = (errorCode || 'OAUTH_ERROR').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64);
    state.oauth.errorsByCode[safeCode] = (state.oauth.errorsByCode[safeCode] || 0) + 1;
  }
}

export function recordRateLimitMetric(opts: {
  allowed: boolean;
  backend: RateLimitBackendKind;
  degraded: boolean;
  isAuthRequired?: boolean;
  isFailClosed?: boolean;
  scope?: string;
  env?: AppEnv;
}): void {
  state.rateLimit.backendCounts[opts.backend] =
    (state.rateLimit.backendCounts[opts.backend] || 0) + 1;
  if (opts.isFailClosed) {
    state.rateLimit.failClosed503 += 1;
  } else if (opts.isAuthRequired) {
    state.rateLimit.authRejected401 += 1;
  } else if (opts.allowed) {
    state.rateLimit.allowed += 1;
  } else {
    state.rateLimit.rejected429 += 1;
  }

  if (opts.degraded) {
    state.rateLimit.degradedEvents += 1;
    const now = Date.now();
    if (now - lastDegradedLogAtMs >= 60_000) {
      lastDegradedLogAtMs = now;
      console.warn(
        JSON.stringify({
          type: 'rate_limit_degraded',
          backend: opts.backend,
          scope: opts.scope || 'api',
          degradedEvents: state.rateLimit.degradedEvents,
          note: 'Cloudflare native RATE_LIMITER binding is absent or degraded; multi-isolate atomicity is not guaranteed',
        }),
      );
    }
  }
}

export function recordLicensingBlockMetric(source: string): void {
  state.licensing.blockedByPolicy += 1;
  const safe = (source || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
  state.licensing.blockedBySource[safe] = (state.licensing.blockedBySource[safe] || 0) + 1;
}

export function recordSqliteMetric(kind: 'read_error' | 'write_error' | 'memory_fallback'): void {
  if (kind === 'read_error') state.sqlite.readErrors += 1;
  else if (kind === 'write_error') state.sqlite.writeErrors += 1;
  else if (kind === 'memory_fallback') state.sqlite.memoryFallbacks += 1;
}

export function getObservabilitySnapshot(env?: AppEnv) {
  const now = Date.now();
  const total = state.requests.total;
  const errorRate5xx = total > 0 ? Number((state.requests.status5xx / total).toFixed(4)) : 0;
  const meta = getReleaseMetadata(env);

  return {
    release: meta,
    bootAt: state.bootAtIso,
    uptimeSec: Math.max(0, Math.floor((now - state.bootAtMs) / 1000)),
    requests: {
      ...state.requests,
      errorRate5xx,
    },
    latency: {
      overall: summarizeSamples(state.latency.overall),
      search: summarizeSamples(state.latency.search),
      stream: summarizeSamples(state.latency.stream),
      lyrics: summarizeSamples(state.latency.lyrics),
      recommend: summarizeSamples(state.latency.recommend),
      auth: summarizeSamples(state.latency.auth),
      cover: summarizeSamples(state.latency.cover),
      engine: summarizeSamples(state.latency.engine),
    },
    stream: {
      resolvedOk: state.stream.resolvedOk,
      proxied200: state.stream.proxied200,
      proxied206: state.stream.proxied206,
      errors: { ...state.stream.errors },
    },
    oauth: {
      loginStarted: state.oauth.loginStarted,
      callbackSuccess: state.oauth.callbackSuccess,
      logoutCount: state.oauth.logoutCount,
      revokeCount: state.oauth.revokeCount,
      errorsByCode: { ...state.oauth.errorsByCode },
    },
    rateLimit: {
      allowed: state.rateLimit.allowed,
      rejected429: state.rateLimit.rejected429,
      authRejected401: state.rateLimit.authRejected401,
      failClosed503: state.rateLimit.failClosed503,
      degradedEvents: state.rateLimit.degradedEvents,
      backendCounts: { ...state.rateLimit.backendCounts },
    },
    licensing: {
      blockedByPolicy: state.licensing.blockedByPolicy,
      blockedBySource: { ...state.licensing.blockedBySource },
    },
    sqlite: { ...state.sqlite },
    alerts: {
      configured: Boolean(env?.SONIC_ALERT_WEBHOOK_URL),
      sentCount: state.alerts.sentCount,
      suppressedByCooldown: state.alerts.suppressedByCooldown,
      failedCount: state.alerts.failedCount,
      lastAlertAt: state.alerts.lastAlertAt || null,
      lastAlertCode: state.alerts.lastAlertCode || null,
    },
  };
}

function normalizeAlertWebhookUrl(raw: unknown, allowLocalhost: boolean): string | null {
  const val = typeof raw === 'string' ? raw.trim() : '';
  if (!val) return null;
  try {
    const parsed = new URL(val);
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocal) {
      return allowLocalhost && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        ? parsed.toString()
        : null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function triggerSonicAlert(
  env: AppEnv | undefined,
  alert: {
    code: string;
    severity: 'warning' | 'critical';
    summary: string;
    bypassCooldown?: boolean;
  },
): Promise<{ sent: boolean; reason: string; status?: number }> {
  const allowLocal = isEnvEnabled(env?.SONIC_ALERT_ALLOW_LOCALHOST, false);
  const webhookUrl = normalizeAlertWebhookUrl(env?.SONIC_ALERT_WEBHOOK_URL, allowLocal);
  if (!webhookUrl) {
    return { sent: false, reason: 'webhook_not_configured_or_unsafe' };
  }

  const now = Date.now();
  const cooldownSec = Math.max(
    0,
    parseInt(String(env?.SONIC_ALERT_COOLDOWN_SEC ?? '300'), 10) || 300,
  );
  const safeCode = alert.code.replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64);
  const until = state.alerts.cooldownUntilByCode.get(safeCode) || 0;
  if (!alert.bypassCooldown && cooldownSec > 0 && now < until) {
    state.alerts.suppressedByCooldown += 1;
    return { sent: false, reason: 'cooldown_active' };
  }

  state.alerts.cooldownUntilByCode.set(safeCode, now + cooldownSec * 1000);
  const release = getReleaseMetadata(env);
  const redactedSummary = redactSensitiveString(alert.summary);
  const timestamp = new Date(now).toISOString();

  const payload = {
    brand: 'Sonic',
    alertVersion: '1.0',
    severity: alert.severity,
    code: safeCode,
    summary: redactedSummary,
    text: `[Sonic ${alert.severity.toUpperCase()}] ${safeCode}: ${redactedSummary} (env=${release.environment}, sha=${release.releaseCommit})`,
    timestamp,
    release,
    metrics: {
      requests: state.requests,
      p95Ms: summarizeSamples(state.latency.overall).p95Ms,
      streamErrors: state.stream.errors,
      sqlite: state.sqlite,
      rateLimitDegraded: state.rateLimit.degradedEvents,
    },
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Sonic-Alert-Dispatcher/2.2',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    resp.body?.cancel?.().catch(() => {});
    if (!resp.ok) {
      state.alerts.failedCount += 1;
      return { sent: false, reason: `webhook_http_${resp.status}`, status: resp.status };
    }
    state.alerts.sentCount += 1;
    state.alerts.lastAlertAt = timestamp;
    state.alerts.lastAlertCode = safeCode;
    return { sent: true, reason: 'delivered', status: resp.status };
  } catch (err: any) {
    state.alerts.failedCount += 1;
    console.warn(
      JSON.stringify({
        type: 'alert_delivery_failed',
        code: safeCode,
        error: redactSensitiveString(err?.message || 'network_error'),
      }),
    );
    return { sent: false, reason: 'network_error' };
  }
}

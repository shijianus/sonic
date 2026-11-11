// Sonic Gateway & Linux Engine — Minimal Production/Beta Observability & Redacted Alerting
// Web-standard compatible (Cloudflare Pages Functions + Node.js 22 Linux Engine).
// Strictly enforces secret/token/cookie/signed-URL redaction across metrics, logs, and alerts.

import type { AppEnv } from '../types';
import { isEnvEnabled } from './config';
import { isProductionEnvironment } from './environment';
import { COMPILED_RELEASE } from './compiled-release';

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
const ROUTE_GROUPS: RouteMetricGroup[] = ['overall', 'search', 'stream', 'lyrics', 'recommend', 'auth', 'cover', 'engine', 'other'];

interface RequestCounts {
  total: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
}

function emptyCounts(): RequestCounts {
  return { total: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 };
}

function countRequest(counts: RequestCounts, status: number): void {
  counts.total += 1;
  if (status >= 500) counts.status5xx += 1;
  else if (status >= 400) counts.status4xx += 1;
  else if (status >= 300) counts.status3xx += 1;
  else if (status >= 200) counts.status2xx += 1;
}

function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function getAlertPolicy(env?: AppEnv) {
  const warningRatio = boundedNumber(env?.SONIC_ALERT_5XX_WARNING_RATIO, 0.02, 0, 1);
  const pagingRatio = boundedNumber(env?.SONIC_ALERT_5XX_PAGING_RATIO, 0.05, 0, 1);
  const warningMs = boundedNumber(env?.SONIC_ALERT_P95_WARNING_MS, 0, 0, 3_600_000);
  const pagingMs = boundedNumber(env?.SONIC_ALERT_P95_PAGING_MS, 0, 0, 3_600_000);
  return {
    windowSec: Math.floor(boundedNumber(env?.SONIC_ALERT_WINDOW_SEC, 300, 10, 3600)),
    minRequests: Math.floor(boundedNumber(env?.SONIC_ALERT_MIN_REQUESTS, 100, 1, 1_000_000)),
    min5xx: Math.floor(boundedNumber(env?.SONIC_ALERT_5XX_THRESHOLD, 5, 1, 1_000_000)),
    // A zero threshold disables that severity; paging cannot precede an enabled warning.
    warningRatio,
    pagingRatio: pagingRatio > 0 ? Math.max(warningRatio, pagingRatio) : 0,
    warningP95Ms: warningMs,
    pagingP95Ms: pagingMs > 0 ? Math.max(warningMs, pagingMs) : 0,
  };
}

type GroupCounts = Record<RouteMetricGroup, number>;
interface RequestBucket {
  counts: RequestCounts;
  groups: Partial<GroupCounts>;
}
interface RequestWindow {
  windowSec: number;
  lastSec: number;
  startedAtMs: number;
  buckets: Array<RequestBucket | undefined>;
  counts: RequestCounts;
  groups: GroupCounts;
}

let requestWindow: RequestWindow | undefined;
let lastP95EvaluationAtMs = -Infinity;

// One bucket per second, at most 3600 buckets, with no timers or per-request history.
// The oldest partial second is excluded. Counts and timed latency samples share this boundary.
function advanceRequestWindow(windowSec: number, now: number): RequestWindow {
  const nowSec = Math.floor(now / 1000);
  if (!requestWindow || requestWindow.windowSec !== windowSec || nowSec < requestWindow.lastSec) {
    lastP95EvaluationAtMs = -Infinity;
    requestWindow = {
      windowSec,
      lastSec: nowSec,
      startedAtMs: now,
      buckets: new Array(windowSec),
      counts: emptyCounts(),
      groups: Object.fromEntries(ROUTE_GROUPS.map(group => [group, 0])) as GroupCounts,
    };
  }
  const window = requestWindow;
  const elapsed = nowSec - window.lastSec;
  if (elapsed >= windowSec) {
    window.buckets.fill(undefined);
    window.counts = emptyCounts();
    for (const group of ROUTE_GROUPS) window.groups[group] = 0;
  } else {
    for (let second = window.lastSec + 1; second <= nowSec; second += 1) {
      const index = second % windowSec;
      const expired = window.buckets[index];
      if (!expired) continue;
      for (const key of Object.keys(expired.counts) as Array<keyof RequestCounts>) window.counts[key] -= expired.counts[key];
      for (const group of ROUTE_GROUPS) window.groups[group] -= expired.groups[group] || 0;
      window.buckets[index] = undefined;
    }
  }
  window.lastSec = nowSec;
  return window;
}

function windowStart(window: RequestWindow): number {
  return Math.max(window.startedAtMs, (window.lastSec - window.windowSec + 1) * 1000);
}

interface RollingSamples {
  values: number[];
  recordedAtMs: number[];
  cursor: number;
  totalCount: number;
  max: number;
}

function createRollingSamples(): RollingSamples {
  return { values: [], recordedAtMs: [], cursor: 0, totalCount: 0, max: 0 };
}

function pushSample(ring: RollingSamples, valueMs: number, now: number): void {
  const clean = Math.max(0, Math.round(Number.isFinite(valueMs) ? valueMs : 0));
  ring.totalCount += 1;
  if (clean > ring.max) ring.max = clean;
  if (ring.values.length < MAX_LATENCY_SAMPLES) {
    ring.values.push(clean);
    ring.recordedAtMs.push(now);
  } else {
    ring.values[ring.cursor] = clean;
    ring.recordedAtMs[ring.cursor] = now;
    ring.cursor = (ring.cursor + 1) % MAX_LATENCY_SAMPLES;
  }
}

function summarizeSamples(ring: RollingSamples, sinceMs?: number, now = Date.now(), count = ring.totalCount): {
  count: number;
  sampleWindow: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
} {
  const sorted = ring.values.filter((_, index) => sinceMs === undefined ||
    ring.recordedAtMs[index] >= sinceMs && ring.recordedAtMs[index] <= now).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count, sampleWindow: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  return {
    count,
    sampleWindow: sorted.length,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: sinceMs === undefined ? ring.max : sorted[sorted.length - 1],
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
    body: Record<'engine' | 'http', { started: number; active: number; completed: number; cancelled: number; error: number; timeout: number }>;
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
    inFlight: Set<string>;
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
      body: {
        engine: { started: 0, active: 0, completed: 0, cancelled: 0, error: 0, timeout: 0 },
        http: { started: 0, active: 0, completed: 0, cancelled: 0, error: 0, timeout: 0 },
      },
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
      inFlight: new Set<string>(),
    },
  };
}

let state: ObservabilityState = createInitialState();
let lastDegradedLogAtMs = 0;

export function resetObservabilityForTest(): void {
  state = createInitialState();
  requestWindow = undefined;
  lastP95EvaluationAtMs = -Infinity;
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
    .replace(/((?:authorization|x-sonic-engine-key|x-sonic-staging-token|x-api-key)\s*[=:]\s*)[^\r\n,;]+/gi, '$1[REDACTED]')
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:[a-z0-9_-]*(?:secret|password)|access[_-]?token|refresh[_-]?token)\s*=\s*)[^\s&;,"']+/gi, '$1[REDACTED]')
    .replace(/((?:__Host-)?(?:sonic_session|sonic_access|sonic_staging_access)|sonic_oauth_state|sonic_oauth_verifier)=[^;\s"']+/gi, '$1=[REDACTED]')
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

export interface ReleaseMetadata {
  version: string;
  releaseCommit: string;
  environment: string;
  buildTime?: string;
  releaseId?: string;
  sourceDigest?: string;
  pagesArtifactDigest?: string;
  engineIdentityCompiled?: true;
  dirty: boolean;
}

export function getReleaseMetadata(env?: AppEnv): ReleaseMetadata {
  const e = (env || {}) as Record<string, any>;
  const procEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  const compiled = COMPILED_RELEASE;
  const rawCommit = String(compiled ? compiled.baseCommit : e.SONIC_RELEASE_COMMIT || e.CF_PAGES_COMMIT_SHA || procEnv.SONIC_RELEASE_COMMIT || procEnv.CF_PAGES_COMMIT_SHA || 'unknown').trim();
  // Keep the reported environment aligned with the same fail-closed policy used
  // by access and content licensing. A Pages preview without an explicit
  // environment is treated as production, not staging.
  const explicitEnv = String(e.SONIC_ENV || procEnv.SONIC_ENV || '').trim().toLowerCase();
  const production = isProductionEnvironment(env);
  const rawEnv = explicitEnv
    ? (production ? 'production' : explicitEnv)
    : production
      ? 'production'
      : String(e.CF_PAGES_BRANCH ? 'staging' : (procEnv.NODE_ENV || 'development')).trim().toLowerCase();
  const buildTime = String(compiled ? compiled.buildTime || '' : e.SONIC_BUILD_TIME || procEnv.SONIC_BUILD_TIME || '').trim();
  const releaseId = String(compiled ? compiled.releaseId || '' : e.SONIC_RELEASE_ID || procEnv.SONIC_RELEASE_ID || '').trim();
  const sourceDigest = String(compiled ? compiled.sourceDigest || '' : e.SONIC_SOURCE_DIGEST || procEnv.SONIC_SOURCE_DIGEST || '').trim();
  const pagesArtifactDigest = compiled?.pagesArtifactDigest;
  return {
    version: '2.2.0',
    releaseCommit: /^[a-f0-9]{7,40}$/i.test(rawCommit) ? rawCommit : 'unknown',
    environment: rawEnv || 'development',
    ...(buildTime && Number.isFinite(Date.parse(buildTime)) ? { buildTime } : {}),
    ...(releaseId && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(releaseId) ? { releaseId } : {}),
    ...(/^[a-f0-9]{64}$/i.test(sourceDigest) ? { sourceDigest } : {}),
    ...(pagesArtifactDigest && /^[a-f0-9]{64}$/.test(pagesArtifactDigest) ? { pagesArtifactDigest } : {}),
    ...(compiled?.engineIdentityCompiled === true ? { engineIdentityCompiled: true } : {}),
    dirty: compiled ? compiled.dirty === true : isEnvEnabled(e.SONIC_RELEASE_DIRTY ?? procEnv.SONIC_RELEASE_DIRTY, false),
  };
}

export function getReleaseReadiness(env?: AppEnv): { required: boolean; ok: boolean; error?: string } {
  const release = getReleaseMetadata(env);
  const required = isEnvEnabled(env?.SONIC_REQUIRE_RELEASE_METADATA, release.environment.toLowerCase() === 'production');
  const valid = release.releaseCommit !== 'unknown' && Boolean(release.buildTime) &&
    (!release.dirty || Boolean(release.releaseId && release.sourceDigest));
  return { required, ok: !required || valid, ...(!valid ? { error: 'release_metadata_missing_or_invalid' } : {}) };
}

function alertSeverity(value: number, warning: number, paging: number): 'warning' | 'critical' | undefined {
  if (paging > 0 && value > paging) return 'critical';
  if (warning > 0 && value > warning) return 'warning';
  return undefined;
}

function getWindowSnapshot(env?: AppEnv, now = Date.now()) {
  const policy = getAlertPolicy(env);
  const window = advanceRequestWindow(policy.windowSec, now);
  const fromMs = windowStart(window);
  const latency = Object.fromEntries(ROUTE_GROUPS.map(group => [group,
    summarizeSamples(state.latency[group], fromMs, now, window.groups[group]),
  ])) as Record<RouteMetricGroup, ReturnType<typeof summarizeSamples>>;
  return {
    windowSec: policy.windowSec,
    bucketSec: 1,
    from: new Date(fromMs).toISOString(),
    to: new Date(now).toISOString(),
    observedSec: Math.max(0, (now - fromMs) / 1000),
    requests: {
      ...window.counts,
      errorRate5xx: window.counts.total > 0 ? window.counts.status5xx / window.counts.total : 0,
    },
    latency,
  };
}

export function recordHttpRequestMetric(
  pathname: string,
  status: number,
  durationMs: number,
  env?: AppEnv,
): void {
  const now = Date.now();
  const policy = getAlertPolicy(env);
  const window = advanceRequestWindow(policy.windowSec, now);
  const group = classifyRouteGroup(pathname);
  const index = window.lastSec % window.windowSec;
  const bucket = window.buckets[index] ||= { counts: emptyCounts(), groups: {} };
  countRequest(state.requests, status);
  countRequest(window.counts, status);
  countRequest(bucket.counts, status);
  for (const key of ['overall', group] as RouteMetricGroup[]) {
    window.groups[key] += 1;
    bucket.groups[key] = (bucket.groups[key] || 0) + 1;
    pushSample(state.latency[key], durationMs, now);
  }

  if (!env?.SONIC_ALERT_WEBHOOK_URL || window.counts.total < policy.minRequests) return;
  const rate = window.counts.status5xx / window.counts.total;
  const severity = alertSeverity(rate, policy.warningRatio, policy.pagingRatio);
  if (severity && window.counts.status5xx >= policy.min5xx) {
    void triggerSonicAlert(env, {
      code: 'HIGH_5XX_ERROR_RATE',
      severity,
      summary: `Sonic rolling ${policy.windowSec}s 5xx rate ${window.counts.status5xx}/${window.counts.total} (${(rate * 100).toFixed(2)}%)`,
    });
  }

  // Percentiles cost a bounded sort. Evaluate at most once/second, only if explicitly enabled.
  if ((!policy.warningP95Ms && !policy.pagingP95Ms) || now - lastP95EvaluationAtMs < 1000) return;
  lastP95EvaluationAtMs = now;
  for (const key of ROUTE_GROUPS) {
    if (window.groups[key] < policy.minRequests) continue;
    const sample = summarizeSamples(state.latency[key], windowStart(window), now, window.groups[key]);
    if (sample.sampleWindow < Math.min(policy.minRequests, MAX_LATENCY_SAMPLES)) continue;
    const latencySeverity = alertSeverity(sample.p95Ms, policy.warningP95Ms, policy.pagingP95Ms);
    if (!latencySeverity) continue;
    void triggerSonicAlert(env, {
      code: `HIGH_P95_LATENCY_${key.toUpperCase()}`,
      severity: latencySeverity,
      summary: `Sonic ${key} rolling ${policy.windowSec}s P95 ${sample.p95Ms}ms (${sample.sampleWindow} recent samples, ${sample.count} requests)`,
    });
  }
}

export function recordStreamBodyMetric(
  kind: 'started' | 'completed' | 'cancelled' | 'error' | 'timeout',
  scope: 'engine' | 'http' = 'engine',
): void {
  const body = state.stream.body[scope];
  body[kind] += 1;
  if (kind === 'started') body.active += 1;
  else body.active = Math.max(0, body.active - 1);
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

const KNOWN_LICENSING_SOURCES = new Set([
  'synthetic', 'netease', 'ncm', 'qq', 'tencent', 'kugou', 'kuwo',
  'amll', 'lrclib', 'apple', 'ytmusic', 'listenbrainz', 'gdstudio', 'lyriva', 'unblock',
  'sonic', 'palette', 'palette-url', 'legacy-proxy', 'forward-url', 'direct-cover-url', 'unknown',
]);

export function recordLicensingBlockMetric(source: string): void {
  state.licensing.blockedByPolicy += 1;
  const normalized = (source || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  const safe = KNOWN_LICENSING_SOURCES.has(normalized) ? normalized : 'unknown';
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
    // Cumulative counters above remain backwards compatible; alarms use only this window.
    window: getWindowSnapshot(env, now),
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
      body: { engine: { ...state.stream.body.engine }, http: { ...state.stream.body.http } },
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
      configured: Boolean(normalizeAlertWebhookUrl(env?.SONIC_ALERT_WEBHOOK_URL, isEnvEnabled(env?.SONIC_ALERT_ALLOW_LOCALHOST, false))),
      policy: getAlertPolicy(env),
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

function redactAlertText(raw: unknown, env?: AppEnv): string {
  let text = String(raw ?? '');
  // Also scrub configured secrets when an exception/note contains an unlabelled value.
  for (const [key, value] of Object.entries(env || {})) {
    if (/(?:SECRET|TOKEN|COOKIE|API_KEY|WEBHOOK_URL)(?:_|$)/i.test(key) && typeof value === 'string' && value.length >= 4) {
      text = text.split(value).join('[REDACTED]');
    }
  }
  return redactSensitiveString(text);
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
  const cooldownSec = Math.floor(boundedNumber(env?.SONIC_ALERT_COOLDOWN_SEC, 300, 0, 86400));
  const safeCode = redactAlertText(alert.code, env).replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64) || 'SONIC_ALERT';
  const key = `${safeCode}:${alert.severity}`;
  const alerts = state.alerts;
  const until = alerts.cooldownUntilByCode.get(key) || 0;
  if (alerts.inFlight.has(key) || alerts.inFlight.size >= 16 ||
    !alert.bypassCooldown && cooldownSec > 0 && now < until) {
    alerts.suppressedByCooldown += 1;
    return { sent: false, reason: 'cooldown_active' };
  }

  // Bound state even if callers supply different codes. Reserve before awaiting to coalesce bursts.
  if (alerts.cooldownUntilByCode.size >= 128 && !alerts.cooldownUntilByCode.has(key)) {
    alerts.cooldownUntilByCode.delete(alerts.cooldownUntilByCode.keys().next().value!);
  }
  alerts.cooldownUntilByCode.set(key, now + cooldownSec * 1000);
  alerts.inFlight.add(key);
  const metadata = getReleaseMetadata(env);
  const release = {
    ...metadata,
    environment: redactAlertText(metadata.environment, env),
    ...(metadata.releaseId ? { releaseId: redactAlertText(metadata.releaseId, env) } : {}),
  };
  const redactedSummary = redactAlertText(alert.summary, env);
  const timestamp = new Date(now).toISOString();
  const window = getWindowSnapshot(env, now);

  const payload = {
    brand: 'Sonic',
    alertVersion: '1.1',
    severity: alert.severity,
    code: safeCode,
    summary: redactedSummary,
    text: `[Sonic ${alert.severity.toUpperCase()}] ${safeCode}: ${redactedSummary} (env=${release.environment}, sha=${release.releaseCommit})`,
    timestamp,
    release,
    metrics: {
      requests: { ...state.requests },
      window,
      p95Ms: window.latency.overall.p95Ms,
      streamErrors: { ...state.stream.errors },
      sqlite: { ...state.sqlite },
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
      redirect: 'manual',
    });
    resp.body?.cancel?.().catch(() => {});
    if (!resp.ok) {
      alerts.failedCount += 1;
      return { sent: false, reason: `webhook_http_${resp.status}`, status: resp.status };
    }
    alerts.sentCount += 1;
    alerts.lastAlertAt = timestamp;
    alerts.lastAlertCode = safeCode;
    return { sent: true, reason: 'delivered', status: resp.status };
  } catch {
    alerts.failedCount += 1;
    // Fetch error messages may contain a credential-bearing webhook path, not just query params.
    console.warn(JSON.stringify({ type: 'alert_delivery_failed', code: safeCode, error: 'network_error' }));
    return { sent: false, reason: 'network_error' };
  } finally {
    alerts.inFlight.delete(key);
  }
}

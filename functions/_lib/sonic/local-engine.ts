// Sonic Gateway — Pages -> Linux Local Engine Client & 3-State Circuit Breaker
import type { AppEnv } from '../types';
import { getSonicConfig } from './config';
import { getPublicClientIp, isValidIpLiteral } from './security';
import { recordStreamBodyMetric } from './observability';
import { ENGINE_IDENTITY_HEADER, ENGINE_IDENTITY_REQUIRED_HEADER, EngineIdentityError, getEngineIdentityReadiness, isAccountIdentityPath, issueEngineIdentity } from './engine-identity';
import { resolveUserIdentity } from './recommend/identity';
import { hasPersonalizationOptOut } from './personalization';
import { resolveAuthenticatedSubject } from './authenticated-subject';
import type { UserIdentityContext } from './recommend/types';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface EndpointCircuit {
  state: CircuitState;
  generation: number;
  consecutiveFailures: number;
  openedAt: number;
  lastError: string;
  lastErrorAt: number;
  lastSuccessAt: number;
  probeInFlight: boolean;
}

const circuits = new Map<string, EndpointCircuit>();
// Only Cloudflare-origin/tunnel failures prove the engine is unreachable. An
// application-level 502 (for example a provider error inside the engine) must
// not trip the shared breaker on a single client-triggered request.
const INSTANT_TRIP_HTTP_STATUSES = new Set([521, 522, 523, 524, 530]);

function getOrCreateCircuit(engineBaseUrl: string): EndpointCircuit {
  const key = engineBaseUrl.toLowerCase();
  let c = circuits.get(key);
  if (!c) {
    c = {
      state: 'CLOSED', generation: 0, consecutiveFailures: 0, openedAt: 0,
      lastError: '', lastErrorAt: 0, lastSuccessAt: 0, probeInFlight: false,
    };
    circuits.set(key, c);
  }
  return c;
}

export interface CircuitSnapshot {
  enabled: boolean;
  engineUrl?: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastError?: string;
  cooldownRemainingMs: number;
}

function positiveMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(2_147_483_647, Math.ceil(parsed)) : fallback;
}

export function getLocalEngineCircuitSnapshot(env?: AppEnv): CircuitSnapshot {
  const cfg = getSonicConfig(env);
  if (!cfg.enableLocalEngine || !cfg.localEngineUrl) {
    return { enabled: false, state: 'CLOSED', consecutiveFailures: 0, cooldownRemainingMs: 0 };
  }
  const c = getOrCreateCircuit(cfg.localEngineUrl);
  const cooldownMs = Math.max(100, positiveMs(env?.SONIC_CB_COOLDOWN_MS, 30_000));
  const remaining = c.state === 'OPEN' ? Math.max(0, cooldownMs - (Date.now() - c.openedAt)) : 0;
  return {
    enabled: true, engineUrl: cfg.localEngineUrl,
    state: c.state === 'OPEN' && remaining === 0 ? 'HALF_OPEN' : c.state,
    consecutiveFailures: c.consecutiveFailures, lastError: c.lastError || undefined,
    cooldownRemainingMs: remaining,
  };
}

export function resetLocalEngineCircuitForTest(): void {
  circuits.clear();
}

/** Owns all listeners and timers until the request AND its response body finish. */
export function createRuntimeAbortBudget(signals: Array<AbortSignal | null | undefined>, timeoutMs: number) {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    dispose();
  };
  for (const signal of signals) {
    if (!signal || listeners.has(signal)) continue;
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    const listener = () => abort(signal.reason);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }
  if (!controller.signal.aborted && timeoutMs > 0) {
    timer = setTimeout(() => abort(new DOMException(`Request total timeout (${timeoutMs}ms)`, 'TimeoutError')), timeoutMs);
    (timer as any).unref?.();
  }
  return { signal: controller.signal, abort, dispose };
}

export type RuntimeBodyOutcome = 'completed' | 'cancelled' | 'error' | 'timeout';

/**
 * Unlike AbortSignal.timeout(firstByteMs), the first-byte timer is removed after
 * the first body chunk. A separate total budget remains active through EOF.
 * Idle time is counted while reading upstream, excluding downstream backpressure.
 */
export async function fetchWithRuntimeBudget(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: {
    timeoutMs: number;
    signals?: Array<AbortSignal | null | undefined>;
    firstByteTimeoutMs?: number;
    bodyIdleTimeoutMs?: number;
    onBodyStart?: () => void;
    onBodyOutcome?: (outcome: RuntimeBodyOutcome, error?: any) => void;
  },
): Promise<Response> {
  const budget = createRuntimeAbortBudget([init.signal, ...(options.signals || [])], options.timeoutMs);
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  };
  if (options.firstByteTimeoutMs) {
    firstByteTimer = setTimeout(() => budget.abort(new DOMException('Upstream first byte timeout', 'TimeoutError')), options.firstByteTimeoutMs);
    (firstByteTimer as any).unref?.();
  }
  try {
    budget.signal.throwIfAborted();
    const response = await fetch(input, { ...init, signal: budget.signal });
    if (budget.signal.aborted) {
      void response.body?.cancel(budget.signal.reason).catch(() => {});
      throw budget.signal.reason;
    }
    if (!response.body) {
      clearTimers();
      budget.dispose();
      options.onBodyOutcome?.('completed');
      return response;
    }
    const reader = response.body.getReader();
    let settled = false;
    let receivedByte = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const settle = (outcome: RuntimeBodyOutcome, error?: any) => {
      if (settled) return false;
      settled = true;
      clearTimers();
      budget.signal.removeEventListener('abort', onAbort);
      budget.dispose();
      options.onBodyOutcome?.(outcome, error);
      return true;
    };
    const cancelReader = (reason: unknown) => { void reader.cancel(reason).catch(() => {}); };
    const onAbort = () => {
      const reason = budget.signal.reason || new DOMException('Request aborted', 'AbortError');
      if (settle(reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', reason)) {
        bodyController.error(reason);
        cancelReader(reason);
      }
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        options.onBodyStart?.();
        budget.signal.addEventListener('abort', onAbort, { once: true });
        if (budget.signal.aborted) onAbort();
      },
      async pull(controller) {
        if (settled) return;
        if (receivedByte && options.bodyIdleTimeoutMs) {
          idleTimer = setTimeout(() => budget.abort(new DOMException('Upstream body idle timeout', 'TimeoutError')), options.bodyIdleTimeoutMs);
          (idleTimer as any).unref?.();
        }
        try {
          const result = await reader.read();
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          if (settled) return;
          if (result.done) {
            settle('completed');
            controller.close();
          } else {
            if (result.value.byteLength > 0) {
              receivedByte = true;
              if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
            }
            controller.enqueue(result.value);
          }
        } catch (error: any) {
          if (settle(error?.name === 'TimeoutError' ? 'timeout' : 'error', error)) {
            controller.error(error);
            cancelReader(error);
          }
        }
      },
      cancel(reason) {
        if (settle('cancelled', reason)) {
          budget.abort(reason || new DOMException('Response body cancelled', 'AbortError'));
          cancelReader(reason);
        }
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    clearTimers();
    budget.dispose();
    throw error;
  }
}

interface CircuitLease { generation: number; probe: boolean; }

function acquireCircuit(c: EndpointCircuit, cooldownMs: number): CircuitLease | undefined {
  if (c.state === 'OPEN') {
    if (Date.now() - c.openedAt < cooldownMs || c.probeInFlight) return;
    c.state = 'HALF_OPEN';
    c.generation += 1;
  }
  if (c.state === 'HALF_OPEN') {
    if (c.probeInFlight) return;
    c.probeInFlight = true;
  }
  return { generation: c.generation, probe: c.state === 'HALF_OPEN' };
}

function currentLease(c: EndpointCircuit, lease: CircuitLease): boolean {
  return c.generation === lease.generation && (lease.probe ? c.state === 'HALF_OPEN' && c.probeInFlight : c.state === 'CLOSED');
}

function completeCircuit(c: EndpointCircuit, lease: CircuitLease, result: 'success' | 'failure' | 'cancelled', error = '', threshold = 3, instant = false): void {
  if (!currentLease(c, lease)) return;
  if (result === 'cancelled') {
    // Cancellation is not an upstream failure. The next caller can take a fresh probe.
    if (lease.probe) {
      c.probeInFlight = false;
      c.generation += 1;
    }
    return;
  }
  c.probeInFlight = false;
  if (result === 'success') {
    c.state = 'CLOSED';
    c.consecutiveFailures = 0;
    c.lastSuccessAt = Date.now();
    c.lastError = '';
    if (lease.probe) c.generation += 1;
    return;
  }
  c.consecutiveFailures += 1;
  c.lastError = error;
  c.lastErrorAt = Date.now();
  if (instant || lease.probe || c.consecutiveFailures >= threshold) {
    c.state = 'OPEN';
    c.openedAt = Date.now();
    c.generation += 1;
  }
}

export interface LocalEngineCallResult<T> {
  ok: boolean;
  data?: T;
  status?: number;
  latencyMs: number;
  skippedByCircuit: boolean;
  circuitState: CircuitState;
  error?: string;
  errorCode?: string;
  /** Sanitized upstream Cache-Control, used by callers that relay engine payloads. */
  cacheControl?: string;
}

function buildEngineHeaders(secret?: string, request?: Request, clientIp?: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'Sonic-Edge-Gateway/2.2' };
  if (secret) headers['X-Sonic-Engine-Key'] = secret;
  if (request) headers['X-Sonic-Client-IP'] = getPublicClientIp(request);
  else if (clientIp && isValidIpLiteral(clientIp)) headers['X-Sonic-Client-IP'] = clientIp;
  return headers;
}

export async function callLocalEngineJson<T = any>(
  pathWithQuery: string,
  env?: AppEnv,
  options?: {
    request?: Request; method?: 'GET' | 'POST' | 'DELETE'; body?: string;
    timeoutMs?: number; signal?: AbortSignal; clientIp?: string;
  },
): Promise<LocalEngineCallResult<T>> {
  const cfg = getSonicConfig(env);
  if (!cfg.enableLocalEngine || !cfg.localEngineUrl) {
    return { ok: false, latencyMs: 0, skippedByCircuit: true, circuitState: 'CLOSED', error: 'Local engine not configured' };
  }
  const c = getOrCreateCircuit(cfg.localEngineUrl);
  const threshold = Math.max(1, positiveMs(env?.SONIC_CB_FAILURE_THRESHOLD, 3));
  const lease = acquireCircuit(c, Math.max(100, positiveMs(env?.SONIC_CB_COOLDOWN_MS, 30_000)));
  if (!lease) {
    return { ok: false, latencyMs: 0, skippedByCircuit: true, circuitState: c.state, error: `Circuit ${c.state} (${c.lastError || 'probe already in flight'})` };
  }
  const start = Date.now();
  const timeoutMs = lease.probe ? Math.min(options?.timeoutMs ?? cfg.engineTimeoutMs, 2500) : options?.timeoutMs ?? cfg.engineTimeoutMs;
  const headers = buildEngineHeaders(cfg.engineSecret, options?.request, options?.clientIp);
  headers.Accept = 'application/json';
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  for (const name of ['authorization', 'cookie', 'x-sonic-key', 'x-cfsolara-key', 'x-api-key', 'x-sonic-anon-id', 'x-sonic-personalization', 'x-sonic-context']) {
    const value = options?.request?.headers.get(name);
    if (value) headers[name] = value;
  }
  const signals = [options?.signal, options?.request?.signal];
  const clientCancelled = () => signals.some((signal) => signal?.aborted && signal.reason?.name !== 'TimeoutError');
  try {
    const method = options?.method || 'GET';
    let forwardedIdentity: UserIdentityContext | undefined;
    if (options?.request) {
      const readiness = getEngineIdentityReadiness(env);
      if (!readiness.ok) throw new EngineIdentityError();
      const accountRoute = isAccountIdentityPath(pathWithQuery) || pathWithQuery.split('?')[0].replace(/\/+$/, '') === '/api/sonic/recommend/radar-album';
      const accountSubject = accountRoute ? await resolveAuthenticatedSubject(options.request, env) : null;
      forwardedIdentity = accountRoute
        ? { mode: 'public', subjectKey: null, personalizationEnabled: false, isAuthenticated: false }
        : await resolveUserIdentity(options.request, env);
      const optedOut = hasPersonalizationOptOut(options.request);
      if (optedOut) {
        headers['x-sonic-personalization'] = 'off';
        delete headers['x-sonic-anon-id'];
        delete headers['x-sonic-context'];
      }
      const assertion = await issueEngineIdentity(forwardedIdentity, method, pathWithQuery, env, undefined, accountSubject);
      if (assertion) {
        headers[ENGINE_IDENTITY_HEADER] = assertion;
        headers[ENGINE_IDENTITY_REQUIRED_HEADER] = '1';
        delete headers['x-sonic-anon-id'];
      }
      if (assertion || optedOut || forwardedIdentity.mode === 'public') {
        for (const credential of ['authorization', 'cookie', 'x-sonic-key', 'x-cfsolara-key', 'x-api-key']) delete headers[credential];
      }
      if ((readiness.required || accountRoute) && !assertion) throw new EngineIdentityError();
    }
    const response = await fetchWithRuntimeBudget(`${cfg.localEngineUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`, {
      method, headers, body: method !== 'GET' ? options?.body : undefined, redirect: 'error',
    }, { timeoutMs, signals });
    if (response.status >= 500 || INSTANT_TRIP_HTTP_STATUSES.has(response.status)) {
      const error = `Engine HTTP ${response.status}`;
      completeCircuit(c, lease, 'failure', error, threshold, INSTANT_TRIP_HTTP_STATUSES.has(response.status));
      let data: any;
      if (response.status === 503 && response.headers.get('content-type')?.includes('application/json') && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 16384) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
          if (size <= 16384) data = JSON.parse(text + decoder.decode());
        } catch {} finally {
          void reader.cancel().catch(() => {});
        }
      } else {
        void response.body?.cancel().catch(() => {});
      }
      const errorCode = data?.brand === 'Sonic' && typeof data?.error?.code === 'string' ? data.error.code : undefined;
      return { ok: false, status: response.status, data, latencyMs: Date.now() - start, skippedByCircuit: false, circuitState: c.state, error, errorCode };
    }
    let data: any;
    try {
      data = await response.json();
    } catch (error) {
      // Invalid error payloads remain consumable; timeouts/cancellation must still propagate.
      if (response.ok || signals.some((signal) => signal?.aborted) || (error as any)?.name !== 'SyntaxError') throw error;
    }
    if (clientCancelled()) throw signals.find((signal) => signal?.aborted)!.reason;
    if (response.ok && forwardedIdentity && pathWithQuery.split('?')[0].replace(/\/+$/, '') === '/api/sonic/events') {
      if (data?.data?.privacyMode !== forwardedIdentity.mode ||
          (forwardedIdentity.subjectKey && data?.data?.ignoredByPrivacy > 0)) throw new EngineIdentityError();
    }
    const authRejected = response.status === 401 || response.status === 403;
    // 4xx is a definitive answer from a reachable engine (access gate, policy
    // denial, invalid parameters), not an outage. Treating it as a breaker
    // failure previously let an anonymous request to a public 401 endpoint
    // degrade every engine-backed feature for all users.
    completeCircuit(c, lease, response.status < 500 ? 'success' : 'failure', authRejected ? `Engine auth rejected (${response.status})` : '', threshold);
    return {
      ok: response.ok, data, status: response.status, latencyMs: Date.now() - start,
      skippedByCircuit: false, circuitState: c.state,
      ...(response.headers.get('cache-control') ? { cacheControl: String(response.headers.get('cache-control')) } : {}),
      ...(response.ok ? {} : { error: data?.error?.message || data?.error || `Engine HTTP ${response.status}` }),
    };
  } catch (error: any) {
    const cancelled = clientCancelled();
    const message = cancelled ? 'Engine request cancelled' : error?.name === 'TimeoutError' ? `Engine timeout (${timeoutMs}ms)` : error?.message || 'Engine network error';
    // A missing/invalid identity assertion is a configuration failure, not
    // evidence that the engine is down; it must not poison the shared breaker.
    completeCircuit(c, lease, cancelled || error instanceof EngineIdentityError ? 'cancelled' : 'failure', message, threshold);
    return {
      ok: false, latencyMs: Date.now() - start, skippedByCircuit: false, circuitState: c.state, error: message,
      ...(error instanceof EngineIdentityError ? { status: 503, errorCode: error.code } : {}),
    };
  }
}

export interface LocalEngineStreamResult extends Omit<LocalEngineCallResult<never>, 'data'> {
  response?: Response;
}

export async function callLocalEngineStream(
  pathWithQuery: string,
  env?: AppEnv,
  options?: { request?: Request; method?: 'GET' | 'HEAD'; timeoutMs?: number; signal?: AbortSignal },
): Promise<LocalEngineStreamResult> {
  const cfg = getSonicConfig(env);
  if (!cfg.enableLocalEngine || !cfg.localEngineUrl) {
    return { ok: false, latencyMs: 0, skippedByCircuit: true, circuitState: 'CLOSED', error: 'Local engine not configured' };
  }
  const c = getOrCreateCircuit(cfg.localEngineUrl);
  const threshold = Math.max(1, positiveMs(env?.SONIC_CB_FAILURE_THRESHOLD, 3));
  const lease = acquireCircuit(c, Math.max(100, positiveMs(env?.SONIC_CB_COOLDOWN_MS, 30_000)));
  if (!lease) {
    return { ok: false, latencyMs: 0, skippedByCircuit: true, circuitState: c.state, error: `Circuit ${c.state} (${c.lastError || 'probe already in flight'})` };
  }
  const start = Date.now();
  const baseFirstByteMs = options?.timeoutMs ?? positiveMs(env?.SONIC_STREAM_FIRST_BYTE_TIMEOUT_MS, Math.max(cfg.engineTimeoutMs, 8000));
  const firstByteTimeoutMs = lease.probe ? Math.min(baseFirstByteMs, 2500) : baseFirstByteMs;
  const headers = buildEngineHeaders(cfg.engineSecret, options?.request);
  const range = options?.request?.headers.get('range');
  if (range) headers.Range = range;
  const signals = [options?.signal, options?.request?.signal];
  const clientCancelled = () => signals.some((signal) => signal?.aborted && signal.reason?.name !== 'TimeoutError');
  let status = 0;
  let bodyStarted = false;
  try {
    const response = await fetchWithRuntimeBudget(`${cfg.localEngineUrl}${pathWithQuery.startsWith('/') ? '' : '/'}${pathWithQuery}`, {
      method: options?.method || 'GET', headers, redirect: 'error',
    }, {
      signals,
      timeoutMs: positiveMs(env?.SONIC_STREAM_TOTAL_TIMEOUT_MS, 30 * 60_000),
      firstByteTimeoutMs,
      bodyIdleTimeoutMs: positiveMs(env?.SONIC_STREAM_IDLE_TIMEOUT_MS, 30_000),
      onBodyStart: () => { bodyStarted = true; recordStreamBodyMetric('started', 'engine'); },
      onBodyOutcome: (outcome, error) => {
        if (bodyStarted) recordStreamBodyMetric(outcome, 'engine');
        if (outcome === 'cancelled' || clientCancelled()) completeCircuit(c, lease, 'cancelled');
        else if (outcome === 'error' || outcome === 'timeout') completeCircuit(c, lease, 'failure', error?.message || 'Engine response body failed', threshold);
        else if (status > 0 && status < 500) completeCircuit(c, lease, 'success', `Engine HTTP ${status}`, threshold);
      },
    });
    status = response.status;
    if (response.status >= 500 || INSTANT_TRIP_HTTP_STATUSES.has(response.status)) {
      const error = `Engine HTTP ${response.status}`;
      completeCircuit(c, lease, 'failure', error, threshold, INSTANT_TRIP_HTTP_STATUSES.has(response.status));
      void response.body?.cancel().catch(() => {});
      return { ok: false, status, latencyMs: Date.now() - start, skippedByCircuit: false, circuitState: c.state, error };
    }
    // A HEAD/empty response has no body lifecycle to wait for.
    if (!response.body) completeCircuit(c, lease, response.status < 500 ? 'success' : 'failure', `Engine HTTP ${status}`, threshold);
    return { ok: true, response, status, latencyMs: Date.now() - start, skippedByCircuit: false, circuitState: c.state };
  } catch (error: any) {
    const cancelled = clientCancelled();
    const message = cancelled ? 'Engine stream cancelled' : error?.name === 'TimeoutError' ? `Engine stream timeout (${firstByteTimeoutMs}ms first byte)` : error?.message || 'Engine stream network error';
    completeCircuit(c, lease, cancelled ? 'cancelled' : 'failure', message, threshold);
    return { ok: false, latencyMs: Date.now() - start, skippedByCircuit: false, circuitState: c.state, error: message };
  }
}

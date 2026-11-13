import { fetchWithoutRedirect } from '../fetch-direct';

export const UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT';

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
    const send = init.redirect === 'error' ? fetchWithoutRedirect : fetch;
    const response = await send(input, { ...init, signal: budget.signal });
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
    if (budget.signal.aborted) throw budget.signal.reason;
    throw error;
  }
}

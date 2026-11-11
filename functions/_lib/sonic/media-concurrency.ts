import { jsonResponse } from '../http';
import type { AppEnv } from '../types';
import { recordStreamMetric } from './observability';
import { acquireStreamSlot, extractClientIp, getStreamSlotLimit, releaseStreamSlot } from './security';

export function isMediaContentType(contentType: string | null, allowVideo = true): boolean {
  const value = (contentType || '').split(';')[0].trim().toLowerCase();
  // Approved CDNs also serve raw audio with an absent or generic binary MIME type.
  return !value || value.startsWith('audio/') || (allowVideo && value.startsWith('video/')) ||
    value === 'application/octet-stream' || value === 'binary/octet-stream';
}

function trackBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, release: () => void) {
  const reader = body.getReader();
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array>;

  const finish = () => {
    if (finished) return false;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    release();
    return true;
  };
  const fail = (error: unknown) => {
    if (finish()) output.error(error);
  };
  const onAbort = () => {
    if (!finished) {
      fail(signal.reason);
      void reader.cancel(signal.reason).catch(() => {});
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      // Propagate an upstream timeout/error even when the downstream has stopped reading.
      void reader.closed.catch(fail);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        fail(error);
      }
    },
    cancel(reason) {
      if (finish()) return reader.cancel(reason).catch(() => {});
    },
  });
}

/** The same per-client budget covers pending upstream media and the body returned to the client. */
export async function withMediaStreamLimit(
  request: Request,
  env: AppEnv | undefined,
  respond: () => Promise<Response>,
): Promise<Response> {
  if (request.method === 'HEAD') return respond();

  const ip = extractClientIp(request, env);
  if (!acquireStreamSlot(ip)) {
    recordStreamMetric('err_429');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'STREAM_CONCURRENCY_LIMIT',
          message: `Too many concurrent media streams from this client (max ${getStreamSlotLimit()})`,
        },
      },
      { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
    );
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseStreamSlot(ip);
  };
  let tracksBody = false;
  // Free the slot even if a pending provider call is slow to react to an abort.
  request.signal.addEventListener('abort', release, { once: true });
  try {
    request.signal.throwIfAborted();
    const response = await respond();
    if (!response.body || !response.ok) return response;

    const tracked = new Response(trackBody(response.body, request.signal, release), response);
    tracksBody = true;
    return tracked;
  } finally {
    request.signal.removeEventListener('abort', release);
    if (!tracksBody) release();
  }
}

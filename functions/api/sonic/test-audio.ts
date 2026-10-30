// GET /api/sonic/test-audio
// First-Party Authorized Synthetic PCM/WAV Audio Endpoint (CC0 / Mathematical Sine-Wave Generator)
// Supports full HTTP 200, byte-range 206 Partial Content, 416 Range Not Satisfiable, HEAD,
// and explicit controlled fault scenarios (403 / 429 / 502 / timeout) when SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1.

import { corsHeaders, errorResponse, handleOptions, jsonResponse } from '../../_lib/http';
import { getSonicConfig } from '../../_lib/sonic/config';
import { callLocalEngineStream } from '../../_lib/sonic/local-engine';
import { recordLicensingBlockMetric, recordStreamMetric } from '../../_lib/sonic/observability';
import {
  buildRateLimitErrorResponse,
  checkEngineAccess,
  evaluateGatewayRateLimit,
} from '../../_lib/sonic/security';
import {
  generateSyntheticWavRange,
  getSyntheticTrackSpec,
  getSyntheticWavTotalBytes,
  parseHttpByteRange,
} from '../../_lib/sonic/synthetic-media';
import type { AppEnv } from '../../_lib/types';

export async function serveSyntheticAudioLocally(
  id: string,
  method: string,
  rangeHeader: string | null,
  viaLabel = 'synthetic-local',
): Promise<Response> {
  const cleanId = (id || 'syn-440hz').replace(/^synthetic:/i, '').trim().toLowerCase();

  // Controlled fault scenarios for Staging & E2E resilience verification
  if (cleanId === 'syn-fault-403') {
    recordStreamMetric('err_403');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: { code: 'UPSTREAM_FORBIDDEN', message: 'Simulated upstream 403 forbidden fault' },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (cleanId === 'syn-fault-429') {
    recordStreamMetric('err_429');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: { code: 'UPSTREAM_RATE_LIMITED', message: 'Simulated upstream 429 rate limit fault' },
      },
      { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } },
    );
  }
  if (cleanId === 'syn-fault-500') {
    recordStreamMetric('err_5xx');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: { code: 'UPSTREAM_ERROR', message: 'Simulated upstream 502 gateway fault' },
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (cleanId === 'syn-fault-timeout') {
    await new Promise((resolve) => setTimeout(resolve, 250));
    recordStreamMetric('err_timeout');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: { code: 'UPSTREAM_TIMEOUT', message: 'Simulated upstream stream timeout fault' },
      },
      { status: 504, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const spec = getSyntheticTrackSpec(cleanId);
  if (!spec) {
    recordStreamMetric('err_404');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: { code: 'STREAM_NOT_FOUND', message: `Synthetic test track '${cleanId}' not found` },
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const totalBytes = getSyntheticWavTotalBytes(spec);
  const parsedRange = parseHttpByteRange(rangeHeader, totalBytes);

  if (parsedRange.kind === 'unsatisfiable') {
    recordStreamMetric('err_416');
    const h416 = corsHeaders({
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${totalBytes}`,
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, X-Sonic-Provider, X-Sonic-Via',
      'X-Sonic-Provider': 'synthetic',
      'X-Sonic-Via': viaLabel,
    });
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'RANGE_NOT_SATISFIABLE',
          message: `Requested byte range is outside 0-${totalBytes - 1}`,
        },
      },
      { status: 416, headers: h416 },
    );
  }

  const isPartial = parsedRange.kind === 'valid';
  const start = isPartial ? parsedRange.start : 0;
  const end = isPartial ? parsedRange.end : totalBytes - 1;
  const chunkLen = end - start + 1;
  const isHead = method.toUpperCase() === 'HEAD';

  const headers = corsHeaders({
    'Content-Type': 'audio/wav',
    'Content-Length': String(chunkLen),
    'Accept-Ranges': 'bytes',
    ETag: `"sonic-syn-${spec.id}-${totalBytes}"`,
    'Cache-Control': 'public, max-age=300',
    'X-Sonic-Provider': 'synthetic',
    'X-Sonic-Via': viaLabel,
    'X-Sonic-Stream-Type': 'full',
    'Access-Control-Expose-Headers':
      'Content-Range, Content-Length, Accept-Ranges, Content-Type, ETag, X-Sonic-Provider, X-Sonic-Via, X-Sonic-Stream-Type',
  });

  if (isPartial) {
    headers.set('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
    recordStreamMetric('proxied_206');
  } else {
    recordStreamMetric('proxied_200');
  }

  if (isHead) {
    return new Response(null, { status: isPartial ? 206 : 200, headers });
  }

  const bytes = generateSyntheticWavRange(spec, start, end);
  return new Response(bytes as unknown as BodyInit, { status: isPartial ? 206 : 200, headers });
}

export async function onRequest({ request, env }: { request: Request; env: AppEnv }): Promise<Response> {
  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, 'test-audio');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const cfg = getSonicConfig(env);
  if (!cfg.enableSynthetic) {
    recordLicensingBlockMetric('synthetic');
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'SOURCE_DISABLED_BY_POLICY',
          message: 'Synthetic test audio source is disabled (set SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1 in staging/test)',
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || 'syn-440hz';

  // When running on Cloudflare Pages with Linux Engine configured, route through Cloudflare Tunnel -> Linux Engine first
  if (cfg.enableLocalEngine) {
    const engineStream = await callLocalEngineStream(
      `/api/sonic/test-audio?id=${encodeURIComponent(id)}`,
      env,
      { request, method: request.method as 'GET' | 'HEAD', signal: request.signal },
    );
    if (engineStream.ok && engineStream.response) {
      const outHeaders = new Headers(engineStream.response.headers);
      outHeaders.set('X-Sonic-Via', 'local-engine');
      outHeaders.set('X-Sonic-Provider', 'local-synthetic');
      return new Response(engineStream.response.body, {
        status: engineStream.response.status,
        headers: outHeaders,
      });
    }
  }

  const viaLabel = cfg.runtime === 'linux-engine' ? 'local-engine-synthetic' : 'edge-synthetic';
  return serveSyntheticAudioLocally(id, request.method, request.headers.get('Range'), viaLabel);
}

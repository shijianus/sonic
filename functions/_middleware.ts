// Cloudflare Pages Functions Global Middleware
// Enforces Staging access control & anti-indexing headers, records route latency / 5xx metrics,
// attaches release traceability header, and redacts any unhandled exception logs.

import { handleOptions, jsonResponse } from './_lib/http';
import {
  getReleaseMetadata,
  recordHttpRequestMetric,
  redactSensitiveString,
} from './_lib/sonic/observability';
import { checkStagingAccessGate } from './_lib/sonic/security';
import type { AppEnv } from './_lib/types';

export async function onRequest(context: {
  request: Request;
  env: AppEnv;
  next: () => Promise<Response>;
}): Promise<Response> {
  const { request, env, next } = context;
  const startedAt = Date.now();
  const url = new URL(request.url);
  const pathname = url.pathname || '/';
  const release = getReleaseMetadata(env);
  const isStaging =
    release.environment === 'staging' ||
    release.environment === 'preview' ||
    Boolean(env?.SONIC_STAGING_ACCESS_TOKEN && String(env.SONIC_STAGING_ACCESS_TOKEN).trim());

  const finalizeResponse = (resp: Response): Response => {
    recordHttpRequestMetric(pathname, resp.status, Date.now() - startedAt, env);
    const needRobots = isStaging && !resp.headers.has('X-Robots-Tag');
    const needRelease = release.releaseCommit !== 'unknown' && !resp.headers.has('X-Sonic-Release');
    if (!needRobots && !needRelease) {
      return resp;
    }
    const headers = new Headers(resp.headers);
    if (needRobots) {
      headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    if (needRelease) {
      headers.set('X-Sonic-Release', release.releaseCommit.slice(0, 12));
    }
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  };

  if (request.method === 'OPTIONS') {
    return finalizeResponse(handleOptions());
  }

  const stagingDenied = checkStagingAccessGate(request, env);
  if (stagingDenied) {
    return finalizeResponse(stagingDenied);
  }

  try {
    const resp = await next();
    return finalizeResponse(resp);
  } catch (err: any) {
    console.error(
      JSON.stringify({
        type: 'edge_unhandled_error',
        path: pathname,
        error: redactSensitiveString(err?.message || String(err)),
      }),
    );
    return finalizeResponse(
      jsonResponse(
        {
          brand: 'Sonic',
          error: {
            code: 'EDGE_INTERNAL_ERROR',
            message: 'Internal gateway error',
          },
        },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      ),
    );
  }
}

// Cloudflare Pages Functions Global Middleware
// Enforces Staging access control & anti-indexing headers, records route latency / 5xx metrics,
// attaches release traceability header, and redacts any unhandled exception logs.

import { handleOptions, jsonResponse } from './_lib/http';
import {
  getReleaseMetadata,
  getReleaseReadiness,
  recordHttpRequestMetric,
  redactSensitiveString,
} from './_lib/sonic/observability';
import { checkStagingAccessGate, canonicalPolicyPath } from './_lib/sonic/security';
import { getAccessMode, requireAccess } from './_lib/sonic/access';
import { getContentPolicyReadiness } from './_lib/sonic/licensing';
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
    getAccessMode(env) === 'invite' ||
    Boolean(env?.SONIC_STAGING_ACCESS_TOKEN && String(env.SONIC_STAGING_ACCESS_TOKEN).trim());

  const finalizeResponse = (resp: Response): Response => {
    recordHttpRequestMetric(pathname, resp.status, Date.now() - startedAt, env);
    const needRobots = isStaging && !resp.headers.has('X-Robots-Tag');
    const releaseId = release.releaseId || (release.releaseCommit !== 'unknown' ? release.releaseCommit.slice(0, 12) : '');
    const needRelease = Boolean(releaseId) && !resp.headers.has('X-Sonic-Release');
    if (!needRobots && !needRelease) {
      return resp;
    }
    const headers = new Headers(resp.headers);
    if (needRobots) {
      headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    if (needRelease) {
      headers.set('X-Sonic-Release', releaseId);
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

  const accessDenied = await requireAccess(request, env);
  if (accessDenied) {
    return finalizeResponse(accessDenied);
  }

  const contentPolicy = getContentPolicyReadiness(env);
  const releaseReadiness = getReleaseReadiness(env);
  // Health must remain reachable so an operator can see why a deployment is
  // failing closed. The handler reports contentPolicy/release details itself.
  // Route matching is case-insensitive on Pages, so use the canonical path.
  const isHealthEndpoint = canonicalPolicyPath(request) === '/api/sonic/engine/health';
  if (!isHealthEndpoint && !contentPolicy.ok) {
    return finalizeResponse(jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'CONTENT_POLICY_MISCONFIGURED',
          message: 'Production requires SONIC_CONTENT_POLICY=strict-allowlist and a reviewed SONIC_ALLOWED_SOURCES list',
          reason: contentPolicy.reason,
          invalidSources: contentPolicy.invalidSources,
          effectiveSources: contentPolicy.effectiveSources,
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } },
    ));
  }

  if (!isHealthEndpoint && !releaseReadiness.ok) {
    return finalizeResponse(jsonResponse(
      { brand: 'Sonic', error: { code: 'RELEASE_NOT_READY', message: 'Release metadata is not configured' } },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } },
    ));
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

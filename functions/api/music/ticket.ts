// Sonic Gateway — Playback Ticket Issuance Endpoint
// POST /api/music/ticket
// Issues short-lived (exp <= 120s) HMAC-SHA256 tickets for audio streaming & controlled downloading.
// Supports both authenticated users (via API Key/Session) and anonymous visitors (via HttpOnly session cookie).

import {
  corsHeaders,
  errorResponse,
  handleOptions,
  jsonResponse,
} from '../../_lib/http';
import { verifyAuth } from '../../_lib/auth';
import {
  checkEngineAccess,
  evaluateGatewayRateLimit,
  buildRateLimitErrorResponse,
  extractClientIp,
  hasValidEngineSecret,
} from '../../_lib/sonic/security';
import {
  getOrCreateAnonSession,
  issueStreamTicket,
  verifyTurnstileToken,
  resolveGuardSubject,
  checkStreamCorsAndFetchMetadata,
  TICKET_MAX_TTL_SEC,
} from '../../_lib/sonic/ticket';
import type { AppEnv } from '../../_lib/types';

export async function onRequest({
  request,
  env,
}: {
  request: Request;
  env: AppEnv;
}): Promise<Response> {
  const isEngineCaller = hasValidEngineSecret(request, env);
  let hasApiKey = isEngineCaller;
  if (!hasApiKey) {
    const auth = await verifyAuth(request, env);
    if (auth.authenticated && auth.source === 'header') {
      hasApiKey = true;
    }
  }

  const isStrictCors = String(env?.SONIC_CORS_STRICT || '0').trim() === '1';
  const corsCheck = checkStreamCorsAndFetchMetadata(request, env);
  const customCorsHeaders: Record<string, string> = {};
  if (isStrictCors && !hasApiKey && corsCheck.allowOriginHeader) {
    customCorsHeaders['Access-Control-Allow-Origin'] = corsCheck.allowOriginHeader;
    customCorsHeaders['Vary'] = 'Origin';
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(customCorsHeaders),
    });
  }
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  if (!corsCheck.allowed && !hasApiKey) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'CORS_FORBIDDEN',
          message: `Cross-origin ticket request forbidden by security policy (${corsCheck.reason})`,
        },
      },
      { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store', ...customCorsHeaders }) },
    );
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;

  const rl = await evaluateGatewayRateLimit(request, env, 'music-ticket');
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON payload in request body', 400);
  }

  const id = String(body.id || body.platformId || body.trackId || '').trim();
  if (!id) {
    return errorResponse('Parameter id is required', 400);
  }

  const source = String(body.source || body.platform || 'netease').trim().toLowerCase();
  const br = String(body.br || body.quality || '320').trim();
  const purpose = (body.purpose === 'download' ? 'download' : 'play') as 'play' | 'download';
  const clientIp = extractClientIp(request);

  // 1. Identify requester subject: Authenticated API User vs Anonymous Visitor
  const auth = await verifyAuth(request, env);
  let cookieHeader: string | undefined;

  if (!auth.authenticated && body.cfTurnstileToken) {
    const turnstileCheck = await verifyTurnstileToken(
      body.cfTurnstileToken,
      clientIp,
      env,
    );
    if (!turnstileCheck.success) {
      return jsonResponse(
        {
          brand: 'Sonic',
          error: {
            code: 'CAPTCHA_FAILED',
            message: 'Human verification failed or expired',
          },
        },
        { status: 403, headers: corsHeaders({ 'Cache-Control': 'no-store', ...customCorsHeaders }) },
      );
    }
  }

  // Unified Subject Resolution via resolveGuardSubject
  let subject = await resolveGuardSubject(request, env);
  if (!auth.authenticated && subject.startsWith('anon:ip:')) {
    const anonSession = await getOrCreateAnonSession(request, env);
    subject = `anon:${anonSession.sessionId}`;
    if (anonSession.isNew && anonSession.cookieHeader) {
      cookieHeader = anonSession.cookieHeader;
    }
  }

  // 2. Issue HMAC-SHA256 Playback Ticket
  try {
    const ticket = await issueStreamTicket({
      id,
      source,
      br,
      purpose,
      sub: subject,
      ip: clientIp,
      cdh: body.cdh,
      ttlSec: TICKET_MAX_TTL_SEC,
      env,
    });

    const responseHeaders: Record<string, string> = {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Sonic-Ticket-Ttl': String(TICKET_MAX_TTL_SEC),
      ...customCorsHeaders,
    };
    if (cookieHeader) {
      responseHeaders['Set-Cookie'] = cookieHeader;
    }

    return jsonResponse(
      {
        ok: true,
        brand: 'Sonic',
        ticket,
        expiresIn: TICKET_MAX_TTL_SEC,
        purpose,
        fingerprint: `${source}:${id}:${br}`,
      },
      {
        status: 200,
        headers: corsHeaders(responseHeaders),
      },
    );
  } catch (err: any) {
    return jsonResponse(
      {
        brand: 'Sonic',
        error: {
          code: 'TICKET_ISSUANCE_FAILED',
          message: err?.message || 'Failed to issue stream ticket',
        },
      },
      { status: 500, headers: corsHeaders({ 'Cache-Control': 'no-store', ...customCorsHeaders }) },
    );
  }
}

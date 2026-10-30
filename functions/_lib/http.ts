export function corsHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Sonic-Key, X-CFSolara-Key, X-Api-Key, X-Sonic-Engine-Key, X-Sonic-Staging-Token, X-Sonic-Anon-Id, X-Sonic-Personalization, X-Sonic-Context, X-Shijianus-Device-Id, Range',
  );
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, X-Sonic-Release, X-RateLimit-Backend, X-RateLimit-Degraded');
  // API payloads are JSON/text only; never let a browser treat one as an active document.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (extra) {
    applyHeaders(headers, extra);
  }
  return headers;
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function applyHeaders(target: Headers, rawHeaders: HeadersInit): void {
  if (rawHeaders instanceof Headers) {
    const canReadSetCookie = typeof (rawHeaders as any).getSetCookie === 'function';
    if (canReadSetCookie) {
      for (const cookie of (rawHeaders as any).getSetCookie()) {
        target.append('set-cookie', cookie);
      }
    }
    rawHeaders.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        if (!canReadSetCookie) target.append('set-cookie', value);
      } else {
        target.set(key, value);
      }
    });
    return;
  }
  new Headers(rawHeaders).forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') target.append(key, value);
    else target.set(key, value);
  });
}

export function jsonResponse(
  payload: unknown,
  initOrStatus?: ResponseInit | number,
  extraHeaders?: HeadersInit,
): Response {
  const headers = corsHeaders();
  const status = typeof initOrStatus === 'number' ? initOrStatus : (initOrStatus?.status ?? 200);
  const statusText = typeof initOrStatus === 'object' ? initOrStatus?.statusText : undefined;
  const rawHeaders = typeof initOrStatus === 'object' ? initOrStatus?.headers : extraHeaders;
  if (rawHeaders) {
    applyHeaders(headers, rawHeaders);
  }
  if (extraHeaders && typeof initOrStatus === 'object') {
    applyHeaders(headers, extraHeaders);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(payload), {
    status,
    statusText,
    headers,
  });
}

export function errorResponse(message: string, status = 400, details?: unknown): Response {
  return jsonResponse(
    { ok: false, error: message, ...(details ? { details } : {}) },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

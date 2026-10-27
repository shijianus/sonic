export function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sonic-Key, X-CFSolara-Key, X-Shijianus-Device-Id, Range');
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  return headers;
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function mergeResponseHeaders(target: Headers, source: HeadersInit): void {
  const incoming = new Headers(source);
  incoming.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    target.set(key, value);
  });
  const getSetCookie = (incoming as any).getSetCookie;
  if (typeof getSetCookie === 'function') {
    for (const cookie of getSetCookie.call(incoming) as string[]) {
      target.append('Set-Cookie', cookie);
    }
  } else {
    const cookie = incoming.get('set-cookie');
    if (cookie) target.append('Set-Cookie', cookie);
  }
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
    mergeResponseHeaders(headers, rawHeaders);
  }
  if (extraHeaders && typeof initOrStatus === 'object') {
    mergeResponseHeaders(headers, extraHeaders);
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
  return jsonResponse({ ok: false, error: message, ...(details ? { details } : {}) }, { status });
}

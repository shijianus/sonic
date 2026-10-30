import { getUniversalLyrics, searchTracks } from "./_lib/music";
import { getSonicConfig } from "./_lib/sonic/config";
import { isSourceEnabledByPolicy } from "./_lib/sonic/licensing";
import { recordLicensingBlockMetric, redactSensitiveString } from "./_lib/sonic/observability";
import {
  buildRateLimitErrorResponse,
  checkEngineAccess,
  evaluateGatewayRateLimit,
  isBlockedSsrfHost,
  safeFetch,
  validateSafeUrl,
} from "./_lib/sonic/security";
import type { AppEnv } from "./_lib/types";

const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SENSITIVE_PROXY_QUERY = /[?&](auth|auth_key|vkey|guid|sign|signature|token|access_token|secret|key|wssecret|wstime|vuutv|dis_k)=/i;
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "accept-ranges",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
  "expires",
];

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  const hasContentEncoding = Boolean(init?.has("content-encoding"));
  if (init) {
    init.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" && hasContentEncoding) return;
      if (SAFE_RESPONSE_HEADERS.includes(lower)) {
        headers.set(key, value);
      }
    });
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase().trim().replace(/\.+$/, '');
  return (h === 'kuwo.cn' || h.endsWith('.kuwo.cn')) && !isBlockedSsrfHost(h);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== '443' && parsed.port !== '80') return null;
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "https:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request, env?: AppEnv): Promise<Response> {
  if (!getSonicConfig(env).enableKuwo) {
    recordLicensingBlockMetric("kuwo");
    const deniedHeaders = createCorsHeaders();
    deniedHeaders.set("Content-Type", "application/json; charset=utf-8");
    deniedHeaders.set("Cache-Control", "no-store");
    return new Response(
      JSON.stringify({ code: "SOURCE_DISABLED_BY_POLICY", error: "Source 'kuwo' is disabled by server content policy" }),
      { status: 403, headers: deniedHeaders },
    );
  }

  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400, headers: createCorsHeaders() });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      Referer: "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await safeFetch(normalized, init, {
    allowHttp: false,
    allowedDomains: ['kuwo.cn'],
    maxRedirects: 2,
    timeoutMs: 15000,
    maxBytes: 256 * 1024 * 1024,
  });

  if (!upstream.ok && upstream.status !== 206) {
    upstream.body?.cancel().catch(() => {});
    const errHeaders = createCorsHeaders();
    errHeaders.set("Cache-Control", "no-store");
    if (upstream.status === 416) {
      const cr = upstream.headers.get("content-range");
      if (cr) errHeaders.set("Content-Range", cr);
      return new Response(null, { status: 416, headers: errHeaders });
    }
    return new Response("Upstream media unavailable", {
      status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
      headers: errHeaders,
    });
  }

  const upstreamType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (
    upstreamType &&
    !upstreamType.startsWith('audio/') &&
    upstreamType !== 'application/octet-stream' &&
    upstreamType !== 'binary/octet-stream'
  ) {
    upstream.body?.cancel().catch(() => {});
    throw new Error(`Unexpected upstream content type: ${upstreamType}`);
  }
  const headers = createCorsHeaders(upstream.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  const upstreamCc = (upstream.headers.get("cache-control") || "").toLowerCase();
  if (
    SENSITIVE_PROXY_QUERY.test(normalized.search) ||
    upstreamCc.includes("private") ||
    upstreamCc.includes("no-store")
  ) {
    headers.set("Cache-Control", "private, no-store");
  } else if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url: URL, request: Request, env?: AppEnv): Promise<Response> {
  const types = (url.searchParams.get("types") || "").toLowerCase().trim();
  if (!types) {
    return new Response("Missing types", { status: 400, headers: createCorsHeaders() });
  }

  const headers = createCorsHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");

  const rawSource = (url.searchParams.get("source") || "netease").toLowerCase().trim();
  const rawId = (url.searchParams.get("id") || "").replace(/^[a-z0-9_-]+:/i, "").trim();

  if (rawSource !== "sonic" && !isSourceEnabledByPolicy(rawSource, env)) {
    recordLicensingBlockMetric(rawSource);
    headers.set("Cache-Control", "no-store");
    return new Response(
      JSON.stringify({
        code: "SOURCE_DISABLED_BY_POLICY",
        error: `Source '${rawSource}' is disabled by server content policy`,
      }),
      { status: 403, headers },
    );
  }

  // 1. Native local-first handlers (zero third-party free aggregation dependency)
  if (types === "search") {
    const keyword = (url.searchParams.get("name") || url.searchParams.get("q") || "").trim();
    const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get("count") || "20", 10) || 20));
    const page = Math.max(1, parseInt(url.searchParams.get("pages") || url.searchParams.get("page") || "1", 10) || 1);
    if (!keyword) {
      return new Response(JSON.stringify([]), { status: 200, headers });
    }
    const tracks = await searchTracks(env || {}, keyword, rawSource, count, page);
    if (tracks.length > 0 || !getSonicConfig(env).enableGdstudio) {
      const legacyItems = tracks.map((t) => ({
        id: t.id,
        name: t.name,
        artist: [t.artist],
        album: t.album,
        pic_id: t.picId || t.id,
        url_id: t.urlId || t.id,
        lyric_id: t.lyricId || t.id,
        source: t.source,
      }));
      return new Response(JSON.stringify(legacyItems), { status: 200, headers });
    }
  } else if (types === "url") {
    if (!rawId) {
      return new Response(JSON.stringify({ url: "", br: 0 }), { status: 200, headers });
    }
    const br = parseInt(url.searchParams.get("br") || "320", 10) || 320;
    const quality = br >= 740 ? "flac" : br >= 320 ? "320" : br >= 192 ? "192" : "128";
    if (!getSonicConfig(env).enableGdstudio) {
      return new Response(
        JSON.stringify({
          url: `/api/music/stream?id=${encodeURIComponent(rawId)}&source=${encodeURIComponent(rawSource)}&quality=${quality}`,
          br,
          source: "local",
        }),
        { status: 200, headers },
      );
    }
  } else if (types === "pic") {
    if (!getSonicConfig(env).enableGdstudio) {
      return new Response(
        JSON.stringify({
          url: rawId ? `/api/music/cover?id=${encodeURIComponent(rawId)}&source=${encodeURIComponent(rawSource)}` : "",
        }),
        { status: 200, headers },
      );
    }
  } else if (types === "lyric") {
    const lyr = await getUniversalLyrics(env || {}, { id: rawId, source: rawSource });
    if (lyr.rawLyric || !getSonicConfig(env).enableGdstudio) {
      return new Response(
        JSON.stringify({
          lyric: lyr.rawLyric || "",
          tlyric: "",
        }),
        { status: 200, headers },
      );
    }
  }

  // 2. Optional third-party GDStudio fallback (ONLY when SONIC_ENABLE_GDSTUDIO=1)
  const cfg = getSonicConfig(env);
  if (!cfg.enableGdstudio) {
    return new Response(
      JSON.stringify({
        error: "Third-party proxy disabled by default (SONIC_ENABLE_GDSTUDIO=false)",
      }),
      { status: 501, headers },
    );
  }

  const apiUrl = new URL(cfg.upstreamGdstudio);
  const forwardedParams = new Set(['types', 'source', 'id', 'name', 'count', 'pages', 'page', 'br']);
  url.searchParams.forEach((value, key) => {
    if (forwardedParams.has(key)) apiUrl.searchParams.set(key, value);
  });

  const upstreamCheck = validateSafeUrl(apiUrl, {
    allowHttp: false,
    allowedDomains: [apiUrl.hostname],
  });
  if (!upstreamCheck.valid) {
    return new Response(JSON.stringify({ error: 'Configured upstream is not a safe HTTPS target' }), {
      status: 502,
      headers,
    });
  }

  try {
    const upstreamResponse = await safeFetch(
      upstreamCheck.url!,
      {
        headers: {
          'User-Agent': 'Sonic-Gateway/2.2',
          Accept: 'application/json',
        },
      },
      {
        allowHttp: false,
        allowedDomains: [apiUrl.hostname],
        maxRedirects: 2,
        timeoutMs: 8000,
        maxBytes: 8 * 1024 * 1024,
      },
    );
    const upstreamContentType = (upstreamResponse.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (
      upstreamContentType &&
      upstreamContentType !== 'application/json' &&
      upstreamContentType !== 'text/json' &&
      upstreamContentType !== 'text/plain'
    ) {
      upstreamResponse.body?.cancel().catch(() => {});
      return new Response(JSON.stringify({ error: 'Upstream returned a non-JSON content type' }), {
        status: 502,
        headers,
      });
    }
    const outHeaders = createCorsHeaders(upstreamResponse.headers);
    outHeaders.set('X-Content-Type-Options', 'nosniff');
    outHeaders.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
    if (!outHeaders.has('Content-Type')) {
      outHeaders.set('Content-Type', 'application/json; charset=utf-8');
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: outHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: "Upstream fetch failed" }), {
      status: 502,
      headers,
    });
  }
}

export async function onRequest({ request, env }: { request: Request; env?: AppEnv }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const engineDenied = checkEngineAccess(request, env);
  if (engineDenied) return engineDenied;
  const rl = await evaluateGatewayRateLimit(request, env, "legacy-proxy");
  if (!rl.allowed) return buildRateLimitErrorResponse(rl);

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    try {
      return await proxyKuwoAudio(target, request, env);
    } catch (error: any) {
      console.warn('[Sonic Proxy] Kuwo audio proxy rejected or failed:', redactSensitiveString(String(error?.message || error)));
      return new Response("Upstream fetch rejected", {
        status: 502,
        headers: createCorsHeaders(),
      });
    }
  }

  return proxyApiRequest(url, request, env);
}

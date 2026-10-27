import { getUniversalLyrics, searchTracks } from "./_lib/music";
import { getSonicConfig } from "./_lib/sonic/config";
import {
  buildRateLimitErrorResponse,
  checkEngineAccess,
  evaluateGatewayRateLimit,
  isBlockedSsrfHost,
  safeFetch,
  hostMatchesDomain,
} from "./_lib/sonic/security";
import {
  buildStreamedProxyResponse,
  getContentType,
  isAllowedContentType,
  parseByteLimit,
  parseConcurrency,
  parseMaxRedirects,
  parseTimeoutMs,
  readBodyWithLimit,
} from "./_lib/sonic/proxy-safety";
import type { AppEnv } from "./_lib/types";

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
  if (init) {
    init.forEach((value, key) => {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    });
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
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
  return hostMatchesDomain(hostname, "kuwo.cn") && !isBlockedSsrfHost(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443" && parsed.port !== "80") return null;
    if (!isAllowedKuwoHost(parsed.hostname)) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = "https:";
    parsed.port = "";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request, env?: AppEnv): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400, headers: createCorsHeaders() });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      Referer: "https://www.kuwo.cn/",
      Accept: "audio/*,application/octet-stream;q=0.8",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader && rangeHeader.length <= 256) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  try {
    const upstream = await safeFetch(
      normalized.toString(),
      init,
      {
        allowHttp: false,
        allowedDomains: ["kuwo.cn"],
        maxRedirects: parseMaxRedirects(env?.SONIC_PROXY_MAX_REDIRECTS),
        timeoutMs: parseTimeoutMs(env?.SONIC_PROXY_TIMEOUT_MS, 15000),
        maxConcurrency: parseConcurrency(env?.SONIC_PROXY_MAX_CONCURRENCY),
      },
    );

    if (!upstream.ok && upstream.status !== 206) {
      upstream.body?.cancel().catch(() => {});
      return new Response("Upstream audio request failed", {
        status: 502,
        headers: createCorsHeaders(),
      });
    }

    if (!isAllowedContentType(getContentType(upstream), "audio")) {
      upstream.body?.cancel().catch(() => {});
      return new Response("Unsupported upstream content type", {
        status: 415,
        headers: createCorsHeaders(),
      });
    }

    const response = buildStreamedProxyResponse(upstream, {
      kind: "audio",
      maxBytes: parseByteLimit(env?.SONIC_AUDIO_MAX_BYTES, 256 * 1024 * 1024, 1024, 512 * 1024 * 1024),
      isHead: request.method === "HEAD",
      cacheControl: "public, max-age=3600",
    });
    response.headers.set("X-Sonic-Provider", "kuwo-legacy");
    return response;
  } catch (error) {
    console.warn(
      "[Sonic Legacy Proxy] Audio proxy rejected:",
      error instanceof Error ? error.message : "unknown error",
    );
    return new Response("Upstream audio request failed", {
      status: 502,
      headers: createCorsHeaders(),
    });
  }
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
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback") return;
    apiUrl.searchParams.set(key, value);
  });

  try {
    const upstreamResponse = await fetch(apiUrl.toString(), {
      headers: {
        "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(parseTimeoutMs(env?.SONIC_PROXY_TIMEOUT_MS, 10000)),
    });

    if (!upstreamResponse.ok) {
      upstreamResponse.body?.cancel().catch(() => {});
      return new Response(JSON.stringify({ error: "Upstream fetch failed" }), {
        status: 502,
        headers,
      });
    }

    if (!isAllowedContentType(getContentType(upstreamResponse), "json")) {
      upstreamResponse.body?.cancel().catch(() => {});
      return new Response(JSON.stringify({ error: "Unsupported upstream content type" }), {
        status: 502,
        headers,
      });
    }

    const bytes = await readBodyWithLimit(upstreamResponse, 4 * 1024 * 1024);
    const outHeaders = createCorsHeaders(upstreamResponse.headers);
    outHeaders.set("Content-Type", "application/json; charset=utf-8");
    outHeaders.set("Content-Length", String(bytes.byteLength));
    return new Response(bytes, { status: upstreamResponse.status, headers: outHeaders });
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
    return proxyKuwoAudio(target, request, env);
  }

  return proxyApiRequest(url, request, env);
}

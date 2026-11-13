// Sonic Gateway — Provider HTTP Boundary
// Every provider/legacy upstream request goes through here: HTTPS-only targets on
// an authorized host family, per-hop redirect validation, credential stripping on
// an origin change, and bounded JSON reads. Uses only a leaf helper so legacy modules
// (`music.ts`) can adopt it without creating an import cycle.
import { fetchWithoutRedirect } from '../fetch-direct';

const PROVIDER_REDIRECT_HOST_SUFFIXES = [
  'music.163.com',
  '163.com',
  '126.net',
  'qq.com',
  'gtimg.cn',
  'kugou.com',
  'kuwo.cn',
  'lrclib.net',
  'amll.dev',
  'musixmatch.com',
  'gdstudio.xyz',
  'lyriva.xyz',
];

export function isAllowedProviderHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  return PROVIDER_REDIRECT_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

const PROVIDER_JSON_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read a JSON body with a hard byte ceiling. A hostile or broken provider must
 * not be able to balloon isolate/heap memory via an unbounded response.
 */
export async function readBoundedProviderJson(response: Response, maxBytes = PROVIDER_JSON_MAX_BYTES): Promise<any> {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Provider response exceeds size limit');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('Provider response exceeds size limit');
    return JSON.parse(text);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error('Provider response exceeds size limit');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * Provider JSON/API fetch with redirect validation.
 *
 * Native protocol calls may carry provider cookies (NETEASE_COOKIE / QQ_COOKIE /
 * KUGOU_COOKIE). Following a provider-controlled redirect with those headers is
 * a credential-leak and SSRF risk, so every hop is restricted to the provider
 * host families, HTTPS only, and cookies are stripped on an origin change.
 */
export async function fetchProviderUrl(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let currentUrl = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
  );
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);
  let redirects = 0;

  while (true) {
    if (currentUrl.protocol !== 'https:' || !isAllowedProviderHost(currentUrl.hostname)) {
      throw new Error('Provider request target is not an authorized HTTPS host');
    }
    const remaining = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Provider request timeout', 'TimeoutError')),
      remaining,
    );
    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let response: Response;
    try {
      response = await fetch(currentUrl.toString(), {
        ...init,
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    void response.body?.cancel().catch(() => {});
    if (++redirects > 3) throw new Error('Too many provider redirects');

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== 'https:' || !isAllowedProviderHost(nextUrl.hostname)) {
      throw new Error('Provider redirect target is not an authorized HTTPS host');
    }
    if (nextUrl.origin !== currentUrl.origin) {
      for (const name of [
        'cookie',
        'authorization',
        'proxy-authorization',
        'x-real-ip',
        'x-forwarded-for',
      ]) {
        headers.delete(name);
      }
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
    } else if (
      body !== undefined &&
      body !== null &&
      typeof body !== 'string' &&
      !(body instanceof URLSearchParams) &&
      !(body instanceof Uint8Array) &&
      !(body instanceof ArrayBuffer)
    ) {
      throw new Error('Streaming provider bodies cannot be replayed across redirects');
    }
    currentUrl = nextUrl;
  }
}

/**
 * Direct provider fetch for callers outside the native-protocol layer: no
 * redirects are followed at all (a provider 302 to an internal address must
 * never trigger a second request), so caller-set credentials cannot leak to a
 * cross-origin hop.
 */
export async function fetchProviderDirect(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<Response> {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('Invalid provider URL');
  }
  if (url.protocol !== 'https:' || !isAllowedProviderHost(url.hostname)) {
    throw new Error('Provider request target is not an authorized HTTPS host');
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Provider request timeout', 'TimeoutError')),
    Math.max(1, timeoutMs),
  );
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchWithoutRedirect(url.toString(), {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

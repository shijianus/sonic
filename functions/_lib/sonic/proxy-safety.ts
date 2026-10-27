// Shared response policy for same-origin media proxies. Upstream headers are
// never copied wholesale; only the fields below are forwarded.

export type ProxyResourceKind = 'audio' | 'image' | 'lyrics' | 'json' | 'asset';

export class ResponseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseLimitError';
  }
}

const FORWARDED_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'image/svg+xml',
]);

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/apng',
]);

const AUDIO_TYPES = new Set([
  'application/ogg',
  'application/octet-stream',
  'binary/octet-stream',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
]);

export function getContentType(response: Response): string {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

export function isAllowedContentType(contentType: string, kind: ProxyResourceKind): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (!type || ACTIVE_TYPES.has(type)) return false;

  if (kind === 'image') return IMAGE_TYPES.has(type);
  if (kind === 'audio') return type.startsWith('audio/') || AUDIO_TYPES.has(type);
  if (kind === 'lyrics') {
    return type === 'text/plain' || type === 'application/ttml+xml';
  }
  if (kind === 'json') {
    return type === 'application/json' || type === 'text/json';
  }
  return type.startsWith('audio/')
    || type.startsWith('image/') && IMAGE_TYPES.has(type)
    || type === 'text/plain'
    || type === 'application/ttml+xml'
    || type === 'application/json'
    || type === 'text/json'
    || AUDIO_TYPES.has(type);
}

export function parseByteLimit(value: unknown, fallback: number, min = 1024, max = 512 * 1024 * 1024): number {
  return Math.min(max, Math.max(min, parseInt(String(value ?? ''), 10) || fallback));
}

export function parseTimeoutMs(value: unknown, fallback: number): number {
  return Math.min(60_000, Math.max(1000, parseInt(String(value ?? ''), 10) || fallback));
}

export function parseMaxRedirects(value: unknown, fallback = 3): number {
  return Math.min(5, Math.max(0, parseInt(String(value ?? ''), 10) || fallback));
}

export function parseConcurrency(value: unknown, fallback = 32): number {
  return Math.min(256, Math.max(1, parseInt(String(value ?? ''), 10) || fallback));
}

export function buildProxyHeaders(
  upstream: Response,
  options: {
    kind: ProxyResourceKind;
    cacheControl: string;
    includeContentLength?: boolean;
  },
): Headers {
  const headers = new Headers();
  for (const key of FORWARDED_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }

  const upstreamEncoding = upstream.headers.get('content-encoding');
  if (options.includeContentLength && !upstreamEncoding) {
    const length = upstream.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
  }

  headers.set('Content-Type', getContentType(upstream));
  headers.set('Cache-Control', options.cacheControl);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Range, Content-Length, Accept-Ranges, Content-Type, X-Sonic-Provider, X-Sonic-Via, X-Sonic-Stream-Trial',
  );
  return headers;
}

export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseLimitError('Upstream response exceeds configured byte limit');
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseLimitError('Upstream response exceeds configured byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function createLimitedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new ResponseLimitError('Upstream response exceeds configured byte limit'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  body.pipeTo(transformer.writable).catch(() => {});
  return transformer.readable;
}

export function buildStreamedProxyResponse(
  upstream: Response,
  options: {
    kind: ProxyResourceKind;
    maxBytes: number;
    isHead: boolean;
    cacheControl: string;
  },
): Response {
  const contentType = getContentType(upstream);
  if (!isAllowedContentType(contentType, options.kind)) {
    upstream.body?.cancel().catch(() => {});
    throw new ResponseLimitError('Unsupported upstream content type');
  }

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    upstream.body?.cancel().catch(() => {});
    throw new ResponseLimitError('Upstream response exceeds configured byte limit');
  }

  const headers = buildProxyHeaders(upstream, {
    kind: options.kind,
    cacheControl: options.cacheControl,
    includeContentLength: true,
  });

  if (options.isHead) {
    upstream.body?.cancel().catch(() => {});
    return new Response(null, { status: upstream.status, headers });
  }

  if (!upstream.body) {
    return new Response(null, { status: upstream.status, headers });
  }

  return new Response(createLimitedStream(upstream.body, options.maxBytes), {
    status: upstream.status,
    headers,
  });
}

// Sonic Local Engine — Node http.IncomingMessage -> WHATWG Request adapter
// The engine is service-facing: the request URL must not be derived from client-supplied
// Host/X-Forwarded-* headers, and the client IP must come from the actual socket.

import type http from 'node:http';
import { Readable } from 'node:stream';

export const ENGINE_INTERNAL_ORIGIN = 'http://engine.internal';

// Never let inbound client headers influence origin, client-IP or internal call identity.
const UNTRUSTED_INBOUND_HEADERS = new Set([
  'host',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'x-sonic-hop',
]);

export function normalizeSocketIp(address?: string): string {
  if (!address) return '';
  let ip = address.trim();
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) {
    ip = ip.slice('::ffff:'.length);
  }
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  return ip.replace(/^\[|\]$/g, '');
}

function requestPathAndQuery(rawUrl?: string): string {
  const value = rawUrl || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  return value.startsWith('/') ? value : `/${value}`;
}

export function sanitizeInboundHeaders(
  rawHeaders: Record<string, string | string[] | undefined>,
  socketAddress?: string,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (UNTRUSTED_INBOUND_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const socketIp = normalizeSocketIp(socketAddress);
  if (socketIp) {
    headers.set('CF-Connecting-IP', socketIp);
  }
  return headers;
}

const requestControllers = new WeakMap<Request, AbortController>();

export function abortWebRequest(request: Request, reason = new DOMException('Server draining', 'AbortError')): void {
  requestControllers.get(request)?.abort(reason);
}

export function toWebRequest(req: http.IncomingMessage, res?: http.ServerResponse): Request {
  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const controller = new AbortController();
  const cleanup = () => {
    req.removeListener('aborted', onDisconnect);
    req.removeListener('close', onRequestClose);
    req.socket?.removeListener('close', onDisconnect);
    res?.removeListener('close', onResponseClose);
    res?.removeListener('finish', cleanup);
    controller.signal.removeEventListener('abort', cleanup);
  };
  const onDisconnect = () => controller.abort(new DOMException('Client disconnected', 'AbortError'));
  // Since Node 16, request.close also means a fully received request. It is NOT
  // a disconnected response socket: a GET/POST can still be waiting on upstream.
  const onRequestClose = () => { if (req.aborted || !req.complete) onDisconnect(); };
  const onResponseClose = () => {
    if (!res?.writableFinished) onDisconnect();
    cleanup();
  };
  req.once('aborted', onDisconnect);
  req.once('close', onRequestClose);
  req.socket?.once('close', onDisconnect);
  res?.once('close', onResponseClose);
  res?.once('finish', cleanup);
  controller.signal.addEventListener('abort', cleanup, { once: true });

  try {
    const request = new Request(`${ENGINE_INTERNAL_ORIGIN}${requestPathAndQuery(req.url)}`, {
      method,
      headers: sanitizeInboundHeaders(req.headers, req.socket?.remoteAddress),
      body: hasBody ? (Readable.toWeb(req) as any) : undefined,
      duplex: hasBody ? 'half' : undefined,
      signal: controller.signal,
    } as RequestInit);
    requestControllers.set(request, controller);
    if (req.aborted || req.socket?.destroyed) onDisconnect();
    return request;
  } catch (error) {
    cleanup();
    throw error;
  }
}

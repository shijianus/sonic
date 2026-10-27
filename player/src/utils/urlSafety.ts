const FALLBACK_ORIGIN = 'http://localhost'

function baseOrigin(): string {
  return typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : FALLBACK_ORIGIN
}

function isRootRelative(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value, baseOrigin())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

export function sanitizeImageSrc(value?: string): string {
  const raw = String(value ?? '').trim()
  if (!raw || raw.startsWith('//')) return ''
  if (isRootRelative(raw) || raw.startsWith('blob:')) return raw
  if (/^data:image\/[a-z0-9.+-]+[,;]/i.test(raw)) return raw
  return parseHttpUrl(raw)?.href ?? ''
}

export function sanitizeMediaSrc(value?: string): string {
  const raw = String(value ?? '').trim()
  if (!raw || raw.startsWith('//')) return ''
  if (isRootRelative(raw) || raw.startsWith('blob:')) return raw
  if (/^data:(?:audio|video)\/[a-z0-9.+-]+[,;]/i.test(raw)) return raw
  return parseHttpUrl(raw)?.href ?? ''
}

export function sanitizeHref(value?: string): string {
  const raw = String(value ?? '').trim()
  if (!raw || raw.startsWith('//')) return '/'
  if (isRootRelative(raw)) return raw
  return parseHttpUrl(raw)?.href ?? '/'
}

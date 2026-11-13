export type SearchErrorKind = 'network' | 'rateLimited' | 'upstream' | 'timeout'

const UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT'

export function hasSearchTimeout(payload: any): boolean {
  const attempts = payload?.meta?.attempts
  return payload?.error?.code === UPSTREAM_TIMEOUT ||
    (Array.isArray(attempts) && attempts.some(attempt => attempt?.errorCode === UPSTREAM_TIMEOUT))
}

export function classifySearchError(error: unknown): SearchErrorKind {
  const err = error as any
  const message = String(err?.message || '')
  const status = Number(err?.response?.status ?? err?.status ?? message.match(/Sonic HTTP (\d{3})/)?.[1] ?? 0)
  if (status === 429) return 'rateLimited'
  if (status === 504 || err?.code === UPSTREAM_TIMEOUT || hasSearchTimeout(err?.response?.data)) return 'timeout'
  if (status > 0) return 'upstream'
  if (err?.name === 'TypeError' || /failed to fetch|network|offline|timeout/i.test(message)) return 'network'
  return 'upstream'
}

export function checkSearchPayload(payload: any) {
  if (payload?.error || Number(payload?.code) >= 400) {
    const code = payload?.error?.code
    const status = /rate.limit/i.test(String(code)) ? 429 : Number(payload?.status ?? payload?.code) || 502
    throw Object.assign(new Error('Search provider failed'), { status, code })
  }
}

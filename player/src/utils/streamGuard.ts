/**
 * Stream Guard Client Helper (Phase 1)
 * Manages short-lived playback tickets and graceful fallback for audio streaming and downloading.
 */
import { httpPost } from '@/utils/http'

interface CachedTicket {
  ticket: string
  trackKey: string
  expiresAtMs: number
}

const ticketCache = new Map<string, CachedTicket>()

export async function requestPlaybackTicket(
  id: string | number,
  source = 'netease',
  br = '320',
  purpose: 'play' | 'download' = 'play',
  forceFresh = false
): Promise<string | null> {
  const cleanId = String(id || '').trim()
  if (!cleanId) return null

  const trackKey = `${purpose}:${source}:${cleanId}:${br}`
  const now = Date.now()

  // Reuse cached ticket if within valid window (leave 15s margin), unless forceFresh requested
  if (!forceFresh) {
    const cached = ticketCache.get(trackKey)
    if (cached && cached.expiresAtMs - now > 15_000) {
      return cached.ticket
    }
  }

  try {
    const res: any = await httpPost('/music/ticket', {
      id: cleanId,
      source,
      br,
      purpose,
    })

    if (res && (res.ok || res.ticket) && res.ticket) {
      const ttlSec = Number(res.expiresIn || 120)
      ticketCache.set(trackKey, {
        ticket: res.ticket,
        trackKey,
        expiresAtMs: now + ttlSec * 1000,
      })
      return res.ticket
    }
  } catch {
    // Graceful degradation: network error or offline returns null without throwing
  }

  return null
}

export function clearPlaybackTicketCache(): void {
  ticketCache.clear()
}

/**
 * Strips transient ticket parameters (t=, ticket=, grant=) from audio stream URLs
 * to ensure persistent storage never stores stale or expiring credentials.
 */
export function stripTicketFromUrl(url?: string | null): string {
  if (!url || typeof url !== 'string' || !url.includes('/api/music/stream')) return url || ''
  try {
    const dummyBase = 'http://localhost'
    const isRelative = url.startsWith('/')
    const parsed = new URL(url, dummyBase)
    if (parsed.searchParams.has('t') || parsed.searchParams.has('ticket') || parsed.searchParams.has('grant')) {
      parsed.searchParams.delete('t')
      parsed.searchParams.delete('ticket')
      parsed.searchParams.delete('grant')
      return isRelative ? `${parsed.pathname}${parsed.search}` : parsed.toString()
    }
  } catch {}
  return url
}

/**
 * Checks if a stream URL has no ticket or if the embedded ticket has expired or is nearing expiration.
 */
export function isTicketExpired(url?: string | null): boolean {
  if (!url || typeof url !== 'string' || !url.includes('/api/music/stream')) return false
  try {
    const dummyBase = 'http://localhost'
    const parsed = new URL(url, dummyBase)
    const ticket = parsed.searchParams.get('t') || parsed.searchParams.get('ticket')
    if (!ticket) return true // Gateway stream URL without ticket is considered expired/requiring ticket
    const parts = ticket.split('.')
    if (parts.length !== 3 || parts[0] !== 'st_v1') return false
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    const jsonStr = atob(padded)
    const payload = JSON.parse(jsonStr)
    if (typeof payload?.exp === 'number') {
      const nowSec = Math.floor(Date.now() / 1000)
      return nowSec >= payload.exp - 5
    }
    return false
  } catch {
    return false
  }
}

/**
 * Determines whether a playback diagnostic error is due to ticket/grant expiration or invalidity
 * versus a permanent source error (404/copyright/upstream fault).
 */
export function isTicketOrGrantError(statusCode: number, errorData?: any): boolean {
  if (statusCode !== 403) return false
  const code = String(errorData?.error?.code || errorData?.code || '').toUpperCase()
  return (
    code.includes('TICKET') ||
    code.includes('GRANT') ||
    code.includes('EXPIRED') ||
    code.includes('AUTH')
  )
}

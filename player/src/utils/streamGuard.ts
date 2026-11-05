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

let cachedTicket: CachedTicket | null = null

export async function requestPlaybackTicket(
  id: string | number,
  source = 'netease',
  br = '320',
  purpose: 'play' | 'download' = 'play'
): Promise<string | null> {
  const cleanId = String(id || '').trim()
  if (!cleanId) return null

  const trackKey = `${purpose}:${source}:${cleanId}:${br}`
  const now = Date.now()

  // Reuse cached ticket if within valid window (leave 15s margin)
  if (
    cachedTicket &&
    cachedTicket.trackKey === trackKey &&
    cachedTicket.expiresAtMs - now > 15_000
  ) {
    return cachedTicket.ticket
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
      cachedTicket = {
        ticket: res.ticket,
        trackKey,
        expiresAtMs: now + ttlSec * 1000,
      }
      return res.ticket
    }
  } catch {
    // Graceful degradation: network error or offline returns null without throwing
  }

  return null
}

export function clearPlaybackTicketCache(): void {
  cachedTicket = null
}

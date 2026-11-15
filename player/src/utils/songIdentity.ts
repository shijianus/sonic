import type { Song } from '@/stores/interface'

type SongLike = Partial<Song> & {
  canonicalTrackId?: string
  downloadKey?: string
}

/**
 * Stable identity for UI, queue and persistence operations.
 * Provider IDs are only meaningful together with their provider namespace.
 */
export const songIdentityKey = (song: SongLike | null | undefined): string => {
  if (!song) return ''
  if (song.downloadKey) return `download:${String(song.downloadKey)}`
  if (song.isLocal) return `local:${String(song.id ?? '')}`

  const source = String(song.source || song.platform || '').trim().toLowerCase()
  const platformId = String(song.platformId ?? (source && source !== 'sonic' ? song.id ?? '' : '')).trim()
  const rawId = String(song.id ?? '').trim()
  const prefixed = rawId.match(/^([a-z][a-z0-9_-]*):(.+)$/i)
  const sourcePairs = [
    ...(source && source !== 'sonic' ? [`${source}:${platformId || rawId}`] : []),
    ...(prefixed && !source ? [`${prefixed[1].toLowerCase()}:${prefixed[2]}`] : []),
    ...(Array.isArray(song.sources)
      ? song.sources.map(item => `${String(item.platform || '').trim().toLowerCase()}:${String(item.platformId ?? '').trim()}`)
      : []),
  ].filter(pair => pair !== ':')
  const uniquePairs = Array.from(new Set(sourcePairs)).sort()
  if (uniquePairs.length > 0) return `aggregate:${String(song.id ?? '')}:${uniquePairs.join('|')}`

  const resolvedSource = String(song.resolvedSource || '').trim().toLowerCase()
  const resolvedId = String(song.resolvedPlatformId ?? song.resolvedId ?? '').trim()
  if (resolvedSource && resolvedId) return `resolved:${resolvedSource}:${resolvedId}`

  const urlPair = (() => {
      const value = String(song.url || song.streamUrl || '')
      try {
        const parsed = new URL(value, 'https://sonic.invalid/')
        if (parsed.pathname === '/api/music/stream' && !parsed.searchParams.has('target') && !parsed.searchParams.has('url')) {
          const id = parsed.searchParams.get('id') || ''
          const platform = String(parsed.searchParams.get('source') || '').trim().toLowerCase()
          if (platform && id) return [`${platform}:${id}`]
        }
      } catch {}
      return []
    })()
  if (urlPair.length > 0) return `aggregate:${String(song.id ?? '')}:${urlPair[0]}`

  // Legacy numeric IDs use NetEase as the established fallback namespace.
  // This keeps the identity stable when URL resolution later writes the
  // equivalent resolvedSource/resolvedPlatformId fields onto the Song object.
  if (/^\d+$/.test(rawId)) return `resolved:netease:${rawId}`

  if (song.canonicalTrackId) return `canonical:${String(song.canonicalTrackId)}`
  return `id:${String(song.id ?? '')}`
}

/**
 * Sonic 智能音乐推荐与混合搜索引擎前端 API 客户端
 * 与 `/api/sonic/recommend/*`、`/api/sonic/search/smart`、`/api/sonic/events` 对接
 */
import { inspectGatewayHeaders } from '@/utils/gatewayHealth'
import { formatCoverUrl } from '@/utils/imageUrl'
import { normalizeDurationMs, type SongData } from '@/utils/transformers'

export interface RecommendExplanation {
  primaryReason: string
  reasonCode: string
  scoreSource:
    | 'cfsolara-internal'
    | 'external-chart'
    | 'personalized-interest'
    | 'content-similarity'
    | 'hybrid-personalized'
    | 'cold-start-curated'
    | string
  similarityBasis?: string
  signals?: Array<{ type: string; label: string; weight: number }>
}

export interface RecommendSongItem extends SongData {
  canonicalTrackId?: string
  edition?: string
  language?: string
  genres?: string[]
  recommendScore?: number
  scoreSource?: string
  recommendReason?: string
  explanation?: RecommendExplanation
  matchReasons?: string[]
  popularity?: {
    internalScore: number
    externalChartScore: number
    uniqueListeners: number
    effectivePlays: number
    velocityScore: number
    confidence: number
  }
}

export interface SmartSuggestionItem {
  text: string
  type: 'song' | 'artist' | 'query' | 'genre'
  subLabel?: string
  score: number
}

export interface SonicEventPayload {
  eventId?: string
  type?:
    | 'search'
    | 'search_click'
    | 'play_start'
    | 'play_progress'
    | 'play_complete'
    | 'skip'
    | 'replay'
    | 'favorite'
    | 'unfavorite'
    | 'dislike'
    | 'undislike'
    | 'open'
    | 'add_to_playlist'
    | 'watch_progress'
    | 'watch_complete'
  action?: string
  entity_type?: 'track' | 'album' | 'playlist' | 'mv'
  entity_id?: string
  progress?: number
  session_id?: string
  context?: {
    from?: string
    [key: string]: any
  }
  timestamp?: number
  track?: {
    id?: string | number
    canonicalTrackId?: string
    title?: string
    name?: string
    artist?: string
    album?: string
    duration?: number
    platform?: string
    cover?: string
    genres?: string[]
    streamType?: 'full' | 'trial' | 'unavailable'
  }
  query?: string
  playedSeconds?: number
  durationSeconds?: number
  progressRatio?: number
  reason?: string
}

export function mapSonicTrackToRecommendSong(t: any): RecommendSongItem {
  const rawId = t.platformId || t.id
  const title = t.title || t.name || ''
  const artist = t.artist || ''
  const durMs = normalizeDurationMs(t.duration)
  return {
    id: rawId,
    name: title,
    artist,
    artistId: t.artistId ?? undefined,
    artists: t.artistId ? [{ id: t.artistId, name: artist }] : undefined,
    album: t.album || '',
    albumId: 0,
    cover: formatCoverUrl(t.cover || t.coverUrl || t.artistPic || '', { size: 300, artist }),
    duration: durMs,
    dt: durMs,
    url:
      t.streamUrl ||
      `/api/music/stream?id=${encodeURIComponent(String(rawId))}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
    sha: t.sha || '',
    qualityBadge: t.qualityBadge || undefined,
    qualities: t.qualities || [],
    sources: t.sources || [],
    source: t.source,
    platform: t.platform,
    platformId: t.platformId,
    resolvedSource: t.resolvedSource,
    resolvedId: t.resolvedId,
    resolvedPlatformId: t.resolvedPlatformId,
    resolvedTitle: t.resolvedTitle,
    resolvedArtist: t.resolvedArtist,
    streamType: t.streamType || undefined,
    liked: false,
    canonicalTrackId: t.canonicalTrackId,
    edition: t.edition,
    language: t.language,
    genres: Array.isArray(t.genres) ? t.genres : [],
    recommendScore: t.recommendScore,
    scoreSource: t.scoreSource || t.explanation?.scoreSource,
    recommendReason: t.explanation?.primaryReason || t.matchReasons?.[0] || '',
    explanation: t.explanation,
    matchReasons: t.matchReasons,
    popularity: t.popularity,
  }
}

async function sonicFetchJson<T = any>(
  pathWithQuery: string,
  init?: RequestInit
): Promise<T> {
  const resp = await fetch(pathWithQuery, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  })
  inspectGatewayHeaders(resp.headers as any)
  if (!resp.ok) {
    throw new Error(`Sonic HTTP ${resp.status}`)
  }
  return (await resp.json()) as T
}

export async function fetchRecommendForYou(
  params: {
    mode?: 'for-you' | 'recent' | 'favorites' | 'next' | 'radio'
    count?: number
    seedTrackId?: string | number
    seedTitle?: string
    seedArtist?: string
    exclude?: string[]
    diversity?: number
    temperature?: number
  } = {},
  headers: Record<string, string> = {}
) {
  const q = new URLSearchParams()
  if (params.mode) q.set('mode', params.mode)
  if (params.count) q.set('count', String(params.count))
  if (params.seedTrackId) q.set('seedTrackId', String(params.seedTrackId))
  if (params.seedTitle) q.set('seedTitle', params.seedTitle)
  if (params.seedArtist) q.set('seedArtist', params.seedArtist)
  if (params.exclude?.length) q.set('exclude', params.exclude.slice(0, 20).join(','))
  if (params.diversity !== undefined) q.set('diversity', String(params.diversity))
  if (params.temperature !== undefined) q.set('temperature', String(params.temperature))

  const json = await sonicFetchJson<any>(`/api/sonic/recommend/for-you?${q.toString()}`, { headers })
  const rawTracks = Array.isArray(json?.data?.tracks)
    ? json.data.tracks
    : Array.isArray(json?.data)
      ? json.data.filter((item: any) => item.type === 'track').map((item: any) => item.payload || item)
      : []
  return {
    personalized: Boolean(json?.data?.personalized ?? json?.meta?.personalized),
    privacyMode: String(json?.data?.privacyMode || 'public'),
    profileSummary: json?.data?.profileSummary || { hasHistory: false, topArtists: [], topGenres: [] },
    tracks: rawTracks.map(mapSonicTrackToRecommendSong),
    meta: json?.meta || {},
  }
}

export interface MixedFeedItemDto {
  type: 'track' | 'album' | 'playlist' | 'mv'
  id: string
  title: string
  subtitle: string
  cover: string
  score: number
  reason: string
  payload: Record<string, any>
}

export async function fetchRecommendMixedFeed(
  params: {
    count?: number
    types?: string[]
    diversity?: number
    temperature?: number
    exclude?: string[]
  } = {},
  headers: Record<string, string> = {}
): Promise<{
  items: MixedFeedItemDto[]
  distribution?: Record<string, number>
  meta: Record<string, any>
}> {
  const q = new URLSearchParams()
  q.set('feed', 'mixed')
  if (params.count) q.set('count', String(params.count))
  if (params.types?.length) q.set('types', params.types.join(','))
  if (params.diversity !== undefined) q.set('diversity', String(params.diversity))
  if (params.temperature !== undefined) q.set('temperature', String(params.temperature))
  if (params.exclude?.length) q.set('exclude', params.exclude.join(','))

  const json = await sonicFetchJson<any>(`/api/sonic/recommend/for-you?${q.toString()}`, { headers })
  const items = Array.isArray(json?.data) ? json.data : []
  return {
    items,
    distribution: json?.meta?.distribution,
    meta: json?.meta || {},
  }
}

export async function fetchRecommendTrending(
  params: {
    window?: '24h' | '7d' | 'all' | 'surging' | 'new'
    genre?: string
    count?: number
    personalized?: boolean
  } = {},
  headers: Record<string, string> = {}
) {
  const q = new URLSearchParams()
  if (params.window) q.set('window', params.window)
  if (params.genre) q.set('genre', params.genre)
  if (params.count) q.set('count', String(params.count))
  if (params.personalized) q.set('personalized', '1')

  const json = await sonicFetchJson<any>(`/api/sonic/recommend/trending?${q.toString()}`, { headers })
  const rawTracks = Array.isArray(json?.data?.tracks) ? json.data.tracks : []
  return {
    window: String(json?.data?.window || params.window || '7d'),
    stationStats: json?.data?.stationStats || { activeTracksWithPlays: 0, totalCatalogTracks: 0 },
    tracks: rawTracks.map(mapSonicTrackToRecommendSong),
    meta: json?.meta || {},
  }
}

export async function fetchRecommendSimilar(
  params: {
    trackId?: string | number
    title?: string
    artist?: string
    album?: string
    count?: number
    includeSameArtist?: boolean
  },
  headers: Record<string, string> = {}
) {
  const q = new URLSearchParams()
  if (params.trackId) q.set('trackId', String(params.trackId))
  if (params.title) q.set('title', params.title)
  if (params.artist) q.set('artist', params.artist)
  if (params.album) q.set('album', params.album)
  if (params.count) q.set('count', String(params.count))
  if (params.includeSameArtist === false) q.set('includeSameArtist', '0')

  const json = await sonicFetchJson<any>(`/api/sonic/recommend/similar?${q.toString()}`, { headers })
  const rawTracks = Array.isArray(json?.data?.tracks) ? json.data.tracks : []
  return {
    seed: json?.data?.seed || null,
    similarArtists: Array.isArray(json?.data?.similarArtists) ? json.data.similarArtists : [],
    similarityMethod: String(json?.data?.similarityMethod || 'metadata-cosine-and-session-cooccurrence'),
    tracks: rawTracks.map(mapSonicTrackToRecommendSong),
    meta: json?.meta || {},
  }
}

export async function fetchRecommendDiscover(
  params: {
    genre?: string
    language?: string
    temperature?: number
    count?: number
  } = {},
  headers: Record<string, string> = {}
) {
  const q = new URLSearchParams()
  if (params.genre) q.set('genre', params.genre)
  if (params.language) q.set('language', params.language)
  if (params.temperature !== undefined) q.set('temperature', String(params.temperature))
  if (params.count) q.set('count', String(params.count))

  const json = await sonicFetchJson<any>(`/api/sonic/recommend/discover?${q.toString()}`, { headers })
  const rawTracks = Array.isArray(json?.data?.tracks) ? json.data.tracks : []
  return {
    genre: json?.data?.genre || null,
    temperature: Number(json?.data?.temperature ?? params.temperature ?? 0.55),
    availableGenres: Array.isArray(json?.data?.availableGenres) ? json.data.availableGenres : [],
    tracks: rawTracks.map(mapSonicTrackToRecommendSong),
    meta: json?.meta || {},
  }
}

export async function fetchSmartSearch(
  params: {
    q: string
    page?: number
    count?: number
    personalize?: boolean
  },
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  const qs = new URLSearchParams({
    q: params.q,
    page: String(params.page || 1),
    count: String(params.count || 30),
  })
  if (params.personalize === false) qs.set('personalize', '0')

  const json = await sonicFetchJson<any>(`/api/sonic/search/smart?${qs.toString()}`, {
    headers,
    signal,
  })
  const data = json?.data || {}
  const rawTracks = Array.isArray(data.tracks) ? data.tracks : []
  const rawFallback = Array.isArray(data.fallbackTracks) ? data.fallbackTracks : []
  return {
    query: String(data.query || params.q),
    normalizedQuery: String(data.normalizedQuery || params.q),
    expandedTerms: Array.isArray(data.expandedTerms) ? data.expandedTerms : [],
    total: Number(data.total || rawTracks.length),
    personalizedApplied: Boolean(data.personalizedApplied),
    tracks: rawTracks.map(mapSonicTrackToRecommendSong),
    suggestions: (Array.isArray(data.suggestions) ? data.suggestions : []) as SmartSuggestionItem[],
    fallbackUsed: Boolean(data.fallbackUsed),
    fallbackTracks: rawFallback.map(mapSonicTrackToRecommendSong),
    meta: json?.meta || {},
  }
}

export async function fetchSmartSuggest(
  q: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<SmartSuggestionItem[]> {
  const qs = new URLSearchParams({ mode: 'suggest', q, count: '8' })
  const json = await sonicFetchJson<any>(`/api/sonic/search/smart?${qs.toString()}`, {
    headers,
    signal,
  })
  return Array.isArray(json?.data?.suggestions) ? json.data.suggestions : []
}

type StoredEventPrivacyMode = 'authenticated' | 'anonymous-opt-in'
type SonicEventPostResult =
  | { status: 'sent' | 'identity-mismatch' | 'retry' }
  | { status: 'epoch-mismatch'; eventEpoch?: string | null }

function isEventEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

export async function postSonicEvents(
  events: SonicEventPayload[],
  headers: Record<string, string>,
  { expectedMode, eventEpoch }: { expectedMode: StoredEventPrivacyMode; eventEpoch?: string }
): Promise<SonicEventPostResult> {
  if (!events.length) return { status: 'retry' }
  try {
    const resp = await fetch('/api/sonic/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ events, eventEpoch }),
      keepalive: true,
    })
    if (resp.ok) return { status: 'sent' }
    if (resp.status === 409) {
      const result = await resp.json()
      if (result?.brand === 'Sonic') {
        if (result.error?.code === 'EVENT_INGEST_IDENTITY_MISMATCH') return { status: 'identity-mismatch' }
        if (result.error?.code === 'EVENT_EPOCH_MISMATCH') {
          const epoch = result.data?.eventEpoch
          return result.data?.privacyMode === expectedMode && (epoch === null || isEventEpoch(epoch))
            ? { status: 'epoch-mismatch', eventEpoch: epoch }
            : { status: 'epoch-mismatch' }
        }
      }
    }
    return { status: 'retry' }
  } catch {
    return { status: 'retry' }
  }
}

export async function deleteSonicEvents(
  headers: Record<string, string>,
  expectedMode: StoredEventPrivacyMode | 'public'
): Promise<{ eventEpoch: string | null } | null> {
  try {
    const resp = await fetch('/api/sonic/events', {
      method: 'DELETE',
      headers,
    })
    if (!resp.ok) return null
    const result = await resp.json()
    if (result?.brand !== 'Sonic') return null
    const data = result.data
    if (data?.privacyMode !== expectedMode) return null
    if (!Number.isSafeInteger(data.removedEvents) || data.removedEvents < 0) return null
    if (expectedMode === 'public') {
      return data.cleared === false && data.removedEvents === 0 ? { eventEpoch: null } : null
    }
    return data.cleared === true && data.storageKind === 'sqlite' && isEventEpoch(data.eventEpoch)
      ? { eventEpoch: data.eventEpoch }
      : null
  } catch {
    return null
  }
}

export async function fetchUserRadarAlbum(
  headers: Record<string, string> = {}
): Promise<{ data: any; syncedAt: number | null } | null> {
  try {
    const json = await sonicFetchJson<any>('/api/sonic/recommend/radar-album', { headers })
    return json?.data ? { data: json.data, syncedAt: json.syncedAt || null } : null
  } catch {
    return null
  }
}

export async function syncUserRadarAlbum(
  payload: Record<string, any>,
  headers: Record<string, string> = {}
): Promise<boolean> {
  try {
    const resp = await fetch('/api/sonic/recommend/radar-album', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    })
    return resp.ok
  } catch {
    return false
  }
}

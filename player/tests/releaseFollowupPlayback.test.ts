import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Song } from '@/stores/interface'
import { songPlaybackSource, songSourceCandidates } from '@/utils/audioUtils'
import { transformSong } from '@/utils/transformers'
import { mapSonicTrackToRecommendSong } from '@/api/recommend'
import i18n from '@/languages'

const { songUrlV1Mock } = vi.hoisted(() => ({ songUrlV1Mock: vi.fn() }))
vi.mock('@/api', () => ({ songUrlV1: songUrlV1Mock }))
vi.mock('@/utils/gatewayHealth', () => ({
  inspectGatewayHeaders: vi.fn(), markStreamFailure: vi.fn(),
  gatewayHealth: { degraded: false, statusKind: 'normal', message: '' },
}))

import { useAudioStore } from '@/stores/modules/audio'
import { useLyrics } from '@/composables/useLyrics'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const song = (id: string | number, extra: Partial<Song> = {}): Song => ({
  id, name: 'Original track', artist: 'Original artist', duration: 180000, ...extra,
})
const asUrl = (url: string) => new URL(url, 'http://localhost')
const lyricsResponse = (text: string) => ({ brand: 'Sonic', data: { syncedLyrics: [{ startMs: 1000, text }] } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const head = (source: string, id: string, type = 'full') => new Response(null, { headers: {
  'x-sonic-resolved-source': source, 'x-sonic-resolved-id': id,
  'x-sonic-stream-type': type,
  'x-sonic-resolved-title': encodeURIComponent('Resolved track'),
  'x-sonic-resolved-artist': encodeURIComponent('Resolved artist'),
} })
const ready = (target: Song) => {
  const store = useAudioStore()
  const audio = document.createElement('audio')
  vi.spyOn(audio, 'play').mockResolvedValue(undefined)
  vi.spyOn(audio, 'pause').mockImplementation(() => {})
  vi.spyOn(audio, 'load').mockImplementation(() => {})
  store.audio.audio = audio
  store.setPlaylist([target], 0)
  return { store, audio }
}

beforeEach(() => {
  setActivePinia(createPinia())
  useLyrics().clearLyrics()
  songUrlV1Mock.mockReset().mockResolvedValue({ data: [] })
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'HEAD' ? new Response(null, { status: 404 }) : json({})))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  useAudioStore().stop()
  useLyrics().clearLyrics()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('release follow-up playback source pairing', () => {
  it.each([
    song('qq:12345'),
    song('12345', { source: 'qq' }),
    song('12345', { platform: 'tencent', platformId: '12345' }),
    song('kugou:feedbeef'),
  ])('does not rotate an unmapped provider ID on retry ($id)', async target => {
    const { store } = ready(target)
    const expected = songPlaybackSource(target)!
    for (let attempt = 0; attempt < 3; attempt++) {
      await store._fetchAndApplyUrl(target, true, true)
      const query = asUrl(target.url!).searchParams
      expect(query.get('source')).toBe(expected.platform)
      expect(query.get('id')).toBe(expected.platformId)
      expect(query.get('nocache')).toBe('1')
      expect(query.has('retry')).toBe(false)
      expect(query.has('ts')).toBe(false)
      expect(target.id).toBe(attempt === -1 ? '' : target.id)
    }
    await expect(store._fetchAndApplyUrl(target, true, true)).rejects.toThrow('retry limit')
    expect(songUrlV1Mock).not.toHaveBeenCalled()
  })

  it('rotates only verified source/ID pairs and keeps stable song identity', async () => {
    const target = song('aggregate-identity', { sources: [
      { platform: 'netease', platformId: '100' },
      { platform: 'qq', platformId: 'qq:200' },
      { platform: 'kugou', platformId: '' },
      { platform: 'kuwo', platformId: 'qq:unrelated' },
    ] })
    const { store } = ready(target)
    await store._fetchAndApplyUrl(target, true)
    expect(asUrl(target.url!).searchParams.get('id')).toBe('100')
    await store._fetchAndApplyUrl(target, true, true)
    expect(asUrl(target.url!).searchParams.get('source')).toBe('qq')
    expect(asUrl(target.url!).searchParams.get('id')).toBe('200')
    expect(target).toMatchObject({ id: 'aggregate-identity', name: 'Original track', artist: 'Original artist', resolvedSource: 'qq', resolvedId: '200', resolvedPlatformId: '200' })
    expect(songSourceCandidates(target)).toHaveLength(2)
  })

  it('rejects an aggregate ID with missing source mappings rather than guessing NetEase', async () => {
    const target = song('sha-identity', { sources: [{ platform: 'qq', platformId: '' }] })
    const { store } = ready(target)
    await expect(store._fetchAndApplyUrl(target, true, true)).rejects.toThrow('No verified audio source mapping')
    expect(target.url).toBeUndefined()
    expect(songUrlV1Mock).not.toHaveBeenCalled()
  })

  it('repairs a legacy default-source URL before loading a QQ song', async () => {
    const target = song('2323', { source: 'qq', url: '/api/music/stream?id=2323' })
    const { store, audio } = ready(target)
    await store.playSong(target, 0, true)
    const query = asUrl(audio.src).searchParams
    expect(query.get('source')).toBe('qq')
    expect(query.get('id')).toBe('2323')
    expect(songUrlV1Mock).not.toHaveBeenCalled()
  })

  it('manual retry discards every stale URL location and requests a fresh resolved identity', async () => {
    const stale = 'https://cdn.invalid/expired.mp3'
    const target = song('stable-retry', {
      sources: [{ platform: 'netease', platformId: '111' }],
      resolvedSource: 'qq', resolvedPlatformId: '222',
      url: stale, streamUrl: stale,
      qualities: [{ level: 'exhigh', label: 'HQ', bitrate: '320', streamUrl: stale }],
    })
    const { store, audio } = ready(target)
    store.audio.error = 'expired'
    await store.playSong(target, 0, true)
    const query = asUrl(audio.src).searchParams
    expect(query.get('source')).toBe('qq')
    expect(query.get('id')).toBe('222')
    expect(query.get('nocache')).toBe('1')
    expect(target.id).toBe('stable-retry')
    expect(songUrlV1Mock).not.toHaveBeenCalled()
    expect(store.audio.error).toBeNull()
  })

  it.each(['pause', 'stop'] as const)('%s prevents a late URL from mutating or starting playback', async action => {
    const target = song(action === 'pause' ? 51001 : 51002)
    const { store, audio } = ready(target)
    const pending = deferred<any>()
    songUrlV1Mock.mockReturnValueOnce(pending.promise)
    const playing = store.playSong(target, 0, true)
    store[action]()
    pending.resolve({ data: [{ url: 'https://cdn.invalid/late.mp3' }] })
    await playing
    expect(audio.play).not.toHaveBeenCalled()
    expect(target.url).toBeUndefined()
    expect(target.resolvedSource).toBeUndefined()
    expect(store.audio.isLoading).toBe(false)
  })

  it('a same-song fresh generation cannot be overwritten by the older URL promise', async () => {
    const target = song(52001)
    const { store } = ready(target)
    const pending = deferred<any>()
    songUrlV1Mock.mockReturnValueOnce(pending.promise)
    const first = store.playSong(target, 0, true)
    await store.refreshAndReplay()
    const currentUrl = target.url
    pending.resolve({ data: [{ url: 'https://cdn.invalid/old.mp3' }] })
    await first
    expect(target.url).toBe(currentUrl)
    expect(asUrl(target.url!).searchParams.get('nocache')).toBe('1')
    expect(store.audio.error).toBeNull()
  })

  it('coalesces matching source requests but never different source IDs', async () => {
    const store = useAudioStore()
    const first = song('same-stable', { source: 'netease', platformId: '6001' })
    const copy = { ...first }
    const other = song('same-stable', { source: 'netease', platformId: '6002' })
    const pending = deferred<any>()
    songUrlV1Mock.mockReturnValue(pending.promise)
    const a = store._fetchAndApplyUrl(first)
    const b = store._fetchAndApplyUrl(copy)
    expect(songUrlV1Mock).toHaveBeenCalledTimes(1)
    const c = store._fetchAndApplyUrl(other)
    expect(songUrlV1Mock).toHaveBeenCalledTimes(2)
    pending.resolve({ data: [] })
    await Promise.all([a, b, c])
    expect(first.url).toBeUndefined()
    expect(copy.url).toBeUndefined()
    expect(asUrl(other.url!).searchParams.get('id')).toBe('6002')
  })

  it('bounds automatic failures and does not try another song/provider', async () => {
    const target = song('qq:bounded')
    const { store, audio } = ready(target)
    vi.mocked(audio.play).mockRejectedValue(new Error('source unavailable'))
    const report = vi.spyOn(store, '_reportPlaybackError').mockImplementation(() => {})
    await store.playSong(target, 0, true)
    expect(audio.play).toHaveBeenCalledTimes(4)
    expect(report).toHaveBeenCalledOnce()
    expect(asUrl(target.url!).searchParams.get('source')).toBe('qq')
    expect(asUrl(target.url!).searchParams.get('id')).toBe('bounded')
    expect(store.audio.isLoading).toBe(false)
  })
})

describe('release follow-up stream metadata generations', () => {
  it('applies an atomic pair and aliases without changing the song or display identity', async () => {
    const target = song('metadata-stable', { url: '/api/music/stream?id=91&source=netease' })
    const { store } = ready(target)
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'HEAD' ? head('qq', '92', 'trial') : json(lyricsResponse('Bound lyrics'))))
    await store._probeStreamMetadata(target)
    expect(target).toMatchObject({ id: 'metadata-stable', name: 'Original track', artist: 'Original artist', resolvedSource: 'qq', resolvedId: '92', resolvedPlatformId: '92', streamType: 'trial' })
    expect(store.audio.currentSong?.resolvedId).toBe('92')
  })

  it.each(['url', 'stop'] as const)('ignores a late metadata response after %s changes', async change => {
    const target = song('late-metadata', { url: '/api/music/stream?id=93&source=netease' })
    const { store } = ready(target)
    const pending = deferred<Response>()
    const fetchMock = vi.fn(() => pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const probe = store._probeStreamMetadata(target)
    if (change === 'url') target.url = '/api/music/stream?id=94&source=qq'
    else store.stop()
    pending.resolve(head('kugou', 'wrong-id'))
    await probe
    expect(target.resolvedSource).toBeUndefined()
    expect(target.resolvedId).toBeUndefined()
    if (change === 'stop') expect((fetchMock.mock.calls[0] as any)[1].signal.aborted).toBe(true)
  })

  it('ignores partial provider metadata and unsuccessful HEAD responses', async () => {
    const target = song('partial-metadata', { url: '/api/music/stream?id=95&source=netease', resolvedSource: 'netease', resolvedId: '95' })
    const { store } = ready(target)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'x-sonic-resolved-source': 'qq' } })))
    await store._probeStreamMetadata(target)
    expect(target.resolvedSource).toBe('netease')
    expect(target.resolvedId).toBe('95')
    target.url += '&nocache=1'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404, headers: { 'x-sonic-resolved-source': 'qq', 'x-sonic-resolved-id': 'other' } })))
    await store._probeStreamMetadata(target)
    expect(target.resolvedSource).toBe('netease')
  })
})

describe('release follow-up lyrics same-source fallback and cancellation', () => {
  it.each([
    ['initial URL assignment', undefined],
    ['same-source URL renewal', '/api/music/stream?id=9201&source=netease&token=expired'],
  ] as const)('settles noLyrics after %s without a replacement lyric request', async (_label, initialUrl) => {
    const target = song(9201, {
      name: 'No Lyric Track', artist: 'Tester F', url: initialUrl,
      resolvedSource: 'netease', resolvedId: '9201', resolvedPlatformId: '9201',
    })
    const { store } = ready(target)
    const lyrics = useLyrics()
    const pending = deferred<Response>()
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 404 }))
      if (url.startsWith('/api/sonic/lyrics/nexus')) return pending.promise
      return Promise.resolve(json({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const loading = lyrics.fetchLyrics(store.audio.currentSong, true)
    await store._fetchAndApplyUrl(store.audio.currentSong!, true)
    expect(target.url).not.toBe(initialUrl)
    expect(songPlaybackSource(target)).toEqual({ platform: 'netease', platformId: '9201' })
    // The drawer/stream listener sees the same source identity and joins the request.
    const joined = lyrics.fetchLyrics(store.audio.currentSong)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'HEAD')).toHaveLength(1)
    pending.resolve(json({ brand: 'Sonic', data: { level: 'none', syncedLyrics: [] } }))
    await Promise.all([loading, joined])

    expect(lyrics.mergedLines.value.map(line => line.ori)).toEqual([i18n.global.t('song.noLyrics')])
    expect(lyrics.loading.value).toBe(false)
    const lyricCalls = fetchMock.mock.calls.filter(([, init]) => init?.method !== 'HEAD')
    expect(lyricCalls.map(([url]) => asUrl(url).pathname)).toEqual(['/api/sonic/lyrics/nexus', '/api/music/lyric', '/api/lyric'])
    expect(lyricCalls.every(([, init]) => init?.signal === lyricCalls[0][1]?.signal && !init?.signal?.aborted)).toBe(true)
  })

  it('still discards an in-flight lyric response when the provider ID actually changes without a replacement', async () => {
    const target = song('unchanged-song-id', { resolvedSource: 'qq', resolvedPlatformId: 'old' })
    const { store } = ready(target)
    const lyrics = useLyrics()
    const pending = deferred<Response>()
    const fetchMock = vi.fn(() => pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const loading = lyrics.fetchLyrics(store.audio.currentSong, true)
    target.resolvedPlatformId = 'new'
    pending.resolve(json(lyricsResponse('Stale words')))
    await loading
    expect(lyrics.mergedLines.value).toHaveLength(0)
    expect(lyrics.loading.value).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses resolved source+ID in all three stages, never classifies numeric QQ IDs as NetEase', async () => {
    const target = song('original-id', { source: 'kugou', resolvedSource: 'qq', resolvedPlatformId: '73123' })
    const fetchMock = vi.fn(async () => json({}))
    vi.stubGlobal('fetch', fetchMock)
    await useLyrics().fetchLyrics(target, true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map(call => asUrl((call as any)[0]))
    expect(urls[0].searchParams.get('platform')).toBe('qq')
    expect(urls[0].searchParams.get('platformId')).toBe('73123')
    expect(urls[0].searchParams.get('qqMusicId')).toBe('73123')
    expect(urls[0].searchParams.has('ncmMusicId')).toBe(false)
    for (const url of urls.slice(1)) {
      expect(url.searchParams.get('source')).toBe('qq')
      expect(url.searchParams.get('id')).toBe('73123')
      expect(url.search).not.toContain('original-id')
    }
    const signals = fetchMock.mock.calls.map(call => (call as any)[1].signal)
    expect(signals.every(signal => signal === signals[0])).toBe(true)
  })

  it('source changes on the same song ID invalidate old lyrics and fetch the new identity', async () => {
    const target = song('same-lyrics-id', { source: 'qq', resolvedSource: 'qq', resolvedPlatformId: 'old' })
    const { store } = ready(target)
    const pending = deferred<Response>()
    const fetchMock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(json(lyricsResponse('Fresh bound words')))
    vi.stubGlobal('fetch', fetchMock)
    const lyrics = useLyrics()
    const first = lyrics.fetchLyrics(store.audio.currentSong, true)
    store.audio.currentSong!.resolvedPlatformId = 'new'
    await lyrics.fetchLyrics(store.audio.currentSong)
    pending.resolve(json(lyricsResponse('Stale words')))
    await first
    expect(lyrics.mergedLines.value[0].ori).toBe('Fresh bound words')
    expect(asUrl(fetchMock.mock.calls[1][0]).searchParams.get('platformId')).toBe('new')
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cancelled fallback shares the signal and never launches the classic request', async () => {
    const lyrics = useLyrics()
    const pending = deferred<Response>()
    const fetchMock = vi.fn().mockResolvedValueOnce(json({})).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const loading = lyrics.fetchLyrics(song('qq:cancel-lyrics'), true)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    lyrics.clearLyrics()
    pending.resolve(json({}))
    await loading
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(lyrics.mergedLines.value).toHaveLength(0)
    expect(lyrics.loading.value).toBe(false)
  })

  it('a cached selection cancels a pending different selection instead of being overwritten', async () => {
    const lyrics = useLyrics()
    const a = song('qq:cached-selection')
    const b = song('qq:pending-selection')
    const pending = deferred<Response>()
    const fetchMock = vi.fn().mockResolvedValueOnce(json(lyricsResponse('Cached words'))).mockReturnValueOnce(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    await lyrics.fetchLyrics(a, true)
    const loadingB = lyrics.fetchLyrics(b, true)
    await lyrics.fetchLyrics(a)
    pending.resolve(json(lyricsResponse('Wrong words')))
    await loadingB
    expect(lyrics.mergedLines.value[0].ori).toBe('Cached words')
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true)
    expect(lyrics.loading.value).toBe(false)
  })

  it('does not persist a transient lyrics miss as a successful cache entry', async () => {
    const target = song('qq:lyric-failure-retry')
    const lyrics = useLyrics()
    const fetchMock = vi.fn(async () => json({}))
    vi.stubGlobal('fetch', fetchMock)
    await lyrics.fetchLyrics(target)
    fetchMock.mockImplementation(async () => json(lyricsResponse('Recovered words')))
    await lyrics.fetchLyrics(target)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(lyrics.mergedLines.value[0].ori).toBe('Recovered words')
  })
})

describe('release follow-up mapper metadata preservation', () => {
  it.each([transformSong, mapSonicTrackToRecommendSong])('preserves provided identity aliases and source metadata', map => {
    const metadata = { source: 'netease', platform: 'sonic', platformId: '10', resolvedSource: 'qq', resolvedId: '20', resolvedPlatformId: '20', resolvedTitle: 'Bound', resolvedArtist: 'Artist', sources: [{ platform: 'qq', platformId: '20' }], streamType: 'trial' }
    expect(map({ id: '10', name: 'Track', duration: 180000, ...metadata })).toMatchObject(metadata)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Song } from '@/stores/interface'

const { httpPostMock, songUrlV1Mock } = vi.hoisted(() => ({
  httpPostMock: vi.fn(),
  songUrlV1Mock: vi.fn(),
}))

vi.mock('@/utils/http', () => ({
  httpPost: httpPostMock,
  httpGet: vi.fn(),
}))

vi.mock('@/api', () => ({
  songUrlV1: songUrlV1Mock,
}))

vi.mock('@/utils/gatewayHealth', () => ({
  inspectGatewayHeaders: vi.fn(),
  markStreamFailure: vi.fn(),
  gatewayHealth: { degraded: false, statusKind: 'normal', message: '' },
}))

import { useAudioStore } from '@/stores/modules/audio'
import { requestPlaybackTicket, clearPlaybackTicketCache } from '@/utils/streamGuard'

const song = (id: string | number, extra: Partial<Song> = {}): Song => ({
  id,
  name: 'Test Song',
  artist: 'Test Artist',
  duration: 180000,
  platform: 'netease',
  ...extra,
})

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

describe('Stream Guard Fallback & Resilience (Requirement 4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    clearPlaybackTicketCache()
    httpPostMock.mockReset()
    songUrlV1Mock.mockReset().mockResolvedValue({ data: [] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    useAudioStore().stop()
    clearPlaybackTicketCache()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('Scenario 1: /api/music/ticket returns HTTP 500 error -> graceful degradation without error', async () => {
    // Simulate server 500 failure
    httpPostMock.mockRejectedValue({
      response: { status: 500, data: { error: 'Internal Server Error' } },
    })

    // 1. Direct helper verification
    const ticket = await requestPlaybackTicket('1001', 'netease', '320')
    expect(ticket).toBeNull()

    // 2. Audio Store playback verification
    const testSong = song('1001', { platform: 'netease' })
    const { store, audio } = ready(testSong)

    // Must resolve cleanly without throwing any exception
    await expect(store.playSong(testSong, 0, true)).resolves.not.toThrow()

    // Stream URL falls back to standard unticketed gateway stream
    const resolvedUrl = new URL(audio.src)
    expect(resolvedUrl.pathname).toBe('/api/music/stream')
    expect(resolvedUrl.searchParams.get('id')).toBe('1001')
    expect(resolvedUrl.searchParams.has('t')).toBe(false)
  })

  it('Scenario 2: /api/music/ticket times out (ECONNABORTED) -> graceful degradation without error', async () => {
    // Simulate network request timeout
    const timeoutError = Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    })
    httpPostMock.mockRejectedValue(timeoutError)

    // 1. Direct helper verification
    const ticket = await requestPlaybackTicket('1002', 'netease', '320')
    expect(ticket).toBeNull()

    // 2. Audio Store playback verification
    const testSong = song('1002', { platform: 'netease' })
    const { store, audio } = ready(testSong)

    await expect(store.playSong(testSong, 0, true)).resolves.not.toThrow()

    const resolvedUrl = new URL(audio.src)
    expect(resolvedUrl.pathname).toBe('/api/music/stream')
    expect(resolvedUrl.searchParams.get('id')).toBe('1002')
    expect(resolvedUrl.searchParams.has('t')).toBe(false)
  })

  it('Scenario 3: /api/music/ticket network disconnected (Network Error) -> graceful degradation without error', async () => {
    // Simulate complete client network disconnection
    httpPostMock.mockRejectedValue(new Error('Network Error'))

    // 1. Direct helper verification
    const ticket = await requestPlaybackTicket('1003', 'netease', '320')
    expect(ticket).toBeNull()

    // 2. Audio Store playback verification
    const testSong = song('1003', { platform: 'netease' })
    const { store, audio } = ready(testSong)

    await expect(store.playSong(testSong, 0, true)).resolves.not.toThrow()

    const resolvedUrl = new URL(audio.src)
    expect(resolvedUrl.pathname).toBe('/api/music/stream')
    expect(resolvedUrl.searchParams.get('id')).toBe('1003')
    expect(resolvedUrl.searchParams.has('t')).toBe(false)
  })

  it('Scenario 4: /api/music/ticket succeeds -> ticket attached to stream URL', async () => {
    const mockTicket = 'st_v1.eyJzdWIiOiJhbm9uOjEyMyJ9.valid_sig_123'
    httpPostMock.mockResolvedValue({
      ok: true,
      ticket: mockTicket,
      expiresIn: 120,
    })

    const ticket = await requestPlaybackTicket('1004', 'netease', '320')
    expect(ticket).toBe(mockTicket)

    const testSong = song('1004', { platform: 'netease' })
    const { store, audio } = ready(testSong)

    await expect(store.playSong(testSong, 0, true)).resolves.not.toThrow()

    const resolvedUrl = new URL(audio.src)
    expect(resolvedUrl.pathname).toBe('/api/music/stream')
    expect(resolvedUrl.searchParams.get('id')).toBe('1004')
    expect(resolvedUrl.searchParams.get('t')).toBe(mockTicket)
  })

  it('Scenario 5: Preload next track carries independent ticket in URL and does not conflict with or overwrite current song', async () => {
    const ticketA = 'st_v1.ticket_song_A.sigA'
    const ticketB = 'st_v1.ticket_song_B.sigB'

    httpPostMock.mockImplementation(async (_url: string, data: any) => {
      if (data?.id === 'song-A') {
        return { ok: true, ticket: ticketA, expiresIn: 120 }
      }
      if (data?.id === 'song-B') {
        return { ok: true, ticket: ticketB, expiresIn: 120 }
      }
      return { ok: true, ticket: 'st_v1.default.sig', expiresIn: 120 }
    })

    const songA = song('song-A', { platform: 'netease', name: 'Song A' })
    const songB = song('song-B', { platform: 'netease', name: 'Song B' })

    const store = useAudioStore()
    const audio = document.createElement('audio')
    vi.spyOn(audio, 'play').mockResolvedValue(undefined)
    vi.spyOn(audio, 'pause').mockImplementation(() => {})
    vi.spyOn(audio, 'load').mockImplementation(() => {})
    store.audio.audio = audio
    store.setPlaylist([songA, songB], 0)

    // 1. Play Song A
    await store.playSong(songA, 0, true)
    expect(audio.src).toContain('id=song-A')
    expect(audio.src).toContain(`t=${ticketA}`)

    // 2. Preload Song B (triggers preloadNextTrack)
    await store.preloadNextTrack()
    expect(songB.url).toBeDefined()
    expect(songB.url).toContain('id=song-B')
    expect(songB.url).toContain(`t=${ticketB}`)

    // 3. Current playing audio must still point to Song A with ticket A
    expect(audio.src).toContain('id=song-A')
    expect(audio.src).toContain(`t=${ticketA}`)
    expect(store.audio.currentSong?.id).toBe('song-A')
  })
})

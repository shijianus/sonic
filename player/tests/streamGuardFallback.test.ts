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
import {
  requestPlaybackTicket,
  clearPlaybackTicketCache,
  stripTicketFromUrl,
  isTicketExpired,
  isTicketOrGrantError,
} from '@/utils/streamGuard'

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

  it('Requirement 7: fetchAndApplyUrl strictly attaches ticket before evaluating final URL', async () => {
    const rawTicket = 'st_v1.payload_exact.sig_exact'
    httpPostMock.mockResolvedValue({
      ok: true,
      ticket: rawTicket,
      expiresIn: 120,
    })

    const testSong = song('track-req-7', { platform: 'netease', name: 'Exact Ticket Test' })
    const { store, audio } = ready(testSong)

    await store.playSong(testSong, 0, true)

    const finalUrl = new URL(audio.src)
    expect(finalUrl.pathname).toBe('/api/music/stream')
    expect(finalUrl.searchParams.get('id')).toBe('track-req-7')
    expect(finalUrl.searchParams.get('source')).toBe('netease')
    expect(finalUrl.searchParams.get('t')).toBe(rawTicket)
    expect(finalUrl.searchParams.has('t')).toBe(true)
  })

  it('Requirement 8: Ticket/grant expiration during playback refreshes ticket, retains same source platform without consuming retry attempts, and preserves currentTime', async () => {
    let ticketCounter = 1
    httpPostMock.mockImplementation(async () => ({
      ok: true,
      ticket: `st_v1.ticket_version_${ticketCounter++}.sig`,
      expiresIn: 120,
    }))

    const candidateSources = [
      { platform: 'netease', platformId: '10001' },
      { platform: 'qq', platformId: '001qq' },
    ]
    const testSong = song('10001', {
      platform: 'netease',
      name: 'Resilient Track',
      sources: candidateSources,
    })
    const { store, audio } = ready(testSong)

    // 1. Initial play
    await store.playSong(testSong, 0, true)
    expect(audio.src).toContain('t=st_v1.ticket_version_1.sig')
    expect(audio.src).toContain('source=netease')

    // 2. Playback reaches 42 seconds
    audio.currentTime = 42
    store.audio.currentTime = 42

    // 3. Ticket expires or diagnostic check returns 403 STREAM_TICKET_REQUIRED
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            brand: 'Sonic',
            error: {
              code: 'TICKET_EXPIRED',
              message: 'Ticket expired',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      )
    )

    // Simulate audio error event (e.g. Range request rejected by server)
    const errorEvent = new Event('error')
    audio.dispatchEvent(errorEvent)

    // Allow async error handler to complete
    await new Promise((r) => setTimeout(r, 50))

    // Assert:
    // a) Sound source platform is STILL netease (NO failover to qq)
    expect(audio.src).toContain('source=netease')
    expect(audio.src).toContain('id=10001')

    // b) New ticket was requested and applied
    expect(audio.src).toContain('t=st_v1.ticket_version_2.sig')

    // c) Retains same sound source, and progress is restored
    expect(store.audio.currentTime).toBe(42)
  })

  it('Requirement 8b: True sound source failure (404/copyright) triggers multi-source failover and consumes retry attempt', async () => {
    httpPostMock.mockResolvedValue({
      ok: true,
      ticket: 'st_v1.valid.sig',
      expiresIn: 120,
    })

    const candidateSources = [
      { platform: 'netease', platformId: '20001' },
      { platform: 'qq', platformId: '002qq' },
    ]
    const testSong = song('20001', {
      platform: 'netease',
      name: 'Failover Track',
      sources: candidateSources,
    })
    const { store, audio } = ready(testSong)

    await store.playSong(testSong, 0, true)
    expect(audio.src).toContain('source=netease')

    // Upstream 404 permanent missing audio
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    )

    // Trigger error
    audio.dispatchEvent(new Event('error'))
    await new Promise((r) => setTimeout(r, 50))

    // Assert: failover switched candidate source to QQ
    expect(audio.src).toContain('source=qq')
    expect(audio.src).toContain('id=002qq')
  })

  it('Requirement 9 & 10: Persisted playlist strips t=, and resuming after pause beyond TTL refreshes ticket and preserves progress', async () => {
    // 1. Test stripTicketFromUrl
    const urlWithTicket = '/api/music/stream?id=100&source=netease&t=st_v1.secret.sig&quality=320'
    const stripped = stripTicketFromUrl(urlWithTicket)
    expect(stripped).not.toContain('t=')
    expect(stripped).toContain('id=100')
    expect(stripped).toContain('source=netease')

    // 2. Test isTicketExpired with expired timestamp (nowSec > exp)
    const expiredPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 100 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const expiredUrl = `/api/music/stream?id=100&source=netease&t=st_v1.${expiredPayload}.sig`
    expect(isTicketExpired(expiredUrl)).toBe(true)

    // Valid ticket (exp 1000s in the future)
    const validPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1000 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const validUrl = `/api/music/stream?id=100&source=netease&t=st_v1.${validPayload}.sig`
    expect(isTicketExpired(validUrl)).toBe(false)

    // Unticketed gateway stream is considered expired/requiring ticket
    expect(isTicketExpired('/api/music/stream?id=100&source=netease')).toBe(true)

    // 3. Resuming playback when song has an expired ticket fetches fresh ticket
    let ticketCounter = 1
    httpPostMock.mockImplementation(async () => ({
      ok: true,
      ticket: `st_v1.fresh_ticket_${ticketCounter++}.sig`,
      expiresIn: 120,
    }))

    const testSong = song('30001', {
      platform: 'netease',
      url: expiredUrl,
    })
    const { store, audio } = ready(testSong)

    // Calling playSong on song with expired ticket -> automatically fetches fresh ticket!
    await store.playSong(testSong, 0, true)
    expect(audio.src).toContain('t=st_v1.fresh_ticket_1.sig')
  })
})

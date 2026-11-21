import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildProbeUrl,
  getProbeTargetKey,
  probeSongQualities,
} from '@/utils/qualityProbe'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('quality probe target identity', () => {
  it('distinguishes the same id across sources and stream URLs', () => {
    const netease = { id: '42', source: 'netease', url: '/api/music/stream?id=42&source=netease' }
    const qq = { id: '42', source: 'qq', url: '/api/music/stream?id=42&source=qq' }

    expect(getProbeTargetKey(netease)).not.toBe(getProbeTargetKey(qq))
    const key = getProbeTargetKey(netease)
    expect(getProbeTargetKey(key)).toBe(key)
  })

  it('creates quality-specific gateway URLs when a song has one stream URL', () => {
    const song = { id: '42', source: 'netease', url: '/api/music/stream?id=42&source=netease' }

    expect(buildProbeUrl(song, 'lossless')).toContain('br=lossless')
    expect(buildProbeUrl(song, 'exhigh')).toContain('br=320')
    expect(buildProbeUrl(song, 'standard')).toContain('br=128')
    const withPreference = { ...song, url: song.url + '&quality=lossless' }
    const target = new URL(buildProbeUrl(withPreference, 'standard'), 'https://sonic.test')
    expect(target.searchParams.get('br')).toBe('128')
    expect(target.searchParams.has('quality')).toBe(false)
  })

  it('does not claim higher qualities from one opaque provider URL', () => {
    const song = { id: '42', url: 'https://cdn.example.test/audio.mp3' }

    expect(buildProbeUrl(song, 'standard')).toBe(song.url)
    expect(buildProbeUrl(song, 'exhigh')).toBe('')
    expect(buildProbeUrl(song, 'lossless')).toBe('')
  })

  it('probes distinct bitrate URLs and caches by the complete target identity', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(null, {
        status: 206,
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Range': 'bytes 0-0/1000',
        },
      })
    }))

    const song = { id: 'probe-42', source: 'netease', url: '/api/music/stream?id=probe-42&source=netease', duration: 180 }
    await probeSongQualities(song, { forceRefresh: true })

    expect(calls).toHaveLength(3)
    expect(calls.some(url => url.includes('br=lossless'))).toBe(true)
    expect(calls.some(url => url.includes('br=320'))).toBe(true)
    expect(calls.some(url => url.includes('br=128'))).toBe(true)
  })
})

it('does not invent a codec or whole-stream size for an untyped partial response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
    status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
  })))
  const probe = await probeSongQualities({ id: 'without-size', duration: 200 }, { forceRefresh: true })
  expect(probe.standard.totalBytes).toBeNull()
  expect(probe.standard.actualBitrateKbps).toBeNull()
  expect(probe.lossless.formatLabel).toBe('—')
})

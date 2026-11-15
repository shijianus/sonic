import { describe, expect, it } from 'vitest'
import { buildDownloadKey, buildDownloadStreamUrl, downloadSourcePair } from '@/utils/indexedDB'

describe('下载身份隔离', () => {
  it('优先使用已解析的平台 ID', () => {
    const song = {
      id: 'aggregate-1',
      source: 'sonic',
      sources: [{ platform: 'netease', platformId: '1001' }],
      resolvedSource: 'qq',
      resolvedPlatformId: 'qq-mid-1',
    }
    expect(downloadSourcePair(song)).toEqual({ platform: 'qq', platformId: 'qq-mid-1' })
    expect(buildDownloadKey(song, 'standard')).not.toBe(buildDownloadKey(song, 'lossless'))
  })

  it('保留同一 ID 在不同平台的独立下载键', () => {
    const netease = { id: '42', source: 'netease', platformId: '42' }
    const qq = { id: '42', source: 'qq', platformId: '42' }
    expect(buildDownloadKey(netease, 'exhigh')).not.toBe(buildDownloadKey(qq, 'exhigh'))
  })

  it('不会为未知聚合 ID 猜测平台', () => {
    expect(downloadSourcePair({ id: 'aggregate-id' })).toBeUndefined()
  })

  it('缺少专用音质 URL 时使用来源感知网关，不复用旧 URL', () => {
    const url = buildDownloadStreamUrl({
      id: '42',
      source: 'qq',
      platformId: 'qq-42',
      name: 'Track',
      artist: 'Artist',
      url: 'https://stale.example/old-quality.mp3',
    }, 'standard')
    expect(url).toContain('/api/music/stream?')
    expect(url).toContain('id=qq-42')
    expect(url).toContain('source=qq')
    expect(url).toContain('br=128')
    expect(url).not.toContain('stale.example')
  })

  it('专用音质 URL 优先于网关回退', () => {
    expect(buildDownloadStreamUrl({
      id: '42',
      source: 'qq',
      platformId: 'qq-42',
      url: 'https://stale.example/old-quality.mp3',
      qualities: [{ level: 'lossless', streamUrl: 'https://cdn.example/lossless.flac' }],
    }, 'lossless')).toBe('https://cdn.example/lossless.flac')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAudioStore } from '../src/stores/modules/audio'
import { useLyrics } from '../src/composables/useLyrics'

describe('曲目、实际音频与歌词强绑定 (Source & Lyrics Synchronization)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('1. useLyrics 优先使用 resolvedSource 与 resolvedId 进行强绑定请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        brand: 'Sonic',
        data: {
          syncedLyrics: [
            { time: 1000, text: '故事的小黄花' },
            { time: 4000, text: '从出生那年就飘着' },
          ],
        },
      }),
    })
    globalThis.fetch = fetchMock as any

    const { fetchLyrics, mergedLines } = useLyrics()

    const song = {
      id: 9999, // 原始虚拟 ID 或哈希
      name: '晴天',
      artist: '周杰伦',
      duration: 269000,
      source: 'netease',
      resolvedSource: 'netease',
      resolvedId: '186016', // 强校验绑定的真实网易云 ID
      resolvedTitle: '晴天',
      resolvedArtist: '周杰伦',
    }

    await fetchLyrics(song, true)

    // 校验发起歌词请求时使用了强绑定的 ncmMusicId 与 platformId
    expect(fetchMock).toHaveBeenCalled()
    const callUrl = fetchMock.mock.calls[0][0] as string
    expect(callUrl).toContain('platformId=186016')
    expect(callUrl).toContain('ncmMusicId=186016')
    expect(mergedLines.value.length).toBe(2)
    expect(mergedLines.value[0].ori).toBe('故事的小黄花')
  })

  it('2. 当音频流解析完成触发 sonic:stream-resolved 时，自动对齐刷新歌词', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        brand: 'Sonic',
        data: {
          syncedLyrics: [{ time: 500, text: '跨源强绑定歌词对齐成功' }],
        },
      }),
    })
    globalThis.fetch = fetchMock as any

    const audioStore = useAudioStore()
    const currentSong = {
      id: 8888,
      name: '稻香',
      artist: '周杰伦',
      duration: 223000,
      url: '/api/music/stream?id=8888',
      resolvedSource: 'qq',
      resolvedId: '0039MnYb0qxYig',
      resolvedTitle: '稻香',
      resolvedArtist: '周杰伦',
    }
    audioStore.audio.currentSong = currentSong as any

    // 触发全局流解析完成事件（携带强绑定元数据）
    window.dispatchEvent(
      new CustomEvent('sonic:stream-resolved', {
        detail: {
          songId: 8888,
          resolvedSource: 'qq',
          resolvedId: '0039MnYb0qxYig',
          resolvedTitle: '稻香',
          resolvedArtist: '周杰伦',
        },
      })
    )

    // 等待微任务
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).toHaveBeenCalled()
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0] as string
    expect(lastCall).toContain('platformId=0039MnYb0qxYig')
    expect(lastCall).toContain('qqMusicId=0039MnYb0qxYig')
  })

  it('3. audioStore._probeStreamMetadata 能正确读取响应头并更新强绑定字段', async () => {
    const audioStore = useAudioStore()
    const song = {
      id: 7777,
      name: '夜曲',
      artist: '周杰伦',
      duration: 226000,
      url: '/api/music/stream?id=7777',
      resolvedSource: undefined as any,
      resolvedId: undefined as any,
    }

    const headMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        'x-sonic-stream-type': 'trial',
        'x-sonic-trial-duration': '30',
        'x-sonic-resolved-source': 'netease',
        'x-sonic-resolved-id': '185709',
        'x-sonic-resolved-title': encodeURIComponent('夜曲'),
        'x-sonic-resolved-artist': encodeURIComponent('周杰伦'),
      }),
    })
    globalThis.fetch = headMock as any

    audioStore.playlist = [song as any]
    audioStore._probeStreamMetadata(song as any)

    await new Promise((r) => setTimeout(r, 50))

    expect(song.streamType).toBe('trial')
    expect(song.trialDuration).toBe(30)
    expect(song.resolvedSource).toBe('netease')
    expect(song.resolvedId).toBe('185709')
    expect(song.resolvedTitle).toBe('夜曲')
    expect(song.resolvedArtist).toBe('周杰伦')
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import type { Song } from '@/stores/interface'

/**
 * 播放竞态回归（SONIC-P1-01/P1-02 前端部分）：
 * 异步取流期间用户暂停/停止/切歌后，迟到的回调不得重新起播、不得把旧错误写到新歌上。
 * 这里通过延迟的 songUrlV1 Promise 模拟真实网关的慢响应。
 */

const songUrlV1Mock = vi.fn()

vi.mock('@/api', () => ({
  songUrlV1: (...args: unknown[]) => songUrlV1Mock(...args),
}))

const { useAudioStore } = await import('@/stores/modules/audio')

const song = (id: number, name = `歌曲 ${id}`, url?: string): Song =>
  ({
    id,
    name,
    artist: '测试歌手',
    duration: 180000,
    ...(url ? { url } : {}),
  }) as unknown as Song

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('播放竞态：暂停/停止/切歌使在途请求失效', () => {
  beforeEach(() => {
    localStorage.clear()
    songUrlV1Mock.mockReset()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({ render: () => null }).use(pinia)
    setActivePinia(pinia)
  })

  const readyStore = () => {
    const store = useAudioStore()
    store.initAudio()
    if (store.audio.audio) {
      vi.spyOn(store.audio.audio, 'play').mockResolvedValue(undefined as never)
      vi.spyOn(store.audio.audio, 'pause').mockImplementation(() => {})
      vi.spyOn(store.audio.audio, 'load').mockImplementation(() => {})
    }
    return store
  }

  it('取流中暂停：迟到的 URL 不触发起播', async () => {
    const store = readyStore()
    const pending = deferred<{ data: Array<{ url: string }> }>()
    songUrlV1Mock.mockReturnValue(pending.promise)

    const target = song(1001)
    store.setPlaylist([target], 0)
    const playing = store.playSong(target, 0, true)

    expect(store.audio.isLoading).toBe(true)
    store.pause()
    expect(store.audio.isLoading).toBe(false)

    pending.resolve({ data: [{ url: '/api/music/stream?id=1001' }] })
    await playing

    expect(store.audio.audio?.play).not.toHaveBeenCalled()
    expect(store.audio.isPlaying).toBe(false)
    expect(store.audio.isLoading).toBe(false)
  })

  it('取流中停止：迟到的 URL 不触发起播', async () => {
    const store = readyStore()
    const pending = deferred<{ data: Array<{ url: string }> }>()
    songUrlV1Mock.mockReturnValue(pending.promise)

    const target = song(1002)
    store.setPlaylist([target], 0)
    const playing = store.playSong(target, 0, true)

    store.stop()
    pending.resolve({ data: [{ url: '/api/music/stream?id=1002' }] })
    await playing

    expect(store.audio.audio?.play).not.toHaveBeenCalled()
    expect(store.audio.isLoading).toBe(false)
    expect(store.audio.currentTime).toBe(0)
  })

  it('加载中再次点击播放键 = 取消起播，而不是重复起播', async () => {
    const store = readyStore()
    const pending = deferred<{ data: Array<{ url: string }> }>()
    songUrlV1Mock.mockReturnValue(pending.promise)

    const target = song(1003)
    store.setPlaylist([target], 0)
    const playing = store.playSong(target, 0, true)
    store.togglePlay()

    pending.resolve({ data: [{ url: '/api/music/stream?id=1003' }] })
    await playing

    expect(store.audio.audio?.play).not.toHaveBeenCalled()
  })

  it('旧歌播放失败晚于新歌起播：不得清空新歌播放状态或弹错误', async () => {
    const store = readyStore()
    const a = song(2001, 'A', '/api/music/stream?id=2001')
    const b = song(2002, 'B', '/api/music/stream?id=2002')
    store.setPlaylist([a, b], 0)

    vi.mocked(store.audio.audio!.play)
      .mockRejectedValueOnce(new Error('stale failure'))
      .mockResolvedValue(undefined as never)

    const playingA = store.playSong(a, 0, true)
    const playingB = store.playSong(b, 1, true)
    await Promise.all([playingA, playingB])

    expect(store.audio.currentSong?.id).toBe(2002)
    expect(store.audio.error).toBeNull()
  })

  it('快速连续切歌：最终只播放最后一次选择的歌曲', async () => {
    const store = readyStore()
    const a = song(3001, 'A', '/api/music/stream?id=3001')
    const b = song(3002, 'B', '/api/music/stream?id=3002')
    const c = song(3003, 'C', '/api/music/stream?id=3003')
    store.setPlaylist([a, b, c], 0)

    const p1 = store.playSong(a, 0, true)
    const p2 = store.playSong(b, 1, true)
    const p3 = store.playSong(c, 2, true)
    await Promise.all([p1, p2, p3])

    expect(store.audio.currentSong?.id).toBe(3003)
    expect(store.audio.currentIndex).toBe(2)
    expect(store.audio.playHistory.at(-1)?.id).toBe(3003)
  })
})

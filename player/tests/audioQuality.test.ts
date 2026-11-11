import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { markRaw } from 'vue'
import { useAudioStore } from '@/stores/modules/audio'
import type { Song } from '@/stores/interface'

class FakeAudio extends EventTarget {
  src = ''
  currentSrc = ''
  currentTime = 0
  duration = 200
  error: MediaError | null = null
  readyState = 0

  constructor(private shouldFail = false, private autoReady = true) {
    super()
  }

  getAttribute(name: string) {
    return name === 'src' ? this.src : null
  }

  load() {
    this.currentTime = 0
    this.readyState = 0
    this.error = null
    const src = this.src
    if (this.autoReady) queueMicrotask(() => this.completeLoad(src, this.shouldFail))
  }

  completeLoad(src = this.src, fail = false) {
    this.currentSrc = new URL(src, window.location.href).href
    this.readyState = fail ? 0 : 3
    this.error = fail ? ({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' } as MediaError) : null
    this.dispatchEvent(new Event(fail ? 'error' : 'canplay'))
  }

  play() {
    if (this.shouldFail) return Promise.reject(new Error('source unavailable'))
    return Promise.resolve()
  }

  pause() {}
}

const makeSong = (streamUrl: string): Song => ({
  id: 1,
  name: 'A',
  artist: 'B',
  duration: 200000,
  url: 'old.mp3',
  qualityBadge: 'SQ',
  qualities: [
    { level: 'lossless', label: 'SQ', bitrate: 'FLAC', streamUrl: 'old.mp3' },
    { level: 'exhigh', label: 'HQ', bitrate: '320kbps', streamUrl },
    { level: 'standard', label: '标准', bitrate: '128kbps', streamUrl: 'standard.mp3' },
  ],
})

const setupStore = (shouldFail = false, autoReady = true) => {
  const store = useAudioStore()
  const fakeAudio = markRaw(new FakeAudio(shouldFail, autoReady))
  const song = makeSong(shouldFail ? 'new-fail.mp3' : 'new-ok.mp3')
  fakeAudio.src = song.url!
  store.audio.audio = fakeAudio as unknown as HTMLAudioElement
  store.audio.currentSong = song
  store.audio.playlist = [song]
  store.audio.originalPlaylist = [song]
  store.audio.currentIndex = 0
  store.audio.isPlaying = false
  return { store, song, fakeAudio }
}

describe('switchQuality', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('新音源可用时提交 URL 与徽章', async () => {
    const { store, song, fakeAudio } = setupStore(false)
    fakeAudio.currentTime = 12

    await expect(store.switchQuality('exhigh')).resolves.toBe(true)

    expect(song.url).toBe('new-ok.mp3')
    expect(song.qualityBadge).toBe('HQ')
    expect(store.audio.playlist[0].url).toBe('new-ok.mp3')
    expect(store.audio.playlist[0].qualityBadge).toBe('HQ')
    expect(store.audio.audio?.currentTime).toBe(12)
    expect(store.audio.isLoading).toBe(false)
  })

  it('新音源失败时回滚 URL、徽章并向上抛出', async () => {
    const { store, song } = setupStore(true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(store.switchQuality('exhigh')).rejects.toBeTruthy()

    expect(song.url).toBe('old.mp3')
    expect(song.qualityBadge).toBe('SQ')
    expect(store.audio.playlist[0].url).toBe('old.mp3')
    expect(store.audio.playlist[0].qualityBadge).toBe('SQ')
    expect(store.audio.isLoading).toBe(false)
    errorSpy.mockRestore()
  })

  it('切歌使旧音质操作失效，旧回调不改队列或媒体源', async () => {
    const { store, song, fakeAudio } = setupStore(false, false)
    const play = vi.spyOn(fakeAudio, 'play')
    store.audio.isPlaying = true
    const second = { ...makeSong('another-hq.mp3'), id: 2, url: 'another.mp3' }
    store.audio.playlist.push(second)

    const quality = store.switchQuality('exhigh')
    await store.playSong(second, 1, true)
    fakeAudio.completeLoad('new-ok.mp3', true)

    await expect(quality).resolves.toBe(false)
    expect(store.audio.currentSong?.id).toBe(2)
    expect(store.audio.playlist.map(item => item.url)).toEqual(['old.mp3', 'another.mp3'])
    expect(song.qualityBadge).toBe('SQ')
    expect(fakeAudio.src).toBe('another.mp3')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('等待音质加载期间暂停，切换完成后保持暂停', async () => {
    const { store, song, fakeAudio } = setupStore(false, false)
    const play = vi.spyOn(fakeAudio, 'play')
    store.audio.isPlaying = true
    fakeAudio.currentTime = 38

    const quality = store.switchQuality('exhigh')
    store.pause()
    fakeAudio.completeLoad()

    await expect(quality).resolves.toBe(true)
    expect(play).not.toHaveBeenCalled()
    expect(store.audio.isPaused).toBe(true)
    expect(store.audio.isLoading).toBe(false)
    expect(fakeAudio.currentTime).toBe(38)
    expect(song.url).toBe('new-ok.mp3')
  })

  it('连续切换时保留原进度，只有第二个音源能提交', async () => {
    const { store, song, fakeAudio } = setupStore(false, false)
    const play = vi.spyOn(fakeAudio, 'play')
    store.audio.isPlaying = true
    fakeAudio.currentTime = 38

    const first = store.switchQuality('exhigh')
    const second = store.switchQuality('standard')
    fakeAudio.completeLoad('new-ok.mp3')
    await expect(first).resolves.toBe(false)
    expect(song.url).toBe('old.mp3')
    expect(store.audio.isLoading).toBe(true)
    fakeAudio.completeLoad()

    await expect(second).resolves.toBe(true)
    expect(fakeAudio.currentTime).toBe(38)
    expect(play).toHaveBeenCalledTimes(1)
    expect(song.url).toBe('standard.mp3')
    expect(song.qualityBadge).toBe('标准')
  })

  it('暂停中断已发起的 play 时保留新音源，不恢复旧音源', async () => {
    const { store, song, fakeAudio } = setupStore(false, false)
    let interruptPlay!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, reject) => { interruptPlay = reject })
    const play = vi.spyOn(fakeAudio, 'play').mockReturnValueOnce(pending)
    vi.spyOn(fakeAudio, 'pause').mockImplementation(() => interruptPlay(new Error('interrupted by pause')))
    store.audio.isPlaying = true

    const quality = store.switchQuality('exhigh')
    fakeAudio.completeLoad()
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    store.pause()

    await expect(quality).resolves.toBe(true)
    expect(store.audio.isPaused).toBe(true)
    expect(store.audio.isPlaying).toBe(false)
    expect(song.url).toBe('new-ok.mp3')
    expect(fakeAudio.src).toBe('new-ok.mp3')
  })

  it('已发起的旧 play 在切歌后失败，不回滚新曲目', async () => {
    const { store, fakeAudio } = setupStore(false, false)
    let rejectOldPlay!: (reason: Error) => void
    const oldPlay = new Promise<void>((_resolve, reject) => { rejectOldPlay = reject })
    const play = vi.spyOn(fakeAudio, 'play').mockReturnValueOnce(oldPlay)
    store.audio.isPlaying = true
    const second = { ...makeSong('another-hq.mp3'), id: 2, url: 'another.mp3' }
    store.audio.playlist.push(second)

    const quality = store.switchQuality('exhigh')
    fakeAudio.completeLoad()
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    await store.playSong(second, 1, true)
    rejectOldPlay(new Error('old source interrupted'))

    await expect(quality).resolves.toBe(false)
    expect(fakeAudio.src).toBe('another.mp3')
    expect(store.audio.currentSong?.url).toBe('another.mp3')
    expect(store.audio.error).toBeNull()
  })

  it('停止取消在途音质，继续播放时恢复最后确认的媒体源', async () => {
    const { store, fakeAudio } = setupStore(false, false)
    const play = vi.spyOn(fakeAudio, 'play')
    store.audio.isPlaying = true

    const quality = store.switchQuality('exhigh')
    store.stop()
    fakeAudio.completeLoad('new-ok.mp3')
    await expect(quality).resolves.toBe(false)
    store.resume()

    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    expect(fakeAudio.src).toBe('old.mp3')
    expect(store.audio.currentSong?.qualityBadge).toBe('SQ')
  })
})

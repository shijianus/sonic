import { describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAudioStore } from '@/stores/modules/audio'
import { ListeningCoverage } from '@/utils/listeningCoverage'
import type { Song } from '@/stores/interface'

const { recordEvent } = vi.hoisted(() => ({ recordEvent: vi.fn() }))
vi.mock('@/stores/modules/recommend', () => ({ useRecommendStore: () => ({ recordEvent }) }))

function playedRanges(...ranges: Array<[number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: index => ranges[index][0],
    end: index => ranges[index][1],
  }
}

describe('listening feedback', () => {
  it('merges actual playback across reloads without counting gaps or overlap', () => {
    const listening = new ListeningCoverage()
    listening.archive(playedRanges([0, 10], [45, 50]))
    listening.archive(playedRanges([8, 22]))
    expect(listening.seconds(playedRanges([20, 30], [47, 55], [85, 90]))).toBe(45)
    expect(listening.seconds()).toBe(27)
  })

  it('ignores a seek to the end and records progress and completion from actual coverage', async () => {
    setActivePinia(createPinia())
    const store = useAudioStore()
    store.initAudio()
    const audio = store.audio.audio!
    vi.spyOn(audio, 'play').mockResolvedValue()
    vi.spyOn(audio, 'pause').mockImplementation(() => {})
    vi.spyOn(audio, 'load').mockImplementation(() => {})
    vi.spyOn(store, 'nextSong').mockImplementation(() => {})
    const ended = vi.spyOn(store, 'handleSongEnd')
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 })
    let played = playedRanges()
    Object.defineProperty(audio, 'played', { configurable: true, get: () => played })
    const song: Song = { id: 1, name: 'A', artist: 'B', duration: 100_000, url: 'https://music.test/audio.mp3' }
    store.setPlaylist([song], 0)
    await store.playSong(song, 0, true)
    audio.dispatchEvent(new Event('playing'))
    await vi.dynamicImportSettled()
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'play_start' }))
    recordEvent.mockClear()

    played = playedRanges([0, 5], [95, 100])
    audio.currentTime = 100
    audio.dispatchEvent(new Event('timeupdate'))
    audio.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(1)
    await vi.dynamicImportSettled()
    expect(recordEvent).not.toHaveBeenCalled()

    played = playedRanges()
    await store.playSong(song, 0, true)
    played = playedRanges([0, 61])
    audio.currentTime = 61
    audio.dispatchEvent(new Event('timeupdate'))
    played = playedRanges([0, 99])
    audio.currentTime = 100
    audio.dispatchEvent(new Event('timeupdate'))
    audio.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(recordEvent.mock.calls.map(([event]) => [event.type, event.playedSeconds])).toEqual([
      ['play_progress', 61],
      ['play_complete', 99],
    ]))

    recordEvent.mockClear()
    const trial = { ...song, id: 2, streamType: 'trial' as const }
    await store.playSong(trial, 0, true)
    played = playedRanges([0, 100])
    audio.currentTime = 100
    audio.dispatchEvent(new Event('playing'))
    audio.dispatchEvent(new Event('timeupdate'))
    audio.dispatchEvent(new Event('ended'))
    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(1))
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'skip', reason: 'trial_end' }))
    store.destroy()
  })
})

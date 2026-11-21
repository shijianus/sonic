import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  decode: vi.fn(), parse: vi.fn(),
}))

vi.mock('@/utils/indexedDB', () => ({
  localMusicDB: { add: mocks.add, delete: mocks.delete, getAll: mocks.getAll },
  downloadedMusicDB: { add: vi.fn(), delete: vi.fn(), getAll: vi.fn() },
}))

vi.mock('@/utils/ecs', () => ({ isEcsFile: vi.fn().mockResolvedValue(false), decodeEcs: mocks.decode }))
vi.mock('music-metadata', () => ({ parseBlob: mocks.parse }))

import { useLocalMusicStore } from '@/stores/modules/localMusic'

const makeMusic = (id: string) => ({
  id,
  name: `本地歌曲 ${id}`,
  artist: '测试歌手',
  album: '',
  duration: 30,
  cover: '',
  file: new Blob(['wav'], { type: 'audio/wav' }),
  createTime: Date.now(),
})

describe('本地音乐删除撤销', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.add.mockReset()
    mocks.delete.mockReset()
  })

  it('validates imported ECS, reads metadata from decoded audio and stores only the original package', async () => {
    const store = useLocalMusicStore()
    const file = new File(['package bytes'], 'download.ECS', { type: 'application/octet-stream' })
    const audio = new Blob(['decoded'], { type: 'audio/wav' })
    mocks.decode.mockResolvedValue({ audio, meta: { title: 'Packaged track', artist: 'Artist' } })
    mocks.parse.mockResolvedValue({ common: { album: 'Tagged album' }, format: { duration: 12 } })
    const item = await store.addMusic(file)
    expect(mocks.decode).toHaveBeenCalledWith(file)
    expect(mocks.parse).toHaveBeenCalledWith(audio)
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ file, name: 'Packaged track', artist: 'Artist', album: 'Tagged album', duration: 12 }))
    expect(store.convertToSong(item)).toMatchObject({ isLocal: true, url: '', duration: 12000 })
    mocks.decode.mockRejectedValueOnce(new Error('Invalid ECS'))
    await expect(store.addMusic(file)).rejects.toThrow('Invalid ECS')
    expect(mocks.add).toHaveBeenCalledTimes(1)
  })

  it('删除后撤销会写回 IndexedDB 并恢复到原位置', async () => {
    const store = useLocalMusicStore()
    const first = makeMusic('local_1')
    const second = makeMusic('local_2')
    store.musics = [first, second] as never

    await store.deleteMusic('local_1')
    expect(store.musics.map(m => m.id)).toEqual(['local_2'])
    expect(mocks.delete).toHaveBeenCalledWith('local_1')

    await store.restoreMusic(first as never, 0)
    expect(store.musics.map(m => m.id)).toEqual(['local_1', 'local_2'])
    expect(mocks.add).toHaveBeenCalledWith(first)
  })
})

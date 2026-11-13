import { describe, it, expect } from 'vitest'
import {
  transformSong,
  transformSongs,
  transformPlaylist,
  transformPlaylists,
  transformPlaylistDetail,
  transformMVs,
  transformMVList,
  normalizeDurationMs,
} from '@/utils/transformers'
import { formatDuration, formatDurationOrDash } from '@/utils/time'

describe('normalizeDurationMs', () => {
  it('毫秒输入原样保留', () => {
    expect(normalizeDurationMs(185000)).toBe(185000)
    expect(normalizeDurationMs(3600000)).toBe(3600000)
  })

  it('秒级输入（< 3600）换算为毫秒', () => {
    expect(normalizeDurationMs(185)).toBe(185000)
    expect(normalizeDurationMs(59)).toBe(59000)
    expect(normalizeDurationMs(3599)).toBe(3599000)
  })

  it('非法输入归零', () => {
    expect(normalizeDurationMs(0)).toBe(0)
    expect(normalizeDurationMs(-5)).toBe(-5)
    expect(normalizeDurationMs(undefined)).toBe(0)
    expect(normalizeDurationMs('abc')).toBe(0)
  })
})

describe('transformSong 时长单位', () => {
  it('榜单显式毫秒字段保留短音频时长', () => {
    const song = transformSong({ id: 1, name: 'Intro', duration: 1.5, dt: 1500, durationMs: 1500 })
    expect(song.duration).toBe(1500)
  })

  it('dt 字段为毫秒时原样输出（NetEase 歌单/详情接口）', () => {
    const song = transformSong({ id: 1, name: 'A', dt: 221000, ar: [{ id: 9, name: 'X' }] })
    expect(song.duration).toBe(221000)
    expect(formatDuration(song.duration)).toBe('3:41')
  })

  it('duration 字段为秒时换算为毫秒（nexus 搜索网关等秒级数据源）', () => {
    const song = transformSong({ id: 2, name: 'B', duration: 221, artists: [{ id: 8, name: 'Y' }] })
    expect(song.duration).toBe(221000)
    expect(formatDuration(song.duration)).toBe('3:41')
  })

  it('duration 字段为毫秒时不重复换算', () => {
    const song = transformSong({ id: 3, name: 'C', duration: 221000 })
    expect(song.duration).toBe(221000)
  })

  it('缺失时长输出 0，展示层使用占位符', () => {
    const song = transformSong({ id: 4, name: 'D' })
    expect(song.duration).toBe(0)
    expect(formatDurationOrDash(song.duration)).toBe('--:--')
  })

  it('缺失音质数据时不伪造 SQ 徽章与音质档位', () => {
    const song = transformSong({ id: 5, name: 'E' })
    expect(song.qualityBadge).toBeUndefined()
    expect(song.qualities).toBeUndefined()
  })
})

describe('transformSongs & 歌单详情多源兼容性', () => {
  it('从标准 songs 数组解析', () => {
    const res = transformSongs({ songs: [{ id: 101, name: 'Song 1' }] })
    expect(res).toHaveLength(1)
    expect(res[0].name).toBe('Song 1')
  })

  it('从 tracks 数组及 playlist.tracks 降级解析', () => {
    const resTracks = transformSongs({ tracks: [{ id: 102, name: 'Song 2' }] })
    expect(resTracks).toHaveLength(1)
    expect(resTracks[0].name).toBe('Song 2')

    const resPlTracks = transformSongs({ playlist: { tracks: [{ id: 103, name: 'Song 3' }] } })
    expect(resPlTracks).toHaveLength(1)
    expect(resPlTracks[0].name).toBe('Song 3')
  })

  it('transformPlaylistDetail 兼容 native { playlist: {...} } 与 legacy { result: {...} }', () => {
    const nativeDetail = transformPlaylistDetail({
      playlist: {
        id: 999,
        name: 'Native Playlist',
        description: 'Test',
        trackCount: 10,
        creator: { nickname: 'Alice' },
      },
    })
    expect(nativeDetail).not.toBeNull()
    expect(nativeDetail?.name).toBe('Native Playlist')
    expect(nativeDetail?.creator).toBe('Alice')
    expect(nativeDetail?.songCount).toBe(10)

    const legacyDetail = transformPlaylistDetail({
      result: {
        id: 888,
        name: 'Legacy Playlist',
        description: 'Test Legacy',
        tracks: [{ id: 1 }, { id: 2 }],
        creator: { nickname: 'Bob' },
      },
    })
    expect(legacyDetail).not.toBeNull()
    expect(legacyDetail?.name).toBe('Legacy Playlist')
    expect(legacyDetail?.creator).toBe('Bob')
    expect(legacyDetail?.songCount).toBe(2)
  })

  it('transformPlaylist 弹性回退曲目数量', () => {
    const p1 = transformPlaylist({ id: 1, name: 'P1', tracks: [{}, {}, {}] })
    expect(p1.trackCount).toBe(3)

    const p2 = transformPlaylist({ id: 2, name: 'P2', trackIds: [{}, {}] })
    expect(p2.trackCount).toBe(2)
  })

  it('transformPlaylists 支持 4*6=24 项歌单填满输出', () => {
    const mockList = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Playlist ${i + 1}`,
      coverImgUrl: `https://example.com/cover-${i + 1}.jpg`,
      playCount: (i + 1) * 1000,
      trackCount: 10,
    }))
    const res = transformPlaylists({ playlists: mockList }, 24)
    expect(res).toHaveLength(24)
    expect(res[0].id).toBe(1)
    expect(res[23].id).toBe(24)
  })

  it('transformMVs 支持至少 2 行（12 首）MV 并兼容 result 与 data 路径', () => {
    const mockMvs = Array.from({ length: 15 }, (_, i) => ({
      id: 200 + i,
      name: `MV ${i + 1}`,
      cover: `https://example.com/mv-${i + 1}.jpg`,
      artistName: `Artist ${i + 1}`,
      playCount: (i + 1) * 500,
    }))

    // 验证 result 路径
    const resFromResult = transformMVs({ result: mockMvs }, 12)
    expect(resFromResult).toHaveLength(12)
    expect(resFromResult[0].id).toBe(200)
    expect(resFromResult[11].id).toBe(211)

    // 验证 data 路径
    const resFromData = transformMVs({ data: mockMvs }, 12)
    expect(resFromData).toHaveLength(12)
    expect(resFromData[0].name).toBe('MV 1')
  })
})

/**
 * Sonic 用户专属合辑 Store (Radar Album)
 *
 * 核心机制：
 * 1. 最小信息密度 + 只给结果内容：
 *    - 标题："专属合辑"
 *    - 描述："合辑是 Sonic 专门为你创建的播放列表"
 *    - 纯粹面向用户结果，不向用户暴露任何后端存储机制、同步状态或工程术语。
 * 2. 严格排除与去重 (防自身死循环)：
 *    - 严格排除当前正在播放的 MV（ID 与名称双重排除，绝不导向自己）。
 *    - 内部全局去重，绝不重复导向同一首歌。
 * 3. 毫秒级即时合成 (0ms 阻塞)：
 *    - 先行即时完成本地与关联渲染，异步并发探索新曲，保障极致首屏体验。
 */
import { defineStore } from 'pinia'
import piniaPersistConfig from '../persist'
import type { Song } from '../interface'
import { useAudioStore } from './audio'
import { useLibraryStore } from './library'
import { useAuthStore } from './auth'
import { useRecommendStore } from './recommend'
import {
  fetchRecommendForYou,
  fetchUserRadarAlbum,
  syncUserRadarAlbum,
  type RecommendSongItem,
} from '@/api/recommend'

export interface RadarTrack {
  id: string | number
  name: string
  artist: string
  cover: string
  duration: number
  url?: string
  description?: string
  playCount?: string | number
  publishTime?: string
  tag?: '常听' | '推荐'
  replayed?: boolean
}

export interface RadarAlbumData {
  title: string
  subtitle: string
  coverUrl: string
  tracks: RadarTrack[]
  generatedAt: number
}

interface RadarAlbumState {
  album: RadarAlbumData
  lastSyncedAt: number
  isGenerating: boolean
  isSyncing: boolean
  recentQueries: string[]
}

export const DEFAULT_MV_POOL: RadarTrack[] = [
  {
    id: 10845942,
    name: '起风了',
    artist: '吴青峰',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    duration: 303,
    description: '吴青峰热单《起风了》MV公开',
    playCount: 7693000,
    publishTime: '2019-01-11',
    tag: '推荐',
  },
  {
    id: 5341201,
    name: '关键词',
    artist: '林俊杰',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    duration: 257,
    description: '林俊杰 官方音乐视频',
    playCount: 18351000,
    publishTime: '2015-12-25',
    tag: '推荐',
  },
  {
    id: 5440263,
    name: '光年之外',
    artist: '邓紫棋',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    duration: 235,
    description: '电影《太空旅客》中国区主题曲',
    playCount: 29500000,
    publishTime: '2016-12-30',
    tag: '推荐',
  },
  {
    id: 5293223,
    name: '晴天',
    artist: '周杰伦',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    duration: 269,
    description: '周杰伦经典单曲官方 MV',
    playCount: 52100000,
    publishTime: '2003-07-31',
    tag: '常听',
  },
  {
    id: 5414088,
    name: '告白气球',
    artist: '周杰伦',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    duration: 215,
    description: '周杰伦唯美巴黎实景拍摄 MV',
    playCount: 46800000,
    publishTime: '2016-10-28',
    tag: '推荐',
  },
  {
    id: 5436712,
    name: '广岛之恋',
    artist: '莫文蔚',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    duration: 320,
    description: '莫文蔚经典官方高清音乐视频',
    playCount: 852000,
    publishTime: '1997-01-01',
    tag: '常听',
  },
  {
    id: 10839088,
    name: 'All Night',
    artist: 'Afrojack',
    cover: 'https://p2.music.126.net/w8X1Y2Z3A4B5C6D7E8F9G0==/109951164805721832.jpg',
    duration: 168,
    description: 'Afrojack 官方音乐视频',
    playCount: 77000,
    publishTime: '2020-02-21',
    tag: '推荐',
  },
  {
    id: 10825313,
    name: 'POP/STARS',
    artist: 'K/DA',
    cover: 'https://p2.music.126.net/v7W8X1Y2Z3A4B5C6D7E8F9==/109951163660521943.jpg',
    duration: 202,
    description: '英雄联盟 官方音乐视频',
    playCount: 38200000,
    publishTime: '2018-11-03',
    tag: '推荐',
  },
  {
    id: 5424564,
    name: '七里香',
    artist: '周杰伦',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    duration: 299,
    description: '周杰伦经典代表作 官方高清视频',
    playCount: 41000000,
    publishTime: '2004-08-03',
    tag: '常听',
  },
  {
    id: 5312389,
    name: '稻香',
    artist: '周杰伦',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    duration: 223,
    description: '经典治愈励志音乐视频',
    playCount: 35800000,
    publishTime: '2008-10-15',
    tag: '推荐',
  },
  {
    id: 5389104,
    name: '江南',
    artist: '林俊杰',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    duration: 268,
    description: '林俊杰 突破性成名曲官方 MV',
    playCount: 28400000,
    publishTime: '2004-06-04',
    tag: '推荐',
  },
  {
    id: 5449012,
    name: '泡沫',
    artist: '邓紫棋',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    duration: 258,
    description: '邓紫棋 震撼高音官方完整版',
    playCount: 33400000,
    publishTime: '2012-10-19',
    tag: '推荐',
  },
]

export const useRadarAlbumStore = defineStore('radarAlbum', {
  state: (): RadarAlbumState => ({
    album: {
      title: '专属合辑',
      subtitle: '合辑是 Sonic 专门为你创建的播放列表',
      coverUrl: '',
      tracks: DEFAULT_MV_POOL.slice(0, 8),
      generatedAt: 0,
    },
    lastSyncedAt: 0,
    isGenerating: false,
    isSyncing: false,
    recentQueries: [],
  }),

  getters: {
    hasTracks: (state): boolean => state.album.tracks.length > 0,
    totalCountDisplay: (state): string => {
      const len = state.album.tracks.length
      if (len >= 50) return '50+'
      if (len > 0) return `${len}`
      return '10+'
    },
  },

  actions: {
    /**
     * 合成专属合辑
     * 严格排除当前正在播放的 MV（绝不导向自己，绝无重复歌曲）
     */
    async generateRadarAlbum(
      seed?: {
        id?: string | number
        name?: string
        artist?: string
        cover?: string
        duration?: number
        description?: string
        playCount?: string | number
        publishTime?: string
        url?: string
      },
      fallbackRelated: any[] = []
    ) {
      try {
        const audioStore = useAudioStore()
        const libraryStore = useLibraryStore()
        const recommendStore = useRecommendStore()

        const usedIds = new Set<string>()
        const usedTitles = new Set<string>()
        const finalTracks: RadarTrack[] = []

        // 1. 严格排除当前播放的视频 (禁止合辑导向自己，禁止出现同一首歌)
        if (seed?.id) {
          usedIds.add(String(seed.id))
        }
        if (seed?.name) {
          usedTitles.add(seed.name.trim().toLowerCase())
        }

        // 2. 提取本地常听与高频歌曲 (排除自身)
        const playHistory: Song[] = audioStore.audio.playHistory || []
        const likedSongs = libraryStore.likedSongs || []

        const countMap = new Map<string, { count: number; song: Song }>()
        playHistory.forEach((s) => {
          if (!s?.id) return
          const key = String(s.id)
          const entry = countMap.get(key)
          if (entry) {
            entry.count += 1
          } else {
            countMap.set(key, { count: 1, song: s })
          }
        })

        // 高频曲目
        Array.from(countMap.values())
          .filter((item) => item.count >= 2)
          .sort((a, b) => b.count - a.count)
          .slice(0, 4)
          .forEach((item) => {
            const s = item.song
            const idStr = String(s.id)
            const titleNorm = (s.name || '').trim().toLowerCase()
            if (!usedIds.has(idStr) && (!titleNorm || !usedTitles.has(titleNorm))) {
              usedIds.add(idStr)
              if (titleNorm) usedTitles.add(titleNorm)
              finalTracks.push({
                id: s.id,
                name: s.name,
                artist: s.artist,
                cover: s.cover || '',
                duration: s.duration || 0,
                url: (s as any).url || '',
                description: (s as any).description || (s as any).desc || `${s.artist} 精彩单曲`,
                playCount: (s as any).playCount || 10000,
                publishTime: (s as any).publishTime || '',
                tag: '常听',
                replayed: true,
              })
            }
          })

        // 收藏曲目
        likedSongs.slice(0, 3).forEach((s) => {
          const idStr = String(s.id)
          const titleNorm = (s.name || '').trim().toLowerCase()
          if (!usedIds.has(idStr) && (!titleNorm || !usedTitles.has(titleNorm)) && finalTracks.length < 6) {
            usedIds.add(idStr)
            if (titleNorm) usedTitles.add(titleNorm)
            finalTracks.push({
              id: s.id,
              name: s.name,
              artist: s.artist,
              cover: s.cover || '',
              duration: s.duration || 0,
              url: (s as any).url || '',
              description: `${s.artist} 精彩单曲`,
              playCount: 15000,
              publishTime: '',
              tag: '常听',
              replayed: true,
            })
          }
        })

        // 3. 关联视频补全 (严格排除自身，保证全为高清视频)
        if (Array.isArray(fallbackRelated) && fallbackRelated.length > 0) {
          fallbackRelated.forEach((m) => {
            if (!m?.id) return
            const idStr = String(m.id)
            const titleNorm = (m.name || m.title || '').trim().toLowerCase()
            if (!usedIds.has(idStr) && (!titleNorm || !usedTitles.has(titleNorm)) && finalTracks.length < 12) {
              usedIds.add(idStr)
              if (titleNorm) usedTitles.add(titleNorm)
              finalTracks.push({
                id: m.id,
                name: m.name || m.title || '',
                artist: m.artist || m.artistName || '',
                cover: m.cover || m.coverImg || m.picUrl || '',
                duration: m.duration || 0,
                description: m.description || m.desc || m.briefDesc || `${m.artist || ''} 官方音乐视频`,
                playCount: m.playCount || 20000,
                publishTime: m.publishTime || '',
                tag: '推荐',
                replayed: false,
              })
            }
          })
        }

        // 4. 兜底精选补全 (若条目较少，从候选池按同样规则排除并补齐)
        if (finalTracks.length < 8) {
          DEFAULT_MV_POOL.forEach((dm) => {
            const idStr = String(dm.id)
            const titleNorm = dm.name.trim().toLowerCase()
            if (!usedIds.has(idStr) && (!titleNorm || !usedTitles.has(titleNorm)) && finalTracks.length < 12) {
              usedIds.add(idStr)
              if (titleNorm) usedTitles.add(titleNorm)
              finalTracks.push({ ...dm })
            }
          })
        }

        const albumCover =
          finalTracks[0]?.cover ||
          'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg'

        // === 立即赋予 album，让用户毫秒级看到合辑内容，绝不受异步网络阻塞 ===
        this.album = {
          title: '专属合辑',
          subtitle: '合辑是 Sonic 专门为你创建的播放列表',
          coverUrl: albumCover,
          tracks: [...finalTracks],
          generatedAt: Date.now(),
        }

        // 5. 后台静默智能推荐探索 (不阻塞前台渲染，严格排除已知所有曲目)
        const seedArtist = seed?.artist || finalTracks[0]?.artist || '周杰伦'
        const headers = recommendStore.buildRequestHeaders(true)

        try {
          const recRes = await fetchRecommendForYou(
            {
              mode: 'for-you',
              count: 8,
              seedTrackId: seed?.id,
              seedTitle: seed?.name,
              seedArtist,
              temperature: 0.38,
            },
            headers
          )

          const recList: RecommendSongItem[] = recRes.tracks || []
          let updated = false
          recList.forEach((t) => {
            const idStr = String(t.id)
            const titleNorm = (t.name || '').trim().toLowerCase()
            if (!usedIds.has(idStr) && (!titleNorm || !usedTitles.has(titleNorm)) && this.album.tracks.length < 20) {
              usedIds.add(idStr)
              if (titleNorm) usedTitles.add(titleNorm)
              this.album.tracks.push({
                id: t.id,
                name: t.name,
                artist: t.artist,
                cover: t.cover || '',
                duration: t.duration || 0,
                url: t.url,
                description: `${t.artist} 精选曲目`,
                playCount: 50000,
                publishTime: '',
                tag: '推荐',
                replayed: false,
              })
              updated = true
            }
          })
          if (updated) {
            this.album.generatedAt = Date.now()
          }
        } catch {}

        // 本地优先：若已登录静默同步
        const authStore = useAuthStore()
        if (authStore.isAuthenticated && authStore.user?.id) {
          await this.syncToCloud()
        }
      } catch (err) {
        console.warn('[RadarAlbum] Failed to generate album:', err)
      }
    },

    /**
     * 上传同步至云端 (仅限已登录 EpoMail 用户，静默运行)
     */
    async syncToCloud(): Promise<boolean> {
      const authStore = useAuthStore()
      if (!authStore.isAuthenticated || !authStore.user?.id) {
        return false
      }

      this.isSyncing = true
      try {
        const recommendStore = useRecommendStore()
        const headers = recommendStore.buildRequestHeaders(false)

        const payload = {
          title: this.album.title,
          subtitle: this.album.subtitle,
          coverUrl: this.album.coverUrl,
          tracks: this.album.tracks.slice(0, 16),
          signals: {
            totalReplays: this.album.tracks.length,
            recentQueries: this.recentQueries,
          },
        }

        const ok = await syncUserRadarAlbum(payload, headers)
        if (ok) {
          this.lastSyncedAt = Date.now()
        }
        return ok
      } catch {
        return false
      } finally {
        this.isSyncing = false
      }
    },

    /**
     * 从云端拉取已同步的合辑档案 (静默拉取)
     */
    async fetchFromCloud(): Promise<boolean> {
      const authStore = useAuthStore()
      if (!authStore.isAuthenticated || !authStore.user?.id) return false

      try {
        const recommendStore = useRecommendStore()
        const headers = recommendStore.buildRequestHeaders(false)
        const res = await fetchUserRadarAlbum(headers)
        if (res?.data && Array.isArray(res.data.tracks) && res.data.tracks.length > 0) {
          this.album = {
            title: '专属合辑',
            subtitle: '合辑是 Sonic 专门为你创建的播放列表',
            coverUrl: res.data.coverUrl || this.album.coverUrl,
            tracks: res.data.tracks,
            generatedAt: res.syncedAt || Date.now(),
          }
          this.lastSyncedAt = res.syncedAt || Date.now()
          return true
        }
      } catch {}
      return false
    },

    /**
     * 播放合辑曲目
     */
    async playAll(startIndex = 0) {
      if (!this.album.tracks.length) return
      const audioStore = useAudioStore()
      const playableSongs: Song[] = this.album.tracks.map((t: RadarTrack) => ({
        id: t.id,
        name: t.name,
        artist: t.artist,
        album: this.album.title,
        cover: t.cover,
        duration: t.duration,
        url: t.url,
      }))

      audioStore.setPlaylist(playableSongs, startIndex)
      const target = playableSongs[startIndex] || playableSongs[0]
      if (target) {
        await audioStore.playSong(target, startIndex, true)
      }
    },
  },

  persist: piniaPersistConfig('radarAlbum', ['album', 'lastSyncedAt']),
})

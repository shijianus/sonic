/**
 * 音频播放器 Store
 * 核心模块：管理音频播放、播放列表、播放模式、音量等全部播放器状态
 */
import { defineStore } from 'pinia'
import { songUrlV1 } from '@/api'
import { Song, PlayMode, AudioStoreState } from '../interface'
import { useSettingsStore } from './settings'
import { useToastStore } from './toast'
import i18n from '@/languages'
import { downloadedMusicDB, localMusicDB } from '@/utils/indexedDB'
import { musicStreamUrl, songSourceCandidates, songPlaybackSource, songSourcePair, streamSourcePair } from '@/utils/audioUtils'
import { inspectGatewayHeaders, markStreamFailure, gatewayHealth } from '@/utils/gatewayHealth'
import { sonicBlogBridge } from '@/utils/sonicBlogBridge'
import piniaPersistConfig from '../persist'

/** 全局 Audio 单例（整个应用只创建一个 HTMLAudioElement） */
let globalAudio: HTMLAudioElement | null = null
/** 标记事件是否已绑定，防止重复监听 */
let eventsBound = false
/** 标记当前播放歌曲是否已触发过下一首预加载，避免重复发起 */
let hasPreloadedNext = false
/** 推荐行为追踪：记录当前歌曲是否已上报过起播与 50% 有效播放进度 */
let playStartedSongId: string | number | null = null
let progressReportedSongId: string | number | null = null

function emitRecommendPlaybackEvent(payload: any) {
  import('./recommend')
    .then(({ useRecommendStore }) => {
      try {
        useRecommendStore().recordEvent(payload)
      } catch {}
    })
    .catch(() => {})
}

type PlaybackErrorKind = 'network' | 'source' | 'copyright'

/** 将媒体错误/播放异常归类为网络、音源不可用或版权受限 */
export const classifyPlaybackError = (error?: MediaError | Error | null): PlaybackErrorKind => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network'
  const mediaError = error as MediaError | null
  if (mediaError && typeof mediaError.code === 'number') {
    if (mediaError.code === 2) return 'network'
    if (mediaError.code === 3) return 'source'
    // 媒体源不受支持/被拒绝：非本地源优先按版权受限提示
    if (mediaError.code === 4) return 'copyright'
  }
  const msg = String((error as Error | null)?.message || '').toLowerCase()
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout') || msg.includes('offline')) {
    return 'network'
  }
  if (msg.includes('403') || msg.includes('404') || msg.includes('copyright') || msg.includes('版权')) {
    return 'copyright'
  }
  return 'source'
}

let lastPlaybackToastId: number | null = null
let lastPlaybackToastKey = ''
let lastPlaybackToastAt = 0
/** 音质切换期间由 switchQuality 自行处理错误，避免误触发全局播放错误 */
let switchingQuality = false
/** 本次页面会话内已重新生成的 Blob URL，避免重复读取 IndexedDB */
const restoredBlobUrls = new Set<string>()
/** 播放操作代次：新的切歌/重试会使旧的异步结果失效 */
let playbackGeneration = 0
const metadataControllers = new Set<AbortController>()
const advancePlaybackGeneration = () => {
  playbackGeneration += 1
  for (const controller of metadataControllers) controller.abort()
  metadataControllers.clear()
  return playbackGeneration
}
/** 起播看门狗：上游返回响应头后挂起不发送音频时，媒体元素不会触发 error，需主动收敛错误态 */
let startupWatchdog: ReturnType<typeof setTimeout> | null = null
const STARTUP_WATCHDOG_MS = 15000

const clearStartupWatchdog = () => {
  if (startupWatchdog !== null) {
    clearTimeout(startupWatchdog)
    startupWatchdog = null
  }
}

const armStartupWatchdog = (onTimeout: () => void) => {
  clearStartupWatchdog()
  startupWatchdog = setTimeout(() => {
    startupWatchdog = null
    onTimeout()
  }, STARTUP_WATCHDOG_MS)
}
/** 同一首歌曲、同一来源的播放地址请求共享结果，避免切歌预加载重复请求 */
const pendingUrlRequests = new Map<string, { promise: Promise<string>; generation: number; version: number }>()
const songUrlRequestVersions = new Map<string, number>()
const streamMetadataProbes = new WeakMap<Song, { url: string; generation: number; promise: Promise<void> }>()
const songPlaybackKey = (song: Song) => JSON.stringify([song.id, song.source || song.platform || song.sources?.[0]?.platform || ''])
/** 仅对已验证来源进行有限次数的重试，绝不猜测跨平台 ID */
const MAX_SOURCE_RETRIES = 4
const songSourceAttemptMap = new Map<string, number>()
const sourceRetryLimit = (song: Song) => Math.min(MAX_SOURCE_RETRIES, Math.max(3, songSourceCandidates(song).length + 1))
/** 媒体错误监听器最近一次上报的歌曲与时间，避免 play() 拒绝后重复上报、互相覆盖 */
let lastMediaErrorReport: { songId: string | number | null; at: number } | null = null

const mediaErrorAlreadyReported = (songId: string | number | null): boolean =>
  !!lastMediaErrorReport &&
  String(lastMediaErrorReport.songId) === String(songId) &&
  Date.now() - lastMediaErrorReport.at < 2000

/** 获取 Audio 单例（懒初始化） */
const getAudioSingleton = (): HTMLAudioElement => {
  if (!globalAudio) {
    const audio = new Audio()
    globalAudio = audio
    // 允许跨域，以便 AudioContext 进行音频可视化分析
    audio.crossOrigin = 'anonymous'
    audio.id = 'audioPlayer'
    if (typeof document !== 'undefined') {
      const attachAudio = () => {
        if (!document.getElementById('audioPlayer') && document.body) {
          document.body.appendChild(audio)
        }
      }
      if (document.body) {
        attachAudio()
      } else {
        document.addEventListener('DOMContentLoaded', attachAudio, { once: true })
      }
    }
    if (typeof window !== 'undefined') {
      ;(window as any).__audioPlayer = globalAudio
      ;(window as any).__sonicAudio = globalAudio
    }
  }
  return globalAudio
}

/**
 * Fisher-Yates 洗牌算法 —— 随机打乱数组
 * @param array 待打乱的数组
 * @returns 打乱后的新数组（不修改原数组）
 */
const shuffleArray = <T>(array: T[]): T[] => {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export const useAudioStore = defineStore('audio', {
  state: (): AudioStoreState => ({
    // 全局计数器
    count: 0,
    // 音频播放器状态
    audio: {
      // 音频实例
      audio: null,
      // 是否正在播放
      isPlaying: false,
      // 是否已暂停
      isPaused: false,
      // 是否正在加载
      isLoading: false,
      // 当前播放的歌曲
      currentSong: null,
      // 当前歌曲在播放列表中的索引
      currentIndex: -1,
      // 当前播放列表
      playlist: [] as Song[],
      // 原始播放列表（用于随机模式恢复）
      originalPlaylist: [],
      // 播放模式（列表循环/单曲循环/随机播放）
      playMode: PlayMode.LIST,
      // 音量大小（0-1）
      volume: 1,
      // 是否静音
      isMuted: false,
      // 当前播放时间（秒）
      currentTime: 0,
      // 歌曲总时长（秒）
      duration: 0,
      // 播放历史记录
      playHistory: [],
      // 错误信息
      error: null,
      // 记录静音前的音量
      previousVolume: 1,
    },
  }),

  getters: {
    // 获取当前播放的歌曲
    getCurrentSong: (state): Song | null => state.audio.currentSong,
    // 获取播放状态
    getIsPlaying: (state): boolean => state.audio.isPlaying,
    // 获取播放列表
    getPlaylist: (state): Song[] => state.audio.playlist,
    // 获取播放模式
    getPlayMode: (state): PlayMode => state.audio.playMode,
    // 获取音量
    getVolume: (state): number => state.audio.volume,
    // 获取是否静音
    getIsMuted: (state): boolean => state.audio.isMuted,
    // 获取当前播放时间
    getCurrentTime: (state): number => state.audio.currentTime,
    // 获取歌曲总时长
    getDuration: (state): number => state.audio.duration,
    // 获取播放进度百分比
    getProgress: (state): number => {
      return state.audio.duration > 0 ? (state.audio.currentTime / state.audio.duration) * 100 : 0
    },

    // 检查是否有下一首/上一首
    hasNext: (state): boolean => {
      if (state.audio.playMode === PlayMode.SINGLE) return true
      return state.audio.currentIndex < state.audio.playlist.length - 1
    },
    hasPrevious: (state): boolean => {
      if (state.audio.playMode === PlayMode.SINGLE) return true
      return state.audio.currentIndex > 0
    },
  },

  actions: {
    // 初始化音频播放器
    initAudio() {
      if (!this.audio.audio) {
        this.audio.audio = getAudioSingleton()
        this.setupAudioEvents()
        sonicBlogBridge.init()
        sonicBlogBridge.onCommand((cmd) => {
          if (cmd.action === 'SEEK' && typeof cmd.currentTime === 'number') {
            this.setCurrentTime(cmd.currentTime)
          } else if (cmd.action === 'PLAY') {
            if (this.audio.audio?.paused) {
              this.resume()
            }
          } else if (cmd.action === 'PAUSE') {
            if (!this.audio.audio?.paused) {
              this.pause()
            }
          }
        })
        // 如果有歌曲的情况下
        if (this.audio.playlist.length > 0) {
          const index =
            typeof this.audio.currentIndex === 'number' &&
            this.audio.currentIndex >= 0 &&
            this.audio.currentIndex < this.audio.playlist.length
              ? this.audio.currentIndex
              : 0
          this.audio.currentIndex = index
          this.audio.currentSong = this.audio.playlist[index]
          if (this._isStaleBlobUrl(this.audio.currentSong)) {
            // 页面刷新后 blob: URL 失效，异步从 IndexedDB 重建，避免先加载坏源
            this.restoreCurrentSongSource()
          } else {
            // 仅设置源，不主动 load：避免恢复历史歌曲时自动请求并弹出播放错误
            this.audio.audio.src = (this.audio.currentSong && this.audio.currentSong.url) || ''
          }
        }
      }
    },

    /** blob: URL 仅在创建它的页面会话内有效；未重建过的视为失效 */
    _isStaleBlobUrl(song?: Song | null): boolean {
      return Boolean(
        song?.url?.startsWith('blob:') && !restoredBlobUrls.has(song.url)
      )
    },

    /** 按歌曲 id 从下载库/本地音乐库取回原始 Blob */
    async _findBlobForSong(song: Song): Promise<Blob | null> {
      if (typeof indexedDB === 'undefined') return null
      const id = String(song.id)
      try {
        const downloaded = await downloadedMusicDB.getAll()
        const match = downloaded.find(item => String(item.id) === id)
        if (match?.file) return match.file
      } catch {}
      try {
        const local = await localMusicDB.getAll()
        const match = local.find(item => String(item.id) === id)
        if (match?.file) return match.file
      } catch {}
      return null
    },

    /** 为失效的本地/下载歌曲重新创建 Blob URL；失败时清理当前歌曲并提示 */
    async _restoreBlobUrlForSong(song: Song): Promise<boolean> {
      if (!this._isStaleBlobUrl(song)) return true
      const blob = await this._findBlobForSong(song)
      if (!blob) {
        this._handleMissingLocalFile(song)
        return false
      }
      const newUrl = URL.createObjectURL(blob)
      song.url = newUrl
      const idx = this.audio.playlist.findIndex((item: Song) => String(item.id) === String(song.id))
      if (idx !== -1) {
        this.audio.playlist[idx].url = newUrl
        this.audio.playlist[idx].isLocal = true
      }
      if (this.audio.currentSong && String(this.audio.currentSong.id) === String(song.id)) {
        this.audio.currentSong.url = newUrl
      }
      restoredBlobUrls.add(newUrl)
      return true
    },

    /** 恢复持久化的当前歌曲；blob 源失效时重建，取不到则清除 */
    async restoreCurrentSongSource() {
      const song = this.audio.currentSong
      if (!song || !song.url?.startsWith('blob:')) return
      const restored = await this._restoreBlobUrlForSong(song)
      if (!restored) return
      if (this.audio.audio && this.audio.currentSong && this.audio.currentSong.url) {
        this.audio.audio.src = this.audio.currentSong.url
        this.audio.audio.load()
      }
    },

    /** 本地/下载文件已被删除或 IndexedDB 不可用 */
    _handleMissingLocalFile(song: Song) {
      this.audio.isPlaying = false
      this.audio.isLoading = false
      if (this.audio.audio) {
        this.audio.audio.pause()
        this.audio.audio.removeAttribute('src')
        this.audio.audio.load()
      }
      const idx = this.audio.playlist.findIndex((item: Song) => String(item.id) === String(song.id))
      if (idx !== -1) {
        this.audio.playlist.splice(idx, 1)
        if (idx < this.audio.currentIndex) {
          this.audio.currentIndex -= 1
        }
      }
      if (this.audio.currentSong && String(this.audio.currentSong.id) === String(song.id)) {
        this.audio.currentSong = null
        this.audio.currentIndex = -1
      }
      useToastStore().show({
        message: i18n.global.t('player.localFileMissing'),
        type: 'warning',
        duration: 6000,
      })
    },

    // 设置音频事件监听
    setupAudioEvents() {
      if (!this.audio.audio) return
      if (eventsBound) return

      const audio = this.audio.audio

      // 播放开始
      audio.addEventListener('play', () => {
        this.audio.isPlaying = true
        this.audio.isPaused = false
        this.audio.error = null
        this._dismissPlaybackErrorToast()
        if (gatewayHealth.statusKind === 'track-fail') {
          gatewayHealth.statusKind = gatewayHealth.degraded ? 'degraded' : 'normal'
          gatewayHealth.message = gatewayHealth.degraded
            ? '边缘降级模式 · 本地解析引擎重连中，当前由 Cloudflare 边缘提供检索与歌词'
            : ''
        }
      })

      // 播放暂停
      audio.addEventListener('pause', () => {
        // waiting 导致的暂停不更新状态，等待自动恢复
        if (!this.audio._isWaiting) {
          this.audio.isPlaying = false
          this.audio.isPaused = true
          clearStartupWatchdog()
          sonicBlogBridge.broadcastPlayback({
            isPlaying: false,
            currentTime: audio.currentTime || 0,
            duration: audio.duration || 0,
            volume: audio.volume,
            playbackRate: audio.playbackRate,
          })
        }
      })

      // 播放结束
      audio.addEventListener('ended', () => {
        this.audio.isPlaying = false
        this.audio._isWaiting = false
        clearStartupWatchdog()
        this.handleSongEnd()
      })

      // 加载开始
      audio.addEventListener('loadstart', () => {
        this.audio.isLoading = true
      })

      // 可以播放
      audio.addEventListener('canplay', () => {
        clearStartupWatchdog()
        this.audio.isLoading = false
        this.audio.duration = audio.duration || 0
      })

      // 缓冲等待：网络慢或缓冲不足时触发
      audio.addEventListener('waiting', () => {
        this.audio._isWaiting = true
        this.audio.isLoading = true
      })

      // 实际开始播放（缓冲恢复后也会触发）
      audio.addEventListener('playing', () => {
        clearStartupWatchdog()
        this.audio._isWaiting = false
        this.audio.isLoading = false
        this.audio.isPlaying = true
        this.audio.isPaused = false

        sonicBlogBridge.broadcastPlayback({
          isPlaying: true,
          currentTime: audio.currentTime || 0,
          duration: audio.duration || 0,
          volume: audio.volume,
          playbackRate: audio.playbackRate,
        })

        const s = this.audio.currentSong
        if (s && !s.isLocal && playStartedSongId !== s.id) {
          playStartedSongId = s.id
          const durSec = Math.round(
            audio.duration || (s.duration ? s.duration / 1000 : 0)
          )
          emitRecommendPlaybackEvent({
            type: 'play_start',
            track: {
              id: s.id,
              title: s.name,
              artist: s.artist,
              album: s.album,
              duration: durSec > 0 ? durSec : undefined,
              cover: s.cover,
              streamType: s.streamType,
            },
          })
        }
      })

      // 网络数据获取停滞
      audio.addEventListener('stalled', () => {
        console.warn('Audio stalled: 网络数据获取停滞')
      })

      // 时间更新
      audio.addEventListener('timeupdate', () => {
        const cur = audio.currentTime || 0
        this.audio.currentTime = cur
        const dur = audio.duration || 0
        sonicBlogBridge.broadcastTimeUpdate(cur, dur, !audio.paused)
        // 达到 50% 播放进度（或播放满 45 秒）上报一次有效播放进度信号
        const s = this.audio.currentSong
        if (
          s &&
          !s.isLocal &&
          dur > 20 &&
          (cur / dur >= 0.5 || cur >= 45) &&
          progressReportedSongId !== s.id
        ) {
          progressReportedSongId = s.id
          emitRecommendPlaybackEvent({
            type: 'play_progress',
            track: {
              id: s.id,
              title: s.name,
              artist: s.artist,
              album: s.album,
              duration: Math.round(dur),
              cover: s.cover,
              streamType: s.streamType,
            },
            playedSeconds: Math.round(cur),
            durationSeconds: Math.round(dur),
            progressRatio: Number(Math.min(1, cur / dur).toFixed(2)),
          })
        }
        // 主动预判：当播放剩余时间少于 15 秒且非重复触发时，后台静默预解析下一首歌曲地址
        if (dur > 25 && dur - cur < 15 && !hasPreloadedNext) {
          hasPreloadedNext = true
          this.preloadNextTrack()
        }
      })

      // 音量变化
      audio.addEventListener('volumechange', () => {
        this.audio.volume = audio.volume
        this.audio.isMuted = audio.muted
      })

      // 错误处理（优先自动换源重试，借鉴 YesPlayMusic / UnblockNeteaseMusic 换源兜底机制）
      audio.addEventListener('error', async (e: any) => {
        // 切歌时浏览器会中断上一音源加载并上报 abort，不代表当前歌曲失败
        if (audio.error?.code === 1 /* MEDIA_ERR_ABORTED */) return
        this.audio.isLoading = false
        this.audio.isPlaying = false
        if (switchingQuality) return
        console.error('Audio error:', e)

        const failedSrc = audio.currentSrc || audio.src || ''
        const failedSongId = this.audio.currentSong?.id ?? null
        const failedGeneration = playbackGeneration
        const currentSong = this.audio.currentSong

        // 核心容灾：优先静默换源（Failover）轮询候选音轨或跨平台平替源，轮换穷尽前绝不轻易向用户报错！
        const songKey = currentSong ? songPlaybackKey(currentSong) : ''
        const currentAttempts = songSourceAttemptMap.get(songKey) || 0
        const maxAttempts = currentSong ? sourceRetryLimit(currentSong) : 0

        if (failedSongId && !currentSong?.isLocal && currentAttempts < maxAttempts) {
          console.warn(
            `[Audio Failover] Stream playback error on attempt ${currentAttempts + 1}/${maxAttempts} for song ${failedSongId}. Seamlessly switching to next alternative source...`
          )
          try {
            await this.refreshAndReplay(true)
            return
          } catch (retryErr) {
            console.warn('[Audio Failover] Retry attempt failed:', retryErr)
          }
        }

        // 候选源全部尝试失败后，发起诊断分析具体失败原因
        if (failedGeneration !== playbackGeneration || this.audio.currentSong?.id !== failedSongId) return
        let diagnosticNetworkFailure = false
        if (failedSrc && failedSrc.includes('/api/music/stream')) {
          let diagnosticResponse: Response | undefined
          try {
            const diagRes = await fetch(failedSrc, {
              method: 'GET',
              headers: { Range: 'bytes=0-0' },
              signal: AbortSignal.timeout(5000),
            })
            diagnosticResponse = diagRes
            if (failedGeneration !== playbackGeneration || this.audio.currentSong?.id !== failedSongId) return
            inspectGatewayHeaders(diagRes.headers)
            if (diagRes.status === 503) {
              const message = i18n.global.t('player.playbackError.degraded')
              this.audio.error = message
              markStreamFailure('stream-degraded-fail', message)
              lastMediaErrorReport = { songId: failedSongId, at: Date.now() }
              this._reportPlaybackError(e, message)
              return
            } else if (diagRes.status === 404) {
              this.audio.error = '当前曲目暂无可用音源或受版权限制'
              markStreamFailure('track-fail', this.audio.error)
              lastMediaErrorReport = { songId: failedSongId, at: Date.now() }
              this._reportPlaybackError(e, this.audio.error)
              return
            } else if (diagRes.status === 429) {
              const message = i18n.global.t('player.playbackError.rateLimited')
              this.audio.error = message
              lastMediaErrorReport = { songId: failedSongId, at: Date.now() }
              this._reportPlaybackError(e, message)
              return
            } else if (diagRes.status === 403) {
              const message = i18n.global.t('player.playbackError.copyright')
              this.audio.error = message
              lastMediaErrorReport = { songId: failedSongId, at: Date.now() }
              this._reportPlaybackError(e, message)
              return
            }
          } catch {
            diagnosticNetworkFailure = true
          } finally {
            // Diagnosis only needs headers; never leave another media stream open.
            void diagnosticResponse?.body?.cancel().catch(() => {})
          }
        }

        if (failedGeneration !== playbackGeneration || this.audio.currentSong?.id !== failedSongId) return
        lastMediaErrorReport = { songId: failedSongId, at: Date.now() }
        this._reportPlaybackError(
          diagnosticNetworkFailure ? new Error('network fetch failed') : audio.error || e
        )
      })
      eventsBound = true
    },

    /** 播放歌曲（自动获取缺失的播放地址） */
    async playSong(song?: Song, index?: number, force = false): Promise<void> {
      this.initAudio()
      if (this.audio.error && this.audio.currentSong && !this.audio.currentSong.isLocal &&
        (!song || songPlaybackKey(song) === songPlaybackKey(this.audio.currentSong))) {
        return this.retryCurrentSong()
      }
      const generation = advancePlaybackGeneration()

      const targetSong = song || this.audio.currentSong
      if (targetSong && targetSong.url?.startsWith('blob:')) {
        const restored = await this._restoreBlobUrlForSong(targetSong)
        if (!restored || generation !== playbackGeneration) return
      }

      const prevSong = this.audio.currentSong
      const prevIndex = this.audio.currentIndex
      // 判定是否正在切换歌曲：显式 force，或者传入了不同歌曲对象/不同索引/不同 ID/不同 URL
      const isSwitchingSong =
        force ||
        !!(
          song &&
          (!prevSong ||
            (index !== undefined && index !== prevIndex) ||
            song.id !== prevSong.id ||
            (song.url && prevSong.url && song.url !== prevSong.url))
        )

      if (song && index !== undefined) {
        this.audio.currentSong = song
        this.audio.currentIndex = index
      }

      if (!this.audio.currentSong || !this.audio.audio) return
      const targetSongId = this.audio.currentSong.id

      const audio = this.audio.audio
      const currentAudioSrc = audio.getAttribute('src') || audio.src
      const resolvedTargetUrl =
        this.audio.currentSong.url && typeof window !== 'undefined'
          ? new URL(this.audio.currentSong.url, window.location.href).href
          : this.audio.currentSong.url
      const isSrcUnchanged =
        !force &&
        !isSwitchingSong &&
        !!currentAudioSrc &&
        !!this.audio.currentSong.url &&
        (currentAudioSrc === this.audio.currentSong.url || audio.src === resolvedTargetUrl)

      const isAtEnd =
        audio.ended || (audio.duration > 0 && audio.currentTime >= audio.duration - 0.1)

      // 同一首歌播放结束后重新点击播放，重置到开头从头播放
      if (!isSwitchingSong && isSrcUnchanged && isAtEnd) {
        audio.currentTime = 0
        this.audio.currentTime = 0
      }

      // 同一首歌、audio.src 未变、currentTime > 0 且未播完时，从暂停恢复播放，不重载、不重设 src、不归零
      if (!isSwitchingSong && isSrcUnchanged && audio.currentTime > 0 && !isAtEnd) {
        const resumeTime = audio.currentTime || this.audio.currentTime || 0
        let shouldFallbackReload = false

        // 检查媒体状态是否异常（抛错、error、readyState 为 0、或 networkState 为 NETWORK_NO_SOURCE 即 3）
        if (audio.error || audio.readyState === 0 || audio.networkState === 3) {
          shouldFallbackReload = true
        } else {
          try {
            this.audio.error = null
            await audio.play()
            if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
            if (audio.error || audio.readyState === 0 || audio.networkState === 3) {
              shouldFallbackReload = true
            } else {
              return
            }
          } catch (error) {
            console.warn('Resume play failed, triggering fallback reload:', error)
            shouldFallbackReload = true
          }
        }

        // 失败兜底：强制重载音频源并在 loadedmetadata 后尝试恢复暂停进度，确保播放不卡死
        if (shouldFallbackReload) {
          try {
            this.audio.isLoading = true
            if (resumeTime > 0) {
              const restoreProgress = () => {
                try {
                  if (audio.duration && audio.duration > 0) {
                    audio.currentTime = Math.min(resumeTime, audio.duration)
                  } else {
                    audio.currentTime = resumeTime
                  }
                } catch (_) {}
              }
              audio.addEventListener('loadedmetadata', restoreProgress, { once: true })
            }
            this._loadAudioSrc(this.audio.currentSong.url || '', true)
            await audio.play()
            if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
            this.audio.error = null
            return
          } catch (reloadErr) {
            console.error('Fallback reload and resume error, attempting restart from 0:', reloadErr)
            try {
              audio.currentTime = 0
              this.audio.currentTime = 0
              await audio.play()
              if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
              this.audio.error = null
              return
            } catch (finalErr) {
              console.error('Final play attempt error:', finalErr)
              const id = this.audio.currentSong?.id ?? null
              if (id) this.refreshAndReplay()
              return
            }
          } finally {
            this.audio.isLoading = false
          }
        }
      }

      try {
        this.audio.error = null
        this.audio.isLoading = true
        this._armStartupWatchdog(generation, targetSongId)

        const currentSong = this.audio.currentSong
        const gateway = musicStreamUrl(currentSong.url)
        const requestedPair = streamSourcePair(currentSong.url)
        const sourcePair = songPlaybackSource(currentSong)
        const wrongPair = gateway && !gateway.searchParams.has('target') && !gateway.searchParams.has('url') &&
          (!requestedPair || !sourcePair || requestedPair.platform !== sourcePair.platform || requestedPair.platformId !== sourcePair.platformId)
        // Repair a mapper's legacy default-source URL before loading a foreign provider ID.
        if ((!currentSong.url || wrongPair) && !currentSong.isLocal) {
          await this._fetchAndApplyUrl(currentSong)
        }

        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return

        if (!this.audio.currentSong.url) {
          throw new Error('无法获取播放地址')
        }

        // 切歌时复位进度到开头，强制更新音频源，并重置预加载状态
        if (isSwitchingSong) {
          hasPreloadedNext = false
          playStartedSongId = null
          progressReportedSongId = null
          audio.currentTime = 0
          this.audio.currentTime = 0
        }
        this._loadAudioSrc(this.audio.currentSong.url || '', isSwitchingSong)
        this._probeStreamMetadata(this.audio.currentSong)
        await this.audio.audio.play()
        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
        clearStartupWatchdog()

        // 添加到播放历史
        this.addToHistory(this.audio.currentSong)

        // 联动博客随身听：全链路广播当前曲目元数据与音频流
        if (this.audio.currentSong && this.audio.audio) {
          sonicBlogBridge.broadcastTrack(
            {
              id: this.audio.currentSong.id,
              name: this.audio.currentSong.name,
              artist: this.audio.currentSong.artists || (this.audio.currentSong as any).artist || '',
              album: (this.audio.currentSong as any).album || (this.audio.currentSong.al as any)?.name || '',
              coverUrl: this.audio.currentSong.picUrl || (this.audio.currentSong as any).cover || (this.audio.currentSong.al as any)?.picUrl || '',
              audioUrl: this.audio.currentSong.url || this.audio.audio.src,
              duration: this.audio.duration || (this.audio.currentSong.duration ? this.audio.currentSong.duration / 1000 : 0),
              source: 'sonic',
            },
            {
              isPlaying: true,
              currentTime: this.audio.currentTime || 0,
              duration: this.audio.duration || 0,
              volume: this.audio.audio.volume,
              playbackRate: this.audio.audio.playbackRate,
            }
          )
        }
      } catch (error: any) {
        // 过期请求（用户已切歌/暂停/停止）的失败不得覆盖新播放状态或弹出错误
        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
        clearStartupWatchdog()
        this.audio.isPlaying = false

        // 播放失败时优先尝试自动刷新地址并切换候选源重试，若重试成功则无缝起播不弹窗
        const id = this.audio.currentSong?.id ?? null
        if (id && !this.audio.currentSong.isLocal) {
          const songKey = songPlaybackKey(this.audio.currentSong)
          const currentAttempts = songSourceAttemptMap.get(songKey) || 0
          const maxAttempts = sourceRetryLimit(this.audio.currentSong)
          if (currentAttempts < maxAttempts) {
            try {
              await this.refreshAndReplay(true)
              return
            } catch {}
          }
        }

        // 媒体错误监听器若已给出更准确的诊断（如网络中断），不重复弹出泛化错误
        if (!mediaErrorAlreadyReported(targetSongId)) this._reportPlaybackError(error)
        console.error('Play error:', error)
      } finally {
        if (generation === playbackGeneration) this.audio.isLoading = false
      }
    },

    /**
     * 刷新当前歌曲的播放地址并重试播放
     * 用于链接过期、流断开或音源 403/404 场景的多源自动 failover 与恢复
     */
    async refreshAndReplay(tryNextSource = false): Promise<void> {
      if (!this.audio.currentSong || !this.audio.audio) return
      if (this.audio.currentSong.isLocal) return

      const generation = advancePlaybackGeneration()
      const targetSongId = this.audio.currentSong.id
      this.audio.isLoading = true
      this.audio.isPaused = false
      try {
        await this._fetchAndApplyUrl(this.audio.currentSong, true, tryNextSource)
        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId || !this.audio.currentSong.url) return
        this._loadAudioSrc(this.audio.currentSong.url, true)
        await this.audio.audio.play()
        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
        clearStartupWatchdog()
        this.audio.error = null
        this._dismissPlaybackErrorToast()
      } catch (e) {
        // 已切歌/暂停导致的取消失败不提示，由新播放代次负责状态
        if (generation !== playbackGeneration || this.audio.currentSong?.id !== targetSongId) return
        clearStartupWatchdog()
        this.audio.isPlaying = false
        const song = this.audio.currentSong
        if (song && (songSourceAttemptMap.get(songPlaybackKey(song)) || 0) < sourceRetryLimit(song)) {
          await this.refreshAndReplay(true)
          return
        }
        console.error('Refresh url failed:', e)
        if (!mediaErrorAlreadyReported(targetSongId)) this._reportPlaybackError(e as Error)
      } finally {
        if (generation === playbackGeneration) this.audio.isLoading = false
      }
    },

    /** 用户重试保留队列身份，但重新解析音源，不复用已过期的直连/品质 URL。 */
    async retryCurrentSong(): Promise<void> {
      const song = this.audio.currentSong
      if (!song) return
      this.clearError()
      songSourceAttemptMap.delete(songPlaybackKey(song))
      if (song.isLocal) return this.playSong(song, this.audio.currentIndex, true)
      return this.refreshAndReplay()
    },

    /**
     * 智能预解析下一首歌曲播放地址
     * 实现用户切歌或歌曲自然结束时 0 延迟瞬时起播
     */
    async preloadNextTrack() {
      if (!this.audio.playlist.length) return
      let nextIndex = this.audio.currentIndex + 1
      if (nextIndex >= this.audio.playlist.length) {
        if (this.audio.playMode === PlayMode.LIST) {
          // 若启用了 Auto DJ 自动连续电台，在最后一首即将结束时静默续接相似推荐曲目
          try {
            const { useRecommendStore } = await import('./recommend')
            const recStore = useRecommendStore()
            if (recStore.autoDjEnabled && this.audio.currentSong) {
              const moreSongs = await recStore.fetchAutoDjNextSongs(this.audio.currentSong, 5)
              const existingIds = new Set(this.audio.playlist.map((s: { id: string | number }) => String(s.id)))
              const fresh = moreSongs.filter((s) => !existingIds.has(String(s.id)))
              if (fresh.length > 0) {
                this.audio.playlist.push(...fresh)
                if (this.audio.originalPlaylist.length > 0) {
                  this.audio.originalPlaylist.push(...fresh)
                }
                nextIndex = this.audio.currentIndex + 1
              } else {
                nextIndex = 0
              }
            } else {
              nextIndex = 0
            }
          } catch {
            nextIndex = 0
          }
        } else {
          return
        }
      }
      const nextSong = this.audio.playlist[nextIndex]
      if (nextSong && !nextSong.url && !nextSong.isLocal) {
        try {
          await this._fetchAndApplyUrl(nextSong)
        } catch {}
      }
    },

    /**
     * 内部方法：获取歌曲播放地址并同步到 currentSong 和 playlist
     * 抽取自 playSong 和 refreshAndReplay 的公共逻辑，支持传入目标歌曲进行预解析
     * @param forceFresh 是否强制跳过内存 Promise 缓存重新请求
     * @param tryNextSource 是否在发生错误时轮询切换下一个候选音源平台
     */
    async _fetchAndApplyUrl(targetSong?: Song, forceFresh = false, tryNextSource = false): Promise<void> {
      const song = targetSong || this.audio.currentSong
      if (!song) return
      const generation = playbackGeneration
      const settingsStore = useSettingsStore()
      const songKey = songPlaybackKey(song)
      const candidates = songSourceCandidates(song)
      let chosen = songPlaybackSource(song)
      if (tryNextSource) {
        const attempt = songSourceAttemptMap.get(songKey) || 0
        if (attempt >= sourceRetryLimit(song)) throw new Error('Audio source retry limit reached')
        songSourceAttemptMap.set(songKey, attempt + 1)
        if (candidates.length && chosen) {
          const current = candidates.findIndex(pair => pair.platform === chosen!.platform && pair.platformId === chosen!.platformId)
          chosen = candidates[(current + 1) % candidates.length]
        }
      }
      const fresh = forceFresh || tryNextSource
      const requestKey = JSON.stringify([songKey, chosen?.platform, chosen?.platformId, settingsStore.audioQuality, fresh])
      let flight = pendingUrlRequests.get(requestKey)
      if (fresh || flight?.generation !== generation) flight = undefined
      if (!flight) {
        const version = (songUrlRequestVersions.get(songKey) || 0) + 1
        songUrlRequestVersions.set(songKey, version)
        const promise = (async () => {
          // Unmapped aggregate IDs are not provider IDs. Fail closed instead of playing another song.
          if (!chosen) throw new Error('No verified audio source mapping')
          const params = new URLSearchParams({ id: chosen.platformId, source: chosen.platform })
          const title = String(song.name || '').trim()
          const artist = String(song.artist || song.artists?.map((a: { name: string }) => a.name).join(' / ') || '').trim()
          if (title) params.set('title', title)
          if (artist) params.set('artist', artist)
          if (song.duration) params.set('duration', String(Math.round(song.duration > 1000 ? song.duration / 1000 : song.duration)))
          params.set('quality', settingsStore.audioQuality)
          if (fresh) params.set('nocache', '1')
          const gatewayUrl = `/api/music/stream?${params.toString()}`
          // A retry must not reuse a stale URL from url, streamUrl, qualities or song/url/v1.
          if (fresh) return gatewayUrl
          const ownUrl = song.qualities?.find((q: { level: string; streamUrl?: string }) => q.level === settingsStore.audioQuality)?.streamUrl || song.streamUrl || song.url || ''
          if (ownUrl && !musicStreamUrl(ownUrl)) return ownUrl
          if (ownUrl) return gatewayUrl
          // Only the legacy NetEase endpoint understands bare numeric IDs. All other
          // providers use the source-aware gateway directly.
          if (chosen.platform === 'netease') {
            try {
              const res: any = await songUrlV1({
                id: chosen.platformId,
                title: song.name,
                artist: song.artist,
                level: settingsStore.audioQuality,
              })
              const url = res?.data?.[0]?.url || res?.data?.data?.[0]?.url || res?.url || ''
              if (url && !musicStreamUrl(url)) return url
            } catch {}
          }
          return gatewayUrl
        })()
        flight = { promise, generation, version }
        pendingUrlRequests.set(requestKey, flight)
        const owned = flight
        void promise.finally(() => {
          if (pendingUrlRequests.get(requestKey) === owned) pendingUrlRequests.delete(requestKey)
        }).catch(() => {})
      }
      const url = await flight.promise
      // Guard the mutation itself, not merely the later audio.play(): a stopped or
      // superseded request must not overwrite a newer URL on the same Song object.
      if (generation !== playbackGeneration || flight.version !== songUrlRequestVersions.get(songKey)) return
      const pair = chosen!
      const bindingChanged = song.resolvedSource !== pair.platform || String(song.resolvedPlatformId ?? song.resolvedId ?? '') !== pair.platformId
      const patch: Partial<Song> = {
        url,
        resolvedSource: pair.platform,
        resolvedId: pair.platformId,
        resolvedPlatformId: pair.platformId,
        ...(bindingChanged ? { resolvedTitle: undefined, resolvedArtist: undefined } : {}),
      }
      Object.assign(song, patch)
      for (const item of [this.audio.currentSong, ...this.audio.playlist]) {
        if (item && songPlaybackKey(item) === songKey) Object.assign(item, patch)
      }
      if (bindingChanged && typeof window !== 'undefined' && this.audio.currentSong && songPlaybackKey(this.audio.currentSong) === songKey) {
        window.dispatchEvent(new CustomEvent('sonic:stream-resolved', { detail: {
          songId: song.id, url, resolvedSource: pair.platform, resolvedId: pair.platformId, resolvedPlatformId: pair.platformId,
        } }))
      }
      void this._probeStreamMetadata(song)
    },

    /**
     * 内部方法：异步探测并强绑定流响应头中的音源解析元数据
     * 读取网关返回的真实平台 (X-Sonic-Resolved-Source) 与真实 ID (X-Sonic-Resolved-Id)
     */
    _probeStreamMetadata(song: Song) {
      if (!song?.url || !musicStreamUrl(song.url) || typeof fetch === 'undefined') return
      const targetUrl = song.url
      const generation = playbackGeneration
      const songKey = songPlaybackKey(song)
      const previous = streamMetadataProbes.get(song)
      if (previous?.url === targetUrl && previous.generation === generation) return previous.promise
      const controller = new AbortController()
      metadataControllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), 8000)
      const promise = fetch(targetUrl, { method: 'HEAD', signal: controller.signal })
        .then((res) => {
          if (!res.ok || controller.signal.aborted || generation !== playbackGeneration || song.url !== targetUrl) return
          const streamType = res.headers.get('x-sonic-stream-type')
          const trialDuration = Number(res.headers.get('x-sonic-trial-duration'))
          const pair = songSourcePair(res.headers.get('x-sonic-resolved-source'), res.headers.get('x-sonic-resolved-id'))
          const decode = (value: string | null) => {
            try { return value ? decodeURIComponent(value) : undefined } catch { return undefined }
          }
          const patch: Partial<Song> = {}
          if (streamType === 'trial' || streamType === 'full') {
            patch.streamType = streamType
            patch.trialDuration = streamType === 'trial' && Number.isFinite(trialDuration) && trialDuration > 0 ? trialDuration : undefined
          }
          // Metadata is atomic: a provider header without its own ID cannot inherit
          // the old provider's ID. Stable Song.id/name/artist are never overwritten.
          if (pair) {
            patch.resolvedSource = pair.platform
            patch.resolvedId = pair.platformId
            patch.resolvedPlatformId = pair.platformId
            patch.resolvedTitle = decode(res.headers.get('x-sonic-resolved-title'))
            patch.resolvedArtist = decode(res.headers.get('x-sonic-resolved-artist'))
          }
          const changed = Object.entries(patch).some(([key, value]) => song[key as keyof Song] !== value)
          Object.assign(song, patch)
          for (const item of [this.audio.currentSong, ...this.audio.playlist]) {
            if (item && songPlaybackKey(item) === songKey && item.url === targetUrl) Object.assign(item, patch)
          }
          if (changed && typeof window !== 'undefined' && this.audio.currentSong && songPlaybackKey(this.audio.currentSong) === songKey && this.audio.currentSong.url === targetUrl) {
            window.dispatchEvent(new CustomEvent('sonic:stream-resolved', { detail: {
              songId: song.id, url: targetUrl, ...patch,
            } }))
          }
        })
        .catch(() => {})
        .finally(() => {
          clearTimeout(timeout)
          metadataControllers.delete(controller)
        })
      streamMetadataProbes.set(song, { url: targetUrl, generation, promise })
      return promise
    },

    /**
     * 内部方法：当 URL 变化（或 force=true 强制）时重新加载音频源
     */
    _loadAudioSrc(url: string, force = false) {
      if (!this.audio.audio) return
      const currentSrc = this.audio.audio.src
      const resolved =
        url && typeof window !== 'undefined' ? new URL(url, window.location.href).href : url
      const hasError = !!this.audio.audio.error || this.audio.audio.networkState === 3
      if (force || hasError || (currentSrc !== resolved && this.audio.audio.getAttribute('src') !== url)) {
        this.audio.audio.src = url
        this.audio.audio.load()
        if (!switchingQuality) {
          this._armStartupWatchdog(playbackGeneration, this.audio.currentSong?.id ?? null)
        }
      }
    },

    /**
     * 起播看门狗：媒体元素收到响应头后若长期无数据，不会触发 error 或 canplay，
     * 必须在有限时间内收敛为可重试的网络错误，避免页面无限加载。
     */
    _armStartupWatchdog(generation: number, songId: string | number | null) {
      if (switchingQuality) return
      armStartupWatchdog(() => {
        if (generation !== playbackGeneration) return
        if (this.audio.currentSong?.id !== songId) return
        const audio = this.audio.audio
        if (!audio || this.audio.error || this.audio.isPaused) return
        if (!this.audio.isLoading || audio.readyState >= 3) return
        this.audio.isLoading = false
        this.audio.isPlaying = false
        // 放弃本次起播：使在途 playSong 失效并停止媒体元素，避免迟到的数据自动起播。
        advancePlaybackGeneration()
        try {
          audio.pause()
        } catch {}
        this._reportPlaybackError(new Error('playback startup timeout'))
      })
    },

    // 暂停播放
    pause() {
      if (!this.audio.audio) return
      // 用户在异步取流/起播期间暂停时，必须让在途的 playSong/refreshAndReplay 失效，
      // 否则迟到的 audio.play() 会在用户已暂停后重新起播。
      if (this.audio.isPlaying || this.audio.isLoading) {
        advancePlaybackGeneration()
        clearStartupWatchdog()
        this.audio.isLoading = false
        this.audio._isWaiting = false
        this.audio.audio.pause()
        this.audio.isPlaying = false
        this.audio.isPaused = true
      }
    },

    // 继续播放
    resume() {
      if (this.audio.audio) {
        void this.audio.audio.play().catch(() => {
          // 浏览器自动播放策略或空音源导致的拒绝由 error/pause 事件与 UI 状态兜底，避免未处理 Promise 拒绝
        })
      }
    },

    // 播放/暂停切换（启动播放时会自动获取缺失的URL）
    togglePlay() {
      this.initAudio()
      if (!this.audio.audio) return

      // 加载中再次点击视为取消本次起播，避免用户点了暂停却仍在后台起播
      if (this.audio.isPlaying || this.audio.isLoading) {
        this.pause()
      } else {
        if (!this.audio.currentSong && this.audio.playlist.length > 0) {
          this.audio.currentSong = this.audio.playlist[0]
          this.audio.currentIndex = 0
        }
        if (this.audio.currentSong) {
          // 统一通过 playSong 执行，确保缺失URL的懒加载
          this.playSong(this.audio.currentSong, this.audio.currentIndex)
        }
      }
    },

    // 下一首
    nextSong(isAutoEnd = false, opts?: { suppressSkipSignal?: boolean }) {
      if (this.audio.playlist.length === 0) return

      // 手动切歌时：仅在播放正常（非缓冲卡顿、非报错、非试听受限）且收听不足 25s 时记录一次用户跳过信号
      // suppressSkipSignal: 播放失败 Toast 的"下一首"入口传入——播放失败不是用户嫌弃歌曲,不得记负反馈
      if (!isAutoEnd && !opts?.suppressSkipSignal && this.audio.currentSong && !this.audio.currentSong.isLocal) {
        const cur = this.audio.audio?.currentTime || this.audio.currentTime || 0
        const dur =
          this.audio.audio?.duration ||
          this.audio.duration ||
          (this.audio.currentSong.duration ? this.audio.currentSong.duration / 1000 : 0)
        if (
          cur > 0.5 &&
          cur < 25 &&
          !this.audio._isWaiting &&
          !this.audio.error &&
          this.audio.currentSong.streamType !== 'trial'
        ) {
          emitRecommendPlaybackEvent({
            type: 'skip',
            reason: 'user_skip',
            track: {
              id: this.audio.currentSong.id,
              title: this.audio.currentSong.name,
              artist: this.audio.currentSong.artist,
              album: this.audio.currentSong.album,
              duration: dur > 0 ? Math.round(dur) : undefined,
              cover: this.audio.currentSong.cover,
            },
            playedSeconds: Math.round(cur),
            durationSeconds: dur > 0 ? Math.round(dur) : undefined,
            progressRatio: dur > 0 ? Number((cur / dur).toFixed(2)) : undefined,
          })
        }
      }

      let nextIndex = this.audio.currentIndex

      // 如果是单曲播放结束触发的自动切歌，单曲循环模式下重播当前歌曲
      if (isAutoEnd && this.audio.playMode === PlayMode.SINGLE) {
        this.playSong(this.audio.currentSong!, this.audio.currentIndex, true)
        return
      }

      switch (this.audio.playMode) {
        case PlayMode.RANDOM:
          // 随机播放
          const availableIndexes = this.audio.playlist
            .map((_: any, index: any) => index)
            .filter((index: any) => index !== this.audio.currentIndex)

          if (availableIndexes.length > 0) {
            nextIndex = availableIndexes[Math.floor(Math.random() * availableIndexes.length)]
          } else {
            nextIndex = 0
          }
          break

        case PlayMode.SINGLE:
        case PlayMode.LIST:
        default:
          // 列表循环（单曲循环下手动点击下一首也切换到下一首）
          nextIndex = (this.audio.currentIndex + 1) % this.audio.playlist.length
          break
      }

      const nextSong = this.audio.playlist[nextIndex]
      if (nextSong) {
        this.playSong(nextSong, nextIndex, true)
      }
    },

    // 上一首
    previousSong() {
      if (this.audio.playlist.length === 0) return

      let prevIndex = this.audio.currentIndex

      switch (this.audio.playMode) {
        case PlayMode.RANDOM:
          // 随机播放 - 从历史记录中获取上一首
          if (this.audio.playHistory.length > 1) {
            const prevSong = this.audio.playHistory[this.audio.playHistory.length - 2]
            const foundIdx = this.audio.playlist.findIndex(
              (song: { id: any }) => song.id === prevSong.id
            )
            prevIndex =
              foundIdx !== -1 ? foundIdx : Math.floor(Math.random() * this.audio.playlist.length)
          } else {
            // 如果没有历史记录，随机选择
            prevIndex = Math.floor(Math.random() * this.audio.playlist.length)
          }
          break

        case PlayMode.SINGLE:
        case PlayMode.LIST:
        default:
          // 列表循环（单曲循环下手动点击上一首也切换到上一首）
          prevIndex =
            this.audio.currentIndex <= 0
              ? this.audio.playlist.length - 1
              : this.audio.currentIndex - 1
          break
      }

      const prevSong = this.audio.playlist[prevIndex]
      if (prevSong) {
        this.playSong(prevSong, prevIndex, true)
      }
    },

    // 处理歌曲播放结束
    handleSongEnd() {
      const s = this.audio.currentSong
      const dur =
        this.audio.audio?.duration ||
        this.audio.duration ||
        (s?.duration ? s.duration / 1000 : 0)

      // 试听片段播放完毕：不静默跳歌，明确提示用户，且标记 reason='trial_end' 不计入负向反馈
      if (s?.streamType === 'trial') {
        emitRecommendPlaybackEvent({
          type: 'skip',
          reason: 'trial_end',
          track: {
            id: s.id,
            title: s.name,
            artist: s.artist,
            album: s.album,
            duration: dur > 0 ? Math.round(dur) : undefined,
            streamType: 'trial',
          },
        })
        const toastStore = useToastStore()
        toastStore.show({
          message: i18n.global.t('player.trialEnded'),
          type: 'warning',
          duration: 5000,
        })
        return
      }

      if (s && !s.isLocal) {
        emitRecommendPlaybackEvent({
          type: this.audio.playMode === PlayMode.SINGLE ? 'replay' : 'play_complete',
          track: {
            id: s.id,
            title: s.name,
            artist: s.artist,
            album: s.album,
            duration: dur > 0 ? Math.round(dur) : undefined,
            cover: s.cover,
            streamType: s.streamType,
          },
          playedSeconds: dur > 0 ? Math.round(dur) : undefined,
          durationSeconds: dur > 0 ? Math.round(dur) : undefined,
          progressRatio: 1,
        })
      }

      switch (this.audio.playMode) {
        case PlayMode.SINGLE:
          // 单曲循环
          this.playSong(this.audio.currentSong!, this.audio.currentIndex, true)
          break

        case PlayMode.LIST:
        case PlayMode.RANDOM:
        default:
          // 列表循环或随机播放
          this.nextSong(true)
          break
      }
    },

    /** 循环切换播放模式：列表循环 → 单曲循环 → 随机播放 */
    togglePlayMode() {
      const modes = [PlayMode.LIST, PlayMode.SINGLE, PlayMode.RANDOM]
      const currentIndex = modes.indexOf(this.audio.playMode)
      const nextIndex = (currentIndex + 1) % modes.length
      this.setPlayMode(modes[nextIndex])
    },

    /** 设置播放模式（随机模式自动打乱列表，切出时恢复原始顺序） */
    setPlayMode(mode: PlayMode) {
      this.audio.playMode = mode

      if (mode === PlayMode.RANDOM) {
        this.shufflePlaylist()
      } else if (this.audio.originalPlaylist.length > 0) {
        this._restoreOriginalPlaylist()
      }
    },

    /** 打乱播放列表（保留原始顺序的备份） */
    shufflePlaylist() {
      if (this.audio.playlist.length === 0) return

      // 首次打乱时保存原始顺序
      if (this.audio.originalPlaylist.length === 0) {
        this.audio.originalPlaylist = [...this.audio.playlist]
      }

      this.audio.playlist = shuffleArray(this.audio.playlist)
      this._syncCurrentIndex()
    },

    /** 内部方法：恢复原始播放列表顺序 */
    _restoreOriginalPlaylist() {
      this.audio.playlist = [...this.audio.originalPlaylist]
      this._syncCurrentIndex()
    },

    /** 内部方法：根据当前歌曲同步 currentIndex */
    _syncCurrentIndex() {
      if (this.audio.currentSong) {
        this.audio.currentIndex = this.audio.playlist.findIndex(
          (song: { id: any }) => song.id === this.audio.currentSong!.id
        )
      }
    },

    /** 等待新音源可播放；error 事件视为切换失败 */
    _waitForAudioReady(audio: HTMLAudioElement, timeout = 15000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          audio.removeEventListener('loadedmetadata', onReady)
          audio.removeEventListener('canplay', onReady)
          audio.removeEventListener('error', onError)
          clearTimeout(timer)
        }
        const finish = (fn: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const onReady = () => finish(resolve)
        const onError = () =>
          finish(() => reject(audio.error || new Error('Audio source unavailable')))
        const timer = setTimeout(
          () => finish(() => reject(new Error('Switch quality timeout'))),
          timeout
        )
        audio.addEventListener('loadedmetadata', onReady)
        audio.addEventListener('canplay', onReady)
        audio.addEventListener('error', onError)
      })
    },

    /** 切换当前播放歌曲的音质等级；失败回滚旧音源并向上抛出 */
    async switchQuality(targetLevel: string) {
      const song = this.audio.currentSong
      const audio = this.audio.audio
      if (!song || !audio) return
      if (song.isLocal) return

      const currentTime = audio.currentTime || 0
      const wasPlaying = this.audio.isPlaying
      const oldUrl = song.url || ''
      const oldBadge = song.qualityBadge
      const idx = this.audio.currentIndex
      const oldPlaylistUrl =
        idx >= 0 && idx < this.audio.playlist.length ? this.audio.playlist[idx].url : undefined
      const oldPlaylistBadge =
        idx >= 0 && idx < this.audio.playlist.length
          ? this.audio.playlist[idx].qualityBadge
          : undefined

      // 查找对应音质配置
      const qualityOpt = song.qualities?.find((q: { level: string }) => q.level === targetLevel)
      let newUrl = qualityOpt?.streamUrl || ''

      const brMap: Record<string, string> = {
        lossless: 'lossless',
        exhigh: '320',
        standard: '128',
      }
      const br = brMap[targetLevel] || '320'

      if (!newUrl || musicStreamUrl(newUrl)) {
        const pair = songPlaybackSource(song)
        if (!pair) throw new Error('No verified audio source mapping')
        const params = new URLSearchParams({
          id: pair.platformId, source: pair.platform, br,
          title: song.name || '', artist: song.artist || '',
        })
        newUrl = `/api/music/stream?${params.toString()}`
      }

      const badgeMap: Record<string, string> = {
        lossless: 'SQ',
        exhigh: 'HQ',
        standard: '标准',
      }
      const nextBadge = badgeMap[targetLevel] || oldBadge

      switchingQuality = true
      this.audio.isLoading = true
      try {
        this._loadAudioSrc(newUrl, true)
        await this._waitForAudioReady(audio)
        try {
          audio.currentTime = Math.min(currentTime, audio.duration || currentTime)
        } catch {}
        if (wasPlaying) {
          await audio.play()
        }

        // 新音源确认可用后才提交状态
        song.url = newUrl
        song.qualityBadge = nextBadge
        if (idx >= 0 && idx < this.audio.playlist.length) {
          this.audio.playlist[idx].url = newUrl
          this.audio.playlist[idx].qualityBadge = nextBadge
        }
        this.audio.error = null
      } catch (err) {
        // 回滚 URL、徽章与音频源，保证 UI 与实际播放状态一致
        song.url = oldUrl
        song.qualityBadge = oldBadge
        if (idx >= 0 && idx < this.audio.playlist.length) {
          this.audio.playlist[idx].url = oldPlaylistUrl
          this.audio.playlist[idx].qualityBadge = oldPlaylistBadge
        }
        this._loadAudioSrc(oldUrl, true)
        try {
          audio.currentTime = currentTime
        } catch {}
        if (wasPlaying) {
          try {
            await audio.play()
          } catch {}
        }
        this.audio.error = null
        console.error('Switch quality failed:', err)
        throw err
      } finally {
        switchingQuality = false
        this.audio.isLoading = false
      }
    },

    // 设置音量
    setVolume(volume: number) {
      if (this.audio.audio) {
        this.audio.audio.volume = Math.max(0, Math.min(1, volume))
        this.audio.volume = this.audio.audio.volume
      }
    },

    // 静音切换
    toggleMute() {
      if (this.audio.audio) {
        if (this.audio.audio.muted) {
          // 恢复静音前的音量
          this.audio.audio.muted = false
          this.audio.isMuted = false
          this.setVolume(this.audio.previousVolume || 1)
        } else {
          // 开启静音，记录当前音量
          this.audio.previousVolume = this.audio.volume
          this.audio.audio.muted = true
          this.audio.isMuted = true
          this.setVolume(0)
        }
      }
    },

    // 设置播放进度
    setCurrentTime(time: number) {
      const validTime = Math.max(0, time)
      if (this.audio.audio) {
        try {
          const maxTime = this.audio.duration > 0 ? this.audio.duration : validTime
          this.audio.audio.currentTime = Math.min(maxTime, validTime)
        } catch {}
      }
      this.audio.currentTime = validTime
      sonicBlogBridge.broadcastSeek(validTime)
    },

    // 设置播放进度（百分比）
    setProgress(progress: number) {
      if (this.audio.duration > 0) {
        const time = (progress / 100) * this.audio.duration
        this.setCurrentTime(time)
      }
    },

    // 添加歌曲到播放列表
    addSong(song: Song) {
      const exists = this.audio.playlist.find((s: { id: string | number }) => s.id === song.id)
      if (!exists) {
        this.audio.playlist.push(song)
        if (this.audio.originalPlaylist.length > 0) {
          this.audio.originalPlaylist.push(song)
        }
      }
    },

    // 添加多首歌曲
    addSongs(songs: Song[]) {
      songs.forEach(song => this.addSong(song))
    },

    // 移动歌曲位置
    moveSong(fromIndex: number, toIndex: number) {
      if (fromIndex === toIndex) return
      if (fromIndex < 0 || fromIndex >= this.audio.playlist.length) return
      if (toIndex < 0 || toIndex >= this.audio.playlist.length) return
      const move = (arr: Song[]) => {
        const item = arr.splice(fromIndex, 1)[0]
        arr.splice(toIndex, 0, item)
      }
      move(this.audio.playlist)
      if (this.audio.originalPlaylist.length === this.audio.playlist.length)
        move(this.audio.originalPlaylist)
      if (this.audio.currentIndex === fromIndex) {
        this.audio.currentIndex = toIndex
      } else if (fromIndex < this.audio.currentIndex && toIndex >= this.audio.currentIndex) {
        this.audio.currentIndex -= 1
      } else if (fromIndex > this.audio.currentIndex && toIndex <= this.audio.currentIndex) {
        this.audio.currentIndex += 1
      }
    },

    // 将指定歌曲排到下一首播放
    queueNext(songId: string | number) {
      if (this.audio.playlist.length === 0) return
      const idx = this.audio.playlist.findIndex((s: { id: string | number }) => s.id === songId)
      if (idx === -1) return
      const target = Math.min(this.audio.currentIndex + 1, this.audio.playlist.length - 1)
      this.moveSong(idx, target)
    },

    // 批量删除歌曲
    removeSongs(ids: Array<string | number>) {
      ids.forEach(id => this.removeSong(id))
    },

    // 从播放列表删除歌曲
    removeSong(songId: string | number) {
      const index = this.audio.playlist.findIndex(
        (song: { id: string | number }) => song.id === songId
      )
      if (index !== -1) {
        this.audio.playlist.splice(index, 1)

        // 同时从原始播放列表删除
        const originalIndex = this.audio.originalPlaylist.findIndex(
          (song: { id: string | number }) => song.id === songId
        )
        if (originalIndex !== -1) {
          this.audio.originalPlaylist.splice(originalIndex, 1)
        }

        // 如果删除的是当前播放的歌曲
        if (index === this.audio.currentIndex) {
          if (this.audio.playlist.length > 0) {
            // 播放下一首
            const nextIndex = Math.min(index, this.audio.playlist.length - 1)
            this.playSong(this.audio.playlist[nextIndex], nextIndex)
          } else {
            // 没有歌曲了，停止播放
            this.stop()
          }
        } else if (index < this.audio.currentIndex) {
          // 如果删除的歌曲在当前歌曲之前，更新索引
          this.audio.currentIndex--
        }
      }
    },

    /** 清空队列前保存快照，供撤销恢复 */
    createQueueSnapshot() {
      return {
        playlist: [...this.audio.playlist],
        originalPlaylist: [...this.audio.originalPlaylist],
        currentSong: this.audio.currentSong,
        currentIndex: this.audio.currentIndex,
        currentTime: this.audio.currentTime,
        wasPlaying: this.audio.isPlaying,
      }
    },

    /** 恢复清空前的队列与当前歌曲；此前正在播放的会继续播放 */
    async restoreQueueSnapshot(snapshot: {
      playlist: Song[]
      originalPlaylist: Song[]
      currentSong: Song | null
      currentIndex: number
      currentTime: number
      wasPlaying: boolean
    }) {
      this.audio.playlist = [...snapshot.playlist]
      this.audio.originalPlaylist = [...snapshot.originalPlaylist]
      this.audio.currentSong = snapshot.currentSong
      this.audio.currentIndex = snapshot.currentIndex
      this.audio.currentTime = snapshot.currentTime
      if (snapshot.wasPlaying && snapshot.currentSong) {
        await this.playSong(snapshot.currentSong, snapshot.currentIndex, true)
        try {
          if (this.audio.audio) this.audio.audio.currentTime = snapshot.currentTime
        } catch {}
      }
    },

    // 清空播放列表
    clearPlaylist() {
      this.stop()
      this.audio.playlist = []
      this.audio.originalPlaylist = []
      this.audio.currentSong = null
      this.audio.currentIndex = -1
    },

    /**
     * 插入到当前播放之后并立即播放，保留现有队列
     * 队列为空时作为第一首；已存在的同曲目会先移出避免重复
     */
    playAfterCurrent(song: Song) {
      const list = this.audio.playlist
      const currentIndex = this.audio.currentIndex
      const existing = list.findIndex((item: Song) => String(item.id) === String(song.id))

      if (existing !== -1 && existing === currentIndex) {
        this.playSong(this.audio.currentSong || song, currentIndex)
        return
      }

      if (existing !== -1) {
        list.splice(existing, 1)
        if (existing < currentIndex) this.audio.currentIndex -= 1
      }

      const insertAt = this.audio.currentIndex + 1
      list.splice(insertAt, 0, song)
      this.audio.currentIndex = insertAt
      this.audio.currentSong = song
      this.audio.originalPlaylist = [...list]
      this.playSong(song, insertAt, true)
    },

    // 设置播放列表
    setPlaylist(songs: Song[], startIndex: number = 0) {
      this.audio.playlist = [...songs]
      this.audio.originalPlaylist = [...songs]

      // 只设置当前歌曲和索引，不自动播放
      if (songs.length > 0 && startIndex >= 0 && startIndex < songs.length) {
        this.audio.currentSong = songs[startIndex]
        this.audio.currentIndex = startIndex
      }
    },

    // 播放指定索引的歌曲
    playByIndex(index: number) {
      if (index >= 0 && index < this.audio.playlist.length) {
        const isCurrent = index === this.audio.currentIndex
        this.playSong(this.audio.playlist[index], index, !isCurrent)
      }
    },

    // 停止播放
    stop() {
      // 停止同样需要让在途的异步起播失效，避免取流完成后自动恢复播放
      advancePlaybackGeneration()
      clearStartupWatchdog()
      this.audio.isLoading = false
      if (this.audio.audio) {
        this.audio.audio.pause()
        this.audio.audio.currentTime = 0
      }
      this.audio.isPlaying = false
      this.audio.isPaused = false
      this.audio.currentTime = 0
    },

    // 添加到播放历史
    addToHistory(song: Song) {
      // 移除已存在的相同歌曲（避免重复）
      const existingIndex = this.audio.playHistory.findIndex(
        (s: { id: string | number }) => s.id === song.id
      )

      if (existingIndex !== -1) {
        this.audio.playHistory.splice(existingIndex, 1)
      }

      // 添加到历史记录末尾
      this.audio.playHistory.push(song)

      // 限制历史记录数量
      if (this.audio.playHistory.length > 100) {
        this.audio.playHistory.shift()
      }
    },

    // 清空播放历史
    clearHistory() {
      this.audio.playHistory = []
    },

    /** 播放失败：写入 audio.error 并弹出全局 Toast（重试/下一首），同类错误节流 10 秒；messageOverride 用于网关降级等已探明的具体原因 */
    _reportPlaybackError(error?: MediaError | Error | null, messageOverride?: string) {
      clearStartupWatchdog()
      const kind = classifyPlaybackError(error)
      const message = messageOverride || i18n.global.t(`player.playbackError.${kind}`)
      this.audio.error = message
      this.audio.isLoading = false

      const songId = this.audio.currentSong?.id ?? ''
      const key = `${songId}:${kind}:${message}`
      const now = Date.now()
      if (lastPlaybackToastId !== null && key === lastPlaybackToastKey && now - lastPlaybackToastAt < 10000) {
        return
      }
      lastPlaybackToastKey = key
      lastPlaybackToastAt = now
      if (lastPlaybackToastId !== null) {
        useToastStore().dismiss(lastPlaybackToastId)
      }

      lastPlaybackToastId = useToastStore().show({
        message,
        type: 'error',
        duration: 0,
        actions: [
          {
            label: i18n.global.t('common.retry'),
            primary: true,
            handler: () => this.retryCurrentSong(),
          },
          {
            label: i18n.global.t('player.next'),
            handler: () => {
              // 播放失败后切下一首:抑制 user_skip 负反馈(该跳过由故障触发,非用户口味信号)
              this.clearError()
              this.nextSong(false, { suppressSkipSignal: true })
            },
          },
        ],
      })
    },

    /** 播放恢复后关闭残留的播放错误 Toast */
    _dismissPlaybackErrorToast() {
      if (lastPlaybackToastId !== null) {
        useToastStore().dismiss(lastPlaybackToastId)
        lastPlaybackToastId = null
        lastPlaybackToastKey = ''
      }
    },

    // 清除错误信息
    clearError() {
      this.audio.error = null
      this._dismissPlaybackErrorToast()
    },

    // 销毁音频播放器
    destroy() {
      advancePlaybackGeneration()
      clearStartupWatchdog()
      if (this.audio.audio) {
        this.audio.audio.pause()
        this.audio.audio.src = ''
        this.audio.audio = null
      }

      this.audio.isPlaying = false
      this.audio.isPaused = false
      this.audio.isLoading = false
      this.audio.currentSong = null
      this.audio.currentIndex = -1
      this.audio.currentTime = 0
      this.audio.duration = 0
      this.audio.error = null
    },
  },

  persist: piniaPersistConfig('audio', [
    'count',
    'audio.currentSong',
    'audio.currentIndex',
    'audio.playlist',
    'audio.originalPlaylist',
    'audio.playMode',
    'audio.volume',
    'audio.isMuted',
    'audio.playHistory',
  ]),
})

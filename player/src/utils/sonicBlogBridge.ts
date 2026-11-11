/**
 * Sonic <-> Shijianus Blog (Music Pocket) Audio & Lyrics Full-Link Bridge
 * 负责 Sonic 音乐流媒体平台与 Shijianus-Blog 音乐随身听（.shijianus-music-pocket）的实时双向互联
 * 保障音频链路（播放流、播放/暂停、精准毫秒跳转、时间同步）与字母/歌词链路（逐字时间戳、行级对齐、歌词文本）100% 同步
 */

import { stripTicketFromUrl } from '@/utils/streamGuard'

export interface SonicPocketTrack {
  id: string | number
  name: string
  artist: string
  album?: string
  coverUrl?: string
  audioUrl: string
  duration: number
  source: string
}

export interface SonicPocketPlayback {
  isPlaying: boolean
  currentTime: number
  duration: number
  playbackRate?: number
  volume?: number
}

export interface SonicPocketLyricWord {
  text: string
  start: number
  startSec?: number
  end: number
  endSec?: number
  duration?: number
  durationSec?: number
}

export interface SonicPocketLyricLine {
  time: number
  timeSec?: number
  text: string
  duration?: number
  durationSec?: number
  words?: SonicPocketLyricWord[]
}

export interface SonicPocketLyrics {
  lrc?: string
  syncType?: 'word' | 'line'
  lines?: SonicPocketLyricLine[]
  activeLineIndex?: number
}

export interface SonicPocketMessage {
  version: '2.0'
  source: 'sonic-music-player'
  action: 'CONNECT' | 'TRACK_CHANGE' | 'PLAY' | 'PAUSE' | 'SEEK' | 'TIME_UPDATE' | 'LYRICS_SYNC' | 'DISCONNECT' | 'PING' | 'PONG'
  timestamp: number
  track?: SonicPocketTrack
  playback?: SonicPocketPlayback
  lyrics?: SonicPocketLyrics
}

export interface PocketCommandMessage {
  source: 'shijianus-music-pocket'
  action: 'PLAY' | 'PAUSE' | 'SEEK' | 'VOLUME' | 'REQUEST_SYNC'
  currentTime?: number
  volume?: number
  timestamp: number
}

const PRIMARY_CHANNEL = 'sonic_pocket_linkage'
const SECONDARY_CHANNEL = 'shijianus_sonic_bridge'
const STORAGE_SYNC_KEY = 'sonic_pocket_sync_event'
const STORAGE_COMMAND_KEY = 'sonic_pocket_command_event'
// First-party blog origin. Additional origins must be listed explicitly in
// VITE_SONIC_BRIDGE_ORIGINS; there is deliberately no wildcard.
const DEFAULT_BRIDGE_ORIGINS = ['https://blog.shijianus.com']

function normalizeBridgeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.username || url.password) return null
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
    return url.origin
  } catch {
    return null
  }
}

function readConfiguredBridgeOrigins(): string[] {
  const procEnv = (globalThis as any).process?.env
  const raw = String(
    (import.meta as any).env?.VITE_SONIC_BRIDGE_ORIGINS ||
    procEnv?.VITE_SONIC_BRIDGE_ORIGINS ||
    ''
  )
  return raw
    .split(',')
    .map(normalizeBridgeOrigin)
    .filter((value): value is string => Boolean(value))
}

type CommandHandler = (cmd: PocketCommandMessage) => void

class SonicBlogBridgeManager {
  private channels: BroadcastChannel[] = []
  private commandHandlers: Set<CommandHandler> = new Set()
  private initialized = false
  private isLinked = false
  private lastTrack: SonicPocketTrack | null = null
  private lastPlayback: SonicPocketPlayback | null = null
  private lastLyrics: SonicPocketLyrics | null = null
  private lastTimeBroadcast = 0
  private allowedOrigins = new Set<string>()
  private peerOrigins = new Set<string>()
  private warnedOrigins = new Set<string>()

  public init() {
    if (this.initialized || typeof window === 'undefined') return
    this.initialized = true

    const selfOrigin = normalizeBridgeOrigin(window.location.href)
    this.allowedOrigins = new Set([
      ...(selfOrigin ? [selfOrigin] : []),
      ...DEFAULT_BRIDGE_ORIGINS,
      ...readConfiguredBridgeOrigins(),
    ])

    // 1. 初始化 BroadcastChannel
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const c1 = new BroadcastChannel(PRIMARY_CHANNEL)
        const c2 = new BroadcastChannel(SECONDARY_CHANNEL)
        const onMsg = (e: MessageEvent) => this.handleIncomingMessage(e.data)
        c1.onmessage = onMsg
        c2.onmessage = onMsg
        this.channels.push(c1, c2)
      }
    } catch (e) {
      console.warn('[SonicBridge] BroadcastChannel init error:', e)
    }

    // 2. 监听 postMessage（仅接受白名单 origin 的跨窗口指令）
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object' || e.data.source !== 'shijianus-music-pocket') return
      if (!this.acceptPeerOrigin(e.origin)) return
      this.handleIncomingCommand(e.data as PocketCommandMessage)
    })

    // 3. 监听 localStorage 事件（跨标签页同源存储兜底）
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_COMMAND_KEY && e.newValue) {
        try {
          const cmd = JSON.parse(e.newValue) as PocketCommandMessage
          if (cmd && cmd.source === 'shijianus-music-pocket') {
            this.handleIncomingCommand(cmd)
          }
        } catch {}
      }
    })

    // 4. 监听 DOM 自定义事件
    window.addEventListener('sonic:pocket-command', (e: any) => {
      if (e.detail) {
        this.handleIncomingCommand(e.detail)
      }
    })

    // 挂载全局实例便于外部生态、测试脚本即时调用
    ;(window as any).__sonicBlogBridge = this

    // 初始广播在线 Ping
    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'PING',
      timestamp: Date.now(),
    })
  }

  public getIsLinked(): boolean {
    return this.isLinked
  }

  public setLinked(linked: boolean) {
    this.isLinked = linked
  }

  public onCommand(handler: CommandHandler): () => void {
    this.commandHandlers.add(handler)
    return () => this.commandHandlers.delete(handler)
  }

  private handleIncomingMessage(data: any) {
    if (!data || typeof data !== 'object') return
    if (data.source === 'shijianus-music-pocket') {
      this.handleIncomingCommand(data as PocketCommandMessage)
    }
  }

  private handleIncomingCommand(cmd: PocketCommandMessage) {
    this.isLinked = true
    if (cmd.action === 'REQUEST_SYNC') {
      // 随身听请求全量同步：立即下发当前歌曲、播放状态与歌词
      this.broadcastFullSync()
      return
    }
    for (const h of this.commandHandlers) {
      try {
        h(cmd)
      } catch (err) {
        console.error('[SonicBridge] Error executing command handler:', err)
      }
    }
  }

  private acceptPeerOrigin(origin: string): boolean {
    if (!origin || origin === 'null') return false
    if (this.allowedOrigins.has(origin) || origin === window.location.origin) {
      this.peerOrigins.add(origin)
      return true
    }
    if (!this.warnedOrigins.has(origin)) {
      this.warnedOrigins.add(origin)
      console.warn('[SonicBridge] Ignored command from unauthorized origin:', origin)
    }
    return false
  }

  private postToWindow(target: Window, msg: SonicPocketMessage): void {
    const origins = new Set<string>([...this.allowedOrigins, ...this.peerOrigins])
    for (const origin of origins) {
      try {
        target.postMessage(msg, origin)
      } catch {}
    }
  }

  /**
   * 向全渠道分发 Sonic 消息（BroadcastChannel + postMessage + localStorage + CustomEvent）
   */
  public broadcastMessage(msg: SonicPocketMessage) {
    if (typeof window === 'undefined') return

    // 1. BroadcastChannels
    for (const ch of this.channels) {
      try {
        ch.postMessage(msg)
      } catch {}
    }

    // 2. window.postMessage 广播（只向白名单 origin 发送，绝不使用 '*'）
    try {
      if (window.opener && window.opener !== window) {
        this.postToWindow(window.opener, msg)
      }
      if (window.parent && window.parent !== window) {
        this.postToWindow(window.parent, msg)
      }
      for (let i = 0; i < window.frames.length; i++) {
        try {
          this.postToWindow(window.frames[i], msg)
        } catch {}
      }
    } catch {}

    // 3. localStorage 同步兜底（触发其它同源标签页 storage 事件）
    try {
      window.localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify(msg))
    } catch {}

    // 4. 同窗口 DOM 自定义事件
    try {
      window.dispatchEvent(new CustomEvent('sonic:audio-sync', { detail: msg }))
      window.dispatchEvent(new CustomEvent('shijianus:sonic-connect-audio', { detail: msg }))
    } catch {}
  }

  /**
   * 规范化可播放音频流地址（优先补全绝对路径，避免跨站点相对路径 404）
   */
  public normalizeAudioUrl(url: string): string {
    if (!url) return ''
    const cleanUrl = stripTicketFromUrl(url)
    if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://') || cleanUrl.startsWith('blob:') || cleanUrl.startsWith('data:')) {
      return cleanUrl
    }
    if (typeof window !== 'undefined' && cleanUrl.startsWith('/')) {
      return `${window.location.origin}${cleanUrl}`
    }
    return cleanUrl
  }

  /**
   * 音频链路：同步切歌或更新歌曲流元数据
   */
  public broadcastTrack(
    track: SonicPocketTrack,
    playback?: Partial<SonicPocketPlayback>,
    lyrics?: SonicPocketLyrics
  ) {
    this.init()
    const safeTrack: SonicPocketTrack = {
      ...track,
      audioUrl: this.normalizeAudioUrl(track.audioUrl),
    }
    this.lastTrack = safeTrack

    const safePlayback: SonicPocketPlayback = {
      isPlaying: playback?.isPlaying ?? true,
      currentTime: playback?.currentTime ?? 0,
      duration: playback?.duration ?? safeTrack.duration,
      playbackRate: playback?.playbackRate ?? 1,
      volume: playback?.volume ?? 1,
    }
    this.lastPlayback = safePlayback

    if (lyrics) {
      this.lastLyrics = lyrics
    }

    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'TRACK_CHANGE',
      timestamp: Date.now(),
      track: safeTrack,
      playback: safePlayback,
      lyrics: this.lastLyrics || undefined,
    })
  }

  /**
   * 音频链路：同步播放与暂停
   */
  public broadcastPlayback(playback: SonicPocketPlayback) {
    this.init()
    this.lastPlayback = { ...playback }
    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: playback.isPlaying ? 'PLAY' : 'PAUSE',
      timestamp: Date.now(),
      track: this.lastTrack || undefined,
      playback: this.lastPlayback,
      lyrics: this.lastLyrics || undefined,
    })
  }

  /**
   * 音频链路：同步时间跳转 (Seek)
   */
  public broadcastSeek(currentTime: number) {
    this.init()
    if (this.lastPlayback) {
      this.lastPlayback.currentTime = currentTime
    }
    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'SEEK',
      timestamp: Date.now(),
      track: this.lastTrack || undefined,
      playback: this.lastPlayback || {
        isPlaying: true,
        currentTime,
        duration: this.lastTrack?.duration || 0,
      },
      lyrics: this.lastLyrics || undefined,
    })
  }

  /**
   * 音频链路：高频时间轴节流广播 (每 250ms 节流下发)
   */
  public broadcastTimeUpdate(currentTime: number, duration: number, isPlaying: boolean) {
    const now = performance.now()
    if (now - this.lastTimeBroadcast < 220) return
    this.lastTimeBroadcast = now

    if (this.lastPlayback) {
      this.lastPlayback.currentTime = currentTime
      this.lastPlayback.duration = duration
      this.lastPlayback.isPlaying = isPlaying
    }

    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'TIME_UPDATE',
      timestamp: Date.now(),
      track: this.lastTrack || undefined,
      playback: {
        isPlaying,
        currentTime,
        duration,
      },
    })
  }

  /**
   * 字母链路 / 歌词链路：同步高精度行级与逐字歌词
   */
  public broadcastLyrics(lyrics: SonicPocketLyrics) {
    this.init()
    this.lastLyrics = { ...lyrics }
    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'LYRICS_SYNC',
      timestamp: Date.now(),
      track: this.lastTrack || undefined,
      playback: this.lastPlayback || undefined,
      lyrics: this.lastLyrics,
    })
  }

  /**
   * 主动推送全量信息到随身听
   */
  public broadcastFullSync() {
    this.init()
    if (!this.lastTrack && !this.lastPlayback) return
    this.broadcastMessage({
      version: '2.0',
      source: 'sonic-music-player',
      action: 'CONNECT',
      timestamp: Date.now(),
      track: this.lastTrack || undefined,
      playback: this.lastPlayback || undefined,
      lyrics: this.lastLyrics || undefined,
    })
  }
}

export const sonicBlogBridge = new SonicBlogBridgeManager()

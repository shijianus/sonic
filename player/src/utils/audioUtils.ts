// 音频工具函数
import type { Song } from '@/stores/interface'

export interface SongSourcePair {
  platform: string
  platformId: string
}

export const normalizeSongSource = (value: unknown): string => {
  const source = String(value || '').trim().toLowerCase()
  if (source === 'ncm') return 'netease'
  if (source === 'tencent') return 'qq'
  if (source === 'syn' || source === 'test') return 'synthetic'
  return source
}

/** A provider ID is meaningful only with its own provider; never relabel a prefixed ID. */
export const songSourcePair = (source: unknown, id: unknown): SongSourcePair | undefined => {
  let platform = normalizeSongSource(source)
  let platformId = String(id ?? '').trim()
  const prefixed = platformId.match(/^([a-z][a-z0-9_-]*):(.+)$/i)
  if (prefixed) {
    const prefix = normalizeSongSource(prefixed[1])
    if (platform && platform !== prefix) return undefined
    platform = prefix
    platformId = prefixed[2].trim()
  }
  if (!platform || platform === 'sonic' || !platformId || platformId.includes(':')) return undefined
  return { platform, platformId }
}

export const resolvedSongSource = (song: Partial<Song>): SongSourcePair | undefined =>
  song.resolvedSource
    ? songSourcePair(song.resolvedSource, song.resolvedPlatformId ?? song.resolvedId)
    : undefined

/** Only API mappings or the original provider namespace may add a playback candidate. */
export const songSourceCandidates = (song: Partial<Song>): SongSourcePair[] => {
  const result: SongSourcePair[] = []
  const add = (pair?: SongSourcePair) => {
    if (pair && !result.some(item => item.platform === pair.platform && item.platformId === pair.platformId)) {
      result.push(pair)
    }
  }
  const originalSource = song.source || song.platform
  const prefixedId = songSourcePair('', song.id)
  add(prefixedId)
  if (!prefixedId && originalSource) add(songSourcePair(originalSource, song.platformId ?? song.id))
  for (const source of song.sources || []) add(songSourcePair(source.platform, source.platformId))
  // Legacy NetEase-only lists expose bare numeric IDs. Do not apply this default to
  // aggregate/foreign IDs or to an incomplete cross-provider source mapping.
  if (!result.length && !originalSource && !song.sources?.length && /^\d+$/.test(String(song.id ?? ''))) {
    add(songSourcePair('netease', song.id))
  }
  add(resolvedSongSource(song))
  return result
}

export const musicStreamUrl = (value?: string): URL | undefined => {
  if (!value) return undefined
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'https://sonic.invalid/'
    const url = new URL(value, base)
    if (url.origin === new URL(base).origin && url.pathname === '/api/music/stream') return url
  } catch {}
  return undefined
}

export const streamSourcePair = (value?: string): SongSourcePair | undefined => {
  const url = musicStreamUrl(value)
  if (!url || url.searchParams.has('target') || url.searchParams.has('url')) return undefined
  const id = url.searchParams.get('id') || ''
  return songSourcePair('', id) || songSourcePair(url.searchParams.get('source') || 'netease', id)
}

export const songPlaybackSource = (song: Partial<Song>): SongSourcePair | undefined => {
  const resolved = resolvedSongSource(song)
  if (resolved) return resolved
  const candidates = songSourceCandidates(song)
  const requested = streamSourcePair(song.url || song.streamUrl)
  if (requested && candidates.some(pair => pair.platform === requested.platform && pair.platformId === requested.platformId)) {
    return requested
  }
  return candidates[0]
}

/**
 * 格式化时间（秒）为 mm:ss 格式
 * @param seconds 秒数
 * @returns 格式化后的时间字符串
 */
export const formatTime = (seconds: number): string => {
  if (isNaN(seconds) || seconds < 0) return '00:00'

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`
}

/**
 * 解析时间字符串（mm:ss）为秒数
 * @param timeString 时间字符串
 * @returns 秒数
 */
export const parseTime = (timeString: string): number => {
  const parts = timeString.split(':')
  if (parts.length !== 2) return 0

  const minutes = parseInt(parts[0], 10)
  const seconds = parseInt(parts[1], 10)

  if (isNaN(minutes) || isNaN(seconds)) return 0

  return minutes * 60 + seconds
}

/**
 * 获取音频文件的元数据
 * @param file 音频文件
 * @returns Promise<AudioMetadata>
 */
export interface AudioMetadata {
  duration: number
  title?: string
  artist?: string
  album?: string
}

export const getAudioMetadata = (file: File): Promise<AudioMetadata> => {
  return new Promise((resolve, reject) => {
    const audio = new Audio()
    const url = URL.createObjectURL(file)

    audio.addEventListener('loadedmetadata', () => {
      const metadata: AudioMetadata = {
        duration: audio.duration || 0,
        title: file.name.replace(/\.[^/.]+$/, ''), // 移除文件扩展名
      }

      URL.revokeObjectURL(url)
      resolve(metadata)
    })

    audio.addEventListener('error', () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法加载音频文件'))
    })

    audio.src = url
  })
}

/**
 * 检查是否为支持的音频格式
 * @param file 文件
 * @returns 是否支持
 */
export const isSupportedAudioFormat = (file: File): boolean => {
  const supportedTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/aac',
    'audio/flac',
    'audio/webm',
  ]

  return supportedTypes.includes(file.type) || /\.(mp3|wav|ogg|aac|flac|webm)$/i.test(file.name)
}

/**
 * 创建音频可视化数据
 * @param audioElement 音频元素
 * @returns AudioContext 和 AnalyserNode
 */
export const createAudioVisualizer = (audioElement: HTMLAudioElement) => {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
  const analyser = audioContext.createAnalyser()
  const source = audioContext.createMediaElementSource(audioElement)

  analyser.fftSize = 256
  source.connect(analyser)
  analyser.connect(audioContext.destination)

  return { audioContext, analyser }
}

/**
 * 获取频谱数据
 * @param analyser AnalyserNode
 * @returns 频谱数据数组
 */
export const getFrequencyData = (analyser: AnalyserNode): Uint8Array => {
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)
  analyser.getByteFrequencyData(dataArray)
  return dataArray
}

/**
 * 音量淡入淡出效果
 * @param audioElement 音频元素
 * @param targetVolume 目标音量 (0-1)
 * @param duration 持续时间（毫秒）
 */
export const fadeVolume = (
  audioElement: HTMLAudioElement,
  targetVolume: number,
  duration: number = 1000
): Promise<void> => {
  return new Promise(resolve => {
    const startVolume = audioElement.volume
    const volumeDiff = targetVolume - startVolume
    const steps = 50
    const stepDuration = duration / steps
    const stepSize = volumeDiff / steps

    let currentStep = 0

    const fadeInterval = setInterval(() => {
      currentStep++
      audioElement.volume = Math.max(0, Math.min(1, startVolume + stepSize * currentStep))

      if (currentStep >= steps) {
        clearInterval(fadeInterval)
        audioElement.volume = targetVolume
        resolve()
      }
    }, stepDuration)
  })
}

/**
 * 交叉淡入淡出（在两个音频之间切换）
 * @param currentAudio 当前音频
 * @param nextAudio 下一个音频
 * @param duration 切换持续时间（毫秒）
 */
export const crossfade = async (
  currentAudio: HTMLAudioElement,
  nextAudio: HTMLAudioElement,
  duration: number = 2000
): Promise<void> => {
  // 同时开始淡出当前音频和淡入下一个音频
  const fadeOutPromise = fadeVolume(currentAudio, 0, duration)
  const fadeInPromise = fadeVolume(nextAudio, 1, duration)

  // 开始播放下一个音频
  nextAudio.play()

  await Promise.all([fadeOutPromise, fadeInPromise])

  // 停止当前音频
  currentAudio.pause()
  currentAudio.currentTime = 0
}

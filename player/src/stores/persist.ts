/**
 * Pinia 持久化配置
 * 基于 pinia-plugin-persistedstate，将指定的 state 字段存储到 localStorage
 */
import type { StateTree } from 'pinia'
import type { PersistenceOptions } from 'pinia-plugin-persistedstate'
import { safeStorage } from '@/utils/safeStorage'
import { stripTicketFromUrl } from '@/utils/streamGuard'

function cleanSongUrls(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) {
    return obj.map(cleanSongUrls)
  }
  const cloned = { ...obj }
  if (typeof cloned.url === 'string') {
    cloned.url = stripTicketFromUrl(cloned.url)
  }
  if (typeof cloned.streamUrl === 'string') {
    cloned.streamUrl = stripTicketFromUrl(cloned.streamUrl)
  }
  if (Array.isArray(cloned.qualities)) {
    cloned.qualities = cloned.qualities.map((q: any) => ({
      ...q,
      streamUrl: typeof q?.streamUrl === 'string' ? stripTicketFromUrl(q.streamUrl) : q?.streamUrl,
    }))
  }
  return cloned
}

function cleanAudioState(state: any): any {
  if (!state || typeof state !== 'object') return state
  const cleaned = { ...state }
  if (cleaned.audio && typeof cleaned.audio === 'object') {
    cleaned.audio = {
      ...cleaned.audio,
      currentSong: cleanSongUrls(cleaned.audio.currentSong),
      playlist: cleanSongUrls(cleaned.audio.playlist),
      originalPlaylist: cleanSongUrls(cleaned.audio.originalPlaylist),
      playHistory: cleanSongUrls(cleaned.audio.playHistory),
    }
  }
  return cleaned
}

/**
 * 生成 Pinia Store 的持久化配置
 * @param key - 存储到 localStorage 的键名
 * @param paths - 需要持久化的 state 路径列表（如 ['audio.volume', 'audio.playMode']）
 * @returns PersistenceOptions 配置对象
 */
const piniaPersistConfig = <S extends StateTree = StateTree>(key: string, paths?: string[], storage: Storage = safeStorage): PersistenceOptions<S> => {
  const serializer = key === 'audio' ? {
    serialize: (state: S) => JSON.stringify(cleanAudioState(state)),
    deserialize: (str: string) => cleanAudioState(JSON.parse(str)),
  } : undefined

  const persist: PersistenceOptions<S> = {
    key,
    storage,
    pick: paths,
    ...(serializer ? { serializer } : {}),
  }
  return persist
}

export default piniaPersistConfig

/**
 * 本地音乐 IndexedDB 存储模块
 * 使用 IndexedDB 持久化存储用户导入的本地音乐文件
 */

/** 本地音乐数据结构 */
export interface LocalMusic {
  id: string
  name: string
  artist: string
  album: string
  duration: number
  cover: string
  file: File | Blob
  createTime: number
}

/** 已下载歌曲数据结构 */
export interface DownloadedSong {
  id: string | number
  /** Stable provider-aware identity. Includes the selected quality. */
  downloadKey: string
  name: string
  artist: string
  album?: string
  duration: number
  cover?: string
  qualityLevel: string // 'lossless' | 'exhigh' | 'standard'
  qualityBadge: string // 'SQ' | 'HQ' | '标准'
  bitrate?: string
  format: string // 'flac' | 'mp3'
  fileSize: number // 文件大小(字节)
  file: Blob // 本地持久化 Blob 文件
  downloadTime: number
  streamUrl?: string
  source?: string
  platform?: string
  platformId?: string | number
  resolvedSource?: string
  resolvedPlatformId?: string | number
}

/** 数据库名称 */
const DB_NAME = 'SonicMusicPlayerDB'
/** 对象存储名称 */
const STORE_LOCAL = 'local_music'
const STORE_DOWNLOAD = 'downloaded_music_v3'
const STORE_DOWNLOAD_LEGACY = 'downloaded_music'
/** 数据库版本 */
const DB_VERSION = 3

const normalizeDownloadSource = (value: unknown): string => {
  const source = String(value || '').trim().toLowerCase()
  if (source === 'ncm') return 'netease'
  if (source === 'tencent') return 'qq'
  if (source === 'syn' || source === 'test') return 'synthetic'
  return source
}

export interface DownloadSourcePair {
  platform: string
  platformId: string
}

/** Resolve a provider pair without guessing a provider for aggregate IDs. */
export function downloadSourcePair(song: {
  id: string | number
  source?: string
  platform?: string
  platformId?: string | number
  sources?: Array<{ platform: string; platformId: string | number }>
  resolvedSource?: string
  resolvedPlatformId?: string | number
  resolvedId?: string | number
}): DownloadSourcePair | undefined {
  const candidates: Array<{ source?: unknown; id?: unknown }> = [
    { source: song.resolvedSource, id: song.resolvedPlatformId ?? song.resolvedId },
    { source: song.source || song.platform, id: song.platformId },
    ...(song.sources || []).map(item => ({ source: item.platform, id: item.platformId })),
  ]
  for (const candidate of candidates) {
    const platform = normalizeDownloadSource(candidate.source)
    const platformId = String(candidate.id ?? '').trim()
    if (!platform || platform === 'sonic' || !platformId) continue
    return { platform, platformId }
  }
  const prefixed = String(song.id ?? '').trim().match(/^([a-z][a-z0-9_-]*):(.+)$/i)
  if (prefixed) {
    const platform = normalizeDownloadSource(prefixed[1])
    const platformId = prefixed[2].trim()
    if (platform && platform !== 'sonic' && platformId) return { platform, platformId }
  }
  if (/^\d+$/.test(String(song.id ?? '').trim())) {
    return { platform: 'netease', platformId: String(song.id).trim() }
  }
  return undefined
}

export function buildDownloadKey(
  song: Parameters<typeof downloadSourcePair>[0],
  qualityLevel: string,
): string {
  const pair = downloadSourcePair(song)
  const identity = pair ? `${pair.platform}:${pair.platformId}` : `legacy:${String(song.id)}`
  return `${encodeURIComponent(identity)}|quality:${encodeURIComponent(String(qualityLevel || 'standard'))}`
}

/**
 * Resolve the URL used by a download without silently reusing a stale URL
 * from another quality tier. A quality-specific URL is authoritative. Local
 * Blob/data URLs are safe to reuse because they do not cross provider scopes.
 * Remote songs without a dedicated URL always use the source-aware gateway.
 */
export function buildDownloadStreamUrl(song: {
  id: string | number
  name?: string
  artist?: string
  source?: string
  platform?: string
  platformId?: string | number
  sources?: Array<{ platform: string; platformId: string | number }>
  resolvedSource?: string
  resolvedPlatformId?: string | number
  resolvedId?: string | number
  streamUrl?: string
  url?: string
  isLocal?: boolean
  qualities?: Array<{ level: string; streamUrl?: string }>
}, qualityLevel: string): string {
  const dedicatedUrl = song.qualities?.find(item => item.level === qualityLevel)?.streamUrl
  if (dedicatedUrl) return dedicatedUrl

  if (song.isLocal && (song.url || song.streamUrl)) return song.url || song.streamUrl || ''

  const sourcePair = downloadSourcePair(song)
  if (!sourcePair) throw new Error('No verified audio source mapping')
  const br = qualityLevel === 'lossless' ? 'lossless' : qualityLevel === 'standard' ? '128' : '320'
  const params = new URLSearchParams({
    id: sourcePair.platformId,
    source: sourcePair.platform,
    br,
    title: song.name || '',
    artist: song.artist || '',
  })
  return `/api/music/stream?${params.toString()}`
}

function migrateDownloadedSong(value: Partial<DownloadedSong> & { id?: string | number }): DownloadedSong {
  const id = value.id ?? ''
  const qualityLevel = String(value.qualityLevel || 'standard')
  return {
    ...(value as DownloadedSong),
    id,
    downloadKey: value.downloadKey || buildDownloadKey({
      id,
      source: value.source,
      platform: value.platform,
      platformId: value.platformId,
      resolvedSource: value.resolvedSource,
      resolvedPlatformId: value.resolvedPlatformId,
    }, qualityLevel),
    name: String(value.name || ''),
    artist: String(value.artist || ''),
    duration: Number(value.duration || 0),
    qualityLevel,
    qualityBadge: String(value.qualityBadge || '标准'),
    format: String(value.format || 'mp3'),
    fileSize: Number(value.fileSize || 0),
    file: value.file as Blob,
    downloadTime: Number(value.downloadTime || 0),
  }
}

let globalDbPromise: Promise<IDBDatabase> | null = null
let databaseDeletion: Promise<void> | null = null

/** 关闭并删除整个本地音乐数据库（用于“清除全部本地数据”） */
export async function deleteMusicDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  if (databaseDeletion) return databaseDeletion

  const opening = globalDbPromise
  globalDbPromise = null
  void opening?.then(db => db.close(), () => {})

  const request = indexedDB.deleteDatabase(DB_NAME)
  let deletion!: Promise<void>
  deletion = new Promise<void>((resolve, reject) => {
    const clearDeletion = () => {
      if (databaseDeletion === deletion) databaseDeletion = null
    }
    request.onsuccess = () => {
      clearDeletion()
      resolve()
    }
    request.onerror = () => {
      clearDeletion()
      reject(request.error)
    }
    // 浏览器仍保留受阻的删除请求，等待它结束期间复用当前结果。
    request.onblocked = () => {
      reject(new Error('Another tab is holding the local music database open'))
    }
  })
  databaseDeletion = deletion
  return deletion
}

function openDatabase(): Promise<IDBDatabase> {
  if (databaseDeletion) return databaseDeletion.then(openDatabase)
  if (globalDbPromise) return globalDbPromise

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      if (globalDbPromise === opening) globalDbPromise = null
      reject(request.error)
    }

    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        if (globalDbPromise === opening) globalDbPromise = null
      }
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      const oldVersion = event.oldVersion
      if (!db.objectStoreNames.contains(STORE_LOCAL)) {
        db.createObjectStore(STORE_LOCAL, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_DOWNLOAD)) {
        db.createObjectStore(STORE_DOWNLOAD, { keyPath: 'downloadKey' })
      }
      if (oldVersion < 3 && db.objectStoreNames.contains(STORE_DOWNLOAD_LEGACY)) {
        const transaction = (event.target as IDBOpenDBRequest).transaction
        const legacyStore = transaction?.objectStore(STORE_DOWNLOAD_LEGACY)
        const migratedStore = transaction?.objectStore(STORE_DOWNLOAD)
        if (legacyStore && migratedStore) {
          const read = legacyStore.getAll()
          read.onsuccess = () => {
            const legacyRecords = (read.result || []) as Array<Partial<DownloadedSong> & { id?: string | number }>
            for (const record of legacyRecords) migratedStore.put(migrateDownloadedSong(record))
          }
        }
      }
    }
  })

  globalDbPromise = opening
  return opening
}

async function executeInStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], mode)
    const store = transaction.objectStore(storeName)
    const request = operation(store)
    let result: T
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    request.onerror = () => fail(request.error)
    request.onsuccess = () => {
      result = request.result as T
    }
    transaction.onerror = () => fail(transaction.error || request.error)
    transaction.onabort = () => fail(transaction.error || new Error('IndexedDB transaction aborted'))
    transaction.oncomplete = () => {
      if (settled) return
      settled = true
      resolve(result)
    }
  })
}

/**
 * 本地音乐数据库操作类
 */
export class LocalMusicDB {
  async add(music: LocalMusic): Promise<void> {
    await executeInStore<void>(STORE_LOCAL, 'readwrite', store => store.put(music))
  }

  async getAll(): Promise<LocalMusic[]> {
    return executeInStore<LocalMusic[]>(STORE_LOCAL, 'readonly', store => store.getAll())
  }

  async delete(id: string): Promise<void> {
    await executeInStore<void>(STORE_LOCAL, 'readwrite', store => store.delete(id))
  }

  async clear(): Promise<void> {
    await executeInStore<void>(STORE_LOCAL, 'readwrite', store => store.clear())
  }
}

/**
 * 已下载音乐数据库操作类
 */
export class DownloadedMusicDB {
  async add(song: DownloadedSong): Promise<void> {
    const normalized = migrateDownloadedSong(song)
    await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.put(normalized))
  }

  async getAll(): Promise<DownloadedSong[]> {
    return executeInStore<DownloadedSong[]>(STORE_DOWNLOAD, 'readonly', store => store.getAll())
  }

  async delete(target: string | number | DownloadedSong): Promise<void> {
    if (typeof target === 'object') {
      await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.delete(target.downloadKey))
      return
    }
    const list = await this.getAll()
    const matches = list.filter(item => String(item.id) === String(target))
    if (matches.length === 0) {
      await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.delete(target))
      return
    }
    if (matches.length > 1) {
      throw new Error('Ambiguous download target: provide downloadKey or a full download record')
    }
    for (const item of matches) {
      await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.delete(item.downloadKey))
    }
  }

  async clear(): Promise<void> {
    await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.clear())
  }
}

/** 全局单例，供各模块直接导入使用 */
export const localMusicDB = new LocalMusicDB()
export const downloadedMusicDB = new DownloadedMusicDB()

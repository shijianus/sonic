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
}

/** 数据库名称 */
const DB_NAME = 'SonicMusicPlayerDB'
/** 对象存储名称 */
const STORE_LOCAL = 'local_music'
const STORE_DOWNLOAD = 'downloaded_music'
/** 数据库版本 */
const DB_VERSION = 2

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
  databaseDeletion = new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      databaseDeletion = null
      resolve()
    }
    request.onerror = () => {
      databaseDeletion = null
      reject(request.error)
    }
    // 浏览器仍保留受阻的删除请求，等待它结束期间复用当前结果。
    request.onblocked = () => reject(new Error('Another tab is holding the local music database open'))
  })
  return databaseDeletion
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
      if (!db.objectStoreNames.contains(STORE_LOCAL)) {
        db.createObjectStore(STORE_LOCAL, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_DOWNLOAD)) {
        db.createObjectStore(STORE_DOWNLOAD, { keyPath: 'id' })
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

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
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
    await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.put(song))
  }

  async getAll(): Promise<DownloadedSong[]> {
    return executeInStore<DownloadedSong[]>(STORE_DOWNLOAD, 'readonly', store => store.getAll())
  }

  async delete(id: string | number): Promise<void> {
    await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.delete(id))
  }

  async clear(): Promise<void> {
    await executeInStore<void>(STORE_DOWNLOAD, 'readwrite', store => store.clear())
  }
}

/** 全局单例，供各模块直接导入使用 */
export const localMusicDB = new LocalMusicDB()
export const downloadedMusicDB = new DownloadedMusicDB()

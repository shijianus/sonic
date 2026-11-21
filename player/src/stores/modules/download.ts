import { defineStore } from 'pinia'
import {
  buildDownloadStreamUrl,
  buildDownloadKey,
  downloadSourcePair,
  downloadedMusicDB,
  type DownloadedSong,
} from '@/utils/indexedDB'
import { isPrivateLocalImport } from '@/utils/audioUtils'
import { ecsFilename, exportEcs } from '@/utils/ecs'
import { ecsDownload, packDownload, offlineSong, type EcsExportFile } from '@/utils/offlineDownload'
import type { Song } from '../interface'
import { useAudioStore } from './audio'
import { useToastStore } from './toast'
import i18n from '@/languages'

const activeDownloadKeys = new Set<string>()

const sameDownloadIdentity = (left: DownloadedSong, right: Song): boolean => {
  const leftPair = downloadSourcePair(left)
  const rightPair = downloadSourcePair(right)
  if (leftPair && rightPair) {
    return leftPair.platform === rightPair.platform && leftPair.platformId === rightPair.platformId
  }
  return String(left.id) === String(right.id)
}

export interface QualityChoice {
  level: string // 'lossless' | 'exhigh' | 'standard'
  label: string // 'SQ 无损' | 'HQ 极高' | '标准'
  bitrate: string // 'FLAC 24-bit' | '320kbps' | '128kbps'
  format: string // 'flac' | 'mp3'
  desc: string // '超清无损母带音质 (FLAC / 24-bit)'
  estimatedSize: string // '约 25MB - 50MB'
  streamUrl?: string
}

export const DEFAULT_QUALITY_CHOICES: QualityChoice[] = [
  {
    level: 'lossless',
    label: 'SQ 无损',
    bitrate: 'FLAC 24-bit',
    format: 'flac',
    desc: '母带级超清无损原声，高保真还原细节',
    estimatedSize: '约 25MB - 50MB',
  },
  {
    level: 'exhigh',
    label: 'HQ 极高',
    bitrate: '320kbps MP3',
    format: 'mp3',
    desc: '超清极高品质，声场饱满音质细腻',
    estimatedSize: '约 8MB - 12MB',
  },
  {
    level: 'standard',
    label: '标准',
    bitrate: '128kbps MP3',
    format: 'mp3',
    desc: '标准流畅音质，下载速度快且节省存储',
    estimatedSize: '约 3MB - 5MB',
  },
]

export const useDownloadStore = defineStore('download', {
  state: () => ({
    downloadedList: [] as DownloadedSong[],
    isLoading: false,
    isDownloading: false,
    downloadingId: null as string | number | null,
    dialogVisible: false,
    currentDownloadSong: null as Song | null,
    errorMsg: null as string | null,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    lastManualSave: null as { blob: Blob; fileName: string } | null,
    abortController: null as AbortController | null,
  }),

  getters: {
    totalCount: (state) => state.downloadedList.length,
    totalSizeBytes: (state) =>
      state.downloadedList.reduce((sum, item) => sum + (item.fileSize || 0), 0),
    totalSizeFormatted(): string {
      const bytes = this.totalSizeBytes
      if (bytes === 0) return '0 B'
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    },
    isSongDownloaded: (state) => (songOrId: Song | string | number, qualityLevel?: string) => {
      if (typeof songOrId === 'object') {
        if (qualityLevel) {
          const downloadKey = buildDownloadKey(songOrId, qualityLevel)
          return state.downloadedList.some(item => item.downloadKey === downloadKey)
        }
        return state.downloadedList.some(item => sameDownloadIdentity(item, songOrId))
      }
      return state.downloadedList.some(item =>
        String(item.id) === String(songOrId) && (!qualityLevel || item.qualityLevel === qualityLevel),
      )
    },
  },

  actions: {
    /** 加载本地已下载歌曲列表 */
    async loadDownloads() {
      this.isLoading = true
      try {
        const list = await downloadedMusicDB.getAll()
        this.downloadedList = list.sort((a, b) => (b.downloadTime || 0) - (a.downloadTime || 0))
      } catch (err) {
        console.error('[DownloadStore] Failed to load downloaded songs:', err)
      } finally {
        this.isLoading = false
      }
    },

    /** 打开音质选择下载弹窗 */
    openDownloadDialog(song: Song) {
      if (isPrivateLocalImport(song)) {
        useToastStore().show({ type: 'info', message: i18n.global.t('download.localExportHint') })
        return
      }
      this.currentDownloadSong = song
      this.errorMsg = null
      this.dialogVisible = true
    },

    /** 关闭下载弹窗 */
    closeDownloadDialog() {
      this.dialogVisible = false
      this.currentDownloadSong = null
      this.errorMsg = null
    },

    /** 查询同一首歌是否已下载过指定音质 */
    async findDownloadedByQuality(
      songOrId: Song | string | number,
      qualityLevel: string
    ): Promise<DownloadedSong | null> {
      const downloadKey = typeof songOrId === 'object'
        ? buildDownloadKey(songOrId, qualityLevel)
        : null
      const inMemory = this.downloadedList.find(
        item => downloadKey
          ? item.downloadKey === downloadKey
          : String(item.id) === String(songOrId) && item.qualityLevel === qualityLevel
      )
      if (inMemory) return inMemory
      try {
        const list = await downloadedMusicDB.getAll()
        this.downloadedList = list.sort((a, b) => (b.downloadTime || 0) - (a.downloadTime || 0))
        return (
          this.downloadedList.find(
            item => downloadKey
              ? item.downloadKey === downloadKey
              : String(item.id) === String(songOrId) && item.qualityLevel === qualityLevel
          ) || null
        )
      } catch {
        return null
      }
    },

    /** 取消进行中的下载 */
    cancelDownload() {
      this.abortController?.abort()
    },

    /** 浏览器自动保存被拦截/失去用户手势时，由用户点击后重新保存 */
    saveManually() {
      const payload = this.lastManualSave
      if (!payload) return
      this._saveBlob(payload.blob, payload.fileName)
      useToastStore().show({
        message: i18n.global.t('download.saved'),
        type: 'success',
        duration: 3000,
      })
    },

    _saveBlob(blob: Blob, fileName: string) {
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = fileName
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30000)
    },

    _canAutoSave(): boolean {
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation
      return !activation || activation.isActive !== false
    },

    _fetchBlobWithProgress(
      streamUrl: string,
      signal: AbortSignal,
      remote: boolean,
      onProgress: (loaded: number, total: number) => void
    ): Promise<{ blob: Blob; source: string; platformId: string; title: string; artist: string }> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const xhr = new XMLHttpRequest()
        xhr.open('GET', streamUrl)
        xhr.responseType = 'blob'
        const onAbort = () => xhr.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        xhr.onloadend = () => signal.removeEventListener('abort', onAbort)
        xhr.onprogress = event => {
          if (event.loaded > 64 * 1024 * 1024) {
            reject(new Error(i18n.global.t('download.fileTooLarge')))
            xhr.abort()
            return
          }
          onProgress(event.loaded, event.lengthComputable ? event.total : 0)
        }
        xhr.onerror = () => reject(new Error(i18n.global.t('download.networkError')))
        xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
        xhr.onload = () => {
          if (xhr.status !== 200 && xhr.status !== 206) {
            reject(new Error(xhr.status === 403 || xhr.status === 404
              ? i18n.global.t('download.sourceUnavailable') : `HTTP ${xhr.status}`))
            return
          }
          const blob: Blob = xhr.response
          const header = (name: string) => xhr.getResponseHeader(name) || ''
          const range = header('Content-Range')
          if (!blob.size || ((range || xhr.status === 206) && range !== `bytes 0-${blob.size - 1}/${blob.size}`) ||
              (remote && (header('X-Sonic-Stream-Type') !== 'full' || header('X-Sonic-Stream-Trial') === '1'))) {
            reject(new Error(i18n.global.t('download.incompleteAudio')))
            return
          }
          const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return '' } }
          resolve({ blob, source: header('X-Sonic-Resolved-Source'), platformId: header('X-Sonic-Resolved-Id'),
            title: decode(header('X-Sonic-Resolved-Title')), artist: decode(header('X-Sonic-Resolved-Artist')) })
        }
        xhr.send()
      })
    },

    /**
     * 触发下载并存入本地 IndexedDB；支持进度、取消与手动保存兜底
     */
    async startDownload(
      song: Song,
      qualityChoice: QualityChoice,
      options: { overwrite?: boolean } = {}
    ) {
      if (!song || this.isDownloading) return
      const downloadKey = buildDownloadKey(song, qualityChoice.level)
      const identityPair = downloadSourcePair(song)
      if (activeDownloadKeys.has(downloadKey)) return
      activeDownloadKeys.add(downloadKey)

      const controller = new AbortController()
      this.abortController = controller
      this.isDownloading = true
      this.downloadingId = song.id
      this.errorMsg = null
      this.downloadProgress = 0
      this.downloadedBytes = 0
      this.totalBytes = 0

      try {
        const existing = await this.findDownloadedByQuality(song, qualityChoice.level)
        if (existing && !options.overwrite) {
          const err = new Error('DUPLICATE_DOWNLOAD')
          err.name = 'DuplicateDownloadError'
          throw err
        }

        // Prefer a URL explicitly bound to the requested tier. A generic
        // song.url/streamUrl may belong to another tier, so remote fallback
        // always goes through the verified source-aware gateway.
        const streamUrl = buildDownloadStreamUrl(song, qualityChoice.level)

        // 1. 获取音频二进制 Blob（带进度，可取消）
        const localFile = song.isLocal === true && streamUrl.startsWith('blob:')
        if (song.streamType === 'trial' || song.streamType === 'unavailable') {
          throw new Error(i18n.global.t('download.incompleteAudio'))
        }
        const received = await this._fetchBlobWithProgress(
          streamUrl,
          controller.signal,
          !localFile,
          (loaded, total) => {
            this.downloadedBytes = loaded
            this.totalBytes = total
            this.downloadProgress =
              total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0
          }
        )
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!localFile || received.source || received.platformId) {
          const pair = downloadSourcePair({ id: '', source: received.source, platformId: received.platformId })
          if (!identityPair || !pair || pair.platform !== identityPair.platform || pair.platformId !== identityPair.platformId) {
            throw new Error(i18n.global.t('download.sourceUnavailable'))
          }
        }
        const record = {
          id: song.id,
          downloadKey,
          name: received.title || song.name,
          artist: received.artist || song.artist,
          album: song.album || '',
          duration: song.duration ? song.duration / 1000 : 0,
          cover: song.cover || '',
          qualityLevel: qualityChoice.level,
          source: identityPair?.platform || song.source,
          platform: identityPair?.platform || song.platform,
          platformId: identityPair?.platformId || song.platformId,
          resolvedSource: song.resolvedSource || identityPair?.platform,
          resolvedPlatformId: song.resolvedPlatformId ?? song.resolvedId ?? identityPair?.platformId,
        }
        const packed = await packDownload({ ...record, file: received.blob }, controller.signal, !localFile)
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const fileName = ecsFilename(record.name, record.artist, packed.tier)
        const downloadedSong: DownloadedSong = {
          ...record,
          duration: packed.duration || record.duration, ecsTier: packed.tier, audioMeta: packed.audioMeta,
          qualityBadge: `ECS${packed.tier}`, bitrate: packed.audioMeta.displayTag,
          format: 'ecs', file: packed.file, fileSize: packed.file.size, downloadTime: Date.now(),
        }
        await downloadedMusicDB.add(downloadedSong)

        // 4. 更新内存状态
        const existingIdx = this.downloadedList.findIndex(
          (item) => item.downloadKey === downloadKey
        )
        if (existingIdx >= 0) {
          this.downloadedList.splice(existingIdx, 1, downloadedSong)
        } else {
          this.downloadedList.unshift(downloadedSong)
        }

        // 5. 自动保存；异步请求后可能已失去用户手势，保留手动保存入口
        this.downloadProgress = 100
        this.lastManualSave = { blob: packed.file, fileName }
        let autoSaved = false
        if (this._canAutoSave()) {
          try {
            this._saveBlob(packed.file, fileName)
            autoSaved = true
          } catch {
            // 浏览器可能拦截自动下载，转入手动保存提示
          }
        }
        useToastStore().show({
          message: autoSaved
            ? i18n.global.t('download.completed', { name: song.name })
            : i18n.global.t('download.manualSaveRequired'),
          type: autoSaved ? 'success' : 'warning',
          duration: autoSaved ? 8000 : 0,
          actions: [
            {
              label: i18n.global.t('download.saveNow'),
              primary: true,
              handler: () => this.saveManually(),
            },
          ],
        })

        // 关闭弹窗
        this.closeDownloadDialog()
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          this.errorMsg = null
          useToastStore().show({
            message: i18n.global.t('download.cancelled'),
            type: 'info',
            duration: 3000,
          })
          return
        }
        console.error('[DownloadStore] Download failed:', err)
        const reason = err?.message || i18n.global.t('download.networkError')
        this.errorMsg = i18n.global.t('download.failed', { reason })
        useToastStore().show({ message: this.errorMsg, type: 'error', duration: 5000 })
        throw err
      } finally {
        activeDownloadKeys.delete(downloadKey)
        this.isDownloading = false
        this.downloadingId = null
        this.abortController = null
      }
    },

    /** 从本地下载列表删除单个 */
    async deleteDownload(target: string | number | DownloadedSong) {
      try {
        let item: DownloadedSong | undefined
        if (typeof target === 'object') {
          item = target
        } else {
          const matches = this.downloadedList.filter(candidate => String(candidate.id) === String(target))
          // v3 permits several providers and qualities per numeric ID. A bare
          // ID is ambiguous and must never remove an arbitrary item.
          if (matches.length > 1) {
            console.warn('[DownloadStore] Refusing ambiguous download deletion', target)
            return
          }
          item = matches[0]
        }
        if (item) {
          await downloadedMusicDB.delete(item)
          this.downloadedList = this.downloadedList.filter(candidate => candidate.downloadKey !== item.downloadKey)
        } else {
          await downloadedMusicDB.delete(target)
          this.downloadedList = this.downloadedList.filter(candidate => String(candidate.id) !== String(target))
        }
      } catch (err) {
        console.error('[DownloadStore] Failed to delete download:', err)
      }
    },

    /** 批量删除多个已下载项目 */
    async deleteMultiple(ids: (string | number | DownloadedSong)[]) {
      try {
        for (const target of ids) {
          await this.deleteDownload(target)
        }
      } catch (err) {
        console.error('[DownloadStore] Failed to batch delete downloads:', err)
      }
    },

    /** 清空所有下载 */
    async clearDownloads() {
      try {
        await downloadedMusicDB.clear()
        this.downloadedList = []
      } catch (err) {
        console.error('[DownloadStore] Failed to clear downloads:', err)
      }
    },

    async exportDownload(item: DownloadedSong | EcsExportFile, target: 'ecs' | 'original' | 'high' | 'standard') {
      const { file, tier } = await ecsDownload(item)
      const filename = ecsFilename(item.name, item.artist, tier)
      if (target === 'ecs') {
        this._saveBlob(file, filename)
        return
      }
      const result = await exportEcs(file, target)
      const base = filename.replace(/\.ecs[123]\.ecs$/i, '')
      this._saveBlob(result.audio, `${base}.${result.extension}`)
    },

    playDownloaded(item: DownloadedSong) {
      return useAudioStore().playSong(offlineSong(item), 0)
    },
  },
})

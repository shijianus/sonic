import { defineStore } from 'pinia'
import { localMusicDB, type LocalMusic } from '@/utils/indexedDB'
import { Song } from '../interface'
import * as mm from 'music-metadata'
import { decodeEcs, isEcsFile } from '@/utils/ecs'

export const useLocalMusicStore = defineStore('localMusic', {
  state: () => ({
    musics: [] as LocalMusic[],
    isLoading: false,
  }),

  actions: {
    async loadMusics() {
      this.isLoading = true
      try {
        this.musics = await localMusicDB.getAll()
      } catch (error) {
        console.error('Failed to load local musics:', error)
      } finally {
        this.isLoading = false
      }
    },

    async addMusic(file: File) {
      const id = 'local_' + Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
      const packaged = /\.ecs$/i.test(file.name) || await isEcsFile(file)
      // Validate the entire package before inserting it. Only the original
      // file is persisted; a decoded Blob is used temporarily for metadata.
      const ecs = packaged ? await decodeEcs(file) : null
      const audio = ecs?.audio ?? file
      const name = ecs?.meta.title || file.name.replace(/\.[^/.]+$/, '')
      let artist = ecs?.meta.artist || 'Local Music'
      let album = ecs?.meta.album || 'Unknown Album'
      let cover = ''
      let duration = 0
      try {
        const metadata = await mm.parseBlob(audio)
        artist = ecs?.meta.artist || metadata.common.artist || artist
        album = ecs?.meta.album || metadata.common.album || album
        duration = metadata.format.duration || 0
        const picture = metadata.common.picture?.[0]
        if (picture) {
          cover = await this.blobToBase64(new Blob([new Uint8Array(picture.data)], { type: picture.format }))
        }
      } catch {
        // Some playable codecs lack a tag reader. Try the browser decoder below.
      }
      if (!Number.isFinite(duration) || duration <= 0) {
        try { duration = await this.getAudioDuration(audio) } catch { duration = 0 }
      }
      const music: LocalMusic = {
        id,
        name,
        artist,
        album,
        duration,
        cover,
        file,
        createTime: Date.now(),
      }

      await localMusicDB.add(music)
      this.musics.push(music)
      return music
    },

    async deleteMusic(id: string) {
      await localMusicDB.delete(id)
      this.musics = this.musics.filter(m => m.id !== id)
    },

    /** 撤销删除：把文件写回 IndexedDB 并恢复到原位置 */
    async restoreMusic(music: LocalMusic, index?: number) {
      await localMusicDB.add(music)
      if (!this.musics.some(m => m.id === music.id)) {
        const target = Math.max(0, Math.min(index ?? this.musics.length, this.musics.length))
        this.musics.splice(target, 0, music)
      }
    },

    getAudioDuration(file: Blob): Promise<number> {
      return new Promise((resolve, reject) => {
        const audio = new Audio()
        const url = URL.createObjectURL(file)
        audio.src = url
        audio.onloadedmetadata = () => {
          URL.revokeObjectURL(url)
          resolve(audio.duration)
        }
        audio.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('Load audio failed'))
        }
      })
    },

    blobToBase64(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    },

    convertToSong(music: LocalMusic): Song {
      return {
        id: music.id as any, // 兼容类型
        name: music.name,
        artist: music.artist,
        album: music.album,
        cover: music.cover,
        url: '', // The player resolves this local ID and decodes ECS on demand.
        // 元数据解析出的时长单位为秒，Store 层 Song.duration 统一为毫秒
        duration: Math.round((music.duration || 0) * 1000),
        // 其他字段
        mvId: 0,
        publishTime: music.createTime,
        isLocal: true, // 标记为本地音乐
      } as Song & { isLocal?: boolean }
    }
  }
})

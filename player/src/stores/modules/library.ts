/**
 * 个人音乐库 Store
 *
 * 游客与每个已验证账户使用完全独立的本地命名空间。游客数据不会因为登录
 * 被覆盖或静默上传；只有用户在账号同步组件中明确确认后，才会生成云端操作。
 */
import { defineStore } from 'pinia'
import type { Song } from '../interface'
import { safeStorage } from '@/utils/safeStorage'
import {
  ACCOUNT_COLLECTIONS,
  AccountApiError,
  applyAccountLibraryMutation,
  fetchAccountLibrary,
  isAccountVersionConflict,
  type AccountCollection,
  type AccountOperation,
  type AccountSnapshot,
} from '@/api/account'

export interface LikedSongItem {
  id: string | number
  name: string
  artist: string
  album?: string
  cover?: string
  duration?: number
  mvId?: string | number
  likedAt: number
}

export interface CollectedPlaylistItem {
  id: string | number
  name: string
  coverImgUrl?: string
  trackCount?: number
  creator?: string
  playCount?: number | string
  collectedAt: number
}

export interface FollowedArtistItem {
  id: string | number
  name: string
  picUrl?: string
  followedAt: number
}

export interface CollectedAlbumItem {
  id: string | number
  name: string
  picUrl?: string
  artist?: string
  artistId?: string | number
  trackCount?: number
  collectedAt: number
}

export interface LikedMvItem {
  id: string | number
  name: string
  artist?: string
  cover?: string
  likedAt: number
}

/** 本地歌单(无后端写接口,歌曲与歌单关系全部落 localStorage) */
export interface UserPlaylistItem {
  id: string
  name: string
  createdAt: number
  songs: LikedSongItem[]
}

type LibraryCollectionItem =
  | LikedSongItem
  | CollectedPlaylistItem
  | FollowedArtistItem
  | LikedMvItem
  | CollectedAlbumItem
  | UserPlaylistItem

type AccountSyncStatus = 'idle' | 'syncing' | 'synced' | 'pending' | 'error'

interface QueuedAccountMutation {
  operationId: string
  baseVersion: number
  operations: AccountOperation[]
  createdAt: number
}

interface LibraryState {
  likedSongs: LikedSongItem[]
  collectedPlaylists: CollectedPlaylistItem[]
  followedArtists: FollowedArtistItem[]
  likedMvs: LikedMvItem[]
  collectedAlbums: CollectedAlbumItem[]
  userPlaylists: UserPlaylistItem[]
  /** The verified account version last observed by this namespace. */
  accountVersion: number
  accountSyncStatus: AccountSyncStatus
  /** Durable, ordered local mutations. Never shared between namespaces. */
  accountOperationQueue: QueuedAccountMutation[]
  /** Revision used to make the guest merge decision explicit and repeatable. */
  localRevision: number
  guestMergeHandledRevision: number
  /** Runtime-only namespace and guest prompt state. */
  accountNamespace: string
  guestMergeAvailable: boolean
  guestItemCount: number
  accountTombstones: AccountSnapshot['tombstones']
}

type PersistedLibraryState = Pick<
  LibraryState,
  | 'likedSongs'
  | 'collectedPlaylists'
  | 'followedArtists'
  | 'likedMvs'
  | 'collectedAlbums'
  | 'userPlaylists'
  | 'accountVersion'
  | 'accountOperationQueue'
  | 'localRevision'
  | 'guestMergeHandledRevision'
>

const COLLECTIONS = [...ACCOUNT_COLLECTIONS] as AccountCollection[]
const GUEST_NAMESPACE = 'guest'
const LEGACY_LIBRARY_KEY = 'library'
const ACCOUNT_LIBRARY_PREFIX = 'library:account:'
const MAX_OPERATIONS_PER_MUTATION = 100

const sameId = (a: string | number | undefined, b: string | number | undefined) =>
  a !== undefined && b !== undefined && String(a) === String(b)

const clone = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

function accountNamespace(userId: string): string {
  return `account:${encodeURIComponent(userId)}`
}

function accountIdFor(namespace: string): string {
  return decodeURIComponent(namespace.slice('account:'.length))
}

function storageKey(namespace: string): string {
  if (namespace === GUEST_NAMESPACE) return LEGACY_LIBRARY_KEY
  return `${ACCOUNT_LIBRARY_PREFIX}${namespace.slice('account:'.length)}`
}

function readPersistedNamespace(namespace: string): Partial<PersistedLibraryState> | null {
  try {
    const raw = safeStorage.getItem(storageKey(namespace))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function copyCollection<T>(value: unknown): T[] {
  return Array.isArray(value) ? clone(value) : []
}

function validAccountOperation(value: unknown): value is AccountOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const op = value as Record<string, unknown>
  return (
    (op.type === 'upsert' || op.type === 'delete') &&
    typeof op.collection === 'string' &&
    COLLECTIONS.includes(op.collection as AccountCollection) &&
    typeof op.id === 'string' &&
    op.id.length > 0 &&
    (op.type === 'delete' || Boolean(op.value && typeof op.value === 'object'))
  )
}

function copyQueue(value: unknown): QueuedAccountMutation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const item = raw as Record<string, unknown>
    const operations = Array.isArray(item.operations)
      ? item.operations.filter(validAccountOperation).map((operation) => clone(operation))
      : []
    if (
      typeof item.operationId !== 'string' ||
      !item.operationId ||
      !Number.isSafeInteger(item.baseVersion) ||
      Number(item.baseVersion) < 0 ||
      !Number.isSafeInteger(item.createdAt) ||
      Number(item.createdAt) < 0 ||
      operations.length === 0
    ) {
      return []
    }
    return [{
      operationId: item.operationId,
      baseVersion: Number(item.baseVersion),
      operations,
      createdAt: Number(item.createdAt),
    }]
  })
}

function hasLibraryItems(value: Partial<PersistedLibraryState> | null): boolean {
  if (!value) return false
  return COLLECTIONS.some((collection) => Array.isArray(value[collection]) && value[collection].length > 0)
}

function countLibraryItems(value: Partial<PersistedLibraryState> | null): number {
  if (!value) return 0
  return COLLECTIONS.reduce((total, collection) => {
    const items = value[collection]
    return total + (Array.isArray(items) ? items.length : 0)
  }, 0)
}

function createOperationId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '')
    : Math.random().toString(36).slice(2)
  return `library-${Date.now()}-${random}`.slice(0, 128)
}

function restoreLibrary(namespace: string): PersistedLibraryState {
  const value = readPersistedNamespace(namespace)
  return {
    likedSongs: copyCollection(value?.likedSongs),
    collectedPlaylists: copyCollection(value?.collectedPlaylists),
    followedArtists: copyCollection(value?.followedArtists),
    likedMvs: copyCollection(value?.likedMvs),
    collectedAlbums: copyCollection(value?.collectedAlbums),
    userPlaylists: copyCollection(value?.userPlaylists),
    accountVersion: Number.isSafeInteger(value?.accountVersion) && Number(value?.accountVersion) >= 0 ? Number(value?.accountVersion) : 0,
    accountOperationQueue: copyQueue(value?.accountOperationQueue),
    localRevision: Number.isSafeInteger(value?.localRevision) && Number(value?.localRevision) >= 0 ? Number(value?.localRevision) : 0,
    guestMergeHandledRevision: Number.isSafeInteger(value?.guestMergeHandledRevision) ? Number(value?.guestMergeHandledRevision) : -1,
  }
}

const accountFlushes = new WeakMap<object, { generation: number; promise: Promise<boolean> }>()

export const useLibraryStore = defineStore('library', {
  state: (): LibraryState => ({
    ...restoreLibrary(GUEST_NAMESPACE),
    accountSyncStatus: 'idle',
    accountNamespace: GUEST_NAMESPACE,
    guestMergeAvailable: false,
    guestItemCount: 0,
    accountTombstones: [],
  }),

  getters: {
    likedSongCount: (state: LibraryState) => state.likedSongs.length,
    collectedPlaylistCount: (state: LibraryState) => state.collectedPlaylists.length,
    followedArtistCount: (state: LibraryState) => state.followedArtists.length,
    likedMvCount: (state: LibraryState) => state.likedMvs.length,
    collectedAlbumCount: (state: LibraryState) => state.collectedAlbums.length,
    pendingAccountOperationCount: (state: LibraryState) =>
      state.accountOperationQueue.reduce((count, mutation) => count + mutation.operations.length, 0),
    isAccountNamespace: (state: LibraryState) => state.accountNamespace !== GUEST_NAMESPACE,
  },

  actions: {
    /**
     * Switches the visible local namespace to a verified account and fetches its cloud
     * snapshot. Guest data is only inspected to show the explicit merge prompt.
     */
    async activateAccount(userId: string, force = false): Promise<boolean> {
      const id = String(userId || '').trim()
      if (!id) return false
      const nextNamespace = accountNamespace(id)
      const sameNamespace = this.accountNamespace === nextNamespace
      if (sameNamespace && !force && (this.accountSyncStatus === 'syncing' || this.accountSyncStatus === 'synced' || this.accountSyncStatus === 'pending')) {
        return true
      }

      const generation = this.bumpSyncGeneration()
      this.accountNamespace = nextNamespace
      Object.assign(this, restoreLibrary(nextNamespace))
      this.accountTombstones = []
      this.accountSyncStatus = 'idle'
      this.updateGuestMergePrompt()
      return this.syncAccountLibrary(false, generation)
    },

    /** Switch back to the retained guest namespace without deleting account data. */
    deactivateAccount(): void {
      this.bumpSyncGeneration()
      this.accountNamespace = GUEST_NAMESPACE
      Object.assign(this, restoreLibrary(GUEST_NAMESPACE))
      this.accountTombstones = []
      this.accountSyncStatus = 'idle'
      this.guestMergeAvailable = false
      this.guestItemCount = 0
    },

    /** Whether this store is already displaying the requested account namespace. */
    isAccountActive(userId: string): boolean {
      return this.accountNamespace === accountNamespace(String(userId || '').trim())
    },

    /**
     * Fetches the verified server snapshot and rebases queued local mutations on it.
     * The legacy mergeLocal argument is intentionally ignored: merging guest data is
     * only available through mergeGuestLibrary(), which is called by an explicit UI action.
     */
    async syncAccountLibrary(_mergeLocal = false, expectedGeneration?: number): Promise<boolean> {
      if (this.accountNamespace === GUEST_NAMESPACE) return false
      const namespace = this.accountNamespace
      const generation = expectedGeneration ?? this.currentSyncGeneration()
      if (!this.isSyncGenerationActive(namespace, generation)) return false
      this.accountSyncStatus = 'syncing'
      const versionBeforeRead = this.accountVersion
      try {
        const remote = await fetchAccountLibrary(accountIdFor(namespace))
        if (!this.isSyncGenerationActive(namespace, generation)) return false
        // A user can edit the library while its initial snapshot is in flight.
        if (this.accountVersion === versionBeforeRead || remote.version >= this.accountVersion) {
          this.accountVersion = remote.version
          this.accountTombstones = clone(remote.tombstones)
          this.replaceCollectionsWithRemote(remote)
          this.reapplyQueuedMutations()
          this.persistNamespace(namespace)
        }
        if (this.accountOperationQueue.length > 0) {
          const flushed = await this.flushAccountQueue(namespace, generation)
          if (!flushed) return false
        }
        if (!this.isSyncGenerationActive(namespace, generation)) return false
        this.accountSyncStatus = 'synced'
        this.updateGuestMergePrompt()
        this.persistNamespace(namespace)
        return true
      } catch {
        if (this.isSyncGenerationActive(namespace, generation)) this.accountSyncStatus = 'error'
        return false
      }
    },

    /**
     * Merge guest items only after a user-visible confirmation. Remote records and
     * remote tombstones win on same-id conflicts; guest data remains locally stored.
     */
    async mergeGuestLibrary(): Promise<boolean> {
      if (this.accountNamespace === GUEST_NAMESPACE) return false
      const namespace = this.accountNamespace
      const generation = this.currentSyncGeneration()
      if (this.accountSyncStatus === 'error' || this.accountSyncStatus === 'idle') {
        if (!(await this.syncAccountLibrary(false, generation))) return false
      } else if (this.accountOperationQueue.length > 0) {
        if (!(await this.flushAccountQueue(namespace, generation))) return false
      }
      if (!this.isSyncGenerationActive(namespace, generation)) return false

      const guest = readPersistedNamespace(GUEST_NAMESPACE)
      if (!hasLibraryItems(guest)) {
        this.guestMergeAvailable = false
        this.guestItemCount = 0
        return true
      }

      const remoteIds = new Set<string>()
      for (const collection of COLLECTIONS) {
        for (const item of this[collection] as unknown as Array<{ id?: string | number }>) {
          if (item?.id !== undefined) remoteIds.add(`${collection}:${String(item.id)}`)
        }
      }
      const tombstoneIds = new Set(
        this.accountTombstones.map((tombstone) => `${tombstone.collection}:${tombstone.id}`),
      )
      const operations: AccountOperation[] = []
      for (const collection of COLLECTIONS) {
        const items = (guest?.[collection] || []) as Array<{ id?: string | number; name?: string }>
        for (const item of items) {
          if (!item || item.id === undefined || item.name === undefined) continue
          const id = String(item.id)
          const key = `${collection}:${id}`
          if (remoteIds.has(key) || tombstoneIds.has(key)) continue
          operations.push({ type: 'upsert', collection, id, value: clone(item) })
        }
      }

      for (let index = 0; index < operations.length; index += MAX_OPERATIONS_PER_MUTATION) {
        const batch = operations.slice(index, index + MAX_OPERATIONS_PER_MUTATION)
        this.applyOperationsToLocalState(batch)
        this.enqueueAccountOperations(batch)
      }
      this.guestMergeHandledRevision = Number.isSafeInteger(guest?.localRevision)
        ? Number(guest?.localRevision)
        : 0
      this.guestMergeAvailable = false
      this.persistNamespace(namespace)
      if (this.accountOperationQueue.length === 0) return true
      return this.flushAccountQueue(namespace, generation)
    },

    /** Keep guest data local and record that this account saw the current prompt. */
    keepGuestLibraryLocal(): void {
      const guest = readPersistedNamespace(GUEST_NAMESPACE)
      this.guestMergeHandledRevision = Number.isSafeInteger(guest?.localRevision)
        ? Number(guest?.localRevision)
        : 0
      this.guestMergeAvailable = false
      this.persistNamespace(this.accountNamespace)
    },

    isSongLiked(id: string | number | undefined): boolean {
      return this.likedSongs.some((s: LikedSongItem) => sameId(s.id, id))
    },

    toggleLikeSong(song: Partial<Song> & { id: string | number }): boolean {
      const idx = this.likedSongs.findIndex((s: LikedSongItem) => sameId(s.id, song.id))
      if (idx !== -1) {
        this.likedSongs.splice(idx, 1)
        this.recordLocalMutation({ type: 'delete', collection: 'likedSongs', id: String(song.id) })
        import('./recommend')
          .then(({ useRecommendStore }) => {
            try {
              useRecommendStore().recordEvent({
                type: 'unfavorite',
                track: {
                  id: song.id,
                  title: song.name,
                  artist: song.artist,
                  album: song.album,
                  duration: song.duration ? Math.round(song.duration / 1000) : undefined,
                  cover: song.cover,
                },
              })
            } catch {}
          })
          .catch(() => {})
        return false
      }
      const value: LikedSongItem = {
        id: song.id,
        name: song.name || '',
        artist: song.artist || '',
        album: song.album,
        cover: song.cover,
        duration: song.duration,
        mvId: song.mvId,
        likedAt: Date.now(),
      }
      this.likedSongs.unshift(value)
      this.recordLocalMutation({ type: 'upsert', collection: 'likedSongs', id: String(song.id), value })
      import('./recommend')
        .then(({ useRecommendStore }) => {
          try {
            useRecommendStore().recordEvent({
              type: 'favorite',
              track: {
                id: song.id,
                title: song.name,
                artist: song.artist,
                album: song.album,
                duration: song.duration ? Math.round(song.duration / 1000) : undefined,
                cover: song.cover,
              },
            })
          } catch {}
        })
        .catch(() => {})
      return true
    },

    removeLikedSong(id: string | number) {
      const existing = this.likedSongs.find((s: LikedSongItem) => sameId(s.id, id))
      this.likedSongs = this.likedSongs.filter((s: LikedSongItem) => !sameId(s.id, id))
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'likedSongs', id: String(id) })
    },

    /** 喜欢的歌曲映射为 Store 层 Song，可直接入队播放 */
    toPlayableSongs(): Song[] {
      return this.likedSongs.map((s: LikedSongItem) => ({
        id: s.id,
        name: s.name,
        artist: s.artist,
        album: s.album,
        cover: s.cover,
        duration: s.duration || 0,
        mvId: s.mvId,
        liked: true,
      }))
    },

    // ---------- 收藏歌单 ----------
    isPlaylistCollected(id: string | number | undefined): boolean {
      return this.collectedPlaylists.some((p: CollectedPlaylistItem) => sameId(p.id, id))
    },

    toggleCollectPlaylist(playlist: {
      id: string | number
      name: string
      coverImgUrl?: string
      trackCount?: number
      creator?: string
      playCount?: number | string
    }): boolean {
      const idx = this.collectedPlaylists.findIndex((p: CollectedPlaylistItem) => sameId(p.id, playlist.id))
      if (idx !== -1) {
        this.collectedPlaylists.splice(idx, 1)
        this.recordLocalMutation({ type: 'delete', collection: 'collectedPlaylists', id: String(playlist.id) })
        return false
      }
      const value: CollectedPlaylistItem = {
        id: playlist.id,
        name: playlist.name || '',
        coverImgUrl: playlist.coverImgUrl,
        trackCount: playlist.trackCount,
        creator: playlist.creator,
        playCount: playlist.playCount,
        collectedAt: Date.now(),
      }
      this.collectedPlaylists.unshift(value)
      this.recordLocalMutation({ type: 'upsert', collection: 'collectedPlaylists', id: String(playlist.id), value })
      return true
    },

    removeCollectedPlaylist(id: string | number) {
      const existing = this.collectedPlaylists.find((p: CollectedPlaylistItem) => sameId(p.id, id))
      this.collectedPlaylists = this.collectedPlaylists.filter((p: CollectedPlaylistItem) => !sameId(p.id, id))
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'collectedPlaylists', id: String(id) })
    },

    // ---------- 关注歌手 ----------
    isArtistFollowed(id: string | number | undefined): boolean {
      return this.followedArtists.some((a: FollowedArtistItem) => sameId(a.id, id))
    },

    toggleFollowArtist(artist: { id: string | number; name: string; picUrl?: string }): boolean {
      const idx = this.followedArtists.findIndex((a: FollowedArtistItem) => sameId(a.id, artist.id))
      if (idx !== -1) {
        this.followedArtists.splice(idx, 1)
        this.recordLocalMutation({ type: 'delete', collection: 'followedArtists', id: String(artist.id) })
        return false
      }
      const value: FollowedArtistItem = {
        id: artist.id,
        name: artist.name || '',
        picUrl: artist.picUrl,
        followedAt: Date.now(),
      }
      this.followedArtists.unshift(value)
      this.recordLocalMutation({ type: 'upsert', collection: 'followedArtists', id: String(artist.id), value })
      return true
    },

    removeFollowedArtist(id: string | number) {
      const existing = this.followedArtists.find((a: FollowedArtistItem) => sameId(a.id, id))
      this.followedArtists = this.followedArtists.filter((a: FollowedArtistItem) => !sameId(a.id, id))
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'followedArtists', id: String(id) })
    },

    // ---------- MV 点赞 ----------
    isMvLiked(id: string | number | undefined): boolean {
      return this.likedMvs.some((m: LikedMvItem) => sameId(m.id, id))
    },

    toggleLikeMv(mv: { id: string | number; name: string; artist?: string; cover?: string }): boolean {
      const idx = this.likedMvs.findIndex((m: LikedMvItem) => sameId(m.id, mv.id))
      if (idx !== -1) {
        this.likedMvs.splice(idx, 1)
        this.recordLocalMutation({ type: 'delete', collection: 'likedMvs', id: String(mv.id) })
        return false
      }
      const value: LikedMvItem = {
        id: mv.id,
        name: mv.name || '',
        artist: mv.artist,
        cover: mv.cover,
        likedAt: Date.now(),
      }
      this.likedMvs.unshift(value)
      this.recordLocalMutation({ type: 'upsert', collection: 'likedMvs', id: String(mv.id), value })
      return true
    },

    removeLikedMv(id: string | number) {
      const existing = this.likedMvs.find((m: LikedMvItem) => sameId(m.id, id))
      this.likedMvs = this.likedMvs.filter((m: LikedMvItem) => !sameId(m.id, id))
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'likedMvs', id: String(id) })
    },

    // ---------- 收藏专辑 ----------
    isAlbumCollected(id: string | number | undefined): boolean {
      return this.collectedAlbums.some((a: CollectedAlbumItem) => sameId(a.id, id))
    },

    toggleCollectAlbum(album: {
      id: string | number
      name: string
      picUrl?: string
      artist?: string
      artistId?: string | number
      trackCount?: number
    }): boolean {
      const idx = this.collectedAlbums.findIndex((a: CollectedAlbumItem) => sameId(a.id, album.id))
      if (idx !== -1) {
        this.collectedAlbums.splice(idx, 1)
        this.recordLocalMutation({ type: 'delete', collection: 'collectedAlbums', id: String(album.id) })
        return false
      }
      const value: CollectedAlbumItem = {
        id: album.id,
        name: album.name || '',
        picUrl: album.picUrl,
        artist: album.artist,
        artistId: album.artistId,
        trackCount: album.trackCount,
        collectedAt: Date.now(),
      }
      this.collectedAlbums.unshift(value)
      this.recordLocalMutation({ type: 'upsert', collection: 'collectedAlbums', id: String(album.id), value })
      return true
    },

    removeCollectedAlbum(id: string | number) {
      const existing = this.collectedAlbums.find((a: CollectedAlbumItem) => sameId(a.id, id))
      this.collectedAlbums = this.collectedAlbums.filter((a: CollectedAlbumItem) => !sameId(a.id, id))
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'collectedAlbums', id: String(id) })
    },

    // ---------- 本地歌单 ----------
    createUserPlaylist(name: string): UserPlaylistItem | null {
      const trimmed = name.trim()
      if (!trimmed) return null
      const item: UserPlaylistItem = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: trimmed,
        createdAt: Date.now(),
        songs: [],
      }
      this.userPlaylists.unshift(item)
      this.recordLocalMutation({ type: 'upsert', collection: 'userPlaylists', id: item.id, value: item })
      return item
    },

    removeUserPlaylist(id: string) {
      const existing = this.userPlaylists.some((p: UserPlaylistItem) => p.id === id)
      this.userPlaylists = this.userPlaylists.filter((p: UserPlaylistItem) => p.id !== id)
      if (existing) this.recordLocalMutation({ type: 'delete', collection: 'userPlaylists', id })
    },

    renameUserPlaylist(id: string, name: string) {
      const trimmed = name.trim()
      const pl = this.userPlaylists.find((p: UserPlaylistItem) => p.id === id)
      if (pl && trimmed && pl.name !== trimmed) {
        pl.name = trimmed
        this.recordLocalMutation({ type: 'upsert', collection: 'userPlaylists', id, value: pl })
      }
    },

    isSongInUserPlaylist(playlistId: string, songId: string | number | undefined): boolean {
      const pl = this.userPlaylists.find((p: UserPlaylistItem) => p.id === playlistId)
      return Boolean(pl?.songs.some((s: LikedSongItem) => sameId(s.id, songId)))
    },

    /** 加入本地歌单;返回是否真正写入(已存在时为 false) */
    addSongToUserPlaylist(
      playlistId: string,
      song: Partial<Song> & { id: string | number },
    ): boolean {
      const pl = this.userPlaylists.find((p: UserPlaylistItem) => p.id === playlistId)
      if (!pl) return false
      if (pl.songs.some((s: LikedSongItem) => sameId(s.id, song.id))) return false
      pl.songs.unshift({
        id: song.id,
        name: song.name || '',
        artist: song.artist || '',
        album: song.album,
        cover: song.cover,
        duration: song.duration,
        mvId: song.mvId,
        likedAt: Date.now(),
      })
      this.recordLocalMutation({ type: 'upsert', collection: 'userPlaylists', id: playlistId, value: pl })
      return true
    },

    removeSongFromUserPlaylist(playlistId: string, songId: string | number) {
      const pl = this.userPlaylists.find((p: UserPlaylistItem) => p.id === playlistId)
      if (!pl) return
      const before = pl.songs.length
      pl.songs = pl.songs.filter((s: LikedSongItem) => !sameId(s.id, songId))
      if (pl.songs.length !== before) {
        this.recordLocalMutation({ type: 'upsert', collection: 'userPlaylists', id: playlistId, value: pl })
      }
    },

    /** 本地歌单映射为 Store 层 Song,可直接入队播放 */
    toPlayableSongsForUserPlaylist(playlistId: string): Song[] {
      const pl = this.userPlaylists.find((p: UserPlaylistItem) => p.id === playlistId)
      if (!pl) return []
      return pl.songs.map((s: LikedSongItem) => ({
        id: s.id,
        name: s.name,
        artist: s.artist,
        album: s.album,
        cover: s.cover,
        duration: s.duration || 0,
        mvId: s.mvId,
      }))
    },

    // ---------- Namespace and queue internals ----------
    bumpSyncGeneration(): number {
      const next = (this as unknown as { __syncGeneration?: number }).__syncGeneration
      const generation = (next || 0) + 1
      ;(this as unknown as { __syncGeneration?: number }).__syncGeneration = generation
      return generation
    },

    currentSyncGeneration(): number {
      return (this as unknown as { __syncGeneration?: number }).__syncGeneration || 0
    },

    isSyncGenerationActive(namespace: string, generation: number): boolean {
      return this.accountNamespace === namespace && this.currentSyncGeneration() === generation
    },

    persistNamespace(namespace: string): void {
      const value: PersistedLibraryState = {
        likedSongs: clone(this.likedSongs),
        collectedPlaylists: clone(this.collectedPlaylists),
        followedArtists: clone(this.followedArtists),
        likedMvs: clone(this.likedMvs),
        collectedAlbums: clone(this.collectedAlbums),
        userPlaylists: clone(this.userPlaylists),
        accountVersion: this.accountVersion,
        accountOperationQueue: clone(this.accountOperationQueue),
        localRevision: this.localRevision,
        guestMergeHandledRevision: this.guestMergeHandledRevision,
      }
      safeStorage.setItem(storageKey(namespace), JSON.stringify(value))
    },

    updateGuestMergePrompt(): void {
      const guest = readPersistedNamespace(GUEST_NAMESPACE)
      this.guestItemCount = countLibraryItems(guest)
      this.guestMergeAvailable =
        this.accountNamespace !== GUEST_NAMESPACE &&
        hasLibraryItems(guest) &&
        Number(guest?.localRevision || 0) > this.guestMergeHandledRevision
    },

    replaceCollectionsWithRemote(remote: AccountSnapshot): void {
      for (const collection of COLLECTIONS) {
        ;(this[collection] as unknown as LibraryCollectionItem[]) = copyCollection<LibraryCollectionItem>(remote[collection])
      }
    },

    reapplyQueuedMutations(): void {
      for (const mutation of this.accountOperationQueue) this.applyOperationsToLocalState(mutation.operations)
    },

    applyOperationsToLocalState(operations: AccountOperation[]): void {
      for (const operation of operations) {
        const collection = this[operation.collection] as unknown as Array<{ id?: string | number }>
        const index = collection.findIndex((item) => String(item?.id) === operation.id)
        if (operation.type === 'delete') {
          if (index !== -1) collection.splice(index, 1)
          continue
        }
        const value = clone(operation.value || {}) as LibraryCollectionItem
        if (!value || typeof value !== 'object' || !('id' in value)) continue
        if (index === -1) collection.unshift(value)
        else collection.splice(index, 1, value)
      }
    },

    enqueueAccountOperations(operations: AccountOperation[]): void {
      if (operations.length === 0) return
      const mutation: QueuedAccountMutation = {
        operationId: createOperationId(),
        baseVersion: this.accountVersion,
        operations: clone(operations),
        createdAt: Date.now(),
      }
      this.accountOperationQueue.push(mutation)
      this.accountSyncStatus = 'pending'
      this.persistNamespace(this.accountNamespace)
      if (this.accountNamespace !== GUEST_NAMESPACE) void this.flushAccountQueue(this.accountNamespace, this.currentSyncGeneration())
    },

    recordLocalMutation(operation: AccountOperation): void {
      this.localRevision += 1
      if (this.accountNamespace === GUEST_NAMESPACE) this.persistNamespace(GUEST_NAMESPACE)
      else this.enqueueAccountOperations([operation])
    },

    async flushAccountQueue(namespace: string, generation: number): Promise<boolean> {
      if (namespace === GUEST_NAMESPACE || !this.isSyncGenerationActive(namespace, generation)) return false
      const current = accountFlushes.get(this)
      if (current?.generation === generation) return current.promise
      const promise = this.flushAccountQueueInternal(namespace, generation).finally(() => {
        if (accountFlushes.get(this)?.promise === promise) accountFlushes.delete(this)
      })
      accountFlushes.set(this, { generation, promise })
      return promise
    },

    async flushAccountQueueInternal(namespace: string, generation: number): Promise<boolean> {
      while (this.accountOperationQueue.length > 0) {
        if (!this.isSyncGenerationActive(namespace, generation)) return false
        const mutation = this.accountOperationQueue[0]
        try {
          const result = await applyAccountLibraryMutation({
            operationId: mutation.operationId,
            baseVersion: mutation.baseVersion,
            operations: mutation.operations,
          }, accountIdFor(namespace))
          if (!this.isSyncGenerationActive(namespace, generation)) return false
          this.accountOperationQueue.shift()
          this.accountVersion = Math.max(this.accountVersion, result.version)
          if (result.replayed) {
            // A later edit on another device may supersede the replayed operation.
            const remote = await fetchAccountLibrary(accountIdFor(namespace))
            if (!this.isSyncGenerationActive(namespace, generation)) return false
            this.accountVersion = remote.version
            this.accountTombstones = clone(remote.tombstones)
            this.replaceCollectionsWithRemote(remote)
            this.reapplyQueuedMutations()
          }
          const next = this.accountOperationQueue[0]
          if (next && !result.replayed && next.baseVersion === mutation.baseVersion)
            next.baseVersion = result.version
          this.accountSyncStatus = this.accountOperationQueue.length > 0 ? 'pending' : 'synced'
          this.persistNamespace(namespace)
        } catch (error) {
          if (!this.isSyncGenerationActive(namespace, generation)) return false
          if (isAccountVersionConflict(error)) {
            try {
              const remote = await fetchAccountLibrary(accountIdFor(namespace))
              if (!this.isSyncGenerationActive(namespace, generation)) return false
              this.accountVersion = remote.version
              this.accountTombstones = clone(remote.tombstones)
              this.replaceCollectionsWithRemote(remote)
              // Only a confirmed version conflict permits changing a request that
              // may already have reached the server. Preserve newer remote deletions.
              const deleted = new Set(remote.tombstones.filter(t => t.version > mutation.baseVersion)
                .map(t => t.collection + ':' + t.id))
              mutation.operations = mutation.operations.filter(op => op.type !== 'upsert' || !deleted.has(op.collection + ':' + op.id))
              if (!mutation.operations.length) this.accountOperationQueue.shift()
              else mutation.baseVersion = remote.version
              this.reapplyQueuedMutations()
              this.persistNamespace(namespace)
              continue
            } catch {
              if (this.isSyncGenerationActive(namespace, generation)) this.accountSyncStatus = 'error'
              return false
            }
          }
          this.accountSyncStatus = error instanceof AccountApiError && error.retryable ? 'pending' : 'error'
          this.persistNamespace(namespace)
          return false
        }
      }
      this.accountSyncStatus = 'synced'
      this.persistNamespace(namespace)
      return true
    },
  },
})

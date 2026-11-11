/**
 * 智能推荐与搜索偏好 Store
 * 管理：
 *   - 隐私优先的匿名设备标识 (`anonId`) 与个性化总开关 (`personalizationEnabled`)
 *   - 自动连续电台 / Auto DJ 开关 (`autoDjEnabled`)
 *   - 负向反馈 (`dislikedTracks` — 减少类似推荐)
 *   - 非阻塞异步行为事件批量上报 (`play_start`, `play_progress`, `play_complete`, `skip`, `replay`, `favorite`, `dislike`, `search`, `search_click`)
 */
import { defineStore, getActivePinia } from 'pinia'
import piniaPersistConfig from '../persist'
import type { Song } from '../interface'
import { useLibraryStore } from './library'
import { useAudioStore } from './audio'
import { useAuthStore } from './auth'
import { useToastStore } from './toast'
import { safeStorage } from '@/utils/safeStorage'
import {
  deleteSonicEvents,
  fetchRecommendForYou,
  postSonicEvents,
  type RecommendSongItem,
  type SonicEventPayload,
} from '@/api/recommend'

export interface DislikedTrackEntry {
  id: string
  canonicalTrackId?: string
  name: string
  artist: string
  createdAt: number
}

interface RecommendStoreState {
  personalizationEnabled: boolean
  autoDjEnabled: boolean
  anonId: string
  dislikedTracks: DislikedTrackEntry[]
}

const ANON_ID_PATTERN = /^anon_[a-zA-Z0-9_-]{8,64}$/
const ANON_ID_KEY = 'sonic:recommendation-device-id'
const PERSONALIZATION_CONSENT_KEY = 'sonic:personalization-consent'
const CONSENT_REVISION_PATTERN = /^[a-f0-9]{24}$/

function randomHex(): string {
  const bytes = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function generateAnonId(): string {
  return `anon_${randomHex()}`
}

function readConsentRevision(): string | null {
  const value = safeStorage.getItem(PERSONALIZATION_CONSENT_KEY)
  return value && CONSENT_REVISION_PATTERN.test(value) ? value : null
}

function restoreAnonId(): string {
  const saved = safeStorage.getItem(ANON_ID_KEY)
  if (saved !== null) return ANON_ID_PATTERN.test(saved) ? saved : ''
  try {
    const legacy = JSON.parse(safeStorage.getItem('recommend') || '{}').anonId
    if (typeof legacy === 'string' && ANON_ID_PATTERN.test(legacy)) {
      safeStorage.setItem(ANON_ID_KEY, legacy)
      return legacy
    }
  } catch {}
  return ''
}

function encodeContextBase64Url(obj: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(obj)
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch {
    return ''
  }
}

const MAX_PENDING_EVENTS = 40
const DRAIN_TIMEOUT_MS = 15_000

interface DeliveryState {
  consentRevision: string | null
  generation: number
  pending: SonicEventPayload[]
  identity: string | null
  eventEpoch: { subject: string; value: string } | null
  timer: ReturnType<typeof setTimeout> | null
  writes: Set<Promise<void>>
  clearing: Promise<boolean> | null
}

const deliveries = new WeakMap<object, DeliveryState>()

function deliveryFor(store: object): DeliveryState {
  let delivery = deliveries.get(store)
  if (!delivery) {
    delivery = { consentRevision: null, generation: 0, pending: [], identity: null, eventEpoch: null, timer: null, writes: new Set(), clearing: null }
    deliveries.set(store, delivery)
  }
  return delivery
}

function currentAccountId(): string | undefined {
  const auth = useAuthStore()
  return auth.isAuthenticated ? auth.user?.id : undefined
}

function deliveryIdentity(anonId: string): string {
  return JSON.stringify([anonId, currentAccountId() ?? null])
}

function stopFlushTimer(delivery: DeliveryState) {
  if (delivery.timer !== null) clearTimeout(delivery.timer)
  delivery.timer = null
}

function discardPending(delivery: DeliveryState) {
  stopFlushTimer(delivery)
  delivery.generation++
  delivery.pending = []
  delivery.identity = null
}

function syncConsent(store: RecommendStoreState, delivery = deliveryFor(store)): boolean {
  // Storage events can arrive after a queued timer or pagehide. Read the latest
  // explicit choice before every send, including an off/on change between tasks.
  const revision = readConsentRevision()
  if (delivery.consentRevision !== revision) {
    discardPending(delivery)
    delivery.consentRevision = revision
  }
  store.personalizationEnabled = revision !== null
  return store.personalizationEnabled
}

function syncAnonId(store: RecommendStoreState, delivery = deliveryFor(store)): string {
  const value = safeStorage.getItem(ANON_ID_KEY)
  const id = value && ANON_ID_PATTERN.test(value) ? value : ''
  if (id !== store.anonId) {
    discardPending(delivery)
    store.anonId = id
  }
  return id
}

async function waitForWrites(writes: Set<Promise<void>>): Promise<boolean> {
  if (!writes.size) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.all(writes).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export const useRecommendStore = defineStore('recommend', {
  state: (): RecommendStoreState => ({
    personalizationEnabled: readConsentRevision() !== null,
    autoDjEnabled: true,
    anonId: restoreAnonId(),
    dislikedTracks: [],
  }),

  getters: {
    dislikedCount: (state): number => state.dislikedTracks.length,
  },

  actions: {
    ensureAnonId(): string {
      if (!syncConsent(this)) return ''
      const current = syncAnonId(this)
      if (current) return current
      safeStorage.setItem(ANON_ID_KEY, generateAnonId())
      return syncAnonId(this)
    },

    buildRequestHeaders(includeContext = true): Record<string, string> {
      if (!syncConsent(this) || deliveries.get(this)?.clearing) {
        return {
          'X-Sonic-Personalization': 'off',
        }
      }

      const headers: Record<string, string> = {}
      const id = this.ensureAnonId()
      if (!id) return { 'X-Sonic-Personalization': 'off' }
      headers['X-Sonic-Anon-Id'] = id

      // Browser sessions are authenticated by the HttpOnly `sonic_session` cookie set
      // by the OAuth callback; the SPA must not read or persist bearer API keys.

      if (includeContext) {
        try {
          const libraryStore = useLibraryStore()
          const audioStore = useAudioStore()

          const likedArtists = Array.from(
            new Set(libraryStore.likedSongs.slice(0, 15).map((s: { artist?: string }) => s.artist).filter(Boolean))
          ).slice(0, 10)
          const recentArtists = Array.from(
            new Set(
              (audioStore.audio.playHistory || [])
                .slice(0, 15)
                .map((s: { artist?: string }) => s.artist)
                .filter(Boolean)
            )
          ).slice(0, 10)
          const likedTrackIds = libraryStore.likedSongs
            .slice(0, 15)
            .map((s) => String(s.id))
          const dislikedTrackIds = this.dislikedTracks
            .slice(0, 25)
            .map((d) => d.canonicalTrackId || d.id)
          let recentQueries: string[] = []
          try {
            const rawGlobal =
              typeof localStorage !== 'undefined' ? localStorage.getItem('global') : null
            if (rawGlobal) {
              const parsed = JSON.parse(rawGlobal)
              if (Array.isArray(parsed?.searchHistory)) {
                recentQueries = parsed.searchHistory.slice(0, 8)
              }
            }
          } catch {}

          const ctx = encodeContextBase64Url({
            likedArtists,
            recentArtists,
            likedTrackIds,
            dislikedTrackIds,
            recentQueries,
          })
          if (ctx && ctx.length <= 3600) {
            headers['X-Sonic-Context'] = ctx
          }
        } catch {}
      }

      return syncConsent(this) && syncAnonId(this) === id ? headers : { 'X-Sonic-Personalization': 'off' }
    },

    isSongDisliked(idOrCanonicalId?: string | number): boolean {
      if (idOrCanonicalId === undefined || idOrCanonicalId === null) return false
      const target = String(idOrCanonicalId)
      return this.dislikedTracks.some(
        (d) => d.id === target || (d.canonicalTrackId && d.canonicalTrackId === target)
      )
    },

    recordEvent(payload: SonicEventPayload, immediate = false) {
      const delivery = deliveryFor(this)
      if (delivery.clearing) return
      const anonId = this.ensureAnonId()
      if (!anonId) return
      const identity = deliveryIdentity(anonId)
      if (delivery.identity !== identity) {
        discardPending(delivery)
        delivery.identity = identity
      }
      const evId =
        payload.eventId ||
        `fe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      delivery.pending.push({
        ...payload,
        eventId: evId,
        timestamp: payload.timestamp || Date.now(),
      })
      if (delivery.pending.length > MAX_PENDING_EVENTS) {
        delivery.pending.shift()
      }

      if (immediate) {
        void this.flushEvents()
        return
      }
      if (!delivery.timer) {
        delivery.timer = setTimeout(() => {
          delivery.timer = null
          void this.flushEvents()
        }, 1200)
      }
    },

    async flushEvents() {
      const delivery = deliveries.get(this)
      if (!delivery) return
      stopFlushTimer(delivery)
      if (!syncConsent(this, delivery) || delivery.clearing || delivery.pending.length === 0) return
      const identity = deliveryIdentity(syncAnonId(this, delivery))
      if (delivery.identity !== identity) {
        discardPending(delivery)
        return
      }
      const generation = delivery.generation
      const batch = delivery.pending
      delivery.pending = []
      const headers = this.buildRequestHeaders(false)
      const accountId = currentAccountId()
      const expectedMode = accountId ? 'authenticated' : 'anonymous-opt-in'
      const target = accountId ? `account:${accountId}` : 'anonymous-opt-in'
      const subject = accountId ? target : this.anonId
      const eventEpoch = delivery.eventEpoch?.subject === subject ? delivery.eventEpoch.value : undefined
      headers['X-Sonic-Event-Target'] = target
      if (!syncConsent(this, delivery) || delivery.generation !== generation ||
        deliveryIdentity(syncAnonId(this, delivery)) !== identity) return
      const write = postSonicEvents(batch, headers, { expectedMode, eventEpoch }).then((result) => {
        if (!syncConsent(this, delivery) || delivery.clearing ||
          delivery.generation !== generation || deliveryIdentity(syncAnonId(this, delivery)) !== identity) return
        if (result.status === 'epoch-mismatch') {
          // Discard unsent events and invalidate other writes from before the erasure.
          discardPending(delivery)
          if (result.eventEpoch !== undefined) {
            delivery.eventEpoch = result.eventEpoch === null ? null : { subject, value: result.eventEpoch }
          }
          return
        }
        if (result.status !== 'retry') return
        const capacity = Math.max(0, MAX_PENDING_EVENTS - delivery.pending.length)
        delivery.pending = [...batch.slice(0, capacity), ...delivery.pending]
      })
      delivery.writes.add(write)
      try {
        await write
      } finally {
        delivery.writes.delete(write)
      }
    },

    dislikeSong(
      song: Partial<Song> & { id: string | number; canonicalTrackId?: string }
    ) {
      const idStr = String(song.id)
      if (!this.isSongDisliked(idStr)) {
        this.dislikedTracks.unshift({
          id: idStr,
          canonicalTrackId: song.canonicalTrackId,
          name: song.name || '',
          artist: song.artist || '',
          createdAt: Date.now(),
        })
        if (this.dislikedTracks.length > 100) {
          this.dislikedTracks.pop()
        }
      }

      this.recordEvent(
        {
          type: 'dislike',
          track: {
            id: song.id,
            canonicalTrackId: song.canonicalTrackId,
            title: song.name,
            artist: song.artist,
            album: song.album,
            duration: song.duration ? Math.round(song.duration / 1000) : undefined,
          },
        },
        true
      )

      // 若当前正在播放被标记“不喜欢”的歌曲，自动切到下一首
      try {
        const audioStore = useAudioStore()
        if (
          audioStore.audio.currentSong &&
          String(audioStore.audio.currentSong.id) === idStr
        ) {
          audioStore.nextSong(false)
        }
      } catch {}
    },

    undislikeSong(id: string | number) {
      const target = String(id)
      const found = this.dislikedTracks.find(
        (d) => d.id === target || d.canonicalTrackId === target
      )
      this.dislikedTracks = this.dislikedTracks.filter(
        (d) => d.id !== target && d.canonicalTrackId !== target
      )
      if (found) {
        this.recordEvent(
          {
            type: 'undislike',
            track: {
              id: found.id,
              canonicalTrackId: found.canonicalTrackId,
              title: found.name,
              artist: found.artist,
            },
          },
          true
        )
      }
    },

    async startSongRadio(
      seedSong: Partial<Song> & { id: string | number; name: string; artist: string }
    ): Promise<RecommendSongItem[]> {
      const headers = this.buildRequestHeaders(true)
      const res = await fetchRecommendForYou(
        {
          mode: 'radio',
          count: 16,
          seedTrackId: seedSong.id,
          seedTitle: seedSong.name,
          seedArtist: seedSong.artist,
          temperature: 0.35,
        },
        headers
      )

      const audioStore = useAudioStore()
      const seedPlayable: Song = {
        id: seedSong.id,
        name: seedSong.name,
        artist: seedSong.artist,
        album: seedSong.album || '',
        cover: seedSong.cover || '',
        duration: seedSong.duration || 0,
        url: seedSong.url,
      }
      const radioQueue: Song[] = [seedPlayable, ...res.tracks]
      audioStore.setPlaylist(radioQueue, 0)
      await audioStore.playSong(radioQueue[0], 0, true)

      useToastStore().show({
        message: `已开启「${seedSong.name}」相似音乐电台 (${res.tracks.length + 1} 首)`,
        type: 'success',
        duration: 3500,
      })
      return res.tracks
    },

    async fetchAutoDjNextSongs(seedSong?: Song | null, count = 5): Promise<RecommendSongItem[]> {
      if (!this.autoDjEnabled) return []
      try {
        const audioStore = useAudioStore()
        const excludeIds = audioStore.audio.playlist.slice(-15).map((s: { id: string | number }) => String(s.id))
        const res = await fetchRecommendForYou(
          {
            mode: 'next',
            count,
            seedTrackId: seedSong?.id,
            seedTitle: seedSong?.name,
            seedArtist: seedSong?.artist,
            exclude: excludeIds,
          },
          this.buildRequestHeaders(true)
        )
        return res.tracks
      } catch {
        return []
      }
    },

    setPersonalizationEnabled(enabled: boolean) {
      if (enabled) {
        if (!syncAnonId(this)) safeStorage.setItem(ANON_ID_KEY, generateAnonId())
        safeStorage.setItem(PERSONALIZATION_CONSENT_KEY, randomHex())
      } else {
        safeStorage.removeItem(PERSONALIZATION_CONSENT_KEY)
      }
      syncConsent(this)
      syncAnonId(this)
    },

    async clearAllRecommendationProfile(): Promise<boolean> {
      const delivery = deliveryFor(this)
      if (delivery.clearing) return delivery.clearing
      const accountId = currentAccountId()
      const anonId = syncAnonId(this, delivery)
      // An expired account session must not silently delete the guest profile.
      // Guest erasure still needs the old device ID after personalization is off.
      const mode = accountId ? 'authenticated' : anonId ? 'anonymous-opt-in' : 'public'
      const headers: Record<string, string> = { 'X-Sonic-Erasure-Target': accountId ? `account:${accountId}` : mode }
      if (mode === 'anonymous-opt-in') headers['X-Sonic-Anon-Id'] = anonId
      if (mode === 'public') headers['X-Sonic-Personalization'] = 'off'
      const identity = deliveryIdentity(anonId)
      discardPending(delivery)
      // Drain all writes from this tab before DELETE. No new events can be
      // queued during erasure, including via pagehide or a failed batch retry.
      const clearing = waitForWrites(delivery.writes).then(async (drained) => {
        if (!drained || deliveryIdentity(syncAnonId(this, delivery)) !== identity) return false
        const result = await deleteSonicEvents(headers, mode)
        if (!result || deliveryIdentity(syncAnonId(this, delivery)) !== identity) return false
        syncConsent(this, delivery)
        this.dislikedTracks = []
        if (accountId && result.eventEpoch) {
          delivery.eventEpoch = { subject: `account:${accountId}`, value: result.eventEpoch }
        } else if (mode === 'anonymous-opt-in') {
          if (delivery.eventEpoch?.subject === anonId) delivery.eventEpoch = null
          safeStorage.setItem(ANON_ID_KEY, this.personalizationEnabled ? generateAnonId() : '')
          syncAnonId(this, delivery)
        }
        return true
      })
      delivery.clearing = clearing
      try {
        return await clearing
      } finally {
        delivery.clearing = null
      }
    },
  },

  persist: piniaPersistConfig<RecommendStoreState>('recommend', [
    'autoDjEnabled',
    'dislikedTracks',
  ]),
})

// 页面卸载/切后台时把防抖窗口内未上报的事件立即冲刷出去。
// postSonicEvents 使用 fetch keepalive,页面关闭后浏览器仍会完成发送。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== PERSONALIZATION_CONSENT_KEY && event.key !== ANON_ID_KEY) return
    const pinia = getActivePinia()
    if (!pinia) return
    const store = useRecommendStore(pinia)
    syncConsent(store)
    syncAnonId(store)
  })
  const flushPendingOnHide = () => {
    const pinia = getActivePinia()
    if (pinia) void useRecommendStore(pinia).flushEvents()
  }
  window.addEventListener('pagehide', flushPendingOnHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingOnHide()
  })
}

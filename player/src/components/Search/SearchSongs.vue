<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { cloudSearch } from '@/api'
import {
  fetchSmartSearch,
  type RecommendSongItem,
  type SmartSuggestionItem,
} from '@/api/recommend'
import { useAudio } from '@/composables/useAudio'
import { useRecommendStore } from '@/stores/modules/recommend'
import { transformSearchSongs, normalizeDurationMs, type SongData } from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'

interface Props {
  keywords: string
  limit?: number
  offset?: number
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'loaded', count: number): void
  (e: 'total', count: number): void
}>()

interface SongsState {
  results: SongData[]
  fallbackTracks: RecommendSongItem[]
  suggestions: SmartSuggestionItem[]
  fallbackUsed: boolean
  isLoading: boolean
  errorKind: '' | 'network' | 'rateLimited' | 'upstream'
}

const router = useRouter()
const { t } = useI18n()
const recommendStore = useRecommendStore()
const state = reactive<SongsState>({
  results: [],
  fallbackTracks: [],
  suggestions: [],
  fallbackUsed: false,
  isLoading: false,
  errorKind: '',
})
const { results, fallbackTracks, suggestions, fallbackUsed, isLoading, errorKind } = toRefs(state)

/** 区分“真的没有结果”与“上游失败”，避免把 403/429/断网伪装成空搜索 */
const classifySearchError = (error: unknown): SongsState['errorKind'] => {
  const err = error as any
  const status = Number(err?.response?.status ?? err?.status ?? 0)
  if (status === 429) return 'rateLimited'
  if (status === 403 || status >= 500) return 'upstream'
  const msg = String(err?.message || '')
  const httpMatch = msg.match(/Sonic HTTP (\d{3})/)
  if (httpMatch) return Number(httpMatch[1]) === 429 ? 'rateLimited' : 'upstream'
  if (err?.name === 'TypeError' || /failed to fetch|network|offline|timeout/i.test(msg)) return 'network'
  return 'upstream'
}

const errorMessage = computed(() => {
  switch (state.errorKind) {
    case 'network':
      return t('search.loadFailedNetwork')
    case 'rateLimited':
      return t('search.loadFailedRateLimited')
    case 'upstream':
      return t('search.loadFailedUpstream')
    default:
      return ''
  }
})

const { setPlaylist, play } = useAudio()
let requestController: AbortController | null = null
let requestGeneration = 0

// 仅在用户真实点击搜索结果(或点"播放全部"的第一首)时上报 search_click;
// 此前通过 watch(currentSong) 上报会把自动连播的后续曲目误记为点击,污染推荐信号。
const reportSearchClick = (song: {
  id: string | number
  name: string
  artist: string
  album?: string
  duration?: number
  cover?: string
}) => {
  const term = props.keywords?.trim()
  if (!term || !song) return
  recommendStore.recordEvent({
    type: 'search_click',
    query: term,
    track: {
      id: song.id,
      title: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration ? Math.round(song.duration / 1000) : undefined,
      cover: song.cover,
    },
  })
}

const onSongPlayed = (song: Parameters<typeof reportSearchClick>[0], _index?: number) => {
  reportSearchClick(song)
}

const playAll = () => {
  const list = state.results.length > 0 ? state.results : state.fallbackTracks
  if (list.length === 0) return
  setPlaylist(list, 0)
  play(list[0], 0)
  reportSearchClick(list[0])
}

const applySuggestion = (text: string) => {
  if (!text.trim()) return
  router.push({ path: '/search', query: { q: text.trim() } })
}

const fetchSongs = async () => {
  const generation = ++requestGeneration
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  const term = props.keywords?.trim()
  state.errorKind = ''
  if (!term) {
    state.results = []
    state.fallbackTracks = []
    state.suggestions = []
    state.fallbackUsed = false
    state.isLoading = false
    return
  }
  state.isLoading = true
  let lastError: unknown = null
  const page = Math.floor((props.offset ?? 0) / (props.limit ?? 40)) + 1
  const count = props.limit ?? 40

  if (page === 1) {
    recommendStore.recordEvent({
      type: 'search',
      query: term,
    })
  }

  try {
    // 0. 优先调用 Sonic 混合智能搜索引擎 (/api/sonic/search/smart：支持简繁/拼音/容错/别名扩展与相关性门控个性化重排)
    try {
      const smartRes = await fetchSmartSearch(
        {
          q: term,
          page,
          count,
          personalize: recommendStore.personalizationEnabled,
        },
        recommendStore.buildRequestHeaders(true),
        controller.signal
      )
      if (controller.signal.aborted || generation !== requestGeneration) return
      state.suggestions = smartRes.suggestions || []
      if (smartRes.tracks.length > 0) {
        state.results = smartRes.tracks
        state.fallbackTracks = []
        state.fallbackUsed = false
        emit('loaded', state.results.length)
        emit('total', smartRes.total || state.results.length)
        return
      }
      if (smartRes.fallbackUsed && smartRes.fallbackTracks.length > 0) {
        state.results = []
        state.fallbackTracks = smartRes.fallbackTracks
        state.fallbackUsed = true
        emit('loaded', 0)
        emit('total', 0)
        return
      }
    } catch (smartErr) {
      if (controller.signal.aborted || generation !== requestGeneration) return
      lastError = smartErr
      console.warn('[Sonic Search] Smart search fallback to nexus:', smartErr)
    }

    // 1. 备用调用 Sonic 统一多源 SHA 聚合与音质分级搜索网关
    try {
      const sonicRes = await fetch(
        `/api/sonic/search/nexus?q=${encodeURIComponent(term)}&page=${page}&count=${count}`,
        { signal: controller.signal },
      ).then(r => r.json())
      if (controller.signal.aborted || generation !== requestGeneration) return
      const tracks = sonicRes?.data?.tracks || []
      if (tracks.length > 0) {
        state.results = tracks.map((t: any) => ({
          id: t.platformId || t.id,
          name: t.title || t.name,
          artist: t.artist,
          // 保留真实歌手 ID；缺失时留空，由列表降级为纯文本展示
          artistId: t.artistId ?? undefined,
          artists: t.artistId ? [{ id: t.artistId, name: t.artist || '' }] : undefined,
          album: t.album || '',
          albumId: 0,
          cover: formatCoverUrl(t.cover || t.coverUrl || t.artistPic || '', { size: 300, artist: t.artist }),
          duration: normalizeDurationMs(t.duration),
          dt: normalizeDurationMs(t.duration),
          url: t.streamUrl || `/api/music/stream?id=${encodeURIComponent(t.platformId || t.id)}&title=${encodeURIComponent(t.title || '')}&artist=${encodeURIComponent(t.artist || '')}`,
          sha: t.sha || '',
          qualityBadge: t.qualityBadge || undefined,
          qualities: t.qualities || [],
          sources: t.sources || [],
          streamType: t.streamType || (t.platform === 'netease' && t.isVip ? 'trial' : undefined),
          liked: false,
        }))
        state.fallbackTracks = []
        state.fallbackUsed = false
        emit('loaded', state.results.length)
        emit('total', sonicRes?.data?.total || state.results.length)
        return
      }
    } catch (err) {
      if (controller.signal.aborted || generation !== requestGeneration) return
      lastError = err
      console.warn('[Sonic Search] Nexus gateway warning:', err)
    }

    // 2. 备用兜底检索通道
    try {
      const res = await cloudSearch({
        keywords: term,
        type: 1,
        limit: props.limit ?? 40,
        offset: props.offset ?? 0,
      }, controller.signal)
      if (controller.signal.aborted || generation !== requestGeneration) return
      const { songs, total } = transformSearchSongs(res as Record<string, unknown>)
      if (songs && songs.length > 0) {
        state.results = songs
        state.fallbackTracks = []
        state.fallbackUsed = false
        emit('loaded', state.results.length)
        emit('total', total)
        return
      }
    } catch (err) {
      if (controller.signal.aborted || generation !== requestGeneration) return
      lastError = err
      console.warn('[Sonic Search] CloudSearch fallback warning:', err)
    }

    state.results = []
    if (lastError) state.errorKind = classifySearchError(lastError)
    emit('loaded', 0)
    emit('total', 0)
  } finally {
    if (generation === requestGeneration) state.isLoading = false
  }
}

watch(
  [() => props.keywords, () => props.limit, () => props.offset],
  () => {
    fetchSongs()
  },
  { immediate: true }
)

defineExpose({
  playAll,
})
</script>
<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 纠错与关联推荐词条 -->
    <div
      v-if="suggestions.length > 0 && (fallbackUsed || results.length < 6)"
      class="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 px-1"
    >
      <span class="text-primary/50 text-xs">{{ $t('recommend.search.relatedQueries') }}</span>
      <button
        v-for="sug in suggestions.slice(0, 6)"
        :key="sug.text"
        type="button"
        @click="applySuggestion(sug.text)"
        class="border-glass bg-hover-glass text-primary/80 hover:text-[var(--glass-text-accent)] rounded-full border px-2.5 py-0.5 text-xs transition-colors"
      >
        {{ sug.text }}
      </button>
    </div>

    <!-- 上游失败（403/429/断网/5xx）与真实空结果的区分反馈 -->
    <template v-if="!isLoading && errorKind && results.length === 0 && fallbackTracks.length === 0">
      <div
        data-testid="search-error"
        role="alert"
        class="glass-card border-glass mx-1 mt-2 flex shrink-0 flex-col items-start gap-3 rounded-xl border px-4 py-4"
      >
        <div class="text-primary flex items-center gap-2 text-sm font-semibold">
          <span class="icon-[mdi--cloud-alert] h-5 w-5 text-amber-400" />
          <span>{{ $t('search.loadFailed') }}</span>
        </div>
        <p class="text-primary/60 text-xs">{{ errorMessage }}</p>
        <Button size="sm" variant="soft" data-testid="search-retry" @click="fetchSongs">
          {{ $t('common.retry') }}
        </Button>
      </div>
    </template>

    <!-- 零结果时的智能可播放兜底面板 -->
    <template v-else-if="!isLoading && results.length === 0 && fallbackTracks.length > 0">
      <div class="glass-card border-glass mb-3 shrink-0 rounded-xl border px-4 py-3">
        <div class="text-primary flex items-center gap-2 text-sm font-semibold">
          <span class="icon-[mdi--compass-rose] h-4 w-4 text-sky-400" />
          <span>{{ $t('recommend.search.zeroResultFallbackTitle') }}</span>
        </div>
        <p class="text-primary/55 mt-0.5 text-xs">
          {{ $t('recommend.search.zeroResultFallbackDesc') }}
        </p>
      </div>
      <SongList
        :songs="fallbackTracks"
        :loading="false"
        :showHeader="true"
        :showControls="false"
        :emptyMessage="$t('search.empty')"
        @play="onSongPlayed"
      />
    </template>

    <SongList
      v-else
      :songs="results"
      :loading="isLoading"
      :showHeader="true"
      :showControls="false"
      :emptyMessage="$t('search.empty')"
      @play="onSongPlayed"
    />
  </div>
</template>

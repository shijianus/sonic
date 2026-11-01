<script setup lang="ts">
import { artistList, cloudSearch } from '@/api'
import { useI18n } from 'vue-i18n'
import {
  transformArtists,
  transformAlbums,
  type ArtistData,
  type AlbumData,
} from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'
import InfiniteScroll from '@/components/Ui/InfiniteScroll.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import LazyImage from '@/components/Ui/LazyImage.vue'

const { t } = useI18n()

interface ArtistItem extends Omit<ArtistData, 'alias'> {
  alias?: string
  trans?: string
}

// 分类筛选浏览状态
const state = reactive({
  artists: [] as ArtistItem[],
  isPageLoading: false,
  isLoadingMore: false,
  isLoadError: false,
  type: -1,
  area: -1,
  initial: '',
  sortBy: 'hot' as 'hot' | 'songs' | 'albums',
  selectedStyle: '' as string,
  offset: 0,
  limit: 30,
  hasMore: true,
})

const { type, area, initial, sortBy, selectedStyle } = toRefs(state)

// 专属搜索状态（专搜歌手本人和专辑，严格区分全局单曲/MV搜索）
const searchState = reactive({
  keyword: '',
  appliedKeyword: '',
  isSearching: false,
  isLoading: false,
  isLoadError: false,
  activeTab: 'all' as 'all' | 'artists' | 'albums',
  artists: [] as ArtistItem[],
  albums: [] as AlbumData[],
  artistTotal: 0,
  albumTotal: 0,
})

// 选项配置
const typeOptions = [
  { key: -1, labelKey: 'artists.types.all' },
  { key: 1, labelKey: 'artists.types.male' },
  { key: 2, labelKey: 'artists.types.female' },
  { key: 3, labelKey: 'artists.types.band' },
]

const areaOptions = [
  { key: -1, labelKey: 'artists.areas.all' },
  { key: 7, labelKey: 'artists.areas.zh' },
  { key: 96, labelKey: 'artists.areas.ea' },
  { key: 8, labelKey: 'artists.areas.jp' },
  { key: 16, labelKey: 'artists.areas.kr' },
  { key: 0, labelKey: 'artists.areas.other' },
]

const initialOptions = [
  { key: '', labelKey: 'artists.initials.hot' },
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => ({ key: c, labelKey: c })),
  { key: '0', labelKey: '#' },
]

const sortOptions = [
  { key: 'hot', labelKey: 'artists.sortOptions.hot' },
  { key: 'songs', labelKey: 'artists.sortOptions.songs' },
  { key: 'albums', labelKey: 'artists.sortOptions.albums' },
]

const styleOptions = [
  { key: '', labelKey: 'artists.styles.all' },
  { key: 'pop', labelKey: 'artists.styles.pop' },
  { key: 'rock', labelKey: 'artists.styles.rock' },
  { key: 'folk', labelKey: 'artists.styles.folk' },
  { key: 'hiphop', labelKey: 'artists.styles.hiphop' },
  { key: 'electronic', labelKey: 'artists.styles.electronic' },
  { key: 'gufeng', labelKey: 'artists.styles.gufeng' },
  { key: 'rnb', labelKey: 'artists.styles.rnb' },
  { key: 'acg', labelKey: 'artists.styles.acg' },
]

// 排序后的分类歌手列表
const sortedArtists = computed(() => {
  const list = [...state.artists]
  if (state.sortBy === 'songs') {
    return list.sort((a, b) => (b.musicSize || 0) - (a.musicSize || 0))
  }
  if (state.sortBy === 'albums') {
    return list.sort((a, b) => (b.albumSize || 0) - (a.albumSize || 0))
  }
  return list
})

// 加载分类歌手列表
const loadArtists = async (reset = false) => {
  if (state.isLoadingMore) return
  if (reset) {
    state.offset = 0
    state.artists = []
    state.hasMore = true
    state.isPageLoading = true
  } else {
    if (!state.hasMore) return
    state.isLoadingMore = true
  }
  state.isLoadError = false

  try {
    const params: Record<string, any> = {
      limit: state.limit,
      offset: state.offset,
    }
    if (state.type !== -1) params.type = state.type
    if (state.area !== -1) params.area = state.area
    if (state.initial !== '') params.initial = state.initial

    const res = await artistList(params)
    const artists = transformArtists(res as Record<string, unknown>)

    const mapped: ArtistItem[] = artists.map(it => ({
      ...it,
      alias: it.alias?.join(' / ') || '',
      trans: (it as any).trans || '',
    }))

    state.artists = reset ? mapped : [...state.artists, ...mapped]
    state.hasMore = artists.length === state.limit
    state.offset += state.limit
  } catch {
    state.isLoadError = true
    state.hasMore = false
  } finally {
    if (reset) state.isPageLoading = false
    state.isLoadingMore = false
  }
}

// 重置所有筛选条件
const resetFilters = () => {
  const changed =
    state.type !== -1 ||
    state.area !== -1 ||
    state.initial !== '' ||
    state.sortBy !== 'hot' ||
    state.selectedStyle !== ''

  state.type = -1
  state.area = -1
  state.initial = ''
  state.sortBy = 'hot'
  state.selectedStyle = ''

  if (!changed) {
    loadArtists(true)
  }
}

// 风格流派快速细分
const selectStyle = (styleKey: string) => {
  state.selectedStyle = styleKey
  if (styleKey) {
    // 快速联动搜索该风格下的代表歌手与专辑
    const styleLabel = t(`artists.styles.${styleKey}`)
    searchState.keyword = styleLabel
    triggerSearch(styleLabel)
  }
}

// 专属搜索逻辑（仅搜歌手与专辑）
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const onSearchInput = () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  const val = searchState.keyword.trim()
  if (!val) {
    clearSearch()
    return
  }
  searchDebounceTimer = setTimeout(() => {
    triggerSearch()
  }, 350)
}

const triggerSearch = async (kw?: string) => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  const query = (kw !== undefined ? kw : searchState.keyword).trim()
  if (!query) {
    clearSearch()
    return
  }

  searchState.appliedKeyword = query
  searchState.isSearching = true
  searchState.isLoading = true
  searchState.isLoadError = false

  try {
    const [artistsRes, albumsRes] = await Promise.all([
      cloudSearch({ keywords: query, type: 100, limit: 36, offset: 0 }),
      cloudSearch({ keywords: query, type: 10, limit: 36, offset: 0 }),
    ])

    const rawArtists = transformArtists(artistsRes as Record<string, unknown>)
    searchState.artists = rawArtists.map(it => ({
      ...it,
      alias: it.alias?.join(' / ') || '',
      trans: (it as any).trans || '',
    }))
    searchState.artistTotal =
      (artistsRes as any)?.result?.artistCount ?? searchState.artists.length

    searchState.albums = transformAlbums(albumsRes as Record<string, unknown>)
    searchState.albumTotal =
      (albumsRes as any)?.result?.albumCount ?? searchState.albums.length
  } catch {
    searchState.isLoadError = true
    searchState.artists = []
    searchState.albums = []
  } finally {
    searchState.isLoading = false
  }
}

const clearSearch = () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  searchState.keyword = ''
  searchState.appliedKeyword = ''
  searchState.isSearching = false
  searchState.artists = []
  searchState.albums = []
  searchState.artistTotal = 0
  searchState.albumTotal = 0
  searchState.activeTab = 'all'
}

// 监听分类条件变动即时重新加载
watch([type, area, initial], () => loadArtists(true))

onMounted(() => loadArtists(true))
</script>

<template>
  <div class="flex h-full flex-1 flex-col overflow-hidden">
    <!-- 顶部控制与专属搜索区 -->
    <div class="glass-card mx-1 sm:mx-2 mt-1 mb-3 shrink-0 p-3 sm:p-4 transition-all">
      <!-- 第一栏：板块标题与专属搜索框 -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-white/5">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
            <span class="icon-[mdi--account-music] h-5 w-5" />
          </div>
          <h1 class="text-primary text-base sm:text-lg font-bold tracking-tight">
            {{ t('routes.artists') }}
          </h1>
        </div>

        <!-- 专属搜索框容器 -->
        <div class="flex items-center gap-2 w-full md:w-auto">
          <div class="relative flex-1 md:w-80 group">
            <span
              class="icon-[mdi--magnify] absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-primary/40 transition-colors group-focus-within:text-sky-400"
            />
            <input
              v-model="searchState.keyword"
              type="text"
              :placeholder="t('artists.searchPlaceholder')"
              class="w-full rounded-full border border-white/10 bg-white/5 py-1.5 pl-9 pr-8 text-xs sm:text-sm text-primary placeholder:text-primary/40 outline-none backdrop-blur-md transition-all focus:border-sky-500/50 focus:bg-white/10 focus:ring-2 focus:ring-sky-500/20"
              @input="onSearchInput"
              @keyup.enter="triggerSearch()"
            />
            <button
              v-if="searchState.keyword"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded-full text-primary/40 hover:text-white"
              :title="t('artists.clearSearch')"
              @click="clearSearch"
            >
              <span class="icon-[mdi--close-circle] h-3.5 w-3.5" />
            </button>
          </div>

          <button
            class="shrink-0 flex items-center gap-1.5 rounded-full bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 px-3.5 py-1.5 text-xs font-medium text-sky-400 transition-all active:scale-95 cursor-pointer"
            @click="triggerSearch()"
          >
            <span class="icon-[mdi--magnify] h-3.5 w-3.5" />
            <span class="hidden sm:inline">{{ t('common.search.label') }}</span>
          </button>

          <button
            v-if="searchState.isSearching"
            class="shrink-0 flex items-center gap-1 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 px-3 py-1.5 text-xs text-primary/80 transition-all cursor-pointer"
            @click="clearSearch"
          >
            <span class="icon-[mdi--arrow-left] h-3.5 w-3.5" />
            <span class="hidden sm:inline">{{ t('artists.backToBrowse') }}</span>
          </button>
        </div>
      </div>

      <!-- 第二栏：分类筛选栏（未搜索时展示） -->
      <div v-if="!searchState.isSearching" class="pt-3 space-y-2.5">
        <!-- 地区细分 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
            {{ t('artists.area') }}:
          </span>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="opt in areaOptions"
              :key="opt.key"
              class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer"
              :class="
                area === opt.key
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                  : 'text-primary/60 hover:bg-white/5 hover:text-primary'
              "
              @click="area = opt.key"
            >
              {{ t(opt.labelKey) }}
            </button>
          </div>
        </div>

        <!-- 歌手类型细分 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
            {{ t('artists.type') }}:
          </span>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="opt in typeOptions"
              :key="opt.key"
              class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer"
              :class="
                type === opt.key
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                  : 'text-primary/60 hover:bg-white/5 hover:text-primary'
              "
              @click="type = opt.key"
            >
              {{ t(opt.labelKey) }}
            </button>
          </div>
        </div>

        <!-- 首字母筛选（支持热门、A-Z 与 #） -->
        <div class="flex items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
            {{ t('artists.initial') }}:
          </span>
          <div class="flex flex-1 items-center gap-1 overflow-x-auto py-0.5 no-scrollbar">
            <button
              v-for="opt in initialOptions"
              :key="opt.key"
              class="rounded px-2 py-0.5 text-xs transition-all shrink-0 cursor-pointer"
              :class="
                initial === opt.key
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-semibold shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                  : 'text-primary/60 hover:bg-white/5 hover:text-primary'
              "
              @click="initial = opt.key"
            >
              {{ opt.labelKey.startsWith('artists.') ? t(opt.labelKey) : opt.labelKey }}
            </button>
          </div>
        </div>

        <!-- 扩展维度：风格流派与排序 -->
        <div class="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/5">
          <!-- 风格标签快速筛选 -->
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-primary/40 text-xs shrink-0 mr-1">
              {{ t('artists.styles.all') }}:
            </span>
            <button
              v-for="opt in styleOptions"
              :key="opt.key"
              class="rounded-md px-2 py-0.5 text-[11px] transition-all cursor-pointer"
              :class="
                selectedStyle === opt.key
                  ? 'bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 font-medium'
                  : 'text-primary/50 hover:bg-white/5 hover:text-primary'
              "
              @click="selectStyle(opt.key)"
            >
              {{ t(opt.labelKey) }}
            </button>
          </div>

          <!-- 排序维度与状态 -->
          <div class="flex items-center gap-2 ml-auto">
            <span class="text-primary/40 text-xs hidden sm:inline">
              {{ t('artists.sortBy') }}:
            </span>
            <div class="flex gap-1">
              <button
                v-for="sort in sortOptions"
                :key="sort.key"
                class="rounded-md px-2 py-0.5 text-[11px] transition-all cursor-pointer"
                :class="
                  sortBy === sort.key
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium'
                    : 'text-primary/50 hover:bg-white/5 hover:text-primary'
                "
                @click="sortBy = (sort.key as any)"
              >
                {{ t(sort.labelKey) }}
              </button>
            </div>

            <!-- 重置按钮 -->
            <button
              class="flex items-center gap-1 text-[11px] text-primary/40 hover:text-sky-400 px-2 py-0.5 rounded transition-colors cursor-pointer"
              :title="t('artists.resetFilters')"
              @click="resetFilters"
            >
              <span class="icon-[mdi--restart] h-3.5 w-3.5" />
              <span>{{ t('artists.resetFilters') }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 搜索状态下的信息条与 Tab 切换 -->
      <div v-else class="pt-3 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <span class="text-primary text-xs sm:text-sm font-semibold">
            “{{ searchState.appliedKeyword }}”
          </span>
          <span class="text-primary/40 text-xs">
            {{
              t('artists.searchResultCount', {
                artists: searchState.artistTotal,
                albums: searchState.albumTotal,
              })
            }}
          </span>
        </div>

        <!-- 搜索分类切换 Tab -->
        <div class="flex items-center gap-1 bg-white/5 p-1 rounded-lg border border-white/10">
          <button
            class="rounded-md px-2.5 py-1 text-xs transition-all cursor-pointer"
            :class="
              searchState.activeTab === 'all'
                ? 'bg-sky-500/20 text-sky-400 font-medium'
                : 'text-primary/60 hover:text-primary'
            "
            @click="searchState.activeTab = 'all'"
          >
            {{ t('artists.tabs.all') }}
          </button>
          <button
            class="rounded-md px-2.5 py-1 text-xs transition-all cursor-pointer"
            :class="
              searchState.activeTab === 'artists'
                ? 'bg-sky-500/20 text-sky-400 font-medium'
                : 'text-primary/60 hover:text-primary'
            "
            @click="searchState.activeTab = 'artists'"
          >
            {{ t('artists.tabs.artists') }} ({{ searchState.artists.length }})
          </button>
          <button
            class="rounded-md px-2.5 py-1 text-xs transition-all cursor-pointer"
            :class="
              searchState.activeTab === 'albums'
                ? 'bg-sky-500/20 text-sky-400 font-medium'
                : 'text-primary/60 hover:text-primary'
            "
            @click="searchState.activeTab = 'albums'"
          >
            {{ t('artists.tabs.albums') }} ({{ searchState.albums.length }})
          </button>
        </div>
      </div>
    </div>

    <!-- 主展示区：分类模式 或 搜索模式 -->
    <div class="flex-1 overflow-auto px-1 sm:px-2 pb-6">
      <!-- ═══════════════════════════════════════════════ -->
      <!-- 1. 专属搜索结果展示                             -->
      <!-- ═══════════════════════════════════════════════ -->
      <template v-if="searchState.isSearching">
        <!-- 搜索中加载骨架屏 -->
        <PageSkeleton
          v-if="searchState.isLoading"
          :sections="['grid']"
          :grid-count="12"
        />

        <!-- 空结果状态 -->
        <div
          v-else-if="!searchState.artists.length && !searchState.albums.length"
          class="flex flex-col items-center justify-center py-20 text-center"
        >
          <div class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5 text-primary/30">
            <span class="icon-[mdi--account-search-outline] h-8 w-8" />
          </div>
          <p class="text-primary/70 text-sm font-medium">
            {{ t('artists.noResults') }}
          </p>
          <p class="text-primary/40 text-xs mt-1 max-w-sm">
            未检索到包含「{{ searchState.appliedKeyword }}」的歌手或专辑，您可以尝试其他关键词。
          </p>
          <button
            class="mt-4 rounded-lg bg-sky-500/20 px-4 py-2 text-xs font-medium text-sky-400 hover:bg-sky-500/30 transition-all cursor-pointer"
            @click="clearSearch"
          >
            {{ t('artists.backToBrowse') }}
          </button>
        </div>

        <!-- 搜索结果内容区 -->
        <div v-else class="space-y-6">
          <!-- 匹配歌手模块（在 'all' 或 'artists' 下展示） -->
          <section
            v-if="
              (searchState.activeTab === 'all' || searchState.activeTab === 'artists') &&
              searchState.artists.length
            "
          >
            <div class="flex items-center justify-between mb-3 px-1">
              <h2 class="text-primary text-sm font-bold flex items-center gap-1.5">
                <span class="icon-[mdi--account] h-4 w-4 text-sky-400" />
                <span>{{ t('artists.tabs.artists') }}</span>
                <span class="text-primary/40 text-xs font-normal">({{ searchState.artists.length }})</span>
              </h2>
            </div>

            <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <router-link
                v-for="artist in searchState.artists"
                :key="artist.id"
                :to="`/artist/${artist.id}`"
                class="glass-card group flex flex-col items-center cursor-pointer overflow-hidden p-3 transition-all duration-300 hover:bg-white/10 hover:border-sky-500/30 hover:-translate-y-0.5"
              >
                <div class="relative mb-2 aspect-square w-full overflow-hidden rounded-full shadow-md">
                  <LazyImage
                    :src="formatCoverUrl(artist.picUrl, { size: 300, artist: artist.name })"
                    :alt="artist.name"
                    class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                </div>
                <span class="text-primary truncate text-xs sm:text-sm font-medium transition-colors group-hover:text-sky-400">
                  {{ artist.name }}
                </span>
              </router-link>
            </div>
          </section>

          <!-- 歌手专辑模块（在 'all' 或 'albums' 下展示） -->
          <section
            v-if="
              (searchState.activeTab === 'all' || searchState.activeTab === 'albums') &&
              searchState.albums.length
            "
          >
            <div class="flex items-center justify-between mb-3 px-1">
              <h2 class="text-primary text-sm font-bold flex items-center gap-1.5">
                <span class="icon-[mdi--album] h-4 w-4 text-sky-400" />
                <span>{{ t('artists.tabs.albums') }}</span>
                <span class="text-primary/40 text-xs font-normal">({{ searchState.albums.length }})</span>
              </h2>
            </div>

            <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <router-link
                v-for="album in searchState.albums"
                :key="album.id"
                :to="`/album/${album.id}`"
                class="glass-card group cursor-pointer overflow-hidden p-2.5 transition-all duration-300 hover:bg-white/10 hover:border-sky-500/30 hover:-translate-y-0.5"
              >
                <div class="relative mb-2 aspect-square overflow-hidden rounded-lg shadow-md">
                  <LazyImage
                    :src="formatCoverUrl(album.picUrl, { size: 300, artist: album.artist })"
                    :alt="album.name"
                    class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div
                    class="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100"
                  >
                    <span class="icon-[mdi--play-circle] h-10 w-10 text-white" />
                  </div>
                </div>
                <div>
                  <p class="text-primary truncate text-xs sm:text-sm font-medium group-hover:text-sky-400 transition-colors">
                    {{ album.name }}
                  </p>
                  <router-link
                    v-if="album.artistId"
                    :to="`/artist/${album.artistId}`"
                    class="text-primary/60 hover:text-sky-400 truncate text-[11px] block transition-colors mt-0.5"
                    @click.stop
                  >
                    {{ album.artist }}
                  </router-link>
                  <p v-else class="text-primary/60 truncate text-[11px] mt-0.5">
                    {{ album.artist }}
                  </p>
                </div>
              </router-link>
            </div>
          </section>
        </div>
      </template>

      <!-- ═══════════════════════════════════════════════ -->
      <!-- 2. 分类筛选浏览列表                             -->
      <!-- ═══════════════════════════════════════════════ -->
      <template v-else>
        <PageSkeleton v-if="state.isPageLoading && !state.artists.length" :sections="['grid']" />
        <div v-else class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          <router-link
            v-for="artist in sortedArtists"
            :key="artist.id"
            :to="`/artist/${artist.id}`"
            class="glass-card group flex flex-col items-center cursor-pointer overflow-hidden p-3 transition-all duration-300 hover:bg-white/10 hover:border-sky-500/30 hover:-translate-y-0.5"
          >
            <div class="relative mb-2 aspect-square w-full overflow-hidden rounded-full shadow-md">
              <LazyImage
                :src="formatCoverUrl(artist.picUrl, { size: 300, artist: artist.name })"
                :alt="artist.name"
                class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            </div>
            <span class="text-primary truncate text-xs sm:text-sm font-medium transition-colors group-hover:text-sky-400">
              {{ artist.name }}
            </span>
          </router-link>
        </div>

        <!-- 自动流式触底加载与超时自愈重试 -->
        <InfiniteScroll
          :loading="state.isLoadingMore"
          :has-more="state.hasMore"
          :error="state.isLoadError"
          :empty="!state.artists.length"
          :loading-text="t('common.loading')"
          :retry-text="t('artists.loadMore')"
          :reset-text="$t('components.infiniteScroll.reset')"
          @load="loadArtists(false)"
          @retry="loadArtists(false)"
          @reset="resetFilters"
        />
      </template>
    </div>
  </div>
</template>

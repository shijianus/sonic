<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { topSong } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { transformTopSongs, type SongData } from '@/utils/transformers'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const recommendStore = useRecommendStore()

type Category = 'trending' | 'newSong'
type TrendingWindow = '7d' | '24h' | 'surging' | 'new'

const categories: Array<{ key: Category; labelKey: string }> = [
  { key: 'trending', labelKey: 'charts.trending' },
  { key: 'newSong', labelKey: 'charts.newSongs' },
]

const trendingWindows: Array<{ key: TrendingWindow; labelKey: string }> = [
  { key: '7d', labelKey: 'recommend.windows.7d' },
  { key: '24h', labelKey: 'recommend.windows.24h' },
  { key: 'surging', labelKey: 'recommend.windows.surging' },
  { key: 'new', labelKey: 'recommend.windows.new' },
]

const newSongTypes = [
  { key: 0 as const, labelKey: 'charts.types.all' },
  { key: 7 as const, labelKey: 'charts.types.mandarin' },
  { key: 96 as const, labelKey: 'charts.types.west' },
  { key: 8 as const, labelKey: 'charts.types.japan' },
  { key: 16 as const, labelKey: 'charts.types.korea' },
]

const state = reactive({
  category: 'trending' as Category,
  trendingWindow: '7d' as TrendingWindow,
  newSongTab: 0 as 0 | 7 | 96 | 8 | 16,
  loading: true,
  songs: [] as SongData[],
})

const loadTrending = async () => {
  state.loading = true
  try {
    const res = await fetchRecommendTrending(
      {
        window: state.trendingWindow,
        count: 40,
        personalized: recommendStore.personalizationEnabled,
      },
      recommendStore.buildRequestHeaders(true)
    )
    state.songs = res.tracks
  } catch (err) {
    console.warn('[MobileCharts] loadTrending failed:', err)
  } finally {
    state.loading = false
  }
}

const loadNewSongs = async (type: 0 | 7 | 96 | 8 | 16) => {
  state.loading = true
  try {
    const res = await topSong({ type })
    state.songs = transformTopSongs(res as Record<string, unknown>)
  } finally {
    state.loading = false
  }
}

const loadCurrent = () => {
  if (state.category === 'trending') {
    loadTrending()
  } else {
    loadNewSongs(state.newSongTab)
  }
}

const handleCategoryChange = (cat: Category) => {
  if (state.category === cat) return
  state.category = cat
  loadCurrent()
}

const handleTrendingWindowChange = (win: TrendingWindow) => {
  state.trendingWindow = win
  loadTrending()
}

const handleNewSongTypeChange = (type: 0 | 7 | 96 | 8 | 16) => {
  state.newSongTab = type
  loadNewSongs(type)
}

onMounted(() => {
  loadCurrent()
})
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <div class="glass-nav sticky top-0 z-10 pt-2 pb-3 backdrop-blur-md">
      <!-- 主分类：站内趋势 / 新歌速递 -->
      <div class="mb-2 flex items-center gap-2 border-b border-glass pb-2">
        <button
          v-for="cat in categories"
          :key="cat.key"
          type="button"
          class="rounded-lg px-3 py-1.5 text-sm font-semibold transition-all"
          :class="
            state.category === cat.key
              ? 'bg-sky-500/20 text-[var(--glass-text-accent)] shadow-xs'
              : 'text-primary/60 hover:text-primary'
          "
          @click="handleCategoryChange(cat.key)"
        >
          {{ t(cat.labelKey) }}
        </button>
      </div>

      <!-- 子过滤项 -->
      <div v-if="state.category === 'trending'" class="scrollbar-hide flex items-center gap-1.5 overflow-x-auto">
        <button
          v-for="win in trendingWindows"
          :key="win.key"
          type="button"
          class="shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors"
          :class="
            state.trendingWindow === win.key
              ? 'bg-sky-500/15 text-sky-400 font-medium'
              : 'text-primary/60 hover:text-primary'
          "
          @click="handleTrendingWindowChange(win.key)"
        >
          {{ t(win.labelKey) }}
        </button>
      </div>

      <div v-else class="scrollbar-hide flex items-center gap-1.5 overflow-x-auto">
        <button
          v-for="type in newSongTypes"
          :key="type.key"
          type="button"
          class="shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors"
          :class="
            state.newSongTab === type.key
              ? 'bg-sky-500/15 text-sky-400 font-medium'
              : 'text-primary/60 hover:text-primary'
          "
          @click="handleNewSongTypeChange(type.key)"
        >
          {{ t(type.labelKey) }}
        </button>
      </div>
    </div>

    <!-- 列表展示 -->
    <div v-if="state.loading" class="py-6">
      <PageSkeleton :sections="['list']" :list-count="10" />
    </div>
    <div v-else>
      <MobileSongList :songs="state.songs" :show-index="true" />
    </div>
  </div>
</template>

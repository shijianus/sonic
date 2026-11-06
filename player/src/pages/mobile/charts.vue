<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { topSong, toplist, playlistTrackAll, playlistDetail } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const recommendStore = useRecommendStore()

type Category = 'trending' | 'newSong' | 'official'
type TrendingWindow = '7d' | '24h' | 'surging' | 'new'

const categories: Array<{ key: Category; labelKey: string }> = [
  { key: 'trending', labelKey: 'charts.trending' },
  { key: 'newSong', labelKey: 'charts.newSongs' },
  { key: 'official', labelKey: 'charts.official' },
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
  officialLists: [] as any[],
  selectedList: null as any,
})

// Only the newest load may write shared state. Without this guard, a slow
// official-chart response can overwrite the new-song list after a category
// switch (and vice versa).
let loadGeneration = 0
const beginLoad = () => ++loadGeneration
const isCurrentLoad = (generation: number) => generation === loadGeneration

const loadTrending = async () => {
  const generation = beginLoad()
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
    if (!isCurrentLoad(generation)) return
    state.songs = res.tracks
  } catch (err) {
    if (!isCurrentLoad(generation)) return
    console.warn('[MobileCharts] loadTrending failed:', err)
  } finally {
    if (isCurrentLoad(generation)) state.loading = false
  }
}

const loadNewSongs = async (type: 0 | 7 | 96 | 8 | 16) => {
  const generation = beginLoad()
  state.loading = true
  try {
    const res = await topSong({ type })
    if (!isCurrentLoad(generation)) return
    state.songs = transformTopSongs(res as Record<string, unknown>)
  } finally {
    if (isCurrentLoad(generation)) state.loading = false
  }
}

const loadOfficialSongs = async (item: any) => {
  if (!item?.id) return
  const generation = beginLoad()
  state.selectedList = item
  state.loading = true
  try {
    const numericId = Number(item.id) || item.id
    const [tracksRes, detailRes] = await Promise.allSettled([
      playlistTrackAll({ id: numericId, limit: 100 }),
      playlistDetail({ id: Number(numericId) }),
    ])
    if (!isCurrentLoad(generation)) return
    let songs: SongData[] = []
    if (tracksRes.status === 'fulfilled' && tracksRes.value) {
      songs = transformSongs(tracksRes.value as Record<string, unknown>, 100)
    }
    if (songs.length === 0 && detailRes.status === 'fulfilled' && detailRes.value) {
      songs = transformSongs(detailRes.value as Record<string, unknown>, 100)
    }
    state.songs = songs
  } catch (err) {
    if (!isCurrentLoad(generation)) return
    console.warn('[MobileCharts] loadOfficialSongs failed:', err)
    state.songs = []
  } finally {
    if (isCurrentLoad(generation)) state.loading = false
  }
}

const loadOfficialLists = async () => {
  const generation = beginLoad()
  if (state.officialLists.length) {
    const target = state.selectedList || state.officialLists[0]
    await loadOfficialSongs(target)
    return
  }
  state.loading = true
  try {
    const res: any = await toplist()
    if (!isCurrentLoad(generation)) return
    const list: any[] = res?.list || res?.data?.list || []
    state.officialLists = list.map((item: any) => ({
      id: item?.id,
      name: item?.name,
      cover: item?.coverImgUrl || '',
    }))
    if (state.officialLists.length) {
      await loadOfficialSongs(state.officialLists[0])
    } else {
      state.songs = []
    }
  } catch (err) {
    if (!isCurrentLoad(generation)) return
    console.warn('[MobileCharts] loadOfficialLists failed:', err)
    state.officialLists = []
    state.songs = []
  } finally {
    if (isCurrentLoad(generation)) state.loading = false
  }
}

const loadCurrent = () => {
  if (state.category === 'trending') {
    loadTrending()
  } else if (state.category === 'newSong') {
    loadNewSongs(state.newSongTab)
  } else {
    loadOfficialLists()
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

const handleOfficialChange = (item: any) => {
  if (state.selectedList?.id === item?.id) return
  void loadOfficialSongs(item)
}

onMounted(() => {
  loadCurrent()
})
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <div class="glass-nav sticky top-0 z-10 pt-2 pb-3 backdrop-blur-md">
      <!-- 主分类：站内趋势 / 新歌速递 / 官方榜单 -->
      <div class="mb-2 flex items-center gap-2 border-b border-glass pb-2 flex-wrap">
        <span class="text-primary/60 text-xs font-medium shrink-0 w-[70px]">
          {{ t('charts.categoryLabel') }}
        </span>
        <div class="flex items-center gap-1 flex-wrap">
          <button
            v-for="cat in categories"
            :key="cat.key"
            type="button"
            class="rounded-lg px-2.5 py-1 text-xs font-semibold transition-all"
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
      </div>

      <!-- 子过滤项 -->
      <div v-if="state.category === 'trending'" class="flex h-[96px] items-center gap-2 flex-wrap">
        <span class="text-primary/60 text-xs font-medium shrink-0 w-[70px]">
          {{ t('charts.trendingLabel') }}
        </span>
        <div class="chart-filter-scroll flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1">
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
      </div>

      <div v-else-if="state.category === 'newSong'" class="flex h-[96px] items-center gap-2 flex-wrap">
        <span class="text-primary/60 text-xs font-medium shrink-0 w-[70px]">
          {{ t('charts.newSongLabel') }}
        </span>
        <div class="chart-filter-scroll flex items-center gap-1.5 overflow-x-auto min-w-0 flex-1">
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

      <div v-else class="flex h-[96px] items-start gap-2 flex-wrap">
        <span class="text-primary/60 text-xs font-medium shrink-0 w-[70px]">
          {{ t('charts.officialLabel') }}
        </span>
        <div class="official-chart-filter flex flex-wrap items-center gap-1.5 max-h-[96px] overflow-y-auto min-w-0 flex-1 pr-1">
          <button
            v-for="item in state.officialLists"
            :key="item.id"
            type="button"
            class="max-w-full rounded-md px-2.5 py-1 text-left text-xs transition-colors break-words"
            :class="
              state.selectedList?.id === item.id
                ? 'bg-sky-500/15 text-sky-400 font-medium'
                : 'text-primary/60 hover:text-primary'
            "
            @click="handleOfficialChange(item)"
          >
            {{ item.name }}
          </button>
        </div>
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

<style scoped>
/* Keep every chart filter reachable with a visible thin scrollbar instead of
   hiding overflow behind a scrollbar-hide carousel. */
.chart-filter-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.55) transparent;
  -ms-overflow-style: auto;
}
.chart-filter-scroll::-webkit-scrollbar {
  display: block;
  height: 4px;
}
.chart-filter-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.chart-filter-scroll::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.5);
  border-radius: 999px;
}

/* Official charts can contain 25+ entries. Wrap them into rows with a visible
   vertical scrollbar instead of a 4000px horizontal carousel. */
.official-chart-filter {
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.55) transparent;
  scrollbar-gutter: stable;
  -ms-overflow-style: auto;
}
.official-chart-filter::-webkit-scrollbar {
  display: block;
  width: 4px;
}
.official-chart-filter::-webkit-scrollbar-track {
  background: transparent;
}
.official-chart-filter::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.5);
  border-radius: 999px;
}
</style>

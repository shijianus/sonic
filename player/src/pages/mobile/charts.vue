<script setup lang="ts">
import { computed, reactive, onMounted } from 'vue'
import { topSong, toplist, playlistTrackAll, playlistDetail } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import FilterRow from '@/components/Ui/FilterRow.vue'
import { useChartFilters, type ChartCategory, type ChartWindow, type ChartRegion } from '@/composables/useChartFilters'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const recommendStore = useRecommendStore()

const { categories, trendingWindows, newSongRegions } = useChartFilters()

const state = reactive({
  category: 'trending' as ChartCategory,
  trendingWindow: '7d' as ChartWindow,
  newSongTab: 0 as ChartRegion,
  loading: true,
  songs: [] as SongData[],
  officialLists: [] as any[],
  selectedList: null as any,
})

const officialOptions = computed(() => state.officialLists.map(item => ({ key: item.id, label: item.name })))

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

const loadNewSongs = async (type: ChartRegion) => {
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

const handleCategoryChange = (cat: ChartCategory) => {
  if (state.category === cat) return
  state.category = cat
  loadCurrent()
}

const handleTrendingWindowChange = (win: ChartWindow) => {
  state.trendingWindow = win
  loadTrending()
}

const handleNewSongTypeChange = (type: ChartRegion) => {
  state.newSongTab = type
  loadNewSongs(type)
}

const handleOfficialChange = (id: string | number) => {
  if (state.selectedList?.id === id) return
  void loadOfficialSongs(state.officialLists.find(item => item.id === id))
}

onMounted(() => {
  loadCurrent()
})
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <div class="glass-nav sticky top-0 z-10 grid gap-2 px-2 pt-2 pb-3 backdrop-blur-md">
      <FilterRow
        :model-value="state.category"
        :label="t('charts.categoryLabel')"
        :options="categories"
        @update:model-value="handleCategoryChange"
      />

      <!-- Reserve the same space for each chart category, including the scrollable official list. -->
      <div class="h-26">
        <FilterRow
          v-if="state.category === 'trending'"
          :model-value="state.trendingWindow"
          :label="t('charts.trendingLabel')"
          :options="trendingWindows"
          @update:model-value="handleTrendingWindowChange"
        />
        <FilterRow
          v-else-if="state.category === 'newSong'"
          :model-value="state.newSongTab"
          :label="t('charts.newSongLabel')"
          :options="newSongRegions"
          @update:model-value="handleNewSongTypeChange"
        />
        <FilterRow
          v-else
          :model-value="state.selectedList?.id"
          :label="t('charts.officialLabel')"
          :options="officialOptions"
          scroll="vertical"
          options-class="official-chart-filter"
          @update:model-value="handleOfficialChange"
        />
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

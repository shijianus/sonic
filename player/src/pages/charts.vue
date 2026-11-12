<script setup lang="ts">
import { reactive, toRefs, computed, watch, onMounted } from 'vue'
import SongList from '@/components/SongList.vue'
import FilterRow from '@/components/Ui/FilterRow.vue'
import { useChartFilters, type ChartCategory, type ChartWindow, type ChartRegion } from '@/composables/useChartFilters'
import { topSong, toplist, playlistTrackAll, playlistDetail } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'

const { t } = useI18n()
const recommendStore = useRecommendStore()

const { categories, trendingWindows, newSongRegions } = useChartFilters()

const state = reactive({
  activeTab: 'trending' as ChartCategory,
  trendingWindow: '7d' as ChartWindow,
  trendingSongs: [] as SongData[],
  trendingLoading: false,
  activeType: 0 as ChartRegion,
  songs: [] as SongData[],
  newSongLoading: false,
  officialLists: [] as any[],
  officialListLoading: false,
  selectedList: null as any,
  listSongs: [] as SongData[],
  listLoading: false,
})

const { activeTab, trendingWindow, activeType } = toRefs(state)

const officialOptions = computed(() => state.officialLists.map(item => ({ key: item.id, label: item.name })))

let trendingRequestGeneration = 0

const loadTrendingSongs = async () => {
  const generation = ++trendingRequestGeneration
  state.trendingLoading = true
  try {
    let tracks: SongData[] = []
    try {
      const res = await fetchRecommendTrending(
        {
          window: state.trendingWindow,
          count: 50,
          personalized: recommendStore.personalizationEnabled,
        },
        recommendStore.buildRequestHeaders(true)
      )
      tracks = res.tracks
    } catch (err) {
      if (generation !== trendingRequestGeneration) return
      console.warn('[Charts] loadTrendingSongs failed, applying fallback:', err)
    }
    if (generation !== trendingRequestGeneration) return
    if (!tracks.length) {
      const fallback = await topSong({ type: 0 })
      tracks = transformTopSongs(fallback as Record<string, unknown>, 50)
    }
    if (generation === trendingRequestGeneration) state.trendingSongs = tracks
  } catch (err) {
    if (generation !== trendingRequestGeneration) return
    console.error('[Charts] fallback failed:', err)
    state.trendingSongs = []
  } finally {
    if (generation === trendingRequestGeneration) state.trendingLoading = false
  }
}

let newSongRequestGeneration = 0

const loadNewSongs = async () => {
  const generation = ++newSongRequestGeneration
  state.newSongLoading = true
  try {
    const res = await topSong({ type: activeType.value })
    if (generation !== newSongRequestGeneration) return
    state.songs = transformTopSongs(res as Record<string, unknown>)
  } catch (err) {
    if (generation !== newSongRequestGeneration) return
    console.error('[Charts] loadNewSongs failed:', err)
    state.songs = []
  } finally {
    if (generation === newSongRequestGeneration) state.newSongLoading = false
  }
}

let listRequestGeneration = 0

const selectList = async (item: any, force = false) => {
  if (!item?.id) return
  if (!force && state.selectedList?.id === item.id && state.listSongs.length > 0) return

  const generation = ++listRequestGeneration
  state.selectedList = item
  state.listLoading = true
  try {
    const numericId = Number(item.id) || item.id
    const [tracksRes, detailRes] = await Promise.allSettled([
      playlistTrackAll({ id: numericId, limit: 100 }),
      playlistDetail({ id: Number(numericId) }),
    ])
    if (generation !== listRequestGeneration) return

    let songs: SongData[] = []
    if (tracksRes.status === 'fulfilled' && tracksRes.value) {
      songs = transformSongs(tracksRes.value as Record<string, unknown>, 100)
    }
    if ((!songs || songs.length === 0) && detailRes.status === 'fulfilled' && detailRes.value) {
      songs = transformSongs(detailRes.value as Record<string, unknown>, 100)
    }

    state.listSongs = songs
  } catch (err) {
    if (generation !== listRequestGeneration) return
    console.error('[Charts] selectList failed:', err)
    state.listSongs = []
  } finally {
    if (generation === listRequestGeneration) state.listLoading = false
  }
}

const selectOfficialChart = (id: string | number) => {
  void selectList(state.officialLists.find(item => item.id === id))
}

const loadOfficialLists = async () => {
  try {
    state.officialListLoading = true
    const res: any = await toplist()
    const list: any[] = res?.list || res?.data?.list || []
    state.officialLists = list.map((it: any) => ({
      id: it?.id,
      name: it?.name,
      cover: it?.coverImgUrl || '',
      updateFrequency: it?.updateFrequency || '',
      trackCount: it?.trackCount || 0,
      playCount: it?.playCount || 0,
      description: it?.description || '',
    }))
    if (state.officialLists.length) {
      const target = state.selectedList
        ? state.officialLists.find((it) => it.id === state.selectedList.id) || state.officialLists[0]
        : state.officialLists[0]
      await selectList(target, !state.listSongs.length)
    }
  } catch (err) {
    console.error('[Charts] loadOfficialLists failed:', err)
  } finally {
    state.officialListLoading = false
  }
}

const currentSongs = computed(() => {
  if (state.activeTab === 'trending') return state.trendingSongs
  if (state.activeTab === 'newSong') return state.songs
  return state.listSongs
})

const currentLoading = computed(() => {
  if (state.activeTab === 'trending') return state.trendingLoading
  if (state.activeTab === 'newSong') return state.newSongLoading
  return state.listLoading || (state.officialListLoading && !state.listSongs.length)
})

const headerTitle = computed(() => {
  if (state.activeTab === 'trending') {
    const cur = trendingWindows.value.find(option => option.key === state.trendingWindow)
    return `${t('charts.trending')} · ${cur?.label ?? ''}`
  }
  if (state.activeTab === 'newSong') {
    const cur = newSongRegions.value.find(option => option.key === state.activeType)
    return `${t('charts.newSongs')} · ${cur?.label ?? ''}`
  }
  return state.selectedList?.name || t('charts.official')
})

const currentSubtitle = computed(() => {
  if (state.activeTab === 'trending') return '实时更新'
  if (state.activeTab === 'newSong') return '每日更新'
  return state.selectedList?.updateFrequency || '定期更新'
})

const loadCurrentTab = async () => {
  if (state.activeTab === 'trending') {
    if (!state.trendingSongs.length) await loadTrendingSongs()
  } else if (state.activeTab === 'newSong') {
    if (!state.songs.length) await loadNewSongs()
  } else if (state.activeTab === 'official') {
    if (!state.officialLists.length) {
      await loadOfficialLists()
    } else if (!state.listSongs.length && state.selectedList) {
      await selectList(state.selectedList)
    }
  }
}

watch(trendingWindow, () => {
  if (state.activeTab === 'trending') loadTrendingSongs()
})

watch(activeType, () => {
  if (state.activeTab === 'newSong') loadNewSongs()
})

watch(activeTab, () => {
  loadCurrentTab()
})

onMounted(() => {
  loadCurrentTab()
  if (state.activeTab !== 'official' && !state.officialLists.length) {
    loadOfficialLists()
  }
})
</script>

<template>
  <div class="charts-page flex h-full flex-1 flex-col overflow-hidden">
    <!-- ═══════════════════════════════════════════════════════════ -->
    <!-- 顶部控制面板（高度完全锁定，单层 glass-card，无冗余说明）      -->
    <!-- ═══════════════════════════════════════════════════════════ -->
    <div class="glass-card mx-1 sm:mx-2 mt-1 mb-3 shrink-0 p-3 sm:p-4 transition-all">
      <!-- 第一栏（上栏）：板块标题、当前榜单标签、更新状态与曲目总数 -->
      <div class="flex items-center justify-between gap-3 pb-2.5 border-b border-glass-subtle">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30">
            <span class="icon-[mdi--chart-line] h-5 w-5" />
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="text-primary shrink-0 text-base sm:text-lg font-bold tracking-tight">
                {{ t('routes.charts') }}
              </h1>
              <span class="rounded bg-sky-500/15 border border-sky-500/30 px-2 py-0.5 text-[11px] min-w-0 font-medium wrap-anywhere text-[color:var(--glass-accent-text)]">
                {{ headerTitle }}
              </span>
            </div>
            <!-- 排行榜下方的更新频率与曲目数徽章（极简克制，只展示结果） -->
            <div class="flex items-center gap-2 mt-0.5">
              <span class="text-primary/40 text-[11px]">
                {{ currentSubtitle }}
              </span>
              <span class="text-primary/20 text-[10px] shrink-0">·</span>
              <span class="text-primary/50 text-[11px] px-2 py-0.5 rounded-full bg-button-glass border border-glass-subtle shrink-0 font-medium">
                {{ currentSongs.length }} {{ t('charts.songs') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="grid gap-2 pt-2.5">
        <FilterRow v-model="activeTab" :label="t('charts.categoryLabel')" :options="categories" />

        <!-- Reserve the same space for each chart category, including the scrollable official list. -->
        <div class="h-26">
          <FilterRow
            v-if="activeTab === 'trending'"
            v-model="trendingWindow"
            :label="t('charts.trendingLabel')"
            :options="trendingWindows"
          />
          <FilterRow
            v-else-if="activeTab === 'newSong'"
            v-model="activeType"
            :label="t('charts.newSongLabel')"
            :options="newSongRegions"
          />
          <FilterRow
            v-else
            :model-value="state.selectedList?.id"
            :label="t('charts.officialLabel')"
            :options="officialOptions"
            scroll="vertical"
            options-class="official-filter-scroll"
            @update:model-value="selectOfficialChart"
          />
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════ -->
    <!-- 主展示区（下栏内容区）：严格同步“歌手”页面，并配置清晰可见的滚动滑块 -->
    <!-- ═══════════════════════════════════════════════════════════ -->
    <div class="charts-content-container flex-1 min-h-0 px-1 sm:px-2 pb-2 overflow-hidden">
      <SongList :songs="currentSongs" :loading="currentLoading" :show-header="true" :show-controls="true" :flat="true" />
    </div>
  </div>
</template>

<style scoped>
/* ── 深度强化歌曲列表的垂直滚动条滑块（清晰可见、精致毛玻璃触感、支持拖拽） ── */
.charts-content-container :deep(.song-list-scroll) {
  scrollbar-width: thin !important;
  scrollbar-color: rgba(56, 189, 248, 0.45) transparent !important;
  -ms-overflow-style: auto !important;
}

.charts-content-container :deep(.song-list-scroll::-webkit-scrollbar) {
  display: block !important;
  width: 6px !important;
}

.charts-content-container :deep(.song-list-scroll::-webkit-scrollbar-track) {
  display: block !important;
  background: transparent !important;
}

.charts-content-container :deep(.song-list-scroll::-webkit-scrollbar-thumb) {
  display: block !important;
  background-color: rgba(56, 189, 248, 0.4) !important;
  border-radius: 9999px !important;
  border: 1px solid rgba(56, 189, 248, 0.25) !important;
  background-clip: padding-box !important;
  transition: background-color 0.2s ease;
}

.charts-content-container :deep(.song-list-scroll::-webkit-scrollbar-thumb:hover) {
  background-color: rgba(56, 189, 248, 0.8) !important;
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SongList from '@/components/SongList.vue'
import ChartResultNotice from '@/components/Ui/ChartResultNotice.vue'
import FilterRow from '@/components/Ui/FilterRow.vue'
import { useChartFilters } from '@/composables/useChartFilters'
import { useCharts } from '@/composables/useCharts'

const { t } = useI18n()
const { categories, trendingWindows, newSongRegions } = useChartFilters()
const {
  activeTab,
  trendingWindow,
  activeType,
  officialOptions,
  selectedList,
  selectOfficialChart,
  result,
  loadCurrent,
} = useCharts({ trendingCount: 50, showTrendingFallback: true })

const headerTitle = computed(() => {
  if (result.value.status === 'fallback') return t('charts.newSongs')
  if (activeTab.value === 'trending') {
    const window = trendingWindows.value.find(option => option.key === trendingWindow.value)
    return `${t('charts.trending')} · ${window?.label ?? ''}`
  }
  if (activeTab.value === 'newSong') {
    const region = newSongRegions.value.find(option => option.key === activeType.value)
    return `${t('charts.newSongs')} · ${region?.label ?? ''}`
  }
  return selectedList.value?.name || t('charts.official')
})

const currentSubtitle = computed(() => {
  if (result.value.status === 'fallback' || activeTab.value === 'newSong') {
    return t('charts.updateFrequency.daily')
  }
  if (activeTab.value === 'trending') return t('charts.updateFrequency.realtime')
  return selectedList.value?.updateFrequency || t('charts.updateFrequency.periodic')
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
            <div
              class="flex items-center gap-2 mt-0.5"
              :class="{ invisible: result.status === 'loading' || result.status === 'error' }"
            >
              <span class="text-primary/40 text-[11px]">
                {{ currentSubtitle }}
              </span>
              <span class="text-primary/20 text-[10px] shrink-0">·</span>
              <span class="text-primary/50 text-[11px] px-2 py-0.5 rounded-full bg-button-glass border border-glass-subtle shrink-0 font-medium">
                {{ result.songs.length }} {{ t('charts.songs') }}
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
            :model-value="selectedList?.id"
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
    <div class="charts-content-container flex flex-1 min-h-0 flex-col px-1 sm:px-2 pb-2 overflow-hidden">
      <ChartResultNotice :status="result.status" :empty="!result.songs.length" @retry="loadCurrent" />
      <div v-if="result.status === 'loading' || result.songs.length" class="flex-1 min-h-0">
        <SongList
          :songs="result.songs"
          :loading="result.status === 'loading'"
          :show-header="true"
          :show-controls="true"
          :flat="true"
        />
      </div>
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

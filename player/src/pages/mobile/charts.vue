<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
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
} = useCharts({ trendingCount: 40 })
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <div class="glass-nav sticky top-0 z-10 grid gap-2 px-2 pt-2 pb-3 backdrop-blur-md">
      <FilterRow
        v-model="activeTab"
        :label="t('charts.categoryLabel')"
        :options="categories"
      />

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
          options-class="official-chart-filter"
          @update:model-value="selectOfficialChart"
        />
      </div>
    </div>

    <ChartResultNotice :status="result.status" :empty="!result.songs.length" @retry="loadCurrent" />
    <div v-if="result.status === 'loading'" class="py-6" aria-hidden="true">
      <PageSkeleton :sections="['list']" :list-count="10" />
    </div>
    <MobileSongList v-else-if="result.songs.length" :songs="result.songs" :show-index="true" />
  </div>
</template>

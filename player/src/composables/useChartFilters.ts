import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export type ChartCategory = 'trending' | 'newSong' | 'official'
export type ChartWindow = '7d' | '24h' | 'surging' | 'new'
export type ChartRegion = 0 | 7 | 96 | 8 | 16

export function useChartFilters() {
  const { t } = useI18n()

  const categories = computed(() => [
    { key: 'trending', label: t('charts.trending'), icon: 'icon-[mdi--chart-line-variant]' },
    { key: 'newSong', label: t('charts.newSongs'), icon: 'icon-[mdi--music-note-plus]' },
    { key: 'official', label: t('charts.official'), icon: 'icon-[mdi--trophy]' },
  ] as const)

  const trendingWindows = computed(() => [
    { key: '7d', label: t('recommend.windows.7d'), icon: 'icon-[mdi--chart-timeline-variant]' },
    { key: '24h', label: t('recommend.windows.24h'), icon: 'icon-[mdi--fire]' },
    { key: 'surging', label: t('recommend.windows.surging'), icon: 'icon-[mdi--rocket-launch-outline]' },
    { key: 'new', label: t('recommend.windows.new'), icon: 'icon-[mdi--sparkles]' },
  ] as const)

  const newSongRegions = computed(() => [
    { key: 0, label: t('charts.types.all'), icon: 'icon-[mdi--fire]' },
    { key: 7, label: t('charts.types.mandarin'), icon: 'icon-[mdi--music-note]' },
    { key: 96, label: t('charts.types.west'), icon: 'icon-[mdi--earth]' },
    { key: 8, label: t('charts.types.japan'), icon: 'icon-[mdi--flower-tulip]' },
    { key: 16, label: t('charts.types.korea'), icon: 'icon-[mdi--star-four-points]' },
  ] as const)

  return { categories, trendingWindows, newSongRegions }
}

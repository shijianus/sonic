import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { playlistDetail, playlistTrackAll, topSong, toplist } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { useRecommendStore } from '@/stores/modules/recommend'
import { extractData, transformSongs, transformTopSongs, type SongData } from '@/utils/transformers'
import type { ChartCategory, ChartRegion, ChartWindow } from './useChartFilters'

interface OfficialChart {
  id: number | string
  name: string
  updateFrequency?: string
}

type ChartResult = {
  status: 'loading' | 'success' | 'error' | 'fallback'
  songs: SongData[]
}

async function fetchNewSongs(type: ChartRegion, limit?: number) {
  return transformTopSongs(await topSong({ type }) as Record<string, unknown>, limit)
}

async function fetchOfficialSongs(id: OfficialChart['id']) {
  const numericId = Number(id)
  const [tracks, detail] = await Promise.allSettled([
    playlistTrackAll({ id, limit: 100 }),
    Number.isFinite(numericId) ? playlistDetail({ id: numericId }) : Promise.resolve(null),
  ])
  const trackSongs = tracks.status === 'fulfilled' && tracks.value
    ? transformSongs(tracks.value as Record<string, unknown>, 100)
    : undefined
  if (trackSongs?.length) return trackSongs
  if (detail.status === 'fulfilled' && detail.value) {
    return transformSongs(detail.value as Record<string, unknown>, 100)
  }
  if (trackSongs) return trackSongs
  throw new Error('Official chart tracks unavailable')
}

export function useCharts({ trendingCount, showTrendingFallback = false }: {
  trendingCount: number
  showTrendingFallback?: boolean
}) {
  const recommendStore = useRecommendStore()
  const activeTab = ref<ChartCategory>('trending')
  const trendingWindow = ref<ChartWindow>('7d')
  const activeType = ref<ChartRegion>(0)
  const officialLists = shallowRef<OfficialChart[]>([])
  const selectedOfficialId = ref<OfficialChart['id']>()
  const result = shallowRef<ChartResult>({ status: 'loading', songs: [] })

  const selectedList = computed(() =>
    officialLists.value.find(chart => chart.id === selectedOfficialId.value) ?? officialLists.value[0]
  )
  const officialOptions = computed(() =>
    officialLists.value.map(chart => ({ key: chart.id, label: chart.name }))
  )
  const activeFilter = computed(() => {
    if (activeTab.value === 'trending') return trendingWindow.value
    if (activeTab.value === 'newSong') return activeType.value
    return selectedOfficialId.value
  })

  let generation = 0
  const loadCurrent = async () => {
    const requestGeneration = ++generation
    const isCurrent = () => requestGeneration === generation
    result.value = { status: 'loading', songs: [] }

    try {
      let songs: SongData[]
      if (activeTab.value === 'trending') {
        try {
          const response = await fetchRecommendTrending(
            {
              window: trendingWindow.value,
              count: trendingCount,
              personalized: recommendStore.personalizationEnabled,
            },
            recommendStore.buildRequestHeaders(true)
          )
          songs = response.tracks
        } catch (error) {
          if (!isCurrent()) return
          if (!showTrendingFallback) throw error
          const fallback = await fetchNewSongs(0, trendingCount)
          if (!fallback.length) throw error
          if (isCurrent()) result.value = { status: 'fallback', songs: fallback }
          return
        }
      } else if (activeTab.value === 'newSong') {
        songs = await fetchNewSongs(activeType.value)
      } else {
        if (!officialLists.value.length) {
          const response = await toplist()
          if (!isCurrent()) return
          const charts = extractData<OfficialChart[]>(response as Record<string, unknown>, 'list', 'data.list')
          if (!Array.isArray(charts)) throw new Error('Invalid official chart list')
          officialLists.value = charts.filter(chart => chart?.id && typeof chart.name === 'string')
        }
        const chart = selectedList.value
        songs = chart ? await fetchOfficialSongs(chart.id) : []
      }
      if (isCurrent()) result.value = { status: 'success', songs }
    } catch {
      if (isCurrent()) result.value = { status: 'error', songs: [] }
    }
  }

  const selectOfficialChart = (id: OfficialChart['id']) => {
    if (id !== selectedList.value?.id && officialLists.value.some(chart => chart.id === id)) {
      selectedOfficialId.value = id
    }
  }

  watch([activeTab, activeFilter], loadCurrent, { immediate: true })
  onScopeDispose(() => { generation += 1 })

  return { activeTab, trendingWindow, activeType, officialOptions, selectedList, selectOfficialChart, result, loadCurrent }
}

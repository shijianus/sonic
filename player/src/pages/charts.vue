<script setup lang="ts">
import { reactive, toRefs, computed, watch, onMounted } from 'vue'
import SongList from '@/components/SongList.vue'
import { topSong, toplist, playlistTrackAll, playlistDetail } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'

const { t } = useI18n()
const recommendStore = useRecommendStore()

type MainTabKey = 'trending' | 'newSong' | 'official'
type TrendingWindowKey = '7d' | '24h' | 'surging' | 'new'

const state = reactive({
  activeTab: 'trending' as MainTabKey,
  trendingWindow: '7d' as TrendingWindowKey,
  trendingSongs: [] as SongData[],
  trendingLoading: false,
  activeType: 0 as 0 | 7 | 96 | 8 | 16,
  songs: [] as SongData[],
  newSongLoading: false,
  officialLists: [] as any[],
  officialListLoading: false,
  selectedList: null as any,
  listSongs: [] as SongData[],
  listLoading: false,
})

const { activeTab, trendingWindow, activeType } = toRefs(state)

const displayedOfficialLists = computed(() => {
  return state.officialLists.slice(0, 20)
})

const mainTabs = computed(() => [
  { key: 'trending' as const, labelKey: 'charts.trending', icon: 'icon-[mdi--chart-line-variant]' },
  { key: 'newSong' as const, labelKey: 'charts.newSongs', icon: 'icon-[mdi--music-note-plus]' },
  { key: 'official' as const, labelKey: 'charts.official', icon: 'icon-[mdi--trophy]' },
])

const trendingWindows = [
  { key: '7d', labelKey: 'recommend.windows.7d', icon: 'icon-[mdi--chart-timeline-variant]' },
  { key: '24h', labelKey: 'recommend.windows.24h', icon: 'icon-[mdi--fire]' },
  { key: 'surging', labelKey: 'recommend.windows.surging', icon: 'icon-[mdi--rocket-launch-outline]' },
  { key: 'new', labelKey: 'recommend.windows.new', icon: 'icon-[mdi--sparkles]' },
]

const newSongTypes = [
  { key: 0, labelKey: 'charts.types.all', icon: 'icon-[mdi--fire]' },
  { key: 7, labelKey: 'charts.types.mandarin', icon: 'icon-[mdi--music-note]' },
  { key: 96, labelKey: 'charts.types.west', icon: 'icon-[mdi--earth]' },
  { key: 8, labelKey: 'charts.types.japan', icon: 'icon-[mdi--flower-tulip]' },
  { key: 16, labelKey: 'charts.types.korea', icon: 'icon-[mdi--star-four-points]' },
]

const loadTrendingSongs = async () => {
  try {
    state.trendingLoading = true
    const res = await fetchRecommendTrending(
      {
        window: state.trendingWindow,
        count: 50,
        personalized: recommendStore.personalizationEnabled,
      },
      recommendStore.buildRequestHeaders(true)
    )
    if (res.tracks && res.tracks.length > 0) {
      state.trendingSongs = res.tracks
    } else {
      const fallback = await topSong({ type: 0 })
      state.trendingSongs = transformTopSongs(fallback as Record<string, unknown>, 50)
    }
  } catch (err) {
    console.warn('[Charts] loadTrendingSongs failed, applying fallback:', err)
    try {
      const fallback = await topSong({ type: 0 })
      state.trendingSongs = transformTopSongs(fallback as Record<string, unknown>, 50)
    } catch (e) {
      console.error('[Charts] fallback failed:', e)
    }
  } finally {
    state.trendingLoading = false
  }
}

const loadNewSongs = async () => {
  try {
    state.newSongLoading = true
    const res = await topSong({ type: activeType.value })
    state.songs = transformTopSongs(res as Record<string, unknown>)
  } catch (err) {
    console.error('[Charts] loadNewSongs failed:', err)
  } finally {
    state.newSongLoading = false
  }
}

const selectList = async (item: any, force = false) => {
  if (!item?.id) return
  if (!force && state.selectedList?.id === item.id && state.listSongs.length > 0) return

  state.selectedList = item
  state.listLoading = true
  try {
    const numericId = Number(item.id) || item.id
    const [tracksRes, detailRes] = await Promise.allSettled([
      playlistTrackAll({ id: numericId, limit: 100 }),
      playlistDetail({ id: Number(numericId) }),
    ])

    let songs: SongData[] = []
    if (tracksRes.status === 'fulfilled' && tracksRes.value) {
      songs = transformSongs(tracksRes.value as Record<string, unknown>, 100)
    }
    if ((!songs || songs.length === 0) && detailRes.status === 'fulfilled' && detailRes.value) {
      songs = transformSongs(detailRes.value as Record<string, unknown>, 100)
    }

    state.listSongs = songs
  } catch (err) {
    console.error('[Charts] selectList failed:', err)
    state.listSongs = []
  } finally {
    state.listLoading = false
  }
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
    const cur = trendingWindows.find((w) => w.key === state.trendingWindow)
    return `${t('charts.trending')} · ${cur ? t(cur.labelKey) : ''}`
  }
  if (state.activeTab === 'newSong') {
    const cur = newSongTypes.find((tp) => tp.key === state.activeType)
    return `${t('charts.newSongs')} · ${cur ? t(cur.labelKey) : ''}`
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
              <h1 class="text-primary text-base sm:text-lg font-bold tracking-tight">
                {{ t('routes.charts') }}
              </h1>
              <span class="rounded bg-sky-500/15 border border-sky-500/30 px-2 py-0.5 text-[10px] sm:text-[11px] font-medium text-sky-400 whitespace-nowrap">
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

      <!-- 第二栏（下栏）：分类维度筛选（严格保持与歌手页完全一致的结构规范） -->
      <div class="pt-2.5 h-[96px] flex flex-col justify-between">
        <!-- 维度行 1：主分类切换（趋势榜 / 新歌速递 / 官方榜单） -->
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
            {{ t('layout.aside.menu.charts') }}:
          </span>
          <div class="flex items-center gap-1 flex-wrap">
            <button
              v-for="tab in mainTabs"
              :key="tab.key"
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap"
              :class="
                activeTab === tab.key
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                  : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
              "
              @click="state.activeTab = tab.key"
            >
              <span :class="[tab.icon, 'h-3.5 w-3.5']" />
              <span>{{ t(tab.labelKey) }}</span>
            </button>
          </div>
        </div>

        <!-- 维度行 2：子选项区域（高度固定 58px，以官方榜单两行为准，结构与视觉彻底同步） -->
        <div class="h-[58px] flex flex-col justify-center">
          <!-- 模式 A：趋势榜时间范围选项 -->
          <div v-if="activeTab === 'trending'" class="flex items-center gap-2 flex-wrap">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
              {{ t('recommend.tabs.trending') }}:
            </span>
            <div class="flex items-center gap-1 flex-wrap">
              <button
                v-for="win in trendingWindows"
                :key="win.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1 shrink-0 whitespace-nowrap"
                :class="
                  trendingWindow === win.key
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                    : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
                "
                @click="trendingWindow = win.key as any"
              >
                <span :class="[win.icon, 'h-3.5 w-3.5']" />
                <span>{{ t(win.labelKey) }}</span>
              </button>
            </div>
          </div>

          <!-- 模式 B：新歌榜地区选项 -->
          <div v-else-if="activeTab === 'newSong'" class="flex items-center gap-2 flex-wrap">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14">
              {{ t('artists.area') }}:
            </span>
            <div class="flex items-center gap-1 flex-wrap">
              <button
                v-for="type in newSongTypes"
                :key="type.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1 shrink-0 whitespace-nowrap"
                :class="
                  activeType === type.key
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                    : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
                "
                @click="activeType = type.key as any"
              >
                <span :class="[type.icon, 'h-3.5 w-3.5']" />
                <span>{{ t(type.labelKey) }}</span>
              </button>
            </div>
          </div>

          <!-- 模式 C：官方榜单（结构完全同步，2 行紧凑排布，文字完整展示绝无省略截断） -->
          <div v-else class="flex items-start gap-2 flex-wrap">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-14 mt-1">
              {{ t('charts.official') }}:
            </span>
            <div class="flex items-center gap-1 flex-wrap flex-1 min-w-0 max-h-[58px] overflow-hidden content-start">
              <button
                v-for="item in displayedOfficialLists"
                :key="item.id"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1 shrink-0 whitespace-nowrap"
                :class="
                  state.selectedList?.id === item.id
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                    : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
                "
                @click="selectList(item)"
              >
                <span
                  v-if="state.selectedList?.id === item.id"
                  class="icon-[mdi--equalizer] h-3 w-3 text-sky-400 animate-pulse shrink-0"
                />
                <span class="whitespace-nowrap">{{ item.name }}</span>
              </button>
            </div>
          </div>
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

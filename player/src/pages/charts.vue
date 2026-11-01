<script setup lang="ts">
import { reactive, toRefs, computed, watch, onMounted } from 'vue'
import SongList from '@/components/SongList.vue'
import { topSong, toplist, playlistTrackAll } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { usePlayActions } from '@/composables/usePlayActions'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'
import Button from '@/components/Ui/Button.vue'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'

const { t } = useI18n()
const { playAll: playAllAction } = usePlayActions()
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
  isLoading: false,
  officialLists: [] as any[],
  selectedList: null as any,
  listSongs: [] as SongData[],
  listLoading: false,
})

const { activeTab, trendingWindow, activeType } = toRefs(state)

const displayedOfficialLists = computed(() => {
  return state.officialLists.slice(0, 22)
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
    state.trendingSongs = res.tracks
  } catch (err) {
    console.warn('[Charts] loadTrendingSongs failed:', err)
  } finally {
    state.trendingLoading = false
  }
}

const loadNewSongs = async () => {
  try {
    state.isLoading = true
    const res = await topSong({ type: activeType.value })
    state.songs = transformTopSongs(res as Record<string, unknown>)
  } finally {
    state.isLoading = false
  }
}

const loadOfficialLists = async () => {
  try {
    state.isLoading = true
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
    if (state.officialLists.length && !state.selectedList) {
      selectList(state.officialLists[0])
    }
  } finally {
    state.isLoading = false
  }
}

const selectList = async (item: any) => {
  if (state.selectedList?.id === item.id && state.listSongs.length > 0) return
  state.selectedList = item
  state.listLoading = true
  try {
    const res = await playlistTrackAll({ id: item.id, limit: 100 })
    state.listSongs = transformSongs(res as Record<string, unknown>, 100)
  } finally {
    state.listLoading = false
  }
}

const playAll = () => {
  const songs = currentSongs.value
  playAllAction(songs)
}

const currentSongs = computed(() => {
  if (state.activeTab === 'trending') return state.trendingSongs
  if (state.activeTab === 'newSong') return state.songs
  return state.listSongs
})

const currentLoading = computed(() => {
  if (state.activeTab === 'trending') return state.trendingLoading
  if (state.activeTab === 'newSong') return state.isLoading
  return state.listLoading
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
  if (state.activeTab === 'trending') return '基于全站实时收听热度与探索推荐模型精算'
  if (state.activeTab === 'newSong') return '全球最新发布的录音室优质单曲抢先速递'
  return state.selectedList?.updateFrequency || state.selectedList?.description || t('charts.official')
})

watch(trendingWindow, () => {
  if (state.activeTab === 'trending') loadTrendingSongs()
})

watch(activeType, () => {
  if (state.activeTab === 'newSong') loadNewSongs()
})

watch(activeTab, (val) => {
  if (val === 'trending' && !state.trendingSongs.length) {
    loadTrendingSongs()
  } else if (val === 'newSong' && !state.songs.length) {
    loadNewSongs()
  } else if (val === 'official' && !state.officialLists.length) {
    loadOfficialLists()
  }
})

onMounted(() => {
  loadTrendingSongs()
  loadNewSongs()
  loadOfficialLists()
})
</script>

<template>
  <div class="charts-page flex h-full flex-1 flex-col overflow-hidden">
    <!-- ═══════════════════════════════════════════════════════════ -->
    <!-- 顶部控制面板（尺寸紧凑，单层 glass-card 规整无嵌套）          -->
    <!-- ═══════════════════════════════════════════════════════════ -->
    <div class="glass-card mx-1 sm:mx-2 mt-1 mb-3 shrink-0 p-3 sm:p-4 transition-all">
      <!-- 第一栏（上栏）：板块标题、当前榜单高亮与「播放全部」主操作 -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-glass-subtle">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30">
            <span class="icon-[mdi--chart-line] h-5 w-5" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-primary text-base sm:text-lg font-bold tracking-tight">
                {{ t('routes.charts') }}
              </h1>
              <span class="rounded bg-sky-500/15 border border-sky-500/30 px-2 py-0.5 text-[10px] sm:text-[11px] font-medium text-sky-400">
                {{ headerTitle }}
              </span>
            </div>
            <p class="text-primary/40 text-[11px] hidden sm:block mt-0.5">
              {{ currentSubtitle }}
            </p>
          </div>
        </div>

        <!-- 右侧：曲目数指标 + 「播放全部」按钮 -->
        <div class="flex items-center gap-2 w-full md:w-auto justify-between md:justify-end">
          <span class="text-primary/50 text-xs px-2.5 py-1 rounded-full bg-button-glass border border-glass-subtle">
            {{ currentSongs.length }} {{ t('charts.songs') }}
          </span>

          <Button
            v-if="currentSongs.length > 0"
            variant="solid"
            size="sm"
            rounded="xl"
            class="gap-1.5 shadow-md shadow-sky-500/20 px-3.5 py-1.5 text-xs"
            @click="playAll"
          >
            <span class="icon-[mdi--play] h-4 w-4" />
            <span>{{ t('actions.playAll') }}</span>
          </Button>
        </div>
      </div>

      <!-- 第二栏（下栏）：分类维度筛选（向后自然扩展，不强制向下缩进） -->
      <div class="pt-3">
        <!-- 模式 A：趋势榜 或 新歌榜（分类与次级选项在单行向后扩展） -->
        <div v-if="activeTab !== 'official'" class="flex flex-wrap items-center gap-2">
          <!-- 榜单分类 -->
          <div class="flex items-center gap-1.5">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0">
              {{ t('layout.aside.menu.charts') }}:
            </span>
            <div class="flex items-center gap-1">
              <button
                v-for="tab in mainTabs"
                :key="tab.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1.5"
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

          <!-- 分隔线 -->
          <div class="h-4 w-px bg-glass-subtle shrink-0 mx-1 hidden sm:block" />

          <!-- 趋势榜时间窗选项（直接向后延展） -->
          <div v-if="activeTab === 'trending'" class="flex items-center gap-1.5 flex-wrap">
            <span class="text-primary/50 text-xs font-medium shrink-0">
              {{ t('recommend.tabs.trending') }}:
            </span>
            <div class="flex items-center gap-1 flex-wrap">
              <button
                v-for="win in trendingWindows"
                :key="win.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1"
                :class="
                  trendingWindow === win.key
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-semibold shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                    : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
                "
                @click="trendingWindow = win.key as any"
              >
                <span :class="[win.icon, 'h-3.5 w-3.5']" />
                <span>{{ t(win.labelKey) }}</span>
              </button>
            </div>
          </div>

          <!-- 新歌榜地区选项（直接向后延展） -->
          <div v-else-if="activeTab === 'newSong'" class="flex items-center gap-1.5 flex-wrap">
            <span class="text-primary/50 text-xs font-medium shrink-0">
              {{ t('artists.area') }}:
            </span>
            <div class="flex items-center gap-1 flex-wrap">
              <button
                v-for="type in newSongTypes"
                :key="type.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1"
                :class="
                  activeType === type.key
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30 font-semibold shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                    : 'text-primary/60 hover:bg-hover-glass hover:text-primary'
                "
                @click="activeType = type.key as any"
              >
                <span :class="[type.icon, 'h-3.5 w-3.5']" />
                <span>{{ t(type.labelKey) }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 模式 B：官方榜单（无水平滑块，上下两行结构化清晰排布） -->
        <div v-else class="space-y-2">
          <!-- 上行：主分类切换 -->
          <div class="flex items-center gap-2">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0">
              {{ t('layout.aside.menu.charts') }}:
            </span>
            <div class="flex items-center gap-1">
              <button
                v-for="tab in mainTabs"
                :key="tab.key"
                type="button"
                class="rounded-lg px-2.5 py-1 text-xs transition-all cursor-pointer flex items-center gap-1.5"
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
            <span class="text-primary/35 text-[11px] ml-2 hidden sm:inline">
              权威官方榜单速递
            </span>
          </div>

          <!-- 官方榜单专属：2行排版，上下格式（上名称、下浅细更新周期），禁止横向滑块 -->
          <div class="flex items-start gap-2 pt-0.5">
            <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 mt-1">
              {{ t('charts.official') }}:
            </span>

            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap gap-1.5 max-h-[76px] overflow-hidden">
                <button
                  v-for="item in displayedOfficialLists"
                  :key="item.id"
                  type="button"
                  class="group flex flex-col items-center justify-center px-2 py-1 rounded-lg transition-all cursor-pointer text-center shrink-0 border h-[34px] min-w-[70px] max-w-[94px]"
                  :class="
                    state.selectedList?.id === item.id
                      ? 'bg-sky-500/20 text-sky-400 border-sky-500/30 font-medium shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                      : 'text-primary/70 hover:bg-hover-glass hover:text-primary border-glass-subtle bg-button-glass'
                  "
                  @click="selectList(item)"
                >
                  <div class="flex items-center gap-1 max-w-full">
                    <span
                      v-if="state.selectedList?.id === item.id"
                      class="icon-[mdi--equalizer] h-3 w-3 text-sky-400 animate-pulse shrink-0"
                    />
                    <span class="text-[11px] font-medium leading-none truncate">{{ item.name }}</span>
                  </div>
                  <span
                    v-if="item.updateFrequency"
                    class="text-[9px] text-primary/40 font-normal leading-none mt-0.5 truncate max-w-full"
                  >
                    {{ item.updateFrequency }}
                  </span>
                </button>
              </div>
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

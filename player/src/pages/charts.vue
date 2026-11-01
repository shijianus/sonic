<script setup lang="ts">
import { reactive, toRefs, computed, watch, onMounted, ref } from 'vue'
import SongList from '@/components/SongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
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
const officialScrollRef = ref<HTMLElement | null>(null)

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
  if (state.activeTab === 'newSong') return '全球最新发布的录音室曲目抢先速递'
  return state.selectedList?.updateFrequency || state.selectedList?.description || t('charts.official')
})

const handleOfficialWheel = (e: WheelEvent) => {
  if (!officialScrollRef.value) return
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
    officialScrollRef.value.scrollLeft += e.deltaY * 0.8
  }
}

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
  <div class="flex h-full flex-1 flex-col overflow-hidden">
    <!-- ═══════════════════════════════════════════════════════════ -->
    <!-- 顶部控制与筛选区（严格同步“歌手”页面：单一 glass-card，无嵌套框） -->
    <!-- ═══════════════════════════════════════════════════════════ -->
    <div class="glass-card mx-1 sm:mx-2 mt-1 mb-3 shrink-0 p-3 sm:p-4 transition-all">
      <!-- 第一栏（上栏）：板块标题、榜单图标、状态与「播放全部」操作 -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-glass-subtle">
        <div class="flex items-center gap-2.5">
          <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
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

        <!-- 右侧：曲目数指标 + 「播放全部」主操作按钮 -->
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

      <!-- 第二栏（下栏）：分类维度筛选与小滑块栏 -->
      <div class="pt-3 space-y-2.5">
        <!-- 维度 1：榜单主分类 -->
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-16">
            {{ t('layout.aside.menu.charts') }}:
          </span>
          <div class="flex flex-wrap gap-1">
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

        <!-- 维度 2：次级选项与小滑块 (与歌手页面的首字母/地区小滑块轨完全同步) -->
        <!-- 趋势榜时间窗小滑块 -->
        <div v-if="activeTab === 'trending'" class="flex items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-16">
            {{ t('recommend.tabs.trending') }}:
          </span>
          <div class="flex flex-1 items-center gap-1 overflow-x-auto py-0.5 no-scrollbar">
            <button
              v-for="win in trendingWindows"
              :key="win.key"
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs transition-all shrink-0 cursor-pointer flex items-center gap-1.5"
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

        <!-- 新歌榜地区小滑块 -->
        <div v-else-if="activeTab === 'newSong'" class="flex items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-16">
            {{ t('artists.area') }}:
          </span>
          <div class="flex flex-1 items-center gap-1 overflow-x-auto py-0.5 no-scrollbar">
            <button
              v-for="type in newSongTypes"
              :key="type.key"
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs transition-all shrink-0 cursor-pointer flex items-center gap-1.5"
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

        <!-- 官方权威精选榜单（30+）专属小滑块轨 -->
        <div v-else class="flex items-center gap-2">
          <span class="text-primary/60 text-xs sm:text-sm font-medium shrink-0 w-16">
            {{ t('charts.official') }}:
          </span>
          <div
            ref="officialScrollRef"
            class="flex flex-1 items-center gap-1.5 overflow-x-auto py-0.5 no-scrollbar scroll-smooth"
            @wheel.passive="handleOfficialWheel"
          >
            <button
              v-for="item in state.officialLists"
              :key="item.id"
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs transition-all shrink-0 cursor-pointer flex items-center gap-1.5 border"
              :class="
                state.selectedList?.id === item.id
                  ? 'bg-sky-500/20 text-sky-400 border-sky-500/30 font-semibold shadow-[0_0_8px_rgba(56,189,248,0.15)]'
                  : 'text-primary/60 hover:bg-hover-glass hover:text-primary border-transparent'
              "
              @click="selectList(item)"
            >
              <span
                v-if="state.selectedList?.id === item.id"
                class="icon-[mdi--equalizer] h-3.5 w-3.5 text-sky-400 animate-pulse"
              />
              <span v-else class="icon-[mdi--trophy-outline] h-3.5 w-3.5 opacity-60" />
              <span>{{ item.name }}</span>
              <span v-if="item.updateFrequency" class="text-[10px] opacity-50 ml-0.5">
                ({{ item.updateFrequency }})
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════════════════ -->
    <!-- 主展示区（下栏内容区）：严格同步“歌手”页面，直接在画板内 overflow-auto，无嵌套方框 -->
    <!-- ═══════════════════════════════════════════════════════════ -->
    <div class="flex-1 overflow-auto px-1 sm:px-2 pb-6">
      <PageSkeleton v-if="currentLoading" :sections="['list']" :list-count="12" />
      <SongList v-else :songs="currentSongs" :show-header="true" :show-controls="true" />
    </div>
  </div>
</template>

<style scoped>
/* 隐藏横向滚动条，保留滑动与手势支持 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>

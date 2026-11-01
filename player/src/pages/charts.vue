<script setup lang="ts">
import { reactive, toRefs, computed, watch, onMounted, ref } from 'vue'
import SongList from '@/components/SongList.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { topSong, toplist, playlistTrackAll } from '@/api'
import { fetchRecommendTrending } from '@/api/recommend'
import { usePlayActions } from '@/composables/usePlayActions'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useI18n } from 'vue-i18n'
import LazyImage from '@/components/Ui/LazyImage.vue'
import TabGroup from '@/components/Ui/TabGroup.vue'
import Button from '@/components/Ui/Button.vue'
import { transformTopSongs, transformSongs, type SongData } from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'

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
  { key: 'trending', labelKey: 'charts.trending', icon: 'icon-[mdi--chart-line-variant]' },
  { key: 'newSong', labelKey: 'charts.newSongs', icon: 'icon-[mdi--music-note-plus]' },
  { key: 'official', labelKey: 'charts.official', icon: 'icon-[mdi--trophy]' },
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
  if (state.activeTab === 'trending') return '实时基于全站听歌热度与探索推荐模型精算'
  if (state.activeTab === 'newSong') return '全球最新发布的录音室曲目抢先速递'
  return state.selectedList?.updateFrequency || state.selectedList?.description || t('charts.official')
})

const currentCover = computed(() => {
  if (state.activeTab === 'official' && state.selectedList?.cover) {
    return state.selectedList.cover
  }
  if (currentSongs.value.length > 0 && currentSongs.value[0]?.cover) {
    return currentSongs.value[0].cover
  }
  return ''
})

const handleOfficialWheel = (e: WheelEvent) => {
  if (!officialScrollRef.value) return
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
    officialScrollRef.value.scrollLeft += e.deltaY * 0.8
  }
}

const scrollOfficial = (dir: 'left' | 'right') => {
  if (!officialScrollRef.value) return
  const offset = dir === 'left' ? -320 : 320
  officialScrollRef.value.scrollBy({ left: offset, behavior: 'smooth' })
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
  <div class="flex h-full flex-1 flex-col gap-3 sm:gap-4 overflow-hidden p-3 sm:p-5">
    <!-- ═══════════════════════════════════════════════════ -->
    <!-- 上栏：顶部控制枢纽与看板区 (Header & Dimension Hub)  -->
    <!-- ═══════════════════════════════════════════════════ -->
    <header class="glass-card shrink-0 flex flex-col gap-3 rounded-2xl sm:rounded-3xl p-3 sm:p-4 transition-all">
      <!-- 第一行：顶级 Tab 切换 + 行动操作栏 -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <!-- 主 Tab 分段控制器 -->
        <div class="flex items-center gap-3">
          <TabGroup
            v-model="state.activeTab"
            :tabs="mainTabs"
            variant="gradient"
            size="sm"
            :show-count="false"
          />

          <!-- 趋势榜：次级时间窗药丸组（大屏合流在一行展示） -->
          <div
            v-if="activeTab === 'trending'"
            class="hidden md:flex items-center gap-1.5 rounded-xl bg-button-glass p-1 border border-glass-subtle"
          >
            <button
              v-for="win in trendingWindows"
              :key="win.key"
              type="button"
              class="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg transition-all"
              :class="
                trendingWindow === win.key
                  ? 'bg-hover-glass text-sky-400 font-medium shadow-xs'
                  : 'text-primary/60 hover:text-primary hover:bg-hover-glass/40'
              "
              @click="trendingWindow = win.key as any"
            >
              <span :class="[win.icon, 'h-3.5 w-3.5']" />
              {{ t(win.labelKey) }}
            </button>
          </div>

          <!-- 新歌榜：地区筛选药丸组（大屏合流） -->
          <div
            v-else-if="activeTab === 'newSong'"
            class="hidden md:flex items-center gap-1.5 rounded-xl bg-button-glass p-1 border border-glass-subtle"
          >
            <button
              v-for="type in newSongTypes"
              :key="type.key"
              type="button"
              class="flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg transition-all"
              :class="
                activeType === type.key
                  ? 'bg-hover-glass text-sky-400 font-medium shadow-xs'
                  : 'text-primary/60 hover:text-primary hover:bg-hover-glass/40'
              "
              @click="activeType = type.key as any"
            >
              <span :class="[type.icon, 'h-3.5 w-3.5']" />
              {{ t(type.labelKey) }}
            </button>
          </div>
        </div>

        <!-- 右侧看板指标 & 播放全部 CTA -->
        <div class="flex items-center gap-3 ml-auto">
          <span class="hidden sm:inline-flex items-center rounded-full bg-button-glass px-3 py-1 text-xs font-medium text-primary/60 border border-glass-subtle">
            {{ currentSongs.length }} {{ t('charts.songs') }}
          </span>

          <Button
            v-if="currentSongs.length > 0"
            variant="solid"
            size="sm"
            rounded="xl"
            class="gap-2 shadow-md shadow-sky-500/20 px-4 py-2"
            @click="playAll"
          >
            <span class="icon-[mdi--play] h-4 w-4" />
            {{ t('actions.playAll') }}
          </Button>
        </div>
      </div>

      <!-- 中窄屏设备下的次级选项自适应折叠条 -->
      <div v-if="activeTab === 'trending'" class="flex md:hidden items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        <button
          v-for="win in trendingWindows"
          :key="win.key"
          type="button"
          class="flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-all"
          :class="
            trendingWindow === win.key
              ? 'bg-hover-glass text-sky-400 font-medium shadow-xs'
              : 'text-primary/60 hover:bg-hover-glass/40'
          "
          @click="trendingWindow = win.key as any"
        >
          <span :class="[win.icon, 'h-3.5 w-3.5']" />
          {{ t(win.labelKey) }}
        </button>
      </div>

      <div v-else-if="activeTab === 'newSong'" class="flex md:hidden items-center gap-1.5 overflow-x-auto no-scrollbar pb-1">
        <button
          v-for="type in newSongTypes"
          :key="type.key"
          type="button"
          class="flex shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg transition-all"
          :class="
            activeType === type.key
              ? 'bg-hover-glass text-sky-400 font-medium shadow-xs'
              : 'text-primary/60 hover:bg-hover-glass/40'
          "
          @click="activeType = type.key as any"
        >
          <span :class="[type.icon, 'h-3.5 w-3.5']" />
          {{ t(type.labelKey) }}
        </button>
      </div>

      <!-- 官方精选榜单专属：横向轻量平滑微卡片流 (Horizontal Billboard Snap Strip) -->
      <div v-if="activeTab === 'official'" class="relative flex items-center pt-1 border-t border-glass/40">
        <!-- 向左滑动按钮 -->
        <button
          type="button"
          class="hidden sm:flex absolute left-0 z-10 -ml-2 h-8 w-8 items-center justify-center rounded-full glass-card hover:bg-hover-glass shadow-md text-primary/80 transition-all cursor-pointer"
          title="向左滚动"
          @click="scrollOfficial('left')"
        >
          <span class="icon-[mdi--chevron-left] h-5 w-5" />
        </button>

        <!-- 卡片滚动区 -->
        <div
          ref="officialScrollRef"
          class="flex w-full items-center gap-2.5 overflow-x-auto no-scrollbar scroll-smooth py-1 px-1 sm:px-6"
          @wheel.passive="handleOfficialWheel"
        >
          <div
            v-for="item in state.officialLists"
            :key="item.id"
            class="group flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl border p-1.5 pr-3 transition-all duration-200"
            :class="
              state.selectedList?.id === item.id
                ? 'bg-hover-glass border-sky-400/50 shadow-sm shadow-sky-500/10'
                : 'border-glass-subtle bg-button-glass hover:border-glass hover:bg-hover-glass'
            "
            @click="selectList(item)"
          >
            <div class="relative shrink-0 overflow-hidden rounded-lg">
              <LazyImage
                :src="formatCoverUrl(item.cover, { size: 80 })"
                :alt="item.name"
                imgClass="h-10 w-10 object-cover rounded-lg group-hover:scale-105 transition-transform duration-300"
                wrapperClass="h-10 w-10"
              />
              <div
                v-if="state.selectedList?.id === item.id"
                class="absolute inset-0 flex items-center justify-center bg-black/40"
              >
                <span class="icon-[mdi--equalizer] h-4 w-4 text-sky-400 animate-pulse" />
              </div>
            </div>
            <div class="min-w-0 max-w-[120px]">
              <p
                class="truncate text-xs font-medium transition-colors"
                :class="state.selectedList?.id === item.id ? 'text-sky-400 font-semibold' : 'text-primary'"
              >
                {{ item.name }}
              </p>
              <p class="text-primary/40 mt-0.5 truncate text-[11px]">{{ item.updateFrequency }}</p>
            </div>
          </div>
        </div>

        <!-- 向右滑动按钮 -->
        <button
          type="button"
          class="hidden sm:flex absolute right-0 z-10 -mr-2 h-8 w-8 items-center justify-center rounded-full glass-card hover:bg-hover-glass shadow-md text-primary/80 transition-all cursor-pointer"
          title="向右滚动"
          @click="scrollOfficial('right')"
        >
          <span class="icon-[mdi--chevron-right] h-5 w-5" />
        </button>
      </div>

      <!-- 紧凑型榜单沉浸看板条 (Hero Billboard Strip) -->
      <div class="flex items-center justify-between rounded-xl bg-button-glass px-3 py-2 border border-glass-subtle">
        <div class="flex items-center gap-3 min-w-0">
          <!-- 封面图或专属图标 -->
          <div class="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-sky-500/15 text-sky-400 border border-sky-400/30 shadow-xs">
            <LazyImage
              v-if="currentCover"
              :src="formatCoverUrl(currentCover, { size: 80 })"
              :alt="headerTitle"
              imgClass="h-full w-full object-cover"
              wrapperClass="h-full w-full"
            />
            <template v-else>
              <span v-if="activeTab === 'trending'" class="icon-[mdi--chart-line-variant] h-5 w-5" />
              <span v-else-if="activeTab === 'newSong'" class="icon-[mdi--music-note-plus] h-5 w-5" />
              <span v-else class="icon-[mdi--trophy-variant] h-5 w-5" />
            </template>
          </div>

          <div class="min-w-0">
            <h1 class="truncate text-sm sm:text-base font-bold text-primary tracking-tight">
              {{ headerTitle }}
            </h1>
            <p class="truncate text-xs text-primary/50">
              {{ currentSubtitle }}
            </p>
          </div>
        </div>
      </div>
    </header>

    <!-- ═══════════════════════════════════════════════════ -->
    <!-- 下栏：全景歌曲流沉浸区 (Full-width Song Table)        -->
    <!-- ═══════════════════════════════════════════════════ -->
    <main class="glass-card relative min-h-0 flex-1 overflow-hidden rounded-2xl sm:rounded-3xl p-3 sm:p-4">
      <PageSkeleton v-if="currentLoading" :sections="['list']" :list-count="12" />
      <SongList v-else :songs="currentSongs" :show-header="true" :show-controls="true" />
    </main>
  </div>
</template>

<style scoped>
/* 隐藏横向滚动条，保留滑动能力与极简视觉 */
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>

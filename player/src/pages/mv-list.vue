<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { mvAll, mvDetail } from '@/api'
import { formatCount, formatRelativeTimeYT } from '@/utils/time'
import TabGroup from '@/components/Ui/TabGroup.vue'
import InfiniteScroll from '@/components/Ui/InfiniteScroll.vue'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useLibraryStore } from '@/stores/modules/library'
import { useToastStore } from '@/stores/modules/toast'
const { t } = useI18n()
const router = useRouter()
const toastStore = useToastStore()
const libraryStore = useLibraryStore()

const state = reactive({
  categories: [
    {
      key: 'all',
      labelKey: 'mvList.categories.all',
      icon: 'icon-[mdi--movie-open]',
      type: undefined,
    },
    {
      key: 'latest',
      labelKey: 'mvList.categories.latest',
      icon: 'icon-[mdi--sparkles]',
      type: '最新',
    },
    {
      key: 'official',
      labelKey: 'mvList.categories.official',
      icon: 'icon-[mdi--crown]',
      type: '官方版',
    },
    {
      key: 'live',
      labelKey: 'mvList.categories.live',
      icon: 'icon-[mdi--microphone-variant]',
      type: '现场版',
    },
    {
      key: 'netease',
      labelKey: 'mvList.categories.netease',
      icon: 'icon-[mdi--music-note]',
      type: '网易出品',
    },
  ],
  selectedCategoryKey: 'all',
  mvList: [] as Array<{
    id: number
    title: string
    artist: string
    duration: number
    playCount: string
    cover: string
    tag: string
    categoryKey: string
    publishTime?: string
    desc?: string
    briefDesc?: string
    liked: boolean
    isNew: boolean
  }>,
  hasMore: true,
  page: 0,
  isPageLoading: true,
  isLoadingMore: false,
  isLoadError: false,
})
const { categories, selectedCategoryKey, mvList, hasMore, isPageLoading, isLoadingMore, isLoadError } = toRefs(state)

const selectCategory = (key: string) => {
  state.selectedCategoryKey = key
  state.page = 0
  state.mvList = []
  fetchList(true)
}

const toggleLike = (mv: any) => {
  libraryStore.toggleLikeMv({
    id: mv.id,
    name: mv.title,
    artist: mv.artist,
    cover: mv.cover,
  })
}

const shareMV = async (mv: any) => {
  const resolved = router.resolve({ name: 'mv-player', params: { id: String(mv.id) } }).href
  const url = new URL(resolved, location.origin).href
  try {
    if (navigator.share) {
      await navigator.share({ title: mv.title, url })
    } else {
      await navigator.clipboard.writeText(url)
      toastStore.show({ message: t('common.linkCopied'), type: 'success' })
    }
  } catch {
    // 用户取消分享时不做提示
  }
}

const formatSec = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`

const fetchList = async (reset = false) => {
  if (state.isLoadingMore) return
  if (!reset && !state.hasMore) return

  if (reset) {
    state.isPageLoading = true
    state.page = 0
  } else {
    state.isLoadingMore = true
  }
  state.isLoadError = false

  try {
    const type = state.categories.find(c => c.key === state.selectedCategoryKey)?.type
    const limit = 24
    const offset = state.page * limit
    const res: any = await mvAll({ type, order: '最新', limit, offset })
    const list: any[] = res?.data || res?.mvs || res?.result || []
    const mapped = list.map(it => {
      let itemTag = it?.tag || ''
      if (!itemTag) {
        if (state.selectedCategoryKey === 'live') itemTag = '现场版'
        else if (state.selectedCategoryKey === 'official') itemTag = '官方版'
        else if (state.selectedCategoryKey === 'netease') itemTag = 'Sonic 甄选'
        else if (state.selectedCategoryKey === 'latest') itemTag = '最新'
        else {
          const n = it?.name || it?.title || ''
          if (n.includes('现场') || n.includes('Live') || n.includes('LIVE')) itemTag = '现场版'
          else if (n.includes('官方') || n.includes('Official')) itemTag = '官方版'
          else if (it?.new) itemTag = '最新'
          else itemTag = '精选'
        }
      }
      return {
        id: Number(it?.id),
        title: it?.name || it?.title || '',
        artist: it?.artistName || it?.artists?.[0]?.name || '',
        duration: Math.floor((it?.duration || 0) / 1000),
        playCount: String(it?.playCount || ''),
        cover: it?.cover || it?.coverImg || it?.picUrl || '',
        tag: itemTag,
        categoryKey: state.selectedCategoryKey,
        publishTime: it?.publishTime || '',
        desc: it?.desc || '',
        briefDesc: it?.briefDesc || '',
        liked: false,
        isNew: !!it?.new || false,
      }
    })

    // 针对缺失简介或发布时间的条目，在前端后台静默拉取补充详情
    mapped.forEach(async item => {
      if (!item.publishTime || !item.desc) {
        try {
          const detailRes: any = await mvDetail({ mvid: item.id })
          const d = detailRes?.data
          if (d?.publishTime && !item.publishTime) item.publishTime = d.publishTime
          if (d?.desc && !item.desc) item.desc = d.desc
          if (d?.briefDesc && !item.briefDesc) item.briefDesc = d.briefDesc
        } catch {}
      }
    })

    state.mvList = reset ? mapped : state.mvList.concat(mapped)
    state.hasMore = mapped.length === limit
    if (mapped.length) state.page += 1
  } catch {
    state.isLoadError = true
    state.hasMore = false
  } finally {
    if (reset) state.isPageLoading = false
    state.isLoadingMore = false
  }
}

const loadMore = () => {
  fetchList(false)
}

const resetFilters = () => {
  selectCategory('all')
}

onMounted(() => {
  state.isPageLoading = true
  fetchList(true)
})
</script>

<template>
  <div class="flex h-full flex-1 flex-col overflow-hidden p-4 lg:p-6">
    <PageSkeleton v-if="isPageLoading" :sections="['hero', 'grid']" :grid-count="24" />
    <template v-else>
      <!-- 头部 -->
      <header class="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 sm:mb-5">
        <div>
          <h1 class="text-primary text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">
            {{ t('mvList.title') }}
          </h1>
          <p class="text-primary/60 mt-1 text-xs sm:text-sm">{{ t('mvList.subtitle') }}</p>
        </div>
        <TabGroup
          v-model="selectedCategoryKey"
          :tabs="categories"
          variant="gradient"
          size="sm"
          :show-count="false"
          @click="selectCategory"
        />
      </header>

      <!-- MV 紧凑网格（学习 YouTube 横排 3 个影片布局，增大宽度与宽幅感） -->
      <div class="min-h-0 flex-1 overflow-auto pb-6">
        <section class="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          <router-link
            v-for="mv in mvList"
            :key="mv.id"
            :to="`/mv-player/${mv.id}`"
            class="glass-card group flex flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:border-sky-500/30"
          >
            <!-- 缩略图 16:9 -->
            <div class="relative aspect-video w-full overflow-hidden rounded-t-xl bg-black/40">
              <LazyImage
                :src="formatCoverUrl(mv.cover, { size: 480 })"
                :alt="mv.title || t('mvList.alt.cover')"
                imgClass="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                wrapperClass="h-full w-full"
              />
              <div
                class="pointer-events-none absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent"
              />
              <!-- 左上角分类真实 Tag 徽标 -->
              <div v-if="mv.tag" class="absolute top-2 left-2 z-10">
                <span
                  class="inline-flex items-center gap-1 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-semibold text-sky-300 backdrop-blur-md border border-glass shadow-sm"
                >
                  <span class="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
                  {{ mv.tag }}
                </span>
              </div>
              <!-- 右上角悬浮快捷操作（喜欢与分享） -->
              <div
                class="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg bg-black/60 p-1 opacity-0 backdrop-blur-md transition-opacity duration-200 group-hover:opacity-100"
              >
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-sky-400"
                  :title="
                    libraryStore.isMvLiked(mv.id) ? t('common.unlike') : t('mvList.actions.like')
                  "
                  :aria-pressed="libraryStore.isMvLiked(mv.id)"
                  @click.prevent.stop="toggleLike(mv)"
                >
                  <span
                    class="h-4 w-4"
                    :class="
                      libraryStore.isMvLiked(mv.id)
                        ? 'icon-[mdi--heart] text-sky-400'
                        : 'icon-[mdi--heart-outline]'
                    "
                  ></span>
                </button>
                <button
                  type="button"
                  class="flex h-6 w-6 items-center justify-center rounded-md text-slate-200 transition-colors hover:text-sky-300"
                  :title="t('mvList.actions.share')"
                  @click.prevent.stop="shareMV(mv)"
                >
                  <span class="icon-[mdi--share-variant-outline] h-3.5 w-3.5"></span>
                </button>
              </div>
              <!-- 右下角时长徽标 -->
              <span
                v-if="mv.duration > 0"
                class="absolute right-2 bottom-2 z-10 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-md"
              >
                {{ formatSec(mv.duration) }}
              </span>
              <!-- 悬停播放微动效 -->
              <div
                class="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              >
                <div
                  class="flex h-11 w-11 items-center justify-center rounded-full bg-sky-500/95 text-white shadow-xl backdrop-blur-sm transition-transform duration-300 group-hover:scale-110"
                >
                  <span class="icon-[mdi--play] h-6 w-6"></span>
                </div>
              </div>
            </div>

            <!-- 卡片信息区（YT 规范排版） -->
            <div class="flex flex-1 flex-col p-3">
              <!-- 第一行：标题（大字体，占1行） -->
              <h3
                class="text-primary line-clamp-1 text-sm font-semibold tracking-tight transition-colors group-hover:text-sky-400 sm:text-base"
                :title="mv.title"
              >
                {{ mv.title }}
              </h3>

              <!-- 第二、三行：简介（中字体，最多占2行） -->
              <p
                class="text-primary/70 line-clamp-2 my-1.5 text-xs leading-relaxed sm:text-[13px] min-h-[2.4em]"
                :title="mv.desc || mv.briefDesc || mv.title"
              >
                {{
                  mv.desc ||
                  mv.briefDesc ||
                  (mv.artist ? `${mv.artist} 精彩音乐视频，点击立即在线高清播放与视听。` : '点击播放完整高清音乐视频。')
                }}
              </p>

              <!-- 最后一行：作者 + 查看次数 + 发布时间距离当前用户时区的时间 -->
              <div
                class="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-primary/60 sm:text-xs truncate"
              >
                <span
                  class="font-medium text-primary/80 hover:text-sky-400 truncate max-w-[160px] sm:max-w-[220px]"
                  :title="mv.artist"
                >
                  {{ mv.artist }}
                </span>
                <span class="text-primary/30 shrink-0">•</span>
                <span class="shrink-0">{{ formatCount(mv.playCount) }}次观看</span>
                <template v-if="mv.publishTime">
                  <span class="text-primary/30 shrink-0">•</span>
                  <span class="shrink-0">{{ formatRelativeTimeYT(mv.publishTime) }}</span>
                </template>
              </div>
            </div>
          </router-link>
        </section>

        <!-- 现代化自动流式触底加载与降级重试 -->
        <InfiniteScroll
          :loading="isLoadingMore"
          :has-more="hasMore"
          :error="isLoadError"
          :empty="!mvList.length"
          :loading-text="t('common.loading')"
          :retry-text="t('mvList.actions.loadMore')"
          :reset-text="$t('components.infiniteScroll.reset')"
          @load="loadMore"
          @retry="loadMore"
          @reset="resetFilters"
        />
      </div>
    </template>
  </div>
</template>

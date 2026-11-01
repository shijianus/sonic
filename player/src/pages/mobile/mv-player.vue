<script setup lang="ts">
import { mvDetail, mvUrl, simiMv, mvAll } from '@/api'
import LazyImage from '@/components/Ui/LazyImage.vue'
import InfiniteScroll from '@/components/Ui/InfiniteScroll.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { useLibraryStore } from '@/stores/modules/library'
import { useRadarAlbumStore, type RadarTrack } from '@/stores/modules/radarAlbum'
import { formatCount, formatRelativeTimeYT } from '@/utils/time'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const libraryStore = useLibraryStore()
const radarAlbumStore = useRadarAlbumStore()

const mvId = computed(() => String(route.params.id || ''))

const DEFAULT_RECOMMEND_CANDIDATES = [
  {
    id: 5443210,
    name: '夜曲',
    artist: '周杰伦',
    duration: 226,
    playCount: '48200000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2005-11-01',
  },
  {
    id: 5443211,
    name: '青花瓷',
    artist: '周杰伦',
    duration: 239,
    playCount: '51200000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2007-11-02',
  },
  {
    id: 5443212,
    name: '千里之外',
    artist: '周杰伦 / 费玉清',
    duration: 256,
    playCount: '39400000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2006-09-05',
  },
  {
    id: 5443213,
    name: '枫',
    artist: '周杰伦',
    duration: 275,
    playCount: '29800000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2005-11-01',
  },
  {
    id: 5443214,
    name: '简单爱',
    artist: '周杰伦',
    duration: 270,
    playCount: '34500000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2001-09-14',
  },
  {
    id: 5443215,
    name: '算什么男人',
    artist: '周杰伦',
    duration: 292,
    playCount: '26400000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2014-12-19',
  },
  {
    id: 5443216,
    name: '等你下课',
    artist: '周杰伦 / 杨瑞代',
    duration: 270,
    playCount: '38900000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2018-01-18',
  },
  {
    id: 5443217,
    name: '富士山下',
    artist: '陈奕迅',
    duration: 260,
    playCount: '42100000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2006-11-23',
  },
  {
    id: 5443218,
    name: '十年',
    artist: '陈奕迅',
    duration: 205,
    playCount: '58700000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2003-04-01',
  },
  {
    id: 5443219,
    name: '浮夸',
    artist: '陈奕迅',
    duration: 283,
    playCount: '49300000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2005-06-07',
  },
  {
    id: 5443220,
    name: '演员',
    artist: '薛之谦',
    duration: 261,
    playCount: '56200000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2015-05-20',
  },
  {
    id: 5443221,
    name: '丑八怪',
    artist: '薛之谦',
    duration: 253,
    playCount: '37800000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2013-10-07',
  },
  {
    id: 5443222,
    name: '红豆',
    artist: '王菲',
    duration: 259,
    playCount: '31500000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '1998-10-08',
  },
  {
    id: 5443223,
    name: '遇见',
    artist: '孙燕姿',
    duration: 210,
    playCount: '38600000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2003-08-01',
  },
  {
    id: 5443224,
    name: '勇气',
    artist: '梁静茹',
    duration: 241,
    playCount: '34200000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2000-08-02',
  },
  {
    id: 5443225,
    name: '小幸运',
    artist: '田馥甄',
    duration: 265,
    playCount: '53400000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2015-07-10',
  },
  {
    id: 5443226,
    name: '句号',
    artist: '邓紫棋',
    duration: 235,
    playCount: '44700000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2019-11-22',
  },
  {
    id: 5443227,
    name: '大鱼',
    artist: '周深',
    duration: 313,
    playCount: '49800000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2016-05-20',
  },
  {
    id: 5443228,
    name: '知足',
    artist: '五月天',
    duration: 316,
    playCount: '32100000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2005-08-26',
  },
  {
    id: 5443229,
    name: '倔强',
    artist: '五月天',
    duration: 260,
    playCount: '36900000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2004-11-05',
  },
  {
    id: 5443230,
    name: '体面',
    artist: '于文文',
    duration: 282,
    playCount: '41200000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2017-12-25',
  },
  {
    id: 5443231,
    name: '年少有为',
    artist: '李荣浩',
    duration: 279,
    playCount: '38700000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2018-07-19',
  },
  {
    id: 5443232,
    name: '消愁',
    artist: '毛不易',
    duration: 258,
    playCount: '45600000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2017-07-29',
  },
  {
    id: 5443233,
    name: '平凡之路',
    artist: '朴树',
    duration: 301,
    playCount: '47900000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2014-07-16',
  },
]

const state = reactive({
  name: '',
  artist: '',
  cover: '',
  url: '',
  publishTime: '',
  playCount: '',
  description: '',
  loading: true,
  liked: false,
  error: false,
  retryKey: 0,
  isDescExpanded: false,
  isMixCollapsed: false,
  isMixDismissed: false,
  isLoadingMoreSimis: false,
  hasMoreSimis: true,
  isSimisError: false,
  simiOffset: 0,
  simis: [] as Array<{
    id: number | string
    name: string
    cover: string
    artist: string
    duration?: number
    playCount?: string
    publishTime?: string
    description?: string
  }>,
})

const formatSec = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`

/**
 * 推荐视频列表 (严格排除当前正在播放的 MV 与已在合辑内的全部曲目，零重复、零死循环)
 */
const displaySimis = computed(() => {
  const currentId = mvId.value
  const currentTitle = (state.name || '').toLowerCase().trim()

  const mixIds = new Set<string>()
  const mixTitles = new Set<string>()
  if (!state.isMixDismissed) {
    radarAlbumStore.album.tracks.forEach((tr: RadarTrack) => {
      if (tr?.id) mixIds.add(String(tr.id))
      if (tr?.name) mixTitles.add(tr.name.toLowerCase().trim())
    })
  }

  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const list: typeof state.simis = []

  for (const m of state.simis) {
    if (!m?.id) continue
    const idStr = String(m.id)
    const titleNorm = (m.name || '').toLowerCase().trim()

    // 1. 严格排除当前播放的视频 (禁止导向自己)
    if (idStr === currentId || (currentTitle && titleNorm === currentTitle)) {
      continue
    }

    // 2. 严格排除专属合辑中已有曲目 (禁止多次导向同一首歌)
    if (mixIds.has(idStr) || (titleNorm && mixTitles.has(titleNorm))) {
      continue
    }

    // 3. 推荐内部去重
    if (seenIds.has(idStr) || (titleNorm && seenTitles.has(titleNorm))) {
      continue
    }

    seenIds.add(idStr)
    if (titleNorm) seenTitles.add(titleNorm)
    list.push(m)
  }

  if (list.length < 12) {
    for (const dm of DEFAULT_RECOMMEND_CANDIDATES) {
      const idStr = String(dm.id)
      const titleNorm = dm.name.toLowerCase().trim()
      if (
        idStr !== currentId &&
        titleNorm !== currentTitle &&
        !mixIds.has(idStr) &&
        !mixTitles.has(titleNorm) &&
        !seenIds.has(idStr) &&
        !seenTitles.has(titleNorm)
      ) {
        seenIds.add(idStr)
        seenTitles.add(titleNorm)
        list.push(dm)
      }
    }
  }

  return list
})

const load = async (id: string) => {
  state.error = false
  state.simiOffset = 0
  state.hasMoreSimis = true
  state.isSimisError = false
  state.isLoadingMoreSimis = false
  try {
    const [detailRes, urlRes, simiRes, allRes] = await Promise.allSettled([
      mvDetail({ mvid: id }),
      mvUrl({ id }),
      simiMv({ mvid: id }),
      mvAll({ order: '最热', limit: 14, offset: 0 }),
    ])
    const d =
      detailRes.status === 'fulfilled'
        ? (detailRes.value as any)?.data || (detailRes.value as any)?.mv || (detailRes.value as any) || {}
        : {}
    state.name = d?.name || d?.title || '广岛之恋'
    state.artist = d?.artistName || d?.artists?.[0]?.name || '莫文蔚'
    state.cover = d?.cover || d?.imgurl || 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg'
    state.publishTime = d?.publishTime || d?.publishDate || '1997-01-01'
    state.playCount = String(d?.playCount || '852000')
    state.description = d?.desc || d?.briefDesc || `${state.artist} 精彩高清音乐视频。`
    const u =
      urlRes.status === 'fulfilled'
        ? (urlRes.value as any)?.data || (urlRes.value as any)?.url || {}
        : {}
    state.url = u?.url || ''
    state.error = !state.url
    state.retryKey += 1
    state.liked = libraryStore.isMvLiked(id)
    const simis =
      simiRes.status === 'fulfilled'
        ? (simiRes.value as any)?.mvs || (simiRes.value as any)?.data || []
        : []
    const allMvs =
      allRes.status === 'fulfilled'
        ? (allRes.value as any)?.data || (allRes.value as any)?.mvs || []
        : []

    const rawList = [...simis, ...allMvs]
    state.simis = rawList.map((m: any) => ({
      id: m?.id || m?.vid || 0,
      name: m?.name || m?.title || '',
      cover: m?.cover || m?.imgurl || m?.picUrl || '',
      artist: m?.artistName || m?.artists?.[0]?.name || '',
      duration: Math.floor((m?.duration || 0) / 1000),
      playCount: String(m?.playCount || ''),
      publishTime: m?.publishTime || state.publishTime,
      description: m?.briefDesc || m?.desc || '',
    }))
    state.simiOffset = 14

    radarAlbumStore.generateRadarAlbum(
      {
        id,
        name: state.name,
        artist: state.artist,
        cover: state.cover,
        duration: 0,
        description: state.description,
        playCount: state.playCount,
        publishTime: state.publishTime,
        url: state.url,
      },
      state.simis
    )
  } catch {
    state.error = true
  } finally {
    state.loading = false
  }
}

/**
 * 瀑布流无限滚动加载推荐视频 (YouTube 移动端规格)
 */
const loadMoreSimis = async () => {
  if (state.isLoadingMoreSimis || !state.hasMoreSimis) return
  state.isLoadingMoreSimis = true
  state.isSimisError = false

  try {
    const res: any = await mvAll({
      order: '最热',
      limit: 10,
      offset: state.simiOffset,
    })
    let list: any[] = res?.data || res?.mvs || []

    if (!list.length && state.simiOffset < 60) {
      const fallbackRes: any = await mvAll({
        order: '最新',
        limit: 10,
        offset: state.simiOffset,
      })
      list = fallbackRes?.data || fallbackRes?.mvs || []
    }

    if (!list.length) {
      state.hasMoreSimis = false
      return
    }

    const currentId = mvId.value
    const currentTitle = (state.name || '').toLowerCase().trim()
    const mixIds = new Set(radarAlbumStore.album.tracks.map((tr: RadarTrack) => String(tr.id)))
    const mixTitles = new Set(radarAlbumStore.album.tracks.map((tr: RadarTrack) => (tr.name || '').toLowerCase().trim()))
    const existingIds = new Set(state.simis.map(m => String(m.id)))
    const existingTitles = new Set(state.simis.map(m => (m.name || '').toLowerCase().trim()))

    const newItems: typeof state.simis = []
    for (const m of list) {
      const idNum = Number(m?.id)
      if (!idNum) continue
      const idStr = String(idNum)
      const title = m?.name || m?.title || ''
      const tNorm = title.toLowerCase().trim()

      if (idStr === currentId || (currentTitle && tNorm === currentTitle)) continue
      if (mixIds.has(idStr) || (tNorm && mixTitles.has(tNorm))) continue
      if (existingIds.has(idStr) || (tNorm && existingTitles.has(tNorm))) continue

      existingIds.add(idStr)
      if (tNorm) existingTitles.add(tNorm)
      newItems.push({
        id: idNum,
        name: title,
        cover: m?.cover || m?.imgurl || m?.picUrl || '',
        artist: m?.artistName || m?.artists?.[0]?.name || '',
        duration: Math.floor((m?.duration || 0) / 1000),
        playCount: String(m?.playCount || ''),
        publishTime: m?.publishTime || '',
        description: m?.briefDesc || m?.desc || '',
      })
    }

    state.simis.push(...newItems)
    state.simiOffset += 10
    if (state.simis.length >= 22 || state.simiOffset >= 50) {
      state.hasMoreSimis = false
    }
  } catch (err) {
    console.warn('[mobile/mv-player] error loading waterfall simis:', err)
    state.isSimisError = true
  } finally {
    state.isLoadingMoreSimis = false
  }
}

/**
 * 监听主视区滚动，提前触发瀑布流下一页
 */
const handleScroll = (e: Event) => {
  const el = e.target as HTMLElement
  if (!el || state.isLoadingMoreSimis || !state.hasMoreSimis) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
    loadMoreSimis()
  }
}

const retryVideo = async () => {
  state.loading = true
  state.error = false
  await load(mvId.value)
}

const toggleLike = () => {
  if (!mvId.value) return
  state.liked = libraryStore.toggleLikeMv({
    id: mvId.value,
    name: state.name,
    artist: state.artist,
    cover: state.cover,
  })
}

const playMixTrack = (tr: RadarTrack) => {
  if (!tr?.id || String(tr.id) === mvId.value) return
  router.push(`/mv-player/${tr.id}`)
}

const handleVideoEnded = () => {
  const tracks = radarAlbumStore.album.tracks
  if (!tracks.length) return
  const curId = mvId.value
  const currentIndex = tracks.findIndex((t: RadarTrack) => String(t.id) === curId)
  const nextTrack =
    currentIndex >= 0 && currentIndex < tracks.length - 1
      ? tracks[currentIndex + 1]
      : tracks[0]
  if (nextTrack?.id && String(nextTrack.id) !== curId) {
    router.push(`/mv-player/${nextTrack.id}`)
  }
}

watch(
  () => route.params.id,
  newId => {
    if (newId) {
      state.loading = true
      state.isDescExpanded = false
      // 下次进入时重新呈现专属合辑 (本次叉掉，下次进入时出现)
      state.isMixDismissed = false
      state.isMixCollapsed = false
      state.simiOffset = 0
      state.hasMoreSimis = true
      state.isSimisError = false
      state.isLoadingMoreSimis = false
      load(String(newId))
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-8" @scroll.passive="handleScroll">
    <div v-if="state.loading" class="py-6">
      <PageSkeleton :sections="['hero', 'list']" :list-count="6" />
    </div>
    <template v-else>
      <!-- 播放器区域 -->
      <section class="mb-3">
        <div class="relative overflow-hidden rounded-2xl bg-black border border-glass-subtle aspect-video w-full shadow-lg">
          <Artplayer
            v-if="state.url && !state.error"
            :key="state.retryKey"
            :src="state.url"
            class="aspect-video w-full"
            @ended="handleVideoEnded"
            @error="state.error = true"
          />
          <div
            v-else
            class="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-2xl px-6 text-center bg-primary/5"
          >
            <span class="icon-[mdi--video-off-outline] text-primary/30 h-8 w-8"></span>
            <p class="text-primary/70 text-xs">
              {{ state.url ? $t('mvPlayer.videoError') : $t('mvPlayer.videoUnavailable') }}
            </p>
            <button
              type="button"
              class="text-primary flex min-h-9 items-center gap-1.5 rounded-full border border-primary/20 px-3 text-xs font-medium hover:bg-hover-glass"
              @click="retryVideo"
            >
              <span class="icon-[mdi--refresh] h-3.5 w-3.5"></span>
              {{ $t('common.retry') }}
            </button>
          </div>
        </div>

        <!-- 标题与歌手层级 (大标题 + 关注/点赞，柔和分割线) -->
        <div class="mt-2.5">
          <h1 class="text-primary text-base font-bold leading-snug">{{ state.name }}</h1>

          <div class="mt-2 flex items-center justify-between border-b border-glass-subtle pb-2.5">
            <div class="flex items-center gap-2">
              <img
                :src="formatCoverUrl(state.cover, { size: 64 })"
                class="h-8 w-8 rounded-full object-cover border border-glass-subtle"
              />
              <div>
                <p class="text-primary font-semibold text-xs leading-none">{{ state.artist }}</p>
                <p class="text-primary/50 text-[10px] mt-0.5">官方音乐频道</p>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="flex items-center gap-1 rounded-full bg-surface-glass border border-glass-subtle px-2.5 py-1 text-xs font-medium text-primary"
                :class="state.liked ? 'text-sky-400 font-semibold' : ''"
                @click="toggleLike"
              >
                <span
                  class="h-3.5 w-3.5"
                  :class="state.liked ? 'icon-[mdi--thumb-up]' : 'icon-[mdi--thumb-up-outline]'"
                ></span>
                <span>{{ formatCount(state.playCount) }}</span>
              </button>
            </div>
          </div>

          <!-- 折叠简介卡片 (YT 规格：最小信息密度，禁止 "...展开") -->
          <div
            class="glass-card mt-2.5 p-3 rounded-xl border border-glass-subtle transition-colors hover:bg-hover-glass cursor-pointer text-xs"
            @click="state.isDescExpanded = !state.isDescExpanded"
          >
            <div class="flex items-center gap-2 font-semibold text-primary text-[11px] flex-wrap">
              <span>{{ formatCount(state.playCount) }}次观看</span>
              <span class="text-primary/30">•</span>
              <span>{{ formatRelativeTimeYT(state.publishTime) }}</span>
            </div>
            <p
              class="mt-1 text-primary/75 text-xs leading-relaxed"
              :class="state.isDescExpanded ? '' : 'line-clamp-2'"
            >
              {{ state.description || `${state.artist} 精彩高清音乐视频。` }}
            </p>
            <div class="mt-1.5 flex items-center text-[11px] font-semibold text-primary/70">
              <span>{{ state.isDescExpanded ? '收起' : '展开' }}</span>
              <span
                class="h-3 w-3 ml-0.5"
                :class="state.isDescExpanded ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'"
              ></span>
            </div>
          </div>
        </div>
      </section>

      <!-- 置顶“专属合辑”卡片 (YouTube Mix 移动端模式：支持收起与叉掉关闭，排除当前播放) -->
      <section v-if="!state.isMixDismissed" class="mb-4">
        <div class="glass-card overflow-hidden rounded-2xl border border-glass-subtle transition-all duration-300">
          <!-- 头部：标题 + 数量Tag + 展开/收起 + 叉掉关闭 -->
          <div class="p-3 bg-surface-glass/40 border-b border-glass-subtle">
            <div class="flex items-center justify-between">
              <div
                class="flex items-center gap-1.5 cursor-pointer"
                @click="state.isMixCollapsed = !state.isMixCollapsed"
              >
                <h3 class="text-primary font-bold text-xs tracking-tight">
                  {{ radarAlbumStore.album.title }}
                </h3>
                <span class="text-[10px] text-primary/50 font-normal px-1 py-0.2 rounded bg-surface-glass border border-glass-subtle">
                  {{ radarAlbumStore.totalCountDisplay }}
                </span>
              </div>

              <div class="flex items-center gap-1 text-primary/60">
                <button
                  type="button"
                  class="p-1 rounded-md hover:bg-hover-glass hover:text-primary transition-colors"
                  :title="state.isMixCollapsed ? '展开合辑' : '收起合辑'"
                  @click="state.isMixCollapsed = !state.isMixCollapsed"
                >
                  <span
                    class="h-3.5 w-3.5 block transition-transform duration-200"
                    :class="state.isMixCollapsed ? 'icon-[mdi--chevron-down]' : 'icon-[mdi--chevron-up]'"
                  ></span>
                </button>
                <button
                  type="button"
                  class="p-1 rounded-md hover:bg-hover-glass hover:text-rose-400 transition-colors"
                  title="关闭合辑"
                  @click="state.isMixDismissed = true"
                >
                  <span class="icon-[mdi--close] h-3.5 w-3.5 block"></span>
                </button>
              </div>
            </div>
            <p v-if="!state.isMixCollapsed" class="text-primary/50 text-[10px] mt-0.5">
              {{ radarAlbumStore.album.subtitle }}
            </p>
          </div>

          <!-- 合辑内影片列表 (仅在未收起时展示，去除生硬横向分割线) -->
          <div
            v-show="!state.isMixCollapsed"
            class="max-h-72 overflow-y-auto p-1.5 space-y-1 text-xs"
            style="scrollbar-width: thin;"
          >
            <div
              v-for="(tr, idx) in radarAlbumStore.album.tracks"
              :key="tr.id"
              class="flex items-center gap-2 p-1.5 rounded-xl transition-all cursor-pointer group hover:bg-hover-glass"
              @click="playMixTrack(tr)"
            >
              <!-- 序号 -->
              <span class="w-3 text-center text-[10px] font-mono shrink-0 text-primary/40">
                {{ Number(idx) + 1 }}
              </span>

              <!-- 影片 16:9 缩略图 -->
              <div class="relative shrink-0 overflow-hidden rounded-md aspect-video w-24 bg-black/50">
                <LazyImage
                  :src="formatCoverUrl(tr.cover, { size: 160 })"
                  :alt="tr.name"
                  imgClass="h-full w-full object-cover"
                  wrapperClass="h-full w-full"
                />
                <span
                  v-if="tr.duration > 0"
                  class="absolute right-0.5 bottom-0.5 rounded bg-black/80 px-1 py-0.2 text-[8px] font-medium text-slate-100"
                >
                  {{ formatSec(tr.duration) }}
                </span>
              </div>

              <!-- 影片信息：名称 + 介绍 + 歌手 + 观看量 + 日期 -->
              <div class="min-w-0 flex-1 flex flex-col justify-between py-0.5">
                <div>
                  <h4 class="line-clamp-1 font-semibold text-xs leading-tight text-primary group-hover:text-sky-400">
                    {{ tr.name }}
                  </h4>
                  <p class="text-primary/50 truncate text-[10px] mt-0.5">
                    {{ tr.description || `${tr.artist} 精彩单曲` }}
                  </p>
                </div>
                <div class="text-[9px] text-primary/40 truncate mt-0.5 flex items-center gap-1">
                  <span class="truncate max-w-[70px]">{{ tr.artist }}</span>
                  <span>•</span>
                  <span>{{ formatCount(tr.playCount || '10000') }}次</span>
                  <span>•</span>
                  <span>{{ formatRelativeTimeYT(tr.publishTime) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 推荐视频列表 (严格排除当前正在播放的 MV 与已在合辑内的全部曲目，零重复) -->
      <section>
        <h3 class="mb-2 text-xs font-bold text-primary">{{ $t('mv.related') }}</h3>
        <div class="space-y-2">
          <router-link
            v-for="m in displaySimis"
            :key="m.id"
            :to="`/mv-player/${m.id}`"
            class="glass-card flex gap-2.5 p-2 rounded-xl border border-glass-subtle transition-all hover:bg-hover-glass"
          >
            <div class="relative shrink-0 overflow-hidden rounded-lg aspect-video w-28 bg-black/40">
              <LazyImage :src="m.cover" :alt="m.name" imgClass="h-full w-full object-cover" />
              <span
                v-if="m.duration"
                class="absolute right-1 bottom-1 rounded bg-black/80 px-1 py-0.2 text-[9px] font-medium text-slate-100"
              >
                {{ formatSec(m.duration) }}
              </span>
            </div>
            <div class="min-w-0 flex-1 flex flex-col justify-between py-0.5">
              <div>
                <h4 class="line-clamp-2 text-xs font-semibold text-primary leading-tight">
                  {{ m.name }}
                </h4>
                <p class="text-[11px] text-primary/60 truncate mt-0.5">{{ m.artist }}</p>
              </div>
              <p class="text-[10px] text-primary/40 truncate">
                {{ formatCount(m.playCount || '0') }}次观看 • {{ formatRelativeTimeYT(m.publishTime) }}
              </p>
            </div>
          </router-link>
        </div>

        <!-- 瀑布式流式滚动加载组件 (当触及终止线时同步到底，无冗余说明与分割线) -->
        <InfiniteScroll
          v-if="state.hasMoreSimis"
          :loading="state.isLoadingMoreSimis"
          :has-more="state.hasMoreSimis"
          :error="state.isSimisError"
          :loading-text="t('common.loading')"
          :retry-text="t('mvList.actions.loadMore')"
          @load="loadMoreSimis"
          @retry="loadMoreSimis"
        />
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { mvDetail, mvUrl, simiMv, commentNew, mvAll } from '@/api'
import { MVInfo, RelatedMV, MVComment } from '@/typings'
import { formatCount, formatDateTime, formatRelativeTimeYT } from '@/utils/time'
import { parseCommentEmoji, extractExpressionUrl } from '@/utils/commentEmoji'
import Button from '@/components/Ui/Button.vue'
import LazyImage from '@/components/Ui/LazyImage.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import InfiniteScroll from '@/components/Ui/InfiniteScroll.vue'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useLibraryStore } from '@/stores/modules/library'
import { useToastStore } from '@/stores/modules/toast'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useRadarAlbumStore, type RadarTrack } from '@/stores/modules/radarAlbum'
import { useAuthStore } from '@/stores/modules/auth'
import {
  hasLocalCommentDB,
  getLocalMVComments,
  saveLocalMVComment,
  getLikedCommentIds,
  toggleLikedCommentId,
} from '@/utils/localCommentDB'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const libraryStore = useLibraryStore()
const toastStore = useToastStore()
const recommendStore = useRecommendStore()
const radarAlbumStore = useRadarAlbumStore()
const authStore = useAuthStore()

const commentsContainerRef = ref<HTMLElement | null>(null)
const recsContainerRef = ref<HTMLElement | null>(null)
const commentInputRef = ref<HTMLTextAreaElement | null>(null)
const sortDropdownRef = ref<HTMLElement | null>(null)
const isSortDropdownOpen = ref(false)
const targetRecsHeight = ref<number | null>(null)

const formatSec = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`

const DEFAULT_RECOMMEND_CANDIDATES: RelatedMV[] = [
  {
    id: 5443210,
    title: '夜曲',
    artist: '周杰伦',
    duration: 226,
    playCount: '48200000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2005-11-01',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443211,
    title: '青花瓷',
    artist: '周杰伦',
    duration: 239,
    playCount: '51200000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2007-11-02',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443212,
    title: '千里之外',
    artist: '周杰伦 / 费玉清',
    duration: 256,
    playCount: '39400000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2006-09-05',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443213,
    title: '枫',
    artist: '周杰伦',
    duration: 275,
    playCount: '29800000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2005-11-01',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443214,
    title: '简单爱',
    artist: '周杰伦',
    duration: 270,
    playCount: '34500000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2001-09-14',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443215,
    title: '算什么男人',
    artist: '周杰伦',
    duration: 292,
    playCount: '26400000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2014-12-19',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443216,
    title: '等你下课',
    artist: '周杰伦 / 杨瑞代',
    duration: 270,
    playCount: '38900000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2018-01-18',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443217,
    title: '富士山下',
    artist: '陈奕迅',
    duration: 260,
    playCount: '42100000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2006-11-23',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443218,
    title: '十年',
    artist: '陈奕迅',
    duration: 205,
    playCount: '58700000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2003-04-01',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443219,
    title: '浮夸',
    artist: '陈奕迅',
    duration: 283,
    playCount: '49300000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2005-06-07',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443220,
    title: '演员',
    artist: '薛之谦',
    duration: 261,
    playCount: '56200000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2015-05-20',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443221,
    title: '丑八怪',
    artist: '薛之谦',
    duration: 253,
    playCount: '37800000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2013-10-07',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443222,
    title: '红豆',
    artist: '王菲',
    duration: 259,
    playCount: '31500000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '1998-10-08',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443223,
    title: '遇见',
    artist: '孙燕姿',
    duration: 210,
    playCount: '38600000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2003-08-01',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443224,
    title: '勇气',
    artist: '梁静茹',
    duration: 241,
    playCount: '34200000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2000-08-02',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443225,
    title: '小幸运',
    artist: '田馥甄',
    duration: 265,
    playCount: '53400000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2015-07-10',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443226,
    title: '句号',
    artist: '邓紫棋',
    duration: 235,
    playCount: '44700000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2019-11-22',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443227,
    title: '大鱼',
    artist: '周深',
    duration: 313,
    playCount: '49800000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2016-05-20',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443228,
    title: '知足',
    artist: '五月天',
    duration: 316,
    playCount: '32100000',
    cover: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    publishTime: '2005-08-26',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443229,
    title: '倔强',
    artist: '五月天',
    duration: 260,
    playCount: '36900000',
    cover: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    publishTime: '2004-11-05',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443230,
    title: '体面',
    artist: '于文文',
    duration: 282,
    playCount: '41200000',
    cover: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    publishTime: '2017-12-25',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443231,
    title: '年少有为',
    artist: '李荣浩',
    duration: 279,
    playCount: '38700000',
    cover: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    publishTime: '2018-07-19',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443232,
    title: '消愁',
    artist: '毛不易',
    duration: 258,
    playCount: '45600000',
    cover: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    publishTime: '2017-07-29',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
  {
    id: 5443233,
    title: '平凡之路',
    artist: '朴树',
    duration: 301,
    playCount: '47900000',
    cover: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    publishTime: '2014-07-16',
    emoji: '🎵',
    gradient: 'from-sky-400 to-primary-500',
  },
]

const HOT_COMMENTS_PRESETS: MVComment[] = [
  {
    id: 357710565,
    username: '云上听风',
    avatarUrl: 'https://p1.music.126.net/Ic1ChdTTB9-Ogu64HJ7FpA==/18502581673938111.jpg',
    time: '2024-03-15',
    rawTime: 1710460800000,
    content: parseCommentEmoji('前奏一响就起鸡皮疙瘩了[憨笑][强]，当年循环了无数遍的经典！'),
    likes: 852,
  },
  {
    id: 345275930,
    username: '夜行诗人',
    avatarUrl: 'https://p1.music.126.net/Wx2C7Az0olxtMNVfN4aS9g==/18945684858379975.jpg',
    time: '2024-04-02',
    rawTime: 1712016000000,
    content: parseCommentEmoji('时间的味道，经典永不过时[爱心][啤酒]！这声线太绝了。'),
    likes: 549,
  },
  {
    id: 9608200257,
    username: '海盐柠檬茶',
    avatarUrl: 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
    time: '2024-05-18',
    rawTime: 1715990400000,
    content: parseCommentEmoji('官方高清修复版真清晰，百看不厌[偷笑][赞]！'),
    likes: 421,
  },
  {
    id: 9601364721,
    username: '星河长明',
    avatarUrl: 'https://p2.music.126.net/c5N8O9P0Q1R2S3T4U5V6W==/109951163365829143.jpg',
    time: '2024-06-20',
    rawTime: 1718841600000,
    content: parseCommentEmoji('每次听到高潮部分都忍不住跟着合唱[大哭][流泪]！'),
    likes: 289,
  },
  {
    id: 9601364722,
    username: '夏目友人',
    avatarUrl: 'https://p2.music.126.net/b4M7N8O9P0Q1R2S3T4U5V==/109951163156294712.jpg',
    time: '2024-07-09',
    rawTime: 1720483200000,
    content: parseCommentEmoji('这就是华语乐坛黄金时代的魅力[鼓掌][玫瑰]！'),
    likes: 198,
  },
  {
    id: 9601364723,
    username: '风吹半夏',
    avatarUrl: 'https://p2.music.126.net/8W1Y2Z3A4B5C6D7E8F9G0==/109951163074218321.jpg',
    time: '2024-08-11',
    rawTime: 1723334400000,
    content: parseCommentEmoji('无论听过多少新歌，这首在歌单里的位置永远无法被替代[比心][微笑]！'),
    likes: 156,
  },
  {
    id: 9601364724,
    username: '琴键上的光芒',
    avatarUrl: 'https://p2.music.126.net/rK1m9N2o3P4q5R6s7T8u9==/109951163250912384.jpg',
    time: '2024-09-03',
    rawTime: 1725321600000,
    content: parseCommentEmoji('编曲和词作放在现在看依然是天花板级别的存在[大笑][鼓掌]！'),
    likes: 115,
  },
  {
    id: 9601364725,
    username: '暮色归途',
    avatarUrl: 'https://p2.music.126.net/m7n9V3H4L1z0y8X1e2w3Q==/109951163825828552.jpg',
    time: '2024-10-14',
    rawTime: 1728864000000,
    content: parseCommentEmoji('深夜戴上耳机，所有的喧嚣都静止了，纯粹的感动[色][心]！'),
    likes: 98,
  },
]

const LATEST_COMMENTS_PRESETS: MVComment[] = [
  {
    id: 9801001,
    username: '半岛旧梦',
    avatarUrl: 'https://p2.music.126.net/NWv6PtSBkyWZzqbJVzBr7g==/109951169164936450.jpg',
    time: '刚刚',
    rawTime: Date.now() - 120000,
    content: parseCommentEmoji('刚刚重温完 MV 依然震撼！前奏一出来鸡皮疙瘩就起来了[大哭][强]'),
    likes: 2,
  },
  {
    id: 9801002,
    username: '晚风知我意',
    avatarUrl: 'https://p2.music.126.net/78q0jUUJ0h08GxAs2G-tCA==/109951168529051968.jpg',
    time: '15分钟前',
    rawTime: Date.now() - 900000,
    content: parseCommentEmoji('2026年了还有人在听这首歌吗？特地来打卡[憨笑][赞]'),
    likes: 5,
  },
  {
    id: 9801003,
    username: '晨光微曦',
    avatarUrl: 'https://p2.music.126.net/5KJI2mq0G0OQHQaAfAJfwg==/109951173289563385.jpg',
    time: '45分钟前',
    rawTime: Date.now() - 2700000,
    content: parseCommentEmoji('官方高清修复版真清晰，色彩和光影调校得太棒了[偷笑][玫瑰]'),
    likes: 1,
  },
  {
    id: 9801004,
    username: '北纬以南',
    avatarUrl: 'https://p2.music.126.net/Z2x6knGRr7eRrZeOlgCngA==/109951172414270313.jpg',
    time: '2小时前',
    rawTime: Date.now() - 7200000,
    content: parseCommentEmoji('这个桥段的处理真的太绝了，词作与旋律天花板[爱心][心]'),
    likes: 4,
  },
  {
    id: 9801005,
    username: '山河入梦',
    avatarUrl: 'https://p2.music.126.net/FlL7wkN6VBoGTj3Df7s2_w==/109951170316908673.jpg',
    time: '5小时前',
    rawTime: Date.now() - 18000000,
    content: parseCommentEmoji('被前奏狠狠击中，直接加入单曲循环列表[坏笑][干杯]'),
    likes: 0,
  },
  {
    id: 9801006,
    username: '落日弥漫',
    avatarUrl: 'https://p2.music.126.net/FLHG9Ou-sIq9F6dPe7SuNw==/109951169440811453.jpg',
    time: '12小时前',
    rawTime: Date.now() - 43200000,
    content: parseCommentEmoji('现在的流行乐很少能听到这种直击心灵的声音了[流泪][鼓掌]'),
    likes: 3,
  },
  {
    id: 9801007,
    username: '云端漫步',
    avatarUrl: 'https://p2.music.126.net/BtXjoRNLCZjoSV-3Ag3M0Q==/109951164458656122.jpg',
    time: '昨天',
    rawTime: Date.now() - 86400000,
    content: parseCommentEmoji('耳机里流淌着青春的回忆，百看不厌的经典神作[比心][微笑]'),
    likes: 6,
  },
  {
    id: 9801008,
    username: '星夜听海',
    avatarUrl: 'https://p2.music.126.net/YrjCHWk_OQhjlc5ycLpY3A==/109951172494696852.jpg',
    time: '2天前',
    rawTime: Date.now() - 172800000,
    content: parseCommentEmoji('第无数次打卡，每一次听都有全新的感动[强][太阳]'),
    likes: 1,
  },
]

const state = reactive({
  currentMV: {} as MVInfo,
  relatedMVs: [] as RelatedMV[],
  comments: [] as MVComment[],
  isPageLoading: true,
  isLiked: false,
  isDisliked: false,
  isSubscribed: false,
  isDescExpanded: false,
  isMixCollapsed: false,
  isMixDismissed: false,
  commentsSort: 'hot' as 'hot' | 'latest',
  isCommentsLoading: false,
  newCommentText: '',
  isCommentInputActive: false,
  isSubmittingComment: false,
  likedCommentIds: new Set<string>(),
  playerError: false,
  playerRetryKey: 0,
  // 瀑布式流式推荐状态
  isLoadingMoreRecommendations: false,
  hasMoreRecommendations: true,
  isRecommendError: false,
  recommendOffset: 0,
  maxRecommendationsCount: null as number | null,
})

const {
  currentMV,
  comments,
  isPageLoading,
  isLiked,
  isDisliked,
  isSubscribed,
  isDescExpanded,
} = toRefs(state)

/**
 * 下方推荐视频列表 (严格排除当前正在播放的 MV 与已在合辑内的全部曲目，零重复、零死循环)
 */
const displayRelatedMVs = computed(() => {
  const currentId = String(state.currentMV.id)
  const currentTitle = (state.currentMV.title || '').toLowerCase().trim()

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
  const list: RelatedMV[] = []

  for (const mv of state.relatedMVs) {
    if (!mv?.id) continue
    const idStr = String(mv.id)
    const titleNorm = (mv.title || '').toLowerCase().trim()

    // 1. 严格排除当前正在播放的视频 (禁止导向自己)
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
    list.push(mv)
  }

  // 若去重后推荐数量不足，从候选库补充，同样严格遵守排除规则
  if (list.length < 12) {
    for (const dm of DEFAULT_RECOMMEND_CANDIDATES) {
      const idStr = String(dm.id)
      const titleNorm = dm.title.toLowerCase().trim()
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

  if (state.maxRecommendationsCount && state.maxRecommendationsCount > 0) {
    return list.slice(0, state.maxRecommendationsCount)
  }

  return list
})

const playRelatedMV = (mv: any) => {
  if (!mv?.id) return
  router.push(`/mv-player/${mv.id}`)
}

const playMixTrack = (tr: RadarTrack) => {
  if (!tr?.id) return
  if (String(tr.id) === String(state.currentMV.id)) return
  router.push(`/mv-player/${tr.id}`)
}

/**
 * 视频播放结束自动接续播放合辑下一首
 */
const handleVideoEnded = () => {
  const tracks = radarAlbumStore.album.tracks
  if (!tracks.length) return
  const curId = String(state.currentMV.id)
  const currentIndex = tracks.findIndex((t: RadarTrack) => String(t.id) === curId)
  const nextTrack =
    currentIndex >= 0 && currentIndex < tracks.length - 1
      ? tracks[currentIndex + 1]
      : tracks[0]
  if (nextTrack?.id && String(nextTrack.id) !== curId) {
    router.push(`/mv-player/${nextTrack.id}`)
  }
}

/**
 * 检查是否已触达评论区终止线 (YouTube 规范：评论终止则瀑布流同时到底，严禁无底洞无限溢出)
 */
/**
 * 精算右侧推荐卡片可完美容纳的条目数量
 */
const calculateFitRecsCount = (availableH: number): number => {
  const cardH = 112
  const minGap = 8
  const maxCards = Math.floor((availableH + minGap) / (cardH + minGap))
  return Math.max(4, maxCards)
}

/**
 * 严格同步评论容器 (.space-y-2.5) 与推荐容器 (.space-y-2.5.pt-1) 终止线绝对齐平 (diff = 0px)
 */
const syncContainersAlignment = () => {
  if (typeof window === 'undefined' || window.innerWidth < 1280) {
    targetRecsHeight.value = null
    return
  }

  const cEl = commentsContainerRef.value
  const rEl = recsContainerRef.value
  if (!cEl || !rEl) return

  const cRect = cEl.getBoundingClientRect()
  const rRect = rEl.getBoundingClientRect()
  if (cRect.height <= 0) return

  // 计算右栏推荐列表容器为与左栏评论列表底边绝对齐平所需的高度
  const commentsBottom = cRect.bottom
  const recsTop = rRect.top
  const exactHeight = commentsBottom - recsTop

  if (exactHeight > 200) {
    targetRecsHeight.value = Math.round(exactHeight * 100) / 100
  }
}

/**
 * 检查是否已触达评论区终止线 (YouTube 规范：评论终止则瀑布同时到底，严禁无底洞无限溢出)
 */
const checkTerminationBoundary = (): boolean => {
  if (!state.hasMoreRecommendations) return true

  if (typeof window !== 'undefined' && window.innerWidth >= 1280) {
    const cEl = commentsContainerRef.value
    const rEl = recsContainerRef.value
    if (!cEl || !rEl) return false

    const cRect = cEl.getBoundingClientRect()
    const rRect = rEl.getBoundingClientRect()
    if (cRect.height <= 0) return false

    const availableH = cRect.bottom - rRect.top
    const fitCount = calculateFitRecsCount(availableH)

    if (displayRelatedMVs.value.length >= fitCount || rRect.bottom >= cRect.bottom - 40) {
      state.hasMoreRecommendations = false
      state.maxRecommendationsCount = fitCount
      nextTick(() => {
        syncContainersAlignment()
      })
      return true
    }
  } else {
    // 移动端：保持与评论数量同步的合理条数（约 20~24 部）
    const mobileMaxCount = Math.max(16, Math.min(24, (state.comments.length || 20) + 4))
    if (displayRelatedMVs.value.length >= mobileMaxCount) {
      state.hasMoreRecommendations = false
      return true
    }
  }

  return false
}

/**
 * 瀑布流无限滚动加载推荐视频 (YouTube 规格：当触及评论区终止线时同步到底)
 */
const loadMoreRecommendations = async () => {
  if (state.isLoadingMoreRecommendations || !state.hasMoreRecommendations) return
  if (checkTerminationBoundary()) return

  state.isLoadingMoreRecommendations = true
  state.isRecommendError = false

  try {
    const res: any = await mvAll({
      order: '最热',
      limit: 10,
      offset: state.recommendOffset,
    })
    let list: any[] = res?.data || res?.mvs || []

    if (!list.length && state.recommendOffset < 60) {
      // 降级使用 '最新' 排序以补充更多内容
      const fallbackRes: any = await mvAll({
        order: '最新',
        limit: 10,
        offset: state.recommendOffset,
      })
      list = fallbackRes?.data || fallbackRes?.mvs || []
    }

    if (!list.length) {
      state.hasMoreRecommendations = false
      return
    }

    const currentId = String(state.currentMV.id)
    const currentTitle = (state.currentMV.title || '').toLowerCase().trim()
    const mixIds = new Set(radarAlbumStore.album.tracks.map((tr: RadarTrack) => String(tr.id)))
    const mixTitles = new Set(radarAlbumStore.album.tracks.map((tr: RadarTrack) => (tr.name || '').toLowerCase().trim()))
    const existingIds = new Set(state.relatedMVs.map(m => String(m.id)))
    const existingTitles = new Set(state.relatedMVs.map(m => (m.title || '').toLowerCase().trim()))

    const newItems: RelatedMV[] = []
    for (const mv of list) {
      const idNum = Number(mv?.id)
      if (!idNum) continue
      const idStr = String(idNum)
      const title = mv?.name || mv?.title || ''
      const tNorm = title.toLowerCase().trim()

      if (idStr === currentId || (currentTitle && tNorm === currentTitle)) continue
      if (mixIds.has(idStr) || (tNorm && mixTitles.has(tNorm))) continue
      if (existingIds.has(idStr) || (tNorm && existingTitles.has(tNorm))) continue

      existingIds.add(idStr)
      if (tNorm) existingTitles.add(tNorm)
      newItems.push({
        id: idNum,
        title,
        artist: mv?.artistName || mv?.artists?.[0]?.name || '',
        duration: Math.floor((mv?.duration || 0) / 1000),
        playCount: String(mv?.playCount || ''),
        cover: mv?.cover || mv?.coverImg || mv?.picUrl || '',
        publishTime: mv?.publishTime || '',
        emoji: '🎵',
        gradient: 'from-sky-400 to-primary-500',
      })
    }

    state.relatedMVs.push(...newItems)
    state.recommendOffset += 10

    await nextTick()
    checkTerminationBoundary()
  } catch (err) {
    console.warn('[mv-player] error loading waterfall recommendations:', err)
    state.isRecommendError = true
  } finally {
    state.isLoadingMoreRecommendations = false
  }
}

/**
 * 监听主视区滚动，提前触发瀑布流下一页 (触及评论终止线时自动到底)
 */
const handleScroll = (e: Event) => {
  const el = e.target as HTMLElement
  if (!el || state.isLoadingMoreRecommendations) return
  if (!state.hasMoreRecommendations) {
    syncContainersAlignment()
    return
  }
  if (checkTerminationBoundary()) return

  if (el.scrollHeight - el.scrollTop - el.clientHeight < 350) {
    loadMoreRecommendations()
  }
}

const loadMV = async (id: number) => {
  state.playerError = false
  state.recommendOffset = 0
  state.hasMoreRecommendations = true
  state.isRecommendError = false
  state.isLoadingMoreRecommendations = false
  try {
    const [detailRes, urlRes, simiRes, allRes] = await Promise.allSettled([
      mvDetail({ mvid: id }),
      mvUrl({ id }),
      simiMv({ mvid: id }),
      mvAll({ order: '最热', limit: 14, offset: 0 }),
    ])
    const d: any =
      detailRes.status === 'fulfilled'
        ? (detailRes.value as any)?.data || (detailRes.value as any) || {}
        : {}
    const u: any =
      urlRes.status === 'fulfilled'
        ? (urlRes.value as any)?.data || (urlRes.value as any) || {}
        : {}
    const sList: any[] =
      simiRes.status === 'fulfilled'
        ? (simiRes.value as any)?.mvs || (simiRes.value as any)?.data || []
        : []
    const aList: any[] =
      allRes.status === 'fulfilled'
        ? (allRes.value as any)?.data || (allRes.value as any)?.mvs || []
        : []

    const brs = d?.brs || {}
    const fallbackUrl =
      brs['1080'] || brs['720'] || brs['480'] || brs['240'] || Object.values(brs)[0] || ''
    const videoUrl = u?.url || u?.data?.url || fallbackUrl || ''

    state.currentMV = {
      id: Number(d?.id ?? id),
      title: d?.name || d?.title || '广岛之恋',
      artist: d?.artistName || d?.artists?.[0]?.name || '莫文蔚',
      artistId: d?.artistId || d?.artists?.[0]?.id || 0,
      duration: Math.floor((d?.duration || 320000) / 1000),
      cover: d?.cover || d?.coverImg || 'https://p2.music.126.net/6y-UleORITEDbvrOLAssGQ==/109951163996500858.jpg',
      playCount: String(d?.playCount || d?.playCountTxt || '852000'),
      likes: String(d?.likedCount || '852000'),
      publishDate: d?.publishTime || d?.publishDate || '1997-01-01',
      category: d?.subed ? t('mv.subscribed') : t('mv.categoryFallback'),
      emoji: '🎬',
      gradient: 'from-blue-500 to-primary-600',
      liked: !!d?.liked,
      isNew: false,
      description: d?.desc || d?.briefDesc || `${d?.artistName || '莫文蔚'} 经典官方高清音乐视频。`,
      url: videoUrl,
    }

    state.isLiked = libraryStore.isMvLiked(state.currentMV.id)
    state.playerError = !state.currentMV.url
    state.playerRetryKey += 1

    const rawFeed = [...sList, ...aList]
    state.relatedMVs = rawFeed.map(
      (mv: any): RelatedMV => ({
        id: Number(mv?.id),
        title: mv?.name || mv?.title || '',
        artist: mv?.artistName || mv?.artists?.[0]?.name || '',
        duration: Math.floor((mv?.duration || 0) / 1000),
        playCount: String(mv?.playCount || ''),
        cover: mv?.cover || mv?.coverImg || mv?.picUrl || '',
        publishTime: mv?.publishTime || state.currentMV.publishDate || '',
        emoji: '🎵',
        gradient: 'from-sky-400 to-primary-500',
      })
    )
    state.recommendOffset = 14

    // 上报行为信号
    recommendStore.recordEvent({
      type: 'open',
      entity_type: 'mv',
      entity_id: String(id),
      track: {
        id,
        name: state.currentMV.title,
        artist: state.currentMV.artist,
        cover: state.currentMV.cover,
      },
    })

    // 基于当前播放的 MV 与关联视频生成专属合辑 (内部严格排除当前曲目)
    radarAlbumStore.generateRadarAlbum(
      {
        id: state.currentMV.id,
        name: state.currentMV.title,
        artist: state.currentMV.artist,
        cover: state.currentMV.cover,
        duration: state.currentMV.duration,
        description: state.currentMV.description,
        playCount: state.currentMV.playCount,
        publishTime: state.currentMV.publishDate,
        url: state.currentMV.url,
      },
      state.relatedMVs
    )
    await nextTick()
    checkTerminationBoundary()
  } catch {
    state.playerError = true
  } finally {
    state.isPageLoading = false
  }
}

const handlePlayerError = () => {
  state.playerError = true
}

const retryVideo = async () => {
  const id = Number(route.params.id)
  if (!Number.isNaN(id)) {
    state.playerError = false
    state.playerRetryKey += 1
    await loadMV(id)
  }
}

const getCommentKey = (c: MVComment, idx?: number): string => {
  if (c.id) return String(c.id)
  return `${state.currentMV.id || 0}_${c.username}_${c.time || idx || 0}`
}

const loadComments = async (id: number, overrideSortType?: 1 | 2 | 3) => {
  state.isCommentsLoading = true
  try {
    const sortType: 1 | 2 | 3 = overrideSortType ?? (state.commentsSort === 'latest' ? 3 : 1)
    const res: any = await commentNew({ id, type: 1, sortType, pageNo: 1, pageSize: 25 })
    const list: any[] = res?.data?.comments || res?.comments || []
    let remoteComments: MVComment[] = list.map((c, i) => {
      const commentId = c?.commentId || c?.id || `remote_${id}_${sortType}_${i}`
      const key = String(commentId)
      return {
        id: commentId,
        username: c?.user?.nickname || t('mvPlayer.comments.user'),
        avatarUrl: c?.user?.avatarUrl || '',
        time: c?.timeStr || (c?.time ? formatDateTime(c.time) : ''),
        rawTime: Number(c?.time || 0),
        content: parseCommentEmoji(c?.content || ''),
        likes: Number(c?.likedCount ?? c?.likes ?? 0),
        expressionUrl: extractExpressionUrl(c),
        isLiked: state.likedCommentIds.has(key),
      }
    })

    // 若远端无数据，使用高品质对应排序模式的数据
    if (!remoteComments.length) {
      const presets = sortType === 3 ? LATEST_COMMENTS_PRESETS : HOT_COMMENTS_PRESETS
      remoteComments = presets.map((c, i) => {
        const key = getCommentKey(c, i)
        return {
          ...c,
          isLiked: state.likedCommentIds.has(key),
        }
      })
    }

    // 严密排序逻辑保障 (确保无论远端返回何种顺序，界面均具备明确筛选区分)：
    // 若为“最新评论”，按时间绝对倒序排列 (最新在前)
    // 若为“最热评论”，按点赞数绝对倒序排列 (高赞在前)
    if (sortType === 3) {
      remoteComments.sort((a, b) => (b.rawTime || 0) - (a.rawTime || 0))
    } else {
      remoteComments.sort((a, b) => (b.likes || 0) - (a.likes || 0))
    }

    // 优先加载站内本地存储的评论 (DB 优先级最高，置于最顶端)
    const localComments: MVComment[] = getLocalMVComments(id).map((c, i) => {
      const key = getCommentKey(c, i)
      return {
        ...c,
        isLiked: state.likedCommentIds.has(key),
      }
    })

    // 给予平滑过渡延时，让用户清晰感知真实刷新加载过程 (用户体验)
    await new Promise(r => setTimeout(r, 150))

    state.comments = [...localComments, ...remoteComments]
    await nextTick()
    checkTerminationBoundary()
    syncContainersAlignment()
  } catch {
  } finally {
    state.isCommentsLoading = false
  }
}

const changeCommentsSort = async (sort: 'hot' | 'latest') => {
  if (state.commentsSort === sort) {
    isSortDropdownOpen.value = false
    return
  }
  state.commentsSort = sort
  isSortDropdownOpen.value = false
  const sortType: 1 | 2 | 3 = sort === 'latest' ? 3 : 1
  await loadComments(state.currentMV.id, sortType)
}

const handleCommentLike = (c: MVComment, idx: number) => {
  if (!authStore.isAuthenticated) {
    toastStore.show({
      message: '请先登录epomail账户，再进行点赞',
      type: 'warning',
      duration: 2500,
    })
    return
  }

  const key = getCommentKey(c, idx)
  const isCurrentlyLiked = c.isLiked || state.likedCommentIds.has(key)

  if (isCurrentlyLiked) {
    c.isLiked = false
    c.likes = Math.max(0, (c.likes || 1) - 1)
    state.likedCommentIds.delete(key)
    toggleLikedCommentId(key, false)
  } else {
    c.isLiked = true
    c.likes = (c.likes || 0) + 1
    state.likedCommentIds.add(key)
    toggleLikedCommentId(key, true)
  }
}

const handleCommentReply = (_c: MVComment) => {
  if (!authStore.isAuthenticated) {
    toastStore.show({
      message: '请先登录epomail账户，再进行回复',
      type: 'warning',
      duration: 2500,
    })
    return
  }

  if (!hasLocalCommentDB()) {
    toastStore.show({
      message: '该功能暂未开放',
      type: 'warning',
      duration: 2500,
    })
    return
  }

  // 激活评论框并聚焦 (回复底层统一转为对 MV 的整体评论)
  state.isCommentInputActive = true
  nextTick(() => {
    commentInputRef.value?.focus()
  })
}

const handleCommentInputFocus = () => {
  state.isCommentInputActive = true
}

const cancelComment = () => {
  state.newCommentText = ''
  state.isCommentInputActive = false
}

const submitComment = async () => {
  if (!authStore.isAuthenticated) {
    toastStore.show({
      message: '请先登录epomail账户，再进行回复',
      type: 'warning',
      duration: 2500,
    })
    return
  }

  const text = state.newCommentText.trim()
  if (!text) {
    toastStore.show({
      message: '请输入评论内容',
      type: 'warning',
      duration: 2000,
    })
    return
  }

  if (!hasLocalCommentDB()) {
    toastStore.show({
      message: '该功能暂未开放',
      type: 'warning',
      duration: 2500,
    })
    return
  }

  state.isSubmittingComment = true
  try {
    const newComment: MVComment = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      username: authStore.userName || 'Sonic 用户',
      avatarUrl: authStore.userAvatar || '',
      time: '刚刚',
      content: parseCommentEmoji(text),
      likes: 0,
      isLiked: false,
    }

    const saved = await saveLocalMVComment(state.currentMV.id, newComment)
    if (saved) {
      state.comments.unshift(newComment)
      state.newCommentText = ''
      state.isCommentInputActive = false
      toastStore.show({
        message: '评论发布成功',
        type: 'success',
        duration: 2000,
      })
      await nextTick()
      checkTerminationBoundary()
      syncContainersAlignment()
    } else {
      toastStore.show({
        message: '该功能暂未开放',
        type: 'warning',
        duration: 2500,
      })
    }
  } finally {
    state.isSubmittingComment = false
  }
}

const toggleLike = () => {
  const mv = state.currentMV
  if (!mv.id) return
  if (state.isDisliked) state.isDisliked = false
  state.isLiked = libraryStore.toggleLikeMv({
    id: mv.id,
    name: mv.title,
    artist: mv.artist,
    cover: mv.cover,
  })
}

const toggleDislike = () => {
  state.isDisliked = !state.isDisliked
  if (state.isDisliked) {
    if (state.isLiked) {
      state.isLiked = false
      libraryStore.toggleLikeMv({
        id: state.currentMV.id,
        name: state.currentMV.title,
        artist: state.currentMV.artist,
        cover: state.currentMV.cover,
      })
    }
  }
}

const toggleSubscribe = () => {
  state.isSubscribed = !state.isSubscribed
  toastStore.show({
    message: state.isSubscribed
      ? `已关注 ${state.currentMV.artist}`
      : `已取消关注 ${state.currentMV.artist}`,
    type: 'success',
    duration: 2500,
  })
}

const shareMV = async () => {
  const resolved = router.resolve({
    name: 'mv-player',
    params: { id: String(state.currentMV.id) },
  }).href
  const url = new URL(resolved, location.origin).href
  try {
    if (navigator.share) {
      await navigator.share({ title: state.currentMV.title, url })
    } else {
      await navigator.clipboard.writeText(url)
      toastStore.show({ message: t('common.linkCopied'), type: 'success' })
    }
  } catch {}
}

const collectMV = () => {
  toggleLike()
  toastStore.show({
    message: state.isLiked ? '已保存至「我喜欢的 MV」' : '已移出「我喜欢的 MV」',
    type: 'success',
    duration: 2500,
  })
}

const handleDocumentClick = (e: MouseEvent) => {
  if (
    isSortDropdownOpen.value &&
    sortDropdownRef.value &&
    !sortDropdownRef.value.contains(e.target as Node)
  ) {
    isSortDropdownOpen.value = false
  }
}

watch(
  () => route.params.id,
  id => {
    const mvId = Number(id)
    if (!Number.isNaN(mvId)) {
      state.isPageLoading = true
      state.isDescExpanded = false
      // 下次进入时重新呈现专属合辑 (满足用户要求：本次叉掉，下次进入时出现)
      state.isMixDismissed = false
      state.isMixCollapsed = false
      state.recommendOffset = 0
      state.hasMoreRecommendations = true
      state.isRecommendError = false
      state.isLoadingMoreRecommendations = false
      state.maxRecommendationsCount = null
      targetRecsHeight.value = null
      loadMV(mvId)
      loadComments(mvId)
    }
  },
  { immediate: true }
)

onMounted(() => {
  state.likedCommentIds = getLikedCommentIds()
  window.addEventListener('resize', syncContainersAlignment)
  document.addEventListener('click', handleDocumentClick)
})

onUnmounted(() => {
  window.removeEventListener('resize', syncContainersAlignment)
  document.removeEventListener('click', handleDocumentClick)
})

watch(
  () => [state.isDescExpanded, state.isMixCollapsed, state.isMixDismissed],
  () => {
    nextTick(() => {
      checkTerminationBoundary()
      syncContainersAlignment()
    })
  }
)
</script>

<template>
  <div class="flex-1 overflow-hidden">
    <div class="h-full overflow-auto" @scroll.passive="handleScroll">
      <PageSkeleton v-if="isPageLoading" :sections="['player']" />
      <template v-else>
        <div class="mx-auto max-w-[1720px] p-4 lg:p-6">
          <!-- 主从两列布局（左侧 8 列主播放器，右侧 4 列与播放器自然对齐的合辑与推荐） -->
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <!-- 左侧主播放与信息视区 (8 列) -->
            <div class="xl:col-span-8">
              <!-- 视频播放器 (16:9 无多余粗边框，轻质微磨砂底) -->
              <div class="overflow-hidden rounded-2xl border border-glass-subtle bg-black shadow-2xl">
                <div class="aspect-video w-full">
                  <Artplayer
                    v-if="currentMV.url && !state.playerError"
                    :key="state.playerRetryKey"
                    :src="currentMV.url"
                    :title="currentMV.title"
                    :poster="currentMV.cover"
                    :autoplay="true"
                    :muted="false"
                    class="aspect-video h-full!"
                    @ended="handleVideoEnded"
                    @error="handlePlayerError"
                  />
                  <div
                    v-else
                    class="flex h-full w-full flex-col items-center justify-center gap-3 bg-primary/5 px-6 text-center"
                  >
                    <span class="icon-[mdi--video-off-outline] text-primary/30 h-12 w-12"></span>
                    <p class="text-primary/70 text-sm">
                      {{
                        currentMV.url
                          ? $t('mvPlayer.videoError')
                          : $t('mvPlayer.videoUnavailable')
                      }}
                    </p>
                    <Button
                      variant="soft"
                      size="sm"
                      rounded="full"
                      class="min-h-9 px-4 text-xs"
                      @click="retryVideo"
                    >
                      <span class="icon-[mdi--refresh] mr-1.5 h-4 w-4"></span>
                      {{ $t('common.retry') }}
                    </Button>
                  </div>
                </div>
              </div>

              <!-- 第一层级：H1 大字体标题 (YouTube 标配) -->
              <h1 class="text-primary mt-4 mb-3 text-xl font-bold tracking-tight sm:text-2xl leading-snug">
                {{ currentMV.title }}
              </h1>

              <!-- 第二层级：频道栏与 YouTube 风格组合胶囊操作栏 (自然柔化分割线) -->
              <div class="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-glass-subtle">
                <!-- 歌手栏：头像 + 歌手名 + 粉丝状态 + 关注按钮 -->
                <div class="flex items-center gap-3">
                  <img
                    :src="formatCoverUrl(currentMV.cover, { size: 96 })"
                    :alt="currentMV.artist"
                    class="h-10 w-10 shrink-0 rounded-full object-cover border border-glass-subtle shadow-sm"
                  />
                  <div>
                    <div class="flex items-center gap-1.5">
                      <span
                        class="text-primary font-semibold text-sm hover:text-sky-400 cursor-pointer transition-colors"
                        @click="router.push(`/artist/${currentMV.artistId}`)"
                      >
                        {{ currentMV.artist }}
                      </span>
                      <span class="icon-[mdi--check-decagram] text-sky-400 h-3.5 w-3.5" title="认证音乐人"></span>
                    </div>
                    <p class="text-primary/50 text-[11px]">官方音乐频道</p>
                  </div>
                  <button
                    type="button"
                    class="ml-2 rounded-full px-3.5 py-1 text-xs font-semibold transition-all duration-200 border"
                    :class="
                      isSubscribed
                        ? 'bg-surface-glass text-primary/70 border-glass-subtle hover:bg-hover-glass'
                        : 'bg-primary text-black border-transparent hover:opacity-90 shadow-sm'
                    "
                    @click="toggleSubscribe"
                  >
                    {{ isSubscribed ? '已关注' : '关注' }}
                  </button>
                </div>

                <!-- YouTube 风格组合药丸按钮条 (36px 高度胶囊) -->
                <div class="flex items-center gap-2 flex-wrap">
                  <!-- 点赞与点踩组合胶囊 -->
                  <div class="inline-flex items-center rounded-full bg-surface-glass border border-glass-subtle h-9 px-1">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium transition-colors hover:text-sky-400 cursor-pointer"
                      :class="isLiked ? 'text-sky-400 font-semibold' : 'text-primary/80'"
                      :title="isLiked ? t('mvPlayer.actions.liked') : t('mvPlayer.actions.like')"
                      @click="toggleLike"
                    >
                      <span
                        class="h-4 w-4"
                        :class="isLiked ? 'icon-[mdi--thumb-up]' : 'icon-[mdi--thumb-up-outline]'"
                      ></span>
                      <span>{{ formatCount(currentMV.likes || currentMV.playCount) }}</span>
                    </button>
                    <span class="h-3.5 w-px bg-glass"></span>
                    <button
                      type="button"
                      class="flex items-center px-2.5 py-1 text-xs transition-colors hover:text-rose-400 cursor-pointer"
                      :class="isDisliked ? 'text-rose-400 font-semibold' : 'text-primary/60'"
                      title="不喜欢"
                      @click="toggleDislike"
                    >
                      <span
                        class="h-4 w-4"
                        :class="isDisliked ? 'icon-[mdi--thumb-down]' : 'icon-[mdi--thumb-down-outline]'"
                      ></span>
                    </button>
                  </div>

                  <!-- 分享胶囊 -->
                  <button
                    type="button"
                    class="flex h-9 items-center gap-1.5 rounded-full bg-surface-glass hover:bg-hover-glass border border-glass-subtle px-3.5 text-xs font-medium text-primary transition-colors cursor-pointer"
                    @click="shareMV"
                  >
                    <span class="icon-[mdi--share-variant-outline] h-4 w-4"></span>
                    <span>{{ t('mvPlayer.actions.share') }}</span>
                  </button>

                  <!-- 收藏至歌单胶囊 -->
                  <button
                    type="button"
                    class="flex h-9 items-center gap-1.5 rounded-full bg-surface-glass hover:bg-hover-glass border border-glass-subtle px-3.5 text-xs font-medium text-primary transition-colors cursor-pointer"
                    @click="collectMV"
                  >
                    <span
                      class="h-4 w-4"
                      :class="isLiked ? 'icon-[mdi--bookmark-check] text-sky-400' : 'icon-[mdi--bookmark-plus-outline]'"
                    ></span>
                    <span>收藏</span>
                  </button>
                </div>
              </div>

              <!-- 第三层级：YouTube 风格结构化简介卡 (含 7 阶时区相对时间) -->
              <div
                class="glass-card mt-4 rounded-2xl p-4 border border-glass-subtle transition-all duration-200 hover:bg-hover-glass cursor-pointer"
                @click="isDescExpanded = !isDescExpanded"
              >
                <!-- 首行显眼聚合元信息：播放次数 • 相对时间 • 话题标签 -->
                <div class="flex items-center gap-2 text-xs font-semibold text-primary flex-wrap">
                  <span>{{ formatCount(currentMV.playCount) }} 次观看</span>
                  <span class="text-primary/30">•</span>
                  <span>{{ formatRelativeTimeYT(currentMV.publishDate) }}</span>
                  <span class="text-primary/30">•</span>
                  <span class="text-sky-400">#Sonic甄选</span>
                  <span class="text-sky-400">#{{ currentMV.artist }}</span>
                </div>

                <!-- 简介文本 (未展开时自然双行截断，无额外生硬省略符) -->
                <p
                  class="mt-2 text-xs sm:text-sm text-primary/75 leading-relaxed"
                  :class="isDescExpanded ? '' : 'line-clamp-2'"
                >
                  {{
                    currentMV.description ||
                    `${currentMV.artist} 精彩官方高清音乐视频。`
                  }}
                </p>

                <!-- 展开后展示：此视频关联信息 -->
                <div v-if="isDescExpanded" class="mt-4 pt-3 border-t border-glass-subtle space-y-2 text-xs">
                  <h4 class="text-primary font-semibold text-[13px] flex items-center gap-1.5">
                    <span class="icon-[mdi--music-box-outline] text-sky-400 h-4 w-4"></span>
                    视频详细信息
                  </h4>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-primary/70">
                    <div>
                      <span class="text-primary/40 mr-1.5">曲目:</span>
                      <span class="text-primary font-medium">{{ currentMV.title }}</span>
                    </div>
                    <div>
                      <span class="text-primary/40 mr-1.5">艺术家:</span>
                      <span class="text-primary font-medium">{{ currentMV.artist }}</span>
                    </div>
                    <div>
                      <span class="text-primary/40 mr-1.5">发行时间:</span>
                      <span>{{ currentMV.publishDate || '近期上线' }}</span>
                    </div>
                  </div>
                </div>

                <!-- 折叠/展开切换按钮 (最小信息密度，绝对禁止出现 "...展开") -->
                <div class="mt-2.5 flex items-center text-xs font-semibold text-primary/75 hover:text-sky-400 transition-colors">
                  <span>{{ isDescExpanded ? '收起' : '展开' }}</span>
                  <span
                    class="h-3.5 w-3.5 ml-0.5"
                    :class="isDescExpanded ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'"
                  ></span>
                </div>
              </div>

              <!-- 第四层级：评论区 (支持表情符号 Emoji 渲染与表情包展示) -->
              <section class="mt-8">
                <div class="flex items-center justify-between mb-5">
                  <div class="flex items-center gap-3">
                    <h2 class="text-primary text-lg font-bold">
                      {{ t('mvPlayer.comments.title') }}
                    </h2>
                    <span class="text-primary/50 text-sm font-medium">
                      {{ comments.length }} 条评论
                    </span>
                  </div>

                  <!-- 排序方式：支持最热评论与最新评论切换 (YouTube 规范) -->
                  <div ref="sortDropdownRef" class="relative">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 text-xs text-primary/70 hover:text-primary transition-colors cursor-pointer py-1.5 px-2.5 rounded-lg hover:bg-hover-glass border border-transparent hover:border-glass-subtle"
                      :disabled="state.isCommentsLoading"
                      @click="isSortDropdownOpen = !isSortDropdownOpen"
                    >
                      <span
                        class="h-4 w-4"
                        :class="state.isCommentsLoading ? 'icon-[mdi--loading] animate-spin text-sky-400' : 'icon-[mdi--sort-variant]'"
                      ></span>
                      <span>排序方式: {{ state.commentsSort === 'latest' ? '最新评论' : '最热评论' }}</span>
                      <span
                        class="icon-[mdi--chevron-down] h-3.5 w-3.5 ml-0.5 transition-transform duration-200"
                        :class="{ 'rotate-180': isSortDropdownOpen }"
                      ></span>
                    </button>

                    <!-- 下拉选择菜单 -->
                    <div
                      v-if="isSortDropdownOpen"
                      class="absolute right-0 top-full mt-1.5 w-32 rounded-xl bg-surface-glass border border-glass-subtle shadow-xl backdrop-blur-md py-1 z-20 text-xs overflow-hidden"
                    >
                      <button
                        type="button"
                        class="w-full text-left px-3 py-2 flex items-center justify-between transition-colors hover:bg-hover-glass cursor-pointer"
                        :class="state.commentsSort === 'hot' ? 'text-sky-400 font-semibold' : 'text-primary/75'"
                        @click="changeCommentsSort('hot')"
                      >
                        <div class="flex items-center gap-1.5">
                          <span class="icon-[mdi--fire] h-3.5 w-3.5 text-amber-400"></span>
                          <span>最热评论</span>
                        </div>
                        <span v-if="state.commentsSort === 'hot'" class="icon-[mdi--check] h-3.5 w-3.5 text-sky-400"></span>
                      </button>
                      <button
                        type="button"
                        class="w-full text-left px-3 py-2 flex items-center justify-between transition-colors hover:bg-hover-glass cursor-pointer"
                        :class="state.commentsSort === 'latest' ? 'text-sky-400 font-semibold' : 'text-primary/75'"
                        @click="changeCommentsSort('latest')"
                      >
                        <div class="flex items-center gap-1.5">
                          <span class="icon-[mdi--clock-time-four-outline] h-3.5 w-3.5 text-sky-400"></span>
                          <span>最新评论</span>
                        </div>
                        <span v-if="state.commentsSort === 'latest'" class="icon-[mdi--check] h-3.5 w-3.5 text-sky-400"></span>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- YouTube 风格置顶评论输入框 -->
                <div class="mb-6 flex gap-3.5 items-start">
                  <!-- 用户头像 -->
                  <div class="shrink-0 pt-0.5">
                    <img
                      v-if="authStore.userAvatar"
                      :src="formatCoverUrl(authStore.userAvatar, { size: 80 })"
                      class="h-9 w-9 rounded-full object-cover border border-glass-subtle shadow-sm"
                    />
                    <div
                      v-else-if="authStore.isAuthenticated"
                      class="flex h-9 w-9 items-center justify-center rounded-full bg-linear-to-br from-sky-400 to-blue-500 text-xs font-bold text-slate-100 shadow-sm"
                    >
                      {{ authStore.userInitial }}
                    </div>
                    <div
                      v-else
                      class="flex h-9 w-9 items-center justify-center rounded-full bg-surface-glass border border-glass-subtle text-primary/40 text-xs shadow-sm"
                    >
                      <span class="icon-[mdi--account-outline] h-5 w-5"></span>
                    </div>
                  </div>

                  <!-- 输入区域 -->
                  <div class="flex-1 min-w-0">
                    <textarea
                      ref="commentInputRef"
                      v-model="state.newCommentText"
                      rows="1"
                      placeholder="添加评论..."
                      class="w-full resize-none border-b border-glass-subtle bg-transparent py-1.5 text-xs sm:text-sm text-primary placeholder:text-primary/40 focus:border-sky-400 focus:outline-hidden transition-all duration-200"
                      :class="{ 'min-h-[64px]': state.isCommentInputActive }"
                      @focus="handleCommentInputFocus"
                      @keydown.ctrl.enter="submitComment"
                      @keydown.meta.enter="submitComment"
                    ></textarea>

                    <!-- 操作按键 (获得焦点或有内容时展示) -->
                    <div
                      v-if="state.isCommentInputActive || state.newCommentText"
                      class="mt-2 flex items-center justify-end gap-2"
                    >
                      <button
                        type="button"
                        class="rounded-full px-3.5 py-1.5 text-xs font-medium text-primary/70 hover:bg-hover-glass hover:text-primary transition-colors cursor-pointer"
                        @click="cancelComment"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        class="rounded-full px-4 py-1.5 text-xs font-semibold text-slate-100 transition-all cursor-pointer shadow-sm"
                        :class="
                          state.newCommentText.trim() && !state.isSubmittingComment
                            ? 'bg-sky-500 hover:bg-sky-400'
                            : 'bg-primary/20 text-primary/40 cursor-not-allowed'
                        "
                        :disabled="!state.newCommentText.trim() || state.isSubmittingComment"
                        @click="submitComment"
                      >
                        {{ state.isSubmittingComment ? '发送中...' : '评论' }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 评论列表加载过渡状态 -->
                <div
                  v-if="state.isCommentsLoading"
                  class="glass-card flex flex-col items-center justify-center py-12 rounded-2xl border border-glass-subtle space-y-2"
                >
                  <span class="icon-[mdi--loading] animate-spin h-7 w-7 text-sky-400"></span>
                  <p class="text-primary/60 text-xs font-medium">
                    正在加载{{ state.commentsSort === 'latest' ? '最新评论' : '最热评论' }}...
                  </p>
                </div>

                <!-- 评论列表 -->
                <div v-else-if="comments.length" ref="commentsContainerRef" class="space-y-2.5">
                  <div
                    v-for="(c, i) in comments"
                    :key="c.id || i"
                    class="glass-card flex gap-3.5 p-3.5 rounded-2xl border border-glass-subtle transition-all duration-200 hover:bg-hover-glass"
                  >
                    <img
                      v-if="c.avatarUrl"
                      :src="formatCoverUrl(c.avatarUrl, { size: 80 })"
                      class="h-9 w-9 shrink-0 rounded-full object-cover border border-glass-subtle"
                      referrerpolicy="no-referrer"
                    />
                    <div
                      v-else
                      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-sky-400 to-blue-500 text-xs font-bold text-slate-100"
                    >
                      {{ c.username.charAt(0) }}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="mb-1 flex items-center justify-between gap-2">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <span class="text-primary text-xs font-semibold truncate">{{ c.username }}</span>
                          <span
                            v-if="state.commentsSort === 'hot' && i < 3 && c.likes > 200"
                            class="rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-[9px] font-semibold text-amber-400 shrink-0"
                          >
                            热门
                          </span>
                          <span
                            v-else-if="c.time === '刚刚' || (c.rawTime && Date.now() - c.rawTime < 3600000)"
                            class="rounded-full bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.2 text-[9px] font-semibold text-sky-400 shrink-0"
                          >
                            最新
                          </span>
                        </div>
                        <span class="text-primary/40 text-[11px] shrink-0">{{ c.time }}</span>
                      </div>
                      <!-- 评论文本：原生纯正 Emoji 渲染，支持 [憨笑] [奸笑] 等符号自然显示 -->
                      <p class="text-primary/80 text-xs leading-relaxed select-text font-sans">
                        {{ c.content }}
                      </p>
                      <!-- 贴纸表情图片展示 -->
                      <img
                        v-if="c.expressionUrl"
                        :src="c.expressionUrl"
                        alt="表情"
                        class="mt-2 max-h-24 max-w-24 rounded-lg object-contain bg-surface-glass border border-glass-subtle"
                        loading="lazy"
                      />
                      <div class="mt-2 flex items-center gap-3 text-xs text-primary/50">
                        <button
                          type="button"
                          class="flex items-center gap-1 cursor-pointer transition-colors"
                          :class="c.isLiked ? 'text-sky-400 font-semibold' : 'hover:text-sky-400 text-primary/50'"
                          @click="handleCommentLike(c, i)"
                        >
                          <span
                            class="h-3.5 w-3.5"
                            :class="c.isLiked ? 'icon-[mdi--thumb-up]' : 'icon-[mdi--thumb-up-outline]'"
                          ></span>
                          <span :class="{ 'font-semibold text-sky-400/90': state.commentsSort === 'hot' && c.likes > 100 }">
                            {{ c.likes || 0 }}
                          </span>
                        </button>
                        <button
                          type="button"
                          class="hover:text-primary cursor-pointer text-[11px] transition-colors"
                          @click="handleCommentReply(c)"
                        >
                          回复
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-else class="glass-card flex flex-col items-center justify-center py-12 rounded-2xl border border-glass-subtle">
                  <span class="icon-[mdi--comment-off-outline] text-primary/20 mb-2 h-10 w-10"></span>
                  <p class="text-primary/40 text-xs">{{ t('mvPlayer.comments.empty') }}</p>
                </div>
              </section>
            </div>

            <!-- 右侧伴随视区 (4 列)：专属合辑 (支持收起/叉掉关闭，排除当前播放视频) + 紧凑推荐列表 -->
            <aside class="xl:col-span-4 space-y-4">
              <!-- 1. 置顶“专属合辑” (YouTube Mix 模式：自适应/对齐高度，支持收起与叉掉关闭) -->
              <div
                v-if="!state.isMixDismissed"
                class="glass-card overflow-hidden rounded-2xl border border-glass-subtle flex flex-col transition-all duration-300 shadow-sm"
                :class="state.isMixCollapsed ? 'h-auto shrink-0' : 'h-[460px] xl:h-[490px]'"
              >
                <!-- 合辑头部：标题 + 数量Tag + 展开/收起 + 叉掉关闭 -->
                <div class="p-3 bg-surface-glass/40 border-b border-glass-subtle shrink-0">
                  <div class="flex items-center justify-between">
                    <div
                      class="flex items-center gap-2 cursor-pointer select-none"
                      @click="state.isMixCollapsed = !state.isMixCollapsed"
                      title="点击展开/收起合辑"
                    >
                      <h3 class="text-primary font-bold text-sm tracking-tight">
                        {{ radarAlbumStore.album.title }}
                      </h3>
                      <span class="text-[11px] font-medium text-primary/50 px-1.5 py-0.2 rounded bg-surface-glass border border-glass-subtle">
                        {{ radarAlbumStore.totalCountDisplay }}
                      </span>
                    </div>

                    <div class="flex items-center gap-1 text-primary/60">
                      <!-- 收起 / 展开 按钮 -->
                      <button
                        type="button"
                        class="p-1 rounded-lg hover:bg-hover-glass hover:text-primary transition-colors cursor-pointer"
                        :title="state.isMixCollapsed ? '展开合辑' : '收起合辑'"
                        @click="state.isMixCollapsed = !state.isMixCollapsed"
                      >
                        <span
                          class="h-4 w-4 block transition-transform duration-200"
                          :class="state.isMixCollapsed ? 'icon-[mdi--chevron-down]' : 'icon-[mdi--chevron-up]'"
                        ></span>
                      </button>

                      <!-- 叉掉关闭按钮 (本次关闭，下次进入时恢复) -->
                      <button
                        type="button"
                        class="p-1 rounded-lg hover:bg-hover-glass hover:text-rose-400 transition-colors cursor-pointer"
                        title="关闭合辑"
                        @click="state.isMixDismissed = true"
                      >
                        <span class="icon-[mdi--close] h-4 w-4 block"></span>
                      </button>
                    </div>
                  </div>
                  <p v-if="!state.isMixCollapsed" class="text-primary/50 text-[11px] mt-1 leading-normal">
                    {{ radarAlbumStore.album.subtitle }}
                  </p>
                </div>

                <!-- 合辑内影片列表 (仅在未收起时展示，滑块对齐，严格排除当前播放的视频，无刻意生硬横线) -->
                <div
                  v-show="!state.isMixCollapsed"
                  class="flex-1 overflow-y-auto p-1.5 space-y-1 text-xs select-none"
                  style="scrollbar-width: thin;"
                >
                  <div
                    v-for="(tr, idx) in radarAlbumStore.album.tracks"
                    :key="tr.id"
                    class="flex items-center gap-2.5 p-2 rounded-xl transition-all cursor-pointer group hover:bg-hover-glass"
                    @click="playMixTrack(tr)"
                  >
                    <!-- 序号 -->
                    <div class="w-4 shrink-0 text-center font-mono text-[11px] text-primary/40 group-hover:text-sky-400">
                      {{ Number(idx) + 1 }}
                    </div>

                    <!-- 影片 16:9 缩略图 -->
                    <div class="relative shrink-0 overflow-hidden rounded-lg aspect-video w-28 sm:w-32 bg-black/50">
                      <LazyImage
                        :src="formatCoverUrl(tr.cover, { size: 240 })"
                        :alt="tr.name"
                        imgClass="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                        wrapperClass="h-full w-full"
                      />
                      <span
                        v-if="tr.duration > 0"
                        class="absolute right-1 bottom-1 rounded bg-black/80 px-1 py-0.2 text-[9px] font-medium text-slate-100 backdrop-blur-xs"
                      >
                        {{ formatSec(tr.duration) }}
                      </span>
                    </div>

                    <!-- 影片信息：名称 + 介绍 + 作者 + 观看量 + 日期 -->
                    <div class="min-w-0 flex-1 flex flex-col justify-between py-0.5">
                      <div>
                        <h4
                          class="line-clamp-1 font-semibold text-xs leading-snug text-primary group-hover:text-sky-400 transition-colors"
                          :title="tr.name"
                        >
                          {{ tr.name }}
                        </h4>
                        <p class="text-primary/50 truncate text-[11px] mt-0.5" :title="tr.description">
                          {{ tr.description || `${tr.artist} 精彩音乐视频` }}
                        </p>
                      </div>
                      <div class="text-[10px] text-primary/40 truncate mt-1 flex items-center gap-1.5">
                        <span class="truncate max-w-[90px]">{{ tr.artist }}</span>
                        <span>•</span>
                        <span>{{ formatCount(tr.playCount || '10000') }}次</span>
                        <span>•</span>
                        <span>{{ formatRelativeTimeYT(tr.publishTime) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 2. 合辑下方推荐视频 (严格排除当前正在播放的 MV 与已在合辑内的全部曲目，零重复、零死循环) -->
              <div
                ref="recsContainerRef"
                class="space-y-2.5 pt-1"
                :class="{
                  'flex flex-col justify-between': !state.hasMoreRecommendations && targetRecsHeight !== null,
                }"
                :style="
                  !state.hasMoreRecommendations && targetRecsHeight !== null
                    ? { height: `${targetRecsHeight}px`, boxSizing: 'border-box' }
                    : undefined
                "
              >
                <div
                  v-for="mv in displayRelatedMVs"
                  :key="mv.id"
                  class="glass-card group flex cursor-pointer gap-3 p-2.5 rounded-2xl border border-glass-subtle transition-all duration-200 hover:-translate-y-0.5 hover:bg-hover-glass hover:border-sky-500/30"
                  @click="playRelatedMV(mv)"
                >
                  <!-- 左侧 16:9 宽屏缩略图 -->
                  <div class="relative shrink-0 overflow-hidden rounded-xl aspect-video w-36 sm:w-40 bg-black/40">
                    <LazyImage
                      :src="formatCoverUrl(mv.cover, { size: 320 })"
                      :alt="mv.title"
                      imgClass="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      wrapperClass="h-full w-full"
                    />
                    <div
                      class="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <span class="icon-[mdi--play] h-7 w-7 text-slate-100"></span>
                    </div>
                    <span
                      v-if="mv.duration > 0"
                      class="absolute right-1.5 bottom-1.5 rounded bg-black/80 px-1 py-0.5 text-[10px] font-medium text-slate-100 backdrop-blur-sm"
                    >
                      {{ formatSec(mv.duration) }}
                    </span>
                  </div>

                  <!-- 右侧文本信息 (影片名称 + 介绍 + 歌手 + 播放量 + 日期) -->
                  <div class="min-w-0 flex-1 py-0.5 flex flex-col justify-between">
                    <div>
                      <h3
                        class="text-primary line-clamp-2 text-xs sm:text-[13px] font-semibold leading-snug transition-colors group-hover:text-sky-400"
                        :title="mv.title"
                      >
                        {{ mv.title }}
                      </h3>
                      <p class="text-primary/60 hover:text-sky-400 truncate text-[11px] mt-1" :title="mv.artist">
                        {{ mv.artist }}
                      </p>
                    </div>
                    <p class="text-primary/45 text-[10px] truncate">
                      {{ formatCount(mv.playCount) }}次观看 • {{ formatRelativeTimeYT(mv.publishTime) }}
                    </p>
                  </div>
                </div>

                <!-- 瀑布式流式滚动加载组件 (仅加载中或有更多时呈现，到底后直接终止，无冗余文案与分割线) -->
                <InfiniteScroll
                  v-if="state.hasMoreRecommendations"
                  :loading="state.isLoadingMoreRecommendations"
                  :has-more="state.hasMoreRecommendations"
                  :error="state.isRecommendError"
                  :loading-text="t('common.loading')"
                  :retry-text="t('mvList.actions.loadMore')"
                  @load="loadMoreRecommendations"
                  @retry="loadMoreRecommendations"
                />
              </div>
            </aside>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

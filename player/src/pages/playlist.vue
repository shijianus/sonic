<script setup lang="ts">
import {
  playlistDetail,
  playlistTrackAll,
  commentPlaylist,
  commentNew,
  simiPlaylist,
  search,
} from '@/api'
import { usePlayActions } from '@/composables/usePlayActions'
import { PlaylistInfo, CommentItem } from '@/typings'
import LazyImage from '@/components/Ui/LazyImage.vue'
import Button from '@/components/Ui/Button.vue'
import TabGroup from '@/components/Ui/TabGroup.vue'
import InfiniteScroll from '@/components/Ui/InfiniteScroll.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { formatCount, formatDateTime } from '@/utils/time'
import { useI18n } from 'vue-i18n'
import {
  transformPlaylistDetail,
  transformSongs,
  transformSearchPlaylists,
  type SongData,
} from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useLibraryStore } from '@/stores/modules/library'
import { useAuthStore } from '@/stores/modules/auth'
import { useToastStore } from '@/stores/modules/toast'

const route = useRoute()
const router = useRouter()
const playlistId = computed(() => route.params.id)
const libraryStore = useLibraryStore()
const authStore = useAuthStore()
const toastStore = useToastStore()

interface SimilarPlaylist {
  id: number | string
  name: string
  coverImgUrl: string
  trackCount?: number
  playCount?: number
  creator?: { nickname: string }
}

interface PlaylistState {
  activeTab: 'songs' | 'comments' | 'similar'
  playlistInfo: PlaylistInfo
  isCollected: boolean
  songs: SongData[]
  comments: CommentItem[]
  hotComments: CommentItem[]
  isPageLoading: boolean
  similarPlaylists: SimilarPlaylist[]
  commentPage: number
  hasMoreComments: boolean
  isLoadingMoreComments: boolean
  isLoadingComments: boolean
  isCommentLoadError: boolean
  isLoadingSimilar: boolean
  isSimilarLoadError: boolean
  commentTotal: number
  songTotal: number
  hasMoreSongs: boolean
  isLoadingMoreSongs: boolean
  isSongLoadError: boolean
  isPreparingFullList: boolean
  partialPlayNotice: string
  commentDraft: string
}

const state = reactive<PlaylistState>({
  activeTab: 'songs',
  playlistInfo: {} as PlaylistInfo,
  isCollected: false,
  songs: [],
  comments: [],
  hotComments: [],
  isPageLoading: true,
  similarPlaylists: [],
  commentPage: 1,
  hasMoreComments: true,
  isLoadingMoreComments: false,
  isLoadingComments: false,
  isCommentLoadError: false,
  isLoadingSimilar: false,
  isSimilarLoadError: false,
  commentTotal: 0,
  songTotal: 0,
  hasMoreSongs: false,
  isLoadingMoreSongs: false,
  isSongLoadError: false,
  isPreparingFullList: false,
  partialPlayNotice: '',
  commentDraft: '',
})
const {
  activeTab,
  playlistInfo,
  songs,
  comments,
  hotComments,
  isPageLoading,
  similarPlaylists,
  hasMoreComments,
  isLoadingMoreComments,
  isLoadingComments,
  isCommentLoadError,
  isLoadingSimilar,
  isSimilarLoadError,
  commentTotal,
  songTotal,
  hasMoreSongs,
  isLoadingMoreSongs,
  isSongLoadError,
  isPreparingFullList,
  partialPlayNotice,
  commentDraft,
} = toRefs(state)
const { playAll: playAllAction, shufflePlay: shufflePlayAction } = usePlayActions()
const { t } = useI18n()

const gradients: string[] = ['from-blue-500 to-sky-500']
const pickGradient = (): string => gradients[Math.floor(Math.random() * gradients.length)]

const SONG_PAGE_SIZE = 100

/** 拉取一页歌曲；reset 为 true 时覆盖，否则按 offset 追加并去重 */
const loadSongPage = async (id: number, offset: number, reset: boolean) => {
  const res = await playlistTrackAll({ id, limit: SONG_PAGE_SIZE, offset })
  const page = transformSongs(res as Record<string, unknown>)
  if (reset) {
    state.songs = page
  } else {
    const seen = new Set(state.songs.map(s => String(s.id)))
    state.songs.push(...page.filter(s => !seen.has(String(s.id))))
  }
  const reachedTotal = state.songTotal > 0 && state.songs.length >= state.songTotal
  state.hasMoreSongs = !reachedTotal && page.length === SONG_PAGE_SIZE
  state.isSongLoadError = false
}

const loadPlaylist = async (id: number) => {
  state.songs = []
  state.songTotal = 0
  state.hasMoreSongs = false
  state.isLoadingMoreSongs = false
  state.isSongLoadError = false
  state.partialPlayNotice = ''
  try {
    const [detailRes, tracksRes] = await Promise.allSettled([
      playlistDetail({ id }),
      playlistTrackAll({ id, limit: SONG_PAGE_SIZE, offset: 0 }),
    ])

    const detailRaw = detailRes.status === 'fulfilled' ? detailRes.value : null
    const tracksRaw = tracksRes.status === 'fulfilled' ? tracksRes.value : null

    const detail = detailRaw
      ? transformPlaylistDetail(detailRaw as Record<string, unknown>, t('home.playlistFallback'))
      : null

    let songList: SongData[] = []
    if (tracksRaw) {
      songList = transformSongs(tracksRaw as Record<string, unknown>)
    }
    // 降级回退：若独立歌曲列表为空或失败，优先从歌单详情中提取 tracks 歌曲数据
    if ((!songList || songList.length === 0) && detailRaw) {
      songList = transformSongs(detailRaw as Record<string, unknown>)
    }

    if (detail) {
      state.playlistInfo = {
        name: detail.name,
        description: detail.description,
        creator: detail.creator,
        creatorAvatar: detail.creatorAvatar,
        createTime: detail.createTime,
        songCount: detail.songCount || songList.length,
        playCount: detail.playCount as number,
        likes: String(detail.likes),
        category: detail.category,
        emoji: state.playlistInfo.emoji,
        gradient: pickGradient(),
        coverImgUrl: detail.coverImgUrl || songList[0]?.cover || '',
      }
      state.songTotal = detail.songCount || songList.length
      state.isCollected = libraryStore.isPlaylistCollected(id)
    } else if (songList.length > 0) {
      state.playlistInfo = {
        name: t('common.unknownPlaylist'),
        description: '',
        creator: '',
        creatorAvatar: '',
        createTime: '',
        songCount: songList.length,
        playCount: 0,
        likes: '0',
        category: t('home.playlistFallback'),
        emoji: state.playlistInfo.emoji,
        gradient: pickGradient(),
        coverImgUrl: songList[0]?.cover || '',
      }
      state.songTotal = songList.length
    }

    state.songs = songList
    const reachedTotal = state.songTotal > 0 && state.songs.length >= state.songTotal
    state.hasMoreSongs = !reachedTotal && state.songs.length === SONG_PAGE_SIZE
    state.isSongLoadError = songList.length === 0 && !detail
  } catch {
    state.isSongLoadError = true
  } finally {
    state.isPageLoading = false
  }
}

/** 追加下一页歌曲 */
const loadMoreSongs = async () => {
  if (state.isLoadingMoreSongs || !state.hasMoreSongs) return
  state.isLoadingMoreSongs = true
  try {
    await loadSongPage(Number(route.params.id), state.songs.length, false)
  } catch {
    state.isSongLoadError = true
  } finally {
    state.isLoadingMoreSongs = false
  }
}

/** 播放/随机前确保完整列表已入队，失败时返回 false 以便提示仅播放已加载部分 */
const ensureAllSongsLoaded = async () => {
  if (!state.songs.length || !state.hasMoreSongs) return true
  state.isPreparingFullList = true
  try {
    while (state.hasMoreSongs) {
      const before = state.songs.length
      await loadSongPage(Number(route.params.id), before, false)
      if (state.songs.length === before) break
    }
    return !state.hasMoreSongs
  } catch {
    state.isSongLoadError = true
    return false
  } finally {
    state.isPreparingFullList = false
  }
}

const handlePlayAll = async () => {
  const complete = await ensureAllSongsLoaded()
  if (!complete && state.songs.length) {
    state.partialPlayNotice = t('playlist.partialPlayNotice', {
      loaded: state.songs.length,
      total: state.songTotal || state.songs.length,
    })
  } else {
    state.partialPlayNotice = ''
  }
  playAllAction(state.songs)
}

const handleShufflePlay = async () => {
  const complete = await ensureAllSongsLoaded()
  if (!complete && state.songs.length) {
    state.partialPlayNotice = t('playlist.partialPlayNotice', {
      loaded: state.songs.length,
      total: state.songTotal || state.songs.length,
    })
  } else {
    state.partialPlayNotice = ''
  }
  shufflePlayAction(state.songs)
}

const dismissPartialPlayNotice = () => {
  state.partialPlayNotice = ''
}

let commentRequestSeq = 0

const handleCommentAction = () => {
  if (!authStore.isAuthenticated) {
    toastStore.show({
      message: t('comments.pleaseLoginEpomail') || '请先登录epomail',
      type: 'warning',
    })
    return
  }
  toastStore.show({
    message: t('comments.commentsNotOpen') || '评论区暂时没有开放',
    type: 'info',
  })
}

const resetCommentState = () => {
  commentRequestSeq += 1
  state.comments = []
  state.hotComments = []
  state.commentPage = 1
  state.hasMoreComments = true
  state.isLoadingMoreComments = false
  state.isLoadingComments = false
  state.isCommentLoadError = false
  state.commentTotal = 0
}

const loadComments = async (id?: number, reset = false) => {
  const targetId = id || Number(route.params.id)
  if (!targetId) return
  if (!reset && (state.isLoadingMoreComments || !state.hasMoreComments)) return

  if (reset) {
    resetCommentState()
    state.isLoadingComments = true
  } else {
    state.isLoadingMoreComments = true
  }
  const requestSeq = commentRequestSeq
  const pageNo = state.commentPage
  state.isCommentLoadError = false

  try {
    let res: any = null
    try {
      res = await commentPlaylist({
        id: targetId,
        limit: 20,
        offset: (pageNo - 1) * 20,
      })
    } catch {
      res = await commentNew({
        id: targetId,
        type: 2,
        sortType: 1,
        pageNo,
        pageSize: 20,
      })
    }
    if (requestSeq !== commentRequestSeq) return
    const list = (res as any)?.data?.comments || (res as any)?.comments || []
    const hotList = (res as any)?.data?.hotComments || (res as any)?.hotComments || []

    const mapComment = (c: any, i: number, isHot = false): CommentItem => ({
      id: c?.commentId || c?.id || `${pageNo}-${i}`,
      username: c?.user?.nickname || t('comments.user'),
      avatarGradient: gradients[(state.comments.length + i) % gradients.length],
      time: c?.time ? formatDateTime(c.time) : (c?.timeStr || ''),
      content: c?.content || '',
      likes: c?.likedCount || 0,
      liked: Boolean(c?.liked),
      location: c?.ipLocation?.location || '',
      isHot,
      avatarUrl: c?.user?.avatarUrl || '',
      replies: (c?.beReplied || []).map((r: any, ri: number) => ({
        username: r?.user?.nickname || t('comments.user'),
        avatarUrl: r?.user?.avatarUrl || '',
        avatarGradient: gradients[(state.comments.length + i + ri + 1) % gradients.length],
        time: '',
        content: r?.content || '',
      })),
    })

    if (Array.isArray(list)) {
      const mapped = list.map((c, i) => mapComment(c, i, false))
      if (reset && Array.isArray(hotList) && hotList.length > 0) {
        state.hotComments = hotList.map((c, i) => mapComment(c, i, true))
      } else if (reset) {
        state.hotComments = []
      }

      state.comments = reset ? mapped : [...state.comments, ...mapped]
      state.hasMoreComments = (res as any)?.more ?? (list.length === 20)
      const total = Number(
        (res as any)?.data?.total ??
          (res as any)?.total ??
          (res as any)?.data?.totalCount ??
          (res as any)?.totalCount
      )
      if (Number.isFinite(total)) {
        state.commentTotal = total
      } else if (reset) {
        state.commentTotal = mapped.length + state.hotComments.length
      }
      if (mapped.length) state.commentPage += 1
    } else {
      state.hasMoreComments = false
      if (reset) {
        state.commentTotal = 0
        state.hotComments = []
      }
    }
  } catch {
    if (requestSeq !== commentRequestSeq) return
    if (!reset) {
      state.isCommentLoadError = true
    } else {
      state.hasMoreComments = false
    }
  } finally {
    if (requestSeq === commentRequestSeq) {
      state.isLoadingMoreComments = false
      state.isLoadingComments = false
    }
  }
}

const cleanPlaylistKeyword = (name: string): string => {
  if (!name) return ''
  let cleaned = name
    .replace(/\[.*?\]|【.*?】|（.*?）|\(.*?\)/g, ' ')
    .replace(/[|/\\_—–\-+#!~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || name
}

const loadSimilarPlaylists = async (name: string, id?: number | string) => {
  const currentId = String(id || route.params.id)
  state.isLoadingSimilar = true
  state.isSimilarLoadError = false
  try {
    if (currentId) {
      try {
        const simiRes: any = await simiPlaylist({ id: currentId })
        const list = simiRes?.playlists || []
        if (Array.isArray(list) && list.length > 0) {
          state.similarPlaylists = list
            .filter((pl: any) => String(pl.id) !== currentId)
            .slice(0, 12)
            .map((pl: any) => ({
              id: pl.id,
              name: pl.name,
              coverImgUrl: pl.coverImgUrl || pl.picUrl || '',
              trackCount: pl.trackCount,
              playCount: pl.playCount,
              creator: pl.creator,
            }))
          if (state.similarPlaylists.length > 0) {
            state.isLoadingSimilar = false
            return
          }
        }
      } catch {}
    }

    const q = cleanPlaylistKeyword(name)
    const res = await search({ keywords: q || name || '流行', type: 1000, limit: 16 })
    const { playlists } = transformSearchPlaylists(res as Record<string, unknown>, 16)
    state.similarPlaylists = playlists
      .filter(pl => String(pl.id) !== currentId)
      .slice(0, 12)
      .map(pl => ({
        id: pl.id,
        name: pl.name,
        coverImgUrl: pl.coverImgUrl,
        trackCount: pl.trackCount,
        playCount: pl.playCount,
        creator: (pl as any).creator,
      }))
  } catch {
    state.isSimilarLoadError = true
  } finally {
    state.isLoadingSimilar = false
  }
}

// 初始化加载播放列表
onMounted(() => {
  const idNum = Number(route.params.id)
  if (!Number.isNaN(idNum) && idNum > 0) {
    state.isPageLoading = true
    resetCommentState()
    loadPlaylist(idNum)
    loadComments(idNum, true)
    loadSimilarPlaylists(state.playlistInfo.name || '', idNum)
  }
})

// 监听路由参数变化，加载新的播放列表
watch(
  () => Number(route.params.id),
  idNum => {
    if (!Number.isNaN(idNum) && idNum > 0) {
      state.isPageLoading = true
      resetCommentState()
      loadPlaylist(idNum)
      loadComments(idNum, true)
      loadSimilarPlaylists(state.playlistInfo.name || '', idNum)
    }
  }
)

watch(
  () => state.playlistInfo.name,
  name => {
    if (name) loadSimilarPlaylists(name, String(route.params.id))
  }
)


const toggleCollect = () => {
  if (!state.playlistInfo) return
  const collected = libraryStore.toggleCollectPlaylist({
    id: Number(route.params.id),
    name: state.playlistInfo.name,
    coverImgUrl: state.playlistInfo.coverImgUrl,
    trackCount: state.playlistInfo.songCount,
    creator: state.playlistInfo.creator,
    playCount: state.playlistInfo.playCount,
  })
  state.isCollected = collected
}

const sharePlaylist = async () => {
  const resolved = router.resolve({ name: 'playlist', params: { id: String(playlistId) } }).href
  const url = new URL(resolved, location.origin).href
  const title = String((state.playlistInfo as any)?.name || t('home.playlistFallback'))
  const text = String((state.playlistInfo as any)?.description || '')
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url })
    } else {
      await navigator.clipboard.writeText(url)
    }
  } catch {}
}

const tabs = [
  { key: 'songs', labelKey: 'playlist.tabs.songs', icon: 'icon-[mdi--music-note]' },
  { key: 'comments', labelKey: 'playlist.tabs.comments', icon: 'icon-[mdi--comment-text]' },
  { key: 'similar', labelKey: 'playlist.tabs.similar', icon: 'icon-[mdi--playlist-music]' },
] as const

const tabsWithCount = computed(() =>
  tabs.map(tab => ({
    ...tab,
    count:
      tab.key === 'songs'
        ? songTotal.value || songs.value.length
        : tab.key === 'comments'
          ? commentTotal.value || comments.value.length + hotComments.value.length
          : similarPlaylists.value.length,
  }))
)
</script>

<template>
  <div class="w-full h-full overflow-y-auto p-4 sm:p-6 pb-6 overflow-x-hidden">
    <PageSkeleton v-if="isPageLoading" :sections="['hero', 'list']" :list-count="12" />
    <template v-else>
      <div class="flex flex-col gap-3">
        <!-- 头部区域 -->
        <div class="relative">
          <!-- 背景模糊图片 -->
          <div class="absolute inset-0 overflow-hidden rounded-3xl">
            <img
              :src="formatCoverUrl(playlistInfo.coverImgUrl, { size: 100 })"
              class="h-full w-full scale-150 object-cover opacity-30 blur-3xl"
              alt=""
              aria-hidden="true"
              referrerpolicy="no-referrer"
            />
            <div
              class="to-overlay absolute inset-0 bg-linear-to-b from-transparent via-transparent"
            ></div>
          </div>

          <!-- 内容区域 -->
          <div class="relative z-10 overflow-hidden rounded-3xl">
            <div class="glass-container">
              <div class="flex flex-col gap-6 p-6 lg:flex-row lg:gap-10">
                <!-- 封面 -->
                <div class="group relative mx-auto w-56 shrink-0 lg:mx-0 lg:w-72">
                  <div
                    class="aspect-square overflow-hidden rounded-3xl shadow-2xl ring-1 ring-glass"
                  >
                    <LazyImage
                      :src="formatCoverUrl(playlistInfo.coverImgUrl, { size: 400 })"
                      :alt="$t('components.songList.coverAlt')"
                      imgClass="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
                      wrapperClass="h-full w-full"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="none"
                    class="absolute! inset-0 flex items-center justify-center rounded-3xl opacity-0 transition-all duration-300 group-hover:opacity-100"
                    :aria-label="$t('actions.playAll')"
                    :title="$t('actions.playAll')"
                    @click="handlePlayAll"
                  >
                    <div
                      class="flex h-20 w-20 items-center justify-center rounded-full bg-linear-to-r from-sky-500 to-blue-600 text-white shadow-2xl transition-transform hover:scale-110"
                    >
                      <span class="icon-[mdi--play] h-10 w-10"></span>
                    </div>
                  </Button>
                </div>

                <!-- 信息区域 -->
                <div class="flex min-w-0 flex-1 flex-col justify-center text-center lg:text-left">
                  <!-- 标题 -->
                  <h1
                    class="text-primary mb-4 line-clamp-2 text-xl leading-tight font-bold lg:text-4xl xl:text-5xl"
                  >
                    {{ playlistInfo.name }}
                  </h1>

                  <!-- 创建者信息 -->
                  <div class="mb-5 flex items-center justify-center gap-3 lg:justify-start">
                    <img
                      v-if="playlistInfo.creatorAvatar"
                      :src="formatCoverUrl(playlistInfo.creatorAvatar, { size: 80 })"
                      class="h-8 w-8 rounded-full ring-2 ring-glass"
                      :alt="playlistInfo.creator"
                      referrerpolicy="no-referrer"
                    />
                    <span class="text-primary font-medium">{{ playlistInfo.creator }}</span>
                    <span class="text-primary/40">•</span>
                    <span class="text-primary/60 text-sm">{{ playlistInfo.createTime }}</span>
                    <span class="text-primary/40">•</span>
                    <!-- 分类标签 -->
                    <span
                      class="glass-button accent-gradient px-4 py-1.5 text-xs font-medium text-white"
                    >
                      {{ playlistInfo.category }}
                    </span>
                  </div>

                  <!-- 描述 -->
                  <p
                    v-if="playlistInfo.description"
                    class="text-primary/70 mb-6 line-clamp-2 text-sm leading-relaxed lg:text-base"
                    :title="playlistInfo.description"
                  >
                    {{ playlistInfo.description }}
                  </p>

                  <!-- 统计信息 -->
                  <div
                    class="mb-6 flex flex-wrap items-center justify-center gap-6 lg:justify-start"
                  >
                    <div class="flex items-center gap-2">
                      <span class="icon-[mdi--music-note] text-primary/60 h-5 w-5"></span>
                      <span class="text-primary font-medium">
                        {{ $t('commonUnits.songsShort', { count: playlistInfo.songCount }) }}
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="icon-[mdi--play-circle-outline] text-primary/60 h-5 w-5"></span>
                      <span class="text-primary font-medium">
                        {{ formatCount(playlistInfo.playCount || 0) }}
                        {{ $t('common.stats.plays') }}
                      </span>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="icon-[mdi--heart] h-5 w-5 text-red-400"></span>
                      <span class="text-primary font-medium">
                        {{ formatCount(Number(playlistInfo.likes) || 0) }}
                        {{ $t('common.stats.favorites') }}
                      </span>
                    </div>
                  </div>

                  <!-- 操作按钮 -->
                  <div class="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
                    <Button
                      variant="solid"
                      size="md"
                      rounded="full"
                      class="px-8 py-3 shadow-lg shadow-sky-500/30 hover:shadow-xl hover:shadow-sky-500/40"
                      @click="handlePlayAll"
                    >
                      <span class="icon-[mdi--play] mr-2 h-5 w-5"></span>
                      {{ $t('actions.playAll') }}
                    </Button>
                    <Button
                      variant="soft"
                      size="md"
                      rounded="full"
                      class="px-6 py-3"
                      @click="handleShufflePlay"
                    >
                      <span class="icon-[mdi--shuffle] mr-2 h-5 w-5"></span>
                      {{ $t('actions.shufflePlay') }}
                    </Button>
                    <div class="flex items-center gap-3">
                      <Button
                        variant="soft"
                        size="icon-md"
                        rounded="full"
                        class="h-11 w-11"
                        :class="{
                          'bg-red-500/20 text-red-400 hover:bg-red-500/30': state.isCollected,
                        }"
                        @click="toggleCollect"
                        :title="state.isCollected ? $t('common.uncollect') : $t('common.collect')"
                      >
                        <span
                          :class="
                            state.isCollected ? 'icon-[mdi--heart]' : 'icon-[mdi--heart-outline]'
                          "
                          class="h-5 w-5"
                        ></span>
                      </Button>
                      <Button
                        variant="soft"
                        size="icon-md"
                        rounded="full"
                        class="h-11 w-11"
                        @click="sharePlaylist"
                        :title="$t('common.share')"
                      >
                        <span class="icon-[mdi--share-variant] h-5 w-5"></span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 主内容区域 -->
        <!-- Tabs 工具栏 -->
        <div class="flex items-center justify-between">
          <TabGroup v-model="activeTab" :tabs="tabsWithCount" class="w-full" size="md" />
        </div>

        <!-- 歌曲列表 -->
        <section v-show="activeTab === 'songs'" class="h-full overflow-hidden">
          <div
            v-if="partialPlayNotice"
            class="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-primary/80"
            role="status"
          >
            <span class="icon-[mdi--alert-outline] mt-0.5 h-4 w-4 shrink-0 text-amber-400"></span>
            <span class="flex-1">{{ partialPlayNotice }}</span>
            <button
              type="button"
              class="min-h-11 min-w-11 shrink-0 rounded-lg px-2 text-xs font-medium text-primary/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-sky-400/60"
              @click="dismissPartialPlayNotice"
            >
              {{ $t('playlist.dismiss') }}
            </button>
          </div>
          <SongList v-if="songs.length" :songs="songs" :show-header="true" />
          <div
            v-else-if="!isPageLoading"
            class="glass-card my-6 flex flex-col items-center justify-center p-12 text-center"
          >
            <div
              class="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 text-primary/40 ring-1 ring-white/10"
            >
              <span class="icon-[mdi--music-off] h-8 w-8" />
            </div>
            <p class="text-primary/70 mb-2 font-medium">{{ $t('components.songList.empty') }}</p>
            <Button
              variant="solid"
              size="sm"
              rounded="full"
              @click="loadPlaylist(Number(route.params.id))"
            >
              <span class="icon-[mdi--refresh] mr-1.5 h-4 w-4" />
              {{ $t('common.retry') }}
            </Button>
          </div>
          <div class="mt-4 flex flex-col items-center gap-2 pb-4">
            <p v-if="songTotal" class="text-primary/50 text-xs">
              {{ $t('playlist.loadedProgress', { loaded: songs.length, total: songTotal }) }}
            </p>
            <Button
              v-if="hasMoreSongs"
              variant="soft"
              size="sm"
              rounded="full"
              class="min-h-11"
              :loading="isLoadingMoreSongs || isPreparingFullList"
              :disabled="isLoadingMoreSongs || isPreparingFullList"
              @click="loadMoreSongs"
            >
              {{ isLoadingMoreSongs || isPreparingFullList ? $t('playlist.loadingAll') : $t('playlist.loadMore') }}
            </Button>
            <p v-else-if="songs.length" class="text-primary/40 text-xs">
              {{ $t('playlist.allLoaded') }}
            </p>
            <button
              v-if="isSongLoadError && !isLoadingMoreSongs"
              type="button"
              class="min-h-11 rounded-lg px-3 text-xs font-medium text-sky-400 hover:text-sky-300 focus-visible:ring-2 focus-visible:ring-sky-400/60"
              @click="loadMoreSongs"
            >
              {{ $t('playlist.retryLoad') }}
            </button>
          </div>
        </section>

        <!-- 评论区 -->
        <section v-show="activeTab === 'comments'" class="animate-fade-in flex flex-col gap-4">
          <!-- 评论发表占位区域 (公测UI，未登录提示登录epomail，已登录提示未开放) -->
          <div class="glass-card overflow-hidden p-5 transition-all">
            <div class="flex items-start gap-3.5">
              <!-- 用户头像 -->
              <div class="h-10 w-10 shrink-0 overflow-hidden rounded-full ring-2 ring-glass">
                <img
                  v-if="authStore.userAvatar"
                  :src="authStore.userAvatar"
                  class="h-full w-full object-cover"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <div
                  v-else-if="authStore.isAuthenticated"
                  class="flex h-full w-full items-center justify-center bg-linear-to-tr from-sky-500 to-blue-600 text-sm font-bold text-white"
                >
                  {{ authStore.userInitial }}
                </div>
                <div
                  v-else
                  class="flex h-full w-full items-center justify-center bg-white/10 text-primary/50"
                >
                  <span class="icon-[mdi--account] h-5 w-5" />
                </div>
              </div>

              <!-- 输入交互框架 -->
              <div class="min-w-0 flex-1">
                <div class="mb-2 flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    <span class="text-primary text-sm font-semibold">
                      {{ authStore.isAuthenticated ? authStore.userName : $t('account.guestUser', '访客用户') }}
                    </span>
                    <span
                      v-if="authStore.isAuthenticated"
                      class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400"
                    >
                      EpoMail
                    </span>
                    <span
                      v-else
                      class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-primary/50"
                    >
                      {{ $t('account.guest', '未登录') }}
                    </span>
                  </div>
                  <span class="text-primary/40 text-xs hidden sm:inline">
                    {{ $t('comments.guestTip', '登录 EpoMail 账号即可参与评论互动') }}
                  </span>
                </div>

                <div
                  class="group relative rounded-xl border border-glass bg-white/5 transition-all focus-within:border-sky-500/50 focus-within:bg-white/10 cursor-pointer"
                  @click="handleCommentAction"
                >
                  <textarea
                    v-model="commentDraft"
                    rows="2"
                    :placeholder="$t('comments.writeTip', '发表你的友善评论，留下此刻的听歌心境...')"
                    class="w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-primary placeholder-primary/30 outline-none cursor-pointer"
                    readonly
                    @click.stop="handleCommentAction"
                  ></textarea>
                  <div class="flex items-center justify-between border-t border-glass px-3 py-2">
                    <div class="flex items-center gap-2 text-xs text-primary/40">
                      <span class="icon-[mdi--shield-check-outline] h-4 w-4 text-sky-400" />
                      <span class="text-[11px]">{{ $t('comments.title', '歌单评论') }}</span>
                    </div>
                    <Button
                      variant="solid"
                      size="sm"
                      rounded="full"
                      class="px-4 py-1.5 shadow-sm text-xs font-medium"
                      @click.stop="handleCommentAction"
                    >
                      <span class="icon-[mdi--send-variant-outline] mr-1.5 h-3.5 w-3.5" />
                      {{ $t('comments.submit', '发表评论') }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 评论列表主体 -->
          <div class="glass-card overflow-hidden">
            <!-- 列表标题与总数 -->
            <div class="flex items-center justify-between border-b border-glass px-6 py-4">
              <div class="flex items-center gap-2">
                <span class="icon-[mdi--comment-text-multiple-outline] text-primary/60 h-5 w-5" />
                <h3 class="text-primary text-base font-semibold">
                  {{ $t('comments.title', '全部评论') }}
                </h3>
                <span
                  class="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold text-primary/70"
                >
                  {{ formatCount(commentTotal || comments.length + hotComments.length) }}
                </span>
              </div>
              <button
                type="button"
                class="flex items-center gap-1 text-xs text-primary/60 hover:text-primary transition-colors cursor-pointer"
                @click="loadComments(undefined, true)"
              >
                <span class="icon-[mdi--refresh] h-4 w-4" />
                <span>{{ $t('common.refresh', '刷新') }}</span>
              </button>
            </div>

            <!-- 初次加载中骨架屏 -->
            <div v-if="isLoadingComments && !comments.length && !hotComments.length" class="p-6">
              <PageSkeleton :sections="['list']" :list-count="6" />
            </div>

            <!-- 热评列表 (若有) -->
            <div v-else-if="hotComments.length" class="border-b border-glass bg-amber-500/5">
              <div class="flex items-center gap-1.5 px-6 pt-4 pb-2 text-xs font-bold text-amber-400">
                <span class="icon-[mdi--fire] h-4 w-4" />
                <span>{{ $t('comments.hotBadge', '热门评论') }}</span>
              </div>
              <div class="divide-y divide-glass">
                <div
                  v-for="(comment, index) in hotComments"
                  :key="comment.id || `hot-${index}`"
                  class="hover:bg-hover-glass p-6 transition-colors"
                >
                  <div class="flex gap-4">
                    <img
                      v-if="comment.avatarUrl"
                      :src="formatCoverUrl(comment.avatarUrl, { size: 100 })"
                      class="h-11 w-11 shrink-0 rounded-full ring-2 ring-glass"
                      referrerpolicy="no-referrer"
                    />
                    <div
                      v-else
                      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br text-sm font-semibold text-white"
                      :class="comment.avatarGradient"
                    >
                      {{ comment.username.charAt(0) }}
                    </div>

                    <div class="min-w-0 flex-1">
                      <div class="mb-2 flex items-center justify-between">
                        <div class="flex items-center gap-2">
                          <span class="text-primary text-sm font-semibold">{{ comment.username }}</span>
                          <span v-if="comment.location" class="text-primary/40 text-xs">
                            {{ comment.location }}
                          </span>
                        </div>
                        <span class="text-primary/50 text-xs">{{ comment.time }}</span>
                      </div>

                      <p class="text-primary/80 mb-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
                        {{ comment.content }}
                      </p>

                      <div class="flex items-center gap-4 text-xs text-primary/50">
                        <button
                          type="button"
                          class="flex items-center gap-1.5 transition-colors hover:text-red-400 cursor-pointer"
                          @click="handleCommentAction"
                        >
                          <span class="icon-[mdi--thumb-up-outline] h-4 w-4" />
                          <span class="font-medium">{{ comment.likes || 0 }}</span>
                        </button>
                        <button
                          type="button"
                          class="flex items-center gap-1 transition-colors hover:text-primary cursor-pointer"
                          @click="handleCommentAction"
                        >
                          <span class="icon-[mdi--comment-outline] h-3.5 w-3.5" />
                          <span>{{ $t('comments.reply', '回复') }}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 评论列表 -->
            <div v-if="comments.length" class="divide-y divide-glass">
              <div
                v-for="(comment, index) in comments"
                :key="comment.id || index"
                class="hover:bg-hover-glass p-6 transition-colors"
              >
                <div class="flex gap-4">
                  <img
                    v-if="comment.avatarUrl"
                    :src="formatCoverUrl(comment.avatarUrl, { size: 100 })"
                    class="h-11 w-11 shrink-0 rounded-full ring-2 ring-glass"
                    referrerpolicy="no-referrer"
                  />
                  <div
                    v-else
                    class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br text-sm font-semibold text-white"
                    :class="comment.avatarGradient"
                  >
                    {{ comment.username.charAt(0) }}
                  </div>

                  <div class="min-w-0 flex-1">
                    <div class="mb-2 flex items-center justify-between">
                      <div class="flex items-center gap-2">
                        <span class="text-primary text-sm font-semibold">{{ comment.username }}</span>
                        <span v-if="comment.location" class="text-primary/40 text-xs">
                          {{ comment.location }}
                        </span>
                      </div>
                      <span class="text-primary/50 text-xs">{{ comment.time }}</span>
                    </div>

                    <p class="text-primary/80 mb-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      {{ comment.content }}
                    </p>

                    <div class="flex items-center gap-4 text-xs text-primary/50">
                      <button
                        type="button"
                        class="flex items-center gap-1.5 transition-colors hover:text-red-400 cursor-pointer"
                        @click="handleCommentAction"
                      >
                        <span class="icon-[mdi--thumb-up-outline] h-4 w-4"></span>
                        <span class="font-medium">{{ comment.likes || 0 }}</span>
                      </button>
                      <button
                        type="button"
                        class="flex items-center gap-1 transition-colors hover:text-primary cursor-pointer"
                        @click="handleCommentAction"
                      >
                        <span class="icon-[mdi--comment-outline] h-3.5 w-3.5"></span>
                        <span>{{ $t('comments.reply', '回复') }}</span>
                      </button>
                    </div>

                    <!-- 回复列表 -->
                    <div
                      v-if="comment.replies?.length"
                      class="glass-card mt-4 space-y-3 rounded-xl p-4"
                    >
                      <div v-for="(reply, ri) in comment.replies" :key="ri" class="flex gap-3">
                        <img
                          v-if="reply.avatarUrl"
                          :src="formatCoverUrl(reply.avatarUrl, { size: 80 })"
                          class="h-8 w-8 shrink-0 rounded-full ring-1 ring-glass"
                          referrerpolicy="no-referrer"
                        />
                        <div class="min-w-0 flex-1">
                          <span class="text-primary text-xs font-semibold">{{
                            reply.username
                          }}</span>
                          <p class="text-primary/70 mt-1 text-xs leading-relaxed">
                            {{ reply.content }}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 空状态 -->
            <div
              v-else-if="!isLoadingComments"
              class="flex flex-col items-center justify-center py-20"
            >
              <span class="icon-[mdi--comment-off-outline] text-primary/20 mb-4 h-16 w-16"></span>
              <p class="text-primary/50 text-sm font-medium">{{ $t('comments.empty') }}</p>
            </div>

            <!-- 评论流式自动触底加载与超时重试 -->
            <InfiniteScroll
              v-if="comments.length || isLoadingMoreComments || isCommentLoadError"
              :loading="isLoadingMoreComments"
              :has-more="hasMoreComments"
              :error="isCommentLoadError"
              :empty="false"
              :loading-text="$t('comments.loadMore')"
              :retry-text="$t('comments.loadMore')"
              @load="loadComments(undefined, false)"
              @retry="loadComments(undefined, false)"
            />
          </div>
        </section>

        <!-- 相似歌单 -->
        <section v-show="activeTab === 'similar'" class="animate-fade-in">
          <!-- 加载中骨架 -->
          <div
            v-if="isLoadingSimilar && !similarPlaylists.length"
            class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
          >
            <div
              v-for="i in 12"
              :key="i"
              class="glass-card overflow-hidden animate-pulse rounded-2xl"
            >
              <div class="aspect-square bg-white/10" />
              <div class="p-3 space-y-2">
                <div class="h-4 w-3/4 rounded bg-white/10" />
                <div class="h-3 w-1/2 rounded bg-white/5" />
              </div>
            </div>
          </div>

          <div
            v-else-if="similarPlaylists.length"
            class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
          >
            <router-link
              v-for="pl in similarPlaylists"
              :key="pl.id"
              :to="`/playlist/${pl.id}`"
              class="group"
            >
              <div
                class="glass-card overflow-hidden transition-all duration-300 hover:scale-105 hover:shadow-xl"
              >
                <div class="relative aspect-square overflow-hidden">
                  <LazyImage
                    :src="formatCoverUrl(pl.coverImgUrl, { size: 300 })"
                    :alt="pl.name"
                    imgClass="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
                    wrapperClass="h-full w-full"
                  />
                  <div
                    class="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 backdrop-blur-sm transition-opacity duration-300 group-hover:opacity-100"
                  >
                    <div
                      class="accent-gradient flex h-14 w-14 items-center justify-center rounded-full shadow-2xl"
                    >
                      <span class="icon-[mdi--play] h-7 w-7 text-white"></span>
                    </div>
                  </div>
                  <div
                    v-if="pl.playCount"
                    class="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md"
                  >
                    <span class="icon-[mdi--play] h-3.5 w-3.5"></span>
                    {{ formatCount(pl.playCount) }}
                  </div>
                </div>
                <div class="p-3">
                  <p
                    class="text-primary mb-1.5 line-clamp-2 text-sm leading-snug font-semibold transition-colors group-hover:text-sky-400"
                  >
                    {{ pl.name }}
                  </p>
                  <p class="text-primary/60 text-xs">
                    {{ $t('commonUnits.songsShort', { count: pl.trackCount || 0 }) }}
                    <span v-if="pl.creator"> • {{ pl.creator.nickname }}</span>
                  </p>
                </div>
              </div>
            </router-link>
          </div>
          <div
            v-else
            class="glass-card flex flex-col items-center justify-center py-20 text-center"
          >
            <span class="icon-[mdi--playlist-remove] text-primary/20 mb-5 h-20 w-20"></span>
            <p class="text-primary/50 text-base font-medium mb-1">{{ $t('playlist.similarEmpty') }}</p>
            <p v-if="isSimilarLoadError" class="text-amber-400/80 text-xs mb-3">
              {{ $t('common.networkError', '推荐加载异常，请点击重试') }}
            </p>
            <Button
              variant="soft"
              size="sm"
              rounded="full"
              @click="loadSimilarPlaylists(playlistInfo.name, String(route.params.id))"
            >
              <span class="icon-[mdi--refresh] mr-1.5 h-4 w-4" />
              {{ $t('common.retry') }}
            </Button>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.animate-fade-in {
  animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

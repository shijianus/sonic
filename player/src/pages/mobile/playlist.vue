<script setup lang="ts">
import { playlistDetail, playlistTrackAll, simiPlaylist, search } from '@/api'
import { usePlayActions } from '@/composables/usePlayActions'
import LazyImage from '@/components/Ui/LazyImage.vue'
import PlaylistCommentsPopup from '@/components/Mobile/PlaylistCommentsPopup.vue'
import Button from '@/components/Ui/Button.vue'
import { useI18n } from 'vue-i18n'
import { formatCount } from '@/utils/time'
import {
  transformPlaylistDetail,
  transformSongs,
  transformSearchPlaylists,
  type SongData,
} from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useLibraryStore } from '@/stores/modules/library'

const { t } = useI18n()
const libraryStore = useLibraryStore()

type PlaylistInfo = {
  name: string
  description: string
  creator: string
  creatorAvatar: string
  createTime: string
  songCount: number
  playCount: number | string
  likes: number | string
  category: string
  coverImgUrl: string
}

const route = useRoute()
const playlistId = computed(() => Number(route.params.id))
const isCollected = computed(() => libraryStore.isPlaylistCollected(playlistId.value))

const SONG_PAGE_SIZE = 100

const state = reactive({
  info: {} as PlaylistInfo,
  songs: [] as SongData[],
  loading: true,
  showFullDesc: false,
  showComments: false,
  songTotal: 0,
  hasMoreSongs: false,
  isLoadingMoreSongs: false,
  isSongLoadError: false,
  isPreparingFullList: false,
  partialPlayNotice: '',
  similarPlaylists: [] as Array<{
    id: number | string
    name: string
    coverImgUrl: string
    trackCount?: number
    playCount?: number
  }>,
  loadingSimilar: false,
})

const { playAll: playAllAction, shufflePlay: shufflePlayAction } = usePlayActions()

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

const load = async (id: number) => {
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
      ? transformPlaylistDetail(
          detailRaw as Record<string, unknown>,
          t('home.playlistFallback')
        )
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
      state.info = {
        ...detail,
        coverImgUrl: detail.coverImgUrl || songList[0]?.cover || '',
        playCount: formatCount(detail.playCount as number),
        likes: formatCount(detail.likes as number),
        songCount: detail.songCount || songList.length,
      }
      state.songTotal = detail.songCount || songList.length
    } else if (songList.length > 0) {
      state.info = {
        name: t('common.unknownPlaylist'),
        description: '',
        creator: '',
        creatorAvatar: '',
        createTime: '',
        songCount: songList.length,
        playCount: '0',
        likes: '0',
        category: t('home.playlistFallback'),
        coverImgUrl: songList[0]?.cover || '',
      }
      state.songTotal = songList.length
    }

    state.songs = songList
    const reachedTotal = state.songTotal > 0 && state.songs.length >= state.songTotal
    state.hasMoreSongs = !reachedTotal && state.songs.length === SONG_PAGE_SIZE
    state.isSongLoadError = songList.length === 0 && !detail

    if (state.info.name) {
      loadSimilarPlaylists(state.info.name, id)
    }
  } catch {
    state.isSongLoadError = true
  } finally {
    state.loading = false
  }
}

const loadSimilarPlaylists = async (name: string, id: number) => {
  if (!id) return
  state.loadingSimilar = true
  try {
    try {
      const simiRes: any = await simiPlaylist({ id })
      const list = simiRes?.playlists || []
      if (Array.isArray(list) && list.length > 0) {
        state.similarPlaylists = list
          .filter((pl: any) => String(pl.id) !== String(id))
          .slice(0, 8)
          .map((pl: any) => ({
            id: pl.id,
            name: pl.name,
            coverImgUrl: pl.coverImgUrl || pl.picUrl || '',
            trackCount: pl.trackCount,
            playCount: pl.playCount,
          }))
        if (state.similarPlaylists.length > 0) {
          state.loadingSimilar = false
          return
        }
      }
    } catch {}

    const cleaned = (name || '')
      .replace(/\[.*?\]|【.*?】|（.*?）|\(.*?\)/g, ' ')
      .replace(/[|/\\_—–\-+#!~`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const res = await search({ keywords: cleaned || name || '流行', type: 1000, limit: 10 })
    const { playlists } = transformSearchPlaylists(res as Record<string, unknown>, 10)
    state.similarPlaylists = playlists
      .filter(pl => String(pl.id) !== String(id))
      .slice(0, 8)
      .map(pl => ({
        id: pl.id,
        name: pl.name,
        coverImgUrl: pl.coverImgUrl,
        trackCount: pl.trackCount,
        playCount: pl.playCount,
      }))
  } catch {} finally {
    state.loadingSimilar = false
  }
}

const loadMoreSongs = async () => {
  if (state.isLoadingMoreSongs || !state.hasMoreSongs) return
  state.isLoadingMoreSongs = true
  try {
    await loadSongPage(playlistId.value, state.songs.length, false)
  } catch {
    state.isSongLoadError = true
  } finally {
    state.isLoadingMoreSongs = false
  }
}

const ensureAllSongsLoaded = async () => {
  if (!state.songs.length || !state.hasMoreSongs) return true
  state.isPreparingFullList = true
  try {
    while (state.hasMoreSongs) {
      const before = state.songs.length
      await loadSongPage(playlistId.value, before, false)
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

watch(
  playlistId,
  idNum => {
    if (!Number.isNaN(idNum) && idNum > 0) {
      state.loading = true
      state.showFullDesc = false
      load(idNum)
    }
  },
  { immediate: true }
)

const toggleCollect = () => {
  if (!playlistId.value) return
  libraryStore.toggleCollectPlaylist({
    id: playlistId.value,
    name: state.info.name,
    coverImgUrl: state.info.coverImgUrl,
    trackCount: state.info.songCount,
    creator: state.info.creator,
    playCount: state.info.playCount,
  })
}
</script>

<template>
  <div class="playlist-page flex flex-1 flex-col overflow-hidden">
    <div v-if="state.loading" class="flex-1 overflow-auto px-4 py-6">
      <PageSkeleton :sections="['hero', 'list']" :list-count="8" />
    </div>
    <template v-else>
      <div class="header-section relative">
        <div class="header-bg absolute inset-0 overflow-hidden">
          <LazyImage
            v-if="state.info.coverImgUrl"
            :src="formatCoverUrl(state.info.coverImgUrl, { size: 400 })"
            :alt="$t('components.songList.coverAlt')"
            imgClass="h-full w-full object-cover scale-110"
          />
          <div class="header-overlay absolute inset-0"></div>
        </div>

        <div class="header-content relative z-10 px-4 pt-4 pb-6">
          <div class="flex gap-4">
            <div class="cover-wrapper relative shrink-0">
              <LazyImage
                v-if="state.info.coverImgUrl"
                :src="formatCoverUrl(state.info.coverImgUrl, { size: 300 })"
                :alt="$t('components.songList.coverAlt')"
                imgClass="cover-image h-32 w-32 rounded-2xl object-cover"
              />
              <div
                class="play-count-badge absolute -right-1 -bottom-1 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-accent"
              >
                <span class="icon-[mdi--play] h-3 w-3"></span>
                {{ state.info.playCount }}
              </div>
            </div>

            <div class="flex min-w-0 flex-1 flex-col justify-between py-1">
              <div>
                <h1 class="mb-2 line-clamp-2 text-lg leading-tight font-bold text-accent">
                  {{ state.info.name }}
                </h1>
                <div class="creator-info flex items-center gap-2">
                  <img
                    v-if="state.info.creatorAvatar"
                    :src="formatCoverUrl(state.info.creatorAvatar, { size: 50 })"
                    alt=""
                    class="h-5 w-5 rounded-full"
                    referrerpolicy="no-referrer"
                  />
                  <span class="text-xs text-accent/70">{{ state.info.creator }}</span>
                </div>
              </div>
              <div class="mt-2 flex items-center gap-3 text-[11px] text-accent/60">
                <span class="flex items-center gap-1">
                  <span class="icon-[mdi--music-note] h-3.5 w-3.5"></span>
                  {{ $t('commonUnits.songsShort', { count: state.info.songCount }) }}
                </span>
                <span class="flex items-center gap-1">
                  <span class="icon-[mdi--heart] h-3.5 w-3.5"></span>
                  {{ state.info.likes }}
                </span>
              </div>
            </div>
          </div>

          <div
            v-if="state.info.description"
            class="desc-section mt-4 min-h-11"
            role="button"
            tabindex="0"
            @click="state.showFullDesc = !state.showFullDesc"
            @keydown.enter.prevent="state.showFullDesc = !state.showFullDesc"
            @keydown.space.prevent="state.showFullDesc = !state.showFullDesc"
          >
            <p
              class="text-xs leading-relaxed text-accent/60"
              :class="state.showFullDesc ? '' : 'line-clamp-2'"
            >
              {{ state.info.description }}
            </p>
            <span class="mt-1 inline-flex items-center text-[11px] text-accent/60">
              {{ state.showFullDesc ? $t('common.collapse') : $t('common.expand') }}
              <span
                :class="state.showFullDesc ? 'icon-[mdi--chevron-up]' : 'icon-[mdi--chevron-down]'"
                class="h-3 w-3"
              ></span>
            </span>
          </div>
        </div>
      </div>

      <div class="action-bar flex items-center gap-3 px-4 py-3">
        <Button
          variant="gradient"
          size="md"
          rounded="full"
          class="play-all-btn flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium"
          icon="icon-[mdi--play-circle]"
          icon-class="h-5 w-5"
          @click="handlePlayAll"
        >
          {{ t('actions.playAll') }}
        </Button>
        <Button
          variant="glass"
          size="md"
          rounded="full"
          class="shuffle-btn flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-medium"
          icon="icon-[mdi--shuffle-variant]"
          icon-class="h-5 w-5"
          @click="handleShufflePlay"
        >
          {{ t('actions.shufflePlay') }}
        </Button>
        <Button
          variant="glass"
          size="icon-lg"
          rounded="full"
          class="collect-btn"
          :class="isCollected ? 'collected' : ''"
          :icon="isCollected ? 'icon-[mdi--heart]' : 'icon-[mdi--heart-outline]'"
          icon-class="h-5 w-5"
          :aria-label="isCollected ? t('common.uncollect') : t('common.collect')"
          :title="isCollected ? t('common.uncollect') : t('common.collect')"
          @click="toggleCollect"
        />
        <Button
          variant="glass"
          size="icon-lg"
          rounded="full"
          class="comment-btn"
          icon="icon-[mdi--message-processing-outline]"
          icon-class="h-5 w-5"
          :aria-label="t('player.comments')"
          :title="t('player.comments')"
          @click="state.showComments = true"
        />
        <PlaylistCommentsPopup
          v-model:show="state.showComments"
          :id="playlistId"
          type="playlist"
        />
      </div>

      <div class="flex-1 overflow-auto px-4 pb-6">
        <section>
          <div
            v-if="state.partialPlayNotice"
            class="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-primary/80"
            role="status"
          >
            <span class="icon-[mdi--alert-outline] mt-0.5 h-4 w-4 shrink-0 text-amber-400"></span>
            <span class="flex-1">{{ state.partialPlayNotice }}</span>
            <button
              type="button"
              class="min-h-11 min-w-11 shrink-0 rounded-lg px-2 text-[11px] font-medium text-primary/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-sky-400/60"
              @click="state.partialPlayNotice = ''"
            >
              {{ t('playlist.dismiss') }}
            </button>
          </div>
          <MobileSongList v-if="state.songs.length" :songs="state.songs" :show-index="true" />
          <div
            v-else-if="!state.loading"
            class="my-8 flex flex-col items-center justify-center rounded-2xl bg-white/5 p-8 text-center ring-1 ring-white/10"
          >
            <span class="icon-[mdi--music-off] mb-2 h-8 w-8 text-primary/40" />
            <p class="mb-4 text-xs text-primary/70">{{ t('components.songList.empty') }}</p>
            <Button
              variant="solid"
              size="sm"
              rounded="full"
              @click="load(playlistId)"
            >
              <span class="icon-[mdi--refresh] mr-1.5 h-4 w-4" />
              {{ t('common.retry') }}
            </Button>
          </div>
          <div class="mt-3 flex flex-col items-center gap-2 pb-2">
            <p v-if="state.songTotal" class="text-[11px] text-primary/70">
              {{ t('playlist.loadedProgress', { loaded: state.songs.length, total: state.songTotal }) }}
            </p>
            <Button
              v-if="state.hasMoreSongs"
              variant="glass"
              size="sm"
              rounded="full"
              class="min-h-11"
              :loading="state.isLoadingMoreSongs || state.isPreparingFullList"
              :disabled="state.isLoadingMoreSongs || state.isPreparingFullList"
              @click="loadMoreSongs"
            >
              {{ state.isLoadingMoreSongs || state.isPreparingFullList ? t('playlist.loadingAll') : t('playlist.loadMore') }}
            </Button>
            <p v-else-if="state.songs.length" class="text-[11px] text-primary/40">
              {{ t('playlist.allLoaded') }}
            </p>
            <button
              v-if="state.isSongLoadError && !state.isLoadingMoreSongs"
              type="button"
              class="min-h-11 rounded-lg px-3 text-xs font-medium text-sky-400 hover:text-sky-300 focus-visible:ring-2 focus-visible:ring-sky-400/60"
              @click="loadMoreSongs"
            >
              {{ t('playlist.retryLoad') }}
            </button>
          </div>

          <!-- 相似歌单推荐 (移动端) -->
          <div v-if="state.similarPlaylists.length" class="mt-6 mb-4">
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-xs font-bold text-primary/80">
                {{ t('playlist.tabs.similar', '相似歌单推荐') }}
              </h3>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <router-link
                v-for="pl in state.similarPlaylists"
                :key="pl.id"
                :to="`/playlist/${pl.id}`"
                class="rounded-xl border border-glass bg-white/5 p-2 transition-all active:scale-[0.98]"
              >
                <div class="relative aspect-square overflow-hidden rounded-lg">
                  <LazyImage
                    :src="formatCoverUrl(pl.coverImgUrl, { size: 200 })"
                    :alt="pl.name"
                    imgClass="h-full w-full object-cover"
                    wrapperClass="h-full w-full"
                  />
                  <div
                    v-if="pl.playCount"
                    class="absolute top-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-xs"
                  >
                    <span class="icon-[mdi--play] h-2.5 w-2.5" />
                    {{ formatCount(pl.playCount) }}
                  </div>
                </div>
                <p class="mt-1.5 line-clamp-1 text-xs font-medium text-primary">
                  {{ pl.name }}
                </p>
                <p class="text-[10px] text-primary/50">
                  {{ t('commonUnits.songsShort', { count: pl.trackCount || 0 }) }}
                </p>
              </router-link>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.header-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
}

.header-overlay {
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.3) 0%,
    rgba(0, 0, 0, 0.5) 50%,
    var(--glass-bg-solid) 100%
  );
}

.cover-wrapper {
  filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.4));
}

.cover-image {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.play-count-badge {
  background: linear-gradient(135deg, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.4));
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.play-all-btn {
  background: linear-gradient(135deg, #38bdf8, #2563eb);
  box-shadow: 0 4px 16px rgba(56,189,248, 0.35);
  transition: all 0.3s ease;
}

.play-all-btn:active {
  transform: scale(0.97);
  box-shadow: 0 2px 8px rgba(56,189,248, 0.3);
}

.shuffle-btn {
  background: var(--glass-card-bg);
  color: var(--glass-text-primary);
  border: 1px solid var(--glass-border-default);
  transition: all 0.3s ease;
}

.shuffle-btn:active {
  transform: scale(0.97);
  background: var(--glass-interactive-hover-muted);
}

.collect-btn {
  background: var(--glass-card-bg);
  color: var(--glass-text-primary);
  border: 1px solid var(--glass-border-default);
  transition: all 0.3s ease;
}

.collect-btn:active {
  transform: scale(0.95);
}

.collect-btn.collected {
  background: linear-gradient(135deg, rgba(56,189,248, 0.2), rgba(37,99,235, 0.2));
  border-color: rgba(56,189,248, 0.3);
  color: #38bdf8;
}

.comment-btn {
  background: var(--glass-card-bg);
  color: var(--glass-text-primary);
  border: 1px solid var(--glass-border-default);
  transition: all 0.3s ease;
}

.comment-btn:active {
  transform: scale(0.95);
}

.desc-section {
  cursor: pointer;
}
</style>

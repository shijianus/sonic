<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAudioStore } from '@/stores/modules/audio'
import { useLibraryStore } from '@/stores/modules/library'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useToastStore } from '@/stores/modules/toast'
import { fetchRecommendForYou, type RecommendSongItem } from '@/api/recommend'
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatCoverUrl } from '@/utils/imageUrl'

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false,
  }
)

const { t } = useI18n()
const router = useRouter()
const audioStore = useAudioStore()
const libraryStore = useLibraryStore()
const recommendStore = useRecommendStore()
const toastStore = useToastStore()

const loading = ref<boolean>(false)
const tracks = ref<RecommendSongItem[]>([])

const visibleTracks = computed(() => {
  const maxItems = props.compact ? 6 : 8
  return tracks.value
    .filter((item) => !recommendStore.isSongDisliked(item.canonicalTrackId || item.id))
    .slice(0, maxItems)
})

const currentSongId = computed(() => audioStore.audio.currentSong?.id)

const isCurrentPlaying = (id: string | number) =>
  String(currentSongId.value) === String(id) && audioStore.audio.isPlaying

const formatDuration = (ms?: number) => {
  if (!ms || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const getBadgeLabel = (song: RecommendSongItem): string => {
  const src = song.scoreSource || song.explanation?.scoreSource || ''
  if (src === 'cfsolara-internal') return t('recommend.badges.internalHot')
  if (src === 'external-chart') return t('recommend.badges.externalRef')
  if (src === 'personalized-interest' || src === 'hybrid-personalized') {
    return t('recommend.badges.personalizedTag')
  }
  if (src === 'content-similarity') return t('recommend.badges.contentMatch')
  return t('recommend.badges.coldStart')
}

const getBadgeClass = (song: RecommendSongItem): string => {
  const src = song.scoreSource || song.explanation?.scoreSource || ''
  if (src === 'cfsolara-internal') {
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  }
  if (src === 'external-chart') {
    return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
  }
  if (src === 'personalized-interest' || src === 'hybrid-personalized') {
    return 'bg-sky-500/15 text-sky-400 border-sky-500/30'
  }
  return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
}

async function loadRecommendations() {
  loading.value = true
  const headers = recommendStore.buildRequestHeaders(true)
  const count = props.compact ? 8 : 12

  try {
    const res = await fetchRecommendForYou(
      {
        mode: 'for-you',
        count,
      },
      headers
    )
    tracks.value = res.tracks
  } catch (err) {
    console.warn('[MusicRadar] load failed:', err)
  } finally {
    loading.value = false
  }
}

function handlePlaySong(song: RecommendSongItem, idx: number) {
  const list = visibleTracks.value
  if (!list.length) return
  audioStore.setPlaylist(list, idx)
  audioStore.playSong(song, idx, true)
}

function handlePlayAll() {
  const list = visibleTracks.value
  if (!list.length) return
  audioStore.setPlaylist(list, 0)
  audioStore.playSong(list[0], 0, true)
}

async function handleStartRadio(song: RecommendSongItem, e: Event) {
  e.stopPropagation()
  await recommendStore.startSongRadio(song)
}

function handleToggleLike(song: RecommendSongItem, e: Event) {
  e.stopPropagation()
  libraryStore.toggleLikeSong(song)
}

function handleDislike(song: RecommendSongItem, e: Event) {
  e.stopPropagation()
  recommendStore.dislikeSong(song)
  toastStore.show({
    message: t('recommend.actions.dislikedToast'),
    type: 'info',
    duration: 2800,
  })
}

function goSongDetail(song: RecommendSongItem, e: Event) {
  e.stopPropagation()
  router.push(`/song/${song.id}`)
}

// 布局对路由组件 keep-alive，在设置页切换个性化后返回立即重拉
watch(
  () => recommendStore.personalizationEnabled,
  () => {
    loadRecommendations()
  }
)

onMounted(() => {
  loadRecommendations()
})
</script>

<template>
  <section class="music-radar-section">
    <!-- 顶部标题栏：音乐雷达与快捷动作 -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2
          class="text-primary flex items-center gap-2.5 font-bold tracking-tight"
          :class="compact ? 'text-base' : 'text-xl'"
        >
          <span
            class="flex items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-cyan-500 text-slate-950 shadow-sm"
            :class="compact ? 'h-7 w-7' : 'h-8 w-8'"
          >
            <span class="icon-[mdi--radar]" :class="compact ? 'h-4 w-4' : 'h-5 w-5'" />
          </span>
          <span>{{ t('recommend.musicRadar') }}</span>
        </h2>
        <p v-if="!compact" class="text-primary/55 mt-1 text-xs">
          {{ t('recommend.musicRadarSubtitle') }}
        </p>
      </div>

      <!-- 右侧快捷操作按钮 -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="loadRecommendations"
          :disabled="loading"
          class="border-glass bg-hover-glass text-primary/75 hover:text-primary inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all"
        >
          <span
            class="icon-[mdi--refresh] h-3.5 w-3.5"
            :class="loading ? 'animate-spin' : ''"
          />
          <span>{{ t('recommend.actions.refresh') }}</span>
        </button>

        <button
          v-if="visibleTracks.length > 0"
          type="button"
          @click="handlePlayAll"
          class="inline-flex items-center gap-1.5 rounded-xl bg-sky-500/20 px-3.5 py-1.5 text-xs font-semibold text-[var(--glass-text-accent)] transition-all hover:bg-sky-500/30"
        >
          <span class="icon-[mdi--play] h-4 w-4" />
          <span>{{ t('recommend.actions.playAll') }}</span>
        </button>
      </div>
    </div>

    <!-- 推荐歌曲网格 -->
    <div
      v-if="loading && visibleTracks.length === 0"
      class="grid gap-3"
      :class="compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4'"
    >
      <div
        v-for="n in compact ? 4 : 8"
        :key="n"
        class="glass-card border-glass flex items-center gap-3 rounded-2xl border p-3 animate-pulse"
      >
        <div class="bg-hover-glass h-14 w-14 shrink-0 rounded-xl" />
        <div class="min-w-0 flex-1 space-y-2">
          <div class="bg-hover-glass h-3.5 w-3/4 rounded" />
          <div class="bg-hover-glass h-3 w-1/2 rounded" />
        </div>
      </div>
    </div>

    <div
      v-else
      class="grid gap-3"
      :class="compact ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-4'"
    >
      <div
        v-for="(song, idx) in visibleTracks"
        :key="`${song.canonicalTrackId || song.id}-${idx}`"
        @click="handlePlaySong(song, idx)"
        class="glass-card border-glass hover:bg-hover-glass group relative flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition-all duration-200"
      >
        <!-- 封面与播放悬浮层 -->
        <div class="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl">
          <LazyImage
            :src="formatCoverUrl(song.cover, { size: 160, artist: song.artist })"
            :alt="song.name"
            img-class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          <div
            class="bg-overlay/45 absolute inset-0 flex items-center justify-center transition-opacity duration-200"
            :class="isCurrentPlaying(song.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
          >
            <span
              class="h-6 w-6 text-sky-400"
              :class="isCurrentPlaying(song.id) ? 'icon-[mdi--volume-high]' : 'icon-[mdi--play]'"
            />
          </div>
        </div>

        <!-- 歌曲信息与可解释原因标签 -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p
              @click="goSongDetail(song, $event)"
              class="text-primary truncate text-sm font-semibold hover:text-[var(--glass-text-accent)]"
            >
              {{ song.name }}
            </p>
            <span
              class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none font-medium"
              :class="getBadgeClass(song)"
            >
              {{ getBadgeLabel(song) }}
            </span>
          </div>

          <p class="text-primary/65 mt-0.5 truncate text-xs">
            {{ song.artist }}
            <span v-if="song.album" class="text-primary/40"> · {{ song.album }}</span>
          </p>

          <p
            v-if="song.recommendReason"
            class="text-primary/50 mt-1 flex items-center gap-1 truncate text-[11px]"
          >
            <span class="icon-[mdi--sparkles] h-3 w-3 shrink-0 text-sky-400" />
            <span class="truncate">{{ song.recommendReason }}</span>
          </p>
        </div>

        <!-- 快捷操作按钮：相似电台 / 喜欢 / 不感兴趣 -->
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            :title="t('recommend.actions.startRadio')"
            @click="handleStartRadio(song, $event)"
            class="text-primary/50 hover:bg-hover-glass hover:text-[var(--glass-text-accent)] flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
          >
            <span class="icon-[mdi--radio-tower] h-4 w-4" />
          </button>

          <button
            type="button"
            @click="handleToggleLike(song, $event)"
            class="hover:bg-hover-glass flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
            :class="
              libraryStore.isSongLiked(song.id)
                ? 'text-rose-500'
                : 'text-primary/50 hover:text-rose-400'
            "
          >
            <span
              class="h-4 w-4"
              :class="
                libraryStore.isSongLiked(song.id)
                  ? 'icon-[mdi--heart]'
                  : 'icon-[mdi--heart-outline]'
              "
            />
          </button>

          <button
            type="button"
            :title="t('recommend.actions.dislike')"
            @click="handleDislike(song, $event)"
            class="text-primary/40 hover:bg-hover-glass hover:text-primary/80 flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
          >
            <span class="icon-[mdi--close] h-3.5 w-3.5" />
          </button>

          <span v-if="!compact" class="text-primary/40 ml-1 text-[11px] tabular-nums">
            {{ formatDuration(song.duration) }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

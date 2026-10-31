<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAudioStore } from '@/stores/modules/audio'
import { useLibraryStore } from '@/stores/modules/library'
import { useRecommendStore } from '@/stores/modules/recommend'
import { fetchRecommendDiscover, type RecommendSongItem } from '@/api/recommend'
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

const emit = defineEmits<{
  (e: 'select-genre', genre: string): void
}>()

const { t } = useI18n()
const router = useRouter()
const audioStore = useAudioStore()
const libraryStore = useLibraryStore()
const recommendStore = useRecommendStore()

const selectedGenre = ref<string>('')
const explorationTemp = ref<number>(0.55)
const loading = ref<boolean>(false)
const tracks = ref<RecommendSongItem[]>([])

const genreOptions = [
  { label: '全部风格', value: '' },
  { label: '华语流行', value: '华语流行' },
  { label: 'R&B', value: 'R&B' },
  { label: '粤语金曲', value: '粤语流行' },
  { label: '摇滚', value: '摇滚' },
  { label: '民谣', value: '民谣' },
  { label: '独立音乐', value: '独立音乐' },
  { label: '欧美流行', value: '欧美流行' },
  { label: '日语流行', value: '日语流行' },
  { label: '说唱', value: '说唱' },
  { label: '纯音乐', value: '纯音乐' },
]

const tempLevels = computed(() => [
  { label: t('recommend.temperature.safe'), value: 0.25 },
  { label: t('recommend.temperature.balanced'), value: 0.55 },
  { label: t('recommend.temperature.bold'), value: 0.85 },
])

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

async function loadDiscoverTracks() {
  loading.value = true
  const headers = recommendStore.buildRequestHeaders(false)
  const count = props.compact ? 8 : 12

  try {
    const res = await fetchRecommendDiscover(
      {
        genre: selectedGenre.value || undefined,
        temperature: explorationTemp.value,
        count,
      },
      headers
    )
    tracks.value = res.tracks
  } catch (err) {
    console.warn('[StyleRadar] load failed:', err)
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

function goSongDetail(song: RecommendSongItem, e: Event) {
  e.stopPropagation()
  router.push(`/song/${song.id}`)
}

function onGenreClick(val: string) {
  selectedGenre.value = val
}

watch([selectedGenre, explorationTemp], () => {
  loadDiscoverTracks()
})

onMounted(() => {
  loadDiscoverTracks()
})
</script>

<template>
  <section class="style-radar-section">
    <!-- 头部栏 -->
    <div class="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2
          class="text-primary flex items-center gap-2.5 font-bold tracking-tight"
          :class="compact ? 'text-base' : 'text-xl'"
        >
          <span
            class="flex items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-sky-500 text-slate-950 shadow-sm"
            :class="compact ? 'h-7 w-7' : 'h-8 w-8'"
          >
            <span class="icon-[mdi--compass-rose]" :class="compact ? 'h-4 w-4' : 'h-5 w-5'" />
          </span>
          <span>{{ t('recommend.styleRadar') }}</span>
        </h2>
        <p v-if="!compact" class="text-primary/55 mt-1 text-xs">
          {{ t('recommend.styleRadarSubtitle') }}
        </p>
      </div>

      <!-- 右侧控制按钮 -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="loadDiscoverTracks"
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

    <!-- 流派选择器与探索温度控制栏 -->
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2.5">
      <div class="scrollbar-hide flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full">
        <button
          v-for="g in genreOptions"
          :key="g.value || 'all'"
          type="button"
          @click="onGenreClick(g.value)"
          class="shrink-0 rounded-full border px-2.5 py-1 text-xs transition-all"
          :class="
            selectedGenre === g.value
              ? 'border-sky-400/50 bg-sky-500/20 font-medium text-[var(--glass-text-accent)]'
              : 'border-glass bg-hover-glass text-primary/65 hover:text-primary'
          "
        >
          {{ g.label }}
        </button>
      </div>

      <div class="flex items-center gap-1.5 text-xs">
        <span class="text-primary/50 text-[11px]">{{ t('recommend.temperature.label') }}:</span>
        <button
          v-for="lv in tempLevels"
          :key="lv.value"
          type="button"
          @click="explorationTemp = lv.value"
          class="rounded-lg border px-2 py-0.5 text-[11px] transition-all"
          :class="
            Math.abs(explorationTemp - lv.value) < 0.05
              ? 'border-cyan-400/50 bg-cyan-500/20 text-[var(--glass-text-accent)]'
              : 'border-glass text-primary/60 hover:text-primary'
          "
        >
          {{ lv.label }}
        </button>
      </div>
    </div>

    <!-- 歌曲卡片列表 -->
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

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p
              @click="goSongDetail(song, $event)"
              class="text-primary truncate text-sm font-semibold hover:text-[var(--glass-text-accent)]"
            >
              {{ song.name }}
            </p>
            <span
              v-if="song.genres && song.genres.length > 0"
              class="shrink-0 rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-sky-400"
            >
              {{ song.genres[0] }}
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
            <span class="icon-[mdi--compass-outline] h-3 w-3 shrink-0 text-sky-400" />
            <span class="truncate">{{ song.recommendReason }}</span>
          </p>
        </div>

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

          <span v-if="!compact" class="text-primary/40 ml-1 text-[11px] tabular-nums">
            {{ formatDuration(song.duration) }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

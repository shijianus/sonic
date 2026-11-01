<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAudioStore } from '@/stores/modules/audio'
import { useRecommendStore } from '@/stores/modules/recommend'
import { fetchRecommendDiscover, type RecommendSongItem } from '@/api/recommend'
import SongCard from '@/components/Ui/SongCard.vue'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'
import { getRadarBadgeClass } from '@/utils/exploreTags'

interface Props {
  compact?: boolean
  genre?: string
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
  genre: '',
})

const { t } = useI18n()
const audioStore = useAudioStore()
const recommendStore = useRecommendStore()

const selectedGenre = ref<string>(props.genre || '')
const explorationTemp = ref<number>(0.55)
const loading = ref<boolean>(false)
const tracks = ref<RecommendSongItem[]>([])

const visibleTracks = computed(() => {
  const maxItems = props.compact ? 6 : 10
  return tracks.value
    .filter((item) => !recommendStore.isSongDisliked(item.canonicalTrackId || item.id))
    .slice(0, maxItems)
})

async function loadDiscoverTracks(isRefresh = false) {
  loading.value = true
  const headers = recommendStore.buildRequestHeaders(false)
  const count = props.compact ? 8 : 20

  try {
    // 换一批时对探索温度做轻微自适应漂移，结合服务端抽取获得新组合
    const temp = isRefresh
      ? Math.round((0.4 + Math.random() * 0.5) * 100) / 100
      : explorationTemp.value

    const res = await fetchRecommendDiscover(
      {
        genre: selectedGenre.value || undefined,
        temperature: temp,
        count,
      },
      headers
    )
    let newTracks = res.tracks || []
    if (isRefresh && newTracks.length > 8) {
      newTracks = [...newTracks].sort(() => Math.random() - 0.5)
    }
    tracks.value = newTracks
  } catch (err) {
    console.warn('[StyleRadar] load failed:', err)
  } finally {
    loading.value = false
  }
}

function handlePlayAll() {
  const list = visibleTracks.value
  if (!list.length) return
  audioStore.setPlaylist(list, 0)
  audioStore.playSong(list[0], 0, true)
}

watch(
  () => props.genre,
  (newGenre) => {
    selectedGenre.value = (newGenre || '').trim()
    loadDiscoverTracks()
  }
)

onMounted(() => {
  loadDiscoverTracks()
})

defineExpose({
  refresh: () => loadDiscoverTracks(true),
  loadDiscoverTracks,
  setGenre: (g: string) => {
    selectedGenre.value = g.trim()
    loadDiscoverTracks()
  },
})
</script>

<template>
  <section class="style-radar-section">
    <!-- 头部栏：标题 + 换一批 / 播放全部 -->
    <div class="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <h2
          class="text-primary flex items-center gap-2 font-bold tracking-tight"
          :class="compact ? 'text-base' : 'text-xl'"
        >
          <span class="icon-[mdi--compass-rose] h-4 w-4 text-sky-400" />
          <span>{{ t('recommend.styleRadar') }}</span>
          <template v-if="selectedGenre">
            <span
              v-for="g in selectedGenre.split(/\s+/).filter(Boolean)"
              :key="g"
              class="rounded-full border px-2 py-0.5 text-xs font-medium transition-colors"
              :class="getRadarBadgeClass(g)"
            >
              # {{ g }}
            </span>
          </template>
        </h2>
      </div>

      <!-- 右侧快捷操作按钮 -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="loadDiscoverTracks(true)"
          :disabled="loading"
          class="border-glass bg-hover-glass text-primary/75 hover:text-primary inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all"
        >
          <span
            class="icon-[mdi--refresh] h-3.5 w-3.5"
            :class="loading ? 'animate-spin' : ''"
          />
          <span>换一批</span>
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

    <!-- 骨架屏：对齐 SongCard 双列单曲布局 -->
    <div
      v-if="loading && visibleTracks.length === 0"
      class="songs-container overflow-hidden rounded-2xl"
    >
      <div class="grid md:grid-cols-2">
        <div
          v-for="n in compact ? 4 : 8"
          :key="n"
          class="song-divider flex w-full items-center gap-4 p-3.5 animate-pulse"
        >
          <div class="h-7 w-7 shrink-0 rounded-xl bg-glass-subtle" />
          <div class="h-12 w-12 shrink-0 rounded-xl bg-glass-subtle" />
          <div class="min-w-0 flex-1 space-y-2">
            <div class="h-3.5 w-3/4 rounded bg-glass-subtle" />
            <div class="h-3 w-1/2 rounded bg-glass-subtle" />
          </div>
          <div class="h-3 w-8 shrink-0 rounded bg-glass-subtle" />
        </div>
      </div>
    </div>

    <!-- 移动端紧凑列表视图 -->
    <div v-else-if="compact">
      <MobileSongList :songs="visibleTracks" variant="compact" :show-index="true" />
    </div>

    <!-- PC 桌面端：单曲展示结构 (双列 SongCard + song-divider) -->
    <div v-else class="songs-container overflow-hidden rounded-2xl">
      <div class="grid md:grid-cols-2">
        <SongCard
          v-for="(song, idx) in visibleTracks"
          :key="`${song.canonicalTrackId || song.id}-${idx}`"
          :song="song"
          :index="idx"
          :to="`/song/${song.id}`"
          class="song-divider"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ── 歌曲列表容器 ── */
.songs-container {
  background: transparent;
  border: none;
}

/* ── 歌曲分隔线 ── */
.song-divider {
  border-bottom: 1px solid var(--glass-border-subtle);
}

.song-divider:last-child,
.song-divider:nth-last-child(2):nth-child(odd) {
  border-bottom: none;
}
</style>

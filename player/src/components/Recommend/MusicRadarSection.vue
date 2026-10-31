<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAudioStore } from '@/stores/modules/audio'
import { useGlobalStore } from '@/stores/modules/global'
import { useRecommendStore } from '@/stores/modules/recommend'
import { fetchRecommendForYou, type RecommendSongItem } from '@/api/recommend'
import SongCard from '@/components/Ui/SongCard.vue'
import MobileSongList from '@/components/Mobile/MobileSongList.vue'

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false,
  }
)

const { t } = useI18n()
const audioStore = useAudioStore()
const globalStore = useGlobalStore()
const recommendStore = useRecommendStore()

// 仅当用户真实进行过搜索检索时才启用音乐雷达，杜绝冷启动盲猜
const hasSearched = computed(() => (globalStore.searchHistory?.length || 0) > 0)

const loading = ref<boolean>(false)
const tracks = ref<RecommendSongItem[]>([])

const visibleTracks = computed(() => {
  const maxItems = props.compact ? 6 : 12
  return tracks.value
    .filter((item) => !recommendStore.isSongDisliked(item.canonicalTrackId || item.id))
    .slice(0, maxItems)
})

async function loadRecommendations() {
  if (!hasSearched.value) {
    tracks.value = []
    return
  }

  loading.value = true
  const headers = recommendStore.buildRequestHeaders(true)
  const count = props.compact ? 8 : 16

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

function handlePlayAll() {
  const list = visibleTracks.value
  if (!list.length) return
  audioStore.setPlaylist(list, 0)
  audioStore.playSong(list[0], 0, true)
}

watch(hasSearched, (searched) => {
  if (searched) {
    loadRecommendations()
  } else {
    tracks.value = []
  }
})

// 监听个性化偏好开关
watch(
  () => recommendStore.personalizationEnabled,
  () => {
    if (hasSearched.value) {
      loadRecommendations()
    }
  }
)

onMounted(() => {
  if (hasSearched.value) {
    loadRecommendations()
  }
})
</script>

<template>
  <section v-if="hasSearched && (visibleTracks.length > 0 || loading)" class="music-radar-section">
    <!-- 顶部标题栏：与热门歌曲保持完全一致的设计语言 -->
    <div class="mb-6 flex items-baseline justify-between">
      <h2 class="text-primary flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-cyan-500 shadow-sm"
        >
          <span class="icon-[mdi--radar] h-5 w-5 text-white" />
        </span>
        {{ t('recommend.musicRadar') }}
      </h2>

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

    <!-- 骨架屏：排版完全对齐 SongCard 双列布局 -->
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
          <div class="h-7 w-7 shrink-0 rounded-xl bg-white/5" />
          <div class="h-12 w-12 shrink-0 rounded-xl bg-white/5" />
          <div class="min-w-0 flex-1 space-y-2">
            <div class="h-3.5 w-3/4 rounded bg-white/5" />
            <div class="h-3 w-1/2 rounded bg-white/5" />
          </div>
          <div class="h-3 w-8 shrink-0 rounded bg-white/5" />
        </div>
      </div>
    </div>

    <!-- 移动端紧凑列表视图 -->
    <div v-else-if="compact">
      <MobileSongList :songs="visibleTracks" variant="compact" :show-index="true" />
    </div>

    <!-- PC 桌面端：完全学习热门单曲的排版结构 (双列 SongCard + song-divider) -->
    <div v-else class="songs-container overflow-hidden rounded-2xl">
      <div class="grid md:grid-cols-2">
        <SongCard
          v-for="(song, idx) in visibleTracks"
          :key="song.id"
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

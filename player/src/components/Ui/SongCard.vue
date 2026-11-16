<script setup lang="ts">
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatDurationOrDash } from '@/utils/time'
import { useAudio } from '@/composables/useAudio'
import { useSharedElement } from '@/composables/useSharedElement'
import { formatCoverUrl } from '@/utils/imageUrl'
import type { Song as StoreSong } from '@/stores/interface'
import { songIdentityKey } from '@/utils/songIdentity'

interface Props {
  song: {
    id: number | string
    name: string
    artist: string
    cover: string
    duration: number
    album?: string
    url?: string
    streamUrl?: string
    qualities?: Array<{ level: string; label: string; bitrate: string; streamUrl?: string; format?: string; desc?: string }>
    sources?: Array<{ platform: string; platformId: string | number; duration?: number }>
    source?: string
    platform?: string
    platformId?: string | number
    resolvedSource?: string
    resolvedId?: string | number
    resolvedPlatformId?: string | number
    resolvedTitle?: string
    resolvedArtist?: string
    streamType?: 'full' | 'trial' | 'unavailable'
    qualityBadge?: string
    sha?: string
  }
  index: number
  to?: string
}

const props = defineProps<Props>()
const router = useRouter()
const cardRef = ref<HTMLElement | null>(null)
const coverRef = ref<HTMLElement | null>(null)
const { playAfterCurrent, currentSong, isPlaying } = useAudio()
const { flyTo } = useSharedElement()

const isCurrent = computed(() => {
  const current = currentSong.value
  if (!current) return false
  return songIdentityKey(current) === songIdentityKey(props.song)
})

// 播放歌曲并执行封面飞行动画：保留现有队列，插入到当前播放之后
const handleClick = async (_event: MouseEvent) => {
  if (!cardRef.value || !coverRef.value) {
    if (props.to) router.push(props.to)
    return
  }

  const coverEl = coverRef.value
  const footerCover = document.getElementById('footer-cover')

  // 播放歌曲
  const rawSong = props.song as any
  const storeSong: StoreSong = {
    id: rawSong.id,
    name: rawSong.name,
    artist: rawSong.artist,
    album: rawSong.album || '',
    duration: rawSong.duration,
    cover: rawSong.cover,
    url: rawSong.url || rawSong.streamUrl,
    streamUrl: rawSong.streamUrl,
    qualities: rawSong.qualities,
    sources: rawSong.sources,
    streamType: rawSong.streamType,
    sha: rawSong.sha,
    qualityBadge: rawSong.qualityBadge,
    source: rawSong.source,
    platform: rawSong.platform,
    platformId: rawSong.platformId,
    resolvedSource: rawSong.resolvedSource,
    resolvedId: rawSong.resolvedId,
    resolvedPlatformId: rawSong.resolvedPlatformId,
    resolvedTitle: rawSong.resolvedTitle,
    resolvedArtist: rawSong.resolvedArtist,
  }
  playAfterCurrent(storeSong)

  if (footerCover && props.song.cover) {
    void flyTo(
      coverEl,
      footerCover,
      formatCoverUrl(props.song.cover, { size: 100, artist: props.song.artist }),
      { duration: 0.35 }
    )
  }
}
</script>

<template>
  <button
    ref="cardRef"
    type="button"
    class="song-card group flex w-full cursor-pointer items-center gap-4 rounded-2xl p-3.5 text-left transition-colors duration-150 outline-none hover:bg-white/10 active:scale-[0.99] focus-visible:ring-2 focus-visible:ring-sky-400/70"
    :aria-current="isCurrent ? 'true' : undefined"
    @click="handleClick"
  >
    <!-- 排名 -->
    <span
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold tracking-tight"
      :class="
        index < 3
          ? 'bg-gradient-to-br from-[#2563eb] via-[#38bdf8] to-[#3b82f6] text-[var(--glass-text-accent)] shadow-[0_0_12px_rgba(37,99,235,0.55)]'
          : 'bg-primary/5 text-primary/40'
      "
    >
      {{ index + 1 }}
    </span>

    <!-- 封面 -->
    <div ref="coverRef" class="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl shadow-md ring-1 ring-white/10">
      <LazyImage
        :src="formatCoverUrl(song.cover, { size: 100, artist: song.artist })"
        :fallback-src="formatCoverUrl('', { artist: song.artist })"
        alt="cover"
        img-class="h-full w-full object-cover transition-transform duration-200 ease-out group-hover:scale-105"
      />
      <div
        class="songcard-hover-play absolute inset-0 flex items-center justify-center transition-[opacity,background-color] duration-150"
        :class="isCurrent ? 'bg-black/45 opacity-100' : 'bg-black/0 opacity-0 group-hover:bg-black/40 group-hover:opacity-100'"
      >
        <span
          v-if="isCurrent"
          class="playing-icon"
          aria-hidden="true"
        >
          <span class="bar" :class="{ animate: isPlaying }"></span>
          <span class="bar" :class="{ animate: isPlaying }"></span>
          <span class="bar" :class="{ animate: isPlaying }"></span>
        </span>
        <span v-else class="icon-[mdi--play] h-5 w-5 text-[var(--glass-text-accent)]" />
      </div>
    </div>

    <!-- 信息 -->
    <div class="min-w-0 flex-1">
      <p
        class="line-clamp-1 text-sm font-semibold transition-colors group-hover:text-[#60a5fa]"
        :class="isCurrent ? 'text-[#2563eb] dark:text-sky-300' : 'text-primary'"
      >
        {{ song.name }}
      </p>
      <p class="text-primary/50 mt-0.5 truncate text-xs">{{ song.artist }}</p>
    </div>

    <!-- 时长 -->
    <span class="text-primary/30 shrink-0 text-xs font-mono">
      {{ formatDurationOrDash(song.duration) }}
    </span>
  </button>
</template>

<style scoped>
@media (hover: none) {
  .songcard-hover-play {
    opacity: 1;
  }
}
</style>

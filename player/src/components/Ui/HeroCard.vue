<script setup lang="ts">
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatCount } from '@/utils/time'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useI18n } from 'vue-i18n'
import { useCardTilt } from '@/composables/useCardTilt'

interface Props {
  id: number | string
  coverUrl: string
  title: string
  subtitle?: string
  playCount?: number
  trackCount?: number
  to: string
  aspectRatio?: 'square' | 'video'
  enableTilt?: boolean
  isPlaying?: boolean
  isLoading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  aspectRatio: 'square',
  enableTilt: true,
  isPlaying: false,
  isLoading: false,
})

const emit = defineEmits<{
  (e: 'play', payload: { id: number | string; event: MouseEvent }): void
}>()

const handlePlayClick = (e: MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  emit('play', { id: props.id, event: e })
}

const router = useRouter()
const { t } = useI18n()
const cardRef = ref<HTMLElement | null>(null)
const resolvedHref = computed(() => router.resolve(props.to).href)

const {
  onMouseEnter: handleMouseEnter,
  onMouseMove: handleMouseMove,
  onMouseLeave: handleMouseLeave,
} = useCardTilt(cardRef, {
  enabled: () => props.enableTilt,
})

// 即时路由跳转，去除阻塞式全屏克隆展开动画
const handleClick = (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  router.push(props.to)
}
</script>

<template>
  <a
    ref="cardRef"
    :href="resolvedHref"
    class="hero-card group block cursor-pointer rounded-2xl outline-none transition-transform duration-150 ease-out active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-sky-400/70"
    @click="handleClick"
    @mousemove="handleMouseMove"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <div
      class="hero-card-inner border-glass/60 relative overflow-hidden rounded-2xl border shadow-lg transition-[border-color,box-shadow] duration-200 group-hover:border-sky-400/35 group-hover:shadow-xl"
      :class="aspectRatio === 'video' ? 'aspect-video' : 'aspect-square'"
    >
      <LazyImage
        :src="formatCoverUrl(coverUrl, { size: 300 })"
        :alt="title"
        img-class="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
        wrapper-class="h-full w-full"
      />

      <!-- 渐变遮罩 -->
      <div class="absolute inset-0 bg-linear-to-t from-black/75 via-black/20 to-transparent" />

      <!-- 播放量标签（不使用 backdrop-blur-sm 以避免密集列表模糊层） -->
      <div
        v-if="playCount"
        class="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-slate-950/75 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums border border-sky-400/20"
      >
        <span class="icon-[mdi--headphones] h-3 w-3" />
        {{ formatCount(playCount) }}
      </div>

      <!-- 底部信息 -->
      <div class="absolute right-0 bottom-0 left-0 p-2.5">
        <p class="line-clamp-2 text-xs leading-tight font-medium text-white">
          {{ title }}
        </p>
        <div v-if="trackCount" class="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/70">
          <span class="icon-[mdi--music-note] h-3 w-3" />
          <span>{{ t('commonUnits.songs', { count: trackCount }) }}</span>
        </div>
      </div>

      <!-- 悬停播放按钮 -->
      <div
        class="hero-hover-play absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      >
        <button
          type="button"
          class="flex h-12 w-12 scale-90 items-center justify-center rounded-full bg-linear-to-br from-[#2563eb] to-[#38bdf8] text-white shadow-[0_8px_24px_rgba(37,99,235,0.55)] transition-transform duration-150 ease-out hover:scale-105 active:scale-95 group-hover:scale-100 ring-1 ring-white/40 cursor-pointer"
          :title="t('actions.playAll')"
          :aria-label="t('actions.playAll')"
          @click.stop.prevent="handlePlayClick"
        >
          <span v-if="isLoading" class="icon-[mdi--loading] h-6 w-6 animate-spin text-white" />
          <span v-else-if="isPlaying" class="icon-[mdi--pause] h-6 w-6 text-white" />
          <span v-else class="icon-[mdi--play] h-6 w-6 text-white" />
        </button>
      </div>
    </div>
  </a>
</template>

<style scoped>
.hero-card {
  min-width: 140px;
  transform-origin: center center;
  transform-style: preserve-3d;
}

.hero-card-inner {
  transform-style: preserve-3d;
}

@media (hover: none) {
  .hero-hover-play {
    opacity: 1;
  }
}
</style>

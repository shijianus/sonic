<script setup lang="ts">
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatCount } from '@/utils/time'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useCardTilt } from '@/composables/useCardTilt'

interface Props {
  id: number | string
  name: string
  artist: string
  cover: string
  playCount?: number
  to: string
  enableTilt?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  enableTilt: true,
})

const router = useRouter()
const cardRef = ref<HTMLElement | null>(null)
const resolvedHref = computed(() => router.resolve(props.to).href)

const {
  onMouseEnter: handleMouseEnter,
  onMouseMove: handleMouseMove,
  onMouseLeave: handleMouseLeave,
} = useCardTilt(cardRef, {
  enabled: () => props.enableTilt,
})

// 即时导航，去除阻塞式点击克隆与无限脉冲动画
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
    class="mv-card group block cursor-pointer rounded-2xl outline-none transition-transform duration-150 ease-out active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-sky-400/70"
    @click="handleClick"
    @mousemove="handleMouseMove"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <div class="mv-card-inner border-glass/60 relative aspect-video overflow-hidden rounded-2xl border shadow-xl transition-[border-color,box-shadow] duration-200 group-hover:border-sky-400/40">
      <LazyImage
        :src="formatCoverUrl(cover, { width: 400, height: 225, artist })"
        :fallback-src="formatCoverUrl('', { artist })"
        :alt="name"
        img-class="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
        wrapper-class="h-full w-full"
      />

      <!-- 渐变遮罩 -->
      <div class="absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent" />

      <!-- 播放量（移除 backdrop-blur-sm 消除滚动合成开销） -->
      <div
        v-if="playCount"
        class="absolute top-2 right-2 flex items-center gap-1 rounded-full bg-slate-950/75 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums border border-sky-400/20"
      >
        <span class="icon-[mdi--play] h-3 w-3" />
        {{ formatCount(playCount) }}
      </div>

      <!-- 悬停播放按钮 -->
      <div
        class="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div
          class="play-button flex h-13 w-13 scale-90 items-center justify-center rounded-full bg-gradient-to-br from-[#2563eb] to-[#38bdf8] text-white opacity-0 shadow-[0_8px_24px_rgba(37,99,235,0.6)] ring-1 ring-white/40 transition-[transform,opacity] duration-150 ease-out group-hover:scale-100 group-hover:opacity-100"
        >
          <span class="play-icon icon-[mdi--play] h-7 w-7 text-white" />
        </div>
      </div>

      <!-- 底部信息 -->
      <div class="absolute right-0 bottom-0 left-0 p-3">
        <p class="truncate text-sm font-medium text-white">{{ name }}</p>
        <p class="mt-0.5 truncate text-[11px] text-white/70">{{ artist }}</p>
      </div>
    </div>
  </a>
</template>

<style scoped>
.mv-card {
  transform-origin: center center;
  transform-style: preserve-3d;
}

.mv-card-inner {
  transform-style: preserve-3d;
}

@media (hover: none) {
  .play-button {
    opacity: 1 !important;
    transform: scale(1) !important;
  }
}
</style>

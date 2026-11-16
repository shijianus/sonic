<script setup lang="ts">
import { useAudio } from '@/composables/useAudio'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps({
  color: {
    type: Array as PropType<string[]>,
    default: () => [],
  },
})

// 生成渐变样式
const gradientStyle = computed(() => {
  if (props.color.length === 0) {
    // 使用默认渐变
    return 'linear-gradient(90deg, #38bdf8, #2563eb)'
  }
  // 使用传入的颜色数组生成渐变
  return `linear-gradient(90deg, ${props.color.join(', ')})`
})

const { currentSong, currentTime, duration, progress, setProgress, setCurrentTime } = useAudio()

const progressBarRef = useTemplateRef('progressBarRef')

const state = reactive({
  isDragging: false,
  dragProgress: null as number | null,
  showTimePreview: false,
  previewTime: 0,
  previewPercent: 0,
})

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const totalSeconds = computed(() => {
  let total = duration.value
  if (!total && currentSong.value?.duration) {
    total = currentSong.value.duration
    if (total > 10000) total = total / 1000
  }
  return Math.max(0, total || 0)
})

const currentSeconds = computed(() =>
  Math.max(0, Math.min(totalSeconds.value, currentTime.value))
)

const progressValueText = computed(
  () => `${formatTime(currentSeconds.value)} / ${formatTime(totalSeconds.value)}`
)

const handleProgressKeydown = (event: KeyboardEvent) => {
  if (!currentSong.value) return
  const total = totalSeconds.value
  if (!total) return
  let next: number | null = null
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = currentTime.value - 5
  else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = currentTime.value + 5
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = total
  if (next === null) return
  event.preventDefault()
  setCurrentTime(Math.max(0, Math.min(total, next)))
}

let cachedRect: DOMRect | null = null
const getBarRect = () => {
  if (!progressBarRef.value) return null
  if (!cachedRect) {
    cachedRect = progressBarRef.value.getBoundingClientRect()
  }
  return cachedRect
}

const handleProgressHover = (event: MouseEvent) => {
  if (!progressBarRef.value || !currentSong.value) return
  const rect = progressBarRef.value.getBoundingClientRect()
  cachedRect = rect
  if (!rect.width) return
  const hoverX = event.clientX - rect.left
  const hoverProgress = Math.max(0, Math.min(1, hoverX / rect.width))

  let d = duration.value
  if (!d && currentSong.value.duration) {
    d = currentSong.value.duration
    if (d > 10000) d = d / 1000
  }

  state.previewTime = hoverProgress * d
  state.previewPercent = hoverProgress * 100
  state.showTimePreview = true
}

const handleProgressLeave = () => {
  state.showTimePreview = false
  if (!state.isDragging) cachedRect = null
}

const handleProgressDrag = (clientX: number) => {
  if (!state.isDragging) return
  const rect = getBarRect()
  if (!rect || !rect.width) return
  const x = clientX - rect.left
  const newProgress = (x / rect.width) * 100
  state.dragProgress = Math.max(0, Math.min(100, newProgress))

  if (currentSong.value) {
    let d = duration.value
    if (!d && currentSong.value.duration) {
      d = currentSong.value.duration
      if (d > 10000) d = d / 1000
    }
    state.previewTime = (state.dragProgress / 100) * d
    state.previewPercent = state.dragProgress
  }
}

const startDrag = (event: MouseEvent | TouchEvent) => {
  if (event instanceof TouchEvent) {
    // 由 .prevent 修饰符阻止滚动
  } else {
    event.preventDefault()
  }

  cachedRect = progressBarRef.value?.getBoundingClientRect() ?? null
  state.isDragging = true
  state.dragProgress = progress.value
  document.body.style.userSelect = 'none'

  const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX
  handleProgressDrag(clientX)
}

const stopDrag = () => {
  if (state.isDragging && state.dragProgress !== null) {
    setProgress(state.dragProgress)
  }
  state.isDragging = false
  state.dragProgress = null
  cachedRect = null
  document.body.style.userSelect = ''
}

const handleMouseMove = (event: MouseEvent) => {
  if (state.isDragging) {
    event.preventDefault()
    handleProgressDrag(event.clientX)
  }
}

const handleTouchMove = (event: TouchEvent) => {
  if (state.isDragging) {
    handleProgressDrag(event.touches[0].clientX)
  }
}

const handleProgressClick = (event: MouseEvent) => {
  if (state.isDragging) return
  if (!progressBarRef.value) return
  const rect = progressBarRef.value.getBoundingClientRect()
  if (!rect.width) return
  const clickX = event.clientX - rect.left
  const newProgress = (clickX / rect.width) * 100
  setProgress(Math.max(0, Math.min(100, newProgress)))
}

useEventListener(document, 'mousemove', handleMouseMove)
useEventListener(document, 'mouseup', stopDrag)
useEventListener(document, 'touchmove', handleTouchMove, { passive: false })
useEventListener(document, 'touchend', stopDrag)

const displayProgress = computed(() => {
  return state.isDragging && state.dragProgress !== null ? state.dragProgress : progress.value
})

const progressScaleStyle = computed(() => ({
  transform: `scaleX(${Math.max(0, Math.min(1, displayProgress.value / 100))})`,
  background: gradientStyle.value,
}))

const previewPositionPercent = computed(() => {
  return state.isDragging ? displayProgress.value : state.previewPercent
})
</script>

<template>
  <div
    ref="progressBarRef"
    role="slider"
    data-testid="player-progress"
    tabindex="0"
    aria-orientation="horizontal"
    :aria-label="t('player.progress')"
    aria-valuemin="0"
    :aria-valuemax="Math.round(totalSeconds)"
    :aria-valuenow="Math.round(currentSeconds)"
    :aria-valuetext="progressValueText"
    :aria-disabled="!currentSong || undefined"
    @click="handleProgressClick"
    @keydown="handleProgressKeydown"
    @mousemove="handleProgressHover"
    @mouseleave="handleProgressLeave"
    class="progress-wrapper group relative h-11 cursor-pointer select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
    @mousedown="startDrag"
    @touchstart.prevent="startDrag"
  >
    <!-- 时间预览提示 -->
    <Transition name="fade">
      <div
        v-if="state.showTimePreview || state.isDragging"
        class="time-preview absolute bottom-full mb-2 -translate-x-1/2 rounded-lg bg-black/80 px-3 py-1.5 text-xs whitespace-nowrap text-white shadow-lg backdrop-blur-sm"
        :style="{ left: `${previewPositionPercent}%` }"
      >
        {{ formatTime(state.previewTime) }}
        <div
          class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-black/80"
        ></div>
      </div>
    </Transition>

    <div
      class="progress-track absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 overflow-hidden rounded-full transition-transform duration-150 group-hover:scale-y-150"
      :class="state.isDragging ? 'scale-y-150' : ''"
    >
      <div
        class="progress-fill absolute inset-0 origin-left rounded-full will-change-transform"
        :style="progressScaleStyle"
      ></div>
    </div>
  </div>
</template>

<style scoped>
@reference "../../style/tailwind.css";

.progress-wrapper {
  touch-action: none;
}

.progress-track {
  background: var(--glass-progress-track);
}

.progress-fill {
  box-shadow: 0 0 10px rgba(56,189,248, 0.3);
}

.time-preview {
  pointer-events: none;
  z-index: 100;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

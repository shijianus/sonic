<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import DownloadQualityDialog from '@/components/Dialog/DownloadQualityDialog.vue'
import GlobalToast from '@/components/Ui/GlobalToast.vue'
import AccessGate from '@/components/Access/AccessGate.vue'
import { useDownloadStore } from '@/stores/modules/download'
import { useAccessStore } from '@/stores/modules/access'
import { gatewayHealth, dismissGatewayBanner } from '@/utils/gatewayHealth'

const accessStore = useAccessStore()

// Consume the historical player's one-shot request only after access is established.
watch(() => accessStore.canAccess, async allowed => {
  if (!allowed) return
  try {
    const key = 'sonic:ecs-download-handoff'
    const raw = sessionStorage.getItem(key)
    if (!raw) return
    sessionStorage.removeItem(key)
    const { source, trackId, title, artist } = JSON.parse(raw)
    if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(source) ||
        typeof trackId !== 'string' || !trackId || trackId.length > 256 ||
        typeof title !== 'string' || typeof artist !== 'string') return
    await nextTick()
    useDownloadStore().openDownloadDialog({
      id: source + ':' + trackId, source, platformId: trackId,
      name: title.slice(0, 512), artist: artist.slice(0, 512), duration: 0,
    })
  } catch { /* Storage can be unavailable in private browsing. */ }
}, { immediate: true, flush: 'post' })

onMounted(() => {
  try {
    const isPerf = localStorage.getItem('sonic-perf-mode') === 'true'
    if (isPerf) {
      document.documentElement.classList.add('perf-mode')
    }
  } catch (_) {}

  void accessStore.checkStatus()
})

const showBanner = computed(() => {
  if (gatewayHealth.statusKind === 'normal' || !gatewayHealth.message) return false
  if (gatewayHealth.dismissedAt > 0 && Date.now() - gatewayHealth.dismissedAt < 60_000) return false
  return true
})

const isCriticalStreamDegraded = computed(
  () => gatewayHealth.statusKind === 'stream-degraded-fail'
)
</script>

<template>
  <AccessGate v-if="!accessStore.canAccess" />
  <template v-else>
    <RouterView />
    <DownloadQualityDialog />
    <GlobalToast />
  </template>
  <Transition name="sonic-banner">
    <div
      v-if="showBanner"
      data-testid="sonic-gateway-status"
      :data-status-kind="gatewayHealth.statusKind"
      class="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] max-w-[92vw] flex items-center gap-2.5 px-4 py-2 rounded-full backdrop-blur-xl border shadow-lg text-xs font-medium pointer-events-auto"
      :class="
        isCriticalStreamDegraded
          ? 'bg-rose-950/80 border-rose-400/40 text-rose-100'
          : gatewayHealth.statusKind === 'degraded'
            ? 'bg-amber-950/80 border-amber-400/40 text-amber-100'
            : 'bg-slate-900/85 border-glass text-slate-200'
      "
    >
      <span
        class="inline-block size-2 rounded-full shrink-0"
        :class="
          isCriticalStreamDegraded
            ? 'bg-rose-400 animate-pulse'
            : gatewayHealth.statusKind === 'degraded'
              ? 'bg-amber-400 animate-pulse'
              : 'bg-slate-400'
        "
      />
      <span class="truncate">{{ gatewayHealth.message }}</span>
      <button
        type="button"
        class="ml-1 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
        aria-label="关闭状态提示"
        @click="dismissGatewayBanner"
      >
        ✕
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.sonic-banner-enter-active,
.sonic-banner-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.sonic-banner-enter-from,
.sonic-banner-leave-to {
  opacity: 0;
  transform: translate(-50%, -10px);
}
</style>

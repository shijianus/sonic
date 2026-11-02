<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAccessStore } from '@/stores/modules/access'

const { t } = useI18n()
const accessStore = useAccessStore()

const statusLabel = computed(() => {
  if (accessStore.status === 'loading') return t('access.status.checking')
  if (accessStore.status === 'error') return t('access.status.error')
  if (accessStore.status === 'required') return t('access.status.required')
  if (accessStore.status === 'granted') return t('access.status.granted')
  return t('access.status.open')
})

const statusClass = computed(() => {
  if (accessStore.status === 'error') return 'border-rose-300/25 bg-rose-500/10 text-rose-200'
  if (accessStore.status === 'required') return 'border-amber-300/25 bg-amber-500/10 text-amber-200'
  if (accessStore.canAccess) return 'border-emerald-300/25 bg-emerald-500/10 text-emerald-200'
  return 'border-glass bg-button-glass text-primary/65'
})

const refresh = () => {
  void accessStore.checkStatus(true)
}

const logout = async () => {
  await accessStore.logout()
}

onMounted(() => {
  if (!accessStore.lastCheckedAt) void accessStore.checkStatus()
})
</script>

<template>
  <section class="glass-card space-y-4 rounded-2xl p-5" data-testid="access-status-card" aria-live="polite">
    <div class="flex items-start justify-between gap-3 border-b border-glass pb-4">
      <div class="flex min-w-0 items-center gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300" aria-hidden="true">
          <span class="icon-[mdi--shield-check-outline] size-5" />
        </div>
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-primary">{{ t('access.statusTitle') }}</h2>
          <p class="mt-1 text-xs text-primary/55">{{ t('access.statusDescription') }}</p>
        </div>
      </div>
      <span class="shrink-0 rounded-full border px-2 py-1 text-[11px] font-semibold" :class="statusClass">
        {{ statusLabel }}
      </span>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="min-w-0 flex-1 text-xs leading-5 text-primary/65">
        <template v-if="accessStore.status === 'required'">{{ t('access.statusInviteRequired') }}</template>
        <template v-else-if="accessStore.status === 'error'">{{ t('access.statusRetryHint') }}</template>
        <template v-else-if="accessStore.status === 'granted'">{{ t('access.statusGrantedHint') }}</template>
        <template v-else>{{ t('access.statusOpenHint') }}</template>
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <button
          v-if="accessStore.status === 'error'"
          type="button"
          class="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-glass bg-button-glass px-3 text-xs font-semibold text-primary transition-colors hover:bg-hover-button-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
          :aria-label="t('access.retry')"
          @click="refresh"
        >
          <span class="icon-[mdi--refresh] size-4" aria-hidden="true" />
          <span>{{ t('access.retry') }}</span>
        </button>
        <button
          v-if="accessStore.status === 'granted'"
          type="button"
          class="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-rose-300/20 bg-rose-500/10 px-3 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="accessStore.isLoading"
          @click="logout"
        >
          <span v-if="accessStore.isLoading" class="icon-[mdi--loading] size-4 animate-spin" aria-hidden="true" />
          <span v-else class="icon-[mdi--logout] size-4" aria-hidden="true" />
          <span>{{ t('access.logout') }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

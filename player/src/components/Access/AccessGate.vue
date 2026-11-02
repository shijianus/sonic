<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAccessStore } from '@/stores/modules/access'
import AccessInviteForm from './AccessInviteForm.vue'

const { t } = useI18n()
const accessStore = useAccessStore()
const isInvite = computed(() => accessStore.requiresInvite)
const errorKey = computed(() => (accessStore.errorKind ? `access.errors.${accessStore.errorKind}` : ''))

const retry = () => {
  void accessStore.checkStatus(true)
}
</script>

<template>
  <main
    class="flex min-h-screen w-full items-center justify-center overflow-auto bg-[var(--glass-bg-base)] px-4 py-8 text-primary"
    data-testid="access-gate"
    aria-live="polite"
  >
    <section class="glass-card w-full max-w-lg rounded-2xl p-5 shadow-2xl sm:p-8">
      <div class="mb-6 flex items-start gap-3">
        <div class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300" aria-hidden="true">
          <span class="icon-[mdi--shield-key-outline] size-6" />
        </div>
        <div class="min-w-0">
          <h1 class="text-lg font-bold text-primary sm:text-xl">{{ t('access.title') }}</h1>
          <p class="mt-1 text-sm leading-6 text-primary/60">
            {{ isInvite ? t('access.inviteDescription') : t('access.unavailableDescription') }}
          </p>
        </div>
      </div>

      <AccessInviteForm v-if="isInvite" />

      <div v-else-if="accessStore.status === 'loading'" class="flex items-center gap-2 text-sm text-primary/65" data-testid="access-loading">
        <span class="icon-[mdi--loading] size-4 animate-spin" aria-hidden="true" />
        <span>{{ t('access.checking') }}</span>
      </div>

      <div v-else class="space-y-3" data-testid="access-status-error">
        <p class="text-sm leading-6 text-rose-200" role="alert">
          {{ errorKey ? t(errorKey) : t('access.errors.server') }}
        </p>
        <button
          type="button"
          class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-glass bg-button-glass px-4 text-sm font-semibold text-primary transition-colors hover:bg-hover-button-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
          data-testid="access-retry-button"
          @click="retry"
        >
          <span class="icon-[mdi--refresh] size-4" aria-hidden="true" />
          <span>{{ t('access.retry') }}</span>
        </button>
      </div>
    </section>
  </main>
</template>

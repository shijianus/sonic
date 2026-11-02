<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/modules/auth'
import { useLibraryStore } from '@/stores/modules/library'

const { t } = useI18n()
const authStore = useAuthStore()
const libraryStore = useLibraryStore()
const isAccount = computed(() => authStore.isAuthenticated && Boolean(authStore.user?.id))
const statusLabel = computed(() => {
  if (libraryStore.accountSyncStatus === 'syncing') return t('accountSync.syncing')
  if (libraryStore.accountSyncStatus === 'error') return t('accountSync.error')
  if (libraryStore.accountSyncStatus === 'pending') return t('accountSync.pending')
  if (libraryStore.accountSyncStatus === 'synced') return t('accountSync.synced')
  return t('accountSync.localOnly')
})

const mergeGuest = async () => {
  await libraryStore.mergeGuestLibrary()
}

const keepLocal = () => {
  libraryStore.keepGuestLibraryLocal()
}

const retry = async () => {
  if (authStore.user?.id) await libraryStore.activateAccount(authStore.user.id, true)
}
</script>

<template>
  <section v-if="isAccount" class="glass-card space-y-4 rounded-2xl p-5" data-testid="account-sync-card" aria-live="polite">
    <div class="flex items-start gap-3 border-b border-glass pb-4">
      <div class="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-300" aria-hidden="true">
        <span class="icon-[mdi--cloud-sync-outline] size-5" />
      </div>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-primary">{{ t('accountSync.title') }}</h2>
        <p class="mt-1 text-xs leading-5 text-primary/55">{{ t('accountSync.description') }}</p>
      </div>
      <span class="ml-auto shrink-0 rounded-full border border-glass bg-button-glass px-2 py-1 text-[11px] font-semibold text-primary/70">
        {{ statusLabel }}
      </span>
    </div>

    <p v-if="libraryStore.guestMergeAvailable" class="text-xs leading-5 text-primary/65">
      {{ t('accountSync.mergePrompt', { count: libraryStore.guestItemCount }) }}
    </p>
    <p v-else-if="libraryStore.accountSyncStatus === 'error'" class="text-xs leading-5 text-rose-200" role="alert">
      {{ t('accountSync.errorDescription') }}
    </p>
    <p v-else class="text-xs leading-5 text-primary/65">
      {{ t('accountSync.statusDescription') }}
    </p>

    <div class="flex flex-wrap gap-2">
      <button
        v-if="libraryStore.guestMergeAvailable"
        type="button"
        class="inline-flex min-h-10 items-center justify-center rounded-xl bg-sky-600 px-3 text-xs font-semibold text-sky-50 transition-colors hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
        @click="mergeGuest"
      >
        {{ t('accountSync.merge') }}
      </button>
      <button
        v-if="libraryStore.guestMergeAvailable"
        type="button"
        class="inline-flex min-h-10 items-center justify-center rounded-xl border border-glass bg-button-glass px-3 text-xs font-semibold text-primary transition-colors hover:bg-hover-button-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
        @click="keepLocal"
      >
        {{ t('accountSync.keepLocal') }}
      </button>
      <button
        v-if="libraryStore.accountSyncStatus === 'error'"
        type="button"
        class="inline-flex min-h-10 items-center justify-center rounded-xl border border-glass bg-button-glass px-3 text-xs font-semibold text-primary transition-colors hover:bg-hover-button-glass focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
        @click="retry"
      >
        {{ t('access.retry') }}
      </button>
    </div>
  </section>
</template>

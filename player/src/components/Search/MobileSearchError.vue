<script setup lang="ts">
import Button from '@/components/Ui/Button.vue'
import type { SearchErrorKind } from '@/utils/searchErrors'

const props = defineProps<{ kind: SearchErrorKind }>()
defineEmits<{ retry: [] }>()

const messageKey = computed(() => {
  if (props.kind === 'network') return 'search.loadFailedNetwork'
  if (props.kind === 'rateLimited') return 'search.loadFailedRateLimited'
  if (props.kind === 'timeout') return 'search.loadFailedTimeout'
  return 'search.loadFailedUpstream'
})
</script>

<template>
  <div
    data-testid="search-error"
    role="alert"
    class="glass-card border-glass mt-2 flex flex-col items-start gap-3 rounded-xl border px-4 py-4"
  >
    <div class="text-primary flex items-center gap-2 text-sm font-semibold">
      <span class="icon-[mdi--cloud-alert] h-5 w-5 text-amber-400" />
      <span>{{ $t('search.loadFailed') }}</span>
    </div>
    <p class="text-primary/60 text-xs">{{ $t(messageKey) }}</p>
    <Button size="sm" variant="soft" data-testid="search-retry" @click="$emit('retry')">
      {{ $t('common.retry') }}
    </Button>
  </div>
</template>

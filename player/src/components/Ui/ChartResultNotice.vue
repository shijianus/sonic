<script setup lang="ts">
import Button from '@/components/Ui/Button.vue'

defineProps<{
  status: 'loading' | 'success' | 'error' | 'fallback'
  empty: boolean
}>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <p v-if="status === 'loading'" class="sr-only" role="status">{{ $t('common.loading') }}</p>
  <div
    v-else-if="status === 'error' || status === 'fallback'"
    :data-testid="status === 'error' ? 'charts-error' : 'charts-fallback'"
    :role="status === 'error' ? 'alert' : 'status'"
    class="glass-card border-glass mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2"
  >
    <p class="text-primary text-sm">
      {{ $t(status === 'error' ? 'charts.loadFailed' : 'charts.trendingFallback') }}
    </p>
    <Button size="sm" variant="soft" data-testid="charts-retry" @click="$emit('retry')">
      {{ $t('common.retry') }}
    </Button>
  </div>
  <p v-else-if="empty" role="status" data-testid="charts-empty" class="text-primary/60 px-3 py-10 text-center text-sm">
    {{ $t('charts.empty') }}
  </p>
</template>

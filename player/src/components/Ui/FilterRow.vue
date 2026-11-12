<script setup lang="ts" generic="T extends string | number">
const props = defineProps<{
  label: string
  options: readonly { key: T; label: string; icon?: string }[]
  modelValue?: T
  scroll?: 'horizontal' | 'vertical'
  optionsClass?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()
</script>

<template>
  <div
    class="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2 sm:grid-cols-[5.75rem_minmax(0,1fr)]"
  >
    <span class="min-w-0 py-2 text-xs leading-4 font-medium wrap-anywhere text-secondary">
      {{ label }}
    </span>
    <div
      class="filter-options flex min-w-0 items-start gap-1"
      :class="[
        optionsClass,
        scroll === 'horizontal' ? 'filter-options-horizontal overflow-x-auto' : 'flex-wrap',
        scroll === 'vertical' && 'filter-options-vertical max-h-26 overflow-y-auto',
      ]"
      role="group"
      :aria-label="label"
      :tabindex="scroll ? 0 : undefined"
    >
      <button
        v-for="option in options"
        :key="option.key"
        type="button"
        class="filter-option inline-flex min-h-8 min-w-8 max-w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1 text-left text-xs leading-4 font-medium transition-colors"
        :class="
          props.modelValue === option.key
            ? 'border-sky-500/40 bg-sky-500/20 text-[color:var(--glass-accent-text)]'
            : 'border-transparent text-secondary hover:bg-hover-glass hover:text-primary'
        "
        :aria-pressed="props.modelValue === option.key"
        @click="emit('update:modelValue', option.key)"
      >
        <span v-if="option.icon" :class="[option.icon, 'h-3.5 w-3.5 shrink-0']" aria-hidden="true" />
        <span class="min-w-0 wrap-anywhere">{{ option.label }}</span>
      </button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.filter-options-horizontal,
.filter-options-vertical {
  scrollbar-width: thin;
  scrollbar-color: var(--glass-accent-border) transparent;
}

.filter-options-vertical {
  scrollbar-gutter: stable;
}

.filter-options:focus-visible,
.filter-option:focus-visible {
  outline: 2px solid var(--glass-focus-outline);
  outline-offset: -2px;
}
</style>

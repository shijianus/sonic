<script setup lang="ts" generic="T extends string | number">
export interface Tab<T> {
  key: T
  labelKey: string
  icon: string
  count?: number
}

interface Props {
  tabs: readonly Tab<T>[]
  modelValue: T
  variant?: 'glass' | 'gradient'
  size?: 'sm' | 'md'
  showCount?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'glass',
  size: 'md',
  showCount: true,
})

const emit = defineEmits<{
  'update:modelValue': [value: T]
  'click': [value: T]
}>()

const handleTabClick = (key: T) => {
  emit('update:modelValue', key)
  emit('click', key)
}
</script>

<template>
  <div
    class="flex items-center transition-all"
    :class="[
      size === 'sm' ? 'gap-1 p-1 rounded-xl' : 'gap-2 p-1.5 rounded-xl',
      {
        'glass-card': variant === 'glass',
        'bg-white/10 border border-white/5': variant === 'gradient',
      },
    ]"
  >
    <button
      v-for="tab in tabs"
      :key="String(tab.key)"
      class="relative flex items-center transition-all duration-300"
      :class="[
        size === 'sm' ? 'min-h-8 h-8 px-2.5 py-1 text-xs gap-1.5 rounded-lg' : 'min-h-11 px-4 py-2.5 text-sm gap-2 rounded-xl',
        modelValue === tab.key
          ? variant === 'glass'
            ? 'bg-hover-glass text-primary shadow-sm font-medium'
            : 'bg-linear-to-r from-sky-500/80 to-blue-500/80 text-white shadow-sm font-medium'
          : 'text-primary/60 hover:text-primary/80 hover:bg-hover-glass/50 font-medium',
      ]"
      @click="handleTabClick(tab.key)"
    >
      <span :class="[tab.icon, size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4']"></span>
      <span>{{ $t(tab.labelKey) }}</span>
      <span
        v-if="showCount && tab.count !== undefined"
        class="rounded-full font-medium transition-colors"
        :class="[
          size === 'sm' ? 'px-1.5 py-0.2 text-[10px]' : 'px-2 py-0.5 text-xs',
          modelValue === tab.key
            ? variant === 'glass'
              ? 'bg-button-glass text-primary'
              : 'bg-white/20 text-white'
            : 'bg-button-glass/50 text-primary/60',
        ]"
      >
        {{ tab.count }}
      </span>
    </button>
  </div>
</template>

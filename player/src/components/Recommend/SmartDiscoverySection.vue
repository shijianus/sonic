<script setup lang="ts">
import MusicRadarSection from './MusicRadarSection.vue'

withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false,
  }
)
</script>

<template>
  <MusicRadarSection :compact="compact" />
</template>

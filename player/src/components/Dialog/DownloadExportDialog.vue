<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/modules/auth'
import { useDownloadStore } from '@/stores/modules/download'
import { useDialogA11y } from '@/composables/useDialogA11y'
import type { EcsExportFile } from '@/utils/offlineDownload'
import type { DownloadedSong } from '@/utils/indexedDB'

const props = defineProps<{ item: DownloadedSong | EcsExportFile }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const auth = useAuthStore()
const downloads = useDownloadStore()
const target = ref<'ecs' | 'original' | 'high' | 'standard'>('ecs')
const busy = ref(false)
const error = ref('')
const dialogRef = ref<HTMLElement | null>(null)
const open = ref(false)
onMounted(() => { open.value = true })
async function dismiss() {
  open.value = false
  await nextTick()
  emit('close')
}
const close = () => { if (!busy.value) void dismiss() }
useDialogA11y({ isOpen: open, containerRef: dialogRef, onClose: close })

async function save() {
  if (busy.value) return
  if (target.value !== 'ecs' && !auth.verifiedAccountId) {
    auth.login()
    return
  }
  error.value = ''
  busy.value = true
  try {
    await downloads.exportDownload(props.item, target.value)
    await dismiss()
  } catch (problem) {
    error.value = problem instanceof Error && problem.message === t('download.unverifiedSource')
      ? problem.message : t('downloads.ecsExportError')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" @click.self="close">
      <form ref="dialogRef" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="download-export-title"
        class="w-full max-w-sm space-y-4 rounded-2xl border border-glass bg-[var(--glass-bg-solid)] p-5 text-primary shadow-[var(--glass-shadow-xl)]" @submit.prevent="save">
        <h3 id="download-export-title" class="break-words text-base font-semibold">{{ t('downloads.exportAudio') }} · {{ item.name }}</h3>
        <label class="flex flex-col gap-2 text-sm">
          {{ t('downloads.ecsFormat') }}
          <select data-testid="download-export-format" v-model="target" :disabled="busy" class="min-h-11 rounded-lg border border-glass bg-[var(--glass-bg-overlay)] px-3 text-primary">
            <option value="ecs">ECS (.ecs)</option>
            <option value="original">{{ t('downloads.ecsOriginal') }}</option>
            <option v-if="item.ecsTier !== 3" value="high">{{ t('downloads.ecsHigh') }}</option>
            <option value="standard">{{ t('downloads.ecsStandard') }}</option>
          </select>
        </label>
        <p v-if="error" role="alert" class="text-sm text-red-500">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-3">
          <button type="button" :disabled="busy" class="min-h-11 px-3 text-sm" @click="close">{{ t('common.cancel') }}</button>
          <button data-testid="download-export-confirm" type="submit" :disabled="busy" class="min-h-11 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white">
            {{ target !== 'ecs' && !auth.verifiedAccountId ? t('downloads.ecsLogin') : t('downloads.exportAudio') }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

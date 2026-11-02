<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAccessStore } from '@/stores/modules/access'

const { t } = useI18n()
const accessStore = useAccessStore()
const code = ref('')
const touched = ref(false)
const hasValue = computed(() => code.value.trim().length > 0)
const errorKey = computed(() => (accessStore.errorKind ? `access.errors.${accessStore.errorKind}` : ''))

const submit = async () => {
  touched.value = true
  if (!hasValue.value || accessStore.isRedeeming) return
  const submitted = code.value
  code.value = ''
  await accessStore.redeem(submitted)
}

const clearErrorOnInput = () => {
  if (accessStore.errorKind) accessStore.errorKind = null
}
</script>

<template>
  <form
    class="w-full max-w-md space-y-3"
    data-testid="access-invite-form"
    novalidate
    @submit.prevent="submit"
  >
    <label for="sonic-access-code" class="block text-sm font-medium text-primary">
      {{ t('access.inviteLabel') }}
    </label>
    <div class="flex flex-col gap-2 sm:flex-row">
      <input
        id="sonic-access-code"
        v-model="code"
        type="text"
        inputmode="text"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        :aria-invalid="touched && !hasValue"
        :aria-describedby="errorKey || (touched && !hasValue ? 'access-code-hint' : undefined)"
        :placeholder="t('access.invitePlaceholder')"
        class="min-h-11 min-w-0 flex-1 rounded-xl border border-glass bg-button-glass px-3 text-sm text-primary outline-none transition-colors placeholder:text-primary/35 focus:border-sky-400/70 focus:ring-2 focus:ring-sky-400/20"
        data-testid="access-code-input"
        @input="clearErrorOnInput"
      />
      <button
        type="submit"
        :disabled="!hasValue || accessStore.isRedeeming"
        class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 text-sm font-semibold text-sky-50 transition-colors hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="access-redeem-button"
      >
        <span v-if="accessStore.isRedeeming" class="icon-[mdi--loading] size-4 animate-spin" aria-hidden="true" />
        <span>{{ t('access.redeem') }}</span>
      </button>
    </div>
    <p v-if="touched && !hasValue" id="access-code-hint" class="text-xs text-amber-300" role="alert">
      {{ t('access.errors.required') }}
    </p>
    <p v-else-if="errorKey" class="text-xs text-rose-300" role="alert" data-testid="access-error">
      {{ t(errorKey) }}
    </p>
  </form>
</template>

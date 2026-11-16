import { computed, ref } from 'vue'

// 模块级共享响应状态，避免多个背景/视图组件重复挂载全局 DOM 监听
let listenersInitialized = false

const isPerfMode = ref(
  typeof document !== 'undefined' && document.documentElement.classList.contains('perf-mode')
)
const isDocumentHidden = ref(typeof document !== 'undefined' && document.hidden)
const prefersReducedMotion = ref(
  typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
)

const initGlobalListeners = () => {
  if (listenersInitialized || typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }
  listenersInitialized = true

  const syncPerfMode = () => {
    isPerfMode.value = document.documentElement.classList.contains('perf-mode')
  }
  syncPerfMode()

  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(syncPerfMode)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
  }

  document.addEventListener('visibilitychange', () => {
    isDocumentHidden.value = document.hidden
  })

  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncMotion = () => {
      prefersReducedMotion.value = mq.matches
    }
    syncMotion()
    mq.addEventListener('change', syncMotion)
  }
}

export const readPrefersReducedMotion = (): boolean => {
  initGlobalListeners()
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const matches = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    prefersReducedMotion.value = matches
    return matches
  }
  return prefersReducedMotion.value
}

export const useAmbientMotion = () => {
  initGlobalListeners()

  const shouldAnimate = computed(
    () => !isPerfMode.value && !isDocumentHidden.value && !prefersReducedMotion.value
  )

  return {
    isPerfMode,
    isDocumentHidden,
    prefersReducedMotion,
    shouldAnimate,
  }
}

import { shallowRef, watch } from 'vue'

export function useSearchSuggestions<T>(
  term: () => string,
  fetchSuggestions: (term: string, signal: AbortSignal) => Promise<T[]>,
  debounceMs: number
) {
  const suggestions = shallowRef<T[]>([])

  watch(() => term().trim(), (query, _, onCleanup) => {
    suggestions.value = []
    if (!query) return

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const result = await fetchSuggestions(query, controller.signal)
        if (!controller.signal.aborted) suggestions.value = result
      } catch {
        // Suggestions are optional. The current query starts with an empty list.
      }
    }, debounceMs)

    onCleanup(() => {
      clearTimeout(timer)
      controller.abort()
    })
  }, { immediate: true, flush: 'sync' })

  return suggestions
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import * as Vue from 'vue'
import * as searchSuggestions from '@/composables/useSearchSuggestions'
import * as transformers from '@/utils/transformers'
import * as searchErrors from '@/utils/searchErrors'

// Compile only the components under test: the shared Vitest config intentionally has no
// Vue/auto-import plugins. No generated files or changes to the shared config are needed.
const cloudSearch = vi.fn()
const fetchSmartSearch = vi.fn()
const fetchMock = vi.fn()
const setPlaylist = vi.fn()
const play = vi.fn()
const togglePlay = vi.fn()
const currentSong = Vue.ref<any>(null)
const isPlaying = Vue.ref(false)
const isLoading = Vue.ref(false)
const globalStore = Vue.reactive({ searchHistory: [] as string[], addSearchHistory: vi.fn(), removeSearchHistory: vi.fn(), clearSearchHistory: vi.fn() })
const route = Vue.reactive({ query: { q: 'fixture' } })
const router = { push: vi.fn(), replace: vi.fn() }
const audio = {
  currentSong, isPlaying, isLoading, setPlaylist, play, togglePlay, next: vi.fn(),
  beginDeferredPlayback: vi.fn(() => () => true),
  currentTime: Vue.ref(0), formattedCurrentTime: Vue.ref('0:00'), formattedDuration: Vue.ref('0:20'),
}
const recommendStore = { recordEvent: vi.fn(), buildRequestHeaders: () => ({}), personalizationEnabled: false }
const Passthrough = Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('div', slots.default?.()) })
const SongList = Vue.defineComponent({
  props: ['songs', 'loading'],
  setup: props => () => Vue.h('div', props.loading ? 'Loading' : props.songs?.length
    ? props.songs.map((song: any) => Vue.h('h3', { 'data-testid': `song-${song.id}` }, song.name))
    : 'search.empty'),
})
const dependencies: Record<string, unknown> = {
  vue: Vue,
  'vue-router': { useRouter: () => router, useRoute: () => route, RouterLink: Passthrough },
  'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
  pinia: { storeToRefs: Vue.toRefs },
  gsap: { gsap: {} },
  '@vueuse/core': { useDebounceFn: () => vi.fn() },
  'swiper/vue': { Swiper: Passthrough, SwiperSlide: Passthrough },
  'swiper/modules': { EffectCreative: {} },
  'swiper/css': {},
  'swiper/css/effect-creative': {},
  '@/api': {
    cloudSearch, searchDefault: vi.fn().mockResolvedValue({ data: {} }), searchHotDetail: vi.fn().mockResolvedValue({ data: [] }), searchSuggest: vi.fn(), playlistTrackAll: vi.fn(),
  },
  '@/api/recommend': { fetchSmartSearch },
  '@/composables/useAudio': { useAudio: () => audio },
  '@/composables/useLyrics': { useLyrics: () => ({ mergedLines: Vue.ref([]), activeTimeline: Vue.ref([]), fetchLyrics: vi.fn() }) },
  '@/composables/useSearchSuggestions': searchSuggestions,
  '@/stores/modules/settings': { useSettingsStore: () => Vue.reactive({ footerLyrics: { enabled: false, modes: [] } }) },
  '@/stores/modules/global': { useGlobalStore: () => globalStore },
  '@/stores/modules/recommend': { useRecommendStore: () => recommendStore },
  '@/utils/transformers': transformers,
  '@/utils/searchErrors': searchErrors,
  '@/utils/time': { formatCount: (n: number) => String(n) },
  '@/utils/imageUrl': { formatCoverUrl: () => '' },
  '@/utils/exploreTags': { exploreTags: [], groupOrder: {}, groupColorConfigs: {} },
  '@/components/Ui/LazyImage.vue': { default: Passthrough },
  '@/components/Ui/Pagination.vue': { default: Passthrough },
  '@/components/Ui/MusicProgress.vue': { default: Passthrough },
  '@/components/Recommend/StyleRadarSection.vue': { default: Passthrough },
}

function component(relativePath: string): Vue.Component {
  const filename = resolve(dirname(fileURLToPath(import.meta.url)), '../src', relativePath)
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: relativePath, inlineTemplate: true, genDefaultAs: '__component' })
  const code = ts.transpileModule(script.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const requireMock = (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected component dependency: ${name}`)
    return dependencies[name]
  }
  const globals = {
    reactive: Vue.reactive, toRefs: Vue.toRefs, ref: Vue.ref, computed: Vue.computed,
    watch: Vue.watch, onMounted: Vue.onMounted, onUnmounted: Vue.onUnmounted,
    nextTick: Vue.nextTick, useTemplateRef: Vue.useTemplateRef,
    useRoute: () => route, useRouter: () => router,
  }
  return new Function('require', 'exports', ...Object.keys(globals), `${code}\nreturn __component`)(requireMock, {}, ...Object.values(globals))
}

const Button = component('components/Ui/Button.vue')
dependencies['@/components/Ui/Button.vue'] = { default: Button }
const SearchError = component('components/Search/MobileSearchError.vue')
dependencies['@/components/Search/MobileSearchError.vue'] = { default: SearchError }
const SearchSongs = component('components/Search/SearchSongs.vue')
const SearchPlaylists = component('components/Search/SearchPlaylists.vue')
const SearchMVs = component('components/Search/SearchMVs.vue')
const MobileSearch = component('pages/mobile/search.vue')
const MiniPlayer = component('components/Mobile/MiniPlayerMobile.vue')
const mountedApps: Vue.App[] = []

function mount(target: Vue.Component, props: Record<string, unknown> = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = Vue.createApp(target, props)
  app.config.globalProperties.$t = (key: string) => key
  app.component('SongList', SongList)
  app.component('MobileSongList', SongList)
  app.component('PageSkeleton', Passthrough)
  app.component('LazyImage', Passthrough)
  app.component('router-link', Passthrough)
  mountedApps.push(app)
  app.mount(root)
  return root
}

const empty = { code: 200, result: { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 } }
const smartEmpty = { tracks: [], total: 0, suggestions: [], fallbackTracks: [], fallbackUsed: false }
const boundTrack = {
  id: 'stable-virtual-id', title: 'Bound track', artist: 'Bound artist', duration: 120,
  sources: [{ platform: 'qq', platformId: 'qq-exact-id' }, { platform: 'netease', platformId: 'ncm-exact-id' }],
  streamType: 'trial', trialDuration: 30,
  resolvedSource: 'qq', resolvedId: 'legacy-binding', resolvedPlatformId: 'exact-binding', resolvedTitle: 'Exact title', resolvedArtist: 'Exact artist',
}

beforeEach(() => {
  vi.clearAllMocks()
  currentSong.value = null
  isPlaying.value = false
  isLoading.value = false
  cloudSearch.mockResolvedValue(empty)
  fetchSmartSearch.mockResolvedValue(smartEmpty)
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { tracks: [], total: 0 } }) })
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('desktop search failure and recovery', () => {
  const tabs = [
    { name: 'songs', target: SearchSongs, key: 'songs', countKey: 'songCount', item: { id: 1, name: 'Recovered song', ar: [{ id: 2, name: 'Artist' }] } },
    { name: 'playlists', target: SearchPlaylists, key: 'playlists', countKey: 'playlistCount', item: { id: 1, name: 'Recovered playlist', creator: { nickname: 'Fixture' } } },
    { name: 'MVs', target: SearchMVs, key: 'mvs', countKey: 'mvCount', item: { id: 1, name: 'Recovered MV', artistName: 'Artist' } },
  ]
  for (const tab of tabs) {
    for (const failure of [403, 429, 503, 'network'] as const) {
      it(`${tab.name}: ${failure} shows a retry panel and retry renders results`, async () => {
        const error = failure === 'network' ? new TypeError('Failed to fetch') : { response: { status: failure } }
        cloudSearch.mockRejectedValueOnce(error)
        const root = mount(tab.target, { keywords: 'fixture' })
        await vi.waitFor(() => expect(root.querySelector('[data-testid="search-error"]')).not.toBeNull())
        expect(root.textContent).toContain(failure === 429 ? 'search.loadFailedRateLimited' : failure === 'network' ? 'search.loadFailedNetwork' : 'search.loadFailedUpstream')
        expect(root.textContent).not.toContain('search.empty')
        cloudSearch.mockResolvedValueOnce({ code: 200, result: { [tab.key]: [tab.item], [tab.countKey]: 1 } })
        root.querySelector<HTMLButtonElement>('[data-testid="search-retry"]')!.click()
        await vi.waitFor(() => expect(root.textContent).toContain(tab.item.name))
        expect(root.querySelector('[data-testid="search-error"]')).toBeNull()
      })
    }
    it(`${tab.name}: provider-error envelope is not treated as empty results`, async () => {
      cloudSearch.mockResolvedValueOnce({ code: 429, error: { code: 'RATE_LIMITED' } })
      const root = mount(tab.target, { keywords: 'fixture' })
      await vi.waitFor(() => expect(root.textContent).toContain('search.loadFailedRateLimited'))
      expect(root.textContent).not.toContain('search.empty')
    })
    it(`${tab.name}: successful empty response uses the empty state`, async () => {
      const root = mount(tab.target, { keywords: 'fixture' })
      await vi.waitFor(() => expect(root.textContent).toContain('search.empty'))
      expect(root.querySelector('[data-testid="search-error"]')).toBeNull()
    })
  }

  it('a later failed search clears stale success results before showing the error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { tracks: [boundTrack], total: 1 } }) })
    const props = Vue.reactive({ keywords: 'first' })
    const view = Vue.defineComponent({ setup: () => () => Vue.h(SearchSongs, props) })
    const root = mount(view)
    await vi.waitFor(() => expect(root.textContent).toContain(boundTrack.title))
    cloudSearch.mockRejectedValueOnce({ response: { status: 503 } })
    props.keywords = 'second'
    await vi.waitFor(() => expect(root.textContent).toContain('search.loadFailedUpstream'))
    expect(root.textContent).not.toContain(boundTrack.title)
  })

  it('Nexus non-2xx cannot pass success-shaped tracks through to the song list', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ data: { tracks: [boundTrack] } }) })
    const root = mount(SearchSongs, { keywords: 'fixture' })
    await vi.waitFor(() => expect(root.textContent).toContain('search.loadFailedRateLimited'))
    expect(root.textContent).not.toContain(boundTrack.title)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { tracks: [boundTrack], total: 1 } }) })
    root.querySelector<HTMLButtonElement>('[data-testid="search-retry"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain(boundTrack.title))
    expect(root.querySelector('[data-testid="search-error"]')).toBeNull()
  })
})

describe('search provider identity', () => {
  for (const target of [SearchSongs, MobileSearch]) {
    it(`${target === SearchSongs ? 'desktop Nexus' : 'mobile Nexus and play-all'} preserve supplied provider bindings`, async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { tracks: [boundTrack], total: 1 } }) })
      let api: { playAll?: () => void } | undefined
      const view = target === SearchSongs
        ? Vue.defineComponent({ setup: () => () => Vue.h(target, { keywords: 'fixture', ref: (value: any) => { api = value } }) })
        : target
      const root = mount(view)
      await vi.waitFor(() => expect(root.textContent).toContain(boundTrack.title))
      if (target === SearchSongs) api!.playAll!()
      else Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('actions.playAll'))!.click()
      const songs = setPlaylist.mock.calls[0][0]
      expect(songs[0]).toMatchObject({
        id: boundTrack.id,
        sources: boundTrack.sources,
        streamType: boundTrack.streamType,
        trialDuration: boundTrack.trialDuration,
        resolvedSource: boundTrack.resolvedSource,
        resolvedId: boundTrack.resolvedId,
        resolvedPlatformId: boundTrack.resolvedPlatformId,
        resolvedTitle: boundTrack.resolvedTitle,
        resolvedArtist: boundTrack.resolvedArtist,
      })
      expect(play).toHaveBeenCalledWith(songs[0], 0)
    })
  }
})

it('mini loading uses an enabled Cancel button and delegates to the existing toggle action', async () => {
  currentSong.value = { id: 1, name: 'Slow track', artist: 'Fixture' }
  isLoading.value = true
  const root = mount(MiniPlayer)
  const button = root.querySelector<HTMLButtonElement>('[data-testid="player-toggle"]')!
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-label')).toBe('common.cancel')
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(button.querySelector('.animate-spin')).not.toBeNull()
  button.click()
  expect(togglePlay).toHaveBeenCalledOnce()
  isLoading.value = false
  await Vue.nextTick()
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-label')).toBe('player.play')
  expect(button.getAttribute('aria-busy')).toBe('false')
})

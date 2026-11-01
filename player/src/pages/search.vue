<script setup lang="ts">
// 搜索页脚本：关键词输入、云搜索类型切换、分页与历史记录、风格探索推荐结合
import SearchSongs from '@/components/Search/SearchSongs.vue'
import SearchPlaylists from '@/components/Search/SearchPlaylists.vue'
import SearchMVs from '@/components/Search/SearchMVs.vue'
import StyleRadarSection from '@/components/Recommend/StyleRadarSection.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import TabGroup from '@/components/Ui/TabGroup.vue'
import Button from '@/components/Ui/Button.vue'
import { searchHotDetail, searchDefault } from '@/api'
import { fetchSmartSuggest, type SmartSuggestionItem } from '@/api/recommend'
import { useGlobalStore } from '@/stores/modules/global'
import { useRecommendStore } from '@/stores/modules/recommend'
import { storeToRefs } from 'pinia'
import {
  exploreTags,
  type ExploreTagItem,
  groupColorConfigs,
  groupOrder,
} from '@/utils/exploreTags'

// 路由实例：读取/更新查询参数
const route = useRoute()
const router = useRouter()
const globalStore = useGlobalStore()
const recommendStore = useRecommendStore()
const { searchHistory } = storeToRefs(globalStore)

// 当前搜索关键词（来自路由查询参数）
const q = computed(() => String(route.query.q || '').trim())

// 页面本地状态
const state = reactive({
  activeType: 1 as 1 | 1000 | 1004,
  page: 1,
  lastLoadedCount: 0,
  total: 0,
  isLoading: false,
  hotSearches: [] as { searchWord: string; score: number; iconType?: number }[],
  loadingHot: false,
})
const { activeType, page, total, isLoading } = toRefs(state)

const songsRef = ref<InstanceType<typeof SearchSongs> | null>(null)

// 搜索输入框相关
const searchInput = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const inputFocused = ref(false)
const placeholder = ref('')
const liveSuggestions = ref<SmartSuggestionItem[]>([])
let suggestTimer: ReturnType<typeof setTimeout> | null = null


// 当前选中的多个风格标签列表（支持多角度组合，相斥维度自动替换）
const selectedTags = ref<ExploreTagItem[]>([])

// 选中的标签名称集合，用于高亮判定
const selectedTagNames = computed(() => new Set(selectedTags.value.map(t => t.name)))

// 组合后的查询文本（按 group 规范顺序排序：region -> genre -> mood -> scene -> theme）
const selectedTagQuery = computed(() => {
  return [...selectedTags.value]
    .sort((a, b) => (groupOrder[a.group] || 99) - (groupOrder[b.group] || 99))
    .map(t => t.name)
    .join(' ')
})

watch(searchInput, (val) => {
  if (suggestTimer) clearTimeout(suggestTimer)
  const term = val.trim()
  if (!term) {
    liveSuggestions.value = []
    return
  }
  suggestTimer = setTimeout(async () => {
    try {
      const list = await fetchSmartSuggest(term, recommendStore.buildRequestHeaders(false))
      if (searchInput.value.trim() === term) {
        liveSuggestions.value = list
      }
    } catch {
      liveSuggestions.value = []
    }
  }, 160)
})

const playAllSongs = () => {
  songsRef.value?.playAll()
}

const tabs = [
  {
    key: 1 as const,
    labelKey: 'search.tabs.song',
    component: SearchSongs,
    icon: 'icon-[mdi--music-circle]',
  },
  {
    key: 1000 as const,
    labelKey: 'search.tabs.playlist',
    component: SearchPlaylists,
    icon: 'icon-[mdi--playlist-music]',
  },
  {
    key: 1004 as const,
    labelKey: 'search.tabs.mv',
    component: SearchMVs,
    icon: 'icon-[mdi--movie-open-play]',
  },
]

// 当前激活类型对应的组件（动态组件）
const activeComp = computed(() => tabs.find(t => t.key === activeType.value)?.component)

// 每页数量按类型自适应
const pageSize = computed(() => (activeType.value === 1 ? 40 : activeType.value === 1000 ? 30 : 24))

// 子组件回调：记录当前页加载数量
const onLoaded = (count: number) => {
  state.lastLoadedCount = count
  state.isLoading = false
}
// 子组件回调：记录总条数
const onTotal = (n: number) => {
  state.total = n
}

// 切换类型或关键词时重置分页与总数
watch([activeType, q], () => {
  state.page = 1
  state.lastLoadedCount = 0
  state.total = 0
  state.isLoading = activeType.value !== 1 && !!q.value
})

watch(page, () => {
  state.isLoading = activeType.value !== 1 && !!q.value
})

// 监听路由关键词同步输入框与选中标签
watch(
  q,
  (val) => {
    if (val) {
      searchInput.value = val
      const matched = exploreTags.filter(t => val.includes(t.name))
      if (matched.length > 0) {
        selectedTags.value = matched
      }
    } else {
      if (selectedTags.value.length > 0) {
        searchInput.value = selectedTagQuery.value
      } else {
        searchInput.value = ''
      }
      if (state.hotSearches.length === 0) {
        fetchHotSearch()
      }
    }
  },
  { immediate: true }
)

// 执行搜索关键词
const doSearch = (keyword: string) => {
  const term = keyword.trim()
  if (!term) return
  globalStore.addSearchHistory(term)
  searchInput.value = term
  inputRef.value?.blur()
  router.push({ path: '/search', query: { q: term } })
}

// 点击内置推荐 Tag：支持多角度组合与同维度相斥替换
// 仅以检索方式写入搜索框，并改变风格探索雷达的单曲推荐结果；未点击“搜索”前绝对不进入搜索结果态！
const handleToggleTag = (tag: ExploreTagItem) => {
  const isSelected = selectedTags.value.some(t => t.name === tag.name)
  if (isSelected) {
    // 再次点击同 tag：取消选择
    selectedTags.value = selectedTags.value.filter(t => t.name !== tag.name)
  } else {
    // 点击新 tag：替换同相斥组 (同 group) 的已有 tag，保持其他维度不变
    const filtered = selectedTags.value.filter(t => t.group !== tag.group)
    selectedTags.value = [...filtered, tag]
  }

  // 同步写入搜索框
  searchInput.value = selectedTagQuery.value

  // 若此前在搜索结果页，切回风格探索雷达展示态
  if (q.value) {
    router.replace({ path: '/search' })
  }
}

const clearSelectedTags = () => {
  selectedTags.value = []
  searchInput.value = ''
}

// 提交搜索（从输入框回车或点击按钮）
const handleSubmit = () => {
  const keyword = searchInput.value.trim() || placeholder.value
  if (keyword) doSearch(keyword)
}

// 清空输入框并重置搜索
const handleClearInput = () => {
  searchInput.value = ''
  selectedTags.value = []
  if (q.value) {
    router.push({ path: '/search' })
  }
}

// 清除搜索历史
const clearHistory = () => {
  globalStore.clearSearchHistory()
}

// 获取热门搜索
const fetchHotSearch = async () => {
  state.loadingHot = true
  try {
    const res: any = await searchHotDetail()
    state.hotSearches = res?.data || []
  } catch {
    state.hotSearches = []
  } finally {
    state.loadingHot = false
  }
}

// 获取默认搜索词作为 placeholder
const fetchPlaceholder = async () => {
  try {
    const res: any = await searchDefault()
    placeholder.value = res?.data?.showKeyword || res?.data?.realkeyword || ''
  } catch {
    // 忽略
  }
}

onMounted(() => {
  if (!q.value) {
    fetchHotSearch()
  }
  fetchPlaceholder()
})

// 热搜最大分数，用于计算热度条宽度
const maxScore = computed(() => {
  if (!state.hotSearches.length) return 1
  return Math.max(...state.hotSearches.map(h => h.score))
})
</script>

<template>
  <div class="custom-scrollbar relative flex h-full flex-1 flex-col overflow-y-auto px-4 pb-10">
    <!-- 背景氛围光 -->
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      <div class="ambient-a absolute -top-20 left-1/3 h-[420px] w-[420px] -translate-x-1/2 rounded-full" />
      <div class="ambient-b absolute -bottom-32 right-1/4 h-[350px] w-[350px] rounded-full" />
    </div>

    <!-- 顶部搜索核心交互区：搜索框 + 搜索历史 + 推荐风格Tag -->
    <div class="relative z-10 shrink-0 pt-6 pb-4">
      <!-- 搜索输入框 (正常尺寸，不臃肿) -->
      <div
        class="search-box mx-auto w-full max-w-md md:max-w-lg transition-all duration-300"
      >
        <div
          class="flex h-11 items-center gap-2.5 rounded-full border px-3.5 backdrop-blur-xl transition-all duration-300"
          :class="[
            inputFocused
              ? 'border-sky-500/40 bg-white/[0.08] ring-2 ring-sky-500/20 shadow-[0_0_20px_rgba(56,189,248,0.12)]'
              : 'border-white/[0.12] bg-white/[0.04] shadow-[0_2px_10px_rgba(0,0,0,0.1)] hover:border-white/20'
          ]"
        >
          <span
            class="icon-[mdi--magnify] h-4.5 w-4.5 shrink-0 transition-colors"
            :class="inputFocused ? 'text-sky-400' : 'text-primary/40'"
          />
          <input
            ref="inputRef"
            v-model="searchInput"
            type="text"
            :placeholder="placeholder || $t('common.search.placeholder')"
            class="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-primary/40 font-normal"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
            @keyup.enter="handleSubmit"
          />
          <!-- 清除按钮 -->
          <Transition name="fade-scale">
            <button
              v-if="searchInput"
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-primary/40 transition-colors hover:bg-white/10 hover:text-white"
              :aria-label="$t('common.clear')"
              :title="$t('common.clear')"
              @click="handleClearInput"
            >
              <span class="icon-[mdi--close] h-3.5 w-3.5" />
            </button>
          </Transition>
          <!-- 搜索按钮 -->
          <button
            type="button"
            class="search-btn flex h-7.5 shrink-0 items-center gap-1 rounded-full px-3.5 text-xs font-semibold text-white transition-all duration-200 active:scale-95"
            @click="handleSubmit"
          >
            <span>{{ $t('common.search.label') }}</span>
          </button>
        </div>

        <!-- 智能实时补全建议下拉框 -->
        <div
          v-if="inputFocused && liveSuggestions.length > 0"
          class="border-glass bg-[var(--glass-bg-overlay)] mt-2 overflow-hidden rounded-2xl border p-1.5 shadow-xl backdrop-blur-2xl"
        >
          <div class="text-primary/45 px-3 py-1 text-[11px] font-medium">
            {{ $t('recommend.search.smartSuggestions') }}
          </div>
          <button
            v-for="sug in liveSuggestions"
            :key="`${sug.type}-${sug.text}`"
            type="button"
            @mousedown.prevent="doSearch(sug.text)"
            class="hover:bg-hover-glass flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-xs transition-colors"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span
                class="h-4 w-4 shrink-0 text-sky-400"
                :class="
                  sug.type === 'artist'
                    ? 'icon-[mdi--account-music-outline]'
                    : sug.type === 'genre'
                      ? 'icon-[mdi--tag-outline]'
                      : 'icon-[mdi--music-note-outline]'
                "
              />
              <span class="text-primary truncate font-medium">{{ sug.text }}</span>
            </div>
            <span v-if="sug.subLabel" class="text-primary/45 shrink-0 text-[11px]">
              {{ sug.subLabel }}
            </span>
          </button>
        </div>
      </div>

      <!-- 搜索历史（精简大小，上限20条，合并同类项） -->
      <div v-if="searchHistory.length > 0" class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="icon-[mdi--history] h-3.5 w-3.5 text-primary/40" />
            <span class="text-primary/60 text-xs font-medium">{{ $t('search.recentSearches') }}</span>
            <span class="text-primary/30 text-[11px]">({{ searchHistory.length }}/20)</span>
          </div>
          <button
            type="button"
            class="text-primary/40 hover:text-primary/70 flex h-6 items-center px-1 text-xs font-medium transition-colors"
            @click="clearHistory"
          >
            {{ $t('common.clear') }}
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <div
            v-for="(keyword, ki) in searchHistory"
            :key="keyword"
            class="history-chip group flex h-7 items-center rounded-full border border-white/10 bg-white/5 text-xs transition-all duration-200 hover:border-sky-500/30 hover:bg-white/10"
            :style="{ animationDelay: `${Number(ki) * 20}ms` }"
          >
            <button
              type="button"
              class="flex h-full min-w-0 items-center gap-1.5 pl-2.5 pr-1 text-xs text-primary/80 group-hover:text-primary transition-colors"
              @click="doSearch(keyword)"
            >
              <span class="max-w-[140px] truncate">{{ keyword }}</span>
            </button>
            <button
              type="button"
              class="text-primary/40 hover:text-primary mr-1 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
              :aria-label="$t('search.removeHistory', { keyword })"
              :title="$t('common.delete')"
              @click="globalStore.removeSearchHistory(keyword)"
            >
              <span class="icon-[mdi--close] h-3 w-3"></span>
            </button>
          </div>
        </div>
      </div>

      <!-- 风格探索雷达内置推荐Tag（躺在搜索区域最下方，引导用户进入搜索） -->
      <div class="mt-4">
        <div class="mb-2 flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span class="icon-[mdi--compass-outline] h-3.5 w-3.5 text-sky-400" />
            <span class="text-primary/60 text-xs font-medium">{{ $t('search.styleExploreTags') }}</span>
            <span v-if="selectedTags.length > 0" class="text-sky-400/80 text-[11px]">
              ({{ selectedTags.length }} 已选)
            </span>
          </div>
          <button
            v-if="selectedTags.length > 0"
            type="button"
            class="text-primary/40 hover:text-primary/70 flex h-6 items-center px-1 text-xs font-medium transition-colors"
            @click="clearSelectedTags"
          >
            {{ $t('common.clear') }}
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="tag in exploreTags"
            :key="tag.name"
            type="button"
            class="tag-chip flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-all duration-200"
            :class="
              selectedTagNames.has(tag.name)
                ? groupColorConfigs[tag.group].chipActive
                : groupColorConfigs[tag.group].chipInactive
            "
            @click="handleToggleTag(tag)"
          >
            <span
              class="text-[10px] transition-colors"
              :class="
                selectedTagNames.has(tag.name)
                  ? groupColorConfigs[tag.group].hashActive
                  : groupColorConfigs[tag.group].hashInactive
              "
            >
              #
            </span>
            <span>{{ tag.name }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════════ -->
    <!-- 下方主内容区                                    -->
    <!-- ═══════════════════════════════════════════════ -->
    <div class="relative z-10 flex-1">
      <!-- 有搜索关键词时：呈现检索结果 + 风格探索雷达 -->
      <template v-if="q">
        <div class="mb-5 shrink-0">
          <!-- 搜索结果标题 -->
          <div class="mb-4 flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 shadow-lg shadow-sky-500/20">
              <span class="icon-[mdi--magnify] h-5 w-5 text-white"></span>
            </div>
            <div>
              <h1 class="text-primary text-xl font-bold">
                {{ $t('search.resultsFor') }}
                <span class="bg-gradient-to-r from-sky-400 to-blue-400 bg-clip-text text-transparent">"{{ q }}"</span>
              </h1>
              <p v-if="total > 0" class="text-primary/50 text-sm">
                {{ $t('search.foundResults', { count: total }) }}
              </p>
            </div>
          </div>

          <!-- Tab + 控制栏 -->
          <div class="glass-card flex flex-wrap items-center justify-between gap-4 p-3">
            <TabGroup
              v-model="activeType"
              :tabs="tabs"
              variant="gradient"
              size="sm"
              :show-count="false"
              @click="(val) => activeType = val"
            />

            <div class="flex items-center gap-3">
              <Button
                v-if="activeType === 1 && total > 0"
                variant="gradient"
                size="sm"
                @click="playAllSongs"
              >
                <span class="icon-[mdi--play] mr-1.5 h-4 w-4" />
                {{ $t('actions.playAll') }}
              </Button>

              <div v-if="total > 0" class="flex items-center gap-2">
                <div class="flex items-center gap-1 rounded-xl bg-button-glass border border-glass-subtle p-1">
                  <button
                    class="flex h-9 w-9 items-center justify-center rounded-lg transition-all"
                    :class="
                      page > 1 ? 'text-primary hover:bg-hover-glass' : 'text-primary/30 cursor-not-allowed'
                    "
                    :disabled="page <= 1"
                    :aria-label="$t('components.pagination.prev')"
                    @click="page > 1 && page--"
                  >
                    <span class="icon-[mdi--chevron-left] h-5 w-5" />
                  </button>
                  <span class="text-primary/80 min-w-[50px] text-center text-xs font-medium">
                    {{ page }} / {{ Math.ceil(total / pageSize) || 1 }}
                  </span>
                  <button
                    class="flex h-9 w-9 items-center justify-center rounded-lg transition-all"
                    :class="
                      page < Math.ceil(total / pageSize)
                        ? 'text-primary hover:bg-hover-glass'
                        : 'text-primary/30 cursor-not-allowed'
                    "
                    :disabled="page >= Math.ceil(total / pageSize)"
                    :aria-label="$t('components.pagination.next')"
                    @click="page < Math.ceil(total / pageSize) && page++"
                  >
                    <span class="icon-[mdi--chevron-right] h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 检索结果区（固定适中高度，避免将下方风格雷达单曲完全阻隔） -->
        <div class="relative mb-8 h-[520px] md:h-[580px] overflow-hidden rounded-2xl">
          <component
            :is="activeComp"
            :ref="
              (el: any) => {
                if (activeType === 1) songsRef = el
              }
            "
            :keywords="q"
            :limit="pageSize"
            :offset="(page - 1) * pageSize"
            @loaded="onLoaded"
            @total="onTotal"
          />
          <div v-if="isLoading && activeType !== 1" class="absolute inset-0 z-10">
            <PageSkeleton
              :sections="activeType === 1000 ? ['grid'] : ['list']"
              :grid-count="12"
              :list-count="8"
            />
          </div>
        </div>

        <!-- 风格探索雷达（解耦后只保留单曲列表，可独立换一批，与实际检索结果解耦） -->
        <div class="relative mb-8 shrink-0">
          <StyleRadarSection :genre="selectedTagQuery || q" />
        </div>
      </template>

      <!-- ════════ 未搜索（空状态）时 ════════ -->
      <template v-else>
        <!-- 风格探索雷达（解耦后只保留单曲列表，支持换一批） -->
        <div class="relative mb-8 shrink-0">
          <StyleRadarSection :genre="selectedTagQuery" />
        </div>

        <!-- 热门搜索 -->
        <div class="relative min-h-0 flex-1 pb-6">
          <div class="mb-3 flex items-center gap-2">
            <span class="icon-[mdi--fire] h-4 w-4 text-orange-500/60" />
            <span class="text-primary/40 text-xs font-medium">{{ $t('search.hotSearches') }}</span>
          </div>

          <!-- 骨架屏 -->
          <div v-if="state.loadingHot" class="space-y-1.5">
            <div v-for="i in 12" :key="i" class="flex items-center gap-4 rounded-xl px-3 py-3">
              <div class="h-5 w-5 animate-pulse rounded bg-white/[0.05]" />
              <div class="h-3 animate-pulse rounded bg-white/[0.05]" :style="{ width: `${30 + Math.random() * 35}%` }" />
            </div>
          </div>

          <!-- 热搜双栏列表 -->
          <div v-else class="grid grid-cols-1 sm:grid-cols-2 sm:gap-x-6">
            <button
              v-for="(item, index) in state.hotSearches.slice(0, 20)"
              :key="item.searchWord"
              type="button"
              class="hot-item group flex items-center gap-3 rounded-xl px-3 py-[10px] text-left transition-all duration-200 hover:bg-white/[0.04]"
              :style="{ animationDelay: `${index * 25}ms` }"
              @click="doSearch(item.searchWord)"
            >
              <!-- 排名 -->
              <span
                class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[11px] font-bold leading-none"
                :class="[
                  index === 0
                    ? 'bg-gradient-to-br from-sky-500 to-blue-600 text-white'
                    : index === 1
                      ? 'bg-gradient-to-br from-sky-400 to-blue-600 text-white'
                      : index === 2
                        ? 'bg-gradient-to-br from-cyan-400 to-blue-500 text-amber-900'
                        : 'text-primary/25'
                ]"
              >
                {{ index + 1 }}
              </span>

              <!-- 关键词 + 热度条 -->
              <div class="min-w-0 flex-1">
                <span
                  class="block truncate text-sm transition-colors duration-200"
                  :class="index < 3 ? 'text-primary/90 font-semibold' : 'text-primary/60 group-hover:text-primary/85'"
                >
                  {{ item.searchWord }}
                </span>
                <!-- 热度渐变条 -->
                <div class="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-white/[0.04]">
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="index < 3 ? 'bg-gradient-to-r from-sky-500/60 to-blue-500/40' : 'bg-white/[0.08]'"
                    :style="{ width: `${Math.max(8, (item.score / maxScore) * 100)}%` }"
                  />
                </div>
              </div>

              <!-- 标签 -->
              <span
                v-if="item.iconType === 1"
                class="shrink-0 rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-bold leading-none text-blue-400"
              >HOT</span>
              <span
                v-else-if="item.iconType === 5"
                class="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold leading-none text-emerald-400"
              >NEW</span>

              <!-- 热度值 -->
              <span class="text-primary/70 w-10 shrink-0 text-right text-[11px] tabular-nums">
                {{ Math.round(item.score / 10000) }}w
              </span>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ═══ 背景氛围光 ═══ */
.ambient-a {
  background: radial-gradient(circle, rgba(56,189,248, 0.07) 0%, transparent 65%);
  animation: ambient-float 12s ease-in-out infinite;
}
.ambient-b {
  background: radial-gradient(circle, rgba(37,99,235, 0.05) 0%, transparent 65%);
  animation: ambient-float 15s ease-in-out infinite reverse;
}
@keyframes ambient-float {
  0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.6; }
  33% { transform: translate(20px, -15px) scale(1.05); opacity: 0.8; }
  66% { transform: translate(-15px, 10px) scale(0.97); opacity: 0.5; }
}

/* ═══ 搜索按钮渐变 ═══ */
.search-btn {
  background: linear-gradient(135deg, #38bdf8, #2563eb);
  box-shadow: 0 2px 10px rgba(56,189,248, 0.25);
}
.search-btn:hover {
  box-shadow: 0 4px 16px rgba(56,189,248, 0.35);
  filter: brightness(1.1);
}

/* ═══ 搜索历史与Tag标签入场 ═══ */
.history-chip,
.tag-chip {
  animation: chip-in 0.3s var(--glass-ease-out) both;
}
@keyframes chip-in {
  from { opacity: 0; transform: translateY(3px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* ═══ 热搜入场 ═══ */
.hot-item {
  animation: item-in 0.3s var(--glass-ease-out) both;
}
@keyframes item-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ═══ 淡入缩放过渡（清除按钮） ═══ */
.fade-scale-enter-active,
.fade-scale-leave-active {
  transition: all 0.2s ease;
}
.fade-scale-enter-from,
.fade-scale-leave-to {
  opacity: 0;
  transform: scale(0.8);
}
</style>

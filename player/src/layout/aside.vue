<script setup lang="ts">
import { useGlobalStore } from '@/stores/modules/global'
import { useLibraryStore } from '@/stores/modules/library'
import { useToastStore } from '@/stores/modules/toast'
import SidebarAccount from '@/components/Account/SidebarAccount.vue'
import { storeToRefs } from 'pinia'
import { gsap } from 'gsap'
import {
  BRAND_PARENT,
  BRAND_PRODUCT,
  BRAND_STUDIO,
} from '@/config/brand'

import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAudio } from '@/composables/useAudio'

const router = useRouter()
const route = useRoute()
const globalStore = useGlobalStore()
const { sidebarCollapsed } = storeToRefs(globalStore)

// 侧边栏搜索框
const searchQuery = ref('')
const handleSearch = () => {
  const q = searchQuery.value.trim()
  if (!q) return
  globalStore.addSearchHistory(q)
  router.push({ path: '/search', query: { q } })
}

const sections = [
  {
    titleKey: 'layout.aside.explore',
    items: [
      { to: '/', labelKey: 'layout.aside.menu.home', icon: 'mdi--home' },
      { to: '/mv-list', labelKey: 'layout.aside.menu.mv', icon: 'mdi--video' },
      { to: '/charts', labelKey: 'layout.aside.menu.charts', icon: 'mdi--chart-line' },
      { to: '/artists', labelKey: 'layout.aside.menu.artists', icon: 'mdi--account-music' },
      { to: '/new-albums', labelKey: 'layout.aside.menu.newAlbums', icon: 'mdi--album' },
      { to: '/search', labelKey: 'layout.aside.menu.search', icon: 'ic--round-search' },
    ],
  },
  {
    titleKey: 'layout.aside.myMusic',
    items: [
      { to: '/likes', labelKey: 'layout.aside.menu.likes', icon: 'mdi--heart-outline' },
      { to: '/recent', labelKey: 'layout.aside.menu.recent', icon: 'mdi--history' },
      {
        to: '/downloads',
        labelKey: 'layout.aside.menu.downloads',
        icon: 'mdi--download-circle-outline',
      },
      {
        to: '/local-music',
        labelKey: 'layout.aside.menu.localMusic',
        icon: 'mdi--folder-music-outline',
      },
    ],
  },
  {
    titleKey: 'layout.aside.system',
    items: [{ to: '/settings', labelKey: 'layout.aside.menu.settings', icon: 'mdi--cog' }],
  },
]

// 收藏歌单（本地 library store，持久化）
const libraryStore = useLibraryStore()
const collectedPlaylists = computed(() => libraryStore.collectedPlaylists)

// 我的歌单（本地新建歌单,点击直接入队播放）
const { t } = useI18n()
const toastStore = useToastStore()
const { setPlaylist, play: playSong } = useAudio()
const userPlaylists = computed(() => libraryStore.userPlaylists)

const playUserPlaylist = (playlistId: string) => {
  const songs = libraryStore.toPlayableSongsForUserPlaylist(playlistId)
  if (!songs.length) {
    toastStore.show({ message: t('player.emptyUserPlaylistSongs'), type: 'info' })
    return
  }
  setPlaylist(songs, 0)
  playSong()
}

const deleteUserPlaylist = (playlistId: string) => {
  libraryStore.removeUserPlaylist(playlistId)
}

// 活动指示器相关
const indicatorRef = ref<HTMLElement | null>(null)
const navContainerRef = ref<HTMLElement | null>(null)

// 更新指示器位置
const updateIndicator = () => {
  if (!indicatorRef.value || !navContainerRef.value || sidebarCollapsed.value) {
    if (indicatorRef.value) {
      gsap.to(indicatorRef.value, { opacity: 0, duration: 0.15 })
    }
    return
  }

  const activeLink = navContainerRef.value.querySelector('.nav-link-active') as HTMLElement
  if (!activeLink) {
    gsap.to(indicatorRef.value, {
      opacity: 0,
      duration: 0.2,
    })
    return
  }

  const containerRect = navContainerRef.value.getBoundingClientRect()
  const linkRect = activeLink.getBoundingClientRect()

  gsap.to(indicatorRef.value, {
    y: linkRect.top - containerRect.top,
    height: linkRect.height,
    opacity: 1,
    duration: 0.25,
    ease: 'power3.out',
  })
}

// 路由代码块按需预取
const routeChunkLoaders: Record<string, () => Promise<any>> = {
  '/': () => import('@/pages/index.vue'),
  '/mv-list': () => import('@/pages/mv-list.vue'),
  '/charts': () => import('@/pages/charts.vue'),
  '/artists': () => import('@/pages/artists.vue'),
  '/new-albums': () => import('@/pages/new-albums.vue'),
  '/search': () => import('@/pages/search.vue'),
  '/recent': () => import('@/pages/recent.vue'),
  '/likes': () => import('@/pages/likes.vue'),
  '/downloads': () => import('@/pages/downloads.vue'),
  '/local-music': () => import('@/pages/local-music.vue'),
  '/settings': () => import('@/pages/settings.vue'),
}

const prefetchedRoutes = new Set<string>()
const prefetchRoute = (to: string) => {
  if (!to || prefetchedRoutes.has(to)) return
  const loader = routeChunkLoaders[to]
  if (loader) {
    prefetchedRoutes.add(to)
    loader().catch(() => {})
  }
}

// 监听路由与折叠状态变化
watch(
  () => route.path,
  () => {
    nextTick(() => {
      updateIndicator()
    })
  },
  { immediate: true }
)

watch(sidebarCollapsed, () => {
  nextTick(() => {
    updateIndicator()
  })
})

onMounted(() => {
  nextTick(() => {
    updateIndicator()
  })
  const scheduleIdle =
    typeof window !== 'undefined' && 'requestIdleCallback' in window
      ? (cb: () => void) => (window as any).requestIdleCallback(cb, { timeout: 2000 })
      : (cb: () => void) => setTimeout(cb, 1200)

  scheduleIdle(() => {
    prefetchRoute('/search')
    prefetchRoute('/downloads')
    prefetchRoute('/settings')
  })
})

// 检查是否是当前路由
const isActive = (path: string) => {
  if (path === '/') {
    return route.path === '/'
  }
  return route.path.startsWith(path)
}

// 根据浏览器历史状态禁用不可用的前进/后退按钮
const historyVersion = ref(0)
const syncHistoryState = () => {
  historyVersion.value += 1
}
const canGoBack = computed(() => {
  void historyVersion.value
  return Boolean((window.history.state as { back?: string | null } | null)?.back)
})
const canGoForward = computed(() => {
  void historyVersion.value
  return Boolean((window.history.state as { forward?: string | null } | null)?.forward)
})

watch(() => route.fullPath, syncHistoryState)
onMounted(() => window.addEventListener('popstate', syncHistoryState))
onUnmounted(() => window.removeEventListener('popstate', syncHistoryState))
</script>

<template>
  <aside
    class="hidden md:flex shrink-0 h-full flex-col transition-all duration-300 ease-in-out"
    :class="sidebarCollapsed ? 'w-20' : 'w-64 xl:w-72'"
  >
    <div
      class="sidebar relative flex h-full w-full flex-col justify-between rounded-[28px] overflow-hidden transition-all duration-300"
      :class="sidebarCollapsed ? 'p-2.5 items-center' : 'p-3.5 xl:p-4'"
    >
      <div class="flex flex-col min-h-0 flex-1 w-full">
        <!-- 顶部：展开模式下的招牌 Logo + 品牌排版 + 前进后退导航按钮 -->
        <div v-if="!sidebarCollapsed" class="flex flex-col pb-2.5 border-b border-glass shrink-0 gap-2">
          <div class="flex items-center gap-3">
            <!-- 放大招牌 Logo 作为左侧交互招牌，承担收起侧边栏的交互 button -->
            <button
              type="button"
              @click="globalStore.toggleSidebarCollapsed()"
              class="group relative flex items-center justify-center p-0.5 rounded-2xl bg-button-glass hover:bg-hover-button-glass border border-glass transition-all duration-300 hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 shrink-0 cursor-pointer"
              :title="$t('layout.aside.collapseSidebar') || '收起侧边栏'"
              :aria-label="$t('layout.aside.collapseSidebar') || '收起侧边栏'"
            >
              <img
                src="/logo.svg"
                :alt="BRAND_PRODUCT"
                width="42"
                height="42"
                loading="eager"
                decoding="async"
                class="h-10 w-10 xl:h-11 xl:w-11 rounded-xl shadow-[0_0_18px_rgba(37,99,235,0.45)] transition-transform duration-300 group-hover:scale-105 shrink-0 object-contain"
              />
              <span
                class="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-sky-50 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
              >
                <span class="icon-[mdi--chevron-left] h-3 w-3"></span>
              </span>
            </button>

            <!-- 品牌名称：epocanvas 作为副标题在上方，Sonic 为绝对主标题在正中心，STUDIO 标志在 Sonic 同水平后上方 -->
            <div class="flex flex-1 flex-col justify-center min-w-0 leading-tight">
              <span class="text-[10px] xl:text-[11px] font-bold tracking-[0.18em] text-primary/50 uppercase truncate select-none">
                {{ BRAND_PARENT }}
              </span>
              <div class="flex items-baseline gap-1.5 min-w-0">
                <span class="text-primary text-xl xl:text-2xl font-black tracking-tight leading-none select-none">
                  {{ BRAND_PRODUCT.charAt(0).toUpperCase() + BRAND_PRODUCT.slice(1) }}
                </span>
                <span
                  class="inline-flex items-center -translate-y-1.5 px-1.5 py-0.2 text-[9px] font-extrabold uppercase tracking-wider rounded-md bg-linear-to-r from-blue-500/25 to-sky-400/25 border border-blue-400/30 text-sky-300 shadow-[0_0_8px_rgba(56,189,248,0.2)] select-none"
                >
                  {{ BRAND_STUDIO }}
                </span>
              </div>
            </div>
          </div>

          <!-- 给下面的前进、后退留下充裕空间 -->
          <div class="flex items-center justify-between pt-0.5">
            <span class="text-[10px] font-bold tracking-[0.16em] uppercase text-primary/40 select-none">
              {{ $t('layout.aside.navigation') || 'NAVIGATE' }}
            </span>
            <div class="flex items-center gap-0.5 rounded-full bg-button-glass border border-glass p-0.5">
              <button
                @click="router.back()"
                :title="$t('common.back')"
                :aria-label="$t('common.back')"
                :disabled="!canGoBack"
                :aria-disabled="!canGoBack"
                class="flex h-7 w-7 items-center justify-center rounded-full text-primary/60 hover:text-primary hover:bg-hover-button-glass transition-colors disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
              >
                <span class="icon-[mdi--chevron-left] h-3.5 w-3.5"></span>
              </button>
              <button
                @click="router.forward()"
                :title="$t('common.forward')"
                :aria-label="$t('common.forward')"
                :disabled="!canGoForward"
                :aria-disabled="!canGoForward"
                class="flex h-7 w-7 items-center justify-center rounded-full text-primary/60 hover:text-primary hover:bg-hover-button-glass transition-colors disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
              >
                <span class="icon-[mdi--chevron-right] h-3.5 w-3.5"></span>
              </button>
            </div>
          </div>
        </div>

        <!-- 顶部：折叠模式下的招牌 Logo + 展开交互按钮 -->
        <div v-else class="flex flex-col items-center pb-2.5 border-b border-glass shrink-0 w-full gap-2">
          <button
            type="button"
            @click="globalStore.toggleSidebarCollapsed()"
            class="group relative flex items-center justify-center p-1 rounded-2xl bg-button-glass hover:bg-hover-button-glass border border-glass transition-all duration-300 hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 shrink-0 cursor-pointer"
            :title="$t('layout.aside.expandSidebar') || '展开侧边栏'"
            :aria-label="$t('layout.aside.expandSidebar') || '展开侧边栏'"
          >
            <img
              src="/logo.svg"
              :alt="BRAND_PRODUCT"
              width="40"
              height="40"
              loading="eager"
              decoding="async"
              class="h-10 w-10 rounded-xl shadow-[0_0_18px_rgba(37,99,235,0.45)] transition-transform duration-300 group-hover:scale-105 shrink-0 object-contain"
            />
            <span
              class="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-sky-50 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
            >
              <span class="icon-[mdi--chevron-right] h-3 w-3"></span>
            </span>
          </button>

          <!-- 折叠下的前进后退紧凑按钮 -->
          <div class="flex items-center gap-1">
            <button
              @click="router.back()"
              :title="$t('common.back')"
              :aria-label="$t('common.back')"
              :disabled="!canGoBack"
              class="flex h-6 w-6 items-center justify-center rounded-full text-primary/50 hover:text-primary hover:bg-hover-button-glass transition-colors disabled:opacity-20 cursor-pointer"
            >
              <span class="icon-[mdi--chevron-left] h-3 w-3"></span>
            </button>
            <button
              @click="router.forward()"
              :title="$t('common.forward')"
              :aria-label="$t('common.forward')"
              :disabled="!canGoForward"
              class="flex h-6 w-6 items-center justify-center rounded-full text-primary/50 hover:text-primary hover:bg-hover-button-glass transition-colors disabled:opacity-20 cursor-pointer"
            >
              <span class="icon-[mdi--chevron-right] h-3 w-3"></span>
            </button>
          </div>
        </div>

        <!-- 快速搜索框 (优化尺寸与折叠适配) -->
        <div v-if="!sidebarCollapsed" class="pt-2.5 pb-1.5 shrink-0">
          <div
            class="flex items-center gap-2 rounded-xl bg-button-glass px-2.5 py-1.5 border border-glass text-primary transition-all duration-200 focus-within:border-[#2563eb]/60 focus-within:bg-hover-button-glass focus-within:ring-2 focus-within:ring-[#2563eb]/20"
          >
            <span class="icon-[mdi--magnify] h-3.5 w-3.5 shrink-0 text-primary/40"></span>
            <input
              v-model="searchQuery"
              @keyup.enter="handleSearch"
              type="text"
              data-testid="nav-search-input"
              :aria-label="$t('common.search.label')"
              :placeholder="$t('common.search.placeholder')"
              class="w-full bg-transparent text-xs font-medium outline-none placeholder:text-primary/35"
            />
            <button
              v-if="searchQuery"
              @click="searchQuery = ''"
              class="text-primary/40 hover:text-primary shrink-0"
            >
              <span class="icon-[mdi--close] h-3 w-3"></span>
            </button>
            <span
              v-else
              class="rounded bg-hover-glass px-1 py-0.2 text-[10px] font-semibold text-primary/40 select-none"
            >↵</span>
          </div>
        </div>

        <!-- 折叠模式下的搜索图标快捷入口 -->
        <div v-else class="pt-2 pb-1 shrink-0 flex justify-center w-full">
          <button
            @click="router.push('/search')"
            class="flex h-9 w-9 items-center justify-center rounded-xl bg-button-glass hover:bg-hover-button-glass border border-glass text-primary/60 hover:text-primary transition-all cursor-pointer"
            :title="$t('common.search.label')"
            :aria-label="$t('common.search.label')"
          >
            <span class="icon-[mdi--magnify] h-4 w-4"></span>
          </button>
        </div>

        <!-- 导航菜单区域 (滚动容器：优化各项大小与比例，去除原先过大方框) -->
        <div class="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-0.5 custom-scrollbar pt-1">
          <!-- 滑动指示器 (适应优化后的紧凑尺寸) -->
          <div
            ref="indicatorRef"
            class="nav-indicator pointer-events-none absolute right-1 left-1 rounded-xl bg-button-glass border border-glass opacity-0"
            style="height: 34px; z-index: 0"
          ></div>

          <div ref="navContainerRef">
            <div
              v-for="sec in sections"
              :key="sec.titleKey"
              :class="sidebarCollapsed ? 'mb-2.5 flex flex-col items-center' : 'mb-3'"
            >
              <h3
                v-if="!sidebarCollapsed"
                class="text-primary/40 mb-1 px-2 text-[10px] font-bold tracking-[.18em] uppercase select-none"
              >
                {{ $t(sec.titleKey) }}
              </h3>
              <div v-else class="my-1.5 w-6 h-[1px] bg-glass"></div>

              <nav class="relative space-y-1 w-full">
                <router-link
                  v-for="item in sec.items"
                  :key="item.to"
                  :to="item.to"
                  @mouseenter="prefetchRoute(item.to)"
                  @focus="prefetchRoute(item.to)"
                  class="nav-link text-primary/70 hover:text-primary relative z-10 flex items-center h-[34px] min-h-[34px] rounded-xl text-xs transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                  :class="[
                    sidebarCollapsed ? 'justify-center px-0 w-9 mx-auto' : 'space-x-2.5 px-2.5 py-1',
                    {
                      'nav-link-active text-primary font-semibold': isActive(item.to),
                      'hover:bg-hover-glass': !isActive(item.to),
                    }
                  ]"
                  :title="sidebarCollapsed ? $t(item.labelKey) : undefined"
                >
                  <span
                    class="h-4 w-4 shrink-0 transition-transform duration-200"
                    :class="[
                      `icon-[${item.icon}]`,
                      isActive(item.to) ? 'text-[#2563eb] drop-shadow-[0_0_8px_rgba(37,99,235,0.8)] scale-110' : ''
                    ]"
                  ></span>
                  <span v-if="!sidebarCollapsed" class="truncate font-medium">{{ $t(item.labelKey) }}</span>
                </router-link>
              </nav>
            </div>

            <!-- 收藏的歌单（本地持久化） -->
            <div
              v-if="collectedPlaylists.length"
              :class="sidebarCollapsed ? 'mb-2.5 flex flex-col items-center' : 'mb-3'"
            >
              <h3
                v-if="!sidebarCollapsed"
                class="text-primary/40 mb-1 px-2 text-[10px] font-bold tracking-[.18em] uppercase select-none"
              >
                {{ $t('layout.aside.collectedPlaylists') }}
              </h3>
              <div v-else class="my-1.5 w-6 h-[1px] bg-glass"></div>

              <nav class="relative space-y-1 w-full">
                <router-link
                  v-for="pl in collectedPlaylists"
                  :key="pl.id"
                  :to="`/playlist/${pl.id}`"
                  class="nav-link text-primary/70 hover:text-primary relative z-10 flex items-center h-[34px] min-h-[34px] rounded-xl text-xs transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                  :class="[
                    sidebarCollapsed ? 'justify-center px-0 w-9 mx-auto' : 'space-x-2.5 px-2.5 py-1',
                    {
                      'nav-link-active text-primary font-semibold': isActive(`/playlist/${pl.id}`),
                      'hover:bg-hover-glass': !isActive(`/playlist/${pl.id}`),
                    }
                  ]"
                  :title="sidebarCollapsed ? pl.name : undefined"
                >
                  <span
                    class="h-4 w-4 shrink-0 text-[#2563eb]"
                    :class="isActive(`/playlist/${pl.id}`) ? 'icon-[mdi--playlist-music] drop-shadow-[0_0_8px_rgba(37,99,235,0.8)] scale-110' : 'icon-[mdi--playlist-music]'"
                  ></span>
                  <span v-if="!sidebarCollapsed" class="truncate font-medium">{{ pl.name }}</span>
                </router-link>
              </nav>
            </div>

            <!-- 我的歌单（本地新建,点击入队播放） -->
            <div
              v-if="userPlaylists.length"
              :class="sidebarCollapsed ? 'mb-2.5 flex flex-col items-center' : 'mb-3'"
            >
              <h3
                v-if="!sidebarCollapsed"
                class="text-primary/40 mb-1 px-2 text-[10px] font-bold tracking-[.18em] uppercase select-none"
              >
                {{ $t('layout.aside.userPlaylists') }}
              </h3>
              <div v-else class="my-1.5 w-6 h-[1px] bg-glass"></div>

              <nav class="relative space-y-1 w-full">
                <div
                  v-for="pl in userPlaylists"
                  :key="pl.id"
                  class="nav-link text-primary/70 hover:text-primary relative z-10 flex items-center h-[34px] min-h-[34px] rounded-xl text-xs transition-all duration-200 outline-none focus-within:ring-2 focus-within:ring-sky-400/60"
                  :class="sidebarCollapsed ? 'justify-center px-0 w-9 mx-auto hover:bg-hover-glass' : 'space-x-2 px-2.5 py-1'"
                  :title="sidebarCollapsed ? pl.name : undefined"
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center space-x-2 text-left outline-none cursor-pointer"
                    :class="sidebarCollapsed ? 'justify-center' : ''"
                    :title="$t('player.playUserPlaylist')"
                    :aria-label="`${$t('player.playUserPlaylist')}: ${pl.name}`"
                    @click="playUserPlaylist(pl.id)"
                  >
                    <span class="icon-[mdi--playlist-star] h-4 w-4 shrink-0 text-[#38bdf8]"></span>
                    <span v-if="!sidebarCollapsed" class="truncate font-medium">{{ pl.name }}</span>
                    <span v-if="!sidebarCollapsed" class="text-primary/40 shrink-0 text-[10px]">{{ pl.songs.length }}</span>
                  </button>
                  <button
                    v-if="!sidebarCollapsed"
                    type="button"
                    class="text-primary/40 hover:text-red-400 shrink-0 rounded-lg p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 cursor-pointer"
                    :title="$t('player.deleteUserPlaylist')"
                    :aria-label="`${$t('player.deleteUserPlaylist')}: ${pl.name}`"
                    @click.stop="deleteUserPlaylist(pl.id)"
                  >
                    <span class="icon-[mdi--delete-outline] h-3.5 w-3.5"></span>
                  </button>
                </div>
              </nav>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部账户管理 (移出单独色调调整至设置页，学习 ChatGPT 类 AI UI 统一放置全权交给 EpoMail 的账户系统) -->
      <div class="pt-2.5 border-t border-glass shrink-0 w-full">
        <SidebarAccount :collapsed="Boolean(sidebarCollapsed)" />
      </div>

      <div class="hidden">
        <span class="icon-[mdi--home] h-5 w-5"></span>
        <span class="icon-[mdi--video] h-5 w-5"></span>
        <span class="icon-[mdi--chart-line] h-5 w-5"></span>
        <span class="icon-[ic--round-search] h-5 w-5"></span>
        <span class="icon-[mdi--music-box-multiple] h-5 w-5"></span>
        <span class="icon-[mdi--heart-outline] h-5 w-5"></span>
        <span class="icon-[mdi--cog] h-5 w-5"></span>
        <span class="icon-[mdi--chevron-right] h-5 w-5"></span>
        <span class="icon-[mdi--account-music] h-5 w-5"></span>
        <span class="icon-[mdi--album] h-5 w-5"></span>
        <span class="icon-[mdi--download-circle-outline] h-5 w-5"></span>
        <span class="icon-[mdi--folder-music-outline] h-5 w-5"></span>
        <span class="icon-[mdi--badge-account-outline] h-5 w-5"></span>
        <span class="icon-[mdi--email-fast-outline] h-5 w-5"></span>
        <span class="icon-[mdi--dots-horizontal] h-5 w-5"></span>
        <span class="icon-[mdi--arrow-top-right] h-5 w-5"></span>
        <span class="icon-[mdi--account-lock-outline] h-5 w-5"></span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 导航指示器过渡与毛玻璃微光 */
.nav-indicator {
  transition: opacity 0.2s ease;
  background-color: var(--glass-interactive-bg);
  border: 1px solid var(--glass-border-default);
  box-shadow: 0 0 14px rgba(37, 99, 235, 0.12);
}

/* 导航链接悬停效果 */
.nav-link {
  position: relative;
}

.nav-link::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 0.75rem;
  background: transparent;
  transition: background 0.2s ease;
}

.nav-link:hover::before {
  background: var(--glass-interactive-hover-muted);
}

.nav-link-active::before {
  background: transparent;
}
</style>

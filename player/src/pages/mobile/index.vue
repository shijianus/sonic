<script setup lang="ts">
import { banner, personalized, personalizedNewsong, personalizedMv, topArtists, mvAll } from '@/api'
import { BRAND_PRODUCT } from '@/config/brand'
import { useI18n } from 'vue-i18n'
import { usePreferredReducedMotion } from '@vueuse/core'
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Autoplay, Pagination, EffectCards } from 'swiper/modules'
import 'swiper/css'
import 'swiper/css/pagination'
import 'swiper/css/effect-cards'

import { formatCount } from '@/utils/time'
import {
  transformBanners,
  transformPlaylists,
  transformSongs,
  transformMVs,
  transformMVList,
  transformArtists,
  type BannerData,
  type PlaylistData,
  type SongData,
  type MVData,
  type ArtistData,
} from '@/utils/transformers'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useAudio } from '@/composables/useAudio'
import type { Song as StoreSong } from '@/stores/interface'
import { useGlobalStore } from '@/stores/modules/global'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useToastStore } from '@/stores/modules/toast'
import { fetchRecommendSimilar } from '@/api/recommend'
import MusicRadarSection from '@/components/Recommend/MusicRadarSection.vue'

const { t } = useI18n()
const router = useRouter()
const { play, pause, resume, setPlaylist, currentSong, isPlaying } = useAudio()
const globalStore = useGlobalStore()
const recommendStore = useRecommendStore()
const toastStore = useToastStore()
const hasSearchHistory = computed(() => (globalStore.searchHistory?.length || 0) > 0)

interface HomeState {
  banners: BannerData[]
  playlists: PlaylistData[]
  newSongs: SongData[]
  mvs: MVData[]
  artists: ArtistData[]
  isLoading: boolean
}

const state = reactive<HomeState>({
  banners: [],
  playlists: [],
  newSongs: [],
  mvs: [],
  artists: [],
  isLoading: true,
})

const { banners, playlists, newSongs, mvs, artists, isLoading } = toRefs(state)

const loadHomeData = async () => {
  state.isLoading = true
  try {
    const [bRes, pRes, sRes, mRes, aRes] = await Promise.allSettled([
      banner({ type: 2 }),
      personalized({ limit: 6 }),
      personalizedNewsong({ limit: 6 }),
      personalizedMv({ limit: 4 }),
      topArtists({ limit: 10 }),
    ])

    if (bRes.status === 'fulfilled' && bRes.value) {
      state.banners = transformBanners(bRes.value as Record<string, unknown>, 5)
    }
    if (pRes.status === 'fulfilled' && pRes.value) {
      state.playlists = transformPlaylists(pRes.value as Record<string, unknown>, 6, t('home.playlistFallback'))
    }
    if (sRes.status === 'fulfilled' && sRes.value) {
      state.newSongs = transformSongs(sRes.value as Record<string, unknown>, 6)
    }
    if (mRes.status === 'fulfilled' && mRes.value) {
      let mvs = transformMVs(mRes.value as Record<string, unknown>, 4)
      if (mvs.length < 4) {
        try {
          const fallbackRes: any = await mvAll({ limit: 4, order: '最新' })
          const fallbackMvs = transformMVList(fallbackRes, 4)
          const existingIds = new Set(mvs.map(m => m.id))
          for (const item of fallbackMvs) {
            if (!existingIds.has(item.id)) {
              mvs.push(item)
              existingIds.add(item.id)
            }
            if (mvs.length >= 4) break
          }
        } catch {}
      }
      state.mvs = mvs.slice(0, 4)
    } else {
      try {
        const fallbackRes: any = await mvAll({ limit: 4, order: '最新' })
        state.mvs = transformMVList(fallbackRes, 4)
      } catch {}
    }
    if (aRes.status === 'fulfilled' && aRes.value) {
      state.artists = transformArtists(aRes.value as Record<string, unknown>, 10)
    }
  } catch (err) {
    console.error('Mobile home data loading error:', err)
  } finally {
    state.isLoading = false
  }
}

onMounted(loadHomeData)

const swiperModules = [Autoplay, Pagination, EffectCards]

const reducedMotion = usePreferredReducedMotion()
const prefersReduced = computed(() => reducedMotion.value === 'reduce')
const bannerSwiper = ref<any>(null)
const autoplayPaused = ref(false)
const hoverPaused = ref(false)

const syncAutoplay = () => {
  if (!bannerSwiper.value?.autoplay) return
  if (prefersReduced.value || autoplayPaused.value || hoverPaused.value) {
    bannerSwiper.value.autoplay.stop()
  } else {
    bannerSwiper.value.autoplay.start()
  }
}

const onBannerSwiper = (swiper: any) => {
  bannerSwiper.value = swiper
  syncAutoplay()
}

const toggleAutoplay = () => {
  autoplayPaused.value = !autoplayPaused.value
  syncAutoplay()
}

const pauseForInteraction = () => {
  hoverPaused.value = true
  syncAutoplay()
}

const resumeAfterInteraction = () => {
  hoverPaused.value = false
  syncAutoplay()
}

watch(prefersReduced, syncAutoplay)

const activeBannerIndex = ref(0)
const onBannerSlideChange = (sw: any) => {
  activeBannerIndex.value = sw.realIndex ?? 0
}
const activeBanner = computed(() => state.banners[activeBannerIndex.value] || state.banners[0])

const isBannerActiveSong = (item: BannerData) => {
  if (item.targetType !== 1 || !item.targetId) return false
  return String(currentSong.value?.id ?? '') === String(item.targetId)
}

const isBannerPlaying = (item: BannerData) => {
  return isBannerActiveSong(item) && isPlaying.value
}

const getBannerTagMeta = (item: BannerData) => {
  const rawTitle = item.title?.trim() || ''
  if (item.targetType === 1) {
    return {
      text: rawTitle || t('home.tagSingle'),
      gradientClass: 'from-rose-500 via-red-500 to-rose-600 shadow-rose-500/25',
      icon: 'icon-[mdi--music]',
    }
  }
  if (item.targetType === 10) {
    return {
      text: rawTitle || t('home.tagAlbum'),
      gradientClass: 'from-amber-500 via-orange-500 to-amber-600 shadow-amber-500/25',
      icon: 'icon-[mdi--album]',
    }
  }
  if (item.targetType === 1000) {
    return {
      text: rawTitle || t('home.tagPlaylist'),
      gradientClass: 'from-sky-500 via-blue-500 to-indigo-600 shadow-sky-500/25',
      icon: 'icon-[mdi--playlist-music]',
    }
  }
  if (item.targetType === 1004) {
    return {
      text: rawTitle || t('home.tagMv'),
      gradientClass: 'from-emerald-500 via-teal-500 to-emerald-600 shadow-emerald-500/25',
      icon: 'icon-[mdi--video]',
    }
  }
  return {
    text: rawTitle || t('home.exclusiveRecommend', { brand: BRAND_PRODUCT }),
    gradientClass: 'from-slate-700 via-slate-800 to-slate-900 shadow-black/30',
    icon: 'icon-[mdi--fire]',
  }
}

const handlePlayBannerDirectly = async (item: BannerData, e?: Event) => {
  e?.stopPropagation()

  if (item.targetType === 1 && item.targetId) {
    if (isBannerActiveSong(item)) {
      if (isPlaying.value) {
        pause()
      } else {
        resume()
      }
      return
    }

    const storeSong: StoreSong = {
      id: Number(item.targetId),
      name: item.description || item.title || t('home.bannerSongFallback', { brand: BRAND_PRODUCT }),
      artist: item.title || t('home.bannerArtistFallback', { brand: BRAND_PRODUCT }),
      cover: item.coverImgUrl,
      duration: 0,
    }

    setPlaylist([storeSong], 0)
    play(storeSong, 0)

    try {
      const simRes = await fetchRecommendSimilar(
        {
          trackId: String(item.targetId),
          title: storeSong.name,
          artist: storeSong.artist,
          count: 10,
        },
        recommendStore.buildRequestHeaders(true)
      )
      if (simRes?.tracks?.length > 0) {
        const fullQueue: StoreSong[] = [
          storeSong,
          ...simRes.tracks.map((track: any) => ({
            id: track.id,
            name: track.name,
            artist: track.artist,
            album: track.album || '',
            duration: track.duration || 0,
            cover: track.cover || '',
          })),
        ]
        setPlaylist(fullQueue, 0)
      }
    } catch (err) {
      console.warn('[Banner] Auto enrich mobile queue warning:', err)
    }

    toastStore.show({
      message: t('home.bannerPlayingSingle', {
        title: storeSong.name,
      }),
      type: 'success',
      actions: [
        {
          label: t('player.openPlayer') || '展开大屏',
          primary: true,
          handler: () => {
            globalStore.openPlayerDrawer()
          },
        },
      ],
    })
    return
  }

  if (item.targetType === 10 && item.targetId) {
    router.push(`/album/${item.targetId}?autoplay=1`)
    return
  }

  if (item.targetType === 1000 && item.targetId) {
    router.push(`/playlist/${item.targetId}`)
    return
  }

  if (item.internalTo) {
    router.push(item.internalTo)
  }
}

const handleBannerClick = (item: BannerData) => {
  if (item.targetType === 1 && item.targetId) {
    handlePlayBannerDirectly(item)
    return
  }
  if (item.targetType === 10 && item.targetId) {
    router.push(`/album/${item.targetId}?autoplay=1`)
    return
  }
  if (item.targetType === 1000 && item.targetId) {
    router.push(`/playlist/${item.targetId}`)
    return
  }
  if (item.internalTo) {
    router.push(item.internalTo)
  }
}
</script>

<template>
  <div class="flex-1 overflow-hidden">
    <div class="h-full overflow-auto pb-4" tabindex="0">
      <template v-if="isLoading">
        <MobileHomeSkeleton />
      </template>
      <template v-else>
        <section
          v-if="banners.length"
          class="relative mb-6 px-4 pt-2"
          @mouseenter="pauseForInteraction"
          @mouseleave="resumeAfterInteraction"
          @focusin="pauseForInteraction"
          @focusout="resumeAfterInteraction"
        >
          <!-- 动态海报氛围光晕背景 -->
          <div
            class="pointer-events-none absolute -inset-2 -z-10 overflow-hidden rounded-3xl opacity-30 blur-2xl transition-opacity duration-700 ease-out"
            aria-hidden="true"
          >
            <img
              v-if="activeBanner?.coverImgUrl"
              :src="activeBanner.coverImgUrl"
              class="h-full w-full object-cover scale-125 filter transition-all duration-700 ease-out"
              alt=""
            />
          </div>

          <button
            type="button"
            class="absolute top-4 right-6 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-glass bg-[var(--glass-bg-overlay)] text-primary shadow-lg backdrop-blur-md transition-colors active:scale-95"
            :aria-label="autoplayPaused ? t('home.playCarousel') : t('home.pauseCarousel')"
            :title="autoplayPaused ? t('home.playCarousel') : t('home.pauseCarousel')"
            @click="toggleAutoplay"
          >
            <span :class="autoplayPaused ? 'icon-[mdi--play]' : 'icon-[mdi--pause]'" class="h-5 w-5"></span>
          </button>
          <Swiper
            :modules="swiperModules"
            :slides-per-view="1"
            :space-between="12"
            :speed="prefersReduced ? 0 : 300"
            :autoplay="prefersReduced ? false : { delay: 4000, disableOnInteraction: false }"
            @swiper="onBannerSwiper"
            @slideChange="onBannerSlideChange"
            :pagination="{ clickable: true }"
            class="home-swiper w-full aspect-[1080/400] max-h-[45vh] overflow-visible rounded-2xl shadow-lg"
          >
            <SwiperSlide v-for="(item, i) in banners" :key="i" class="rounded-2xl">
              <div
                role="button"
                tabindex="0"
                @click="handleBannerClick(item)"
                @keydown.enter.prevent="handleBannerClick(item)"
                @keydown.space.prevent="handleBannerClick(item)"
                class="group relative block h-full w-full cursor-pointer overflow-hidden rounded-2xl select-none focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:outline-none"
              >
                <LazyImage
                  :src="item.coverImgUrl"
                  alt="banner"
                  imgClass="h-full w-full object-cover"
                />
                <div
                  class="absolute inset-0 bg-linear-to-t from-black/80 via-black/20 to-transparent"
                ></div>

                <!-- 悬浮微交互：中央大号半透明磨砂播放按钮 -->
                <div
                  class="absolute inset-0 flex items-center justify-center transition-all duration-300 pointer-events-none"
                >
                  <div
                    class="flex h-11 w-11 items-center justify-center rounded-full border border-white/40 bg-black/45 text-white shadow-xl backdrop-blur-md transition-transform"
                    :class="isBannerPlaying(item) ? 'scale-105' : 'opacity-85'"
                  >
                    <span
                      v-if="isBannerPlaying(item)"
                      class="icon-[mdi--pause] h-6 w-6 text-white"
                    />
                    <span
                      v-else
                      class="icon-[mdi--play] h-6 w-6 translate-x-0.5 text-white"
                    />
                  </div>
                </div>

                <!-- 左下角信息排版 -->
                <div class="pointer-events-none absolute bottom-3 left-3.5 z-10 max-w-[65%] space-y-1">
                  <h3 v-if="item.description" class="line-clamp-1 text-sm font-bold text-white drop-shadow">
                    {{ item.description }}
                  </h3>
                  <div class="flex items-center gap-1.5 text-[10px] text-white/80">
                    <span
                      v-if="item.targetType === 1"
                      class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 backdrop-blur-sm"
                    >
                      <span class="icon-[mdi--headphones] h-2.5 w-2.5 text-sky-300" />
                      {{ isBannerPlaying(item) ? t('home.bannerNowPlaying') : t('home.bannerQuickPlay') }}
                    </span>
                    <span
                      v-else-if="item.targetType === 10"
                      class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 backdrop-blur-sm"
                    >
                      <span class="icon-[mdi--album] h-2.5 w-2.5 text-amber-300" />
                      {{ t('home.bannerPlayAll') }}
                    </span>
                  </div>
                </div>

                <!-- 右下角特色角标 (贴合卡片边缘) -->
                <div class="pointer-events-none absolute right-0 bottom-0 z-10">
                  <div
                    class="inline-flex items-center gap-1 rounded-tl-xl px-2.5 py-1 text-[11px] font-semibold text-white shadow-md backdrop-blur-md bg-linear-to-r"
                    :class="getBannerTagMeta(item).gradientClass"
                  >
                    <span v-if="isBannerPlaying(item)" class="flex items-end gap-0.5 h-3 pb-0.5">
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-1" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-2" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-3" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-4" />
                    </span>
                    <span v-else :class="getBannerTagMeta(item).icon" class="h-3 w-3" />
                    <span>{{ isBannerPlaying(item) ? t('home.bannerNowPlaying') : getBannerTagMeta(item).text }}</span>
                  </div>
                </div>
              </div>
            </SwiperSlide>
          </Swiper>
        </section>

        <div v-if="hasSearchHistory" class="mb-6 px-4">
          <MusicRadarSection :compact="true" />
        </div>

        <section class="mb-6 px-4">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="section-title">
              <span
                class="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-blue-600"
              >
                <span class="icon-[mdi--playlist-star] text-primary h-4 w-4"></span>
              </span>
              {{ t('home.recommendPlaylists') }}
            </h2>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <router-link
              v-for="pl in playlists"
              :key="pl.id"
              :to="`/playlist/${pl.id}`"
              class="group"
            >
              <div class="playlist-cover relative mb-2 aspect-square overflow-hidden rounded-xl">
                <LazyImage
                  :src="formatCoverUrl(pl.coverImgUrl, { size: 200 })"
                  :alt="pl.name"
                  imgClass="h-full w-full object-cover transition-transform duration-300 group-active:scale-105"
                />
                <div
                  class="absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent"
                ></div>
                <div
                  class="bg-overlay/50 text-primary absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] backdrop-blur-sm"
                >
                  <span class="icon-[mdi--play] h-2.5 w-2.5"></span>
                  {{ formatCount(pl.playCount) }}
                </div>
                <div class="absolute right-1.5 bottom-1.5 left-1.5">
                  <div
                    class="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 shadow-md dark:bg-black/70"
                  >
                    <span class="icon-[mdi--play] h-3.5 w-3.5 text-sky-500"></span>
                  </div>
                </div>
              </div>
              <p class="playlist-name line-clamp-2 leading-tight">{{ pl.name }}</p>
            </router-link>
          </div>
        </section>

        <section v-if="artists.length" class="mb-6">
          <div class="mb-3 flex items-center justify-between px-4">
            <h2 class="section-title">
              <span
                class="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-blue-600"
              >
                <span class="icon-[mdi--account-music] text-primary h-4 w-4"></span>
              </span>
              {{ t('components.discover.hotArtists') }}
            </h2>
          </div>
          <div class="scrollbar-hide flex gap-3 overflow-x-auto px-4 pb-2">
            <router-link
              v-for="artist in artists"
              :key="artist.id"
              :to="`/artist/${artist.id}`"
              class="flex shrink-0 flex-col items-center"
            >
              <div class="artist-avatar relative mb-1.5 h-16 w-16 overflow-hidden rounded-full">
                <LazyImage
                  :src="formatCoverUrl(artist.picUrl, { size: 100, artist: artist.name })"
                  :alt="artist.name"
                  imgClass="h-full w-full object-cover"
                />
              </div>
              <span class="artist-name w-16 truncate text-center text-[11px]">{{
                artist.name
              }}</span>
            </router-link>
          </div>
        </section>

        <section class="mb-6 px-4">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="section-title">
              <span
                class="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-cyan-500 to-blue-600"
              >
                <span class="icon-[mdi--music-note-plus] text-primary h-4 w-4"></span>
              </span>
              {{ t('components.discover.newSongs') }}
            </h2>
          </div>
          <MobileSongList :songs="newSongs" variant="compact" :show-index="true" />
        </section>

        <section v-if="mvs.length" class="px-4 pb-6">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="section-title">
              <span
                class="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-cyan-500 to-blue-600"
              >
                <span class="icon-[mdi--video] text-primary h-4 w-4"></span>
              </span>
              {{ t('components.discover.recommendMv') }}
            </h2>
            <router-link to="/mv-list" class="view-more-link">
              {{ t('components.discover.viewMore') }}
              <span class="icon-[mdi--chevron-right] h-4 w-4"></span>
            </router-link>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <router-link v-for="mv in mvs" :key="mv.id" :to="`/mv-player/${mv.id}`" class="group">
              <div class="mv-cover relative aspect-video overflow-hidden rounded-xl">
                <LazyImage
                  :src="formatCoverUrl(mv.cover, { size: 320 })"
                  :alt="mv.name"
                  imgClass="h-full w-full object-cover transition-transform duration-300 group-active:scale-105"
                />
                <div
                  class="absolute inset-0 bg-linear-to-t from-black/70 via-transparent to-transparent"
                ></div>
                <div
                  class="bg-overlay/50 text-primary absolute top-2 right-2 flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] backdrop-blur-sm"
                >
                  <span class="icon-[mdi--play] h-2.5 w-2.5"></span>
                  {{ formatCount(mv.playCount ?? 0) }}
                </div>
                <div class="absolute inset-0 flex items-center justify-center">
                  <div
                    class="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm"
                  >
                    <span class="icon-[mdi--play] text-primary h-5 w-5"></span>
                  </div>
                </div>
                <div class="absolute right-0 bottom-0 left-0 p-2">
                  <p class="text-primary truncate text-xs font-medium">{{ mv.name }}</p>
                  <p class="text-primary/60 truncate text-[11px]">{{ mv.artist }}</p>
                </div>
              </div>
            </router-link>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.home-swiper :deep(.swiper-pagination) {
  bottom: 12px;
}

.home-swiper :deep(.swiper-pagination-bullet) {
  width: 6px;
  height: 6px;
  background: rgba(255, 255, 255, 0.4);
  opacity: 1;
  transition: all 0.3s;
}

.home-swiper :deep(.swiper-pagination-bullet-active) {
  background: white;
  width: 20px;
  border-radius: 3px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  font-weight: 700;
  color: var(--glass-text-primary);
}

.view-more-link {
  display: flex;
  align-items: center;
  min-height: 2.75rem;
  padding: 0 0.25rem;
  gap: 0.125rem;
  font-size: 0.75rem;
  color: var(--glass-text-primary);
  opacity: 0.5;
  transition: opacity 0.2s;
}

.view-more-link:active {
  opacity: 0.7;
}

.playlist-cover {
  box-shadow:
    0 10px 15px -3px rgba(0, 0, 0, 0.1),
    0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

:root.dark .playlist-cover,
html.dark .playlist-cover {
  box-shadow:
    0 10px 15px -3px rgba(0, 0, 0, 0.3),
    0 4px 6px -2px rgba(0, 0, 0, 0.2);
}

.playlist-name {
  color: var(--glass-text-primary);
  opacity: 0.8;
  font-size: 11px;
  line-height: 1.35;
}

.artist-avatar {
  box-shadow: 0 0 0 2px var(--glass-border-default);
}

:root.dark .artist-avatar,
html.dark .artist-avatar {
  box-shadow: 0 0 0 2px var(--glass-border-default);
}

.artist-name {
  color: var(--glass-text-primary);
  opacity: 0.7;
}

.song-item:not(.song-item-active):active {
  background: var(--glass-interactive-hover-muted);
}

.song-item-active {
  background: linear-gradient(to right, rgba(56,189,248, 0.2), rgba(37,99,235, 0.2));
}

:root.dark .song-item-active,
html.dark .song-item-active {
  background: linear-gradient(to right, rgba(56,189,248, 0.3), rgba(37,99,235, 0.3));
}

.song-index {
  color: var(--glass-text-primary);
  opacity: 0.3;
}

.song-cover {
  box-shadow:
    0 4px 6px -1px rgba(0, 0, 0, 0.1),
    0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

:root.dark .song-cover,
html.dark .song-cover {
  box-shadow:
    0 4px 6px -1px rgba(0, 0, 0, 0.3),
    0 2px 4px -1px rgba(0, 0, 0, 0.2);
}

.song-name {
  color: var(--glass-text-primary);
}

.song-artist {
  color: var(--glass-text-primary);
  opacity: 0.4;
}

.song-duration {
  color: var(--glass-text-primary);
  opacity: 0.3;
}

/* ── 跳动音频均衡器动画 (移动端海报正在播放指示器) ── */
@keyframes banner-eq-1 {
  0%, 100% { height: 3px; }
  50% { height: 11px; }
}
@keyframes banner-eq-2 {
  0%, 100% { height: 9px; }
  50% { height: 4px; }
}
@keyframes banner-eq-3 {
  0%, 100% { height: 4px; }
  50% { height: 12px; }
}
@keyframes banner-eq-4 {
  0%, 100% { height: 10px; }
  50% { height: 3px; }
}

.animate-equalizer-1 {
  animation: banner-eq-1 0.8s ease-in-out infinite;
}
.animate-equalizer-2 {
  animation: banner-eq-2 0.7s ease-in-out infinite 0.15s;
}
.animate-equalizer-3 {
  animation: banner-eq-3 0.9s ease-in-out infinite 0.3s;
}
.animate-equalizer-4 {
  animation: banner-eq-4 0.75s ease-in-out infinite 0.1s;
}

.mv-cover {
  box-shadow:
    0 10px 15px -3px rgba(0, 0, 0, 0.1),
    0 4px 6px -2px rgba(0, 0, 0, 0.05);
}

:root.dark .mv-cover,
html.dark .mv-cover {
  box-shadow:
    0 10px 15px -3px rgba(0, 0, 0, 0.3),
    0 4px 6px -2px rgba(0, 0, 0, 0.2);
}
</style>

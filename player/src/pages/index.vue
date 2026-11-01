<script setup lang="ts">
import {
  banner,
  topPlaylist,
  personalized,
  topSong,
  topArtists,
  personalizedMv,
  mvAll,
  playlistDetail,
  playlistTrackAll,
  albumDetail,
  search,
} from '@/api'
import { BRAND_PRODUCT } from '@/config/brand'
import { useI18n } from 'vue-i18n'
import { usePreferredReducedMotion } from '@vueuse/core'
import { Swiper, SwiperSlide } from 'swiper/vue'
import { Navigation, Pagination, Autoplay, EffectCoverflow } from 'swiper/modules'
import type SwiperClass from 'swiper'
import 'swiper/css'
import 'swiper/css/navigation'
import 'swiper/css/pagination'
import 'swiper/css/effect-coverflow'

import HeroCard from '@/components/Ui/HeroCard.vue'
import ArtistCard from '@/components/Ui/ArtistCard.vue'
import MVCard from '@/components/Ui/MVCard.vue'
import SongCard from '@/components/Ui/SongCard.vue'
import MusicRadarSection from '@/components/Recommend/MusicRadarSection.vue'
import { useGlobalStore } from '@/stores/modules/global'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useToastStore } from '@/stores/modules/toast'
import { fetchRecommendSimilar } from '@/api/recommend'
import { usePlayActions } from '@/composables/usePlayActions'
import {
  transformBanners,
  transformPlaylists,
  transformTopSongs,
  transformSongs,
  transformArtists,
  transformMVs,
  transformMVList,
  transformSearchSongs,
  extractArray,
  normalizeDurationMs,
  type BannerData,
  type PlaylistData,
  type SongData,
  type ArtistData,
  type MVData,
} from '@/utils/transformers'

import { useAudio } from '@/composables/useAudio'
import type { Song as StoreSong } from '@/stores/interface'

const { t } = useI18n()
const router = useRouter()
const { play, pause, resume, setPlaylist, currentSong, isPlaying } = useAudio()
const globalStore = useGlobalStore()
const recommendStore = useRecommendStore()
const toastStore = useToastStore()
const hasSearchHistory = computed(() => (globalStore.searchHistory?.length || 0) > 0)

const state = reactive({
  banners: [] as BannerData[],
  recommendPlaylists: [] as PlaylistData[],
  hotSongs: [] as SongData[],
  artists: [] as ArtistData[],
  mvs: [] as MVData[],
  isLoading: true,
  swiper: null as SwiperClass | null,
})

const { banners, recommendPlaylists, hotSongs, artists, mvs, isLoading } = toRefs(state)

const loadData = async () => {
  state.isLoading = true
  try {
    const [bRes, pRes, sRes, aRes, mRes] = await Promise.allSettled([
      banner({ type: 0 }),
      topPlaylist({ order: 'hot', limit: 24 }),
      topSong({ type: 0 }),
      topArtists({ limit: 16 }),
      personalizedMv({ limit: 12 }),
    ])

    if (bRes.status === 'fulfilled' && bRes.value) {
      state.banners = transformBanners(bRes.value as Record<string, unknown>, 6)
    }

    // 推荐歌单：填满 4*6 = 24 项，避免出现留白
    if (pRes.status === 'fulfilled' && pRes.value) {
      let playlists = transformPlaylists(
        pRes.value as Record<string, unknown>,
        24,
        t('home.playlistFallback')
      )
      if (playlists.length < 24) {
        try {
          const fallbackRes: any = await personalized({ limit: 24 })
          const fallbackList = transformPlaylists(fallbackRes, 24, t('home.playlistFallback'))
          const existingIds = new Set(playlists.map(p => p.id))
          for (const item of fallbackList) {
            if (!existingIds.has(item.id)) {
              playlists.push(item)
              existingIds.add(item.id)
            }
            if (playlists.length >= 24) break
          }
        } catch {}
      }
      state.recommendPlaylists = playlists.slice(0, 24)
    } else {
      try {
        const fallbackRes: any = await personalized({ limit: 24 })
        state.recommendPlaylists = transformPlaylists(
          fallbackRes,
          24,
          t('home.playlistFallback')
        ).slice(0, 24)
      } catch {}
    }

    if (sRes.status === 'fulfilled' && sRes.value) {
      state.hotSongs = transformTopSongs(sRes.value as Record<string, unknown>, 12)
    }
    if (aRes.status === 'fulfilled' && aRes.value) {
      state.artists = transformArtists(aRes.value as Record<string, unknown>, 16)
    }

    // 推荐MV：保证至少 2 行完整（6列下至少 12 个，无缺漏留白）
    let mvList: MVData[] = []
    if (mRes.status === 'fulfilled' && mRes.value) {
      mvList = transformMVs(mRes.value as Record<string, unknown>, 12)
    }
    if (mvList.length < 12) {
      try {
        const fallbackMvRes: any = await mvAll({ limit: 12, order: '最新' })
        const fallbackMvs = transformMVList(fallbackMvRes, 12)
        const existingIds = new Set(mvList.map(item => item.id))
        for (const item of fallbackMvs) {
          if (!existingIds.has(item.id)) {
            mvList.push(item)
            existingIds.add(item.id)
          }
          if (mvList.length >= 12) break
        }
      } catch (e) {
        console.warn('Failed to supplement MVs via mvAll:', e)
      }
    }
    state.mvs = mvList.slice(0, 12)
  } finally {
    state.isLoading = false
  }
}

const { playAll } = usePlayActions()
const activePlayingPlaylistId = ref<number | string | null>(null)
const loadingPlaylistId = ref<number | string | null>(null)

const handlePlayPlaylist = async (item: PlaylistData) => {
  if (loadingPlaylistId.value) return
  loadingPlaylistId.value = item.id
  try {
    const [detailRes, tracksRes] = await Promise.allSettled([
      playlistDetail({ id: Number(item.id) }),
      playlistTrackAll({ id: Number(item.id), limit: 50, offset: 0 }),
    ])
    let songs: SongData[] = []
    if (tracksRes.status === 'fulfilled' && tracksRes.value) {
      songs = transformSongs(tracksRes.value as Record<string, unknown>)
    }
    if ((!songs || songs.length === 0) && detailRes.status === 'fulfilled' && detailRes.value) {
      songs = transformSongs(detailRes.value as Record<string, unknown>)
    }
    if (songs && songs.length > 0) {
      playAll(songs)
      activePlayingPlaylistId.value = item.id
    }
  } catch (err) {
    console.warn('Failed to play playlist directly:', err)
  } finally {
    loadingPlaylistId.value = null
  }
}

const reducedMotion = usePreferredReducedMotion()
const prefersReduced = computed(() => reducedMotion.value === 'reduce')
const autoplayPaused = ref(false)
const hoverPaused = ref(false)

const activeBannerIndex = ref(0)
const onSlideChange = (sw: SwiperClass) => {
  activeBannerIndex.value = sw.realIndex ?? 0
}
const activeBanner = computed(() => state.banners[activeBannerIndex.value] || state.banners[0])

const slidePrev = () => {
  state.swiper?.slidePrev()
}
const slideNext = () => {
  state.swiper?.slideNext()
}

const syncAutoplay = () => {
  const swiper = state.swiper
  if (!swiper?.autoplay) return
  if (prefersReduced.value || autoplayPaused.value || hoverPaused.value) {
    swiper.autoplay.stop()
  } else {
    swiper.autoplay.start()
  }
}

const onSwiper = (sw: SwiperClass) => {
  state.swiper = sw
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

const handlePlayAlbumDirectly = async (albumId: number | string, albumTitle?: string) => {
  try {
    const res = await albumDetail({ id: Number(albumId) })
    const songs = extractArray(res as Record<string, unknown>, 'songs', 'data.songs')
    let list: SongData[] = songs.map((s: any) => ({
      id: s?.id || 0,
      name: s?.name || '',
      artist: Array.isArray(s?.ar)
        ? s.ar.map((a: any) => a.name).join(' / ')
        : Array.isArray(s?.artists)
          ? s.artists.map((a: any) => a.name).join(' / ')
          : '',
      album: s?.al?.name || s?.album?.name || albumTitle || '',
      albumId: s?.al?.id ?? s?.album?.id ?? Number(albumId),
      duration: normalizeDurationMs(s?.dt ?? s?.duration ?? 0),
      cover: s?.al?.picUrl || s?.album?.picUrl || '',
      liked: false,
    }))

    // 若曲目列表为空且有专辑名称，执行容错搜索补齐
    if (list.length === 0 && albumTitle) {
      try {
        const fallbackRes = await search({
          keywords: albumTitle,
          type: 1,
          limit: 20,
        })
        const searchSongs = transformSearchSongs(fallbackRes as Record<string, unknown>).songs
        if (searchSongs.length > 0) {
          list = searchSongs
        }
      } catch (e) {
        console.warn('[Banner] Album fallback search failed:', e)
      }
    }

    if (list.length > 0) {
      playAll(list)
      toastStore.show({
        message: t('home.bannerPlayingAlbum', { title: albumTitle || list[0].album }),
        type: 'success',
      })
    }
  } catch (err) {
    console.warn('[Banner] Failed to play album directly:', err)
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
      console.warn('[Banner] Auto enrich queue warning:', err)
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
    await handlePlayAlbumDirectly(item.targetId, item.description || item.title)
    return
  }

  if (item.targetType === 1000 && item.targetId) {
    await handlePlayPlaylist({
      id: item.targetId,
      name: item.description || item.title,
      coverImgUrl: item.coverImgUrl,
      playCount: 0,
      trackCount: 0,
    })
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

const swiperModules = [Navigation, Pagination, Autoplay, EffectCoverflow]

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="flex-1 overflow-hidden">
    <div class="custom-scrollbar h-full overflow-y-auto">
      <HomeSkeleton v-if="isLoading" />
      <div v-else class="space-y-10 p-5 pb-8">
        <!-- ═══════ Banner 轮播 (学习网易云: 动态氛围流光 + 特色角标 + 悬停试听 + 播放音波联动) ═══════ -->
        <section
          v-if="banners.length"
          v-scroll-in="{ direction: 'up', duration: 0.8 }"
          class="group/section relative max-h-[50vh]"
          @mouseenter="pauseForInteraction"
          @mouseleave="resumeAfterInteraction"
          @focusin="pauseForInteraction"
          @focusout="resumeAfterInteraction"
        >
          <!-- 动态海报氛围光晕背景 (提取当前活动海报色彩向四周弥散) -->
          <div
            class="pointer-events-none absolute -inset-6 -z-10 overflow-hidden rounded-3xl opacity-35 blur-3xl transition-opacity duration-700 ease-out"
            aria-hidden="true"
          >
            <img
              v-if="activeBanner?.coverImgUrl"
              :src="activeBanner.coverImgUrl"
              class="h-full w-full object-cover scale-125 filter transition-all duration-700 ease-out"
              alt=""
            />
          </div>

          <!-- 自动轮播暂停/继续控制按钮 -->
          <button
            type="button"
            class="absolute top-3 right-3 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-glass bg-[var(--glass-bg-overlay)] text-primary shadow-lg backdrop-blur-md transition-all hover:bg-[var(--glass-interactive-hover)] hover:scale-105 focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:outline-none"
            :aria-label="autoplayPaused ? t('home.playCarousel') : t('home.pauseCarousel')"
            :title="autoplayPaused ? t('home.playCarousel') : t('home.pauseCarousel')"
            @click="toggleAutoplay"
          >
            <span :class="autoplayPaused ? 'icon-[mdi--play]' : 'icon-[mdi--pause]'" class="h-5 w-5"></span>
          </button>

          <!-- 左右快速翻页箭头 (桌面端悬浮显现) -->
          <button
            type="button"
            class="absolute left-2 top-1/2 z-20 -translate-y-1/2 hidden lg:flex h-10 w-10 items-center justify-center rounded-full border border-glass bg-[var(--glass-bg-overlay)] text-primary opacity-0 shadow-lg backdrop-blur-md transition-all duration-300 hover:bg-[var(--glass-interactive-hover)] hover:scale-110 group-hover/section:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            :aria-label="t('common.back')"
            @click="slidePrev"
          >
            <span class="icon-[mdi--chevron-left] h-6 w-6"></span>
          </button>
          <button
            type="button"
            class="absolute right-2 top-1/2 z-20 -translate-y-1/2 hidden lg:flex h-10 w-10 items-center justify-center rounded-full border border-glass bg-[var(--glass-bg-overlay)] text-primary opacity-0 shadow-lg backdrop-blur-md transition-all duration-300 hover:bg-[var(--glass-interactive-hover)] hover:scale-110 group-hover/section:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
            :aria-label="t('common.forward')"
            @click="slideNext"
          >
            <span class="icon-[mdi--chevron-right] h-6 w-6"></span>
          </button>

          <Swiper
            @swiper="onSwiper"
            @slideChange="onSlideChange"
            :modules="swiperModules"
            :slides-per-view="1"
            :space-between="20"
            :centered-slides="true"
            :loop="true"
            :speed="prefersReduced ? 0 : 350"
            :autoplay="prefersReduced ? false : { delay: 5000, disableOnInteraction: false }"
            :pagination="{ clickable: true, el: '.home-pagination' }"
            :breakpoints="{
              640: { slidesPerView: 1.15 },
              1024: { slidesPerView: 1.4 },
              1280: { slidesPerView: 1.7 },
            }"
            class="home-swiper overflow-hidden rounded-2xl"
          >
            <SwiperSlide v-for="(item, idx) in banners" :key="idx">
              <div
                role="button"
                tabindex="0"
                @click="handleBannerClick(item)"
                @keydown.enter="handleBannerClick(item)"
                class="group relative block aspect-[1080/400] max-h-[46vh] cursor-pointer overflow-hidden rounded-2xl select-none shadow-xl transition-shadow duration-300 hover:shadow-2xl"
              >
                <!-- 海报封面原图 -->
                <LazyImage
                  :src="item.coverImgUrl"
                  alt="banner"
                  img-class="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
                />

                <!-- 渐变暗角遮罩 (从底部往上渐变，确保文字与按钮通透可读) -->
                <div class="absolute inset-0 bg-linear-to-t from-black/85 via-black/25 to-transparent opacity-85 transition-opacity duration-300 group-hover:opacity-95" />

                <!-- 悬浮微交互：中央大号半透明磨砂播放按钮 -->
                <div
                  class="absolute inset-0 flex items-center justify-center transition-all duration-300"
                  :class="isBannerPlaying(item) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
                >
                  <button
                    type="button"
                    class="flex h-14 w-14 items-center justify-center rounded-full border border-white/40 bg-black/45 text-white shadow-2xl backdrop-blur-xl transition-all duration-300 hover:scale-115 hover:bg-black/65 hover:border-white/70 active:scale-95 focus-visible:outline-none"
                    :aria-label="isBannerPlaying(item) ? t('player.pause') : t('player.play')"
                    @click.stop="handlePlayBannerDirectly(item, $event)"
                  >
                    <span
                      v-if="isBannerPlaying(item)"
                      class="icon-[mdi--pause] h-7 w-7 text-white drop-shadow"
                    />
                    <span
                      v-else
                      class="icon-[mdi--play] h-7 w-7 translate-x-0.5 text-white drop-shadow"
                    />
                  </button>
                </div>

                <!-- 左下角信息排版：标题 + 副标题/类型快捷提示 -->
                <div class="pointer-events-none absolute bottom-4 left-5 z-10 max-w-[70%] space-y-1.5">
                  <div v-if="item.description">
                    <h3 class="line-clamp-1 text-base font-bold tracking-tight text-white drop-shadow-md sm:text-lg lg:text-xl">
                      {{ item.description }}
                    </h3>
                  </div>
                  <div class="flex items-center gap-2 text-xs text-white/80 drop-shadow">
                    <span
                      v-if="item.targetType === 1"
                      class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-md"
                    >
                      <span class="icon-[mdi--headphones] h-3 w-3 text-sky-300" />
                      {{ isBannerPlaying(item) ? t('home.bannerNowPlaying') : t('home.bannerQuickPlay') }}
                    </span>
                    <span
                      v-else-if="item.targetType === 10"
                      class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-md"
                    >
                      <span class="icon-[mdi--album] h-3 w-3 text-amber-300" />
                      {{ t('home.bannerPlayAll') }}
                    </span>
                  </div>
                </div>

                <!-- 右下角特色角标 (贴合卡片边缘的网易云标志性风格，带动态均衡器音波) -->
                <div class="pointer-events-none absolute right-0 bottom-0 z-10">
                  <div
                    class="inline-flex items-center gap-1.5 rounded-tl-xl px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-md bg-linear-to-r"
                    :class="getBannerTagMeta(item).gradientClass"
                  >
                    <!-- 若正在热播当前单曲，呈现律动均衡器动画 -->
                    <span v-if="isBannerPlaying(item)" class="flex items-end gap-0.5 h-3.5 pb-0.5">
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-1" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-2" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-3" />
                      <span class="w-0.5 bg-white rounded-full animate-equalizer-4" />
                    </span>
                    <span v-else :class="getBannerTagMeta(item).icon" class="h-3.5 w-3.5" />
                    <span>{{ isBannerPlaying(item) ? t('home.bannerNowPlaying') : getBannerTagMeta(item).text }}</span>
                  </div>
                </div>
              </div>
            </SwiperSlide>
          </Swiper>
          <div class="home-pagination mt-4 flex justify-center gap-1.5"></div>
        </section>

        <!-- ═══════ 音乐雷达 (用户真实检索后呈现，学习热门单曲排版) ═══════ -->
        <MusicRadarSection v-if="hasSearchHistory" class="mb-10" />

        <!-- ═══════ 推荐歌单 ═══════ -->
        <section v-if="recommendPlaylists.length" v-scroll-in="{ direction: 'up', delay: 0.1 }">
          <div class="mb-6 flex items-baseline justify-between">
            <h2 class="text-primary flex items-center gap-2.5 text-xl font-bold tracking-tight">
              <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-blue-600">
                <span class="icon-[mdi--playlist-star] h-5 w-5 text-white"></span>
              </span>
              {{ t('home.recommendPlaylists') }}
            </h2>
          </div>
          <div
            v-scroll-in="{ stagger: true, staggerDelay: 0.04 }"
            class="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
          >
            <HeroCard
              v-for="item in recommendPlaylists"
              :key="item.id"
              :id="item.id"
              :cover-url="item.coverImgUrl"
              :title="item.name"
              :play-count="item.playCount"
              :track-count="item.trackCount"
              :to="`/playlist/${item.id}`"
              :is-playing="activePlayingPlaylistId === item.id && isPlaying"
              :is-loading="loadingPlaylistId === item.id"
              class="stagger-item"
              @play="handlePlayPlaylist(item)"
            />
          </div>
        </section>

        <!-- ═══════ 热门歌手 ═══════ -->
        <section v-if="artists.length" v-scroll-in="{ direction: 'up', delay: 0.1 }">
          <div class="mb-6 flex items-baseline justify-between">
            <h2 class="text-primary flex items-center gap-2.5 text-xl font-bold tracking-tight">
              <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-blue-600">
                <span class="icon-[mdi--account-music] h-5 w-5 text-white"></span>
              </span>
              {{ t('components.discover.hotArtists') }}
            </h2>
            <router-link
              v-magnetic="{ strength: 0.3, distance: 60 }"
              to="/artists"
              class="text-primary/40 hover:text-primary/70 flex min-h-11 items-center gap-1 text-[13px] font-medium transition-all duration-200 hover:gap-1.5"
            >
              {{ t('common.viewAll') }}
              <span class="icon-[mdi--chevron-right] h-4 w-4" />
            </router-link>
          </div>
          <div
            v-scroll-in="{ stagger: true, staggerDelay: 0.03 }"
            class="grid grid-cols-4 gap-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 xl:grid-cols-12"
          >
            <ArtistCard
              v-for="artist in artists.slice(0, 12)"
              :key="artist.id"
              :id="artist.id"
              :name="artist.name"
              :pic-url="artist.picUrl"
              :to="`/artist/${artist.id}`"
              class="stagger-item"
            />
          </div>
        </section>

        <!-- ═══════ 热门歌曲 ═══════ -->
        <section v-if="hotSongs.length" v-scroll-in="{ direction: 'up', delay: 0.1 }">
          <div class="mb-6 flex items-baseline justify-between">
            <h2 class="text-primary flex items-center gap-2.5 text-xl font-bold tracking-tight">
              <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-cyan-500 to-blue-600">
                <span class="icon-[mdi--music-note-plus] h-5 w-5 text-white"></span>
              </span>
              {{ t('home.hotSongs') }}
            </h2>
            <router-link
              v-magnetic="{ strength: 0.3, distance: 60 }"
              to="/charts"
              class="text-primary/40 hover:text-primary/70 flex min-h-11 items-center gap-1 text-[13px] font-medium transition-all duration-200 hover:gap-1.5"
            >
              {{ t('common.viewAll') }}
              <span class="icon-[mdi--chevron-right] h-4 w-4" />
            </router-link>
          </div>
          <div class="songs-container overflow-hidden rounded-2xl">
            <div
              v-scroll-in="{ stagger: true, staggerDelay: 0.03, distance: 20 }"
              class="grid md:grid-cols-2"
            >
              <SongCard
                v-for="(song, idx) in hotSongs"
                :key="song.id"
                :song="song"
                :index="idx"
                :to="`/song/${song.id}`"
                class="stagger-item song-divider"
              />
            </div>
          </div>
        </section>

        <!-- ═══════ 推荐MV ═══════ -->
        <section v-if="mvs.length" v-scroll-in="{ direction: 'up', delay: 0.1 }">
          <div class="mb-6 flex items-baseline justify-between">
            <h2 class="text-primary flex items-center gap-2.5 text-xl font-bold tracking-tight">
              <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-cyan-500 to-blue-600">
                <span class="icon-[mdi--video] h-5 w-5 text-white"></span>
              </span>
              {{ t('components.discover.recommendMv') }}
            </h2>
            <router-link
              v-magnetic="{ strength: 0.3, distance: 60 }"
              to="/mv-list"
              class="text-primary/40 hover:text-primary/70 flex min-h-11 items-center gap-1 text-[13px] font-medium transition-all duration-200 hover:gap-1.5"
            >
              {{ t('common.viewAll') }}
              <span class="icon-[mdi--chevron-right] h-4 w-4" />
            </router-link>
          </div>
          <div
            v-scroll-in="{ stagger: true, staggerDelay: 0.06 }"
            class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
          >
            <MVCard
              v-for="mv in mvs"
              :key="mv.id"
              :id="mv.id"
              :name="mv.name"
              :artist="mv.artist"
              :cover="mv.cover"
              :play-count="mv.playCount as number"
              :to="`/mv-player/${mv.id}`"
              class="stagger-item"
            />
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "../style/tailwind.css";

/* ── 3D 聚光灯层叠卡片过渡 (学习网易云 Coverflow 视觉重点) ── */
.home-swiper :deep(.swiper-slide) {
  transform: scale(0.93);
  opacity: 0.65;
  transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform, opacity;
}

.home-swiper :deep(.swiper-slide-active) {
  transform: scale(1);
  opacity: 1;
  z-index: 10;
}

/* ── 跳动音频均衡器动画 (正在播放指示器) ── */
@keyframes banner-eq-1 {
  0%, 100% { height: 4px; }
  50% { height: 13px; }
}
@keyframes banner-eq-2 {
  0%, 100% { height: 11px; }
  50% { height: 5px; }
}
@keyframes banner-eq-3 {
  0%, 100% { height: 5px; }
  50% { height: 14px; }
}
@keyframes banner-eq-4 {
  0%, 100% { height: 12px; }
  50% { height: 4px; }
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

/* ── 轮播图分页指示器 ── */
.home-pagination :deep(.swiper-pagination-bullet) {
  width: 6px;
  height: 6px;
  background: var(--glass-text-primary);
  opacity: 0.2;
  border-radius: 9999px;
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.home-pagination :deep(.swiper-pagination-bullet-active) {
  width: 20px;
  opacity: 0.6;
  border-radius: 3px;
}

/* ── 歌曲列表容器 ── */
.songs-container {
  background: transparent;
  border: none;
}

/* ── 歌曲分隔线 ── */
.song-divider {
  border-bottom: 1px solid var(--glass-border-subtle);
}

.song-divider:last-child,
.song-divider:nth-last-child(2):nth-child(odd) {
  border-bottom: none;
}

@media (min-width: 768px) {
  .song-divider:nth-last-child(1),
  .song-divider:nth-last-child(2):nth-child(odd) {
    border-bottom: none;
  }
}
</style>

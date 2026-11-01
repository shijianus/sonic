<script setup lang="ts">
import { mvAll, mvDetail } from '@/api'
import LazyImage from '@/components/Ui/LazyImage.vue'
import TabGroup from '@/components/Ui/TabGroup.vue'
import PageSkeleton from '@/components/PageSkeleton.vue'
import { formatCount, formatRelativeTimeYT } from '@/utils/time'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const state = reactive({
  loading: true,
  categories: [
    { key: 'all', labelKey: 'mvList.categories.all', icon: 'icon-[mdi--movie-open]', type: undefined },
    { key: 'latest', labelKey: 'mvList.categories.latest', icon: 'icon-[mdi--sparkles]', type: '最新' },
    { key: 'official', labelKey: 'mvList.categories.official', icon: 'icon-[mdi--crown]', type: '官方版' },
    { key: 'live', labelKey: 'mvList.categories.live', icon: 'icon-[mdi--microphone-variant]', type: '现场版' },
    { key: 'netease', labelKey: 'mvList.categories.netease', icon: 'icon-[mdi--music-note]', type: '网易出品' },
  ],
  selectedCategoryKey: 'all',
  list: [] as Array<{
    id: number
    name: string
    artist: string
    cover: string
    duration: number
    playCount: string | number
    tag: string
    publishTime?: string
    desc?: string
    briefDesc?: string
  }>,
})

const selectCategory = (key: string) => {
  state.selectedCategoryKey = key
  load()
}

const formatSec = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`

const load = async () => {
  state.loading = true
  try {
    const type = state.categories.find(c => c.key === state.selectedCategoryKey)?.type
    const res: any = await mvAll({ type, order: '最新', limit: 20 })
    const rawList: any[] = res?.data || res?.mvs || res?.result || []
    state.list = rawList.map(it => {
      let itemTag = it?.tag || ''
      if (!itemTag) {
        if (state.selectedCategoryKey === 'live') itemTag = '现场版'
        else if (state.selectedCategoryKey === 'official') itemTag = '官方版'
        else if (state.selectedCategoryKey === 'netease') itemTag = 'Sonic 甄选'
        else if (state.selectedCategoryKey === 'latest') itemTag = '最新'
        else {
          const n = it?.name || it?.title || ''
          if (n.includes('现场') || n.includes('Live') || n.includes('LIVE')) itemTag = '现场版'
          else if (n.includes('官方') || n.includes('Official')) itemTag = '官方版'
          else if (it?.new) itemTag = '最新'
          else itemTag = '精选'
        }
      }
      return {
        id: Number(it?.id),
        name: it?.name || it?.title || '',
        artist: it?.artistName || it?.artists?.[0]?.name || '',
        cover: it?.cover || it?.coverImg || it?.picUrl || '',
        duration: Math.floor((it?.duration || 0) / 1000),
        playCount: it?.playCount || 0,
        tag: itemTag,
        publishTime: it?.publishTime || '',
        desc: it?.desc || '',
        briefDesc: it?.briefDesc || '',
      }
    })

    // 静默补充详情
    state.list.forEach(async item => {
      if (!item.publishTime || !item.desc) {
        try {
          const dRes: any = await mvDetail({ mvid: item.id })
          const d = dRes?.data
          if (d?.publishTime && !item.publishTime) item.publishTime = d.publishTime
          if (d?.desc && !item.desc) item.desc = d.desc
          if (d?.briefDesc && !item.briefDesc) item.briefDesc = d.briefDesc
        } catch {}
      }
    })
  } finally {
    state.loading = false
  }
}

onMounted(load)
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <!-- 头部分类栏 -->
    <div class="sticky top-0 z-20 -mx-3 mb-3 bg-linear-to-b from-background via-background/95 to-transparent px-3 py-2 backdrop-blur-md">
      <div class="overflow-x-auto no-scrollbar">
        <TabGroup
          v-model="state.selectedCategoryKey"
          :tabs="state.categories"
          variant="gradient"
          size="sm"
          :show-count="false"
          @click="selectCategory"
        />
      </div>
    </div>

    <div v-if="state.loading" class="py-6"><PageSkeleton :sections="['list']" :list-count="8" /></div>
    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <router-link v-for="m in state.list" :key="m.id" :to="`/mv-player/${m.id}`" class="group block">
        <div class="glass-card flex flex-col overflow-hidden rounded-2xl transition-all duration-300">
          <div class="relative aspect-video w-full overflow-hidden rounded-t-xl bg-black/40">
            <LazyImage
              :src="formatCoverUrl(m.cover, { size: 480 })"
              :alt="m.name || t('mvList.alt.cover')"
              imgClass="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              wrapperClass="h-full w-full"
            />
            <div class="pointer-events-none absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent" />
            <div v-if="m.tag" class="absolute top-2 left-2 z-10">
              <span class="inline-flex items-center gap-1 rounded-md bg-black/65 px-2 py-0.5 text-[10px] font-semibold text-sky-300 backdrop-blur-md border border-glass shadow-sm">
                <span class="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
                {{ m.tag }}
              </span>
            </div>
            <span
              v-if="m.duration > 0"
              class="absolute right-2 bottom-2 z-10 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-medium text-sky-100 backdrop-blur-md"
            >
              {{ formatSec(m.duration) }}
            </span>
          </div>

          <div class="flex flex-1 flex-col p-3">
            <h3 class="text-primary line-clamp-1 text-sm font-semibold tracking-tight transition-colors group-hover:text-sky-400">
              {{ m.name }}
            </h3>
            <p class="text-primary/70 line-clamp-2 my-1 text-xs leading-relaxed min-h-[2.4em]">
              {{ m.desc || m.briefDesc || (m.artist ? `${m.artist} 精彩音乐视频作品` : '点击在线播放完整视频') }}
            </p>
            <div class="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-primary/60">
              <span class="truncate font-medium text-primary/80 max-w-[120px]">{{ m.artist }}</span>
              <span class="text-primary/30">•</span>
              <span class="shrink-0">{{ formatCount(m.playCount) }}次观看</span>
              <template v-if="m.publishTime">
                <span class="text-primary/30">•</span>
                <span class="shrink-0">{{ formatRelativeTimeYT(m.publishTime) }}</span>
              </template>
            </div>
          </div>
        </div>
      </router-link>
    </div>
  </div>
</template>

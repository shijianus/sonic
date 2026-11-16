<script setup lang="ts">
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatCoverUrl } from '@/utils/imageUrl'

interface Props {
  id: number | string
  name: string
  picUrl: string
  to: string
}

const props = defineProps<Props>()
const router = useRouter()
const resolvedHref = computed(() => router.resolve(props.to).href)

// 即时路由跳转，去除阻塞式共享元素飞入覆盖层
const handleClick = (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  router.push(props.to)
}
</script>

<template>
  <a
    :href="resolvedHref"
    class="group flex min-w-11 cursor-pointer flex-col items-center rounded-2xl outline-none transition-transform duration-150 ease-out active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-sky-400/70"
    @click="handleClick"
  >
    <div
      class="border-glass relative mb-2.5 aspect-square w-full overflow-hidden rounded-full border-2 shadow-lg transition-[border-color,transform] duration-200 ease-out group-hover:scale-105 group-hover:border-[#2563eb]"
    >
      <LazyImage
        :src="formatCoverUrl(picUrl, { size: 150, artist: name })"
        :fallback-src="formatCoverUrl('', { artist: name })"
        :alt="name"
        img-class="h-full w-full object-cover"
      />
      <div
        class="artist-hover-play absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-[opacity,background-color] duration-150 group-hover:bg-black/35 group-hover:opacity-100"
      >
        <span
          class="icon-[mdi--play] h-6 w-6 scale-75 text-white transition-transform duration-150 group-hover:scale-100"
        />
      </div>
    </div>
    <span
      class="text-primary/70 group-hover:text-primary w-full truncate text-center text-xs transition-colors duration-150"
    >
      {{ name }}
    </span>
  </a>
</template>

<style scoped>
@media (hover: none) {
  .artist-hover-play {
    opacity: 1;
  }
}
</style>

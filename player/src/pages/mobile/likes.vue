<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useAudio } from '@/composables/useAudio'
import Button from '@/components/Ui/Button.vue'
import LazyImage from '@/components/Ui/LazyImage.vue'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useLibraryStore } from '@/stores/modules/library'
import { formatDate } from '@/utils/time'

const { setPlaylist, play } = useAudio()
const libraryStore = useLibraryStore()

interface FavoriteItem {
  id: string | number
  name: string
  subtitle?: string
  cover?: string
  savedAt: number
  to?: string
}

interface FavoriteGroup {
  key: 'song' | 'playlist' | 'mv'
  icon: string
  removeLabel: 'common.unlike' | 'common.uncollect'
  remove: (id: FavoriteItem['id']) => void
  items: FavoriteItem[]
}

const groups = computed(() => {
  const favorites: FavoriteGroup[] = [
    {
      key: 'song',
      icon: 'icon-[mdi--music]',
      removeLabel: 'common.unlike',
      remove: libraryStore.removeLikedSong,
      items: libraryStore.likedSongs.map(song => ({
        id: song.id,
        name: song.name,
        subtitle: song.artist,
        cover: song.cover,
        savedAt: song.likedAt,
      })),
    },
    {
      key: 'playlist',
      icon: 'icon-[mdi--playlist-music]',
      removeLabel: 'common.uncollect',
      remove: libraryStore.removeCollectedPlaylist,
      items: libraryStore.collectedPlaylists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        subtitle: playlist.creator,
        cover: playlist.coverImgUrl,
        savedAt: playlist.collectedAt,
        to: `/playlist/${encodeURIComponent(playlist.id)}`,
      })),
    },
    {
      key: 'mv',
      icon: 'icon-[mdi--video]',
      removeLabel: 'common.unlike',
      remove: libraryStore.removeLikedMv,
      items: libraryStore.likedMvs.map(mv => ({
        id: mv.id,
        name: mv.name,
        subtitle: mv.artist,
        cover: mv.cover,
        savedAt: mv.likedAt,
        to: `/mv-player/${encodeURIComponent(mv.id)}`,
      })),
    },
  ]
  return favorites.filter(group => group.items.length > 0)
})

const playSong = (id: FavoriteItem['id']) => {
  const songs = libraryStore.toPlayableSongs()
  const index = songs.findIndex(song => String(song.id) === String(id))
  if (index >= 0) {
    setPlaylist(songs, index)
    play(songs[index], index)
  }
}
</script>

<template>
  <div class="flex-1 overflow-auto px-3 pb-6">
    <h1 class="mb-3 px-1 text-lg font-semibold text-primary">{{ $t('likes.title') }}</h1>
    <p v-if="!groups.length" class="py-10 text-center text-sm text-primary/70">
      {{ $t('likes.emptyAll') }}
    </p>
    <div v-else class="space-y-5">
      <section v-for="group in groups" :key="group.key" :aria-labelledby="`favorites-${group.key}`">
        <h2 :id="`favorites-${group.key}`" class="mb-2 px-1 text-sm font-semibold text-primary">
          {{ $t(`likes.tabs.${group.key}`) }}
        </h2>
        <ul class="space-y-2">
          <li
            v-for="item in group.items"
            :key="item.id"
            class="glass-card flex items-center gap-1 p-2"
          >
            <component
              :is="item.to ? RouterLink : 'button'"
              :to="item.to"
              :type="item.to ? undefined : 'button'"
              class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-1 py-1 text-left transition-colors hover:bg-hover-glass focus-visible:ring-2 focus-visible:ring-sky-500"
              :aria-label="item.to ? item.name : `${$t('actions.play')} · ${item.name}`"
              @click="!item.to && playSong(item.id)"
            >
              <div class="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                <LazyImage
                  v-if="item.cover"
                  :src="formatCoverUrl(item.cover, { size: 200 })"
                  imgClass="h-full w-full object-cover"
                />
                <div v-else class="glass-button flex h-full w-full items-center justify-center">
                  <span :class="group.icon" class="h-5 w-5" aria-hidden="true"></span>
                </div>
              </div>
              <div class="min-w-0 flex-1 wrap-anywhere">
                <p class="text-sm font-medium text-primary">{{ item.name }}</p>
                <p v-if="item.subtitle" class="text-xs text-secondary">{{ item.subtitle }}</p>
                <p class="text-[11px] text-secondary">{{ formatDate(item.savedAt) }}</p>
              </div>
            </component>
            <Button
              variant="ghost"
              size="icon-sm"
              rounded="full"
              class="shrink-0 hover:text-red-400 focus-visible:ring-2 focus-visible:ring-sky-500"
              :aria-label="`${$t(group.removeLabel)} · ${item.name}`"
              @click="group.remove(item.id)"
            >
              <span class="icon-[mdi--heart-off-outline] h-5 w-5" aria-hidden="true"></span>
            </Button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

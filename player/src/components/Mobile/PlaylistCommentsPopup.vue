<script setup lang="ts">
import MobileDrawer from './MobileDrawer.vue'
import { commentMusic, commentPlaylist } from '@/api'
import { useI18n } from 'vue-i18n'
import PageSkeleton from '@/components/PageSkeleton.vue'
import LazyImage from '@/components/Ui/LazyImage.vue'
import Button from '@/components/Ui/Button.vue'
import { formatDate, formatNumber } from '@/utils/time'
import Pagination from '@/components/Ui/Pagination.vue'
import { formatCoverUrl } from '@/utils/imageUrl'
import { useAuthStore } from '@/stores/modules/auth'
import { useToastStore } from '@/stores/modules/toast'

const { t } = useI18n()
const authStore = useAuthStore()
const toastStore = useToastStore()

const props = withDefaults(defineProps<{
  id: number | string | null | undefined
  type?: 'music' | 'playlist'
}>(), {
  type: 'music'
})

const isOpen = defineModel<boolean>('show', { default: false })

const state = reactive({
  loading: false,
  total: 0,
  comments: [] as Array<any>,
  page: 1,
  limit: 20,
})

const handleCommentAction = () => {
  if (!authStore.isAuthenticated) {
    toastStore.show({
      message: t('comments.pleaseLoginEpomail') || '请先登录epomail',
      type: 'warning',
    })
    return
  }
  toastStore.show({
    message: t('comments.commentsNotOpen') || '评论区暂时没有开放',
    type: 'info',
  })
}

const loadComments = async () => {
  if (!props.id) return
  try {
    state.loading = true
    const api = props.type === 'playlist' ? commentPlaylist : commentMusic
    const res: any = await api({
      id: Number(props.id),
      limit: state.limit,
      offset: (state.page - 1) * state.limit,
    })
    const list = res?.data?.comments || res?.comments || []
    state.comments = Array.isArray(list) ? list : []
    state.total = Number(res?.data?.total ?? res?.total ?? res?.totalCount ?? state.comments.length)
  } finally {
    state.loading = false
  }
}

watch(
  () => isOpen.value,
  val => {
    if (val) {
      loadComments()
    }
  }
)

watch(
  () => props.id,
  () => {
    if (isOpen.value) {
      state.page = 1
      loadComments()
    }
  }
)

watch(
  () => state.page,
  () => {
    if (isOpen.value) loadComments()
  }
)
</script>

<template>
  <MobileDrawer v-model:show="isOpen" :title="t('comments.total', { total: formatNumber(state.total) })">
    <div class="h-full overflow-y-auto p-4 space-y-4">
      <!-- 移动端发表评论 UI 占位符 -->
      <div
        class="rounded-2xl border border-glass bg-white/5 p-3 backdrop-blur-md cursor-pointer transition-all active:scale-[0.99]"
        @click="handleCommentAction"
      >
        <div class="flex items-center gap-2.5 mb-2">
          <div class="h-7 w-7 shrink-0 overflow-hidden rounded-full ring-1 ring-glass bg-white/10 flex items-center justify-center">
            <img
              v-if="authStore.userAvatar"
              :src="authStore.userAvatar"
              class="h-full w-full object-cover"
              alt=""
              referrerpolicy="no-referrer"
            />
            <span v-else-if="authStore.isAuthenticated" class="text-xs font-bold text-white">
              {{ authStore.userInitial }}
            </span>
            <span v-else class="icon-[mdi--account] h-4 w-4 text-primary/50" />
          </div>
          <span class="text-xs font-medium text-primary/80">
            {{ authStore.isAuthenticated ? authStore.userName : t('account.guestUser', '访客用户') }}
          </span>
          <span
            v-if="authStore.isAuthenticated"
            class="rounded-full bg-emerald-500/15 px-1.5 py-0.2 text-[9px] font-medium text-emerald-400"
          >
            EpoMail
          </span>
        </div>

        <div class="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 border border-glass">
          <span class="text-xs text-primary/40 select-none">
            {{ t('comments.writeTip', '发表你的友善评论...') }}
          </span>
          <Button
            variant="solid"
            size="sm"
            rounded="full"
            class="px-3 py-1 text-xs"
            @click.stop="handleCommentAction"
          >
            <span class="icon-[mdi--send-variant-outline] mr-1 h-3 w-3" />
            {{ t('comments.submit', '发表') }}
          </Button>
        </div>
      </div>

      <div v-if="state.loading" class="py-4">
        <PageSkeleton :sections="['list']" :list-count="6" />
      </div>
      <div v-else-if="state.comments.length === 0" class="flex h-64 flex-col items-center justify-center text-primary/40">
        <span class="icon-[mdi--comment-off-outline] mb-2 h-12 w-12"></span>
        <p class="text-sm">{{ t('common.noData') }}</p>
      </div>
      <div v-else class="space-y-4 pb-4">
        <div v-for="comment in state.comments" :key="comment.commentId" class="flex gap-3">
          <!-- 头像 -->
          <div class="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-glass bg-primary/5">
            <LazyImage
              v-if="comment.user?.avatarUrl"
              :src="formatCoverUrl(comment.user?.avatarUrl || '', { size: 60 })"
              class="h-full w-full object-cover"
            />
            <div v-else class="flex h-full w-full items-center justify-center bg-primary/10 text-primary/60">
              <span class="icon-[mdi--account] h-4 w-4" />
            </div>
          </div>
          
          <!-- 内容 -->
          <div class="flex-1 space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-primary/70">{{ comment.user?.nickname || t('comments.user') }}</span>
              <span class="text-[11px] text-primary/40">{{ formatDate(comment.time) }}</span>
            </div>
            
            <p class="text-sm leading-relaxed text-primary/90 break-all whitespace-pre-wrap">{{ comment.content }}</p>
            
            <!-- 回复引用 -->
            <div v-if="comment.beReplied?.length" class="mt-2 rounded-lg bg-primary/5 p-2 text-xs text-primary/60">
               <span class="font-medium text-primary/70">@{{ comment.beReplied[0]?.user?.nickname || t('comments.user') }}:</span>
               {{ comment.beReplied[0]?.content }}
            </div>

            <div class="flex items-center gap-1 pt-1 text-xs text-primary/40">
              <button
                type="button"
                class="flex items-center gap-1 hover:text-red-400 transition-colors cursor-pointer"
                @click="handleCommentAction"
              >
                <span class="icon-[mdi--thumb-up-outline] h-3.5 w-3.5"></span>
                <span>{{ formatNumber(comment.likedCount || 0) }}</span>
              </button>
            </div>
          </div>
        </div>

        <Pagination
            v-if="state.total > state.limit"
            v-model="state.page"
            :total="state.total"
            :page-size="state.limit"
            class="mt-4"
          />
      </div>
    </div>
  </MobileDrawer>
</template>

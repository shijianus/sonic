<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/modules/auth'
import { useToastStore } from '@/stores/modules/toast'
import { storeToRefs } from 'pinia'

const props = withDefaults(
  defineProps<{
    collapsed?: boolean
  }>(),
  {
    collapsed: false,
  }
)

const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const toastStore = useToastStore()
const { user, isAuthenticated, isLoading } = storeToRefs(authStore)

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)

const toggleMenu = () => {
  isOpen.value = !isOpen.value
}

const closeMenu = () => {
  isOpen.value = false
}

// 点击外部关闭弹窗
const handleClickOutside = (event: MouseEvent) => {
  if (
    isOpen.value &&
    menuRef.value &&
    triggerRef.value &&
    !menuRef.value.contains(event.target as Node) &&
    !triggerRef.value.contains(event.target as Node)
  ) {
    closeMenu()
  }
}

// 跨标签页感知 EpoMail 登录/登出变动
const handleStorageChange = (e: StorageEvent) => {
  if (e.key === 'token' || e.key === 'loginEmail' || e.key === 'epo_sessions') {
    authStore.checkAuth(true)
  }
}

onMounted(() => {
  authStore.checkAuth()
  window.addEventListener('click', handleClickOutside)
  window.addEventListener('storage', handleStorageChange)
})

onUnmounted(() => {
  window.removeEventListener('click', handleClickOutside)
  window.removeEventListener('storage', handleStorageChange)
})

const displayName = computed(() => {
  if (user.value?.name) return user.value.name
  if (user.value?.email) return user.value.email.split('@')[0]
  return t('account.guestUser') || '访客'
})

const displayEmail = computed(() => user.value?.email || '')

const initialChar = computed(() => {
  const name = user.value?.name || user.value?.email || 'U'
  return name.charAt(0).toUpperCase()
})

const handleManageProfile = () => {
  closeMenu()
  authStore.openProfile()
}

const handleOpenMail = () => {
  closeMenu()
  authStore.openInbox()
}

const handleSync = async () => {
  await authStore.checkAuth(true)
  toastStore.show({
    message: t('account.syncSuccess') || '账户状态已同步',
    type: 'success',
  })
}

const handleGoSettings = () => {
  closeMenu()
  router.push('/settings')
}

const handleLogin = () => {
  closeMenu()
  authStore.login()
}

const handleLogout = async () => {
  closeMenu()
  await authStore.logout()
  toastStore.show({
    message: t('account.logoutSuccess') || '已退出登录',
    type: 'info',
  })
}
</script>

<template>
  <div class="relative w-full">
    <!-- 折叠模式触发器 -->
    <div v-if="collapsed" class="flex justify-center w-full">
      <button
        ref="triggerRef"
        type="button"
        @click.stop="toggleMenu"
        class="group relative flex h-10 w-10 items-center justify-center rounded-xl bg-button-glass hover:bg-hover-button-glass border border-glass transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 cursor-pointer"
        :title="isAuthenticated ? `${displayName} (${displayEmail})` : ($t('account.signIn') || '登录账户')"
        :aria-expanded="isOpen"
        aria-label="Account menu"
      >
        <img
          v-if="user?.avatar"
          :src="user.avatar"
          :alt="displayName"
          class="h-7 w-7 rounded-full object-cover border border-glass"
        />
        <div
          v-else-if="isAuthenticated"
          class="flex h-7 w-7 items-center justify-center rounded-full bg-linear-to-tr from-blue-600 to-sky-400 text-[11px] font-bold text-sky-50 shadow-xs"
        >
          {{ initialChar }}
        </div>
        <div
          v-else
          class="flex h-7 w-7 items-center justify-center rounded-full bg-hover-glass text-primary/70 group-hover:text-primary transition-colors"
        >
          <span class="icon-[mdi--account-outline] h-4 w-4"></span>
        </div>

        <!-- 登录状态在线绿点 -->
        <span
          v-if="isAuthenticated"
          class="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-[#091326]"
        ></span>
      </button>
    </div>

    <!-- 展开模式：ChatGPT 风格账户卡片 -->
    <div v-else class="w-full">
      <button
        ref="triggerRef"
        type="button"
        @click.stop="toggleMenu"
        class="group flex w-full items-center gap-2.5 rounded-xl bg-button-glass hover:bg-hover-button-glass border border-glass p-2 text-left transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 cursor-pointer select-none"
        :aria-expanded="isOpen"
        aria-label="Account menu"
      >
        <!-- 头像区 -->
        <div class="relative shrink-0">
          <img
            v-if="user?.avatar"
            :src="user.avatar"
            :alt="displayName"
            class="h-8 w-8 rounded-full object-cover border border-glass shadow-xs"
          />
          <div
            v-else-if="isAuthenticated"
            class="flex h-8 w-8 items-center justify-center rounded-full bg-linear-to-tr from-blue-600 to-sky-400 text-xs font-bold text-sky-50 shadow-xs"
          >
            {{ initialChar }}
          </div>
          <div
            v-else
            class="flex h-8 w-8 items-center justify-center rounded-full bg-hover-glass text-primary/70 group-hover:text-primary transition-colors"
          >
            <span class="icon-[mdi--account-outline] h-4.5 w-4.5"></span>
          </div>

          <span
            v-if="isAuthenticated"
            class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-[#091326]"
          ></span>
        </div>

        <!-- 用户名 & 邮箱/提示 -->
        <div class="flex flex-1 flex-col min-w-0 leading-tight">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs font-semibold text-primary truncate">
              {{ displayName }}
            </span>
            <span
              v-if="isAuthenticated"
              class="rounded bg-sky-500/15 border border-sky-400/25 px-1 py-0.2 text-[9px] font-bold text-sky-300 shrink-0"
            >
              SSO
            </span>
          </div>
          <span class="mt-0.5 text-[11px] text-primary/45 truncate font-normal">
            {{ isAuthenticated ? displayEmail : ($t('account.signInDesc') || 'EpoMail 统一账户') }}
          </span>
        </div>

        <!-- 右侧操作指示图标 -->
        <div class="shrink-0 text-primary/40 group-hover:text-primary transition-colors">
          <span v-if="isAuthenticated" class="icon-[mdi--dots-horizontal] h-4 w-4"></span>
          <span v-else class="icon-[mdi--login] h-4 w-4"></span>
        </div>
      </button>
    </div>

    <!-- ChatGPT 风格弹出管理面板 (Popover) -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="transform scale-95 opacity-0 translate-y-1"
      enter-to-class="transform scale-100 opacity-100 translate-y-0"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="transform scale-100 opacity-100 translate-y-0"
      leave-to-class="transform scale-95 opacity-0 translate-y-1"
    >
      <div
        v-if="isOpen"
        ref="menuRef"
        class="absolute z-50 rounded-2xl border border-glass bg-[#0a1426]/95 backdrop-blur-2xl p-2 shadow-[0_12px_36px_rgba(0,0,0,0.6)] text-primary"
        :class="[
          collapsed
            ? 'bottom-0 left-[calc(100%+12px)] w-68'
            : 'bottom-[calc(100%+8px)] left-0 right-0 w-full min-w-[240px]'
        ]"
      >
        <!-- 已登录状态 -->
        <template v-if="isAuthenticated">
          <!-- 顶部用户信息卡片 -->
          <div class="flex items-center gap-3 p-2 rounded-xl bg-button-glass border border-glass mb-2">
            <div
              v-if="!user?.avatar"
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-linear-to-tr from-blue-600 to-sky-400 text-sm font-bold text-sky-50 shadow-xs"
            >
              {{ initialChar }}
            </div>
            <img
              v-else
              :src="user.avatar"
              :alt="displayName"
              class="h-9 w-9 shrink-0 rounded-full object-cover border border-glass"
            />
            <div class="flex flex-1 flex-col min-w-0">
              <span class="text-xs font-bold text-primary truncate leading-tight">{{ displayName }}</span>
              <span class="text-[11px] text-primary/50 truncate leading-tight mt-0.5">{{ displayEmail }}</span>
              <span class="mt-1 inline-flex items-center gap-1 text-[9px] font-medium text-emerald-400">
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                {{ $t('account.ssoBadge') || 'EpoMail 统一认证' }}
              </span>
            </div>
          </div>

          <!-- 功能操作选项菜单 (学习 ChatGPT AI UI) -->
          <div class="space-y-0.5">
            <button
              type="button"
              @click="handleManageProfile"
              class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-primary/80 hover:text-primary hover:bg-hover-button-glass transition-colors text-left cursor-pointer"
            >
              <span class="icon-[mdi--badge-account-outline] h-4 w-4 text-sky-400 shrink-0"></span>
              <span class="truncate">{{ $t('account.manageProfile') || '个人中心与账号设置' }}</span>
              <span class="icon-[mdi--arrow-top-right] h-3 w-3 text-primary/30 ml-auto shrink-0"></span>
            </button>

            <button
              type="button"
              @click="handleOpenMail"
              class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-primary/80 hover:text-primary hover:bg-hover-button-glass transition-colors text-left cursor-pointer"
            >
              <span class="icon-[mdi--email-fast-outline] h-4 w-4 text-blue-400 shrink-0"></span>
              <span class="truncate">{{ $t('account.openMail') || '打开 EpoMail 邮箱' }}</span>
              <span class="icon-[mdi--arrow-top-right] h-3 w-3 text-primary/30 ml-auto shrink-0"></span>
            </button>

            <button
              type="button"
              @click="handleSync"
              class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-primary/80 hover:text-primary hover:bg-hover-button-glass transition-colors text-left cursor-pointer"
            >
              <span class="icon-[mdi--sync] h-4 w-4 text-emerald-400 shrink-0" :class="{ 'animate-spin': isLoading }"></span>
              <span class="truncate">{{ $t('account.syncAccount') || '同步账户状态' }}</span>
            </button>

            <button
              type="button"
              @click="handleGoSettings"
              class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-primary/80 hover:text-primary hover:bg-hover-button-glass transition-colors text-left cursor-pointer"
            >
              <span class="icon-[mdi--cog-outline] h-4 w-4 text-slate-300 shrink-0"></span>
              <span class="truncate">{{ $t('layout.aside.menu.settings') || '偏好设置' }}</span>
            </button>
          </div>

          <!-- 分割线 -->
          <div class="my-1.5 border-t border-glass"></div>

          <!-- 登出选项 -->
          <button
            type="button"
            @click="handleLogout"
            class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors text-left cursor-pointer"
          >
            <span class="icon-[mdi--logout] h-4 w-4 shrink-0"></span>
            <span>{{ $t('account.signOut') || '退出登录' }}</span>
          </button>
        </template>

        <!-- 未登录状态卡片 -->
        <template v-else>
          <div class="p-2.5 text-center">
            <div class="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-linear-to-tr from-blue-600/30 to-sky-400/30 border border-blue-400/30 text-sky-400">
              <span class="icon-[mdi--account-lock-outline] h-5 w-5"></span>
            </div>
            <h4 class="text-xs font-bold text-primary">
              {{ $t('account.signIn') || '登录 EpoMail 账户' }}
            </h4>
            <p class="mt-1 text-[11px] text-primary/50 leading-relaxed">
              {{ $t('account.loginPrompt') || 'Sonic 账户全权由 EpoMail 驱动，登录后畅享云端歌单与专属高质音源。' }}
            </p>

            <button
              type="button"
              @click="handleLogin"
              class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-linear-to-r from-blue-600 to-sky-500 hover:from-blue-500 hover:to-sky-400 text-sky-50 py-2 text-xs font-bold shadow-[0_0_16px_rgba(37,99,235,0.4)] transition-all cursor-pointer"
            >
              <span class="icon-[mdi--login] h-4 w-4"></span>
              <span>{{ $t('account.signIn') || '使用 EpoMail 登录' }}</span>
            </button>

            <button
              type="button"
              @click="handleSync"
              class="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-button-glass hover:bg-hover-button-glass border border-glass text-primary/70 hover:text-primary py-1.5 text-xs font-medium transition-colors cursor-pointer"
            >
              <span class="icon-[mdi--refresh] h-3.5 w-3.5" :class="{ 'animate-spin': isLoading }"></span>
              <span>{{ $t('account.syncAccount') || '检查/同步本地会话' }}</span>
            </button>
          </div>
        </template>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
// 移动端布局：重新排版为纯色背景 + 顶部简洁导航 + 底部标签栏
// 不复用 PC 的 Aside/Footer，采用移动端专属组件
import MobileHeader from './Header.vue'
import MobileTabBar from './TabBar.vue'
import PlayerDrawerMobile from '@/components/Mobile/PlayerDrawerMobile.vue'
import { useGlobalStore } from '@/stores/modules/global'
import { readPrefersReducedMotion } from '@/composables/useAmbientMotion'
import { storeToRefs } from 'pinia'

const globalStore = useGlobalStore()
const { isPlayerDrawerOpen } = storeToRefs(globalStore)
const openPlayerDrawer = () => {
  globalStore.openPlayerDrawer()
}

const clearNode = (node: HTMLElement) => {
  node.style.transition = ''
  node.style.opacity = ''
  node.style.transform = ''
}

const onMobileEnter = (el: Element, done: () => void) => {
  const node = el as HTMLElement
  if (readPrefersReducedMotion()) {
    clearNode(node)
    return done()
  }
  node.style.transition = 'none'
  node.style.opacity = '0'
  setTimeout(() => {
    node.style.transition = 'opacity 100ms cubic-bezier(0.22, 1, 0.36, 1)'
    node.style.opacity = '1'
    setTimeout(() => {
      clearNode(node)
      done()
    }, 100)
  }, 16)
}

const onMobileLeave = (el: Element, done: () => void) => {
  const node = el as HTMLElement
  if (readPrefersReducedMotion()) {
    queueMicrotask(done)
    return
  }
  node.style.transition = 'opacity 50ms ease-out'
  setTimeout(() => {
    node.style.opacity = '0'
  }, 16)
  setTimeout(() => {
    clearNode(node)
    done()
  }, 66)
}
</script>

<template>
  <!-- 纯色背景容器：移动端更简洁、更聚焦内容 -->
  <div class="text-primary flex h-dvh w-full flex-col">
    <!-- 顶部导航（含搜索/登录入口） -->
    <MobileHeader :inert="isPlayerDrawerOpen || undefined" :aria-hidden="isPlayerDrawerOpen || undefined" />

    <!-- 内容区域：页面组件渲染 -->
    <main
      :inert="isPlayerDrawerOpen || undefined"
      :aria-hidden="isPlayerDrawerOpen || undefined"
      class="flex min-h-0 flex-1 flex-col overflow-hidden pt-3"
      style="
        padding-bottom: calc(
          var(--mobile-tabbar-h, 56px) + 12px + var(--mobile-miniplayer-h, 0px) +
            env(safe-area-inset-bottom, 0px)
        );
      "
    >
      <router-view v-slot="{ Component, route }">
        <transition mode="out-in" :css="false" @enter="onMobileEnter" @leave="onMobileLeave">
          <keep-alive :max="6">
            <component :is="Component" :key="route.path" />
          </keep-alive>
        </transition>
      </router-view>
    </main>

    <!-- 底部标签栏：主要导航入口，适配拇指操作 -->
    <MobileTabBar
      :inert="isPlayerDrawerOpen || undefined"
      :aria-hidden="isPlayerDrawerOpen || undefined"
      @show-player="openPlayerDrawer"
    />

    <!-- 播放器抽屉放在背景层之外，打开时背景统一 inert -->
    <PlayerDrawerMobile v-model="isPlayerDrawerOpen" />
  </div>
</template>

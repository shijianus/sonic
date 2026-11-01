<script setup lang="ts">
// 移动端布局：重新排版为纯色背景 + 顶部简洁导航 + 底部标签栏
// 不复用 PC 的 Aside/Footer，采用移动端专属组件
import MobileHeader from './Header.vue'
import MobileTabBar from './TabBar.vue'
import PlayerDrawerMobile from '@/components/Mobile/PlayerDrawerMobile.vue'
import { useGlobalStore } from '@/stores/modules/global'
import { storeToRefs } from 'pinia'

const globalStore = useGlobalStore()
const { isPlayerDrawerOpen } = storeToRefs(globalStore)
const openPlayerDrawer = () => {
  globalStore.openPlayerDrawer()
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
        <keep-alive>
          <component :is="Component" :key="route.path" />
        </keep-alive>
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

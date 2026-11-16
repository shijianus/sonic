<script setup lang="ts">
import Aside from './aside.vue'
import Footer from './footer.vue'

import { storeToRefs } from 'pinia'
import { computed, defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import { useSettingsStore } from '@/stores/modules/settings'
import { useGlobalStore } from '@/stores/modules/global'
import { readPrefersReducedMotion, useAmbientMotion } from '@/composables/useAmbientMotion'

const Aurora = defineAsyncComponent(() => import('@/components/Background/Aurora.vue'))
const ColorBends = defineAsyncComponent(() => import('@/components/Background/ColorBends.vue'))
const Ultimate = defineAsyncComponent(() => import('@/components/Background/Ultimate.vue'))
const ShadowBling = defineAsyncComponent(() => import('@/components/Background/ShadowBling.vue'))

const settings = useSettingsStore()
const { aurora, colorBends, ultimate, shadowBling, backgroundType } = storeToRefs(settings)
const globalStore = useGlobalStore()
const { isPlayerDrawerOpen } = storeToRefs(globalStore)
const { isPerfMode } = useAmbientMotion()

const colorStops = computed(() => {
  const stops = (aurora.value.colorStops || []).slice(0, 3)
  return stops.map((s: string) => (s.startsWith('#') ? s : `#${s}`))
})

const positions = computed(() => {
  const p = aurora.value.colorPositions || [0, 0.5, 1]
  return [p[0] ?? 0, p[1] ?? 0.5, p[2] ?? 1]
})

const openPlayerDrawer = () => {
  globalStore.openPlayerDrawer()
}

type BackgroundType = 'colorbends' | 'ultimate' | 'aurora' | 'shadowBling'

const backgroundComponents: Record<BackgroundType, Component> = {
  colorbends: ColorBends,
  ultimate: Ultimate,
  aurora: Aurora,
  shadowBling: ShadowBling,
}

const backgroundPropsMap = computed<Record<BackgroundType, any>>(() => ({
  colorbends: colorBends.value,
  ultimate: ultimate.value,
  aurora: {
    ...aurora.value,
    colorPositions: positions.value,
    colorStops: colorStops.value,
  },
  shadowBling: shadowBling.value,
}))

const currentBackgroundType = computed<BackgroundType>(() => backgroundType.value as BackgroundType)

const currentBackgroundComponent = computed<Component>(
  () => backgroundComponents[currentBackgroundType.value]
)
const currentBackgroundProps = computed(() => backgroundPropsMap.value[currentBackgroundType.value])

// ── 路由过渡（极速合成器过渡，不依赖易冻结的 rAF）──
const ROUTE_LEAVE_MS = 65
const ROUTE_ENTER_MS = 140
const ROUTE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

const clearNodeTransition = (node: HTMLElement) => {
  node.style.transition = ''
  node.style.opacity = ''
  node.style.transform = ''
}

const onRouteEnter = (el: Element, done: () => void) => {
  const node = el as HTMLElement
  if (readPrefersReducedMotion()) {
    clearNodeTransition(node)
    return done()
  }
  node.style.transition = 'none'
  node.style.opacity = '0'
  node.style.transform = 'translate3d(0, 6px, 0)'
  setTimeout(() => {
    node.style.transition = `opacity ${ROUTE_ENTER_MS}ms ${ROUTE_EASE}, transform ${ROUTE_ENTER_MS}ms ${ROUTE_EASE}`
    node.style.opacity = '1'
    node.style.transform = 'translate3d(0, 0, 0)'
    setTimeout(() => {
      clearNodeTransition(node)
      done()
    }, ROUTE_ENTER_MS)
  }, 16)
}

const onRouteLeave = (el: Element, done: () => void) => {
  const node = el as HTMLElement
  if (readPrefersReducedMotion()) {
    // Let Vue finish patching the out-in placeholder before it mounts the new page.
    queueMicrotask(done)
    return
  }
  node.style.transition = `opacity ${ROUTE_LEAVE_MS}ms ease-out, transform ${ROUTE_LEAVE_MS}ms ease-out`
  setTimeout(() => {
    node.style.opacity = '0'
    node.style.transform = 'translate3d(0, -4px, 0)'
  }, 16)
  setTimeout(() => {
    clearNodeTransition(node)
    done()
  }, ROUTE_LEAVE_MS + 16)
}
</script>

<template>
  <div class="relative flex h-full w-full overflow-hidden">
    <div class="custom-theme absolute inset-0 h-full w-full bg-[var(--glass-bg-solid)]">
      <transition appear name="fade-bg" mode="out-in">
        <component
          v-if="!isPerfMode"
          :is="currentBackgroundComponent"
          :key="currentBackgroundType"
          v-bind="currentBackgroundProps"
          class="h-full w-full"
        />
      </transition>
    </div>

    <!-- Sonic 科技感微网格与工作室径向辉光（零模糊滤镜与动画，无合成重绘成本） -->
    <div class="tech-ambient-overlay fixed inset-0 pointer-events-none z-0" aria-hidden="true"></div>

    <!-- 主工作区：几何对齐的 Studio 架构 (全组件限制在统一上下区间 [Y_top, Y_bottom] 内) -->
    <div class="z-50 flex h-full w-full p-3 sm:p-4 gap-3 sm:gap-4 overflow-hidden">
      <!-- 左侧边栏：单独占用左边所有空间，严格限制在上下区间内 -->
      <Aside :inert="isPlayerDrawerOpen || undefined" :aria-hidden="isPlayerDrawerOpen || undefined" />

      <!-- 右侧主区域：上部内容画板 + 底部控制 Dock，与左侧边栏上下区间严格同步 -->
      <div class="relative flex flex-1 flex-col h-full min-h-0 min-w-0 gap-3 sm:gap-4 overflow-hidden">
        <!-- 上页内容画板：作为主内容区统一的大磨砂画板，内部绝无嵌套框 -->
        <main
          :inert="isPlayerDrawerOpen || undefined"
          :aria-hidden="isPlayerDrawerOpen || undefined"
          class="section-container relative flex flex-1 min-h-0 flex-col overflow-hidden p-2 rounded-[28px]"
        >
          <router-view v-slot="{ Component, route }">
            <transition mode="out-in" :css="false" @enter="onRouteEnter" @leave="onRouteLeave">
              <keep-alive :max="8">
                <component :is="Component" :key="route.path" />
              </keep-alive>
            </transition>
          </router-view>
        </main>

        <!-- 底部播放栏：在 main 下方（前终止），保留已有的磨砂玻璃材质，与左侧边栏底缘绝对齐平 -->
        <Footer
          :inert="isPlayerDrawerOpen || undefined"
          :aria-hidden="isPlayerDrawerOpen || undefined"
          @show="openPlayerDrawer"
        />

        <!-- 播放器全屏抽屉 -->
        <PlayerDrawer v-model="isPlayerDrawerOpen" />
      </div>
    </div>
  </div>
</template>
<style>
.tech-ambient-overlay {
  background-image:
    radial-gradient(60% 45% at 18% 12%, rgba(56, 189, 248, 0.14) 0%, transparent 70%),
    radial-gradient(50% 45% at 85% 88%, rgba(37, 99, 235, 0.16) 0%, transparent 70%),
    radial-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px);
  background-size:
    100% 100%,
    100% 100%,
    28px 28px;
}

.fade-bg-enter-active,
.fade-bg-leave-active {
  transition: opacity 0.24s ease;
}

.fade-bg-enter-from,
.fade-bg-leave-to {
  opacity: 0;
}
</style>

/**
 * 全局状态 Store
 * 管理主题、语言、搜索历史等应用级全局配置
 */
import { defineStore } from 'pinia'
import { GlobalState } from '../interface'
import piniaPersistConfig from '../persist'

export const useGlobalStore = defineStore('global', {
  state: (): GlobalState => ({
    count: 0,
    theme: 'system' as 'light' | 'dark' | 'system',
    /** 搜索历史记录（最多保留 10 条） */
    searchHistory: [] as string[],
    lang: undefined,
    /** 侧边栏折叠状态 */
    sidebarCollapsed: false,
    /** 播放器全屏抽屉是否开启 */
    isPlayerDrawerOpen: false,
  }),
  actions: {
    /** 打开播放器抽屉 */
    openPlayerDrawer() {
      this.isPlayerDrawerOpen = true
    },

    /** 关闭播放器抽屉 */
    closePlayerDrawer() {
      this.isPlayerDrawerOpen = false
    },

    /** 切换播放器抽屉状态 */
    togglePlayerDrawer() {
      this.isPlayerDrawerOpen = !this.isPlayerDrawerOpen
    },

    /** 切换侧边栏折叠状态 */
    toggleSidebarCollapsed() {
      this.sidebarCollapsed = !this.sidebarCollapsed
    },

    /** 设置侧边栏折叠状态 */
    setSidebarCollapsed(collapsed: boolean) {
      this.sidebarCollapsed = collapsed
    },

    /** 通用状态更新方法 */
    setGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
      this.$patch(state => {
        state[key] = value
      })
    },

    /** 设置主题模式 */
    setTheme(theme: 'light' | 'dark' | 'system') {
      this.theme = theme
    },

    /** 切换明暗主题 */
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark'
    },

    /** 设置界面语言 */
    setLang(lang: 'zh' | 'en' | 'ja') {
      this.lang = lang
    },

    /** 添加搜索历史（去重、合并同类项、最新在前、最多 20 条） */
    addSearchHistory(q: string) {
      const s = q.trim()
      if (!s) return
      // 合并同类项：忽略大小写匹配已有项并移除，保留最新输入
      const lower = s.toLowerCase()
      this.searchHistory = this.searchHistory.filter(
        (item: string) => item.trim().toLowerCase() !== lower
      )
      this.searchHistory.unshift(s)
      if (this.searchHistory.length > 20) {
        this.searchHistory = this.searchHistory.slice(0, 20)
      }
    },

    /** 删除指定搜索历史（忽略大小写合并删除） */
    removeSearchHistory(q: string) {
      const s = q.trim().toLowerCase()
      if (!s) return
      this.searchHistory = this.searchHistory.filter(
        (item: string) => item.trim().toLowerCase() !== s
      )
    },

    /** 清空全部搜索历史 */
    clearSearchHistory() {
      this.searchHistory = []
    },
  },
  persist: piniaPersistConfig('global', ['theme', 'searchHistory', 'lang', 'sidebarCollapsed']),
})

import { describe, it, expect, beforeEach } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useGlobalStore } from '@/stores/modules/global'

describe('search history store', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({ render: () => null }).use(pinia)
    setActivePinia(pinia)
  })

  it('添加搜索历史并合并同类项（忽略大小写与首尾空格），最新搜索项置顶', () => {
    const global = useGlobalStore()
    expect(global.searchHistory).toEqual([])

    global.addSearchHistory('周杰伦')
    expect(global.searchHistory).toEqual(['周杰伦'])

    global.addSearchHistory('林俊杰')
    expect(global.searchHistory).toEqual(['林俊杰', '周杰伦'])

    // 同名不同大小写/空格合并
    global.addSearchHistory('  周杰伦  ')
    expect(global.searchHistory).toEqual(['周杰伦', '林俊杰'])

    global.addSearchHistory('taylor swift')
    expect(global.searchHistory[0]).toBe('taylor swift')

    global.addSearchHistory('Taylor Swift')
    expect(global.searchHistory[0]).toBe('Taylor Swift')
    expect(global.searchHistory.filter(s => s.toLowerCase() === 'taylor swift').length).toBe(1)
  })

  it('搜索历史最多收录20个记录，超出截断', () => {
    const global = useGlobalStore()
    for (let i = 1; i <= 25; i++) {
      global.addSearchHistory(`搜索词${i}`)
    }
    expect(global.searchHistory.length).toBe(20)
    expect(global.searchHistory[0]).toBe('搜索词25')
    expect(global.searchHistory[19]).toBe('搜索词6')
  })

  it('删除和清空搜索历史', () => {
    const global = useGlobalStore()
    global.addSearchHistory('A')
    global.addSearchHistory('B')
    global.addSearchHistory('C')

    global.removeSearchHistory('b')
    expect(global.searchHistory).toEqual(['C', 'A'])

    global.clearSearchHistory()
    expect(global.searchHistory).toEqual([])
  })
})

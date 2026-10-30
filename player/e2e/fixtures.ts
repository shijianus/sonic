import { test as base, expect, type Page } from '@playwright/test'

/**
 * 所有 E2E 共用夹具：捕获未处理异常。
 * 单个用例允许出现预期的 console.warn/console.error（例如上游 403），
 * 但任何未捕获的页面异常都视为失败。
 */
export const test = base.extend<{ pageErrors: string[] }>({
  // 应用默认 UI 语言是中文（main.ts 的显式产品默认），E2E 统一固定为英文，
  // 保证断言文本稳定且可读；这与语言切换功能本身无关。
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('global', JSON.stringify({ lang: 'en' }))
      } catch {
        /* about:blank 等场景忽略 */
      }
    })
    await use(page)
  },
  pageErrors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', err => errors.push(String((err as Error)?.message || err)))
    await use(errors)
  },
})

test.afterEach(async ({ pageErrors }) => {
  expect(pageErrors, 'uncaught page errors').toEqual([])
})

export { expect }

export interface AudioSnapshot {
  paused: boolean
  currentTime: number
  duration: number
  src: string
}

/** 读取真实 <audio> 元素状态，而不是只信 UI 文案 */
export async function getAudio(page: Page): Promise<AudioSnapshot | null> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLAudioElement>('#audioPlayer')
    if (!el) return null
    return {
      paused: el.paused,
      currentTime: el.currentTime,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      src: el.currentSrc || el.src || '',
    }
  })
}

export async function expectPlaying(page: Page): Promise<void> {
  await expect.poll(async () => (await getAudio(page))?.paused, { timeout: 20_000 }).toBe(false)
  await expect
    .poll(async () => (await getAudio(page))?.currentTime ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(0.4)
}

export async function expectPaused(page: Page): Promise<void> {
  await expect.poll(async () => (await getAudio(page))?.paused, { timeout: 20_000 }).toBe(true)
}

/** 页面是否出现横向溢出（响应式基础检查） */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
}

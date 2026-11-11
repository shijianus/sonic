import { test, expect, getAudio, expectPlaying, expectPaused } from '../fixtures'
import type { Page } from '@playwright/test'

async function holdOldTrackUrl(page: Page) {
  const matches = (url: URL) => url.pathname === '/api/song/url/v1' && url.searchParams.get('id') === '9001'
  let markRequested!: () => void
  const requested = new Promise<void>(resolve => { markRequested = resolve })
  let unblock!: () => void
  const held = new Promise<void>(resolve => { unblock = resolve })
  await page.route(matches, async route => {
    markRequested()
    await held
    await route.fulfill({ json: { data: [{ url: '/api/music/stream?id=9001' }] } })
  })
  return {
    requested,
    unblock,
    async deliver() {
      const oldResponse = page.waitForResponse(response => matches(new URL(response.url())))
      unblock()
      expect(await (await oldResponse).finished()).toBeNull()
      // Give the browser a rendering turn to apply the delivered URL before inspecting media state.
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
    },
  }
}

/**
 * 异常与降级 E2E（SONIC-P1-02）。
 * Mock 明确覆盖：403、404、429、503、连接中断、挂起超时、异常 JSON、空结果。
 * 这不代表真实上游/CDN 行为已验证。
 */
test.describe('异常与降级', () => {
  test('取流中暂停：迟到的 URL 不得在用户暂停后自动起播', async ({ page }) => {
    const old = await holdOldTrackUrl(page)
    try {
      await page.goto('/#/playlist/123')
      await page.getByTestId('song-row-9001').getByRole('heading').click()
      await old.requested
      const title = page.getByTestId('now-playing-title')
      const toggle = page.getByTestId('player-toggle')
      await expect(title).toHaveText('Test Song One')
      await expect(toggle).toHaveAttribute('aria-label', 'Cancel')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-label', 'Play')

      await old.deliver()
      const audio = await getAudio(page)
      expect(audio?.paused).toBe(true)
      expect(audio?.currentTime ?? 0).toBeLessThan(0.5)
      await expect(title).toHaveText('Test Song One')
    } finally {
      old.unblock()
    }
  })

  test('快速切歌：旧歌慢响应晚到不覆盖新歌状态', async ({ page }) => {
    const old = await holdOldTrackUrl(page)
    try {
      await page.goto('/#/playlist/123')
      await page.getByTestId('song-row-9001').getByRole('heading').click()
      await old.requested
      await page.getByTestId('song-row-9002').getByRole('heading').click()

      const title = page.getByTestId('now-playing-title')
      await expect(title).toHaveText('Test Song Two')
      await expectPlaying(page)
      const beforeOldResponse = (await getAudio(page))!.currentTime

      await old.deliver()
      await expect.poll(async () => (await getAudio(page))?.currentTime ?? 0).toBeGreaterThan(beforeOldResponse + 0.2)
      await expect(title).toHaveText('Test Song Two')
      const audio = await getAudio(page)
      expect(audio?.src).toContain('id=9002')
      expect(audio?.paused).toBe(false)
    } finally {
      old.unblock()
    }
  })

  test('播放 403：给出明确错误提示，页面与播放器保持可用', async ({ page }) => {
    await page.goto('/#/search?q=restricted')
    await expect(page.getByTestId('song-row-9303')).toBeVisible()
    await page.getByTestId('song-row-9303').click()

    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/copyright|unavailable/i)
    await expect(page.getByTestId('now-playing-title')).toHaveText('Forbidden Track')

    // 页面仍可交互：搜索引擎输入框仍在，可继续切歌
    await expect(page.getByTestId('nav-search-input')).toBeVisible()
    await page.getByTestId('song-row-9304').click()
    await expect(page.getByRole('alert').last()).toBeVisible()
  })

  test('播放 429：提示限流原因，不产生未捕获异常', async ({ page }) => {
    await page.goto('/#/search?q=restricted')
    await page.getByTestId('song-row-9304').click()
    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/rate limited|too many/i)
    await expect(page.getByTestId('now-playing-title')).toHaveText('Rate Limited Track')
  })

  test('播放 404：提示曲目无可用音源，页面保持可用', async ({ page }) => {
    await page.goto('/#/search?q=errors')
    await page.getByTestId('song-row-9307').click()
    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/暂无可用音源|unavailable|copyright/i)
    await expect(page.getByTestId('nav-search-input')).toBeVisible()
  })

  test('播放 503：提示服务降级，不静默卡死', async ({ page }) => {
    await page.goto('/#/search?q=errors')
    await page.getByTestId('song-row-9308').click()
    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('The music service is degraded. Please retry later.')
    await expect(alert).not.toContainText('player.playbackError')
    await expectPaused(page)
  })

  test('播放挂起超时：不得无限加载，需给出网络错误提示', async ({ page }) => {
    await page.goto('/#/search?q=errors')
    await page.getByTestId('song-row-9306').click()

    // 9306 返回 200 响应头后不再发送音频数据；前端启动看门狗须在 15s 内收敛错误态。
    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible({ timeout: 25_000 })
    await expect(alert).toContainText(/network|timeout|网络/i)
    await expect(page.getByTestId('nav-search-input')).toBeVisible()
    await expectPaused(page)
  })

  test('播放连接中断：提示网络错误而不是静默卡死', async ({ page }) => {
    await page.goto('/#/search?q=restricted')
    await page.getByTestId('song-row-9305').click()
    const alert = page.getByRole('alert').last()
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/network/i)
    await expectPaused(page)
  })

  test('搜索 429：显示可重试错误态，而不是伪装成空结果', async ({ page }) => {
    await page.goto('/#/search?q=ratelimited')
    const panel = page.getByTestId('search-error')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(/too many requests/i)
    await expect(page.getByTestId('search-retry')).toBeVisible()
  })

  test('搜索 403：显示上游错误态', async ({ page }) => {
    await page.goto('/#/search?q=forbidden')
    const panel = page.getByTestId('search-error')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(/music service returned an error/i)
  })

  test('搜索断网：显示网络错误态', async ({ page }) => {
    await page.goto('/#/search?q=offline')
    const panel = page.getByTestId('search-error')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(/network error/i)
  })

  test('快速改搜索词：旧慢请求晚到不覆盖新结果', async ({ page }) => {
    await page.goto('/#/search?q=slow')
    const input = page.getByTestId('nav-search-input')
    await input.fill('empty')
    await input.press('Enter')

    await expect(page.getByText('No results found')).toBeVisible()
    // 旧请求约 1.2s 后返回；等待并确认没有覆盖空结果
    await page.waitForTimeout(1700)
    await expect(page.getByText('No results found')).toBeVisible()
    await expect(page.locator('[data-testid^="song-row-"]')).toHaveCount(0)
  })

  test('搜索空结果与异常 JSON：明确空态，不崩溃', async ({ page }) => {
    await page.goto('/#/search?q=empty')
    await expect(page.getByText('No results found')).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)

    await page.goto('/#/search?q=malformed')
    await expect(page.getByText('No results found')).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)
  })
})

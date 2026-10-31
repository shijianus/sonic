import { test, expect, getAudio, expectPlaying, expectPaused } from '../fixtures'

/**
 * 异常与降级 E2E（SONIC-P1-02）。
 * Mock 明确覆盖：403、404、429、503、连接中断、挂起超时、异常 JSON、空结果。
 * 这不代表真实上游/CDN 行为已验证。
 */
test.describe('异常与降级', () => {
  test('取流中暂停：迟到的 URL 不得在用户暂停后自动起播', async ({ page }) => {
    await page.goto('/#/playlist/123')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()

    // 9001 的播放地址接口延迟 900ms；等待进入“加载中（可取消）”状态后立即取消
    await page.getByTestId('song-row-9001').click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song One')
    const toggle = page.getByTestId('player-toggle')
    await expect(toggle).toHaveAttribute('aria-label', 'Cancel')
    await toggle.click()

    await page.waitForTimeout(1600)
    const audio = await getAudio(page)
    expect(audio?.paused).toBe(true)
    expect(audio?.currentTime ?? 0).toBeLessThan(0.5)
    // 选中的歌曲信息保留，只是不自动播放
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song One')
  })

  test('快速切歌：旧歌慢响应晚到不覆盖新歌状态', async ({ page }) => {
    await page.goto('/#/playlist/123')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()

    // 9001 的 URL 慢 900ms；立即切到 9002（快）
    await page.getByTestId('song-row-9001').click()
    await page.getByTestId('song-row-9002').click()

    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')
    await expectPlaying(page)
    await page.waitForTimeout(1500)

    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')
    await expect.poll(async () => (await getAudio(page))?.src ?? '').toContain('id=9002')
    expect((await getAudio(page))?.paused).toBe(false)
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
    await expect(alert).toContainText(/降级|degraded/i)
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

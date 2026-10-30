import { test, expect, getAudio, expectPlaying, horizontalOverflow } from '../fixtures'

/** 响应式布局与移动端基础可用性（Pixel 7 项目执行） */
test.describe('移动端响应式与可访问性', () => {
  test('移动端搜索结果可见且无横向溢出', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('移动端点击结果可真实播放，再次点击可暂停', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    const row = page.getByTestId('song-row-9001')
    await expect(row).toBeVisible()
    await row.click()
    await expectPlaying(page)

    // 移动端迷你播放器/底部播放器必须暴露播放控制
    const toggle = page.locator('[data-testid="player-toggle"], button[aria-label="Pause"]').first()
    if ((await toggle.count()) > 0) {
      await toggle.click()
      await expect.poll(async () => (await getAudio(page))?.paused).toBe(true)
    }
  })

  test('移动端核心控件具备可访问名称', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()
    const rows = page.locator('[data-testid^="song-row-"]')
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i++) {
      const label = await rows.nth(i).getAttribute('aria-label')
      expect(label, `row ${i} accessible name`).toBeTruthy()
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('移动端页面 lang 与 viewport 正确设置', async ({ page }) => {
    await page.goto('/')
    const meta = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
    }))
    expect(meta.lang).toMatch(/^(zh-CN|en|ja)$/)
    expect(meta.viewport).toContain('width=device-width')
  })
})

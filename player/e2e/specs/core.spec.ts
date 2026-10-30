import { test, expect, getAudio, expectPlaying, expectPaused, horizontalOverflow } from '../fixtures'

/**
 * 核心播放路径 E2E（SONIC-P1-01 浏览器层）。
 * 数据来自 e2e/mock-server.mjs 的确定性夹具；音频为本地生成的 20s WAV。
 */
test.describe('核心播放路径', () => {
  test('首页加载：布局、搜索入口与播放器控制可见，无横向溢出', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('nav-search-input')).toBeVisible()
    await expect(page.locator('#footer-song-info')).toBeVisible()
    await expect(page.getByTestId('player-toggle')).toBeVisible()
    await expect(page.getByTestId('player-next')).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  })

  test('搜索 → 播放 → 暂停 → 恢复', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    const row = page.getByTestId('song-row-9001')
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song One')
    await expectPlaying(page)

    const playingAt = (await getAudio(page))!.currentTime
    await page.getByTestId('player-toggle').click()
    await expectPaused(page)

    const pausedAt = (await getAudio(page))!.currentTime
    await page.waitForTimeout(500)
    const pausedLater = (await getAudio(page))!.currentTime
    expect(Math.abs(pausedLater - pausedAt)).toBeLessThan(0.15)
    expect(pausedAt).toBeGreaterThanOrEqual(playingAt)

    await page.getByTestId('player-toggle').click()
    await expectPlaying(page)
    await expect
      .poll(async () => (await getAudio(page))!.currentTime, { timeout: 10_000 })
      .toBeGreaterThan(pausedLater + 0.3)
  })

  test('切歌与快速连点下一首：最终只播放最后一次选择', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await page.getByTestId('song-row-9001').click()
    await expectPlaying(page)

    await page.getByTestId('player-next').click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')

    // 连续两次“下一首”，第二次点击不得被旧请求覆盖
    await page.getByTestId('player-next').click()
    await page.getByTestId('player-next').click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Four')
    await expect.poll(async () => (await getAudio(page))?.src ?? '').toContain('id=9004')
    await expectPlaying(page)
  })

  test('Seek：点击进度条 50% 后真实音频时间跳转并继续播放', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await page.getByTestId('song-row-9001').click()
    await expectPlaying(page)

    const progress = page.getByTestId('player-progress')
    await expect(progress).toBeVisible()
    await expect
      .poll(async () => {
        const a = await getAudio(page)
        return a?.duration ?? 0
      }, { timeout: 15_000 })
      .toBeGreaterThan(10)

    const box = await progress.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2)

    await expect.poll(async () => (await getAudio(page))!.currentTime, { timeout: 10_000 }).toBeGreaterThan(7)
    await expect.poll(async () => (await getAudio(page))!.currentTime, { timeout: 10_000 }).toBeLessThan(15)
    await expectPlaying(page)
    await expect(progress).toHaveAttribute('aria-valuenow', /\d+/)
  })

  test('歌词：随当前歌曲加载并高亮推进，切歌后歌词同步切换', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await page.getByTestId('song-row-9001').click()
    await expectPlaying(page)

    await page.locator('#footer-cover').click()
    const lyrics = page.getByTestId('lyrics-container')
    await expect(lyrics).toBeVisible()
    await expect(lyrics).toContainText('Test Song One line')
    expect(await lyrics.locator('.lyric-line').count()).toBeGreaterThanOrEqual(3)
    await expect(lyrics.locator('.lyric-line.current')).toHaveCount(1)

    // 切歌后歌词必须切换为目标歌曲，而不是保留旧歌歌词（播放器弹层为模态，使用其内部按钮）
    const dialog = page.getByRole('dialog', { name: /full-screen music player/i })
    await dialog.getByRole('button', { name: 'Next track' }).click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')
    await expect(lyrics).toContainText('Test Song Two line')
    await expect(lyrics).not.toContainText('Test Song One line')
  })

  test('收藏：喜欢后进入收藏页可见，刷新后保持', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    const row = page.getByTestId('song-row-9001')
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', { name: 'Like', exact: true }).click()

    await page.goto('/#/likes')
    await expect(page.getByText('Test Song One', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Test Song One', { exact: true })).toBeVisible()
  })

  test('歌词降级：纯音乐与无歌词返回明确提示而不是崩溃', async ({ page }) => {
    await page.goto('/#/playlist/123')
    await expect(page.getByTestId('song-row-9200')).toBeVisible()

    await page.getByTestId('song-row-9200').click()
    await page.locator('#footer-cover').click()
    const lyrics = page.getByTestId('lyrics-container')
    await expect(lyrics).toBeVisible()
    await expect(lyrics).toContainText(/instrumental/i)

    const dialog = page.getByRole('dialog', { name: /full-screen music player/i })
    await dialog.getByRole('button', { name: 'Next track' }).click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('No Lyric Track')
    await expect(lyrics).toContainText(/no lyrics/i)
  })
})

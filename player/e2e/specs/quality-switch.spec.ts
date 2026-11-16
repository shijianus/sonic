import { test, expect, expectPaused, expectPlaying, getAudio, horizontalOverflow } from '../fixtures'

async function playSearchTrack(page: Parameters<typeof expectPlaying>[0], id = '9002') {
  await page.goto('/#/search?q=sonic')
  await page.getByTestId(`song-row-${id}`).click()
  await expectPlaying(page)
}

test('desktop click switches audio quality, updates stream br= and preserves playback position', async ({ page }, testInfo) => {
  const nonProbeStreams: string[] = []
  page.on('request', req => {
    if (!req.url().includes('/api/music/stream')) return
    if (req.headers()['range'] === 'bytes=0-0') return
    nonProbeStreams.push(req.url())
  })

  await playSearchTrack(page, '9002')

  await page.locator('#audioPlayer').evaluate((audio: HTMLAudioElement) => {
    audio.currentTime = 4.5
  })
  await expect.poll(async () => (await getAudio(page))?.currentTime ?? 0).toBeGreaterThanOrEqual(4.2)

  const qualityBtn = page.locator('#footer-quality-btn')
  await expect(qualityBtn).toBeVisible()
  await expect(qualityBtn).toContainText('SQ Lossless')

  await qualityBtn.click()
  const menu = page.locator('#quality-menu-panel')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('radio', { name: /SQ Lossless/ })).toHaveAttribute('aria-checked', 'true')
  const hqOption = menu.getByRole('radio', { name: /HQ Extreme/ })
  await expect(hqOption).toBeEnabled()

  const menuBox = await menu.boundingBox()
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1440)
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(900)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  const itemOverlap = await menu.locator('[role="radio"]').evaluateAll(buttons =>
    buttons.some(btn => {
      const children = Array.from(btn.children) as HTMLElement[]
      if (children.length < 2) return false
      const left = children[0].getBoundingClientRect()
      const right = children[1].getBoundingClientRect()
      return left.right > right.left + 1
    })
  )
  expect(itemOverlap).toBe(false)

  await hqOption.click()

  await expect(menu).toHaveCount(0)
  await expect(qualityBtn).toContainText('HQ Extreme')
  await expect(page.getByText('Switched to HQ Extreme')).toBeVisible()
  await expect.poll(async () => (await getAudio(page))?.src || '').toContain('br=320')
  expect((await getAudio(page))?.currentTime ?? 0).toBeGreaterThanOrEqual(4.0)
  await expectPlaying(page)
  expect(nonProbeStreams.some(u => u.includes('br=320'))).toBe(true)

  await expect.poll(() => page.evaluate(() => document.activeElement?.id || '')).toBe('footer-quality-btn')
  await testInfo.attach('quality-desktop-hq', {
    body: await page.screenshot({ path: testInfo.outputPath('quality-desktop-hq.png') }),
    contentType: 'image/png',
  })

  // Pause and switch to Standard: paused state must be preserved while br=128 applies.
  await page.locator('footer [data-testid="player-toggle"]').click()
  await expectPaused(page)
  await qualityBtn.click()
  await expect(menu.getByRole('radio', { name: /HQ Extreme/ })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('radio', { name: /Standard/ }).click()
  await expect(menu).toHaveCount(0)
  await expect(qualityBtn).toContainText('Standard')
  await expect.poll(async () => (await getAudio(page))?.src || '').toContain('br=128')
  await expectPaused(page)
})

test('desktop keyboard navigation (ArrowDown/ArrowUp/Enter/Escape) operates quality menu', async ({ page }) => {
  await playSearchTrack(page, '9002')

  const qualityBtn = page.locator('#footer-quality-btn')
  await qualityBtn.focus()
  await page.keyboard.press('ArrowDown')

  const menu = page.locator('#quality-menu-panel')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.activeElement?.id || '')).toBe('footer-quality-btn')

  // Open via keyboard, navigate to HQ Extreme, confirm with Enter
  await page.keyboard.press('ArrowDown')
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  await expect(menu).toHaveCount(0)
  await expect(qualityBtn).toContainText('HQ Extreme')
  await expect.poll(async () => (await getAudio(page))?.src || '').toContain('br=320')
  await expectPlaying(page)
})

test('failed quality switch rolls back stream URL and badge, keeps menu open, and shows error toast', async ({ page }, testInfo) => {
  await playSearchTrack(page, '9002')
  const initialSrc = (await getAudio(page))?.src || ''

  const qualityBtn = page.locator('#footer-quality-btn')
  await qualityBtn.click()
  const menu = page.locator('#quality-menu-panel')
  await expect(menu.getByRole('radio', { name: /Standard/ })).toBeEnabled()
  await page.keyboard.press('Escape')

  await page.route('**/api/music/stream?**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.headers()['range'] !== 'bytes=0-0' && url.searchParams.get('br') === '128') {
      return route.fulfill({ status: 503, json: { error: { code: 'QUALITY_UNAVAILABLE' } } })
    }
    return route.fallback()
  })

  await qualityBtn.click()
  await menu.getByRole('radio', { name: /Standard/ }).click()

  await expect(page.getByText(/Failed to switch quality/i)).toBeVisible()
  await expect(menu).toBeVisible()
  await expect(qualityBtn).toHaveAttribute('aria-busy', 'false')
  await expect(qualityBtn).toContainText('SQ Lossless')
  await expect(menu.getByRole('radio', { name: /SQ Lossless/ })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await getAudio(page))?.src || '').toBe(initialSrc)
  await expectPlaying(page)

  // Subsequent switch to a healthy tier (HQ Extreme) still succeeds cleanly after rollback.
  await menu.getByRole('radio', { name: /HQ Extreme/ }).click()
  await expect(menu).toHaveCount(0)
  await expect(qualityBtn).toContainText('HQ Extreme')
  await expect.poll(async () => (await getAudio(page))?.src || '').toContain('br=320')
  await expectPlaying(page)

  await testInfo.attach('quality-rollback-error', {
    body: await page.screenshot({ path: testInfo.outputPath('quality-rollback-error.png') }),
    contentType: 'image/png',
  })
})

test('dedupes repeated clicks, cancels stale quality switch on rapid change or track switch, and disables unavailable tiers', async ({ page }) => {
  let slowHqCount = 0
  let delayHq = false
  let releaseSlowHq: (() => void) | null = null
  let forceEqualProbeSizes = false

  await page.route('**/api/music/stream?**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    if (forceEqualProbeSizes && req.headers()['range'] === 'bytes=0-0' && url.searchParams.get('id') === '9004') {
      return route.fulfill({
        status: 206,
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Range': 'bytes 0-0/160044',
          'Content-Length': '1',
          'Accept-Ranges': 'bytes',
        },
        body: Buffer.from([0]),
      })
    }
    if (delayHq && req.headers()['range'] !== 'bytes=0-0' && url.searchParams.get('id') === '9002' && url.searchParams.get('br') === '320') {
      slowHqCount++
      await new Promise<void>(resolve => { releaseSlowHq = resolve })
    }
    return route.fallback().catch(() => {})
  })

  await playSearchTrack(page, '9002')
  const qualityBtn = page.locator('#footer-quality-btn')
  const menu = page.locator('#quality-menu-panel')
  await qualityBtn.click()
  await expect(menu.getByRole('radio', { name: /HQ Extreme/ })).toBeEnabled()

  // Repeated clicks on in-flight HQ Extreme must dedupe, show loading state, and clicking Standard supersedes it.
  delayHq = true
  await menu.getByRole('radio', { name: /HQ Extreme/ }).click()
  await expect.poll(() => slowHqCount).toBe(1)
  await expect(qualityBtn).toHaveAttribute('aria-busy', 'true')
  await expect(menu.getByRole('radio', { name: /HQ Extreme/ })).toHaveAttribute('aria-busy', 'true')
  await menu.getByRole('radio', { name: /HQ Extreme/ }).click()
  await page.waitForTimeout(100)
  expect(slowHqCount).toBe(1)

  await menu.getByRole('radio', { name: /Standard/ }).click()
  await expect(menu).toHaveCount(0)
  await expect(qualityBtn).toHaveAttribute('aria-busy', 'false')
  await expect(qualityBtn).toContainText('Standard')
  await expect.poll(async () => (await getAudio(page))?.src || '').toContain('br=128')

  // Release the stale gated HQ request and ensure Standard remains active.
  releaseSlowHq?.()
  releaseSlowHq = null
  await page.waitForTimeout(200)
  await expect(qualityBtn).toContainText('Standard')
  expect((await getAudio(page))?.src || '').toContain('br=128')

  // Track switch cancels an in-flight quality switch and resets loading state cleanly.
  await qualityBtn.click()
  await menu.getByRole('radio', { name: /HQ Extreme/ }).click()
  await expect.poll(() => releaseSlowHq !== null).toBe(true)
  await expect(qualityBtn).toHaveAttribute('aria-busy', 'true')
  await page.getByTestId('song-row-9003').click()
  await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Three')
  await expect(qualityBtn).toHaveAttribute('aria-busy', 'false')
  await expectPlaying(page)
  releaseSlowHq?.()
  releaseSlowHq = null
  await page.waitForTimeout(200)
  await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Three')
  expect((await getAudio(page))?.src || '').toContain('id=9003')

  // Probe returning identical sizes disables higher lossless/HQ tiers cleanly.
  delayHq = false
  forceEqualProbeSizes = true
  await page.getByTestId('song-row-9004').click()
  await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Four')
  await qualityBtn.click()
  await expect(menu.getByRole('radio', { name: /SQ Lossless/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(menu.getByRole('radio', { name: /HQ Extreme/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(menu.getByRole('radio', { name: /Standard/ })).toBeEnabled()
  await expect(menu).toContainText('Source does not provide a higher quality')
})

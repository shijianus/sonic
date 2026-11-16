import { test, expect, expectPlaying, getAudio, horizontalOverflow } from '../fixtures'

for (const width of [360, 390]) {
  test.describe(`mobile quality settings & layout ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    test('quality options fit viewport without overflow, persist selection across reload, and drive mobile playback quality', async ({ page }, testInfo) => {
      const streamUrls: string[] = []
      page.on('request', req => {
        if (req.url().includes('/api/music/stream')) streamUrls.push(req.url())
      })

      await page.goto('/#/settings')
      const qualityHeading = page.getByRole('heading', { name: 'Audio Quality', exact: true })
      await expect(qualityHeading).toBeVisible()

      const extremeBtn = page.getByRole('button', { name: 'Extreme', exact: true })
      const losslessBtn = page.getByRole('button', { name: 'Lossless', exact: true })
      await expect(extremeBtn).toBeVisible()
      await expect(losslessBtn).toBeVisible()

      for (const btn of [extremeBtn, losslessBtn]) {
        const box = await btn.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.width).toBeGreaterThanOrEqual(80)
        expect(box!.height).toBeGreaterThanOrEqual(36)
        expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

      await extremeBtn.click()
      await expect(extremeBtn).toHaveClass(/active/)
      await testInfo.attach(`mobile-quality-settings-${width}`, {
        body: await page.screenshot({ path: testInfo.outputPath(`mobile-quality-settings-${width}.png`) }),
        contentType: 'image/png',
      })

      await page.reload()
      await expect(page.getByRole('button', { name: 'Extreme', exact: true })).toHaveClass(/active/)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

      await page.goto('/#/search?q=sonic')
      await page.getByTestId('search-song-results').getByTestId('song-row-9002').click()
      await expectPlaying(page)
      await expect(page.locator('#quality-menu-panel')).toHaveCount(0)
      await expect.poll(async () => (await getAudio(page))?.src || '').toContain('quality=exhigh')
      expect(streamUrls.some(url => url.includes('quality=exhigh'))).toBe(true)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    })

    test('playback on mobile keeps mini player layout clean without desktop quality popover leak', async ({ page }) => {
      await page.goto('/#/search?q=sonic')
      await page.getByTestId('search-song-results').getByTestId('song-row-9002').click()
      await expectPlaying(page)
      await expect(page.locator('#quality-menu-panel')).toHaveCount(0)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    })
  })
}

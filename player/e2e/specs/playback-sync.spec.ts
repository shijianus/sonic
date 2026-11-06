import { test, expect, getAudio, expectPlaying, expectPaused } from '../fixtures'

test('音频、歌词与播放器展示在同一曲目内同步推进，切歌后同时更新', async ({ page }, testInfo) => {
  await page.goto('/#/search?q=sonic')
  await page.getByTestId('song-row-9001').click()

  const title = page.getByTestId('now-playing-title')
  const footerInfo = page.locator('#footer-song-info')
  await expect(title).toHaveText('Test Song One')
  await expect(footerInfo).toContainText('Tester A')
  await expectPlaying(page)

  // Let the real audio clock advance past the first line, open the lyric view
  // while playing (so its entrance animation runs), then freeze for a
  // deterministic clock/lyric comparison.
  await expect.poll(async () => (await getAudio(page))?.currentTime ?? 0, { timeout: 12000 }).toBeGreaterThan(4)
  await page.locator('#footer-cover').click()
  const dialog = page.getByRole('dialog', { name: /full-screen music player/i })
  const lyrics = page.getByTestId('lyrics-container')
  await expect(lyrics).toBeVisible()
  await expect(lyrics).toContainText('Test Song One line 1')
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click()
  await expectPaused(page)
  await page.waitForTimeout(600)

  const sync = await page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>('#audioPlayer')
    const lines = [...document.querySelectorAll<HTMLElement>('.lyric-line')]
    const currentIndex = lines.findIndex(line => line.classList.contains('current'))
    const time = audio?.currentTime ?? 0
    let expectedIndex = 0
    lines.forEach((line, index) => {
      if (Number(line.dataset.time || 0) <= time + 0.25) expectedIndex = index
    })
    const opacity = currentIndex >= 0 ? getComputedStyle(lines[currentIndex]).opacity : '0'
    return { currentIndex, expectedIndex, time, currentText: lines[currentIndex]?.textContent || '', opacity }
  })
  expect(sync.currentIndex).toBeGreaterThanOrEqual(1)
  expect(Math.abs(sync.currentIndex - sync.expectedIndex)).toBeLessThanOrEqual(1)
  expect(sync.currentText.replace(/\s+/g, ' ')).toContain('Test Song One line')
  expect(Number(sync.opacity)).toBeGreaterThan(0.5)

  if (process.env.SONIC_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.SONIC_EVIDENCE_DIR}/${testInfo.project.name}-playback-lyrics-sync.png` })
  }

  await dialog.getByRole('button', { name: 'Play', exact: true }).click()
  await expectPlaying(page)
  await dialog.getByRole('button', { name: 'Next track' }).click()

  await expect(title).toHaveText('Test Song Two')
  await expect(footerInfo).toContainText('Tester B')
  await expect(lyrics).toContainText('Test Song Two line 1')
  await expect(lyrics).not.toContainText('Test Song One line')
  await expect.poll(async () => (await getAudio(page))?.src ?? '', { timeout: 10000 }).toContain('id=9002')
  await expectPlaying(page)
})

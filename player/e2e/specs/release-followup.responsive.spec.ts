import type { Locator } from '@playwright/test'
import { test, expect, getAudio, expectPaused, expectPlaying, horizontalOverflow } from '../fixtures'

async function expectCompleteText(locator: Locator, text: string) {
  await expect(locator).toHaveText(text)
  const layout = await locator.evaluate(el => {
    const style = getComputedStyle(el)
    return { width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp, lineHeight: parseFloat(style.lineHeight) }
  })
  expect(layout.whiteSpace).not.toBe('nowrap')
  expect(layout.textOverflow).not.toBe('ellipsis')
  expect(['none', '']).toContain(layout.lineClamp)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1)
  expect(layout.height).toBeGreaterThan(layout.lineHeight * 1.5)
}

for (const width of [360, 390]) {
  test.describe(`release follow-up mobile ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    for (const tab of [
      { label: 'Songs', type: '1', result: '[data-testid="search-song-results"] [data-testid="song-row-9002"]', text: 'Recovered mobile song' },
      { label: 'Playlists', type: '1000', result: 'a[href="#/playlist/72001"]', text: 'Recovered mobile playlist' },
      { label: 'MV', type: '1004', result: 'a[href="#/mv-player/72002"]', text: 'Recovered mobile MV' },
    ]) {
      test(`${tab.label}: HTTP 503 → retry → results retains the selected tab`, async ({ page }, testInfo) => {
        let recovered = false
        await page.route('**/api/sonic/search/nexus?**', route => route.fulfill({ json: { data: { tracks: [], total: 0 } } }))
        await page.route('**/api/cloudsearch?**', route => {
          const type = new URL(route.request().url()).searchParams.get('type')
          if (type === tab.type && !recovered) return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_ERROR' } } })
          return route.fulfill({ json: { code: 200, result: {
            songs: [{ id: 9002, name: 'Recovered mobile song', ar: [{ id: 1, name: 'Fixture' }], dt: 20000 }], songCount: 1,
            playlists: [{ id: 72001, name: 'Recovered mobile playlist', coverImgUrl: '', trackCount: 4 }], playlistCount: 1,
            mvs: [{ id: 72002, name: 'Recovered mobile MV', artistName: 'Fixture', cover: '', duration: 20000 }], mvCount: 1,
          } } })
        })
        await page.goto('/#/search?q=release-mobile-retry')
        const tabs = page.locator('.mobile-search-tabs')
        const selectedTab = tabs.getByRole('button', { name: tab.label, exact: true })
        await selectedTab.click()
        const slide = page.locator('.swiper-slide-active')
        await expect(slide.getByTestId('search-error')).toContainText(/music service returned an error/i)
        const before = await tabs.boundingBox()
        await testInfo.attach(`${tab.label}-${width}-error`, { body: await page.screenshot({ path: testInfo.outputPath(`${tab.label}-${width}-error.png`) }), contentType: 'image/png' })
        recovered = true
        await slide.getByTestId('search-retry').click()
        await expect(selectedTab).toHaveClass(/tab-button-active/)
        await expect(slide.locator(tab.result)).toContainText(tab.text)
        await expect(slide.getByTestId('search-error')).toHaveCount(0)
        const after = await tabs.boundingBox()
        expect(after).toEqual(before)
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
        await testInfo.attach(`${tab.label}-${width}-recovered`, { body: await page.screenshot({ path: testInfo.outputPath(`${tab.label}-${width}-recovered.png`) }), contentType: 'image/png' })
      })
    }

    test('slow URL load → mini Cancel → late successful response never autoplays', async ({ page }, testInfo) => {
      let release!: () => void
      const responseGate = new Promise<void>(resolve => { release = resolve })
      let requested = false
      let delivered = false
      let cancelled = false
      const streamRequestsAfterCancel: string[] = []
      page.on('request', request => {
        if (cancelled && request.method() === 'GET' && new URL(request.url()).pathname === '/api/music/stream') {
          streamRequestsAfterCancel.push(request.url())
        }
      })
      await page.route('**/api/sonic/search/nexus?**', route => route.fulfill({ json: { data: { tracks: [], total: 0 } } }))
      await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: {
        songs: [{ id: 9001, name: 'Slow mobile track', ar: [{ id: 1, name: 'Fixture' }], dt: 20000 }], songCount: 1,
        playlists: [], playlistCount: 0, mvs: [], mvCount: 0,
      } } }))
      await page.route('**/api/song/url/v1?**', async route => {
        requested = true
        await responseGate
        await route.fulfill({ json: { data: [{ url: '/api/music/stream?id=9001' }] } })
        delivered = true
      })
      await page.goto('/#/search?q=release-slow-mobile')
      await page.getByTestId('search-song-results').getByTestId('song-row-9001').click()
      await expect.poll(() => requested).toBe(true)
      const toggle = page.locator('.miniplayer-root').getByTestId('player-toggle')
      await expect(toggle).toBeEnabled()
      await expect(toggle).toHaveAttribute('aria-label', 'Cancel')
      await expect(toggle).toHaveAttribute('aria-busy', 'true')
      const before = await toggle.boundingBox()
      await testInfo.attach(`mini-cancellable-loading-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`mini-cancellable-loading-${width}.png`) }), contentType: 'image/png' })
      await toggle.click()
      cancelled = true
      await expect(toggle).toHaveAttribute('aria-label', 'Play')
      await expect(toggle).toHaveAttribute('aria-busy', 'false')
      release()
      await expect.poll(() => delivered).toBe(true)
      // Allow both the late URL handler and any accidental media-start callback to settle.
      await page.waitForTimeout(1200)
      await expectPaused(page)
      expect((await getAudio(page))?.currentTime ?? 0).toBeLessThan(0.1)
      expect(streamRequestsAfterCancel).toEqual([])
      await expect(page.getByTestId('now-playing-title')).toHaveText('Slow mobile track')
      const after = await toggle.boundingBox()
      expect(after?.width).toBe(before?.width)
      expect(after?.height).toBe(before?.height)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
      await testInfo.attach(`mini-cancelled-after-late-response-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`mini-cancelled-after-late-response-${width}.png`) }), contentType: 'image/png' })
      await toggle.click()
      await expectPlaying(page)
    })

    test('expanded cover and lyrics views show complete long titles and artists without horizontal overflow', async ({ page }, testInfo) => {
      // Four screenshots and real playback interactions share this case's budget.
      testInfo.setTimeout(90_000)
      const title = '完整曲名 Long title with every word visible — extended acoustic concert final movement'
      const artist = 'Sonic Acoustic Orchestra / 国际合作演出者 / ALongUnbrokenArtistIdentifierThatMustWrapWithoutOverflow'
      const trackId = '9400'
      await page.route('**/api/sonic/search/nexus?**', route => route.fulfill({ json: { data: { tracks: [{ platformId: trackId, title, artist, duration: 120_000, streamUrl: `/api/music/stream?id=${trackId}` }], total: 1 } } }))
      await page.route('**/api/sonic/lyrics/nexus?**', route => route.fulfill({ json: {
        brand: 'Sonic',
        data: { syncedLyrics: [
          { startMs: 0, text: 'Morning tide' },
          { startMs: 7_000, text: 'Crossing the harbor' },
          { startMs: 14_000, text: 'Lights on shore' },
        ] },
      } }))
      await page.goto('/#/search?q=release-mobile-long-title')
      await page.getByTestId('search-song-results').getByTestId(`song-row-${trackId}`).click()
      await expectPlaying(page)
      await page.locator('.miniplayer-cover').click()
      const dialog = page.getByRole('dialog', { name: /full-screen music player/i })
      await expect(dialog).toBeVisible()
      const album = dialog.locator('.album-area')
      const controls = dialog.locator('.controls-area')
      // GSAP still animates the entrance with reduced motion; measure after it settles.
      await expect.poll(() => dialog.evaluate(el => el.getBoundingClientRect().top)).toBe(0)
      await expect(controls).toBeInViewport({ ratio: 1 })
      const controlsBefore = await controls.boundingBox()
      const titleNode = album.getByRole('heading')
      await titleNode.scrollIntoViewIfNeeded()
      await expectCompleteText(titleNode, title)
      const artistNode = album.getByText(artist, { exact: true })
      await expectCompleteText(artistNode, artist)
      expect(await album.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
      expect(await controls.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      await testInfo.attach(`expanded-complete-title-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`expanded-complete-title-${width}.png`) }), contentType: 'image/png' })
      // A wrapping element can still be clipped by the album scroller. Read its end,
      // and prove the fixed playback controls do not move while metadata is scrolled.
      await artistNode.scrollIntoViewIfNeeded()
      await expect(artistNode).toBeInViewport({ ratio: 1 })
      const artistVisibility = await artistNode.evaluate(el => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0)
        const viewport = el.closest('.album-area')!.getBoundingClientRect()
        return { firstTop: lines[0].top, lastBottom: lines[lines.length - 1].bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom }
      })
      expect(artistVisibility.firstTop).toBeGreaterThanOrEqual(artistVisibility.viewportTop - 1)
      expect(artistVisibility.lastBottom).toBeLessThanOrEqual(artistVisibility.viewportBottom + 1)
      expect(await controls.boundingBox()).toEqual(controlsBefore)
      await testInfo.attach(`expanded-complete-artist-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`expanded-complete-artist-${width}.png`) }), contentType: 'image/png' })
      for (const button of await controls.getByRole('button').all()) {
        await expect(button).toBeEnabled()
        await expect(button).toBeInViewport({ ratio: 1 })
        await button.click({ trial: true })
      }
      await expect(controls.getByRole('slider', { name: 'Playback progress', exact: true })).toBeInViewport({ ratio: 1 })
      await testInfo.attach(`expanded-controls-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`expanded-controls-${width}.png`) }), contentType: 'image/png' })
      await controls.getByRole('button', { name: 'Pause', exact: true }).click()
      await expectPaused(page)
      await controls.getByRole('button', { name: 'Play', exact: true }).click()
      await expectPlaying(page)
      await titleNode.scrollIntoViewIfNeeded({ timeout: 10_000 })
      await expect(titleNode).toBeInViewport()
      await titleNode.click({ timeout: 10_000 })
      await expect(album).toBeHidden()
      const lyricsTitle = dialog.getByRole('heading', { name: title, exact: true }).filter({ visible: true })
      await expectCompleteText(lyricsTitle, title)
      await expectCompleteText(dialog.getByText(artist, { exact: true }).filter({ visible: true }), artist)
      expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      await controls.getByRole('button', { name: 'Pause', exact: true }).click()
      await expectPaused(page)
      const lyricLines = dialog.locator('.lyrics-container .lyric-line')
      await expect(lyricLines).toHaveCount(3)
      const activeLyric = dialog.locator('.lyrics-container .lyric-line.current')
      const progress = controls.getByRole('slider', { name: 'Playback progress', exact: true })
      await progress.press('Home')
      await expect(activeLyric).toContainText('Morning tide')
      const bounds = await progress.boundingBox()
      expect(bounds).not.toBeNull()
      const duration = (await getAudio(page))?.duration
      expect(duration).toBeCloseTo(120)
      await progress.tap({ position: { x: bounds!.width * 10 / duration!, y: bounds!.height / 2 } })
      await expect.poll(async () => (await getAudio(page))?.currentTime ?? 0).toBeGreaterThan(9)
      expect((await getAudio(page))?.currentTime ?? 0).toBeLessThan(11)
      await expect(activeLyric).toContainText('Crossing the harbor')
      await expect(activeLyric).toBeInViewport()
      await testInfo.attach(`lyrics-complete-title-${width}`, { body: await page.screenshot({ path: testInfo.outputPath(`lyrics-complete-title-${width}.png`) }), contentType: 'image/png' })
    })
  })
}

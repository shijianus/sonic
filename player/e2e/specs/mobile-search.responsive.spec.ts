import { test, expect, expectPaused, expectPlaying, getAudio, horizontalOverflow } from '../fixtures'

// These run in the mobile Chromium project; routes are deterministic local fixtures.
for (const width of [360, 390]) {
  test.describe(`移动搜索错误反馈 ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    for (const failure of [429, 403, 503, 'network'] as const) {
      test(`nexus ${failure} 与真实空结果区分，重试可恢复`, async ({ page }, testInfo) => {
        let recovered = false
        let requests = 0
        await page.route('**/api/sonic/search/nexus?**', async route => {
          requests++
          if (recovered) {
            await route.fulfill({ json: { data: { tracks: [{ platformId: 'mobile-retry', title: 'Recovered mobile search', artist: 'Fixture', duration: 120 }], total: 1 } } })
          } else if (failure === 'network') {
            await route.abort('connectionfailed')
          } else {
            // A JSON error body must not be consumed as a successful empty response.
            await route.fulfill({ status: failure, json: { error: { code: failure === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR' } } })
          }
        })
        await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 } } }))
        await page.goto('/#/search?q=mobile-failure')
        const slide = page.locator('.swiper-slide-active')
        const error = slide.getByTestId('search-error')
        await expect(error).toBeVisible()
        await expect(error).toContainText(failure === 429 ? /too many requests/i : failure === 'network' ? /network error/i : /music service returned an error/i)
        await expect(slide.locator('.empty-state')).toHaveCount(0)
        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
        await testInfo.attach(`mobile-search-${failure}-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
        const before = requests
        recovered = true
        await error.getByTestId('search-retry').click()
        await expect(page.getByTestId('song-row-mobile-retry')).toBeVisible()
        expect(requests).toBeGreaterThan(before)
        await expect(slide.getByTestId('search-error')).toHaveCount(0)
      })
    }

    test('cloudsearch 错误覆盖歌曲、歌单和 MV，重试保持所选 Tab', async ({ page }) => {
      let recovered = false
      await page.route('**/api/sonic/search/nexus?**', route => route.fulfill({ json: { data: { tracks: [], total: 0 } } }))
      await page.route('**/api/cloudsearch?**', route => route.fulfill(recovered
        ? { json: { code: 200, result: { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 } } }
        : { status: 503, json: { error: { code: 'UPSTREAM_ERROR' } } }))
      await page.goto('/#/search?q=mobile-fallback')
      const tabs = page.locator('.mobile-search-tabs button')
      const activeSlide = page.locator('.swiper-slide-active')
      for (let index = 0; index < 3; index++) {
        await tabs.nth(index).click()
        await expect(activeSlide.getByTestId('search-error')).toBeVisible()
        await expect(activeSlide.locator('.empty-state')).toHaveCount(0)
      }
      recovered = true
      await activeSlide.getByTestId('search-retry').click()
      await expect(tabs.nth(2)).toHaveClass(/tab-button-active/)
      await expect(activeSlide.locator('.empty-state')).toContainText('No results found')
      await expect(page.getByTestId('search-error')).toHaveCount(0)
    })

    test('长曲名在结果与播放器完整换行且控件保持可用', async ({ page }, testInfo) => {
      const title = 'Sonic 完整曲名验证 · Long title with every word visible (440Hz)'
      await page.route('**/api/sonic/search/nexus?**', route => route.fulfill({
        json: { data: { tracks: [{ platformId: '9001', title, artist: 'Sonic Acoustic Lab', album: 'Controlled Beta Test Suite', duration: 20000 }], total: 1 } },
      }))
      await page.goto('/#/search?q=long-title')
      const row = page.getByTestId('search-song-results').getByTestId('song-row-9001')
      const name = row.locator('.song-name')
      await expect(name).toHaveText(title)
      await row.click()
      const playing = page.getByTestId('now-playing-title')
      await expect(playing).toHaveText(title)
      for (const text of [name, playing]) {
        const layout = await text.evaluate(el => {
          const style = getComputedStyle(el)
          return { width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp }
        })
        expect(layout.whiteSpace).not.toBe('nowrap')
        expect(layout.textOverflow).not.toBe('ellipsis')
        expect(layout.lineClamp).not.toBe('1')
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1)
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
      await testInfo.attach(`mobile-full-title-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    })

    test('真正空结果仍显示空态，没有重试错误面板', async ({ page }) => {
      await page.goto('/#/search?q=empty')
      const activeSlide = page.locator('.swiper-slide-active')
      await expect(activeSlide.locator('.empty-state')).toContainText('No results found')
      await expect(page.getByTestId('search-error')).toHaveCount(0)
      await expect(page.getByTestId('search-retry')).toHaveCount(0)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    })
  })
}

test('mobile suggestions disappear when the query changes and return for the current query', async ({ page }, testInfo) => {
  const pending = Promise.withResolvers<void>()
  const deliver = Promise.withResolvers<void>()
  await page.route('**/api/search/suggest?**', async route => {
    const term = new URL(route.request().url()).searchParams.get('keywords')
    if (term === 'new-mobile') {
      pending.resolve()
      await deliver.promise
    }
    const keyword = term === 'old-mobile' ? 'Obsolete mobile suggestion' : 'Current mobile suggestion'
    return route.fulfill({ json: { code: 200, result: { allMatch: [{ keyword }] } } })
  })

  try {
    await page.goto('/#/search')
    const input = page.locator('input.search-input')
    await input.fill('old-mobile')
    const obsolete = page.getByRole('button', { name: 'Obsolete mobile suggestion' })
    await expect(obsolete).toBeVisible()
    await input.fill('new-mobile')
    await pending.promise
    await expect(obsolete).toHaveCount(0)
    deliver.resolve()
    await expect(page.getByRole('button', { name: 'Current mobile suggestion' })).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    await testInfo.attach('current-mobile-suggestion', { body: await page.screenshot(), contentType: 'image/png' })
  } finally {
    deliver.resolve()
  }
})

for (const action of ['select a song', 'pause'] as const) {
  test(`a pending mobile playlist does not replace playback after ${action}`, async ({ page }) => {
    const pending = Promise.withResolvers<void>()
    const deliver = Promise.withResolvers<void>()
    await page.route('**/api/cloudsearch?**', route => {
      if (new URL(route.request().url()).searchParams.get('type') !== '1000') return route.continue()
      return route.fulfill({ json: { code: 200, result: {
        playlists: [{ id: 8001, name: 'Pending playlist', trackCount: 1, coverImgUrl: '' }], playlistCount: 1,
      } } })
    })
    await page.route('**/api/playlist/track/all?**', async route => {
      pending.resolve()
      await deliver.promise
      return route.fulfill({ json: { songs: [{ id: 9003, name: 'Old playlist song', dt: 20000 }], songCount: 1 } })
    })

    try {
      await page.goto('/#/search?q=rock')
      const row = page.getByTestId('search-song-results').getByTestId('song-row-9002')
      if (action === 'pause') {
        await row.click()
        await expectPlaying(page)
      }
      await page.getByRole('button', { name: 'Playlists', exact: true }).click()
      const playlist = page.getByRole('button', { name: 'Play: Pending playlist' })
      await playlist.click()
      await pending.promise
      if (action === 'select a song') {
        await page.getByRole('button', { name: 'Songs', exact: true }).click()
        await row.click()
        await expectPlaying(page)
      } else {
        await page.getByTestId('player-toggle').click()
        await expectPaused(page)
      }
      const response = page.waitForResponse(result => result.url().includes('/api/playlist/track/all?') && result.status() === 200)
      deliver.resolve()
      await response
      await expect(playlist.locator('.animate-spin')).toHaveCount(0)
      await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')
      const media = await getAudio(page)
      expect(media?.src).toContain('id=9002')
      expect(media?.paused).toBe(action === 'pause')
    } finally {
      deliver.resolve()
    }
  })
}

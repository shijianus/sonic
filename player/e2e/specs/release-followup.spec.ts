import type { Locator } from '@playwright/test'
import { test, expect, expectPaused, expectPlaying, horizontalOverflow } from '../fixtures'

const emptySearch = { code: 200, result: { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 } }
const track = { platformId: '9002', title: 'Recovered song', artist: 'Fixture artist', duration: 20000, streamUrl: '/api/music/stream?id=9002' }

for (const tab of [
  { label: 'Songs', type: '1', result: '[data-testid="song-row-9002"]', text: 'Recovered song' },
  { label: 'Playlists', type: '1000', result: 'a[href="#/playlist/71001"]', text: 'Recovered playlist' },
  { label: 'MV', type: '1004', result: 'a[href="#/mv-player/71002"]', text: 'Recovered MV' },
]) {
  for (const failure of [403, 429, 503, 'network'] as const) {
    test(`desktop ${tab.label}: ${failure} → retry → results`, async ({ page }, testInfo) => {
      let recovered = false
      let requests = 0
      await page.route('**/api/sonic/search/smart?**', route => route.fulfill({ json: { data: { tracks: [], total: 0, suggestions: [] } } }))
      await page.route('**/api/sonic/search/nexus?**', async route => {
        if (tab.type !== '1') return route.fulfill({ json: { data: { tracks: [], total: 0 } } })
        requests++
        if (recovered) return route.fulfill({ json: { data: { tracks: [track], total: 1 } } })
        if (failure === 'network') return route.abort('connectionfailed')
        // Deliberately include success-shaped data: a non-2xx response must still fail.
        return route.fulfill({ status: failure, json: { data: { tracks: [track], total: 1 } } })
      })
      await page.route('**/api/cloudsearch?**', async route => {
        const type = new URL(route.request().url()).searchParams.get('type')
        if (tab.type === '1' || type !== tab.type) return route.fulfill({ json: emptySearch })
        requests++
        if (!recovered) {
          if (failure === 'network') return route.abort('connectionfailed')
          return route.fulfill({ status: failure, json: { error: { code: failure === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR' } } })
        }
        return route.fulfill({ json: {
          code: 200,
          result: tab.type === '1000'
            ? { playlists: [{ id: 71001, name: tab.text, coverImgUrl: '', trackCount: 12, playCount: 42, creator: { nickname: 'Fixture' } }], playlistCount: 1 }
            : { mvs: [{ id: 71002, name: tab.text, artistName: 'Fixture', cover: '', duration: 20000, playCount: 42 }], mvCount: 1 },
        } })
      })
      await page.goto('/#/search?q=release-retry')
      const tabButton = page.getByRole('button', { name: tab.label, exact: true })
      await tabButton.click()
      const error = page.getByTestId('search-error')
      await expect(error).toBeVisible()
      await expect(error).toContainText(failure === 429 ? /too many requests/i : failure === 'network' ? /network error/i : /music service returned an error/i)
      // offsetWidth/Height measure layout, excluding floating-point compositor transforms.
      const before = await tabButton.evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }))
      await testInfo.attach(`${tab.label}-${failure}-error`, { body: await page.screenshot({ path: testInfo.outputPath(`${tab.label}-${failure}-error.png`) }), contentType: 'image/png' })
      const previousRequests = requests
      recovered = true
      await error.getByTestId('search-retry').click()
      await expect(page.locator(tab.result).first()).toContainText(tab.text)
      await expect(error).toHaveCount(0)
      expect(requests).toBeGreaterThan(previousRequests)
      const after = await tabButton.evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }))
      expect(after).toEqual(before)
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
      await testInfo.attach(`${tab.label}-${failure}-recovered`, { body: await page.screenshot({ path: testInfo.outputPath(`${tab.label}-${failure}-recovered.png`) }), contentType: 'image/png' })
    })
  }
}

test('desktop empty playlist and MV searches have an empty state, not an error or blank panel', async ({ page }) => {
  await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: emptySearch }))
  await page.goto('/#/search?q=empty')
  for (const label of ['Songs', 'Playlists', 'MV']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByText('No results found', { exact: true })).toBeVisible()
    await expect(page.getByTestId('search-error')).toHaveCount(0)
  }
})

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

test('desktop long title and artist wrap in rows and expanded player without horizontal overflow', async ({ page }, testInfo) => {
  const title = '完整曲名 Long title with every word visible — extended live recording from the Sonic acoustic concert, final movement'
  const artist = 'Sonic Acoustic Orchestra / International Guest Ensemble / 完整演出者名称 / ALongUnbrokenArtistIdentifierThatMustWrapWithoutOverflow'
  await page.route('**/api/sonic/search/smart?**', route => route.fulfill({ json: { data: { tracks: [{ ...track, title, artist }], total: 1, suggestions: [] } } }))
  await page.goto('/#/search?q=release-long-title')
  const row = page.getByTestId('song-row-9002').first()
  await expectCompleteText(row.getByRole('heading'), title)
  await expectCompleteText(row.locator('.song-col-artist'), artist)
  expect(await row.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  await testInfo.attach('desktop-complete-row', { body: await page.screenshot({ path: testInfo.outputPath('desktop-complete-row.png') }), contentType: 'image/png' })
  await row.getByRole('heading').click()
  await expectPlaying(page)
  await page.locator('#footer-cover').click()
  const dialog = page.getByRole('dialog', { name: /full-screen music player/i })
  await expect(dialog).toBeVisible()
  const heading = dialog.locator('.song-title')
  await heading.scrollIntoViewIfNeeded()
  await expectCompleteText(heading, title)
  await expectCompleteText(dialog.locator('.song-artist'), artist)
  expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await testInfo.attach('desktop-complete-expanded-player', { body: await page.screenshot({ path: testInfo.outputPath('desktop-complete-expanded-player.png') }), contentType: 'image/png' })
  const panel = dialog.locator('.player-left-panel')
  await panel.getByRole('button', { name: 'Add to playlist', exact: true }).scrollIntoViewIfNeeded()
  for (const button of await panel.getByRole('button').all()) {
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeEnabled()
    await expect(button).toBeInViewport({ ratio: 1 })
    await button.click({ trial: true })
  }
  await expect(panel.getByRole('slider', { name: 'Playback progress', exact: true })).toBeInViewport({ ratio: 1 })
  expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await testInfo.attach('desktop-expanded-controls', { body: await page.screenshot({ path: testInfo.outputPath('desktop-expanded-controls.png') }), contentType: 'image/png' })
  await panel.getByRole('button', { name: 'Pause', exact: true }).click()
  await expectPaused(page)
  await panel.getByRole('button', { name: 'Play', exact: true }).click()
  await expectPlaying(page)
  await panel.getByRole('button', { name: 'Pause', exact: true }).click()
  await expectPaused(page)
})

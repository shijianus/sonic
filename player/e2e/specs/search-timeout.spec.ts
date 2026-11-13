import type { Page } from '@playwright/test'
import { test, expect, expectPlaying, horizontalOverflow } from '../fixtures'

const attempt = { provider: 'qq', ok: false, errorCode: 'UPSTREAM_TIMEOUT' }
const timeoutMeta = { attempts: [attempt] }
const song = { platformId: '9001', title: 'Search recovery fixture', artist: 'Fixture', duration: 20 }
const empty = { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 }
const gateway = (tracks: Array<typeof song>, meta = {}, fallbackTracks: Array<typeof song> = []) => ({
  brand: 'Sonic',
  data: { tracks, total: tracks.length, fallbackTracks, fallbackUsed: fallbackTracks.length > 0 },
  meta,
})

const searchResults = (page: Page, mobile: boolean) => mobile ? page.locator('.swiper-slide-active') : page
const resultRow = (page: Page, mobile: boolean) =>
  (mobile ? page.getByTestId('search-song-results') : page).getByTestId('song-row-9001')

async function stubSearch(page: Page, mobile: boolean, reply: (url: URL) => ReturnType<typeof gateway>) {
  const primary = mobile ? 'nexus' : 'smart'
  await page.route('**/api/sonic/search/*?**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'suggest') return route.fallback()
    return route.fulfill({ json: url.pathname.endsWith(`/${primary}`) ? reply(url) : gateway([]) })
  })
  await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: empty } }))
}

test('a timed-out search keeps its retry panel when all fallbacks are empty and recovers', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile-chromium'
  let recovered = false
  const requests: URL[] = []
  await stubSearch(page, mobile, url => {
    requests.push(url)
    return recovered ? gateway([song]) : gateway([], timeoutMeta, mobile ? [] : [{ ...song, platformId: 'unrelated' }])
  })
  await page.goto('/#/search?q=search-timeout')

  const results = searchResults(page, mobile)
  const panel = results.getByTestId('search-error')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(/search timed out/i)
  await expect(results.getByText('No results found', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('song-row-unrelated')).toHaveCount(0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await info.attach('search-timeout', {
    body: await page.screenshot({ path: info.outputPath('search-timeout.png') }), contentType: 'image/png',
  })

  recovered = true
  await panel.getByTestId('search-retry').click()
  const row = resultRow(page, mobile)
  await expect(row).toBeVisible()
  await expect(panel).toHaveCount(0)
  expect(requests).toHaveLength(2)
  expect(requests.at(-1)?.searchParams.get('nocache')).toBe('1')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await row.click()
  await expectPlaying(page)
  await info.attach('search-recovered', {
    body: await page.screenshot({ path: info.outputPath('search-recovered.png') }), contentType: 'image/png',
  })
})

test('a partial timeout keeps matching songs visible without the retry panel', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile-chromium'
  await stubSearch(page, mobile, () => gateway([song], timeoutMeta))
  await page.goto('/#/search?q=search-partial')
  await expect(resultRow(page, mobile)).toBeVisible()
  await expect(page.getByTestId('search-error')).toHaveCount(0)
})

test('successful empty searches still use the ordinary empty state', async ({ page }, info) => {
  await stubSearch(page, info.project.name === 'mobile-chromium', () => gateway([], {
    attempts: [{ provider: 'qq', ok: false, error: 'Empty result set' }],
  }))
  await page.goto('/#/search?q=search-healthy-empty')
  const results = searchResults(page, info.project.name === 'mobile-chromium')
  await expect(results.getByText('No results found', { exact: true })).toBeVisible()
  await expect(page.getByTestId('search-retry')).toHaveCount(0)
})

test('the compatibility fallback can provide songs after a primary timeout', async ({ page }, info) => {
  const mobile = info.project.name === 'mobile-chromium'
  await stubSearch(page, mobile, () => gateway([], timeoutMeta))
  await page.route('**/api/cloudsearch?**', route => {
    if (new URL(route.request().url()).searchParams.get('type') !== '1') return route.fallback()
    return route.fulfill({ json: { code: 200, result: {
      songs: [{ id: 9001, name: song.title, ar: [{ id: 1, name: song.artist }], al: { id: 0, name: '' }, dt: 20000 }], songCount: 1,
    } } })
  })
  await page.goto('/#/search?q=search-fallback-recovery')
  await expect(resultRow(page, mobile)).toBeVisible()
  await expect(page.getByTestId('search-error')).toHaveCount(0)
})

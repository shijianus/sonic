import { test, expect } from '../fixtures'
import { chartFailure, chartSong, exerciseOfficialChartRetry, trendingPayload } from '../charts-degradation-fixtures'

test('desktop Trending labels a New Songs fallback only after a failure and retries the selected window', async ({ page }, testInfo) => {
  let recoverTrending = false
  let newSongRequests = 0
  const trendingWindows: (string | null)[] = []
  await page.route(url => url.pathname === '/api/sonic/recommend/trending', route => {
    const window = new URL(route.request().url()).searchParams.get('window')
    trendingWindows.push(window)
    if (window === '7d') return route.fulfill({ json: { data: { tracks: [] } } })
    if (!recoverTrending) return route.fulfill(chartFailure)
    return route.fulfill({ json: trendingPayload(8121, 'Recovered Trending fixture') })
  })
  await page.route(url => url.pathname === '/api/top/song', route => {
    newSongRequests++
    return route.fulfill({ json: { data: [chartSong(8122, 'New Songs fallback fixture')] } })
  })

  await page.goto('/#/charts')
  await expect(page.getByTestId('charts-empty')).toBeVisible()
  await expect(page.getByTestId('charts-error')).toHaveCount(0)
  const fallback = page.getByTestId('charts-fallback')
  await expect(fallback).toHaveCount(0)
  expect(newSongRequests).toBe(0)

  const window = page.getByRole('button', { name: '24h Hot', exact: true })
  await window.click()
  await expect(fallback).toBeVisible()
  await expect(fallback).toContainText(/new songs/i)
  await expect(page.getByTestId('song-row-8122')).toBeVisible()
  await expect(page.getByTestId('charts-empty')).toHaveCount(0)
  expect(newSongRequests).toBe(1)
  if (process.env.SONIC_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.SONIC_EVIDENCE_DIR}/${testInfo.project.name}-charts-fallback.png` })
  }

  recoverTrending = true
  await page.getByTestId('charts-retry').click()
  await expect(page.getByTestId('song-row-8121')).toBeVisible()
  await expect(page.getByTestId('song-row-8122')).toHaveCount(0)
  await expect(fallback).toHaveCount(0)
  await expect(window).toHaveAttribute('aria-pressed', 'true')
  expect(trendingWindows).toEqual(['7d', '24h', '24h'])
})

test('desktop official chart clears obsolete tracks, reports upstream failure and retries the selected chart', async ({ page }) => {
  await exerciseOfficialChartRetry(page)
})

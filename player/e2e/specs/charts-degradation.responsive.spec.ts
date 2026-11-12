import { test, expect, horizontalOverflow } from '../fixtures'
import { chartFailure, chartSong, exerciseOfficialChartRetry, trendingPayload } from '../charts-degradation-fixtures'

test('mobile charts clear tracks when switching in either direction and distinguish failures from empty results', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 })
  let trendingFails = false
  let newSongsFail = true
  const newSongsRequested = Promise.withResolvers<void>()
  const respondToNewSongs = Promise.withResolvers<void>()

  await page.route(url => url.pathname === '/api/sonic/recommend/trending', route => {
    if (trendingFails) return route.fulfill(chartFailure)
    const isEmpty = new URL(route.request().url()).searchParams.get('window') === 'surging'
    return route.fulfill({ json: isEmpty ? { data: { tracks: [] } } : trendingPayload(8131, 'Trending fixture') })
  })
  await page.route(url => url.pathname === '/api/top/song', async route => {
    if (newSongsFail) {
      newSongsRequested.resolve()
      await respondToNewSongs.promise
      return route.fulfill(chartFailure)
    }
    return route.fulfill({ json: { data: [chartSong(8132, 'New Songs fixture')] } })
  })

  try {
    await page.goto('/#/charts')
    const trendingTrack = page.getByTestId('song-row-8131')
    const newTrack = page.getByTestId('song-row-8132')
    const trending = page.getByRole('button', { name: 'Trending', exact: true })
    const newSongs = page.getByRole('button', { name: 'New Songs', exact: true })
    const error = page.getByTestId('charts-error')
    const empty = page.getByTestId('charts-empty')
    const retry = page.getByTestId('charts-retry')
    await expect(trendingTrack).toBeVisible()

    await newSongs.click()
    await newSongsRequested.promise
    await expect(trendingTrack).toHaveCount(0)
    respondToNewSongs.resolve()
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(empty).toHaveCount(0)
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    if (process.env.SONIC_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.SONIC_EVIDENCE_DIR}/${testInfo.project.name}-charts-error.png` })
    }

    newSongsFail = false
    await retry.click()
    await expect(newTrack).toBeVisible()
    await expect(newSongs).toHaveAttribute('aria-pressed', 'true')

    trendingFails = true
    await trending.click()
    await expect(error).toBeVisible()
    await expect(empty).toHaveCount(0)
    await expect(newTrack).toHaveCount(0)
    await expect(page.getByTestId('charts-fallback')).toHaveCount(0)

    trendingFails = false
    await retry.click()
    await expect(trendingTrack).toBeVisible()
    await expect(trending).toHaveAttribute('aria-pressed', 'true')
    await expect(error).toHaveCount(0)

    await page.getByRole('button', { name: 'Surging', exact: true }).click()
    await expect(empty).toBeVisible()
    await expect(error).toHaveCount(0)
    await expect(retry).toHaveCount(0)
    await expect(trendingTrack).toHaveCount(0)
  } finally {
    respondToNewSongs.resolve()
  }
})

test('mobile chart category changes ignore a late response for the previously selected category', async ({ page }) => {
  const newSongsRequested = Promise.withResolvers<void>()
  const respondToNewSongs = Promise.withResolvers<void>()
  await page.route(url => url.pathname === '/api/sonic/recommend/trending', route =>
    route.fulfill({ json: trendingPayload(8141, 'Current Trending fixture') }),
  )
  await page.route(url => url.pathname === '/api/top/song', async route => {
    newSongsRequested.resolve()
    await respondToNewSongs.promise
    return route.fulfill({ json: { data: [chartSong(8142, 'Obsolete New Songs fixture')] } })
  })

  try {
    await page.goto('/#/charts')
    const current = page.getByTestId('song-row-8141')
    await expect(current).toBeVisible()
    await page.getByRole('button', { name: 'New Songs', exact: true }).click()
    await newSongsRequested.promise
    await expect(current).toHaveCount(0)
    const trending = page.getByRole('button', { name: 'Trending', exact: true })
    await trending.click()
    await expect(current).toBeVisible()

    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/top/song')
    respondToNewSongs.resolve()
    expect(await (await lateResponse).finished()).toBeNull()
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(trending).toHaveAttribute('aria-pressed', 'true')
    await expect(current).toBeVisible()
    await expect(page.getByTestId('song-row-8142')).toHaveCount(0)
  } finally {
    respondToNewSongs.resolve()
  }
})

test('mobile official chart clears obsolete tracks, reports upstream failure and retries the selected chart', async ({ page }) => {
  await exerciseOfficialChartRetry(page)
})

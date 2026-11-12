import type { Page } from '@playwright/test'
import { expect } from './fixtures'

export const trendingPayload = (id: number, title: string) => ({
  data: { tracks: [{ platformId: String(id), title, artist: 'Chart fixture', duration: 20_000 }] },
})

export const chartSong = (id: number, name: string) => ({
  id,
  name,
  ar: [{ name: 'Chart fixture' }],
  dt: 20_000,
})

export const chartFailure = { status: 503, json: { error: { code: 'UPSTREAM_ERROR' } } }

export async function exerciseOfficialChartRetry(page: Page) {
  const charts = [{ id: 8101, name: 'Fixture Official One' }, { id: 8102, name: 'Fixture Official Two' }]
  const firstSong = chartSong(8111, 'First official chart song')
  const secondSong = chartSong(8112, 'Recovered official chart song')
  let recoverSecond = false
  const secondRequested = Promise.withResolvers<void>()
  const respondToSecond = Promise.withResolvers<void>()

  await page.route(url => url.pathname === '/api/toplist', route => route.fulfill({ json: { list: charts } }))
  await page.route(url => ['/api/playlist/track/all', '/api/playlist/detail'].includes(url.pathname), async route => {
    const isSecond = new URL(route.request().url()).searchParams.get('id') === String(charts[1].id)
    if (isSecond && !recoverSecond) {
      secondRequested.resolve()
      await respondToSecond.promise
      return route.fulfill(chartFailure)
    }
    const songs = [isSecond ? secondSong : firstSong]
    return route.fulfill({ json: { songs, playlist: { tracks: songs } } })
  })

  try {
    await page.goto('/#/charts')
    await page.getByRole('button', { name: 'Official Charts', exact: true }).click()
    const first = page.getByTestId(`song-row-${firstSong.id}`)
    await expect(first).toBeVisible()

    const second = page.getByRole('button', { name: charts[1].name, exact: true })
    await second.click()
    await secondRequested.promise
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(first).toHaveCount(0)
    respondToSecond.resolve()

    const error = page.getByTestId('charts-error')
    await expect(error).toBeVisible()
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('charts-empty')).toHaveCount(0)
    recoverSecond = true
    await page.getByTestId('charts-retry').click()
    await expect(page.getByTestId(`song-row-${secondSong.id}`)).toBeVisible()
    await expect(first).toHaveCount(0)
    await expect(second).toHaveAttribute('aria-pressed', 'true')
    await expect(error).toHaveCount(0)
  } finally {
    respondToSecond.resolve()
  }
}

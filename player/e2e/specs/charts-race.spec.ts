import { test, expect } from '../fixtures'

const filters = [
  {
    section: 'Trending',
    path: '/api/sonic/recommend/trending',
    param: 'window',
    slowKey: '24h',
    slowLabel: '24h Hot',
    currentKey: 'surging',
    currentLabel: 'Surging',
    payload: (id: number, title: string) => ({ data: { tracks: [{ id, platformId: String(id), title, artist: 'Fixture', duration: 20_000 }] } }),
  },
  {
    section: 'New Songs',
    path: '/api/top/song',
    param: 'type',
    slowKey: '7',
    slowLabel: 'Mandarin',
    currentKey: '96',
    currentLabel: 'Western',
    payload: (id: number, name: string) => ({ data: [{ id, name, ar: [{ name: 'Fixture' }], dt: 20_000 }] }),
  },
]

for (const filter of filters) {
  test(`desktop ${filter.section}: an older response cannot replace the selected filter`, async ({ page }) => {
    const matches = (url: URL) => url.pathname === filter.path
    let started!: () => void
    const requested = new Promise<void>(resolve => { started = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const latestTitle = `Latest ${filter.section} fixture`
    const staleTitle = `Stale ${filter.section} fixture`
    await page.route(matches, async route => {
      const key = new URL(route.request().url()).searchParams.get(filter.param)
      if (key === filter.slowKey) {
        started()
        await held
        await route.fulfill({ json: filter.payload(9702, staleTitle) })
      } else {
        const current = key === filter.currentKey
        await route.fulfill({ json: filter.payload(current ? 9703 : 9701, current ? latestTitle : 'Initial chart fixture') })
      }
    })

    try {
      await page.goto('/#/charts')
      await page.getByRole('button', { name: filter.section, exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Initial chart fixture' })).toBeVisible()
      await page.getByRole('button', { name: filter.slowLabel, exact: true }).click()
      await requested
      const selected = page.getByRole('button', { name: filter.currentLabel, exact: true })
      await selected.click()
      const latest = page.getByRole('heading', { name: latestTitle })
      await expect(latest).toBeVisible()

      const response = page.waitForResponse(reply => {
        const url = new URL(reply.url())
        return matches(url) && url.searchParams.get(filter.param) === filter.slowKey
      })
      release()
      expect(await (await response).finished()).toBeNull()
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      await expect(selected).toHaveClass(/bg-sky-500/)
      await expect(latest).toBeVisible()
      await expect(page.getByRole('heading', { name: staleTitle })).toHaveCount(0)
    } finally {
      release()
    }
  })
}

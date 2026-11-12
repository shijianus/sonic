import { test, expect, horizontalOverflow } from '../fixtures'

const charts = Array.from({ length: 25 }, (_, i) => ({
  id: 3000 + i,
  name: i === 24
    ? '云音乐说唱榜 · 第25个榜单名称完整展示测试'
    : `官方榜单 ${String(i + 1).padStart(2, '0')} · 华语流行金曲`,
  coverImgUrl: '',
  updateFrequency: '每日更新',
  trackCount: 100,
  playCount: 100000,
  description: '',
}))

test.beforeEach(async ({ page }) => {
  await page.route('**/api/toplist**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: charts }) })
  )
})

test('mobile official charts: 25 entries wrap vertically with no horizontal carousel', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/#/charts')
  await page.getByRole('button', { name: 'Official Charts' }).click()

  const scroller = page.getByRole('group', { name: 'Official charts:', exact: true })
  const buttons = scroller.getByRole('button')
  await expect(buttons).toHaveCount(25)
  await expect(buttons.nth(24)).toContainText('第25个榜单名称完整展示测试')
  await expect(scroller).toHaveAttribute('tabindex', '0')

  const geometry = await page.evaluate(() => {
    const scroller = document.querySelector('.official-chart-filter') as HTMLElement | null
    if (!scroller) return null
    return {
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      clipped: [...scroller.querySelectorAll<HTMLButtonElement>('button')]
        .filter(button => button.scrollWidth > button.clientWidth + 1).length,
    }
  })
  expect(geometry).not.toBeNull()
  expect(geometry!.scrollWidth).toBeLessThanOrEqual(geometry!.clientWidth + 1)
  expect(geometry!.scrollHeight).toBeGreaterThan(geometry!.clientHeight)
  expect(geometry!.clipped).toBe(0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

  const heights: number[] = []
  for (const name of ['Trending', 'New Songs', 'Official Charts']) {
    await page.getByRole('button', { name, exact: true }).first().click()
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
    heights.push(await page.locator('.glass-nav.sticky').evaluate(element => Math.round(element.getBoundingClientRect().height)))
  }
  expect(new Set(heights).size).toBe(1)

  await buttons.nth(24).scrollIntoViewIfNeeded()
  await buttons.nth(24).click()
  await expect(buttons.nth(24)).toHaveAttribute('aria-pressed', 'true')

  if (process.env.SONIC_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.SONIC_EVIDENCE_DIR}/${testInfo.project.name}-charts-official-fixed.png` })
  }
})

test('mobile artist filters keep stable touch targets and let users reach and reset the last initial', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.route('**/api/artist/list**', route =>
    route.fulfill({ json: { artists: [{ id: 41, name: 'Laufey', musicSize: 30, albumSize: 6 }] } }),
  )
  await page.goto('/#/artists')

  const region = page.getByRole('group', { name: 'Region:', exact: true })
  const western = region.getByRole('button', { name: 'Western', exact: true })
  await expect(western).toHaveAttribute('aria-pressed', 'false')
  const before = await western.boundingBox()
  expect(before?.height).toBeGreaterThanOrEqual(32)
  await western.click()
  await expect(western).toHaveAttribute('aria-pressed', 'true')
  expect(await western.boundingBox()).toEqual(before)

  const initials = page.getByRole('group', { name: 'Initial:', exact: true })
  await expect(initials).toHaveAttribute('tabindex', '0')
  const lastInitial = initials.getByRole('button', { name: '#', exact: true })
  await lastInitial.click()
  await expect(lastInitial).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => initials.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Reset Filters' }).click()
  await expect(region.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(initials.getByRole('button', { name: 'Hot', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('link', { name: /Laufey/ })).toBeVisible()
})

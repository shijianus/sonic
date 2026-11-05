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

test('desktop official charts: 25 entries stay inside their slot and tabs remain clickable', async ({ page }, testInfo) => {
  await page.goto('/#/charts')
  await page.getByRole('button', { name: 'Official Charts' }).click()

  const buttons = page.locator('.official-filter-scroll button')
  await expect(buttons).toHaveCount(25)
  await expect(buttons.nth(24)).toContainText('第25个榜单名称完整展示测试')

  const geometry = await page.evaluate(() => {
    const scroller = document.querySelector('.official-filter-scroll') as HTMLElement | null
    const category = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Trending')
    const s = scroller?.getBoundingClientRect()
    const c = category?.getBoundingClientRect()
    const hit = category ? document.elementFromPoint(
      c.left + c.width / 2,
      c.top + c.height / 2,
    ) : null
    return {
      overlap: s && c ? Math.max(0, Math.round(c.bottom - s.top)) : -1,
      categoryBottom: c ? Math.round(c.bottom) : 0,
      scrollerTop: s ? Math.round(s.top) : 0,
      trendingHit: Boolean(category && hit && (hit === category || category.contains(hit))),
      clipped: [...document.querySelectorAll<HTMLButtonElement>('.official-filter-scroll button')]
        .filter(button => button.scrollWidth > button.clientWidth + 1).length,
      labelOverlap: (() => {
        const label = [...document.querySelectorAll<HTMLElement>('span')]
          .find(element => element.textContent?.trim() === 'Official charts:')
        const first = document.querySelector<HTMLButtonElement>('.official-filter-scroll button')
        if (!label || !first) return -1
        return Math.round(first.getBoundingClientRect().left - label.getBoundingClientRect().right)
      })(),
    }
  })
  expect(geometry.overlap).toBe(0)
  expect(geometry.scrollerTop).toBeGreaterThanOrEqual(geometry.categoryBottom)
  expect(geometry.trendingHit).toBe(true)
  expect(geometry.clipped).toBe(0)
  expect(geometry.labelOverlap).toBeGreaterThanOrEqual(4)

  // This click used to be intercepted by the overflowing official row.
  await page.getByRole('button', { name: 'Trending', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Trending', exact: true })).toHaveClass(/bg-sky-500/)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

  const heights: number[] = []
  for (const name of ['Trending', 'New Songs', 'Official Charts']) {
    await page.getByRole('button', { name, exact: true }).first().click()
    await page.waitForTimeout(250)
    heights.push(await page.locator('.glass-card').first().evaluate(element => Math.round(element.getBoundingClientRect().height)))
  }
  expect(new Set(heights).size).toBe(1)

  await page.getByRole('button', { name: 'Official Charts' }).click()
  await buttons.nth(24).click()
  await expect(buttons.nth(24)).toHaveClass(/bg-sky-500/)

  if (process.env.SONIC_EVIDENCE_DIR) {
    await page.screenshot({ path: `${process.env.SONIC_EVIDENCE_DIR}/${testInfo.project.name}-charts-official-fixed.png` })
  }
})

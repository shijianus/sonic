import { test, expect, horizontalOverflow } from '../fixtures'

const buildMobileTracks = (pageNum: number, count: number, total: number) => {
  const start = (pageNum - 1) * count
  const len = Math.max(0, Math.min(count, total - start))
  return Array.from({ length: len }, (_, idx) => {
    const seq = start + idx + 1
    return {
      platformId: `m-${pageNum}-${seq}`,
      title: `Mobile Track ${seq}`,
      artist: `Mobile Artist ${seq}`,
      duration: 20_000,
      streamUrl: `/api/music/stream?id=9002`,
    }
  })
}

for (const width of [360, 390]) {
  test.describe(`mobile search pagination ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    test('renders numeric/prev/next buttons cleanly, handles clicks, dedupes active page, clamps shrink & recovers from error', async ({ page }, testInfo) => {
      let total = 55
      let failPage2 = false
      let slowPage2 = false
      const requestedPages: number[] = []
      let abortedCount = 0

      let releaseSlowPage2: (() => void) | null = null
      page.on('requestfailed', req => {
        if (req.url().includes('/api/sonic/search/nexus') && req.failure()?.errorText === 'net::ERR_ABORTED') {
          abortedCount++
        }
      })

      await page.route('**/api/sonic/search/nexus?**', async route => {
        const url = new URL(route.request().url())
        const q = (url.searchParams.get('q') || '').trim()
        const p = Number(url.searchParams.get('page') || 1)
        const count = Number(url.searchParams.get('count') || 20)
        requestedPages.push(p)
        if (q === 'fast-query') {
          return route.fulfill({
            json: {
              data: {
                tracks: [{ platformId: 'm-fast', title: 'Fast Override Track', artist: 'Mobile Fast', duration: 20_000, streamUrl: '/api/music/stream?id=9002' }],
                total: 1,
              },
            },
          })
        }
        if (p === 2 && slowPage2) {
          await new Promise<void>(resolve => { releaseSlowPage2 = resolve })
        }
        if (p === 2 && failPage2) {
          return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_ERROR' } } })
        }
        return route.fulfill({
          json: {
            data: {
              tracks: buildMobileTracks(p, count, total),
              total,
            },
          },
        }).catch(() => {})
      })
      await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: { songs: [], songCount: 0, playlists: [], playlistCount: 0, mvs: [], mvCount: 0 } } }))

      await page.goto('/#/search?q=mobile-paginate')
      const slide = page.locator('.swiper-slide-active')
      const prevBtn = slide.getByRole('button', { name: 'Prev', exact: true })
      const nextBtn = slide.getByRole('button', { name: 'Next', exact: true })
      const page1Btn = slide.getByRole('button', { name: '1', exact: true })
      const page2Btn = slide.getByRole('button', { name: '2', exact: true })
      const page3Btn = slide.getByRole('button', { name: '3', exact: true })

      await expect(slide.getByText('Mobile Track 1', { exact: true })).toBeVisible()
      await expect(page1Btn).toHaveAttribute('aria-current', 'page')
      await expect(prevBtn).toBeDisabled()
      await expect(nextBtn).toBeEnabled()
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

      // Next -> Page 2
      await nextBtn.click()
      await expect(slide.getByText('Mobile Track 21', { exact: true })).toBeVisible()
      await expect(page2Btn).toHaveAttribute('aria-current', 'page')

      // Numeric click 3 -> Page 3
      await page3Btn.click()
      await expect(slide.getByText('Mobile Track 41', { exact: true })).toBeVisible()
      await expect(page3Btn).toHaveAttribute('aria-current', 'page')
      await expect(nextBtn).toBeDisabled()
      await testInfo.attach(`mobile-pagination-p3-${width}`, {
        body: await page.screenshot({ path: testInfo.outputPath(`mobile-pagination-p3-${width}.png`) }),
        contentType: 'image/png',
      })

      // Clicking active page 3 again must not fire duplicate request
      const requestsBefore = requestedPages.length
      await page3Btn.click()
      await page.waitForTimeout(100)
      expect(requestedPages.length).toBe(requestsBefore)

      // Prev from Page 3 when Page 2 returns 503 -> error retry panel retries Page 2 cleanly
      failPage2 = true
      await prevBtn.click()
      const errPanel = slide.getByTestId('search-error')
      await expect(errPanel).toBeVisible()
      failPage2 = false
      await errPanel.getByTestId('search-retry').click()
      await expect(errPanel).toHaveCount(0)
      await expect(slide.getByText('Mobile Track 21', { exact: true })).toBeVisible()

      // Total shrinks <= songPageSize while navigating from Page 2 -> Next (Page 3): must clamp back to Page 1!
      total = 8
      await nextBtn.click()
      await expect(slide.getByText('Mobile Track 1', { exact: true })).toBeVisible()
      await expect(slide.getByText('Mobile Track 8', { exact: true })).toBeVisible()
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

      // Re-open 55-track query on a fresh query string, trigger slow Page 2 (verify loading skeleton), then rapidly submit new search to abort stale Page 2
      total = 55
      await page.goto('/#/search?q=mobile-paginate-abort')
      await expect(slide.getByText('Mobile Track 1', { exact: true })).toBeVisible()
      slowPage2 = true
      await page2Btn.click()
      await expect(page.locator('.animate-shimmer').first()).toBeVisible()
      await expect.poll(() => releaseSlowPage2 !== null).toBe(true)
      const main = page.getByRole('main')
      await main.getByRole('textbox', { name: 'Search', exact: true }).fill('fast-query')
      await main.getByRole('button', { name: 'Search', exact: true }).click()
      await expect(slide.getByText('Fast Override Track', { exact: true })).toBeVisible()
      releaseSlowPage2!()
      await page.waitForTimeout(150)
      await expect(slide.getByText('Fast Override Track', { exact: true })).toBeVisible()
      await expect(slide.getByText('Mobile Track 21', { exact: true })).toHaveCount(0)
      expect(abortedCount).toBeGreaterThanOrEqual(1)
    })
  })
}

test('keeps Next available without displaying a fabricated mobile total', async ({ page }) => {
  await page.route('**/api/sonic/search/nexus?**', route => {
    const url = new URL(route.request().url())
    const p = Number(url.searchParams.get('page'))
    const size = Number(url.searchParams.get('count'))
    const tracks = buildMobileTracks(p, size, size + 1)
    return route.fulfill({ json: { data: { total: tracks.length, totalKnown: false,
      hasMore: p === 1, tracks } } })
  })
  await page.goto('/#/search?q=mobile-window')
  await expect(page.getByText('Mobile Track 1', { exact: true })).toBeVisible()
  await expect(page.locator('.search-results-summary p')).toHaveCount(0)
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await next.click()
  await expect(next).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Prev', exact: true })).toBeEnabled()
})

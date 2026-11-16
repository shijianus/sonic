import { test, expect, horizontalOverflow } from '../fixtures'

const buildSmartPageTracks = (pageNum: number, pageSize: number, total: number) => {
  const start = (pageNum - 1) * pageSize
  const count = Math.max(0, Math.min(pageSize, total - start))
  return Array.from({ length: count }, (_, idx) => {
    const seq = start + idx + 1
    return {
      platformId: `p-${pageNum}-${seq}`,
      title: `Paginated Track ${seq}`,
      artist: `Artist ${seq}`,
      album: 'Pagination Album',
      duration: 20_000,
      streamUrl: `/api/music/stream?id=9002`,
    }
  })
}

const buildPlaylists = (offset: number, limit: number, total: number) => {
  const count = Math.max(0, Math.min(limit, total - offset))
  return Array.from({ length: count }, (_, idx) => {
    const seq = offset + idx + 1
    return {
      id: 80000 + seq,
      name: `Paginated Playlist ${seq}`,
      coverImgUrl: '',
      trackCount: 10,
      playCount: 100,
      creator: { nickname: 'Tester' },
    }
  })
}

test('desktop search pagination clicks Next/Prev, supports keyboard Enter, and updates offsets cleanly', async ({ page }, testInfo) => {
  const requestedPages: number[] = []
  await page.route('**/api/sonic/search/smart?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'suggest') return route.fallback()
    const p = Number(url.searchParams.get('page') || 1)
    const count = Number(url.searchParams.get('count') || 40)
    requestedPages.push(p)
    return route.fulfill({
      json: {
        data: {
          query: 'paginate',
          total: 95,
          tracks: buildSmartPageTracks(p, count, 95),
          suggestions: [],
          personalizedApplied: false,
        },
      },
    })
  })
  await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: { songs: [], songCount: 0 } } }))

  await page.goto('/#/search?q=paginate')
  const prevBtn = page.getByRole('button', { name: 'Prev', exact: true })
  const nextBtn = page.getByRole('button', { name: 'Next', exact: true })

  await expect(page.getByText('Paginated Track 1', { exact: true })).toBeVisible()
  await expect(page.getByText('1 / 3', { exact: true })).toBeVisible()
  await expect(prevBtn).toBeDisabled()
  await expect(nextBtn).toBeEnabled()

  // Click Next -> Page 2
  await nextBtn.click()
  await expect(page.getByText('Paginated Track 41', { exact: true })).toBeVisible()
  await expect(page.getByText('2 / 3', { exact: true })).toBeVisible()
  await expect(prevBtn).toBeEnabled()
  await expect(nextBtn).toBeEnabled()

  // Keyboard Enter on Next -> Page 3 (boundary)
  await nextBtn.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Paginated Track 81', { exact: true })).toBeVisible()
  await expect(page.getByText('Paginated Track 95', { exact: true })).toBeVisible()
  await expect(page.getByText('3 / 3', { exact: true })).toBeVisible()
  await expect(nextBtn).toBeDisabled()

  // Click Prev -> back to Page 2
  await prevBtn.click()
  await expect(page.getByText('Paginated Track 41', { exact: true })).toBeVisible()
  await expect(page.getByText('2 / 3', { exact: true })).toBeVisible()
  expect(requestedPages).toEqual([1, 2, 3, 2])
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

  await testInfo.attach('desktop-pagination-page2', {
    body: await page.screenshot({ path: testInfo.outputPath('desktop-pagination-page2.png') }),
    contentType: 'image/png',
  })
})

test('desktop pagination clamps page when upstream total shrinks and guards rapid stale responses', async ({ page }) => {
  let total = 95
  let delayPage2 = false
  let releasePage2: (() => void) | null = null
  let abortedRequests = 0
  page.on('requestfailed', req => {
    if (req.url().includes('/api/sonic/search/smart') && req.failure()?.errorText === 'net::ERR_ABORTED') {
      abortedRequests++
    }
  })

  await page.route('**/api/sonic/search/smart?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('mode') === 'suggest') return route.fallback()
    const p = Number(url.searchParams.get('page') || 1)
    const count = Number(url.searchParams.get('count') || 40)
    if (delayPage2 && p === 2) {
      await new Promise<void>(resolve => { releasePage2 = resolve })
    }
    return route.fulfill({
      json: {
        data: {
          query: 'paginate',
          total,
          tracks: buildSmartPageTracks(p, count, total),
          suggestions: [],
          personalizedApplied: false,
        },
      },
    }).catch(() => {})
  })
  await page.route('**/api/cloudsearch?**', route => route.fulfill({ json: { code: 200, result: { songs: [], songCount: 0 } } }))

  await page.goto('/#/search?q=paginate')
  const prevBtn = page.getByRole('button', { name: 'Prev', exact: true })
  const nextBtn = page.getByRole('button', { name: 'Next', exact: true })

  // Rapid Next -> Next once Page 2 fetch is in-flight: stale Page 2 must abort and never overwrite Page 3
  delayPage2 = true
  await expect(page.getByText('1 / 3', { exact: true })).toBeVisible()
  await nextBtn.click()
  await expect.poll(() => releasePage2 !== null).toBe(true)
  await nextBtn.click()
  await expect(page.getByText('3 / 3', { exact: true })).toBeVisible()
  await expect(page.getByText('Paginated Track 81', { exact: true })).toBeVisible()
  releasePage2!()
  await page.waitForTimeout(150)
  await expect(page.getByText('Paginated Track 81', { exact: true })).toBeVisible()
  await expect(page.getByText('Paginated Track 41', { exact: true })).toHaveCount(0)
  expect(abortedRequests).toBeGreaterThanOrEqual(1)

  // Now shrink catalog total to 12 while on Page 3 and click Prev -> Page 2 response carries total=12, clamping to Page 1!
  delayPage2 = false
  total = 12
  await prevBtn.click()
  await expect(page.getByText('1 / 1', { exact: true })).toBeVisible()
  await expect(page.getByText('Paginated Track 1', { exact: true })).toBeVisible()
  await expect(prevBtn).toBeDisabled()
  await expect(nextBtn).toBeDisabled()
})

test('desktop pagination shows loading state, surfaces error on page 2, and retries page 2 without resetting to page 1', async ({ page }, testInfo) => {
  let failPage2 = true
  let releasePage2: (() => void) | null = null
  const seenOffsets: number[] = []
  await page.route('**/api/sonic/search/smart?**', route => route.fulfill({ json: { data: { tracks: [], total: 0, suggestions: [] } } }))
  await page.route('**/api/cloudsearch?**', async route => {
    const url = new URL(route.request().url())
    const type = url.searchParams.get('type')
    if (type !== '1000') return route.fulfill({ json: { code: 200, result: { songs: [], songCount: 0 } } })
    const offset = Number(url.searchParams.get('offset') || 0)
    const limit = Number(url.searchParams.get('limit') || 30)
    seenOffsets.push(offset)
    if (offset >= 30 && failPage2) {
      await new Promise<void>(resolve => { releasePage2 = resolve })
      return route.fulfill({ status: 503, json: { error: { code: 'UPSTREAM_ERROR' } } })
    }
    return route.fulfill({
      json: { code: 200, result: { playlists: buildPlaylists(offset, limit, 65), playlistCount: 65 } },
    })
  })

  await page.goto('/#/search?q=paginate')
  await page.getByRole('button', { name: 'Playlists', exact: true }).click()
  await expect(page.getByText('Paginated Playlist 1', { exact: true })).toBeVisible()
  await expect(page.getByText('1 / 3', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect.poll(() => releasePage2 !== null).toBe(true)
  await expect(page.locator('.animate-shimmer').first()).toBeVisible()
  releasePage2!()

  const errPanel = page.getByTestId('search-error')
  await expect(errPanel).toBeVisible()
  await expect(page.getByText('No results found', { exact: true })).toHaveCount(0)
  await testInfo.attach('desktop-pagination-error-page2', {
    body: await page.screenshot({ path: testInfo.outputPath('desktop-pagination-error-page2.png') }),
    contentType: 'image/png',
  })

  failPage2 = false
  await errPanel.getByTestId('search-retry').click()
  await expect(errPanel).toHaveCount(0)
  await expect(page.getByText('Paginated Playlist 31', { exact: true })).toBeVisible()
  await expect(page.getByText('2 / 3', { exact: true })).toBeVisible()
  expect(seenOffsets).toEqual([0, 30, 30])
})

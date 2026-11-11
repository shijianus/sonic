import { expect, horizontalOverflow, test } from '../fixtures'

test('a superseded desktop suggestion failure preserves the current suggestions', async ({ page }, testInfo) => {
  const pending = Promise.withResolvers<void>()
  const deliver = Promise.withResolvers<void>()
  // Allow this particular request to finish even if the app aborts it. A late
  // error must be harmless even when the transport ignores cancellation.
  await page.addInitScript(() => {
    const fetchPage = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const raw = input instanceof Request ? input.url : input
      const url = new URL(raw, window.location.href)
      if (url.pathname === '/api/sonic/search/smart' && url.searchParams.get('q') === 'old-term') {
        return fetchPage(input, { ...init, signal: undefined })
      }
      return fetchPage(input, init)
    }
  })
  await page.route('**/api/sonic/search/smart?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('mode') !== 'suggest') return route.continue()
    if (query.get('q') === 'old-term') {
      pending.resolve()
      await deliver.promise
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } })
    }
    return route.fulfill({ json: { data: { suggestions: [{ text: 'Current suggestion', type: 'query', score: 1 }] } } })
  })

  try {
    await page.goto('/#/search')
    const input = page.getByTestId('page-search-input')
    await input.fill('old-term')
    await pending.promise
    await input.fill('new-term')
    const current = page.getByRole('button', { name: 'Current suggestion' })
    await expect(current).toBeVisible()
    const response = page.waitForResponse(result => result.status() === 503 && result.url().includes('q=old-term'))
    deliver.resolve()
    await response
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect(current).toBeVisible()
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
    await testInfo.attach('current-desktop-suggestion', { body: await page.screenshot(), contentType: 'image/png' })
  } finally {
    deliver.resolve()
  }
})

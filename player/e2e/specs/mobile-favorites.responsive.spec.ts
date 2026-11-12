import { expect, expectPlaying, horizontalOverflow, test } from '../fixtures'

test('mobile favorites deep link selects Recent and restores the tab after history navigation', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  const activeTab = page.locator('nav a[aria-current="page"]')
  const favoritesHeading = page.getByRole('heading', { name: 'My Favorites' })

  await page.goto('/#/likes')
  await expect(favoritesHeading).toBeVisible()
  await expect(activeTab).toHaveText('Recent')

  await page.reload()
  await expect(activeTab).toHaveText('Recent')
  await page.getByRole('navigation').getByRole('link', { name: 'Search' }).click()
  await expect(activeTab).toHaveText('Search')

  await page.goBack()
  await expect(favoritesHeading).toBeVisible()
  await expect(activeTab).toHaveText('Recent')
  await page.goForward()
  await expect(activeTab).toHaveText('Search')
})

test('mobile playlist and MV favorites are visible, openable and removable without liked songs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/playlist/123')
  await page.getByRole('button', { name: 'Favorite', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unfavorite', exact: true })).toBeVisible()

  await page.goto('/#/mv-player/10880673')
  const mvLike = page.getByRole('button', { name: 'Like', exact: true })
  await expect(mvLike).toHaveAttribute('aria-pressed', 'false')
  await mvLike.tap()
  await expect(mvLike).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/#/recent')
  const favorites = page.getByRole('link', { name: /^My Favorites/ })
  const activeTab = page.locator('nav a[aria-current="page"]')
  await expect(favorites).toHaveText(/My Favorites\s*2/)
  await favorites.click()
  await expect(page.getByRole('heading', { name: 'My Favorites' })).toBeVisible()
  await expect(activeTab).toHaveText('Recent')
  const playlist = page.getByRole('link', { name: 'E2E Playlist', exact: true })
  const mv = page.getByRole('link', { name: '起风了', exact: true })
  for (const link of [playlist, mv]) await expect(link).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)

  await page.reload()
  await playlist.click()
  await expect(page).toHaveURL(/#\/playlist\/123$/)
  await expect(activeTab).toHaveText('Recent')
  await expect(page.getByRole('button', { name: 'Unfavorite', exact: true })).toBeVisible()
  await page.goBack()
  await mv.click()
  await expect(page).toHaveURL(/#\/mv-player\/10880673$/)
  await expect(activeTab).toHaveText('Recent')
  await expect(mvLike).toHaveAttribute('aria-pressed', 'true')
  await page.goBack()

  await page.getByRole('button', { name: 'Unfavorite · E2E Playlist' }).click()
  await page.getByRole('button', { name: 'Unlike · 起风了' }).click()
  await expect(page.getByText(/^Nothing here yet/)).toBeVisible()
  await page.goto('/#/playlist/123')
  await expect(page.getByRole('button', { name: 'Favorite', exact: true })).toBeVisible()
  await page.goto('/#/mv-player/10880673')
  await expect(mvLike).toHaveAttribute('aria-pressed', 'false')
  await page.goto('/#/likes')
  await page.reload()
  await expect(page.getByText(/^Nothing here yet/)).toBeVisible()
  await page.goto('/#/recent')
  await expect(favorites).toHaveText('My Favorites')
})

test('mobile liked songs play from a native button and can be removed independently', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await page.route(url => url.pathname === '/api/song/detail', route => route.fulfill({
    json: {
      songs: [{ id: 9001, name: 'Test Song One', ar: [{ name: 'Test Artist' }], dt: 20_000 }],
    },
  }))
  await page.goto('/#/song/9001')
  await expect(page.getByRole('heading', { name: 'Test Song One' })).toBeVisible()
  await page.getByRole('button', { name: 'Like', exact: true }).click()
  await page.goto('/#/likes')

  const play = page.getByRole('button', { name: 'Play · Test Song One' })
  await play.press('Enter')
  await expectPlaying(page)
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: 'Unlike · Test Song One' }).click()
  await expect(play).toHaveCount(0)
  await expect(page.getByText(/^Nothing here yet/)).toBeVisible()
})

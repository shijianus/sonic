import { test, expect } from '../fixtures'

test('desktop sidebar navigation renders each page with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort())
  const settingsPrefetch = page.waitForResponse(response => /\/static\/js\/settings-[^/]+\.js$/.test(response.url()))
  await page.goto('/#/')
  const sidebar = page.getByRole('complementary')
  const main = page.getByRole('main')
  const settingsHeading = main.getByRole('heading', { name: 'Settings', exact: true })
  await expect(main.getByRole('heading', { name: 'Featured MVs' })).toBeVisible()
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  // Exercise the warm route after the sidebar's idle prefetch has loaded it.
  expect(await (await settingsPrefetch).finished()).toBeNull()

  await sidebar.getByRole('link', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(settingsHeading).toBeVisible()

  await sidebar.getByRole('link', { name: 'Search', exact: true }).click()
  await expect(page).toHaveURL(/#\/search$/)
  await expect(main.getByTestId('page-search-input')).toBeVisible()

  await page.goBack()
  await expect(settingsHeading).toBeVisible()
})

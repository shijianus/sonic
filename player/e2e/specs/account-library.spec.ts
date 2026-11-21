import { test, expect } from '../fixtures'

test('account library stays separate from guest data across refresh and a second tab changing accounts', async ({ context, page }) => {
  let current = 'One'
  const targets: string[] = []
  await context.route('**/api/auth/user', route => route.fulfill({
    status: current ? 200 : 401,
    json: current ? { ok: true, user: { id: current, name: current, email: current + '@example.test' } } : { ok: false },
  }))
  await context.route('**/api/auth/logout', route => {
    current = ''
    return route.fulfill({ json: { ok: true } })
  })
  await context.route('**/api/account/library', route => {
    const target = route.request().headers()['x-sonic-account-target']
    if (target !== current) return route.fulfill({ status: 409, json: { error: { code: 'ACCOUNT_IDENTITY_MISMATCH' } } })
    targets.push(target)
    return route.fulfill({ json: { brand: 'Sonic', meta: { storageKind: 'sqlite', persistenceConfirmed: true },
      data: { version: 1, schemaVersion: 1, updatedAt: null, tombstones: [], collectedPlaylists: [], likedMvs: [], collectedAlbums: [], followedArtists: [], userPlaylists: [],
        likedSongs: [{ id: 'account-song', artist: 'Example', name: current + ' private favorite' }] } } })
  })
  await page.goto('/api/sonic/engine/health')
  await page.evaluate(() => {
    localStorage.setItem('library', JSON.stringify({ likedSongs: [{ id: 'g', artist: 'Guest', name: 'Guest favorite' }] }))
  })
  await page.goto('/#/likes')
  await expect(page.getByText('One private favorite', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('One private favorite', { exact: true })).toBeVisible()

  // Complete a normal OAuth callback in another tab, sharing this browser's session.
  const other = await context.newPage()
  current = 'Two'
  await other.goto('/?auth=success#/likes')
  await expect(page.getByText('Two private favorite', { exact: true })).toBeVisible()
  await expect(page.getByText('One private favorite', { exact: true })).toHaveCount(0)
  await other.getByRole('button', { name: 'Account menu' }).click()
  await other.getByRole('button', { name: 'Sign Out' }).click()
  await expect(page.getByText('Guest favorite', { exact: true })).toBeVisible()
  await expect(page.getByText('Two private favorite', { exact: true })).toHaveCount(0)
  expect(targets).toEqual(expect.arrayContaining(['One', 'Two']))
})

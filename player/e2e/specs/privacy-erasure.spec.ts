import { test, expect } from '../fixtures'

test('an erasure identity conflict preserves the anonymous profile ID for retry', async ({ page }, testInfo) => {
  const anonId = 'anon_erasure_browser_001'
  const deletes: Array<{ anonId: string | undefined; target: string | undefined }> = []
  await page.addInitScript((id) => {
    localStorage.setItem('recommend', JSON.stringify({ personalizationEnabled: true, anonId: id }))
    localStorage.setItem('sonic-e2e-local-data', 'preserved')
  }, anonId)

  await page.route('**/api/sonic/events', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const headers = route.request().headers()
    deletes.push({ anonId: headers['x-sonic-anon-id'], target: headers['x-sonic-erasure-target'] })
    if (deletes.length === 1) {
      await route.fulfill({ status: 409, json: { brand: 'Sonic', error: { code: 'EVENT_ERASURE_IDENTITY_MISMATCH' } } })
    } else {
      await route.fulfill({ json: {
        brand: 'Sonic', data: { privacyMode: 'anonymous-opt-in', cleared: true, storageKind: 'sqlite', removedEvents: 1 },
      } })
    }
  })

  await page.goto('/#/settings')
  await page.getByRole('button', { name: 'Clear all local data', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clear all local data?' })
  await expect(dialog).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('privacy-erase-dialog.png') })
  await dialog.getByRole('button', { name: 'Clear everything' }).click()
  await expect(page.getByText('Some data could not be cleared. Please retry.')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('sonic-e2e-local-data'))).toBe('preserved')

  await page.getByRole('button', { name: 'Reset Recommendation Profile & Dislikes' }).click()
  await expect(page.getByText('Recommendation profile and disliked tracks cleared')).toBeVisible()
  const expected = { anonId, target: 'anonymous-opt-in' }
  expect(deletes).toEqual([expected, expected])
})

import { test, expect } from '../fixtures'
import type { Page } from '@playwright/test'

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

const musicDbName = 'SonicMusicPlayerDB'
const localTrack = { id: 'erasure-local-track', name: 'Local music erasure test' }

async function seedMusicDatabase(page: Page) {
  await page.goto('/api/sonic/engine/health')
  return page.evaluateHandle(async ({ dbName, track }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 2)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('local_music', { keyPath: 'id' })
        request.result.createObjectStore('downloaded_music', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('local_music', 'readwrite')
      tx.objectStore('local_music').put({ ...track, artist: 'Test', duration: 1000, file: new Blob(['test']) })
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
    })
    return db
  }, { dbName: musicDbName, track: localTrack })
}

async function openClearSettings(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('recommend', JSON.stringify({ personalizationEnabled: false }))
  })
  await page.route('**/api/sonic/events', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    await route.fulfill({ json: {
      brand: 'Sonic', data: { privacyMode: 'public', cleared: false, removedEvents: 0 },
    } })
  })
  await page.goto('/#/settings')
}

async function confirmLocalClear(page: Page) {
  await page.getByRole('button', { name: 'Clear all local data', exact: true }).click()
  await page.getByRole('dialog', { name: 'Clear all local data?' })
    .getByRole('button', { name: 'Clear everything' }).click()
}

async function hasMusicDatabase(page: Page) {
  return page.evaluate(async name => (await indexedDB.databases()).some(db => db.name === name), musicDbName)
}

test('local data clearing closes another app tab’s music database and lets it reopen empty', async ({ context, page }) => {
  const other = await context.newPage()
  const seeded = await seedMusicDatabase(other)
  await seeded.evaluate(db => db.close())
  await other.addInitScript(() => localStorage.setItem('global', JSON.stringify({ lang: 'en' })))
  await other.goto('/#/local-music')
  await expect(other.getByText(localTrack.name, { exact: true })).toBeVisible()

  await openClearSettings(page)
  await Promise.all([page.waitForEvent('load'), confirmLocalClear(page)])
  expect(await hasMusicDatabase(other)).toBe(false)

  // Downloads uses the same cached connection and opens it on first mount.
  await other.getByRole('link', { name: 'Downloads', exact: true }).click()
  await expect.poll(() => hasMusicDatabase(other)).toBe(true)
  const localCount = await other.evaluate(name => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open(name, 2)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const count = db.transaction('local_music').objectStore('local_music').count()
      count.onsuccess = () => resolve(count.result)
      count.onerror = () => reject(count.error)
      db.close()
    }
  }), musicDbName)
  expect(localCount).toBe(0)
})

test('blocked local data clearing reports failure and can be retried after the blocker closes', async ({ context, page }, testInfo) => {
  const other = await context.newPage()
  const blocker = await seedMusicDatabase(other)
  await openClearSettings(page)
  await confirmLocalClear(page)
  await expect(page.getByText('Some data could not be cleared. Please retry.')).toBeVisible()
  await expect(page.getByText('Local data cleared', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('indexeddb-blocked.png') })
  const retained = await blocker.evaluate((db, id) => new Promise((resolve, reject) => {
    const request = db.transaction('local_music').objectStore('local_music').get(id)
    request.onsuccess = () => resolve(request.result?.id)
    request.onerror = () => reject(request.error)
  }), localTrack.id)
  expect(retained).toBe(localTrack.id)

  await confirmLocalClear(page)
  await expect(page.getByRole('dialog', { name: 'Clear all local data?' })).toBeHidden()
  await other.close()
  await expect.poll(() => hasMusicDatabase(page)).toBe(false)
  await Promise.all([page.waitForEvent('load'), confirmLocalClear(page)])
  expect(await hasMusicDatabase(page)).toBe(false)
})

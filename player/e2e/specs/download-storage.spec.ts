import type { Page } from '@playwright/test'
import { expect, expectPlaying, horizontalOverflow, test } from '../fixtures'

const dbName = 'SonicMusicPlayerDB'

async function seedLegacyDownloads(page: Page, version: 2 | 3, withSource = true) {
  await page.goto('/api/sonic/engine/health')
  const wave = await (await page.request.get('/api/music/stream?id=9001')).body()
  await page.evaluate(async ({ dbName, version, wave, withSource }) => {
    const file = new Blob([Uint8Array.from(atob(wave), c => c.charCodeAt(0))], { type: 'audio/wav' })
    const seed = {
      id: 9001, name: 'Old standard recording', artist: 'Fixture artist', duration: 20,
      qualityLevel: 'standard', qualityBadge: 'Standard', format: 'wav', fileSize: file.size,
      file, downloadTime: 1, ...(withSource ? { source: 'netease', platformId: '9001' } : {}),
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, version)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('local_music', { keyPath: 'id' })
        db.createObjectStore('downloaded_music', { keyPath: 'id' }).put(seed)
        if (version === 3) {
          const canonical = db.createObjectStore('downloaded_music_v3', { keyPath: 'downloadKey' })
          for (const level of ['standard', 'lossless']) {
            canonical.put({ ...seed, name: `Retained ${level}`, qualityLevel: level, downloadKey: `netease%3A9001|quality:${level}` })
          }
        }
      }
      request.onsuccess = () => { request.result.close(); resolve() }
    })
  }, { dbName, version, wave: wave.toString('base64'), withSource })
}

test('v2 downloads survive the v4 upgrade and remain playable', async ({ page }) => {
  await seedLegacyDownloads(page, 2)
  await page.goto('/#/downloads')
  const old = page.getByRole('row').filter({ hasText: 'Old standard recording' })
  await old.press('Enter')
  await expectPlaying(page)
  const schema = await page.evaluate(async name => {
    const request = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try { return { version: db.version, stores: Array.from(db.objectStoreNames) } }
    finally { db.close() }
  }, dbName)
  expect(schema.version).toBe(4)
  expect(schema.stores).toEqual(['downloaded_music_v3', 'ecs_playback_keys', 'local_music'])
})

test('v3 migration keeps the selected variant across reload and never revives removed legacy rows', async ({ page }) => {
  await seedLegacyDownloads(page, 3)
  await page.goto('/#/downloads')
  await expect(page.getByRole('row').filter({ hasText: 'Retained standard' })).toBeVisible()
  const selected = page.getByRole('row').filter({ hasText: 'Retained lossless' })
  await selected.press('Enter')
  await expectPlaying(page)
  await expect(page.getByRole('row').filter({ hasText: 'Old standard recording' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('footer')).toContainText('Retained lossless')
  await expect.poll(() => page.locator('#audioPlayer').evaluate(el => (el as HTMLAudioElement).src)).toMatch(/^blob:/)
  await expect(page.getByRole('row').filter({ hasText: 'Retained standard' })).toBeVisible()
})

test('download rejects a preview, unknown stream type, partial range, short audio and mismatched receipts before issuing an ECS key', async ({ page }) => {
  await page.goto('/#/search?q=ecs')
  await page.getByTestId('song-row-9451').click()
  await expectPlaying(page)
  await page.locator('footer').getByRole('button', { name: 'Download', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const tier = dialog.getByRole('radio', { name: /^ECS3/ })
  await expect(tier).toHaveAttribute('aria-disabled', 'false')
  await tier.click()
  const original = await (await page.request.get('/api/music/stream?id=9451&br=128')).body()
  const shortened = Buffer.from(original.subarray(0, 8044))
  shortened.writeUInt32LE(shortened.length - 8, 4)
  shortened.writeUInt32LE(shortened.length - 44, 40)
  let keyRequests = 0
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/music/ecs') keyRequests++
  })
  for (const problem of ['trial', 'unknown', 'partial', 'short', 'identity']) {
    const routeUrl = '**/api/music/stream?**'
    await page.route(routeUrl, route => {
      if (route.request().resourceType() !== 'xhr') return route.fallback()
      const headers: Record<string, string> = {
        'Content-Type': 'audio/wav', 'X-Sonic-Resolved-Source': 'netease',
        'X-Sonic-Resolved-Id': problem === 'identity' ? 'another-track' : '9451',
      }
      if (problem !== 'unknown') headers['X-Sonic-Stream-Type'] = problem === 'trial' ? 'trial' : 'full'
      if (problem === 'partial') headers['Content-Range'] = `bytes 0-8043/${original.length}`
      return route.fulfill({ status: problem === 'partial' ? 206 : 200, headers,
        body: problem === 'partial' || problem === 'short' ? shortened : original })
    })
    const served = page.waitForResponse(response => response.request().resourceType() === 'xhr' &&
      new URL(response.url()).pathname === '/api/music/stream')
    await dialog.getByRole('button', { name: /^Download \(/ }).click()
    await served
    const error = problem === 'identity' ? /Audio source unavailable or restricted/i : /The source did not confirm a complete track/
    await expect(dialog.getByText(error).last()).toBeVisible()
    await page.unroute(routeUrl)
  }
  expect(keyRequests).toBe(0)
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.goto('/#/downloads')
  await expect(page.getByRole('row').filter({ hasText: 'ECS Test Tone' })).toHaveCount(0)
})

test('a mobile guest can play an old download and choose an export format', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedLegacyDownloads(page, 2)
  await page.goto('/#/downloads')
  await page.getByRole('heading', { name: 'Old standard recording' }).click()
  await expectPlaying(page)
  await page.getByTestId('download-export').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('download-export-confirm')).toHaveText('Export audio file')
  await dialog.getByRole('combobox').selectOption('original')
  await expect(dialog.getByTestId('download-export-confirm')).toContainText('Sign in')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('mobile-download-export.png') })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('download-export')).toBeFocused()
})

test('a legacy numeric ID alone cannot authorize wrapping a local file', async ({ page }) => {
  await seedLegacyDownloads(page, 2, false)
  await page.goto('/#/downloads')
  const old = page.getByRole('row').filter({ hasText: 'Old standard recording' })
  await old.hover()
  await old.getByTestId('download-export').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByTestId('download-export-confirm').click()
  await expect(dialog.getByRole('alert')).toHaveText(/still available for local playback/i)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await old.press('Enter')
  await expectPlaying(page)
})

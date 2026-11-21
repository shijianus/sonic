import { randomBytes, createHash } from 'node:crypto'
import type { Download, Page } from '@playwright/test'
import { parseBuffer } from 'music-metadata'
import { expect, test, expectPlaying, getAudio } from '../fixtures'
import { createSession } from '../../../functions/_lib/auth'
import { onRequest as license } from '../../../functions/api/music/ecs'
import { onRequest as profile } from '../../../functions/api/auth/user'

const fixtureTitle = 'ECS Test Tone'

function testEnvironment() {
  // The mock media server serves locally generated WAVs for these catalog IDs.
  return {
    SONIC_SECRET: randomBytes(32).toString('hex'),
    SONIC_ECS_MASTER_KEY: randomBytes(32).toString('hex'),
    SONIC_ECS_DOWNLOAD_SOURCES: 'netease',
    SONIC_ECS_EXPORT_SOURCES: 'netease',
    SONIC_CONTENT_POLICY: 'strict-allowlist',
    SONIC_ALLOWED_SOURCES: 'netease',
    SONIC_ENABLE_NETEASE: '1',
  }
}

async function useRealHandlers(page: Page) {
  const env = testEnvironment()
  const calls: string[] = []
  for (const [path, handler] of [
    ['/api/music/ecs', license],
    ['/api/auth/user', profile],
  ] as const) {
    await page.route(`**${path}`, async route => {
      const request = route.request()
      if (handler === license) calls.push(request.postDataJSON().action)
      const response = await handler({
        request: new Request(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postData(),
        }),
        env,
      })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
  }
  return { env, calls }
}

async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('Browser did not save the download')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function downloadSong(page: Page, tier: 1 | 2 | 3 = 1) {
  await page.goto('/#/search?q=ecs')
  await page.getByTestId('song-row-9451').click()
  await expectPlaying(page)
  expect((await getAudio(page))?.src).toContain('/api/music/stream')
  await page.locator('footer').getByRole('button', { name: 'Download', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const selected = dialog.getByRole('radio', { name: new RegExp(`^ECS${tier}\\b`) })
  await expect(selected).toHaveAttribute('aria-disabled', 'false')
  await selected.click()
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: /^Download \(/ }).click()
  // Download completion can outlive transient browser activation on a slow CI host.
  await expect(dialog).toBeHidden()
  if (await page.getByText(/browser blocked the automatic save/).isVisible()) {
    await page.getByRole('button', { name: 'Save manually', exact: true }).click()
  }
  const saved = await download
  expect(saved.suggestedFilename().endsWith(`.ecs${tier}.ecs`)).toBe(true)
  const file = await bytesOf(saved)
  const parts = file.toString('ascii').split('.')
  expect(parts).toHaveLength(5)
  expect(JSON.parse(Buffer.from(parts[0], 'base64url').toString())).toMatchObject({ alg: 'dir', enc: 'A256GCM', ecs: 1 })
  expect(parts[1]).toBe('')
  expect(parts[3]).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(Buffer.from(parts[4], 'base64url')).toHaveLength(16)
  const ticket: string = JSON.parse(Buffer.from(parts[0], 'base64url').toString()).kid
  return { name: saved.suggestedFilename(), file, parts, ticket }
}

async function storedFileDigests(page: Page, storeName: 'local_music' | 'downloaded_music_v3') {
  return page.evaluate(async name => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('SonicMusicPlayerDB')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const records = await new Promise<Array<{file: Blob}>>((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      return Promise.all(records.map(async ({ file }) => {
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      }))
    } finally { db.close() }
  }, storeName)
}

async function openExport(page: Page, target: string) {
  const row = page.getByRole('row').filter({ hasText: fixtureTitle })
  await row.hover()
  await row.getByRole('button', { name: 'Export audio file' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('combobox').selectOption(target)
  return dialog
}

function digest(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function signIn(page: Page, env: ReturnType<typeof testEnvironment>) {
  // Use a locally signed session. The external OAuth service is not part of this fixture.
  const session = await createSession(env, { email: 'ecs@example.invalid', name: 'Test Listener', avatar: '' })
  await page.context().addCookies([{
    name: 'sonic_session', value: session.apiKey, url: new URL(page.url()).origin, httpOnly: true, sameSite: 'Lax',
  }])
  const verified = page.waitForResponse(res => new URL(res.url()).pathname === '/api/auth/user' && res.status() === 200)
  await page.reload()
  await verified
}

function exportDecision(page: Page, ticket: string, target: string) {
  return page.evaluate(async ({ticket, target}) => {
    const res = await fetch('/api/music/ecs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export', target, ticket }),
    })
    return { status: res.status, code: (await res.json()).error?.code }
  }, {ticket, target})
}

test('guest online and offline playback, encrypted downloads and verified-account exports', async ({ page, context }) => {
  test.setTimeout(100_000)
  const { env, calls } = await useRealHandlers(page)
  const { file, ticket } = await downloadSong(page)
  expect(await storedFileDigests(page, 'downloaded_music_v3')).toEqual([digest(file)])
  const wav = await (await page.request.get('/api/music/stream?id=9451&br=lossless')).body()
  await page.goto('/#/downloads')
  const row = page.getByRole('row').filter({ hasText: fixtureTitle })
  await expect(row).toBeVisible()
  await context.setOffline(true)
  try {
    await row.press('Enter')
    await expect.poll(async () => (await getAudio(page))?.src).toMatch(/^blob:/)
    await expectPlaying(page)
    expect(calls).toEqual(['issue'])
  } finally {
    await context.setOffline(false)
  }

  const guest = await openExport(page, 'original')
  await expect(guest.getByRole('button', { name: 'Sign in to export audio' })).toBeVisible()
  await guest.getByRole('button', { name: 'Cancel' }).click()
  expect(await exportDecision(page, ticket, 'original')).toEqual({ status: 401, code: 'ACCOUNT_REQUIRED' })

  await signIn(page, env)
  for (const target of ['ecs', 'original', 'high', 'standard']) {
    const dialog = await openExport(page, target)
    const downloading = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Export audio file', exact: true }).click()
    const result = await downloading
    const bytes = await bytesOf(result)
    if (target === 'ecs') {
      expect(digest(bytes)).toBe(digest(file))
    } else if (target === 'original') {
      expect(result.suggestedFilename()).toMatch(/\.wav$/)
      expect(digest(bytes)).toBe(digest(wav))
    } else {
      expect(result.suggestedFilename()).toMatch(/\.mp3$/)
      const { format } = await parseBuffer(bytes)
      expect(format.codec).toContain('Layer 3')
      expect(format.sampleRate).toBe(48000)
      expect(format.bitrate).toBe(target === 'high' ? 320_000 : 128_000)
      const actual = await page.evaluate(async b64 => {
        const ctx = new OfflineAudioContext(1, 1, 44100)
        const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const decoded = await ctx.decodeAudioData(data.buffer)
        const samples = decoded.getChannelData(0).subarray(44100, 44200)
        return { seconds: decoded.duration, peak: Math.max(...samples.map(Math.abs)) }
      }, bytes.toString('base64'))
      expect(actual.seconds).toBeGreaterThan(19.9)
      expect(actual.seconds).toBeLessThan(20.2)
      expect(actual.peak).toBeGreaterThan(0.02)
    }
  }
  expect(calls.filter(action => action === 'export')).toHaveLength(4)
})

test('imports a portable ECS, rejects corrupt ciphertext and rejects an incorrect cached key', async ({ page }) => {
  const { calls } = await useRealHandlers(page)
  const { file, name, parts } = await downloadSong(page)
  await page.goto('/#/local-music')
  const input = page.locator('input[type=file]')
  await expect(input).toBeAttached()
  const modifyKey = (mode: 'clear' | 'replace') => page.evaluate(async mode => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('SonicMusicPlayerDB')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('ecs_playback_keys', 'readwrite')
        const store = tx.objectStore('ecs_playback_keys')
        if (mode === 'clear') store.clear()
        else {
          const ids = store.getAllKeys()
          ids.onsuccess = () => { for (const id of ids.result) store.put(key, id) }
        }
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  }, mode)

  // A new device has no previous playback key. Import must retrieve and cache it.
  await modifyKey('clear')
  await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer: file })
  await expect(page.getByText('1 songs imported')).toBeVisible()
  expect(calls).toContain('play')
  expect(await storedFileDigests(page, 'local_music')).toEqual([digest(file)])
  await page.getByTestId('local-ecs-export').click()
  const savedAgain = page.waitForEvent('download')
  await page.getByTestId('download-export-confirm').click()
  expect(digest(await bytesOf(await savedAgain))).toBe(digest(file))
  await page.locator('main').getByText(fixtureTitle, { exact: true }).click()
  await expect.poll(async () => (await getAudio(page))?.src).toMatch(/^blob:/)
  await expectPlaying(page)

  const altered = parts.slice()
  altered[3] = (altered[3][0] === 'A' ? 'B' : 'A') + altered[3].slice(1)
  const importInvalid = async (name: string, buffer: Buffer) => {
    await input.setInputFiles({ name, mimeType: 'application/octet-stream', buffer })
    await expect(page.getByText(/Could not read the file/)).toBeVisible()
    await expect(page.locator('main').getByText(fixtureTitle, { exact: true })).toHaveCount(1)
    await expect(page.getByText('0 songs imported')).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss import results' }).click()
  }
  await importInvalid('damaged.ecs', Buffer.from(altered.join('.')))
  await modifyKey('replace')
  await importInvalid('wrong-key.ecs', file)
  expect(await storedFileDigests(page, 'local_music')).toEqual([digest(file)])
})

for (const tier of [2, 3] as const) {
  test(`downloading a tier ${tier} variant preserves the selected level`, async ({ page }) => {
    const { env } = await useRealHandlers(page)
    const { file, ticket } = await downloadSong(page, tier)
    expect(await storedFileDigests(page, 'downloaded_music_v3')).toEqual([digest(file)])
    await page.goto('/#/downloads')
    const row = page.getByRole('row').filter({ hasText: fixtureTitle })
    await row.hover()
    await row.getByRole('button', { name: 'Export audio file' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('option[value=high]')).toHaveCount(tier === 2 ? 1 : 0)
    if (tier === 3) {
      await signIn(page, env)
      expect(await exportDecision(page, ticket, 'high')).toEqual({ status: 403, code: 'ECS_HIGHER_QUALITY_UNAVAILABLE' })
      expect((await exportDecision(page, ticket, 'original')).status).toBe(200)
    }
  })
}

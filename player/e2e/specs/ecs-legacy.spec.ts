import { test, expect } from '../fixtures'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('legacy download opens the exact ECS track in the current player', async ({ page }) => {
  const script = readFileSync(resolve(process.cwd(), '../js/index.js'), 'utf8')
  const start = script.indexOf('function openEcsDownload(')
  const end = script.indexOf('\n}', start) + 2
  expect(start).toBeGreaterThan(-1)
  await page.goto('/')
  await page.evaluate(script.slice(start, end) +
    "\nopenEcsDownload({source:'netease',id:'9451',name:'ECS Test Tone',artist:['Sonic']})")
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('ECS Test Tone', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: /^ECS3/ })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('sonic:ecs-download-handoff'))).toBeNull()
})

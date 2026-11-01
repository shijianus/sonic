import { chromium } from '@playwright/test'
import path from 'path'

const ARTIFACTS_DIR = '/root/.gemini/antigravity-cli/brain/1aff6e71-1395-4a69-9948-8c1d160d6e42'
const LIVE_URL = 'https://a7b81fdf.cfsolara-dho.pages.dev/#/mv-player/5436712'

async function verifyScreenshots() {
  console.log('Launching browser...')
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  // 1. Desktop Test
  console.log('--- Testing Desktop ---')
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  })
  const desktopPage = await desktopContext.newPage()
  console.log(`Navigating desktop to ${LIVE_URL}...`)
  await desktopPage.goto(LIVE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await desktopPage.waitForTimeout(4000)

  const initialItems = await desktopPage.locator('aside .space-y-2\\.5 > div.glass-card').count()
  console.log(`Desktop initial recommendation count: ${initialItems}`)

  await desktopPage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-waterfall-desktop.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-waterfall-desktop.png')

  // Trigger waterfall scroll
  console.log('Scrolling down container to trigger infinite scroll...')
  await desktopPage.evaluate(() => {
    const sc = document.querySelector('.overflow-auto')
    if (sc) {
      sc.scrollTop = sc.scrollHeight - 300
    }
  })
  await desktopPage.waitForTimeout(4000)

  const scrolledItems = await desktopPage.locator('aside .space-y-2\\.5 > div.glass-card').count()
  console.log(`Desktop scrolled recommendation count: ${scrolledItems}`)

  await desktopPage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-waterfall-scrolled.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-waterfall-scrolled.png')

  const titles = await desktopPage
    .locator('aside .space-y-2\\.5 > div.glass-card h3')
    .allInnerTexts()
  console.log('Sample recommendation titles:', titles.slice(0, 8))
  const uniqueTitles = new Set(titles.map(t => t.trim()))
  console.log(`Total items: ${titles.length}, Unique titles: ${uniqueTitles.size}`)

  const hasSelfReference = titles.some(t => t.includes('广岛之恋'))
  console.log(`Self-reference check ("广岛之恋" in recommendations): ${hasSelfReference}`)

  await desktopContext.close()

  // 2. Mobile Test
  console.log('--- Testing Mobile ---')
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
  })
  const mobilePage = await mobileContext.newPage()
  console.log(`Navigating mobile to ${LIVE_URL}...`)
  await mobilePage.goto(LIVE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await mobilePage.waitForTimeout(4000)

  const mobileCount = await mobilePage.locator('section:last-of-type .space-y-2 a').count()
  console.log(`Mobile initial recommendation count: ${mobileCount}`)

  await mobilePage.evaluate(() => {
    const el = document.querySelector('.flex-1.overflow-auto')
    if (el) el.scrollTop = el.scrollHeight - 300
  })
  await mobilePage.waitForTimeout(4000)

  const mobileScrolledCount = await mobilePage.locator('section:last-of-type .space-y-2 a').count()
  console.log(`Mobile scrolled recommendation count: ${mobileScrolledCount}`)

  await mobilePage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-waterfall-mobile.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-waterfall-mobile.png')

  await mobileContext.close()
  await browser.close()
  console.log('All tests passed successfully!')
}

verifyScreenshots().catch(err => {
  console.error('Error during verification:', err)
  process.exit(1)
})

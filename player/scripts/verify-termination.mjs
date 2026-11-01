import { chromium } from '@playwright/test'
import path from 'path'

const ARTIFACTS_DIR = '/root/.gemini/antigravity-cli/brain/1aff6e71-1395-4a69-9948-8c1d160d6e42'
const LIVE_URL = process.env.LIVE_URL || 'https://cfsolara-dho.pages.dev/#/mv-player/5436712'

async function verifyTermination() {
  console.log('Launching browser...')
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  // 1. Desktop Test
  console.log('--- Testing Desktop Exact Alignment ---')
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
  await desktopPage.waitForSelector('.space-y-2\\.5', { timeout: 15000 }).catch(() => {})
  await desktopPage.waitForTimeout(3000)

  // Scroll to bottom
  console.log('Scrolling down container to reach termination boundary...')
  await desktopPage.evaluate(() => {
    const sc = document.querySelector('.overflow-auto')
    if (sc) {
      sc.scrollTop = sc.scrollHeight - 300
    }
  })
  await desktopPage.waitForTimeout(3000)

  // Measure exact boundaries of .space-y-2.5 and .space-y-2.5.pt-1
  const desktopStats = await desktopPage.evaluate(() => {
    const commentsEl = document.querySelector('.space-y-2\\.5:not(.pt-1)')
    const recsEl = document.querySelector('.space-y-2\\.5.pt-1')
    if (!commentsEl || !recsEl) return { error: 'elements not found' }

    const cRect = commentsEl.getBoundingClientRect()
    const rRect = recsEl.getBoundingClientRect()

    const hasCommentsEndText = document.body.innerText.includes('已显示全部评论')
    const hasRecsEndText = document.body.innerText.includes('已显示全部推荐')

    const recCards = Array.from(recsEl.querySelectorAll(':scope > div.glass-card'))
    const lastRecCard = recCards[recCards.length - 1]
    const lastRecCardBottom = lastRecCard ? lastRecCard.getBoundingClientRect().bottom : null

    const commentCards = Array.from(commentsEl.querySelectorAll(':scope > div.glass-card'))
    const lastCommentCard = commentCards[commentCards.length - 1]
    const lastCommentCardBottom = lastCommentCard ? lastCommentCard.getBoundingClientRect().bottom : null

    return {
      commentsBottom: cRect.bottom,
      commentsTop: cRect.top,
      commentsHeight: cRect.height,
      recsBottom: rRect.bottom,
      recsTop: rRect.top,
      recsHeight: rRect.height,
      containerDiff: Math.abs(cRect.bottom - rRect.bottom),
      lastCardsDiff: (lastRecCardBottom && lastCommentCardBottom) ? Math.abs(lastRecCardBottom - lastCommentCardBottom) : null,
      hasCommentsEndText,
      hasRecsEndText,
      recCardCount: recCards.length,
      commentCardCount: commentCards.length,
    }
  })

  console.log('Desktop Alignment Stats:', desktopStats)

  // Assertions
  if (desktopStats.error) {
    throw new Error(`FAIL: ${desktopStats.error}`)
  }
  if (desktopStats.hasCommentsEndText) {
    throw new Error('FAIL: "已显示全部评论" text found in page! Should have been removed.')
  }
  if (desktopStats.hasRecsEndText) {
    throw new Error('FAIL: "已显示全部推荐" text found in page! Should have been removed.')
  }
  if (desktopStats.containerDiff > 1) {
    throw new Error(`FAIL: .space-y-2.5 and .space-y-2.5.pt-1 bottom diff is ${desktopStats.containerDiff}px, must be 0px!`)
  }

  // Take screenshot of desktop at termination line
  await desktopPage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-termination-desktop.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-termination-desktop.png')

  await desktopContext.close()

  // 2. Mobile Test
  console.log('--- Testing Mobile View ---')
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

  await mobilePage.evaluate(() => {
    const el = document.querySelector('.flex-1.overflow-auto')
    if (el) el.scrollTop = el.scrollHeight - 300
  })
  await mobilePage.waitForTimeout(3000)

  const mobileStats = await mobilePage.evaluate(() => {
    const hasRecsEndText = document.body.innerText.includes('已显示全部推荐')
    const hasCommentsEndText = document.body.innerText.includes('已显示全部评论')
    return {
      hasRecsEndText,
      hasCommentsEndText,
    }
  })
  console.log('Mobile Stats:', mobileStats)

  if (mobileStats.hasRecsEndText) {
    throw new Error('FAIL: Mobile still has "已显示全部推荐" text!')
  }

  await mobilePage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-termination-mobile.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-termination-mobile.png')

  await mobileContext.close()
  await browser.close()
  console.log('All verification checks passed with 100% success!')
}

verifyTermination().catch(err => {
  console.error('Error during termination verification:', err)
  process.exit(1)
})

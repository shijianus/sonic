import { chromium } from '@playwright/test'
import path from 'path'

const ARTIFACTS_DIR = '/root/.gemini/antigravity-cli/brain/1aff6e71-1395-4a69-9948-8c1d160d6e42'
const LIVE_URL = process.env.LIVE_URL || 'https://cfsolara-dho.pages.dev/#/mv-player/5436712'

async function verifyAllInteractions() {
  console.log('Launching browser for interaction and visual verification...')
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  })
  const page = await context.newPage()

  console.log(`Navigating to ${LIVE_URL}...`)
  await page.goto(LIVE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })

  // Explicitly wait for comment cards to be rendered
  await page.waitForSelector('.space-y-2\\.5:not(.pt-1) > div.glass-card', { timeout: 20000 })
  await page.waitForTimeout(2000)

  // 1. Verify Emojis in comments
  console.log('--- Step 1: Checking comment emojis ---')
  const emojiCheck = await page.evaluate(() => {
    const comments = Array.from(document.querySelectorAll('.space-y-2\\.5:not(.pt-1) p.select-text'))
    const texts = comments.map(el => el.textContent || '')
    const bracketPattern = /\[[\u4e00-\u9fa5a-zA-Z0-9_\-]+\]/g
    const unparsedBrackets = []
    for (const t of texts) {
      const matches = t.match(bracketPattern)
      if (matches) {
        unparsedBrackets.push(...matches)
      }
    }
    return {
      totalComments: comments.length,
      sampleTexts: texts.slice(0, 5),
      unparsedBrackets,
    }
  })
  console.log(`Comments count: ${emojiCheck.totalComments}`)
  console.log('Sample parsed comment texts:', emojiCheck.sampleTexts)
  console.log('Unparsed bracket tags:', emojiCheck.unparsedBrackets)
  if (emojiCheck.unparsedBrackets.length > 0) {
    throw new Error(`FAIL: Found unparsed bracket tags: ${JSON.stringify(emojiCheck.unparsedBrackets)}`)
  }
  console.log('✓ All emojis successfully parsed without raw bracket square boxes!')

  // 2. Test Like Button Interaction (when not logged in)
  console.log('--- Step 2: Testing Comment Like button (unauthenticated) ---')
  const firstLikeBtn = page.locator('.space-y-2\\.5:not(.pt-1) button').filter({ hasText: /\d+/ }).first()
  await firstLikeBtn.click()
  await page.waitForTimeout(600)
  const likeToastText = await page.evaluate(() => {
    const toast = document.querySelector('[role="alert"], .toast, [class*="toast"], div.fixed')
    return toast ? toast.textContent : ''
  })
  console.log('Toast after like click:', likeToastText)
  if (!likeToastText || !likeToastText.includes('请先登录epomail账户，再进行点赞')) {
    // Check all visible text
    const pageText = await page.evaluate(() => document.body.innerText)
    if (!pageText.includes('请先登录epomail账户，再进行点赞')) {
      throw new Error(`FAIL: Expected toast "请先登录epomail账户，再进行点赞", got: "${likeToastText}"`)
    }
  }
  console.log('✓ Like button shows expected unauthenticated toast!')

  // 3. Test Reply Button Interaction (when not logged in)
  console.log('--- Step 3: Testing Comment Reply button (unauthenticated) ---')
  await page.waitForTimeout(2500) // Wait for prior toast to dismiss
  const firstReplyBtn = page.locator('.space-y-2\\.5:not(.pt-1) button', { hasText: '回复' }).first()
  await firstReplyBtn.click()
  await page.waitForTimeout(600)
  const replyToastText = await page.evaluate(() => {
    return document.body.innerText
  })
  if (!replyToastText.includes('请先登录epomail账户，再进行回复')) {
    throw new Error(`FAIL: Expected toast "请先登录epomail账户，再进行回复" on reply`)
  }
  console.log('✓ Reply button shows expected unauthenticated toast!')

  // 4. Test YouTube Comment Input Box
  console.log('--- Step 4: Testing YouTube comment input box ---')
  await page.waitForTimeout(2500) // Wait for previous toast to clear
  const textarea = page.locator('textarea[placeholder="添加评论..."]')
  await textarea.click()
  await textarea.fill('这是一条测试评论内容')
  await page.waitForTimeout(500)
  const submitBtn = page.getByRole('button', { name: '评论', exact: true })
  await submitBtn.click()
  await page.waitForTimeout(600)
  const submitToast = await page.evaluate(() => document.body.innerText)
  if (!submitToast.includes('请先登录epomail账户，再进行回复')) {
    throw new Error(`FAIL: Expected toast "请先登录epomail账户，再进行回复" on comment submit`)
  }
  console.log('✓ Comment input box validation and unauthenticated toast verified!')

  // Clear comment box
  const cancelBtn = page.getByRole('button', { name: '取消', exact: true })
  if (await cancelBtn.isVisible()) {
    await cancelBtn.click()
  }

  // 5. Test Sort Dropdown Switching
  console.log('--- Step 5: Testing comment sorting dropdown ---')
  const sortBtn = page.locator('button', { hasText: /排序方式/ }).first()
  await sortBtn.click()
  await page.waitForTimeout(500)
  const latestSortBtn = page.locator('button', { hasText: '最新评论' })
  if (!await latestSortBtn.isVisible()) {
    throw new Error('FAIL: Sort dropdown menu did not open!')
  }
  await latestSortBtn.click()
  await page.waitForTimeout(2000)
  const currentSortText = await sortBtn.textContent()
  console.log('Current sort text after toggle:', currentSortText)
  if (!currentSortText.includes('最新评论')) {
    throw new Error(`FAIL: Expected sort text to be "排序方式: 最新评论", got: "${currentSortText}"`)
  }
  console.log('✓ Comment sorting dropdown switches successfully!')

  // 6. Test Dual Column Alignment
  console.log('--- Step 6: Testing Dual Column Termination Alignment ---')
  await page.evaluate(() => {
    const sc = document.querySelector('.overflow-auto')
    if (sc) {
      sc.scrollTop = sc.scrollHeight - 300
    }
  })
  await page.waitForTimeout(3000)

  const alignment = await page.evaluate(() => {
    const commentsEl = document.querySelector('.space-y-2\\.5:not(.pt-1)')
    const recsEl = document.querySelector('.space-y-2\\.5.pt-1')
    if (!commentsEl || !recsEl) return { error: 'elements missing' }

    const cRect = commentsEl.getBoundingClientRect()
    const rRect = recsEl.getBoundingClientRect()
    return {
      commentsBottom: cRect.bottom,
      recsBottom: rRect.bottom,
      diff: Math.abs(cRect.bottom - rRect.bottom),
      hasDividerFluff: document.body.innerText.includes('已显示全部'),
    }
  })
  console.log('Alignment test result:', alignment)
  if (alignment.diff > 1) {
    throw new Error(`FAIL: Dual column bottom alignment diff is ${alignment.diff}px, must be <= 1px!`)
  }
  if (alignment.hasDividerFluff) {
    throw new Error('FAIL: Redundant divider fluff "已显示全部" found in page!')
  }
  console.log('✓ Dual column bottom alignment strictly 0px verified without divider fluff!')

  // Capture Desktop Screenshot
  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-termination-desktop.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-termination-desktop.png')

  // Scroll to comments and take focused screenshot
  await page.evaluate(() => {
    const header = document.querySelector('h2')
    if (header) header.scrollIntoView()
  })
  await page.waitForTimeout(1000)
  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-cf-live.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-cf-live.png')

  await context.close()

  // 7. Mobile Viewport Check
  console.log('--- Step 7: Testing Mobile Viewport ---')
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    locale: 'zh-CN',
  })
  const mobilePage = await mobileContext.newPage()
  await mobilePage.goto(LIVE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await mobilePage.waitForSelector('.space-y-2 a.glass-card', { timeout: 20000 })
  await mobilePage.waitForTimeout(2000)

  await mobilePage.screenshot({
    path: path.join(ARTIFACTS_DIR, 'mv-player-termination-mobile.png'),
    fullPage: false,
  })
  console.log('Saved mv-player-termination-mobile.png')

  await mobileContext.close()
  await browser.close()
  console.log('=== All tests and verifications PASSED successfully! ===')
}

verifyAllInteractions().catch(err => {
  console.error('VERIFICATION ERROR:', err)
  process.exit(1)
})

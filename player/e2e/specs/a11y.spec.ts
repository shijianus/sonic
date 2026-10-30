import { test, expect } from '../fixtures'

/** 基础可访问性（桌面核心路径）：控件必须有可读名称与正确 ARIA 状态 */
test.describe('基础可访问性', () => {
  test('搜索、播放控制与进度条具备可访问名称', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()
    await page.getByTestId('song-row-9001').click()
    await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song One')

    await expect(page.getByTestId('nav-search-input')).toHaveAttribute('aria-label', 'Search')
    const toggle = page.getByTestId('player-toggle')
    await expect(toggle).toHaveAttribute('aria-label', /^(Play|Pause)$/)
    await expect(page.getByTestId('player-next')).toHaveAttribute('aria-label', 'Next track')
    await expect(page.getByTestId('player-previous')).toHaveAttribute('aria-label', 'Previous')

    const slider = page.getByTestId('player-progress')
    await expect(slider).toHaveAttribute('role', 'slider')
    await expect(slider).toHaveAttribute('aria-label', 'Playback progress')
    await expect(slider).toHaveAttribute('aria-valuemax', /\d+/)
    await expect(slider).toHaveAttribute('aria-valuenow', /\d+/)
  })

  test('所有可见按钮都有可访问名称', async ({ page }) => {
    await page.goto('/#/search?q=sonic')
    await expect(page.getByTestId('song-row-9001')).toBeVisible()

    const unnamed = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      return Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isVisible)
        .map(el => {
          const label =
            el.getAttribute('aria-label') ||
            (el.textContent || '').trim() ||
            el.getAttribute('title') ||
            ''
          return label ? '' : (el as HTMLElement).outerHTML.slice(0, 140)
        })
        .filter(Boolean)
    })

    expect(unnamed, `buttons without accessible name: ${unnamed.join(' | ')}`).toEqual([])
  })

  test('键盘可聚焦搜索框并提交查询', async ({ page }) => {
    await page.goto('/')
    const input = page.getByTestId('nav-search-input')
    await input.focus()
    await expect(input).toBeFocused()
    await input.fill('sonic')
    await input.press('Enter')
    await expect(page).toHaveURL(/#\/search\?q=sonic/)
    await expect(page.getByTestId('song-row-9001')).toBeVisible()
  })
})

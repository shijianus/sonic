import { test, expect } from '../fixtures'

/**
 * 公测范围路由冒烟：主要路由可加载、切换不白屏、未知路由落到 404。
 * 数据来自确定性 Mock，仅验证前端路由与渲染层，不代表真实服务端数据。
 */

const ROUTES: Array<{ name: string; path: string }> = [
  { name: '首页', path: '/' },
  { name: '搜索', path: '/#/search?q=sonic' },
  { name: '收藏', path: '/#/likes' },
  { name: '最近播放', path: '/#/recent' },
  { name: '榜单', path: '/#/charts' },
  { name: 'MV 列表', path: '/#/mv-list' },
  { name: '歌手', path: '/#/artists' },
  { name: '新专辑', path: '/#/new-albums' },
  { name: '下载', path: '/#/downloads' },
  { name: '本地音乐', path: '/#/local-music' },
  { name: '设置', path: '/#/settings' },
  { name: '歌单', path: '/#/playlist/123' },
]

for (const route of ROUTES) {
  test(`主要路由可加载：${route.name}`, async ({ page }) => {
    await page.goto(route.path)

    const main = page.locator('main').first()
    await expect(main).toBeVisible()
    await expect
      .poll(async () => (await main.innerText()).trim().length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    await expect(page.getByRole('heading', { name: '404', exact: true })).toHaveCount(0)
  })
}

test('侧边栏切换路由：连续切换不白屏', async ({ page }) => {
  await page.goto('/')
  const main = page.locator('main').first()
  await expect(main).toBeVisible()

  await page.getByRole('link', { name: 'Favorites' }).click()
  await expect(page).toHaveURL(/#\/likes/)
  await expect(main).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Favorites' })).toBeVisible()

  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/#\/settings/)
  await expect(main).toBeVisible()

  await page.getByRole('link', { name: 'Search' }).click()
  await expect(page).toHaveURL(/#\/search/)
  await expect(main).toBeVisible()
})

test('未知路由显示 404 而不是白屏', async ({ page }) => {
  await page.goto('/#/this-route-does-not-exist')
  await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible()
  await expect(page.locator('main').first()).toBeVisible()
})

test('匿名模式：页面不存在登录死入口', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('main').first()).toBeVisible()

  await expect(
    page.getByRole('link', { name: /^(log ?in|login|sign ?in)$/i })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^(log ?in|login|sign ?in)$/i })
  ).toHaveCount(0)
})

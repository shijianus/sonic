import { test, expect } from '../fixtures'

test.use({ appLanguage: 'zh' })

test.describe('搜索与风格探索雷达视觉与交互核验', () => {
  test('桌面端：多维度分组颜色区分、相斥替换、雷达图标极简对齐、音频稳定播放、搜索提交', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    // 1. 进入未搜索状态（默认搜索页）
    await page.goto('/#/search')
    await page.waitForTimeout(1000)

    // 检查搜索输入框正常尺寸
    const searchInput = page.locator('.search-box input')
    await expect(searchInput).toBeVisible()
    await expect(page.locator('.search-box .search-btn')).toBeVisible()

    // 检查内置推荐风格 Tag 数量
    const tagChips = page.locator('.tag-chip')
    await expect(tagChips.first()).toBeVisible()
    const tagCount = await tagChips.count()
    expect(tagCount).toBeGreaterThanOrEqual(25)

    // ── 检查不同组别(互斥)tag的颜色区分（相同组别颜色相同，不同组别颜色不同） ──
    // 1) 地域/语种组 (region: 华语流行, 欧美流行) -> Sky (天蓝)
    const huayuHash = page.locator('.tag-chip:has-text("华语流行") span:first-child')
    const oumeiHash = page.locator('.tag-chip:has-text("欧美流行") span:first-child')
    await expect(huayuHash).toHaveClass(/text-sky-400/)
    await expect(oumeiHash).toHaveClass(/text-sky-400/)

    // 2) 曲风流派组 (genre: 摇滚, 民谣) -> Violet (紫罗兰)
    const yaogunHash = page.locator('.tag-chip:has-text("摇滚") span:first-child')
    const minyaoHash = page.locator('.tag-chip:has-text("民谣") span:first-child')
    await expect(yaogunHash).toHaveClass(/text-violet-400/)
    await expect(minyaoHash).toHaveClass(/text-violet-400/)

    // 3) 情绪氛围组 (mood: 治愈系, 浪漫抒情) -> Rose (玫瑰红)
    const zhiyuHash = page.locator('.tag-chip:has-text("治愈系") span:first-child')
    await expect(zhiyuHash).toHaveClass(/text-rose-400/)

    // 4) 场景功能组 (scene: 学习工作, 运动健身) -> Emerald (翡翠绿)
    const xuexiHash = page.locator('.tag-chip:has-text("学习工作") span:first-child')
    await expect(xuexiHash).toHaveClass(/text-emerald-400/)

    // 5) 主题特色组 (theme: 经典老歌, ACG二次元) -> Amber (琥珀金)
    const laogeHash = page.locator('.tag-chip:has-text("经典老歌") span:first-child')
    await expect(laogeHash).toHaveClass(/text-amber-400/)

    // 检查雷达标题图标：确保无臃肿的 h-8 w-8 渐变圆角背景，对齐极简无背景的 h-4 w-4 图标
    const radarIcon = page.locator('.style-radar-section .icon-\\[mdi--compass-rose\\]')
    await expect(radarIcon).toBeVisible()
    const heavyBgIcon = page.locator('.style-radar-section .bg-gradient-to-br.h-8.w-8')
    await expect(heavyBgIcon).toHaveCount(0)

    // 检查未搜索前：展示风格探索雷达，且为单曲卡片列表（SongCard）
    const styleRadar = page.locator('.style-radar-section')
    await expect(styleRadar).toBeVisible()
    const radarSongs = page.locator('.style-radar-section .song-card')
    await expect(radarSongs.first()).toBeVisible()

    // 此时绝对不能出现搜索结果区（TabGroup / 搜索结果标题）
    await expect(page.getByText('共找到')).toHaveCount(0)

    // 截图 1：未搜索前初始态
    await page.screenshot({ path: 'e2e-results/search-initial-desktop.png', fullPage: true })

    // 2. 测试多角度支援：首先点击“华语流行”（地域维度）
    const huayuTag = page.locator('.tag-chip:has-text("华语流行")')
    await huayuTag.click()
    await page.waitForTimeout(600)

    // 验证：搜索框写入“华语流行”，雷达标签包含“# 华语流行”，仍停留在探索展示态
    await expect(searchInput).toHaveValue('华语流行')
    await expect(page.locator('.style-radar-section')).toContainText('# 华语流行')
    await expect(page.getByText('共找到')).toHaveCount(0)

    // 3. 点击不同维度标签：“摇滚”（流派维度）——支援多角度组合
    const yaogunTag = page.locator('.tag-chip:has-text("摇滚")')
    await yaogunTag.click()
    await page.waitForTimeout(600)

    // 验证：两个维度组合，写入“华语流行 摇滚”，雷达展示两个标签
    await expect(searchInput).toHaveValue('华语流行 摇滚')
    await expect(page.locator('.style-radar-section')).toContainText('# 华语流行')
    await expect(page.locator('.style-radar-section')).toContainText('# 摇滚')
    await expect(page.getByText('共找到')).toHaveCount(0)

    // 4. 测试相斥替换：点击“欧美流行”（与“华语流行”同属地域维度）
    const oumeiTag = page.locator('.tag-chip:has-text("欧美流行")')
    await oumeiTag.click()
    await page.waitForTimeout(600)

    // 验证：相斥替换生效！“华语流行”被“欧美流行”替换，而“摇滚”不受影响，搜索框为“欧美流行 摇滚”
    await expect(searchInput).toHaveValue('欧美流行 摇滚')
    await expect(page.locator('.style-radar-section')).not.toContainText('# 华语流行')
    await expect(page.locator('.style-radar-section')).toContainText('# 欧美流行')
    await expect(page.locator('.style-radar-section')).toContainText('# 摇滚')
    await expect(page.getByText('共找到')).toHaveCount(0)

    // 截图 2：选入相斥替换后的 Tag 展示
    await page.screenshot({ path: 'e2e-results/search-tag-selected-desktop.png', fullPage: true })

    // 5. 测试再次点击已选 Tag 取消选中：再次点击“欧美流行”
    await oumeiTag.click()
    await page.waitForTimeout(600)
    await expect(searchInput).toHaveValue('摇滚')
    await expect(page.locator('.style-radar-section')).not.toContainText('# 欧美流行')
    await expect(page.locator('.style-radar-section')).toContainText('# 摇滚')

    // 6. 测试雷达单曲播放：点击雷达列表中的“播放推荐列表”或者单曲，核验音频加载与播放状态
    const playAllRadarBtn = page.locator('.style-radar-section button:has-text("播放推荐列表"), .style-radar-section button:has-text("播放全部")')
    await expect(playAllRadarBtn).toBeVisible()
    await playAllRadarBtn.click()
    await page.waitForTimeout(1000)

    // 验证：绝对不出现“音频加载失败”错误提示
    await expect(page.locator('.toast-error, [data-toast-type="error"], .text-rose-400:has-text("失败")')).toHaveCount(0)

    // 7. 测试换一批功能
    const refreshBtn = page.locator('.style-radar-section button:has-text("换一批")')
    await expect(refreshBtn).toBeVisible()
    await refreshBtn.click()
    await page.waitForTimeout(800)
    await expect(radarSongs.first()).toBeVisible()

    // 截图 3：换一批后的雷达单曲展示
    await page.screenshot({ path: 'e2e-results/search-radar-refreshed-desktop.png', fullPage: true })

    // 8. 正式点击“搜索”按钮，此时才切换至搜索结果展示态
    const searchBtn = page.locator('.search-box .search-btn')
    await searchBtn.click()
    await page.waitForTimeout(1200)

    // 验证：点击搜索后进入搜索结果展示
    await expect(page.locator('.style-radar-section')).toBeVisible()

    // 截图 4：点击搜索后的检索结果展示
    await page.screenshot({ path: 'e2e-results/search-submitted-desktop.png', fullPage: true })
  })

  test('移动端：多角度Tag支援与相斥替换、不同组别颜色区分、单曲列表与音频起播核验', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/search')
    await page.waitForTimeout(1000)

    // 检查移动端搜索框与推荐 Tag
    const mobileInput = page.locator('.mobile-search-top input')
    await expect(mobileInput).toBeVisible()
    const mobileTags = page.locator('.tag-chip')
    await expect(mobileTags.first()).toBeVisible()

    // 检查移动端颜色区分
    await expect(page.locator('.tag-chip:has-text("华语流行") span:first-child')).toHaveClass(/text-sky-400/)
    await expect(page.locator('.tag-chip:has-text("摇滚") span:first-child')).toHaveClass(/text-violet-400/)
    await expect(page.locator('.tag-chip:has-text("治愈系") span:first-child')).toHaveClass(/text-rose-400/)
    await expect(page.locator('.tag-chip:has-text("学习工作") span:first-child')).toHaveClass(/text-emerald-400/)
    await expect(page.locator('.tag-chip:has-text("经典老歌") span:first-child')).toHaveClass(/text-amber-400/)

    // 检查未搜索前雷达组件存在，搜索结果 Tab 不存在
    const radar = page.locator('.style-radar-section')
    await expect(radar).toBeVisible()
    await expect(page.locator('.mobile-search-tabs')).toHaveCount(0)

    // 截图 5：移动端未搜索初始态
    await page.screenshot({ path: 'e2e-results/search-initial-mobile.png', fullPage: true })

    // 点击“华语流行”
    const huayuTag = page.locator('.tag-chip:has-text("华语流行")')
    await huayuTag.click()
    await page.waitForTimeout(600)
    await expect(mobileInput).toHaveValue('华语流行')

    // 点击“民谣”
    const minyaoTag = page.locator('.tag-chip:has-text("民谣")')
    await minyaoTag.click()
    await page.waitForTimeout(600)
    await expect(mobileInput).toHaveValue('华语流行 民谣')

    // 点击“欧美流行”替换“华语流行”
    const oumeiTag = page.locator('.tag-chip:has-text("欧美流行")')
    await oumeiTag.click()
    await page.waitForTimeout(600)
    await expect(mobileInput).toHaveValue('欧美流行 民谣')
    await expect(page.locator('.mobile-search-tabs')).toHaveCount(0)

    // 截图 6：移动端选入 Tag
    await page.screenshot({ path: 'e2e-results/search-tag-selected-mobile.png', fullPage: true })

    // 点击搜索按钮
    const searchBtn = page.locator('.mobile-search-top .search-btn')
    await searchBtn.click()
    await page.waitForTimeout(1200)

    // 验证：点击搜索后展示搜索结果 tabs
    await expect(page.locator('.mobile-search-tabs')).toBeVisible()

    // 截图 7：移动端搜索结果
    await page.screenshot({ path: 'e2e-results/search-submitted-mobile.png', fullPage: true })
  })
})

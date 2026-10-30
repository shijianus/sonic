import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT || 4173)
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * 浏览器 E2E 配置（SONIC-P1-01 / P1-02）。
 *
 * 测试对象：`player/dist` 构建产物 + `e2e/mock-server.mjs` 提供的确定性网关 Mock。
 * 不使用真实 CDN、真实 OAuth、真实上游音源；音频为本地生成的 WAV。
 * 本地可用系统 Chrome：E2E_CHANNEL=chrome；CI 安装 Playwright Chromium 时不设置该变量。
 */
export default defineConfig({
  testDir: './e2e/specs',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]]
    : [['list']],
  outputDir: 'e2e-results',
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    // 开启“减少动效”后列表点击直接起播，不再经过 250ms 封面飞行动画；
    // 既贴近无障碍场景，也让竞态用例的时序可复现。
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    },
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: /responsive\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-chromium',
      testMatch: /responsive\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'node e2e/mock-server.mjs',
    url: `${BASE_URL}/api/sonic/engine/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})

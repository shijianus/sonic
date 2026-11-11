import { test, expect, expectPlaying } from '../fixtures'

test('真实音频跳到末尾不会上报完播，从头播放才会上报', async ({ page }) => {
  const events: Array<{ type: string; track?: { id: number | string }; playedSeconds?: number }> = []
  await page.addInitScript(() => {
    localStorage.setItem('recommend', JSON.stringify({ personalizationEnabled: true, anonId: 'anon_playback_listening_e2e' }))
  })
  await page.route('**/api/sonic/events', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    events.push(...route.request().postDataJSON().events)
    await route.fulfill({ json: { data: { accepted: 1 } } })
  })

  await page.goto('/#/search?q=sonic')
  await page.getByTestId('song-row-9001').click()
  await expectPlaying(page)
  await expect.poll(() => events.some(event => event.type === 'play_start' && String(event.track?.id) === '9001')).toBe(true)

  await page.locator('#audioPlayer').evaluate((audio: HTMLAudioElement) => {
    audio.currentTime = audio.duration - 0.3
  })
  await expect(page.getByTestId('now-playing-title')).toHaveText('Test Song Two')
  await expectPlaying(page)
  await page.locator('#audioPlayer').evaluate((audio: HTMLAudioElement) => { audio.playbackRate = 4 })

  await expect.poll(() => events.find(event => event.type === 'play_complete' && String(event.track?.id) === '9002'), { timeout: 15_000 })
    .toMatchObject({ playedSeconds: 20 })
  expect(events.some(event => event.type === 'play_complete' && String(event.track?.id) === '9001')).toBe(false)
})

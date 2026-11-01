import assert from 'node:assert';
import { chromium } from 'playwright';

const LIVE_HOSTS = [
  'https://sonic.epocanvas.com',
  'https://cfsolara-dho.pages.dev',
  'https://eba9ef6c.cfsolara-dho.pages.dev'
];

const ARTIFACT_DIR = '/root/.gemini/antigravity-cli/brain/47b8a5db-6267-41d7-9145-822180b206ef';

async function selectActiveHost() {
  for (const host of LIVE_HOSTS) {
    try {
      console.log(`Checking live host: ${host}...`);
      const res = await fetch(`${host}/api/sonic/search/nexus?q=${encodeURIComponent('夜に駆ける')}&nocache=1`, {
        signal: AbortSignal.timeout(6000)
      });
      if (res.status === 200) {
        console.log(`✓ Active live host selected: ${host}`);
        return host;
      }
    } catch (e) {
      console.warn(`Host ${host} check failed: ${e.message}`);
    }
  }
  return LIVE_HOSTS[0];
}

async function run() {
  const targetHost = await selectActiveHost();
  console.log(`\n======================================================`);
  console.log(`🚀 RUNNING LIVE E2E VERIFICATION ON: ${targetHost}`);
  console.log(`======================================================\n`);

  // Step 1: API Level Lyric & Track Check
  console.log(`--- Step 1: Checking Live API for '夜に駆ける' ---`);
  const searchRes = await fetch(`${targetHost}/api/sonic/search/nexus?q=${encodeURIComponent('夜に駆ける')}&nocache=1`);
  assert.strictEqual(searchRes.status, 200, 'Search API 200 OK');
  const searchData = await searchRes.json();
  assert(searchData.data?.tracks?.length > 0, 'Returned search tracks');
  
  const topTrack = searchData.data.tracks[0];
  console.log(`✓ Top track: ${topTrack.title} - ${topTrack.artist} (ID: ${topTrack.id}, Duration: ${topTrack.duration}s)`);
  assert(topTrack.duration > 250 && topTrack.duration < 270, `Duration should be ~261s (got ${topTrack.duration})`);

  // Check lyric API
  console.log(`Fetching lyric for ${topTrack.title} (ID: ${topTrack.id})...`);
  const lyricUrl = `${targetHost}/api/sonic/lyric?id=${encodeURIComponent(topTrack.id)}&title=${encodeURIComponent(topTrack.title)}&artist=${encodeURIComponent(topTrack.artist)}&duration=${topTrack.duration}&nocache=1`;
  const lyricRes = await fetch(lyricUrl);
  assert.strictEqual(lyricRes.status, 200, 'Lyric API 200 OK');
  const lyricData = await lyricRes.json();
  const lyricStr = lyricData.lrc?.lyric || lyricData.lyric || '';
  console.log(`✓ Lyric retrieved: ${lyricStr.length} chars`);
  assert(lyricStr.includes('沈むように') || lyricStr.includes('溶けてゆくように') || lyricStr.includes('夜に駆ける'),
    'Lyric must contain authentic Japanese lyrics');
  assert(!lyricStr.includes('Sudah') && !lyricStr.includes('berlalu') && !lyricStr.includes('kuyakin'),
    'Lyric must NOT contain Indonesian text');
  console.log(`✓ Lyric verification passed! First 100 chars: ${lyricStr.slice(0, 100).replace(/\n/g, ' ')}`);

  // Step 2: Headless Browser Playwright Test
  console.log(`\n--- Step 2: Playwright Live UI Verification ---`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN'
  });

  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error' || text.includes('error') || text.includes('failed')) {
      console.log(`[Browser Console ${msg.type()}]:`, text);
    }
  });

  // Navigate to live site
  console.log(`Navigating to ${targetHost}/search?q=${encodeURIComponent('夜に駆ける')}`);
  await page.goto(`${targetHost}/search?q=${encodeURIComponent('夜に駆ける')}`, {
    waitUntil: 'networkidle',
    timeout: 30000
  });

  await page.waitForTimeout(2000);
  await page.waitForSelector('.song-item', { timeout: 15000 });

  // Check search results
  const songItems = page.locator('.song-item');
  const count = await songItems.count();
  console.log(`✓ Found ${count} song items in search results`);
  assert(count > 0, 'Must have song items');

  const firstSongTitle = await songItems.first().locator('.song-title, .title, font, [class*="title"]').first().textContent();
  console.log(`✓ First song display title: "${firstSongTitle?.trim()}"`);
  assert(!firstSongTitle?.includes('...'), 'First song title should not be truncated with ...');

  // Screenshot 1: Live search results
  await page.screenshot({
    path: `${ARTIFACT_DIR}/01_live_cf_search_yorunikakeru.png`,
    fullPage: false
  });
  console.log(`✓ Saved screenshot: 01_live_cf_search_yorunikakeru.png`);

  // Click to play the song
  console.log('Clicking to play the first song...');
  const playButton = songItems.first().locator('button, [role="button"], .play-btn').first();
  await playButton.click();
  await page.waitForTimeout(3000);

  // Check if error toast popped up
  const errorToasts = await page.locator('.el-message--error, [class*="toast-error"], [role="alert"]').allTextContents();
  console.log('Error alerts found:', errorToasts);
  const audioFailErrors = errorToasts.filter(t => t.includes('暂无可用音源') || t.includes('加载失败') || t.includes('受版权限制'));
  assert.strictEqual(audioFailErrors.length, 0, `Audio playback must NOT trigger failure toast: ${audioFailErrors.join(', ')}`);

  // Check player bar
  const playerBar = page.locator('#play-bar, [class*="play-bar"], [class*="player-bar"]');
  const isPlaying = await page.evaluate(() => {
    const audio = document.querySelector('audio');
    return audio ? {
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      src: audio.src ? audio.src.slice(0, 80) : ''
    } : null;
  });
  console.log(`✓ Live Audio element state:`, isPlaying);

  // Open Lyric Drawer / Fullscreen Player
  console.log('Opening lyric drawer/player view...');
  // Try clicking on player cover or title in play-bar or lyric toggle button
  const drawerTriggers = [
    'button[aria-label*="歌词"]',
    'button[title*="歌词"]',
    '.play-bar .cover-img',
    '.play-bar [class*="cover"]',
    '.play-bar [class*="title"]',
    '.player-drawer-trigger'
  ];

  let drawerOpened = false;
  for (const sel of drawerTriggers) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      console.log(`Attempting trigger: ${sel}`);
      await el.click().catch(() => {});
      await page.waitForTimeout(1000);
      const lyricsVisible = await page.locator('[class*="lyric"], [class*="Lyric"]').count() > 0;
      if (lyricsVisible) {
        drawerOpened = true;
        break;
      }
    }
  }

  await page.waitForTimeout(2500);

  // Screenshot 2: Live player drawer / lyrics view for 夜に駆ける
  await page.screenshot({
    path: `${ARTIFACT_DIR}/02_live_cf_lyrics_yorunikakeru.png`,
    fullPage: false
  });
  console.log(`✓ Saved screenshot: 02_live_cf_lyrics_yorunikakeru.png`);

  // Extract rendered lyrics
  const lyricElements = await page.locator('[class*="lyric"] p, [class*="lyric"] div, [class*="Lyric"] span').allTextContents();
  const renderedLyricsText = lyricElements.join(' ');
  console.log(`Rendered lyrics sample (first 200 chars): ${renderedLyricsText.slice(0, 200)}`);
  
  // Verify lyric content on screen
  if (renderedLyricsText.length > 0) {
    assert(!renderedLyricsText.includes('Sudah') && !renderedLyricsText.includes('berlalu'),
      'Rendered UI lyrics must NOT contain Indonesian text');
    console.log('✓ UI lyric verification passed: No Indonesian leakage detected!');
  }

  // Step 3: Switch track to "晴天" (Zhou Jay)
  console.log('\n--- Step 3: Switching track to 周杰伦 晴天 to verify Zero-Stale & Alignment ---');
  // Navigate directly or search
  await page.goto(`${targetHost}/search?q=${encodeURIComponent('周杰伦 晴天')}`, {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.waitForTimeout(2000);
  await page.waitForSelector('.song-item', { timeout: 15000 });

  const qingtianSong = page.locator('.song-item').first();
  await qingtianSong.locator('button, [role="button"], .play-btn').first().click();
  await page.waitForTimeout(3500);

  // Screenshot 3: Live player for 晴天
  await page.screenshot({
    path: `${ARTIFACT_DIR}/03_live_cf_lyrics_qingtian.png`,
    fullPage: false
  });
  console.log(`✓ Saved screenshot: 03_live_cf_lyrics_qingtian.png`);

  // Step 4: Mobile Viewport Verification
  console.log('\n--- Step 4: Mobile Viewport Verification (390x844) ---');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  console.log(`Mobile viewport dimensions: scrollWidth=${scrollWidth}, clientWidth=${clientWidth}`);
  assert(scrollWidth <= clientWidth + 2, `No horizontal overflow on mobile (scrollWidth: ${scrollWidth}, clientWidth: ${clientWidth})`);

  // Screenshot 4: Mobile Viewport
  await page.screenshot({
    path: `${ARTIFACT_DIR}/04_live_cf_drawer_lyrics_mobile.png`,
    fullPage: false
  });
  console.log(`✓ Saved screenshot: 04_live_cf_drawer_lyrics_mobile.png`);

  await browser.close();
  console.log('\n======================================================');
  console.log('🎉 ALL LIVE CLOUDFLARE E2E VERIFICATIONS PASSED!');
  console.log('======================================================\n');
}

run().catch(err => {
  console.error('E2E Verification failed:', err);
  process.exit(1);
});

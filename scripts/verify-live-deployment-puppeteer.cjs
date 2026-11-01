const assert = require('node:assert');
const puppeteer = require('/home/shijian/projects/shijianus-blog/node_modules/puppeteer');

const LIVE_HOSTS = [
  'https://cfsolara-dho.pages.dev',
  'https://sonic.epocanvas.com',
  'https://eba9ef6c.cfsolara-dho.pages.dev'
];

const ARTIFACT_DIR = '/root/.gemini/antigravity-cli/brain/47b8a5db-6267-41d7-9145-822180b206ef';

async function selectActiveHost() {
  for (const host of LIVE_HOSTS) {
    try {
      console.log(`Checking live host: ${host}...`);
      const res = await fetch(`${host}/api/sonic/search/nexus?q=${encodeURIComponent('夜に駆ける')}&nocache=1`, {
        signal: AbortSignal.timeout(8000)
      });
      if (res.status === 200) {
        const data = await res.json();
        if (data?.data?.tracks?.length > 0) {
          console.log(`✓ Active live host selected: ${host} (returned ${data.data.tracks.length} tracks)`);
          return host;
        }
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

  // Step 1: Live API Level Verification
  console.log(`--- Step 1: Verifying Live Nexus Search & Lyric APIs ---`);
  const searchUrl = `${targetHost}/api/sonic/search/nexus?q=${encodeURIComponent('夜に駆ける')}&nocache=1`;
  const searchRes = await fetch(searchUrl);
  assert.strictEqual(searchRes.status, 200, `Search API status 200 (got ${searchRes.status})`);
  const searchData = await searchRes.json();
  assert(searchData.data?.tracks?.length > 0, 'Must return tracks for 夜に駆ける');

  const topTrack = searchData.data.tracks[0];
  console.log(`✓ Top Track: "${topTrack.title}" by "${topTrack.artist}" (ID: ${topTrack.id}, Duration: ${topTrack.duration}s)`);
  assert(topTrack.duration > 250 && topTrack.duration < 270, `Duration should be ~261s (got ${topTrack.duration})`);

  // Fetch Lyric API (Nexus multi-engine provider with word-sync)
  const lyricUrl = `${targetHost}/api/sonic/lyrics/nexus?id=${encodeURIComponent(topTrack.id)}&title=${encodeURIComponent(topTrack.title)}&artist=${encodeURIComponent(topTrack.artist)}&duration=${topTrack.duration}&nocache=1`;
  console.log(`Fetching Lyric API: ${lyricUrl}`);
  const lyricRes = await fetch(lyricUrl);
  assert.strictEqual(lyricRes.status, 200, `Lyric API status 200 (got ${lyricRes.status})`);
  const lyricData = await lyricRes.json();
  const rawLyric = lyricData.data?.plainLyrics || lyricData.plainLyrics || lyricData.lrc?.lyric || '';
  console.log(`✓ Lyric length: ${rawLyric.length} characters, provider: ${lyricData.data?.provider || 'default'}`);
  assert(rawLyric.length > 50, 'Lyric content must not be empty');
  
  // Gating & Alignment Assertions
  assert(rawLyric.includes('沈むように') || rawLyric.includes('溶けてゆくように') || rawLyric.includes('夜に駆ける'),
    'Lyric MUST contain authentic Japanese lyrics');
  assert(!rawLyric.includes('Sudah') && !rawLyric.includes('berlalu') && !rawLyric.includes('kuyakin') && !rawLyric.includes('merelakanmu'),
    'Lyric MUST NOT contain Indonesian leakage');
  console.log(`✓ Direct Lyric API passed gating! Sample: ${rawLyric.slice(0, 120).replace(/\n/g, ' ')}`);

  // Step 2: Headless Browser UI Verification
  console.log(`\n--- Step 2: Headless Chrome UI Verification ---`);
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' || text.includes('Error') || text.includes('error')) {
      console.log(`[Browser Console ${msg.type()}]:`, text.slice(0, 160));
    }
  });

  page.on('response', res => {
    if (res.status() >= 400) {
      console.log(`[HTTP ${res.status()}]:`, res.url());
    }
  });

  // Navigate to live search page
  const searchPageUrl = `${targetHost}/search?q=${encodeURIComponent('夜に駆ける')}`;
  console.log(`Navigating to ${searchPageUrl}...`);
  await page.goto(searchPageUrl, { waitUntil: 'networkidle2', timeout: 35000 });

  await page.waitForSelector('.song-item', { timeout: 15000 });
  const songCount = await page.$$eval('.song-item', els => els.length);
  console.log(`✓ Rendered ${songCount} song items`);
  assert(songCount > 0, 'Must render song items');

  // Verify song title is NOT truncated with '...'
  const topSongTitle = await page.$eval('.song-item', el => {
    const titleEl = el.querySelector('.song-title, .title, font, [class*="title"]');
    return titleEl ? titleEl.textContent.trim() : el.textContent.trim();
  });
  console.log(`✓ Top song display title: "${topSongTitle}"`);
  assert(!topSongTitle.includes('...'), 'Song title should not be truncated with ...');

  // Screenshot 1: Search results
  const screenshot1Path = `${ARTIFACT_DIR}/01_search_yorunikakeru_verified.png`;
  await page.screenshot({ path: screenshot1Path });
  console.log(`✓ Saved screenshot 1: ${screenshot1Path}`);

  // Click on the first song item to play
  console.log('Clicking to play the song...');
  await page.click('.song-item');
  await new Promise(r => setTimeout(r, 3000));

  // Verify audio state in browser
  const audioState = await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) return { exists: false };
    return {
      exists: true,
      src: audio.src,
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
      error: audio.error ? audio.error.message || audio.error.code : null
    };
  });
  console.log('✓ Browser audio element state:', audioState);
  assert(audioState.exists, 'Audio element must exist');
  assert(!audioState.error, `Audio element must not be in error state: ${audioState.error}`);

  // Check no error toast on screen
  const errorAlerts = await page.evaluate(() => {
    const alerts = Array.from(document.querySelectorAll('.el-message--error, [role="alert"], [class*="toast-error"]'));
    return alerts.map(a => a.textContent.trim());
  });
  const audioFailErrors = errorAlerts.filter(t => t.includes('暂无可用音源') || t.includes('加载失败') || t.includes('版权限制'));
  console.log('Error alerts found:', errorAlerts);
  assert.strictEqual(audioFailErrors.length, 0, `Playback must not pop up failure alert: ${audioFailErrors.join(', ')}`);

  // Open player drawer using #footer-cover
  console.log('Opening Player Drawer via #footer-cover...');
  await page.waitForSelector('#footer-cover', { timeout: 10000 });
  await page.click('#footer-cover');
  await new Promise(r => setTimeout(r, 2500));

  // Verify lyrics in drawer
  await page.waitForSelector('[data-testid="lyrics-container"], .lyrics-scroll, .lyrics-container', { timeout: 10000 });
  const lyricsTexts = await page.$$eval('.lyric-line, .lyric-text, [data-testid="lyrics-container"] p', els => els.map(e => e.textContent.trim()).filter(Boolean));
  const fullRenderedLyric = lyricsTexts.join(' ');
  console.log(`Rendered lyric count: ${lyricsTexts.length} lines`);
  console.log(`Rendered lyric sample: ${fullRenderedLyric.slice(0, 160)}`);
  
  assert(fullRenderedLyric.includes('沈むように') || fullRenderedLyric.includes('溶けてゆくように') || fullRenderedLyric.includes('夜に駆ける'),
    'Rendered lyric must contain Japanese lyric text');
  assert(!fullRenderedLyric.includes('Sudah') && !fullRenderedLyric.includes('berlalu'),
    'Rendered lyric must NOT contain Indonesian text');

  // Screenshot 2: Drawer lyrics for 夜に駆ける
  const screenshot2Path = `${ARTIFACT_DIR}/02_drawer_lyrics_yorunikakeru.png`;
  await page.screenshot({ path: screenshot2Path });
  console.log(`✓ Saved screenshot 2: ${screenshot2Path}`);

  // Step 3: Switch track to "晴天" (Zhou Jay) to verify Zero-Stale and seamless playback
  console.log(`\n--- Step 3: Switch to 周杰伦《晴天》to verify zero-stale and auto-play ---`);
  await page.goto(`${targetHost}/search?q=${encodeURIComponent('周杰伦 晴天')}`, { waitUntil: 'networkidle2', timeout: 35000 });
  await page.waitForSelector('.song-item', { timeout: 15000 });
  
  console.log('Clicking to play 晴天...');
  await page.click('.song-item');
  await new Promise(r => setTimeout(r, 3000));

  await page.waitForSelector('#footer-cover', { timeout: 10000 });
  await page.click('#footer-cover');
  await new Promise(r => setTimeout(r, 2500));

  await page.waitForSelector('[data-testid="lyrics-container"], .lyrics-scroll, .lyrics-container', { timeout: 10000 });
  const qingtianLyrics = await page.$$eval('.lyric-line, .lyric-text, [data-testid="lyrics-container"] p', els => els.map(e => e.textContent.trim()).filter(Boolean));
  const fullQingtianLyric = qingtianLyrics.join(' ');
  console.log(`晴天 rendered lyric sample: ${fullQingtianLyric.slice(0, 160)}`);

  assert(fullQingtianLyric.includes('故事的小黄花') || fullQingtianLyric.includes('晴天') || fullQingtianLyric.includes('为你翘课的那一天'),
    'Rendered lyric must contain 晴天 lyrics');
  assert(!fullQingtianLyric.includes('沈むように'), 'Old song lyrics must be zero-staled and completely evicted');

  // Screenshot 3: Drawer lyrics for 晴天
  const screenshot3Path = `${ARTIFACT_DIR}/03_drawer_lyrics_qingtian.png`;
  await page.screenshot({ path: screenshot3Path });
  console.log(`✓ Saved screenshot 3: ${screenshot3Path}`);

  // Step 4: Mobile Viewport Verification (390x844)
  console.log(`\n--- Step 4: Mobile Viewport Check (390x844) ---`);
  await page.setViewport({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 2000));

  const overflowInfo = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
  console.log(`Mobile viewport dimensions: scrollWidth=${overflowInfo.scrollWidth}, clientWidth=${overflowInfo.clientWidth}`);
  assert(overflowInfo.scrollWidth <= overflowInfo.clientWidth + 2, 'No horizontal overflow on mobile');

  // Screenshot 4: Mobile Viewport
  const screenshot4Path = `${ARTIFACT_DIR}/04_drawer_lyrics_mobile.png`;
  await page.screenshot({ path: screenshot4Path });
  console.log(`✓ Saved screenshot 4: ${screenshot4Path}`);

  await browser.close();
  console.log(`\n======================================================`);
  console.log(`🎉 ALL LIVE PRODUCTION VERIFICATIONS COMPLETED SUCCESSFULLY!`);
  console.log(`======================================================\n`);
}

run().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});

// Test suite for Cover Resolution and Proxy Gateway
import { onRequestGet } from '../functions/api/music/cover';
import { buildNeteaseLinuxApiParams } from '../functions/_lib/sonic/crypto';
import { withProviderFixtures } from './test-fixtures/provider-fetch.mjs';

const trackId = 347230;
const albumMid = '000QgDxv39bMKQ';
const artist = '周杰伦';
const trackImage = 'https://p1.music.126.net/cover-fixture-track.png';
const artistImage = 'https://p1.music.126.net/cover-fixture-artist.png';
const qqImage = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`;
const missingImage = 'https://p1.music.126.net/cover-fixture-missing.png';
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOw2PvjPwAGCwLtgxz7OwAAAABJRU5ErkJggg==',
  'base64',
);

const neteaseFixtures = new Map([
  [buildNeteaseLinuxApiParams({
    method: 'POST',
    url: 'http://music.163.com/api/v3/song/detail',
    params: { c: JSON.stringify([{ id: trackId }]), ids: JSON.stringify([trackId]) },
  }), { songs: [{ al: { picUrl: trackImage } }] }],
  [buildNeteaseLinuxApiParams({
    method: 'POST',
    url: 'http://music.163.com/api/cloudsearch/pc',
    params: { s: artist, type: 100, limit: 1, offset: 0 },
  }), { result: { artists: [{ img1v1Url: artistImage }] } }],
]);

const imageReferers = new Map([
  [trackImage, 'https://music.163.com/'],
  [artistImage, 'https://music.163.com/'],
  [qqImage, 'https://y.qq.com/'],
]);

function coverFixture(url, init) {
  const method = init.method || 'GET';
  if (method === 'POST' && url.href === 'https://music.163.com/api/linux/forward') {
    const data = neteaseFixtures.get(new URLSearchParams(init.body).get('eparams'));
    if (data) return Response.json(data);
  }
  if (method === 'POST' && url.href === 'https://u.y.qq.com/cgi-bin/musicu.fcg') {
    const detail = JSON.parse(init.body).songinfo;
    if (detail?.module === 'music.pf_song_detail_svr' && detail.method === 'get_song_detail_yqq' &&
        detail.param?.song_mid === albumMid) {
      // The input is an album MID, so the song-detail lookup has no result.
      return Response.json({ songinfo: { data: {} } });
    }
  }
  if (method === 'GET' && url.href === missingImage) return new Response(null, { status: 404 });
  const expectedReferer = imageReferers.get(url.href);
  if (method === 'GET' && expectedReferer && new Headers(init.headers).get('referer') === expectedReferer) {
    return new Response(imageBytes, {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(imageBytes.length) },
    });
  }
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

async function assertFixtureImage(response, provider) {
  assert(response.headers.get('content-type') === 'image/png', 'Returns the fixture image content type');
  assert(response.headers.get('x-sonic-provider') === provider, `Resolved cover via ${provider}`);
  assert(Buffer.from(await response.arrayBuffer()).equals(imageBytes), 'Preserves the upstream image bytes');
}

async function runTests() {
  console.log('=== Running Cover Gateway Test Suite ===\n');

  const mockEnv = {};

  // Test 1: Fallback SVG when no params
  console.log('1. Testing GET /api/music/cover with no params');
  {
    const req = new Request('http://localhost/api/music/cover');
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    assert(res.headers.get('content-type')?.includes('image/svg+xml'), 'Returns SVG fallback');
    const text = await res.text();
    assert(text.includes('<svg') && text.includes('sonicCoverGrad'), 'Contains valid SVG vector graphic');
  }

  // Test 2: NetEase song ID resolution
  console.log('\n2. Testing NetEase Song ID Cover Resolution');
  {
    const req = new Request(`http://localhost/api/music/cover?id=${trackId}&source=netease`);
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    assert(res.headers.get('access-control-allow-origin') === '*', 'CORS Allow-Origin header is *');
    await assertFixtureImage(res, 'netease');
  }

  // Test 3: QQ Music mid resolution
  console.log('\n3. Testing QQ Music Mid Cover Resolution');
  {
    const req = new Request(`http://localhost/api/music/cover?id=${albumMid}&source=qq`);
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    await assertFixtureImage(res, 'qq');
  }

  // Test 4: Artist Avatar Fallback
  console.log('\n4. Testing Artist Avatar Search Fallback');
  {
    const req = new Request(`http://localhost/api/music/cover?artist=${encodeURIComponent(artist)}`);
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    await assertFixtureImage(res, 'netease-artist');
  }

  // Test 5: Direct URL Proxy with Anti-Hotlinking
  console.log('\n5. Testing Direct URL Proxy Mode');
  {
    const req = new Request(`http://localhost/api/music/cover?url=${encodeURIComponent(qqImage)}`);
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    assert(res.headers.get('access-control-allow-origin') === '*', 'CORS Allow-Origin header is present on proxy');
    assert(res.headers.get('content-length') === String(imageBytes.length), 'Preserves the proxy content length');
    await assertFixtureImage(res, 'proxy');
  }

  // Test 6: Invalid image URL gracefully falls back to SVG
  console.log('\n6. Testing Invalid Target URL Fallback');
  for (const target of [missingImage, 'https://example.com/nonexistent_image_123456789.png']) {
    const req = new Request(`http://localhost/api/music/cover?url=${encodeURIComponent(target)}`);
    const res = await onRequestGet({ request: req, env: mockEnv });
    assert(res.status === 200, `Status is 200 (got ${res.status})`);
    assert(res.headers.get('content-type')?.includes('image/svg+xml'), 'Fails over to SVG fallback instead of 404');
    assert((await res.text()).includes('sonicCoverGrad'), 'Returns the built-in fallback image');
  }

  console.log(`\n========================================`);
  console.log(`Cover Gateway Test Results: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exitCode = 1;
}

withProviderFixtures(coverFixture, runTests).catch(err => {
  console.error('Test runner failed:', err);
  process.exitCode = 1;
});

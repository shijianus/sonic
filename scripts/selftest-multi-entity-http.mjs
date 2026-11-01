// Multi-entity HTTP self-verification against a running engine.
// Usage: node scripts/selftest-multi-entity-http.mjs <baseUrl> <engineKey>
// Writes raw evidence JSON to graytest/multi-entity-impl/ and prints an ASCII-safe summary.

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3210';
const KEY = process.argv[3] || 'test_super_secret_engine_key_999_32chars!';
const ANON = 'anon_selftest_me_002';
const HEADERS = { 'X-Sonic-Engine-Key': KEY, 'X-Sonic-Anon-Id': ANON, 'Content-Type': 'application/json' };
const OUT_DIR = path.resolve('graytest/multi-entity-impl');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function call(method, urlPath, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: HEADERS,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, latencyMs: Date.now() - t0, json };
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
}

// Fresh identity: clear any prior state
await call('DELETE', '/api/sonic/events');

// 1a. Album favorite (embedded real catalog track 晴天@叶惠美)
const fav = await call('POST', '/api/sonic/events', {
  events: [
    {
      type: 'favorite',
      entityType: 'album',
      entityId: 'alb_yehuimei_jay',
      track: { id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, platform: 'netease' },
    },
  ],
});
fs.writeFileSync(path.join(OUT_DIR, 'h1a_favorite_album.json'), JSON.stringify(fav, null, 2));
check('1a album favorite accepted', fav.status === 200 && fav.json?.data?.accepted === 1 && fav.json?.data?.entityFeedbackAccepted === 1,
  `status=${fav.status} accepted=${fav.json?.data?.accepted} entityFeedbackAccepted=${fav.json?.data?.entityFeedbackAccepted}`);

// 1b. MV watch_complete
const watch = await call('POST', '/api/sonic/events', {
  events: [
    {
      type: 'watch_complete',
      entityType: 'mv',
      entityId: 'mv_gray_347230',
      entityTitle: '海阔天空 MV',
      progressRatio: 1.0,
      track: { id: 347230, title: '海阔天空', artist: 'Beyond', album: '乐与怒', duration: 326, platform: 'netease' },
    },
  ],
});
fs.writeFileSync(path.join(OUT_DIR, 'h1b_watch_mv.json'), JSON.stringify(watch, null, 2));
check('1b mv watch_complete accepted', watch.status === 200 && watch.json?.data?.accepted === 1 && watch.json?.data?.entityFeedbackAccepted === 1,
  `status=${watch.status} accepted=${watch.json?.data?.accepted} entityFeedbackAccepted=${watch.json?.data?.entityFeedbackAccepted}`);

// 1c. Invalid entity type must be a 4xx, never silently accepted
const badEntity = await call('POST', '/api/sonic/events', {
  events: [{ type: 'favorite', entityType: 'artist', entityId: 'art_x' }],
});
fs.writeFileSync(path.join(OUT_DIR, 'h1c_invalid_entity_type.json'), JSON.stringify(badEntity, null, 2));
check('1c invalid entityType -> 4xx', badEntity.status === 400 && badEntity.json?.error?.code === 'INVALID_ENTITY_TYPE',
  `status=${badEntity.status} code=${badEntity.json?.error?.code}`);

// 2. Mixed feed contains non-track types
const mixed = await call('GET', '/api/sonic/recommend/for-you?feed=mixed&count=12');
fs.writeFileSync(path.join(OUT_DIR, 'h2_mixed.json'), JSON.stringify(mixed, null, 2));
const items = mixed.json?.data?.items || [];
const nonTrack = items.filter((i) => i.type !== 'track');
check('2 mixed non-track present', mixed.status === 200 && items.length === 12 && nonTrack.length > 0,
  `status=${mixed.status} items=${items.length} distribution=${JSON.stringify(mixed.json?.data?.distribution)} nonTrackTypes=${[...new Set(nonTrack.map((i) => i.type))].join(',')}`);
check('2b item contract', items.every((i) => i.type && i.id && i.title && Number.isFinite(i.score) && i.reason && i.reasonCode),
  `all items carry type/id/title/score/reason/reasonCode`);
const favoredAlbum = items.find((i) => i.type === 'album' && (i.reason || '').includes('收藏'));
check('2c favored album ranked with affinity reason', Boolean(favoredAlbum),
  `album item reason=${favoredAlbum ? encodeURIComponent(favoredAlbum.reason) : 'none'} score=${favoredAlbum?.score ?? 'n/a'}`);

// 3. Legacy contract without feed stays tracks-only
const legacy = await call('GET', '/api/sonic/recommend/for-you?count=6');
fs.writeFileSync(path.join(OUT_DIR, 'h3_legacy.json'), JSON.stringify(legacy, null, 2));
const d = legacy.json?.data || {};
check('3 legacy tracks contract intact', legacy.status === 200 && Array.isArray(d.tracks) && d.tracks.length === 6 && d.feed === undefined && d.items === undefined,
  `status=${legacy.status} keys=${Object.keys(d).join(',')} tracks=${d.tracks?.length} top1=${encodeURIComponent(d.tracks?.[0]?.title || '')}`);

// 3b. Unknown feed values must NOT trigger mixed (strict legacy)
const otherFeed = await call('GET', '/api/sonic/recommend/for-you?feed=top&count=4');
check('3b non-mixed feed value falls back to legacy', otherFeed.status === 200 && Array.isArray(otherFeed.json?.data?.tracks) && otherFeed.json?.data?.feed === undefined,
  `status=${otherFeed.status} tracks=${otherFeed.json?.data?.tracks?.length} feed=${otherFeed.json?.data?.feed}`);

// 4. DELETE clears both behavior_events and user_entity_feedback
const del = await call('DELETE', '/api/sonic/events');
fs.writeFileSync(path.join(OUT_DIR, 'h4_delete.json'), JSON.stringify(del, null, 2));
check('4a delete clears all', del.status === 200 && del.json?.data?.cleared === true && del.json?.data?.removedEntityFeedback === 2,
  `status=${del.status} removedEvents=${del.json?.data?.removedEvents} removedEntityFeedback=${del.json?.data?.removedEntityFeedback}`);
const profile = await call('GET', '/api/sonic/events');
fs.writeFileSync(path.join(OUT_DIR, 'h4b_profile_after_delete.json'), JSON.stringify(profile, null, 2));
check('4b profile zeroed', profile.json?.data?.totalEvents === 0 && profile.json?.data?.entityFeedbackCount === 0,
  `totalEvents=${profile.json?.data?.totalEvents} entityFeedbackCount=${profile.json?.data?.entityFeedbackCount}`);
const mixedAfter = await call('GET', '/api/sonic/recommend/for-you?feed=mixed&count=12');
fs.writeFileSync(path.join(OUT_DIR, 'h4c_mixed_after_delete.json'), JSON.stringify(mixedAfter, null, 2));
check('4c personalized falls back after delete', mixedAfter.json?.data?.personalized === false,
  `personalized=${mixedAfter.json?.data?.personalized} distribution=${JSON.stringify(mixedAfterAfterJson(mixedAfter))}`);

function mixedAfterAfterJson(m) {
  return m.json?.data?.distribution;
}

// 5. Latency sample (engine-internal latencyMs from meta)
const lat = [];
for (let i = 0; i < 20; i++) {
  const r = await call('GET', '/api/sonic/recommend/for-you?feed=mixed&count=12');
  lat.push(r.json?.meta?.latencyMs ?? -1);
}
lat.sort((a, b) => a - b);
const p95 = lat[Math.floor(lat.length * 0.95)];
check('5 mixed HTTP latency (20 runs)', lat.every((v) => v >= 0) && p95 < 50, `p95=${p95}ms avg=${(lat.reduce((s, v) => s + v, 0) / lat.length).toFixed(1)}ms (incl. localhost HTTP overhead)`);

console.log(failures === 0 ? '\nALL HTTP SELF-TESTS PASS' : `\n${failures} HTTP SELF-TEST(S) FAILED`);
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ BASE, ANON, failures, latencyP95Ms: p95 }, null, 2));
process.exitCode = failures === 0 ? 0 : 1;

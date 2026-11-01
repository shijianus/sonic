// 故事线剧本: anon_gray_story_001 — 模拟真实用户 3 分钟行为序列（逻辑顺序，不真 sleep）
// Steps: 1.cold mixed 2.收藏专辑 3.听完专辑曲目 4.看完MV 5.mixed 6.skip 7.dislike 8.mixed 9.DELETE 10.mixed
const BASE = 'http://127.0.0.1:3000';
const KEY = 'test_super_secret_engine_key_999_32chars!';
const ANON = 'anon_gray_story_001';
const H = { 'X-Sonic-Engine-Key': KEY, 'X-Sonic-Anon-Id': ANON, 'Content-Type': 'application/json' };

const log = (...a) => console.log(...a);
const mixed = async (tag) => {
  const r = await fetch(`${BASE}/api/sonic/recommend/for-you?feed=mixed&count=12`, { headers: H });
  const j = await r.json();
  const t = j.data?.tracks || [];
  log(`[${tag}] HTTP ${r.status} personalized=${j.data?.personalized} items=${t.length} types=[${t.map((x) => x.type || 'track').join(',')}]`);
  log(`   seq: ${t.map((x, i) => `${i + 1}.${x.title}@${x.artist}`).join(' | ')}`);
  return { status: r.status, j, t };
};
const post = async (tag, body) => {
  const r = await fetch(`${BASE}/api/sonic/events`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  log(`[${tag}] HTTP ${r.status} ${JSON.stringify(j.data || j.error)}`);
  return { status: r.status, j };
};

// 目录真实曲目: 乐与怒(海阔天空 347230) / 命运派对(光辉岁月 346576) / 秘密警察(喜欢你 347355) — 均为 Beyond
// 注意: 种子曲库每张专辑仅 1 首, 「专辑内 1~2 首」以 同艺术家相邻专辑曲目 补足
const HKT = { id: '347230', platform: 'netease', title: '海阔天空', artist: 'Beyond', album: '乐与怒', duration: 326 };
const GORY = { id: '346576', platform: 'netease', title: '光辉岁月', artist: 'Beyond', album: '命运派对', duration: 299 };

log('===== STORY: anon_gray_story_001 =====');
// 1. 打开推荐 (cold mixed)
const s1 = await mixed('S1 cold mixed');

// 2. 收藏一张专辑 (乐与怒): 实体语义事件 + 曲目级 favorite（当前 API 仅认曲目级）
await post('S2a favorite(entityType=album)', { events: [{ type: 'favorite', entityType: 'album', entityId: 'alb_leyunou_beyond', album: '乐与怒', track: HKT }] });
await post('S2b favorite(track 海阔天空)', { events: [{ type: 'favorite', track: HKT }] });

// 3. 完整听该专辑内 1~2 首歌
await post('S3 play_complete x2', { events: [
  { type: 'play_complete', playedSeconds: 326, durationSeconds: 326, progressRatio: 1.0, track: HKT },
  { type: 'play_complete', playedSeconds: 299, durationSeconds: 299, progressRatio: 1.0, track: GORY },
] });

// 4. 再看完 1 支 MV (海阔天空 MV): watch_complete 当前为非法类型 → 400; fallback: 关联曲目 play_progress 0.7
await post('S4a watch_complete(mv)', { events: [{ type: 'watch_complete', progress: 1.0, entityType: 'mv', entityId: 'mv_347230', track: HKT }] });
await post('S4b fallback play_progress 0.7', { events: [{ type: 'play_progress', playedSeconds: 228, durationSeconds: 326, progressRatio: 0.7, track: HKT }] });

// 5. 再次打开雷达 mixed
const s5 = await mixed('S5 mixed after fav+play+mv-fallback');

// 6. 跳过 1 首不喜欢的歌 (从 S5 实际列表中选非 Beyond 的第 3 首, 早期 skip)
const skipPick = (s5.t.filter((x) => x.artist !== 'Beyond')[2]) || s5.t[3];
await post(`S6 skip(early) ${skipPick?.title}@${skipPick?.artist}`, { events: [{ type: 'skip', playedSeconds: 12, durationSeconds: skipPick?.duration, progressRatio: 0.04, reason: 'user_skip', track: { id: skipPick?.id, platform: skipPick?.platform, title: skipPick?.title, artist: skipPick?.artist, album: skipPick?.album } }] });

// 7. dislike 另一首 (S5 列表第 1 首非 Beyond 曲目)
const dl = (s5.t.filter((x) => x.artist !== 'Beyond')[0]) || s5.t[0];
await post(`S7 dislike ${dl?.title}@${dl?.artist}`, { events: [{ type: 'dislike', track: { id: dl?.id, platform: dl?.platform, title: dl?.title, artist: dl?.artist, album: dl?.album } }] });

// 8. 再次打开 mixed
const s8 = await mixed('S8 mixed after skip+dislike');
log(`   [核对] dislike 目标「${dl?.title}」在列表中: ${s8.t.some((x) => x.id === dl?.id)} | Beyond 相关曲目数: ${s8.t.filter((x) => x.artist === 'Beyond').length}`);

// 9. DELETE 清空
const dr = await fetch(`${BASE}/api/sonic/events`, { method: 'DELETE', headers: H });
const dj = await dr.json();
log(`[S9 DELETE] HTTP ${dr.status} ${JSON.stringify(dj.data)}`);

// 10. 最后一次打开 mixed
const s10 = await mixed('S10 mixed after clear');
log(`   [核对] personalized=${s10.j.data?.personalized} (期望回落 false) | Beyond 置顶是否消失: ${s10.t[0]?.artist !== 'Beyond'}`);
const pr = await fetch(`${BASE}/api/sonic/events`, { headers: H });
const pj = await (await pr.json(), pr).json?.() ?? (await pr.json());
log(`[S10b profile] ${JSON.stringify(pj?.data || {})}`);

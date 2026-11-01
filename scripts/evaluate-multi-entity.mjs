// Multi-Entity Recommendation Offline Evaluation
// Usage: npm run eval:multi-entity
//
// Verifies the full multi-entity pipeline without HTTP:
//   1. SQLite (or memory fallback when node:sqlite is unavailable) catalog seeding
//   2. Entity event ingestion (album favorite, mv watch_complete, playlist open)
//   3. feed=mixed recall with non-track types + bidirectional propagation
//   4. Legacy tracks contract untouched (no feed param)
//   5. DELETE cascade clears user_entity_feedback
//   6. Engine-internal latency P95 against the 25ms target
// Exits non-zero on any failure so it can gate CI.

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRecommendStore } from '../server/recommend-sqlite.ts';
import {
  MemoryRecommendStore,
  ensureCatalogSeeded,
  ensureMultiEntityCatalog,
  ingestBehaviorEvents,
  clearUserRecommendationData,
  getRecommendationsForYou,
  getMultiEntityRecommendations,
  computeMvEntityId,
} from '../functions/_lib/sonic/recommend/index.ts';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name} — ${detail}`);
}

let usingSqlite = true;
try {
  // node:sqlite is unflagged on Node >= 23.4; flagged on Node 22 (engines floor is 22.13)
  await import('node:sqlite');
} catch {
  console.warn('[warn] node:sqlite unavailable; falling back to MemoryRecommendStore');
  usingSqlite = false;
}

const ANON = {
  mode: 'anonymous-opt-in',
  subjectKey: 'anon_evalmultientity01',
  personalizationEnabled: true,
  isAuthenticated: false,
};

function createStore() {
  if (usingSqlite) {
    const dbPath = path.join(os.tmpdir(), `sonic-eval-multi-entity-${Date.now()}.sqlite`);
    return { store: new SqliteRecommendStore(dbPath), dbPath };
  }
  return { store: new MemoryRecommendStore(), dbPath: ':memory:' };
}

const { store, dbPath } = createStore();
// All engine calls must target THIS store explicitly; getRecommendStore(env) reads env.RECOMMEND_STORE.
const env = { RECOMMEND_STORE: store };
try {
  // ── 1. Catalog seeding ──
  ensureCatalogSeeded(store);
  const entityCreated = ensureMultiEntityCatalog(store);
  const counts = store.countEntities();
  record(
    'catalog-seed',
    counts.album > 0 && counts.mv > 0 && counts.relations > 0,
    `albums=${counts.album} playlists=${counts.playlist} mvs=${counts.mv} relations=${counts.relations} (derived ${entityCreated}, storage=${store.kind}, db=${dbPath})`,
  );

  // ── 2. Entity event ingestion ──
  const track晴天 = store.findTrackByTitleArtist('晴天', '周杰伦') || store.listTracks(50).find((t) => t.title === '晴天');
  const track海阔天空 = store.listTracks(50).find((t) => t.title === '海阔天空');
  const ingest = await ingestBehaviorEvents(
    [
      {
        type: 'favorite',
        entityType: 'album',
        entityId: 'alb_yehuimei_jay',
        track: { id: 186016, title: track晴天.title, artist: track晴天.canonicalArtist, album: '叶惠美', duration: 269, platform: 'netease' },
      },
      { type: 'play_complete', track: { id: 186016, title: track晴天.title, artist: track晴天.canonicalArtist, album: '叶惠美', duration: 269, platform: 'netease' } },
      { type: 'watch_complete', entityType: 'mv', entityId: computeMvEntityId(track海阔天空.canonicalTrackId), progressRatio: 1.0 },
      { type: 'open', entityType: 'playlist', entityId: 'pl_mandopop_eval', entityTitle: '华语流行精选' },
    ],
    ANON,
    env,
  );
  record(
    'entity-events',
    ingest.accepted === 4 && ingest.entityFeedbackAccepted === 3,
    `accepted=${ingest.accepted} entityFeedbackAccepted=${ingest.entityFeedbackAccepted} (album favorite + play_complete + mv watch_complete + playlist open)`,
  );
  const fbCount = store.getUserEntityFeedback(ANON.subjectKey).length;
  record('entity-feedback-rows', fbCount === 3, `user_entity_feedback rows=${fbCount}`);

  // ── 3. Mixed feed ──
  const mixed = getMultiEntityRecommendations(ANON, { count: 12 }, env);
  const nonTrack = mixed.items.filter((i) => i.type !== 'track');
  const distTotal = mixed.distribution.track + mixed.distribution.album + mixed.distribution.playlist + mixed.distribution.mv;
  record(
    'mixed-non-track',
    mixed.items.length === 12 && nonTrack.length > 0 && distTotal === 12,
    `items=${mixed.items.length} nonTrack=${nonTrack.length} distribution=${JSON.stringify(mixed.distribution)} personalized=${mixed.personalized}`,
  );
  record(
    'mixed-contract-fields',
    mixed.items.every((i) => i.type && i.id && i.title && Number.isFinite(i.score) && i.reason && i.reasonCode),
    `sample=${JSON.stringify({ type: mixed.items[0].type, id: mixed.items[0].id, title: mixed.items[0].title, score: mixed.items[0].score, reason: mixed.items[0].reason })}`,
  );
  const propagated = mixed.items.filter(
    (i) => i.type === 'track' && i.signals.some((s) => s.type === 'entity_propagation'),
  );
  record(
    'entity-propagation',
    propagated.length > 0,
    `${propagated.length} track item(s) carry entity_propagation signals (e.g. "${propagated[0]?.reason || 'none'}")`,
  );
  const maxConsecutive = (() => {
    let max = 1;
    let run = 1;
    for (let i = 1; i < mixed.items.length; i++) {
      run = mixed.items[i].type === mixed.items[i - 1].type ? run + 1 : 1;
      max = Math.max(max, run);
    }
    return max;
  })();
  record('type-interleave', maxConsecutive <= 2, `max consecutive same-type run=${maxConsecutive}`);

  // ── 4. Legacy contract untouched ──
  const legacy = await getRecommendationsForYou(ANON, { count: 6 }, env);
  record(
    'legacy-contract',
    Array.isArray(legacy.tracks) && legacy.tracks.length === 6 && legacy.feed === undefined && legacy.items === undefined,
    `keys=${Object.keys(legacy).join(',')} tracks=${legacy.tracks.length} top1=${legacy.tracks[0]?.title}`,
  );

  // ── 5. DELETE cascade ──
  const cleared = clearUserRecommendationData(ANON, env);
  const mixedAfterClear = getMultiEntityRecommendations(ANON, { count: 12 }, env);
  record(
    'delete-cascade',
    cleared.removedEntityFeedback === 3 && store.getUserEntityFeedback(ANON.subjectKey).length === 0 && !mixedAfterClear.personalized,
    `removedEvents=${cleared.removedEvents} removedEntityFeedback=${cleared.removedEntityFeedback} personalizedAfter=${mixedAfterClear.personalized}`,
  );

  // Re-ingest for latency measurement (personalized path)
  await ingestBehaviorEvents(
    [
      {
        type: 'favorite',
        entityType: 'album',
        entityId: 'alb_yehuimei_jay',
        track: { id: 186016, title: track晴天.title, artist: track晴天.canonicalArtist, album: '叶惠美', duration: 269, platform: 'netease' },
      },
      { type: 'watch_complete', entityType: 'mv', entityId: computeMvEntityId(track海阔天空.canonicalTrackId), progressRatio: 1.0 },
    ],
    ANON,
    env,
  );

  // ── 6. Engine-internal latency ──
  const measure = (fn, runs) => {
    fn(); // warmup
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
    return { avg, p95: samples[Math.floor(samples.length * 0.95)], max: samples[samples.length - 1] };
  };
  const mixedLat = measure(() => getMultiEntityRecommendations(ANON, { count: 12 }, env), 40);
  const legacyLat = measure(() => getRecommendationsForYou(ANON, { count: 6 }, env), 40);
  record(
    'latency-target',
    mixedLat.p95 < 25 && legacyLat.p95 < 25,
    `mixed(count=12) avg=${mixedLat.avg.toFixed(2)}ms p95=${mixedLat.p95.toFixed(2)}ms max=${mixedLat.max.toFixed(2)}ms | legacy(count=6) p95=${legacyLat.p95.toFixed(2)}ms | target P95<25ms engine-internal`,
  );

  // ── Summary ──
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== Multi-Entity Evaluation Summary ===');
  console.log(`storage=${store.kind} db=${dbPath}`);
  console.log(`passed=${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
    process.exitCode = 1;
  } else {
    console.log('ALL PASS');
  }
} finally {
  try {
    store.close?.();
  } catch {}
  try {
    if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  } catch {}
}

/**
 * Sonic 智能推荐系统 —— 多实体 (Track / Album / Playlist / MV) 混合 Feed 离线评估基准
 *
 * 评估目标：
 *   1. 对照有无用户反馈时的关联实体传播分
 *   2. 评估混合 Feed 的实体分布、重复项与相关性
 *   3. 评估多样性（歌手多样性 ILD 与实体类型香农熵）
 *   4. 测量内存 SQLite 的打分与重排延迟 (p50 / p95)
 */
import { performance } from 'node:perf_hooks';
import { SqliteRecommendStore } from '../server/recommend-sqlite.ts';
import {
  ensureMultiEntityCatalogSeeded,
  ingestBehaviorEvents,
  getMultiEntityRecommendationsForYou,
  buildMultiEntityPreferenceProfile,
  computeAlbumEntityId,
  computeMvEntityId,
} from '../functions/_lib/sonic/recommend/index.ts';

const FEED_COUNT = 18;
const FEED_TYPES = ['track', 'album', 'playlist', 'mv'];
const LATENCY_RUNS_PER_PERSONA = 15;

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1);
  return sortedArr[idx];
}

function computeShannonEntropy(counts) {
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const c of Object.values(counts)) {
    if (c > 0) {
      const p = c / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

function computeIntraListDiversity(items) {
  if (items.length < 2) return 0;
  let pairCount = 0;
  let distSum = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const typeDiff = a.type !== b.type ? 1 : 0;
      const artistA = a.payload?.artist || a.subtitle || '';
      const artistB = b.payload?.artist || b.subtitle || '';
      const artistDiff = artistA !== artistB ? 1 : 0;
      distSum += 0.45 * typeDiff + 0.55 * artistDiff;
      pairCount++;
    }
  }
  return pairCount > 0 ? distSum / pairCount : 0;
}

function benchmarkIdentity(name) {
  return {
    mode: 'authenticated',
    subjectKey: `usr:eval_${name}`,
    personalizationEnabled: true,
    isAuthenticated: true,
  };
}

function readLatencyBudget(args) {
  if (args.length === 0) return null;
  const limit = Number(args[1]);
  if (args.length !== 2 || args[0] !== '--max-p95-ms' || !Number.isFinite(limit) || limit <= 0) {
    throw new Error('Usage: npm run eval:multi-entity -- [--max-p95-ms <positive number>]');
  }
  return limit;
}

async function measurePropagation(store, env, track, albumId, mvId, unrelatedTrackId) {
  const playlistId = 'pl_chinese_rnb_classics';
  const relatedTrack = { type: 'track', id: track.canonicalTrackId };
  const scenarios = [
    { name: 'albumToTrack', event: { entityType: 'album', entityId: albumId, type: 'favorite' }, targets: [relatedTrack] },
    { name: 'playlistToTrack', event: { entityType: 'playlist', entityId: playlistId, type: 'favorite' }, targets: [relatedTrack] },
    { name: 'mvToTrack', event: { entityType: 'mv', entityId: mvId, type: 'watch_complete' }, targets: [relatedTrack] },
    { name: 'trackToEntities', event: { type: 'play_complete', track: { canonicalTrackId: track.canonicalTrackId } }, targets: [
      { type: 'album', id: albumId }, { type: 'playlist', id: playlistId }, { type: 'mv', id: mvId },
    ] },
  ];

  const results = [];
  for (const { name, event, targets } of scenarios) {
    const identity = benchmarkIdentity(`propagation_${name}`);
    const timestamp = Date.now();
    const baseline = buildMultiEntityPreferenceProfile(identity, store, env, timestamp);
    const ingestion = await ingestBehaviorEvents([{ ...event, timestamp }], identity, env);
    const measured = buildMultiEntityPreferenceProfile(identity, store, env, timestamp);
    const scoreFor = (profile, id) => profile.propagatedEntityScores.get(id) ?? 0;
    const comparisons = targets.map(({ type, id }) => ({
      type, baselineScore: scoreFor(baseline, id), scoreWithFeedback: scoreFor(measured, id),
    }));
    const unrelatedScore = scoreFor(measured, unrelatedTrackId);
    results.push({
      name,
      acceptedEvents: ingestion.accepted,
      comparisons,
      unrelatedScore,
      passed: ingestion.accepted === 1 && unrelatedScore === 0 && comparisons.every(
        ({ baselineScore, scoreWithFeedback }) => baselineScore === 0 && scoreWithFeedback > baselineScore
      ),
    });
  }
  return results;
}

async function runEvaluation() {
  const latencyBudgetMs = readLatencyBudget(process.argv.slice(2));

  const store = new SqliteRecommendStore(':memory:');
  ensureMultiEntityCatalogSeeded(store);
  const env = { RECOMMEND_STORE: store, SONIC_RECOMMEND_OFFLINE: '1' };

  // The ordinary seed catalog does not claim verified videos. Add synthetic video
  // references to this private in-memory fixture only, without querying a provider.
  const mvFixtures = [['186016', 'eval-qingtian'], ['347230', 'eval-haikuotiankong']];
  for (const [trackId, fixtureId] of mvFixtures) {
    const track = store.getTrack(`netease:${trackId}`);
    if (!track) throw new Error(`Missing MV fixture track: ${trackId}`);
    store.upsertTrack({ ...track, mvSourceIds: { synthetic: fixtureId } });
  }
  const track = store.getTrack('netease:186016');
  const unrelatedTrack = store.getTrack('netease:347230');
  const albumId = computeAlbumEntityId(track.cleanAlbum, track.canonicalArtist);
  const mvId = computeMvEntityId('synthetic', 'eval-qingtian');
  const propagation = await measurePropagation(store, env, track, albumId, mvId, unrelatedTrack.canonicalTrackId);

  const allTracks = store.listTracks(1000);
  const allAlbums = store.listEntities('album', 500);
  const allPlaylists = store.listEntities('playlist', 500);
  const allMvs = store.listEntities('mv', 500);

  // 4 类典型多实体交叉交互画像
  const personas = [
    {
      id: 'jay_multi',
      name: '周杰伦专辑与 MV 重度用户',
      events: [
        { entity_type: 'album', entity_id: albumId, action: 'favorite' },
        { entity_type: 'mv', entity_id: mvId, action: 'watch_complete' },
      ],
      isRelevant: (item) =>
        (item.subtitle || '').includes('周杰伦') ||
        (item.title || '').includes('晴天') ||
        (item.payload?.artist || '') === '周杰伦',
    },
    {
      id: 'cantopop_multi',
      name: '港乐经典与粤语专辑爱好者',
      events: [
        { entity_type: 'playlist', entity_id: 'pl_cantopop_golden_age', action: 'favorite' },
        { entity_type: 'track', entity_id: '65766', action: 'replay', track: { title: '富士山下', artist: '陈奕迅' } },
      ],
      isRelevant: (item) =>
        ['Beyond', '陈奕迅', '张学友', '张国荣'].some((ar) => (item.subtitle || '').includes(ar) || (item.payload?.artist || '') === ar),
    },
    {
      id: 'rnb_soul_multi',
      name: 'R&B / Soul 主题歌单常听听众',
      events: [
        { entity_type: 'playlist', entity_id: 'pl_chinese_rnb_classics', action: 'open' },
        { entity_type: 'track', entity_id: '150432', action: 'play_complete', track: { title: '普通朋友', artist: '陶喆' } },
      ],
      isRelevant: (item) =>
        ['陶喆', '周杰伦', '方大同', '林俊杰'].some((ar) => (item.subtitle || '').includes(ar) || (item.payload?.artist || '') === ar),
    },
    {
      id: 'cold_start',
      name: '冷启动新用户 (零历史，靠热度与探索)',
      events: [],
      isRelevant: null,
    },
  ];

  const latencies = [];
  const typeCounts = { track: 0, album: 0, playlist: 0, mv: 0 };
  let totalRecommendations = 0;
  let relevantHits = 0;
  let totalHoldoutTrials = 0;
  const ildList = [];
  const personaResults = [];

  for (const p of personas) {
    const identity = benchmarkIdentity(p.id);
    const ingestion = await ingestBehaviorEvents(p.events, identity, env);
    const options = { count: FEED_COUNT, temperature: 0 };
    const feed = await getMultiEntityRecommendationsForYou(identity, options, env);
    const distribution = feed.meta.distribution;
    const perTypeCounts = Object.fromEntries(FEED_TYPES.map((type) => [type, 0]));
    const uniqueItems = new Set();
    let personaHits = 0;
    for (const item of feed.data) {
      perTypeCounts[item.type]++;
      typeCounts[item.type]++;
      totalRecommendations++;
      uniqueItems.add(`${item.type}:${item.id}`);
      if (p.isRelevant) {
        if (p.isRelevant(item)) personaHits++;
        totalHoldoutTrials++;
      }
    }
    relevantHits += personaHits;
    personaResults.push({
      id: p.id,
      acceptedEvents: ingestion.accepted,
      distribution: perTypeCounts,
      relevantItemCount: p.isRelevant ? personaHits : null,
      personalized: feed.meta.personalized,
      passed: ingestion.accepted === p.events.length && feed.meta.personalized === (p.events.length > 0) &&
        feed.data.length === FEED_COUNT &&
        uniqueItems.size === FEED_COUNT && perTypeCounts.track > 0 && perTypeCounts.mv > 0 &&
        perTypeCounts.album + perTypeCounts.playlist > 0 &&
        FEED_TYPES.every((type) => distribution?.[type] === perTypeCounts[type]),
    });
    ildList.push(computeIntraListDiversity(feed.data));

    for (let run = 0; run < LATENCY_RUNS_PER_PERSONA; run++) {
      const t0 = performance.now();
      await getMultiEntityRecommendationsForYou(identity, options, env);
      latencies.push(performance.now() - t0);
    }
  }

  const typeProbes = [];
  for (const type of FEED_TYPES) {
    const result = await getMultiEntityRecommendationsForYou(
      benchmarkIdentity('type_probe'), { count: 1, temperature: 0, allowedTypes: [type] }, env
    );
    typeProbes.push({ type, passed: result.data.length === 1 && result.data[0].type === type });
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const avgIld = ildList.reduce((s, v) => s + v, 0) / ildList.length;

  const typeEntropy = computeShannonEntropy(typeCounts);
  const trackRatio = Number((typeCounts.track / totalRecommendations).toFixed(4));
  const albumPlaylistRatio = Number(((typeCounts.album + typeCounts.playlist) / totalRecommendations).toFixed(4));
  const mvRatio = Number((typeCounts.mv / totalRecommendations).toFixed(4));
  const hitRate = Number((relevantHits / totalHoldoutTrials).toFixed(4));

  const checks = {
    propagationWithFeedback: propagation.every((scenario) => scenario.passed),
    mixedFeedDistributionMatchesReturnedItems: personaResults.every((persona) => persona.passed),
    explicitlyRequestedTypesAreAvailable: typeProbes.every((probe) => probe.passed),
    ...(latencyBudgetMs === null ? {} : { latencyWithinBudget: p95 <= latencyBudgetMs }),
  };
  const report = {
    schemaVersion: 2,
    benchmarkName: 'Sonic Multi-Entity Mixed Feed Benchmark (Reproducible)',
    checks,
    personaResults,
    typeProbes,
    catalogStats: {
      canonicalTracks: allTracks.length,
      albums: allAlbums.length,
      playlists: allPlaylists.length,
      mvs: allMvs.length,
      totalCatalogEntities: allTracks.length + allAlbums.length + allPlaylists.length + allMvs.length,
    },
    mixedFeedDistribution: {
      trackRatio,
      albumPlaylistRatio,
      mvRatio,
      typeShannonEntropy: Number(typeEntropy.toFixed(4)),
    },
    relevanceAndDiversity: {
      relevantItemRatioAt18: hitRate,
      intraListDiversity_ILD: Number(avgIld.toFixed(4)),
      propagationValid: checks.propagationWithFeedback,
      propagation,
    },
    performanceMetrics: {
      p50_latency_ms: Number(p50.toFixed(2)),
      p95_latency_ms: Number(p95.toFixed(2)),
      sampleCount: latencies.length,
      p95LatencyBudgetMs: latencyBudgetMs,
      processRssMemory_MB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    },
  };

  console.log(JSON.stringify(report, null, 2));
  store.close();
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
}

runEvaluation().catch((err) => {
  console.error(err);
  process.exit(1);
});

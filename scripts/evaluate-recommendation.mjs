/**
 * Sonic 智能音乐推荐与混合搜索引擎离线基准
 *
 * 数据集诚实声明：
 *   本脚本基于种子曲库、6 类合成用户画像的训练和留出集切分，以及 20 组搜索用例，
 *   输出 Precision@10, Recall@10, NDCG@10, Catalog Coverage, Intra-List Diversity (ILD),
 *   Novelty, 搜索 Top-1/Top-5 命中率、零结果兜底率以及 p50/p95 延迟与内存占用。
 */
import { performance } from 'node:perf_hooks'
import { SqliteRecommendStore } from '../server/recommend-sqlite.ts'
import {
  ensureCatalogSeeded,
  ingestBehaviorEvents,
  getRecommendationsForYou,
  executeSmartSearch,
  isPlayableTrack,
} from '../functions/_lib/sonic/recommend/index.ts'

const K = 10

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0
  const idx = Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1)
  return sortedArr[idx]
}

function computeDcg(relevances) {
  let sum = 0
  for (let i = 0; i < relevances.length; i++) {
    sum += relevances[i] / Math.log2(i + 2)
  }
  return sum
}

function jaccardDistance(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0
  let inter = 0
  for (const x of setA) {
    if (setB.has(x)) inter++
  }
  const union = setA.size + setB.size - inter
  return union > 0 ? 1 - inter / union : 0
}

function computeIntraListDiversity(tracks) {
  if (tracks.length < 2) return 0
  let pairCount = 0
  let distSum = 0
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i]
      const b = tracks[j]
      const artistDiff = a.artist !== b.artist ? 1 : 0
      const genresA = new Set([...(a.genres || []), a.language || ''])
      const genresB = new Set([...(b.genres || []), b.language || ''])
      const genreDist = jaccardDistance(genresA, genresB)
      distSum += 0.55 * artistDiff + 0.45 * genreDist
      pairCount++
    }
  }
  return pairCount > 0 ? distSum / pairCount : 0
}

async function runEvaluation() {
  const store = new SqliteRecommendStore(':memory:')
  ensureCatalogSeeded(store)
  const env = { RECOMMEND_STORE: store, SONIC_RECOMMEND_OFFLINE: '1' }

  const allTracks = store.listTracks(500)
  const eligibleTracks = allTracks.filter((track) => isPlayableTrack(track) && !['demo', 'cover'].includes(track.edition))
  const eligibleIds = new Set(eligibleTracks.map((track) => track.canonicalTrackId))

  // 定义 6 类典型音乐品味画像：训练集交互 + 留出验证集目标风格/歌手判据
  const personas = [
    {
      id: 'anon:eval_jay_rnb',
      name: '华语 R&B 与周杰伦/林俊杰深度听众',
      trainEvents: [
        { type: 'favorite', track: { id: '186016', title: '晴天', artist: '周杰伦', duration: 269 } },
        { type: 'play_complete', track: { id: '185811', title: '七里香', artist: '周杰伦', duration: 299 } },
        { type: 'favorite', track: { id: '108914', title: '江南', artist: '林俊杰', duration: 267 } },
        { type: 'search_click', query: '华语 R&B', track: { id: '150432', title: '普通朋友', artist: '陶喆', duration: 255 } },
      ],
      isRelevantHoldout: (t) =>
        ['周杰伦', '林俊杰', '陶喆', '王力宏', '方大同'].includes(t.artist) ||
        (t.genres || []).includes('r&b'),
    },
    {
      id: 'anon:eval_cantopop',
      name: '粤语经典与港乐爱好者',
      trainEvents: [
        { type: 'favorite', track: { id: '65766', title: '富士山下', artist: '陈奕迅', duration: 259 } },
        { type: 'play_complete', track: { id: '347230', title: '海阔天空', artist: 'Beyond', duration: 326 } },
        { type: 'search_click', query: '粤语金曲', track: { id: '188432', title: '吻别', artist: '张学友', duration: 303 } },
      ],
      isRelevantHoldout: (t) =>
        t.language === 'yue' ||
        (t.genres || []).includes('cantopop') ||
        ['陈奕迅', 'Beyond', '张学友', '王菲', '谢安琪'].includes(t.artist),
    },
    {
      id: 'anon:eval_rock_indie',
      name: '华语摇滚与独立民谣听众',
      trainEvents: [
        { type: 'favorite', track: { id: '385929', title: '倔强', artist: '五月天', duration: 262 } },
        { type: 'play_complete', track: { id: '28815250', title: '平凡之路', artist: '朴树', duration: 301 } },
        { type: 'replay', track: { id: '407679921', title: '大风吹', artist: '草东没有派对', duration: 235 } },
      ],
      isRelevantHoldout: (t) =>
        (t.genres || []).some((g) => ['rock', 'folk', 'indie'].includes(g)) ||
        ['万能青年旅店', '朴树', '新裤子', '五月天', '赵雷', '宋冬野', '草东没有派对'].includes(t.artist),
    },
    {
      id: 'anon:eval_western_pop',
      name: '欧美流行与合成器电子听众',
      trainEvents: [
        { type: 'favorite', track: { id: '1382576173', title: 'Lover', artist: 'Taylor Swift', duration: 221 } },
        { type: 'play_complete', track: { id: '1403318151', title: 'Blinding Lights', artist: 'The Weeknd', duration: 200 } },
        { type: 'search_click', query: 'Coldplay', track: { id: '400162138', title: 'Something Just Like This', artist: 'Coldplay', duration: 247 } },
      ],
      isRelevantHoldout: (t) =>
        t.language === 'en' ||
        (t.genres || []).some((g) => ['pop', 'electronic'].includes(g)),
    },
    {
      id: 'anon:eval_jpop_anime',
      name: '日音 J-Pop 与二次元原声听众',
      trainEvents: [
        { type: 'favorite', track: { id: '536622304', title: 'Lemon', artist: '米津玄師', duration: 255 } },
        { type: 'play_complete', track: { id: '1409311773', title: '夜に駆ける', artist: 'YOASOBI', duration: 261 } },
      ],
      isRelevantHoldout: (t) =>
        t.language === 'ja' || (t.genres || []).includes('j-pop'),
    },
    {
      id: 'anon:eval_ballad_female',
      name: '华语抒情女声与都市慢歌听众',
      trainEvents: [
        { type: 'favorite', track: { id: '25642126', title: '泡沫', artist: '邓紫棋', duration: 258 } },
        { type: 'play_complete', track: { id: '287035', title: '遇见', artist: '孙燕姿', duration: 210 } },
        { type: 'favorite', track: { id: '299992', title: '红豆', artist: '王菲', duration: 256 } },
      ],
      isRelevantHoldout: (t) =>
        ['邓紫棋', '孙燕姿', '王菲', '蔡依林', '张惠妹', '莫文蔚', '梁静茹'].includes(t.artist) ||
        (t.genres || []).includes('ballad'),
    },
  ]

  const recLatencies = []
  const recommendedTrackUnion = new Set()
  let precisionSum = 0
  let recallSum = 0
  let ndcgSum = 0
  let ildSum = 0
  let noveltySum = 0
  const personaResults = []

  for (const p of personas) {
    const identity = {
      mode: 'anonymous-opt-in',
      subjectKey: p.id,
      personalizationEnabled: true,
    }
    const now = Date.now()
    const trainEvents = p.trainEvents.map((event, index) => ({
      ...event,
      eventId: `eval-${p.id}-${index}`,
      timestamp: now - (p.trainEvents.length - index) * 10_000,
    }))
    const ingestion = await ingestBehaviorEvents(trainEvents, identity, env)
    const trainIds = new Set(store.getUserEvents(p.id, p.trainEvents.length).map((event) => event.canonicalTrackId))
    const relevantIds = new Set(eligibleTracks
      .filter((track) => !trainIds.has(track.canonicalTrackId) && p.isRelevantHoldout(track))
      .map((track) => track.canonicalTrackId))

    const t0 = performance.now()
    const rec = await getRecommendationsForYou(
      identity,
      { count: K, excludeIds: Array.from(trainIds).filter(Boolean), temperature: 0 },
      env
    )
    recLatencies.push(performance.now() - t0)

    const topK = rec.tracks.slice(0, K)
    const seenIds = new Set()
    const relVector = topK.map(({ canonicalTrackId }) => {
      const hit = !seenIds.has(canonicalTrackId) && relevantIds.has(canonicalTrackId)
      seenIds.add(canonicalTrackId)
      if (eligibleIds.has(canonicalTrackId)) recommendedTrackUnion.add(canonicalTrackId)
      return Number(hit)
    })
    const hits = relVector.reduce((a, b) => a + b, 0)
    const precision = hits / K
    const recall = relevantIds.size ? hits / relevantIds.size : 0
    const dcg = computeDcg(relVector)
    const idealRel = Array.from({ length: K }, (_, i) =>
      i < Math.min(K, relevantIds.size) ? 1 : 0
    )
    const idcg = computeDcg(idealRel)
    const ndcg = idcg > 0 ? dcg / idcg : 0

    // The external chart score is already normalized to [0, 1].
    const avgNovelty =
      topK.reduce((acc, item) => {
        const popProb = Math.max(0.05, Math.min(0.99, item.popularity?.externalChartScore ?? 0.5))
        return acc + -Math.log2(popProb)
      }, 0) / Math.max(1, topK.length)

    precisionSum += precision
    recallSum += recall
    ndcgSum += ndcg
    ildSum += computeIntraListDiversity(topK)
    noveltySum += avgNovelty
    personaResults.push({
      id: p.id,
      name: p.name,
      relevantHoldoutCount: relevantIds.size,
      hitsAtK: hits,
      passed: ingestion.accepted === trainEvents.length && trainIds.size === trainEvents.length &&
        !trainIds.has(undefined) && relevantIds.size > 0 && seenIds.size === K &&
        [...seenIds].every((id) => eligibleIds.has(id) && !trainIds.has(id)),
    })
  }

  // 搜索基准评测 (20 个覆盖简繁/拼音/首字母/别名/拼写容错/精准保护与零结果兜底的查询)
  const searchBenchmarkQueries = [
    { q: '晴天', expectArtist: '周杰伦', expectTitle: '晴天' },
    { q: '七里香 周杰伦', expectArtist: '周杰伦', expectTitle: '七里香' },
    { q: '陳奕迅 富士山下', expectArtist: '陈奕迅', expectTitle: '富士山下' },
    { q: '鄧紫棋 泡沫', expectArtist: '邓紫棋', expectTitle: '泡沫' },
    { q: 'qingtian', expectArtist: '周杰伦', expectTitle: '晴天' },
    { q: 'fushishanxia', expectArtist: '陈奕迅', expectTitle: '富士山下' },
    { q: 'haikuotiankong', expectArtist: 'Beyond', expectTitle: '海阔天空' },
    { q: 'zjl', expectArtist: '周杰伦' },
    { q: 'cyx', expectArtist: '陈奕迅' },
    { q: 'jay chou', expectArtist: '周杰伦' },
    { q: 'g.e.m.', expectArtist: '邓紫棋' },
    { q: 'eason chan', expectArtist: '陈奕迅' },
    { q: 'coldpaly', expectArtist: 'Coldplay' },
    { q: 'tayler swift', expectArtist: 'Taylor Swift' },
    { q: '江南', expectArtist: '林俊杰', expectTitle: '江南' },
    { q: '海阔天空', expectArtist: 'Beyond', expectTitle: '海阔天空' },
    { q: '平凡之路', expectArtist: '朴树', expectTitle: '平凡之路' },
    { q: 'Lemon', expectArtist: '米津玄师', expectTitle: 'Lemon' },
    { q: '华语 R&B', expectGenre: 'r&b' },
    { q: 'nonexistent_gibberish_query_99999', expectFallback: true },
  ]

  const searchLatencies = []
  let top1Hits = 0
  let top5Hits = 0
  let nonEmptyAfterFallback = 0
  const metadataStreamTypes = { full: 0, trial: 0, unavailable: 0, unknown: 0 }
  let expectedMatchQueries = 0
  let expectedFallbackQueries = 0
  let successfulFallbackQueries = 0

  const publicIdentity = { mode: 'public', subjectKey: null, personalizationEnabled: false }

  for (const item of searchBenchmarkQueries) {
    const t0 = performance.now()
    const res = await executeSmartSearch(
      item.q,
      { skipLiveUpstream: true, count: 10 },
      publicIdentity,
      env
    )
    searchLatencies.push(performance.now() - t0)

    const tracks = res.data.tracks
    const effectiveList = tracks.length > 0 ? tracks : res.data.fallbackTracks || []
    if (effectiveList.length > 0) nonEmptyAfterFallback++

    for (const t of effectiveList) {
      const type = t.streamType
      if (type === 'full' || type === 'trial' || type === 'unavailable') metadataStreamTypes[type]++
      else metadataStreamTypes.unknown++
    }

    if (item.expectFallback) {
      expectedFallbackQueries++
      if (tracks.length === 0 && res.data.fallbackUsed && res.data.fallbackTracks?.length > 0) successfulFallbackQueries++
      continue
    }
    expectedMatchQueries++

    const matchFn = (t) => {
      if (item.expectTitle && t.title !== item.expectTitle) return false
      if (item.expectArtist && t.artist !== item.expectArtist) return false
      if (item.expectGenre && !(t.genres || []).includes(item.expectGenre)) return false
      return true
    }

    if (tracks[0] && matchFn(tracks[0])) top1Hits++
    if (tracks.slice(0, 5).some(matchFn)) top5Hits++
  }

  recLatencies.sort((a, b) => a - b)
  searchLatencies.sort((a, b) => a - b)
  const memMb = process.memoryUsage().rss / (1024 * 1024)

  const nP = personas.length
  const nQ = searchBenchmarkQueries.length
  const totalReturnedTracks = Object.values(metadataStreamTypes).reduce((sum, count) => sum + count, 0)
  const checks = {
    holdoutExcludesTrainingAndHasUniqueCatalogItems: personaResults.every((persona) => persona.passed),
    everyPersonaFindsAtLeastOneRelevantHoldoutItem: personaResults.every((persona) => persona.hitsAtK > 0),
    knownQueriesMatchWithinTopFive: top5Hits === expectedMatchQueries,
    unknownQueriesReceiveFallback: successfulFallbackQueries === expectedFallbackQueries,
  }
  const report = {
    schemaVersion: 2,
    datasetType: 'Synthetic Multi-Persona Holdout & Query Benchmark (Offline Reproducible)',
    catalogSize: allTracks.length,
    eligibleCatalogSize: eligibleIds.size,
    checks,
    personaResults,
    recommendationMetrics: {
      [`Precision@${K}`]: Number((precisionSum / nP).toFixed(4)),
      [`Recall@${K}`]: Number((recallSum / nP).toFixed(4)),
      [`NDCG@${K}`]: Number((ndcgSum / nP).toFixed(4)),
      CatalogCoverage: Number((recommendedTrackUnion.size / Math.max(1, eligibleIds.size)).toFixed(4)),
      IntraListDiversity_ILD: Number((ildSum / nP).toFixed(4)),
      Novelty_Bits: Number((noveltySum / nP).toFixed(4)),
    },
    searchMetrics: {
      Top1_HitRate: Number((top1Hits / expectedMatchQueries).toFixed(4)),
      Top5_HitRate: Number((top5Hits / expectedMatchQueries).toFixed(4)),
      ExpectedFallbackSuccessRate: Number((successfulFallbackQueries / expectedFallbackQueries).toFixed(4)),
      ZeroResultRate_AfterFallback: Number((1 - nonEmptyAfterFallback / nQ).toFixed(4)),
      MetadataDeclaredAvailableTrackRatio: Number(((metadataStreamTypes.full + metadataStreamTypes.trial) / Math.max(1, totalReturnedTracks)).toFixed(4)),
      metadataStreamTypes,
      livePlaybackVerified: false,
    },
    performanceMetrics: {
      recommendLatency_p50_ms: Number(percentile(recLatencies, 50).toFixed(2)),
      recommendLatency_p95_ms: Number(percentile(recLatencies, 95).toFixed(2)),
      searchLatency_p50_ms: Number(percentile(searchLatencies, 50).toFixed(2)),
      searchLatency_p95_ms: Number(percentile(searchLatencies, 95).toFixed(2)),
      processRssMemory_MB: Number(memMb.toFixed(1)),
    },
  }

  console.log(JSON.stringify(report, null, 2))
  store.close()
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1
}

runEvaluation().catch((err) => {
  console.error('Evaluation failed:', err)
  process.exit(1)
})

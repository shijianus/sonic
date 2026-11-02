# 多实体推荐实现状态（Implementation Status）

- 日期：2026-11-01
- 分支：`rc/sonic-20261031`
- 性质：从零实现（本分支此前**无任何**多实体代码，灰测报告
  [`docs/gray-test-multi-entity-windows.md`](gray-test-multi-entity-windows.md) 的 P0 结论为真，
  本文档记录其 P0 的落地与逐条自证）。

## 1. 文件清单

| 文件 | 变更 | 内容 |
| :-- | :-- | :-- |
| `functions/_lib/sonic/recommend/types.ts` | 改 | `SonicEntityType`、`EntityRecord`、`EntityRelation`、`StoredEntityFeedback`、`EntityAffinityStat`、`MixedFeedOptions/Result/Item`、`MixedDistribution`；事件类型 +`watch_complete/watch_progress/open`；`SonicBehaviorEventInput` +`entityType/entityId/entityTitle`；`StoredBehaviorEvent` +`entityType/entityId`；`RecommendStore` +11 个实体接口方法 |
| `server/recommend-sqlite.ts` | 改 | `entities` / `entity_relations` / `user_entity_feedback` 三表 DDL + 索引；`behavior_events` 增列迁移（幂等）；实体/关系/反馈/亲和聚合/清空/计数的 SQLite 实现 |
| `functions/_lib/sonic/recommend/memory-store.ts` | 改 | 同构内存实现（Edge / 测试）；`clearAll` 覆盖实体状态 |
| `functions/_lib/sonic/recommend/entity-store.ts` | 新 | 实体 ID 派生、事件实体三级解析（exact-id → 自然键 → 新建）、`ensureMultiEntityCatalog`（album/playlist/mv 目录种子 + 双向关系）、传播系数配置（4 个 `SONIC_ENTITY_PROP_*` 环境变量） |
| `functions/_lib/sonic/recommend/multi-entity.ts` | 新 | `getMultiEntityRecommendations`（实体召回 + 曲目召回 + 实体→曲目传播 + `diversifyMixedList` 类型配额/邻接约束/不3连） |
| `functions/_lib/sonic/recommend/engine.ts` | 改 | `computeEventCredibilityWeight` +watch/watch_progress/open；`ingestBehaviorEvents` 写实体反馈并审计实体字段；`clearUserRecommendationData` 级联清空 `user_entity_feedback` |
| `functions/_lib/sonic/recommend/index.ts` | 改 | 导出 `entity-store` / `multi-entity` |
| `functions/api/sonic/events.ts` | 改 | 白名单 +3 类型；实体字段强校验（整批 4xx + 逐事件定位）；响应 +`entityFeedbackAccepted` / `removedEntityFeedback`；GET 画像 +`entityFeedbackCount` / `topEntities` |
| `functions/api/sonic/recommend/for-you.ts` | 改 | `feed=mixed` 分支（`types` 过滤、`unrecognizedParams` 回显）；无 feed 分支零改动 |
| `tests/multi-entity-recommendation.test.ts` | 新 | 17 项真实断言（schema/迁移/关系/反馈/校验/mixed/传播/兼容/清空/延迟） |
| `scripts/evaluate-multi-entity.mjs` + `package.json` | 新 | `npm run eval:multi-entity`；`test:recommend` 挂载新测试文件 |
| `scripts/selftest-multi-entity-http.mjs` | 新 | 12 项 HTTP 自证脚本 |
| `API.md` / `docs/recommend-multi-entity.md` / 本文件 | 改/新 | 文档与代码一致 |

## 2. 自证（真实执行输出，非推断）

### 2.1 源码检索

```
$ grep -rn "user_entity_feedback" --include="*.ts" server functions tests | wc -l → 12 处
$ grep -rln "watch_complete" --include="*.ts" functions tests → events.ts / engine.ts / types.ts / multi-entity.ts / 测试
$ grep -n "feedRaw === 'mixed'" functions/api/sonic/recommend/for-you.ts → :79
# 构建产物 dist-server/index.mjs（881KB）：
# user_entity_feedback×10  entity_relations×12  watch_complete×3  mixed×12  entityType×91
```

### 2.2 SQLite 三表（自证库 `data/sonic-recommend-multientity-selftest.sqlite`，已清理）

```
sqlite_master tables → behavior_events, canonical_tracks, entities,
                       entity_relations, platform_track_links, search_queries,
                       track_cooccurrence, tracks_fts*, user_entity_feedback
entities 计数：album=58, mv=60, playlist=8
entity_relations：480 条（album contains track / track belongs_to album / mv derives_from track / playlist contains track）
叶惠美 album 实体唯一（alb_5bc1b0aa687f2ffe）→ 事件自然键命中目录实体
```

### 2.3 真实 HTTP（`node scripts/selftest-multi-entity-http.mjs`，引擎 `PORT=3210` 隔离库冷启动）

```
[PASS] 1a album favorite accepted — status=200 accepted=1 entityFeedbackAccepted=1
[PASS] 1b mv watch_complete accepted — status=200 accepted=1 entityFeedbackAccepted=1
[PASS] 1c invalid entityType -> 4xx — status=400 code=INVALID_ENTITY_TYPE
[PASS] 2 mixed non-track present — items=12 distribution={"track":7,"album":2,"playlist":1,"mv":2} nonTrackTypes=album,mv,playlist
[PASS] 2b item contract — all items carry type/id/title/score/reason/reasonCode
[PASS] 2c favored album ranked with affinity reason — reason="你收藏的专辑《叶惠美》" score=0.667
[PASS] 3 legacy tracks contract intact — keys=mode,personalized,privacyMode,storageKind,tracks,profileSummary tracks=6
[PASS] 3b non-mixed feed value falls back to legacy — feed=top → data.tracks，无 feed/items 字段
[PASS] 4a delete clears all — removedEvents=2 removedEntityFeedback=2
[PASS] 4b profile zeroed — totalEvents=0 entityFeedbackCount=0
[PASS] 4c personalized falls back after delete — personalized=false
[PASS] 5 mixed HTTP latency (20 runs) — p95=21ms avg=16.4ms（含 localhost HTTP 开销）
→ ALL HTTP SELF-TESTS PASS（原始响应取证：graytest/multi-entity-impl/*.json）
```

mixed 列表实际内容（收藏专辑 + 完看 MV 后，节选）：

```
track    trk_fc4da46cda4ecc1e  0.983  收录于MV《七里香 MV》      ← mv→track 传播
album    alb_5bc1b0aa687f2ffe  0.667  你收藏的专辑《叶惠美》      ← 实体直接亲和置顶
mv       mv_a981ce9e27b89372   0.450  包含你常听的《晴天》        ← track→mv 传播
playlist pl_ce45dab92c9913db   0.425  包含你常听的《晴天》
mv       mv_953e40147a67288d   0.417  你看完的MV《海阔天空 MV》   ← watch_complete 实体
```

### 2.4 测试与评估

```
$ npm run test:recommend   → 42/42 passed（原 25 项零回归 + 多实体 17 项）
$ npm run eval:multi-entity → 10/10 ALL PASS
  catalog-seed   albums=57 playlists=8 mvs=58 relations=474 (storage=sqlite)
  mixed(count=12) avg=5.55ms p95=8.65ms max=10.06ms | legacy(count=6) p95=3.78ms
  目标：引擎内部 P95 < 25ms → 满足
```

## 3. API 示例

```bash
# 实体事件（专辑收藏，内嵌真实曲目元数据以命中目录实体）
curl -X POST "$BASE/api/sonic/events" \
  -H "X-Sonic-Engine-Key: $KEY" -H "X-Sonic-Anon-Id: anon_demo0001" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"favorite","entityType":"album","entityId":"alb_yehuimei_jay",
       "track":{"id":186016,"title":"晴天","artist":"周杰伦","album":"叶惠美","duration":269,"platform":"netease"}}]}'
# → 200 {"data":{"accepted":1,"entityFeedbackAccepted":1,"storageKind":"sqlite"}}

# MV 完看
curl -X POST "$BASE/api/sonic/events" ... \
  -d '{"events":[{"type":"watch_complete","entityType":"mv","entityId":"mv_347230",
       "entityTitle":"海阔天空 MV","progressRatio":1.0,
       "track":{"id":347230,"title":"海阔天空","artist":"Beyond","album":"乐与怒","duration":326,"platform":"netease"}}]}'

# 非法实体字段 → 整批 400（不静默丢弃）
curl -X POST ... -d '{"events":[{"type":"favorite","entityType":"artist","entityId":"art_x"}]}'
# → 400 {"error":{"code":"INVALID_ENTITY_TYPE","message":"entityType must be one of track|album|playlist|mv, got: artist"}}

# 多实体混合 feed
curl "$BASE/api/sonic/recommend/for-you?feed=mixed&count=12" -H ...
# → data.items[]（type/id/title/score/reason/…）+ data.distribution

# 旧契约（严格不变）
curl "$BASE/api/sonic/recommend/for-you?count=6" -H ...
# → data.tracks（mode/personalized/privacyMode/storageKind/tracks/profileSummary，无 feed/items 字段）

# 一键清空（级联实体反馈）
curl -X DELETE "$BASE/api/sonic/events" -H ...
# → 200 {"data":{"cleared":true,"removedEvents":2,"removedEntityFeedback":2}}
```

## 4. 遗留问题

**P0**：无（本文件 P0 已落地；灰测 G2/G3 判据在相同场景下可复验通过——见 2.3）。

**P1**
1. 种子曲库每专辑仅 1 曲（灰测 P1.4 沿未变）：专辑→曲目传播的「同专辑多曲」空间有限，
   灰度前建议扩充目录；实体目录在曲库扩充后自动重建。
2. 客户端乱码/非 UTF-8 输入会按替换字符创建 derived 实体并长期保留于 `entities`
   （自证期间曾用 curl 命令行发送 GBK 字节复现）。建议：网关层校验 UTF-8 或定期清理
   零反馈 derived 实体。
3. 事件自造实体 id 与目录派生 id 不合并（如 `mv_347230` 与 `mv_<trackId>` 并存），
   两者均经关系图传播到同一曲目，但实体行独立；灰度后可做实体 id 联邦。
4. Linux VPS 灰度环境需复测 HTTP P95（Windows 本机 mixed count=12 端到端 p95=21ms，
   引擎内部 8.65ms，均在目标内）。

**P2**
5. `feed=mixed` 暂不接入 Gorse 协同与在线扩目录（换取稳定 P95；track-only 契约不受影响）。
6. mixed 分支 `types` 之外的未知查询参数经 `meta.unrecognizedParams` 回显，旧分支不回显（兼容优先）。

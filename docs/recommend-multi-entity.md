# 多实体推荐设计与实现（Track / Album / Playlist / MV）

> 状态：已实现并可通过灰测自证（实现状态与取证见 [`docs/multi-entity-implementation-status.md`](docs/multi-entity-implementation-status.md)）
> 分支：`rc/sonic-20261031`；本文件描述与代码一致的当前实现，不描述未落地的规划。

## 1. 目标与范围

在既有 Track 单实体推荐引擎之上增加实体层，使 `GET /api/sonic/recommend/for-you?feed=mixed`
返回 track / album / playlist / mv 混合列表，且：

- 事件层正式支持实体语义（`entityType` + `entityId`），非法实体字段明确 4xx，绝不静默丢弃；
- 双向软传播：album/playlist/mv ↔ track 的亲和相互增强，系数可配置；
- 类型打散：混合列表带类型配额与 MMR 式约束，避免全 track；
- 向后兼容：不带 `feed` 参数时旧版 `data.tracks` 契约逐字节不变；
- 隐私：`DELETE /api/sonic/events` 级联清空 `behavior_events` 与 `user_entity_feedback`；
- 轻量：零新增 npm 依赖，SQLite（node:sqlite）+ 内存双实现。

## 2. 数据模型（SQLite）

新增三表（`server/recommend-sqlite.ts` 启动时 `CREATE TABLE IF NOT EXISTS`，旧库自动迁移）：

| 表 | 主键 | 关键列 | 用途 |
| :-- | :-- | :-- | :-- |
| `entities` | `(entity_type, entity_id)` | `title, subtitle, artist_key, genres_json, language, cover_url, external_popularity, derived, meta_json` | 实体目录。`derived=1` 表示由本地曲目目录聚合生成（无上游实体 API） |
| `entity_relations` | `(from_type, from_id, to_type, to_id, relation)` | `relation ∈ contains / belongs_to / derives_from / references`，`weight ∈ [0,1]` | 双向软传播图 |
| `user_entity_feedback` | `feedback_id` | `subject_key, entity_type, entity_id, action, weight, progress_ratio, related_track_id, created_at` | 实体级行为反馈（与 `behavior_events` 分表，DELETE 级联清空） |

`behavior_events` 追加两列 `entity_type` / `entity_id`（`ALTER TABLE ADD COLUMN`，幂等迁移），
用于审计事件中的实体引用，保证「无静默丢弃」可被事后取证。

内存实现（`MemoryRecommendStore`，Cloudflare Edge / 测试用）提供同构接口。

## 3. 实体 ID 与目录种子（ensureMultiEntityCatalog）

- 实体 ID 确定性派生（`entity-store.ts`）：
  - 专辑：`alb_<hash16(normalize(album) + ':::' + normalize(artist))>`
  - MV：`mv_<hash16(canonicalTrackId)>`
  - 歌单：`pl_<hash16('genre:' + normalize(genre))>`
- 种子来源（无外部请求，基于现有 58 首种子曲库聚合）：
  - **album**：按 `(cleanAlbum, canonicalArtist)` 分组，全部 57 组；
  - **mv**：每首可播放曲目派生一部《〈曲名〉 MV》，`derives_from` 关联原曲；
  - **playlist**：按风格聚合（≥4 首才生成，上限 8 张 / 每张 20 首），如「粤语金曲馆」。
- 事件带来的未知实体（客户端自造 id 如 `alb_yehuimei_jay`）按
  **精确 id → 自然键（entityTitle 或内嵌 track 的 album/title 派生）→ 新建 derived 实体**
  三级解析；只要请求内嵌了真实曲目元数据，就会命中目录实体（灰测场景 G2 实测命中）。
- 幂等：每个 store 实例只推导一次（WeakSet），重复调用零开销；实体行按主键 upsert。

## 4. 事件契约（POST /api/sonic/events）

- 新增行为类型：`watch_complete`（权重 2.5）、`watch_progress`（按进度分档）、`open`（0.8）。
- 实体事件 = 行为类型 × `entityType ∈ {track, album, playlist, mv}` + 非空 `entityId`（≤128 字符）。
- 校验失败**整批 400**，错误码：`INVALID_ENTITY_TYPE`（类型非法 / 只有 id 没有类型）、
  `INVALID_ENTITY_ID`（有类型无 id 或超长）——响应 meta 附带逐事件定位。
- 写入路径（`engine.ts ingestBehaviorEvents`）：
  1. `resolveEventEntity` 解析/创建实体并补齐与内嵌曲目的双向关系；
  2. `behavior_events` 记录统一行为日志（含实体字段）；
  3. `user_entity_feedback` 记录实体反馈（2 秒窗口幂等去重，与事件去重一致）；
  4. 曲目共现图 / 画像 / Gorse 同步等原有链路不受影响。
- 响应新增 `entityFeedbackAccepted`（计入实体反馈写入数）。

## 5. 召回与重排（feed=mixed）

`multi-entity.ts getMultiEntityRecommendations`（纯本地、无网络、确定性，无 Math.random）：

1. **实体召回**
   - 直接亲和：`user_entity_feedback` 90 天窗口聚合，正权按 `min(1, w/6)` 饱和 × 14 天半衰期
     时间衰减，负权惩罚（仅负反馈的实体直接剔除）；
   - 曲目 → 实体传播：最近常听/收藏曲目沿 `track → album/playlist/mv` 关系传播，
     系数 `SONIC_ENTITY_PROP_TRACK_TO_ENTITY`（默认 0.5）；
   - 热度兜底：`externalPopularity` 加权的热门实体，保证冷启动与非个性化场景列表饱满。
2. **曲目召回**（在原 for-you 亲和公式基础上）
   - 实体 → 曲目传播：有亲和的专辑/歌单/MV 沿 `contains/derives_from` 关系给曲目加成
     （系数 `SONIC_ENTITY_PROP_ALBUM_TO_TRACK=0.6` / `..._PLAYLIST_TO_TRACK=0.45` /
     `..._MV_TO_TRACK=0.7`，单曲加成上限 0.4），解释信号 `entity_propagation`
     （如「收录于专辑《叶惠美》」）；
   - 其余沿用歌手/风格亲和、热度、新鲜度、上下文与歌手惩罚。
3. **类型打散（diversifyMixedList）**
   - 类型配额：track 55% / album 20% / mv 15% / playlist 10%（最大余数法精确分配，
     可用 `types` 参数过滤后重分配）；
   - 同类型内歌手去重上限、跨类型邻接约束（曲目不与其所属专辑/派生 MV 相邻）；
   - 输出排序保证「同类型不 3 连」（仅当其他类型耗尽时允许）。
4. **响应契约**
   ```jsonc
   {
     "feed": "mixed",
     "mode": "for-you",
     "personalized": true,
     "storageKind": "sqlite",
     "items": [{
       "type": "album", "id": "alb_5bc1b0aa687f2ffe", "title": "叶惠美",
       "subtitle": "周杰伦", "score": 0.667,
       "reason": "你收藏的专辑《叶惠美》", "reasonCode": "entity_affinity",
       "entityId": "alb_5bc1b0aa687f2ffe", "trackIds": ["trk_…"],
       "meta": { "derived": true, "trackCount": 1 }
     }, {
       "type": "track", "id": "trk_…", "title": "七里香", "score": 0.983,
       "reason": "收录于MV《七里香 MV》", "reasonCode": "entity_propagation",
       "track": { /* 完整可播放 RecommendedTrack */ }
     }],
     "distribution": { "track": 7, "album": 2, "playlist": 1, "mv": 2 },
     "profileSummary": { "hasHistory": true, "topArtists": [...], "topGenres": [...],
                         "topEntities": [{ "type": "album", "id": "…", "title": "叶惠美", "weight": 4 }] }
   }
   ```

## 6. 兼容与隐私

- **旧契约严格保持**：`for-you` 不带 `feed` 或 `feed` 取其他值 → 原有 `data.tracks` 分支，
  代码路径零改动；`feed=top` 等未知值回落旧契约（HTTP 自证 3b）。
- `types` 参数仅在 `feed=mixed` 下生效；未知查询参数在 mixed 分支通过
  `meta.unrecognizedParams` 回显（旧分支不加字段）。
- `DELETE /api/sonic/events` 同时清空 `behavior_events` 与 `user_entity_feedback`，
  响应新增 `removedEntityFeedback`；`GET /api/sonic/events` 画像新增
  `entityFeedbackCount` 与 `topEntities`（均为增量字段）。
- 实体目录（`entities`/`entity_relations`）是共享目录数据，不随单个用户的 DELETE 清除。

## 7. 可配置传播系数

环境变量（缺省即上表默认值，均为 [0,1]）：

| 变量 | 默认 | 语义 |
| :-- | :-- | :-- |
| `SONIC_ENTITY_PROP_ALBUM_TO_TRACK` | 0.6 | 专辑亲和 → 其内曲目 |
| `SONIC_ENTITY_PROP_PLAYLIST_TO_TRACK` | 0.45 | 歌单亲和 → 其内曲目 |
| `SONIC_ENTITY_PROP_MV_TO_TRACK` | 0.7 | MV 亲和 → 源曲目 |
| `SONIC_ENTITY_PROP_TRACK_TO_ENTITY` | 0.5 | 曲目行为 → 所属专辑/歌单/MV |

## 8. 测试与评估

- `npm run test:recommend`：`tests/recommendation-and-search.test.ts`（25 项，零回归）+
  `tests/multi-entity-recommendation.test.ts`（17 项：三表 schema、旧库迁移列、实体 upsert/关系双向、
  反馈去重/聚合/清空、目录种子幂等、自然键命中、watch_complete 200、非法实体 4xx、
  mixed 非 track 类型、传播信号、类型打散、旧契约保持、DELETE 级联、延迟护栏）。
- `npm run eval:multi-entity`：`scripts/evaluate-multi-entity.mjs` 离线全链路 10 项断言
  （SQLite 真库），输出引擎内部延迟（目标 P95 < 25ms）。
- HTTP 自证：`scripts/selftest-multi-entity-http.mjs`（12 项断言），
  取证落盘 `graytest/multi-entity-impl/`。

## 9. 已知限制

1. 种子曲库每张专辑仅 1 首曲目（灰测报告 P1.4 未变）：专辑→曲目传播在出厂目录上
   表现为「同专辑多曲」的空间有限；实体的曲目聚合能力已在测试中以注入曲目验证。
2. 事件自造实体 id 与目录派生 id 可能并存（如客户端 MV id ≠ `mv_<trackId>`）：
   两者都会经关系图传播到同一首曲目，但实体行不合并（实体 id 联邦 / 合并策略为后续项）。
3. 混合 feed 暂不接入 Gorse 协同与在线扩目录（保持 P95 < 25ms 引擎内部延迟），无网络依赖。
4. 每张专辑 1 首的出厂目录下，album 实体与单曲 MV 语义高度重叠（`meta.sourceTrackId`），
   灰度前建议扩充目录（同曲库扩充时实体目录自动重建，无需迁移）。

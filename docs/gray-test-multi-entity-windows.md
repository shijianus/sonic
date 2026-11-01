# 灰测报告：多实体推荐（Track / Album / Playlist / MV）Windows 本地端到端验证

- 日期：2026-11-01
- 执行环境：Windows 10.0.26200 x64 / Git Bash / Node v24.14.0 / npm 11.9.0 / pnpm 10.34.5 / curl.exe 8.17.0
- 仓库：shijianus/sonic，分支 `rc/sonic-20261031`（工作区 clean，HEAD `c272305`）
- 结论先行：**多实体推荐（feed=mixed、Album/Playlist/MV 实体、实体反馈表）在本仓库不存在，灰测目标场景 G2/G3/故事线的多实体判定全部 FAIL，不可进入多实体灰度。** 现有 Track 单实体推荐引擎本身健康（G1 基线、G4 负反馈、G5 隐私清空、G6 兼容、G7 隔离、故事线 Track 链路均 PASS），若仅就 Track 推荐可进入小流量灰度。

---

## 1. 环境与启动

### 1.1 环境探测
- 端口 3000 启动前无本地监听（netstat 仅一条到远端 103.212.12.47:3000 的出站连接）。
- 依赖已安装（node_modules 存在），`dist-server/index.mjs` 已存在并于本次重新构建。

### 1.2 构建与启动命令（实际使用）
```bash
npm run build:engine        # esbuild → dist-server/index.mjs (825KB)
cp data/sonic-recommend.sqlite data/sonic-recommend-graytest.sqlite   # 隔离测试库，不动原始库
PORT=3000 \
SONIC_ENGINE_SECRET="test_super_secret_engine_key_999_32chars!" \
SONIC_SECRET="test_super_secret_user_key_999_32chars!" \
SONIC_RECOMMEND_DB_PATH="D:/Users/Smart Kevin/OneDrive/Desktop/sonic/data/sonic-recommend-graytest.sqlite" \
node --experimental-sqlite dist-server/index.mjs
```
- 引擎默认 host 127.0.0.1、默认端口 8080（`PORT` 覆盖为 3000）。
- 鉴权：引擎上所有 `/api/*` 强制要求 `X-Sonic-Engine-Key`（≥32 字符，缺失/错误 → 503/401 fail-closed，实测确认）。
- 匿名身份：`X-Sonic-Anon-Id: anon_[a-zA-Z0-9_-]{8,64}`（正则校验），映射为 `anon_<sha256 前 24 hex>` 的 subjectKey。

### 1.3 健康检查
- `GET /api/sonic/engine/health` → 200 `{"ok":true,"runtime":"linux-engine",...}`
- `GET /api/sonic/recommend/for-you?count=3`（带双头）→ 200，`personalized:false`，旧 tracks 契约，`storageKind:sqlite`
- 无 key / 错 key → 401 `ENGINE_UNAUTHORIZED`（取证：日志 2×401）

---

## 2. 前置核实：多实体功能是否存在（关键发现）

任务背景声称"上一阶段已实现并验收多实体"，以下五项独立核实**全部为否**：

| 核实项 | 命令/位置 | 结果 |
|---|---|---|
| 源码实体表 | `grep -r user_entity_feedback .`（全仓库，排除 node_modules/.git） | 0 处 |
| 全部分支 tip | `git grep user_entity_feedback` 于 origin/main、work/agy-*、work/zcode-*、feat/smart-reco、release/rc 等 9 个分支 | 0 处 |
| 提交历史 | `git log --all --grep entity/multi-entity` | 0 条 |
| 构建产物 | `grep -o "entityType\|watch_complete\|'mixed'" dist-server/index.mjs` | 无 `entityType`、无 `watch_complete`、无 `mixed`（仅 Gorse `feedbackType`×3） |
| SQLite Schema | `data/sonic-recommend-graytest.sqlite` sqlite_master | 仅 `canonical_tracks / platform_track_links / tracks_fts / behavior_events / track_cooccurrence / search_queries`，**无 entities / entity_relations / user_entity_feedback** |

- 事件白名单（`functions/api/sonic/events.ts:22`）：仅 search/search_click/play_start/play_progress/play_complete/skip/replay/favorite/unfavorite/dislike/undislike。**无 watch_complete，无任何实体语义字段**（`SonicBehaviorEventInput` 只有 `track`）。
- `for-you` 处理器（`functions/api/sonic/recommend/for-you.ts`）仅透传 query 给引擎；引擎端 `getRecommendationsForYou` 无 `feed` 参数，未知参数被静默忽略。
- 任务书提到的 `npm run eval:multi-entity` 脚本在 package.json 中**不存在**（存在 `eval:recommend`，已运行作为基线）。
- 目录数据：种子曲库 58 首（`canonical_tracks` 58 行，netease 真实 id），**曲目含 album 字符串元数据但无专辑/播放列表/MV 实体**；每张专辑仅 1 首曲目。

因此：G2/G3/故事线的多实体判据按"功能缺失 FAIL"如实记录，不做数据不足开脱（目录里并非缺 MV 数据，而是根本没有实体层）。

---

## 3. 场景结果矩阵

统一请求头：`X-Sonic-Engine-Key: <测试密钥>` + `X-Sonic-Anon-Id: <场景 anon id>`；Base URL `http://127.0.0.1:3000`。原始响应存于 `graytest/`（g1a_body.json … story.mjs 输出）。

### G1 冷启动基线 — anon_gray_cold_001 — **PASS（基线）/ FAIL（mixed 多实体）**
| 步骤 | 请求 | 结果 |
|---|---|---|
| G1-a | GET `/for-you?feed=mixed&count=12` | 200，25.7ms；`personalized:false`（冷启动 ✓）；12/12 全部 `type=track`；响应无 `distribution` 字段；`feed=mixed` 被静默忽略，`data.mode` 仍为 `for-you` |
| G1-b | GET `/for-you?count=6` | 200；tracks 旧契约保持（data keys: mode,personalized,privacyMode,storageKind,tracks,profileSummary） |

判定：冷启动与旧契约 PASS；「mixed 返回多种 type」FAIL —— 功能不存在。

### G2 专辑偏好（核心）— anon_gray_album_001 — **FAIL（多实体核心）/ Track 亲和生效**
| 步骤 | 请求 | 结果 |
|---|---|---|
| step0 基线 | GET mixed ×12 | 200，全 track；周杰伦《夜曲》列 #2 |
| step1 | POST events：`{type:"favorite", entityType:"album", entityId:"alb_yehuimei_jay", album:"叶惠美", track:{晴天 186016}}` | 200 `accepted:1` —— **entityType/entityId 被静默丢弃**（StoredBehaviorEvent 无实体字段；画像 topArtists 仅来自内嵌 track） |
| step2 | POST events：favorite + play_complete ×3（晴天/七里香/夜曲） | 200 `accepted:4` |
| 画像 | GET /events | `totalEvents:5, likedCount:1, topArtists:["周杰伦"], topGenres:["mandopop","r&b",...]` |
| step3 | GET mixed ×12 | 200，`personalized:true`；**类型序列仍 100% track，无 type=album**；周杰伦相关升到 #1（告白气球）/ #6 / #8，mandopop/R&B 亲和面扩张 |
| step4 | GET `/for-you?count=6` 旧契约 | 200，tracks 结构不变；周杰伦《简单爱》#1（允许的弱相关抬升 ✓） |

判定：核心判据「列表出现 type=album / meta.distribution 非 100% track / 收藏专辑实体靠前」全部不满足 —— 实体层缺失。Track/Artist 级亲和与排序变化真实生效。

### G3 MV 偏好（核心）— anon_gray_mv_001 — **FAIL（多实体核心）/ Fallback 生效**
| 步骤 | 请求 | 结果 |
|---|---|---|
| step1 基线 | GET mixed ×12 | 200，全 track；Beyond《海阔天空》#9 |
| step2 | POST `{type:"watch_complete", progress:1.0, entityType:"mv", entityId:"mv_347230", ...}` | **400 INVALID_EVENT_TYPE**（安全 4xx，无 5xx）——MV 事件类型不存在 |
| step3 | POST fallback：play_progress(0.65) 海阔天空 + play_complete 光辉岁月 | 200 `accepted:2` |
| step4 | GET mixed ×12 | 200，`personalized:true`；**无 type=mv**；Beyond《喜欢你》升至 #1，cantopop 亲和（张学友/张国荣/陈奕迅）上升 |

判定：核心判据「出现 type=mv / 类型交织」FAIL。曲级 fallback 亲和生效。目录中确无 mv 实体可引用（非数据不足，是实体层缺失）。

### G4 负反馈 dislike — anon_gray_dislike_001 — **PASS**
- 基线 12 首中含 Blinding Lights(#1)。POST dislike ×2（Blinding Lights 1403318151 + 海阔天空 347230）→ 200 accepted:2。
- 复查 mixed 与旧契约：**两首均消失**（`BlindingLights in list: false | 海阔天空 in list: false`），列表仍满 12 首（未整页误杀）；同艺术家 Beyond 其余曲目亦被过滤（艺术家级惩罚偏强但页面完好）；画像 `dislikedCount:2`。
- 判定 PASS。

### G5 隐私一键清空（核心）— anon_gray_album_001 — **PASS**
- `DELETE /api/sonic/events` → 200 `{"cleared":true,"removedEvents":5,"privacyMode":"anonymous-opt-in"}`（7ms）。
- 清空后 mixed：`personalized:false`（回落 ✓）；画像 `totalEvents:0, likedCount:0, topArtists:[]`；收藏期置顶（告白气球/简单爱）消失；列表回到热度/冷启动形态（晴天 #1 系 external_popularity=98 的目录热度，冷用户同样出现，非个性化残留）。
- 旧契约 count=6 同样回落。判定 PASS（实体反馈清空无对象可清——实体层缺失，见 P0）。

### G6 兼容与参数 — **PASS**
| 用例 | 结果 |
|---|---|
| `feed=mixed&types=track` | 200，全 track（types 参数静默忽略，无 5xx） |
| `feed=mixed&types=track,album,mv` | 200，全 track（同上；album/mv 类型无法产出） |
| POST 空 events 数组 | 400 `EMPTY_EVENTS` |
| POST 未知类型 playlist_follow | 400 `INVALID_EVENT_TYPE` |
| POST 非法 JSON | 400 `INVALID_JSON` |
| 连续 20 次 mixed | 20/20 HTTP 200 |

延迟（Windows 本机，含 localhost HTTP 开销）：
- mixed count=12：HTTP 端到端 avg 19.4~23.7ms，**P95 25.2~36.7ms**（两次采样，max 66.7ms）；引擎内部 latencyMs avg 19.6ms / P95 39ms（首跑，冷）。
- 旧契约 count=6：HTTP P95 20.3ms，**引擎内部 avg 6.8ms / P95 12ms** —— 满足 P95<25ms。
- 离线基准（`npm run eval:recommend`）：recommend P95 **13.73ms**、RSS 187MB，与文档口径（12~22ms）一致。
- 判定：兼容/健壮性 PASS；P95 处于 25ms 目标边界（mixed count=12 略超，Windows 本机含 OneDrive/Defender 噪声，P2 遗留）。

### G7 多用户隔离 — **PASS**
- 重建 A（anon_gray_album_001，4 事件周杰伦）后与 B（anon_gray_mv_001，2 事件 Beyond）交错 3 轮 mixed ×8：
  - A 每轮：`personalized=true`，周杰伦 3/8 首，top1 简单爱@周杰伦（3 轮稳定一致）；
  - B 每轮：`personalized=true`，Beyond 喜欢你 #1（3 轮稳定一致）；
- 画像对照：A `topArtists:["周杰伦"]/mandopop`，B `topArtists:["Beyond"]/cantopop` —— 头隔离（`X-Sonic-Anon-Id` → subjectKey 哈希）有效，无交叉污染。

### 故事线剧本（anon_gray_story_001，10 步）— **Track 链路 PASS / 多实体步骤 FAIL**
| 步 | 操作 | 结果 | 评价 |
|---|---|---|---|
| S1 | cold mixed | 200，personalized=false，全 track | ✓ |
| S2a | favorite(entityType=album 乐与怒) | 200 accepted:1，**实体字段被静默丢弃** | ✗ 实体无效 |
| S2b | favorite(track 海阔天空) | 200 `deduplicated:1`（2 秒窗口去重生效） | ✓ |
| S3 | play_complete ×2（海阔天空/光辉岁月） | 200 accepted:2 | ✓ |
| S4a | watch_complete(海阔天空 MV) | **400 INVALID_EVENT_TYPE** | ✗ MV 不支持 |
| S4b | fallback play_progress(0.7) | 200 accepted:1 | ✓ |
| S5 | mixed | personalized=true；喜欢你@Beyond #1（冷启动时 #12）；cantopop 亲和面上升 | ✓ 上升 |
| S6 | skip(早期, 我@张国荣, 12s) | 200 accepted:1；S8 中该曲仍在列表 #4（早期 skip 仅 -0.8 弱负，符合设计） | ✓ |
| S7 | dislike(浮夸@陈奕迅) | 200 accepted:1 | ✓ |
| S8 | mixed | **浮夸消失（硬过滤 ✓）**；喜欢你@Beyond 仍 #1 | ✓ |
| S9 | DELETE /events | 200 `cleared:true, removedEvents:6` | ✓ |
| S10 | mixed | personalized=false 回落；Beyond 置顶消失；列表回到热度形态；画像 totalEvents=0 | ✓ 回退 |

判定：10 步全部按当前 Track 引擎语义正确工作（相关上升/去重/dislike 硬过滤/清空回退均符合预期）；但 S2/S4 的实体语义（专辑收藏、MV 完看）无任何实体效果 —— 多实体目标 FAIL。

---

## 4. 基线测试与评估（Track 单实体系统）
- `npm run test:recommend`：**25/25 passed**（4.35s）。
- `npm run eval:recommend`：Precision@10 0.633 / Recall@10 0.706 / NDCG@10 0.771 / ILD 0.798；recommend P95 13.73ms；Search Top1 HitRate 1.0。

## 5. 服务端稳定性
- 全会话 135 个请求：128×200、5×400（均为故意的负向用例）、2×401（故意的鉴权用例）。**0×5xx，0 unhandled_error**。

---

## 6. 汇总表

| 场景 | 结果 | 证据摘要 |
|---|---|---|
| 启动与健康 | PASS | 200 探活；无/错 key 401；engine/health ok |
| G1 冷启动 | 基线 PASS / mixed FAIL | personalized:false ✓、旧契约 ✓；mixed 全 track、无 distribution（功能缺失） |
| G2 专辑偏好（核心） | **FAIL（多实体）** | entityType 静默丢弃、无 type=album；但周杰伦曲目 0→3+ 置顶、旧契约兼容 |
| G3 MV 偏好（核心） | **FAIL（多实体）** | watch_complete→400 INVALID_EVENT_TYPE、无 type=mv；fallback 后 Beyond #1 |
| G4 dislike | PASS | 两首被 dislike 曲目在 mixed 与旧契约均消失；页面满 12 首未误杀 |
| G5 隐私清空（核心） | PASS | cleared:true removedEvents:5；personalized 回落 false；画像归零；置顶消失 |
| G6 兼容参数 | PASS | types 静默忽略、非法输入全 4xx、20/20 200；延迟旧契约 P95 20.3ms、mixed P95 25.2~36.7ms（边界） |
| G7 隔离 | PASS | A/B 交错 3 轮画像与置顶完全隔离 |
| 故事线剧本 | Track 链路 PASS / 实体步 FAIL | 10 步全执行；dedup、dislike 硬过滤、清空回退正确；S2 实体 inert、S4a 400 |

**总通过标准核对**：G2/G3（核心多实体）FAIL —— 功能缺失，非数据不足（第 2 节五重证据）；G4/G6/G7 PASS；G5/故事线 Track 语义 PASS、实体语义 FAIL；无 5xx；旧契约未破坏；清空生效。

---

## 7. 结论

**不可进入「多实体推荐」小流量灰度。** 原因：多实体层（entities / entity_relations / user_entity_feedback、feed=mixed、watch_complete、DELETE 实体反馈清理）在本仓库当前分支及全部远端分支中不存在——任务背景「上一阶段已实现并验收」与仓库事实不符（详见第 2 节证据），且不存在 `eval:multi-entity` 评估脚本。本报告未做任何弱化断言或造数：所有 FAIL 均附可复现请求与响应。

**现有 Track 单实体引擎可以独立进入小流量灰度**：健康、鉴权 fail-closed、个性化/去重/负反馈/隐私清空/多用户隔离/向后兼容全部验证通过，延迟满足目标（旧契约 P95 20.3ms；离线基准 P95 13.7ms）。

## 8. 遗留问题

**P0（阻塞多实体灰测/灰度）**
1. 实体层整体缺失：需实现 entities / entity_relations / user_entity_feedback 三表、双向软传播（album/playlist/mv ↔ track）、`GET /for-you?feed=mixed` 多实体交织与 `meta.distribution`、`watch_complete` 等实体事件类型、`DELETE /events` 同时清实体反馈。背景资料所述实现需先落到本仓库（当前 rc/sonic-20261031 无此代码），并补 `eval:multi-entity`。

**P1**
2. `POST /events` 对携带 `entityType/entityId` 等未知字段的合法事件**静默接受并丢弃实体字段**（G2-S2a accepted:1 但无任何实体效果）——多实体实现前建议至少告警日志，实现后应校验实体 id 真实存在，防止"空跑"事件污染行为表。
3. mixed count=12 的 HTTP P95 在本机处于 25ms 目标边界（25.2~36.7ms，含 OneDrive/Defender 环境噪声）；灰度环境（Linux VPS）需复测。
4. 种子曲库 58 首中每张专辑仅 1 首曲目，专辑维度亲和（即使未来实体层落地）在此目录上无表现为"同专辑多曲"的空间，灰度前应扩充目录。

**P2**
5. `feed`/`types` 未知参数被静默忽略——按向后兼容原则可接受，但建议在 `meta.unrecognizedParams` 中回显，便于灰测发现契约漂移。
6. G4 中 dislike 某曲导致同艺术家其余曲目整体跌出 12 强（artist 惩罚偏强）——符合"整页不误杀"底线，但灰度期建议观察 artist 级惩罚系数。

## 9. 复现与取证物
- 取证目录：`graytest/`（g1a/g1b/g2s0..s4/g3s1..s4/g4s1..s3/g5s1..s4/g6a..e 原始响应 JSON；g2_events_*.json、g3_events_*.json、g4_events_dislike.json 请求体；g6_latency.mjs、story.mjs 可重复执行；summarize.mjs 摘要器）
- 服务日志：`graytest-server.log`（135 access 行，含逐请求 status/durationMs）
- 隔离测试库：`data/sonic-recommend-graytest.sqlite`（原始 `data/sonic-recommend.sqlite` 未被改动）

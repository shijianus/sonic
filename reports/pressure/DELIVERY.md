# Sonic 本地 VPS 压力测试、稳定性与功能内测交付报告 (`DELIVERY.md`)

## 1. 交付结论与发布基线

- **测试结论**: **通过本地 loopback 全项候选基线核验**（本地合成媒体、`127.0.0.1` Staging/Production 引擎、SQLite 持久化恢复、并发压力与异常降级均达到预期；生产外网/真实上游/OAuth/Durable Object/Docker/真机等外部环境项按规则明确标记为 `NOT_RUN`）。
- **固定基线 Commit (`HEAD` / `origin/main` / `origin/codex/refactor-public-beta`)**: `1c03ce4acc36d4b28f31cba83fcd25086714650a`
- **Source Digest**: `af33ace2ff5fe969f321c0f8f9939c131b937781c5b9e837ec26b40e85abec8e`
- **Pages Artifact Digest**: `4f3e1ef00f35408084538169e93bbc4462af8868ce96a7ce7d3e8a48d1016502`
- **Build Manifest (`dist/release.json`)**: `schemaVersion=1`, `baseCommit=1c03ce4acc36d4b28f31cba83fcd25086714650a`, `dirty=false`, `buildTime=2026-11-15T07:14:34.000Z`
- **验收边界**: 全程仅监听 `127.0.0.1`（Staging `:19080`、Production `:19081`），测试结束已全部停机且无遗留 `LISTEN` 端口；未使用真实私钥，报告与日志中全部密钥、签名及认证头均已脱敏且确认 **0 泄漏**。

---

## 2. 环境版本与前置构建核验

- **Runtime 工具链**: Node `v22.18.0` / npm `10.9.3` / pnpm `10.34.5`
- **清理与构建命令全部以 `exit 0` 完成**:
  1. `rm -rf node_modules player/node_modules dist dist-server` -> `exit 0`
  2. `CI=true npm ci` (`added 77 packages in 8s`) -> `exit 0`
  3. `CI=true pnpm --dir player install --frozen-lockfile` (`Packages: +705`, `Done in 3.2s`) -> `exit 0`
  4. `CI=true npm run build` (`✓ 659 modules transformed`) -> `exit 0`
  5. `npm run build:engine` -> `exit 0`
  6. `node scripts/release-inputs.mjs --verify dist/release.json` (`verification="full-source"`, `fileCount=478`, `ok=true`) -> `exit 0`
  7. `npm run verify:pages-deploy` (`compiledRelease=true`, `ok=true`) -> `exit 0`
  8. `TMPDIR=/tmp/sonic-test-tmp node --experimental-sqlite scripts/verify-built-release.mjs` (12 项 HTTP 验收全部 `ok=true`) -> `exit 0`
  9. `scripts/start-bare-metal-engine.mjs --check`（Staging `19080` & Production `19081`）-> 均 `exit 0`

---

## 3. 仓库内置压力、负载与可观测性脚本结果

| 指标 | `npm run test:pressure` (8w × 75) | `npm run test:load` (8w × 75) | `npm run test:observability` |
|---|---:|---:|---|
| 退出码 / 状态 | `0` / `ok=true` | `0` / `ok=true` | `0` / `ok=true` |
| 总请求数 | `605` | `600` | `mode=self-test` (`fullGate=false`) |
| 耗时 / 吞吐 (`req/s`) | `1373.84 ms` / `440.37 req/s` | `1458 ms` / `411.62 req/s` | stub 投递/失败/缺失/脱敏验证全通过 |
| 整体延迟 P50 / P95 / P99 / Max | `14.21` / `41.14` / *N/A* / `84.73 ms` | `18.43` / `41.74` / *N/A* / `61.07 ms` | *N/A* |
| 按类别延迟摘要 (ms) | `search` 121 (P50 11.76 / P95 25.79 / Max 38.15)；`range` 120 (6.11/21.3/42.35)；`error` 120 (7.52/17.99/44.28)；`event` 120 (20.96/42.32/58.87)；`profile` 120 (27.59/63.03/84.73)；`stream-{200,206,416,404}` 各 1 (17.67/4.75/3.58/3.19) | `search` (7.46/25.26/55.48)；`range` (6.25/27.04/57.81)；`write` (18.83/40.4/51.13)；`profile` (27.34/45.79/61.07)；`feed` (25.49/39.82/57.05) | `stubDeliveryVerified=true`, `failingDeliveryRejected=true`, `missingWebhookRejected=true`, `redactionVerified=true` |
| 取消请求数 | `16` (`cancellationChecks=16`) | 未单独统计 | — |
| 隐私隔离 (`privacy isolation`) | `true`（8 主体各 15 条事件相互隔离） | `true` | — |
| 清理后归零 (`eventStoreEmptyAfterCleanup`) | `true` | `temporarySubjectsDeleted=true` | — |
| Webhook 投递状态 | — | `webhookReceived=1`, `alertResult={sent:true, reason:"delivered", httpStatus:200, webhookStatus:204}`, `rollingRequests=618`, `rollingErrorRate5xx=0` | `stubDeliveryVerified=true` |
| `externalNetwork` | `false` | `false` | `false` |
| `releaseId` / `sourceDigest` | `1c03ce4acc36d4b28f31cba83fcd25086714650a` / `af33ace2...` | 一致 | — |

> 注：内置 `test:pressure` 与 `test:load` 脚本自身不输出 `p99Ms`（记为 *N/A*）；第 4 节并发矩阵输出了完整 `p50Ms`、`p95Ms`、`p99Ms` 与 `maxMs`。

---

## 4. VPS 并发矩阵压测报告 (`127.0.0.1:19080`)

所有阶段均同时覆盖：`nexus` 搜索、`/api/music/search`、`stream syn-440hz` (200)、`Range bytes=0-1023` (206)、非法 `Range` (416)、不存在音源 (404)、`/api/sonic/events` (`POST`/`GET`/`DELETE` 清理)、`/api/sonic/recommend/for-you` (200)。每个并发 worker 使用独立 `X-Sonic-Client-IP` (`198.51.100.1..N`) 模拟独立用户会话以在不改动原始 `.env` 限流参数前提下测量引擎吞吐极限。

| 阶段 (JSON 报告) | Workers × Req | 总请求 | 耗时 (ms) | 吞吐 (req/s) | P50 (ms) | P95 (ms) | P99 (ms) | Max (ms) | 状态码分布 | 4xx (预期) / 5xx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| [baseline.json](./baseline.json) | `1 × 100` | `100` | `301.42` | `331.76` | `1.77` | `7.69` | `8.71` | `12.06` | `200`: 63, `206`: 13, `404`: 12, `416`: 12 | `24` (0 非预期) / `0` |
| [normal.json](./normal.json) | `8 × 100` | `800` | `1569.13` | `509.84` | `14.28` | `33.90` | `47.50` | `62.56` | `200`: 504, `206`: 104, `404`: 96, `416`: 96 | `192` (0 非预期) / `0` |
| [burst.json](./burst.json) | `32 × 100` | `3200` | `5642.62` | `567.11` | `35.29` | `138.36` | `182.33` | `569.18` | `200`: 2016, `206`: 416, `404`: 384, `416`: 384 | `768` (0 非预期) / `0` |
| [high.json](./high.json) | `64 × 100` | `6400` | `10444.69` | `612.75` | `62.33` | `239.66` | `386.50` | `1699.18` | `200`: 4032, `206`: 832, `404`: 768, `416`: 768 | `1536` (0 非预期) / `0` |

- **全矩阵共 10,500 次请求**：`unexpectedStatuses = 0`、`status5xxDelta = 0`、`rateLimitRejected429Delta = 0`、`privacyIsolation = true`（分别为 1 / 8 / 32 / 64 个临时主体各自隔离）、每阶段清理后 `eventStoreEmptyAfterCleanup = true`。
- **Production fail-closed 验证 (`127.0.0.1:19081`)**：即使配置 `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1`，Production `/api/music/stream?id=syn-440hz&source=synthetic`、`/api/sonic/test-audio?id=syn-440hz`、`/api/music/search?q=Sonic&source=synthetic&count=3` 全部返回 **`403 SOURCE_DISABLED_BY_POLICY`**，完整 URL 验证见 [URLS.md](./URLS.md)（27/27 PASS）。

---

## 5. 压测期间 5 秒资源监控摘要 (`RESOURCE-SAMPLES.csv`)

来自 [RESOURCE-SAMPLES.csv](./RESOURCE-SAMPLES.csv)（共 7 个 5 秒采样点，覆盖 `idle-pre` → `burst` → `high` → `fault-and-stability` → `idle-post` 重启后）：

| 监控项 | 实测范围 / 结果 | 备注 |
|---|---|---|
| CPU 使用率 | 空闲 `0%`（区间 CPU）；`burst`~`high` 峰值区间 CPU `102.53%` ~ `108.73%`（单主线程事件循环+SQLite/libuv 线程）；故障后回落 `9.15%` | 无死循环失控 |
| RSS 内存 | 初始 `69.37 MB` (`71,032 KB`) -> `high` 峰值 `148.81 MB` (`152,380 KB`) -> 停机重启后 `idle-post` 回落 `74.46 MB` (`76,248 KB`) | 稳态回落正常，无明显内存持续泄漏 |
| 文件描述符 (`fd_count`) | 初始 `32` -> 高并发峰值 `106` -> 故障排空后回落 `31` -> 重启后 `33` | 流与请求中断释放干净，无 FD 泄漏 |
| TCP 连接数 (`19080`) | `idle-pre` total=`3` (ESTAB `2`) -> `high` ESTAB 峰值 `152` -> `fault` 阶段 `TIME-WAIT` 峰值 `133` (`ESTAB=0`)；结束停机后仅剩少量 `TIME-WAIT`，**0 LISTEN** | Keep-Alive 连接正常回收 |
| SQLite 文件大小 | `recommend.sqlite` `4,096 B` -> 写入期间 `393,216 B`；`WAL` 高峰 `4,218,912 B`（总 `4,714,883 B`）；`DELETE`+重启 checkpoint 后 WAL 收敛为 `123,632 B`（总 `615,283 B`） | WAL 收敛正常 |
| 5xx 错误率与日志异常 | 矩阵阶段 5xx 增量为 **0**；Staging 全程共 9 次注入式 5xx（最大观测比率 `0.000816`，详见 `FAILURES.md`）；`errorCount=0` | 无未捕获异常 |
| 密钥 / Cookie / Auth 泄漏 | 全部 7 个采样点及全量停机扫描 **`secret_or_auth_leak = false`** | 零泄漏 |

---

## 6. 稳定性、故障注入与持久化恢复覆写矩阵

详情见 [FAILURES.md](./FAILURES.md) 及 [RAW-OUTPUT.txt](./RAW-OUTPUT.txt)：
- **搜索取消 / 快速切换搜索词**: 20 次并发 `AbortController.abort()` 全量生效；连续快速切换 `Sonic-a..d` 后仅最终 `Sonic` 返回 200（3 条结果）。
- **搜索超时 / 403 / 429 / 503 / 网络错误**:
  - 边缘网关隔离测试确认 `timeout(150ms)` -> `504 UPSTREAM_TIMEOUT`、Engine `503` -> `502 SEARCH_UPSTREAM_UNAVAILABLE`、关闭端口 `ECONNREFUSED` -> `502`（第 1 次保持 `CLOSED`，连续第 3 次触发熔断 `OPEN`，第 4 次返回 `Circuit OPEN (fetch failed)`）。
  - 实时 Staging：`source=netease` / `gdstudio` -> `403 SOURCE_DISABLED_BY_POLICY`；单 IP >600 req/min -> `429 RATE_LIMITED` (`allowed200=600, rejected429=50`)；错误/缺失身份签名 -> `503 ENGINE_IDENTITY_UNAVAILABLE`。
- **Stream 403 / 404 / 429 / 503 / 416 / 快速切歌**:
  - `syn-fault-403` (`403`)、`pressure-missing` (`404`)、`syn-fault-429` (`429`)、单 IP 持有 4 个在途流后第 5 个返回 `429 STREAM_CONCURRENCY_LIMIT`、签名失效 (`503 ENGINE_IDENTITY_UNAVAILABLE`)、`syn-fault-500` (`502`)、`syn-fault-timeout` (`504`)、越界 Range (`416`)；同 IP 连续 20 次切歌中断后仍可完整拉取 `syn-chord` (240,044 B `RIFF`)，确认流槽位无泄漏。
- **重复事件写入 / Subject 隔离 / DELETE 与优雅停机重启恢复**:
  - 同 `eventId` 重复 POST 去重（`accepted=1`, 再次 `deduplicated=1`）；Subject A 写入/删除与 Subject B 完全隔离；在途 504 请求期间执行 `SIGTERM` 优雅停机（`cleanExit=true`, `elapsedMs=3296ms`, 在途请求顺利收到 `504`）；重启引擎后 Subject A 保持为空且 `eventEpoch` 保留、Subject B 事件留存，旧 epoch 补报返回 `409 EVENT_EPOCH_MISMATCH`，携带新 `eventEpoch` 上报返回 `200`，清空后 `eventCount=0`。

---

## 7. Playwright 真实无头浏览器内测结果

- **命令 A（按指定环境变量 `PLAYWRIGHT_BROWSERS_PATH=0`）**:
  - 命令：`PLAYWRIGHT_BROWSERS_PATH=0 CI=true corepack pnpm --dir player exec playwright test --reporter=list`
  - 结果：**123 failed (`exit=1`)**。原因：按前置要求清除并重装 `player/node_modules` 后，包内 `.local-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` 不存在。
- **命令 B（使用本机系统已预装浏览器缓存 `/root/.cache/ms-playwright/chromium_headless_shell-1194`）**:
  - 命令：`CI=true corepack pnpm --dir player exec playwright test --reporter=list`
  - 结果：**123 / 123 passed (`7.7m`, `exit=0`)**（`desktop-chromium`: 78 例，`mobile-chromium`: 45 例，覆盖 22 个 spec 文件），基于前端构建产物 (`player/dist`) + 本地 Mock 服务 (`player/e2e/mock-server.mjs`，20s 本地 WAV 夹具) 完成以下分项核验：
  - **搜索与重试**: `release-followup.spec.ts`（14 例，含桌面 Songs/Playlists/MV 的 403/429/503/network 重试与 Tab 保持 12 例）、`mobile-search.responsive.spec.ts`（18 例，含 360px/390px 429/403/503/network 与真假空态区分及重试）、`release-followup.responsive.spec.ts`（10 例，360px/390px HTTP 503 重试与延迟取消）、`search-timeout.spec.ts`（桌面 4 例 + 移动 4 例）、`resilience.spec.ts`（15 例，含搜索 429/403/断网/改词防竞争及播放降级）全部通过。
  - **媒体解码**: `core.spec.ts` Seek 用例断言 `#audioPlayer.duration > 10`（20s 本地生成 WAV 夹具解码成功），`playback-listening.spec.ts` 使用 `audio.duration - 0.3` 并完成 20s 完播验证。
  - **播放开始与 `currentTime` 推进**: `expectPlaying` 在桌面 `core.spec.ts`（8 例）、移动端 `responsive.spec.ts` 等多处轮询断言 `#audioPlayer.paused === false` 且 `currentTime > 0.4` 通过。
  - **暂停停止推进**: `core.spec.ts` 暂停后等待 500ms 校验 `Math.abs(pausedLater - pausedAt) < 0.15`，随后恢复播放 `currentTime > pausedLater + 0.3` 通过。
  - **Seek**: `core.spec.ts` 点击进度条 50% 后校验 `7 < currentTime < 15` 且继续播放通过。
  - **移动端播放**: `mobile-chromium` (Pixel 7) 执行 `responsive.spec.ts`（5 例，含搜索结果点击起播与暂停）、`mobile-favorites.responsive.spec.ts`（3 例）、`charts-degradation.responsive.spec.ts`（3 例）、`charts-official.responsive.spec.ts`（2 例）等总计 45 例全部通过。
  - **无障碍 (`a11y`)**: `a11y.spec.ts` 桌面 3 例（搜索/播放/进度条可访问名称及 `role="slider"` 属性、所有可见按钮无未命名、键盘聚焦提交搜索）+ `responsive.spec.ts` 移动行可读 `aria-label`、44×44px 触控开关与 `lang`/`viewport` 校验全部通过。
  - **横向溢出**: `core.spec.ts`（桌面首页）、`release-followup.spec.ts`（桌面长标题与展开播放器）、`responsive.spec.ts`、`mobile-search.responsive.spec.ts`、`release-followup.responsive.spec.ts`（360px/390px 移动端及展开歌词/封面页）均通过 `scrollWidth - clientWidth <= 1` 检查。

---

## 8. 交付文件索引与 `NOT_RUN` 声明

### 已生成交付产物（`reports/pressure/`）
- [baseline.json](./baseline.json) (`1 × 100`)
- [normal.json](./normal.json) (`8 × 100`)
- [burst.json](./burst.json) (`32 × 100`)
- [high.json](./high.json) (`64 × 100`)
- [RESOURCE-SAMPLES.csv](./RESOURCE-SAMPLES.csv)
- [URLS.md](./URLS.md)
- [RAW-OUTPUT.txt](./RAW-OUTPUT.txt)
- [FAILURES.md](./FAILURES.md)
- [DELIVERY.md](./DELIVERY.md)

### 明确标记 `NOT_RUN`（不得将本地 Mock/Synthetic 视为生产已通过）
- **真实 OAuth 登录授权**: `NOT_RUN`
- **真实外部提供商与第三方 CDN 搜索/取流 (`netease`, `qq`, `kugou`, `kuwo`, `amll`, `lrclib`)**: `NOT_RUN`
- **真实外网 CDN 音频解码与真实 `Range` / `206` 分片传输**: `NOT_RUN`（本报告所有 `200`/`206` 播放均基于本地合成 WAV / Playwright Mock WAV）
- **Cloudflare Durable Object 线上分布式限流**: `NOT_RUN`（本地 VPS 仅以进程内内存限流器运行）
- **Docker 容器构建与运行验证**: `NOT_RUN`
- **真机硬件测试（iOS Safari / Android Chrome 实机）**: `NOT_RUN`
- **人工辅助无障碍审计（VoiceOver / NVDA / 纯键盘全站走查）**: `NOT_RUN`

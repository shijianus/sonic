# Sonic 故障注入、异常矩阵与阻塞边界记录 (`FAILURES.md`)

> 本文档按实测结果严格区分：**(1) 系统非预期故障**、**(2) 预期内故障注入与限流/熔断/策略拒绝**、**(3) 环境运行限制及未执行 (`NOT_RUN` / `BLOCKED`) 边界**。

---

## 1. 非预期系统故障（Unplanned Regressions / Leaks）

| 检查项 | 结果 | 说明 |
|---|---|---|
| URL 清单验证 (Staging + Production) | **0 失败** (27/27 通过) | 见 `URLS.md` |
| 并发矩阵 (`baseline` 1x100, `normal` 8x100, `burst` 32x100, `high` 64x100) | **0 非预期状态码 / 0 非预期 5xx** | 共计 10,500 次请求，其中期望 `200`/`206`/`404`/`416` 全部命中，`unexpectedStatuses=0` |
| 引擎进程日志错误 (`unhandled_error` / 非 JSON 异常) | **0** | Staging 11,464 行、Production 11 行，`errorCount=0` |
| 密钥 / Cookie / Authorization 泄漏检测 | **0 泄漏** | `stagingLeak=false`, `prodLeak=false`，对日志全文正则扫描命中 0 次 |
| 压力测试脚本初始断言修正（测试脚本问题，非被测源码缺陷） | 已记录 | 初次运行自建压测脚本时，在孤立网关故障注入中仅发送 1 次关闭端口 `ECONNREFUSED` 即断言 `circuit.state === 'OPEN'`；核查 `functions/_lib/sonic/local-engine.ts` 后确认默认阈值为 `SONIC_CB_FAILURE_THRESHOLD=3`（单次请求保持 `CLOSED` 且 `consecutiveFailures=1`，连续第 3 次失败后状态转为 `OPEN`，第 4 次跳过调用并返回 `Circuit OPEN (fetch failed)`），更新脚本为验证 1 次保持 `CLOSED` 与 3 次打开 `OPEN` 后通过 |

---

## 2. 预期内故障注入、策略拒绝与降级实测明细

### 2.1 Staging 引擎与边缘隔离故障/策略注入

| 测试场景 | 触发方式 | 预期响应 / 行为 | 实测响应 / 行为 | 结果 |
|---|---|---|---|---|
| 匿名访问本地引擎管理接口 | `GET /api/sonic/engine/health`（无密钥头） | HTTP 401 `ENGINE_UNAUTHORIZED` | Staging & Production 均返回 `401 ENGINE_UNAUTHORIZED` | PASS |
| Production 环境启用 synthetic 参数 fail-closed | Production 设置 `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1` 后请求 `synthetic` stream / test-audio / search | HTTP 403 `SOURCE_DISABLED_BY_POLICY` | 三类端点均返回 `403 SOURCE_DISABLED_BY_POLICY`，`/api/sonic/engine/health` 报告 `enableSynthetic=false` | PASS |
| Staging 非白名单来源拦截 | Staging 请求 `source=netease` 与 `/api/sonic/search/gdstudio` | HTTP 403 `SOURCE_DISABLED_BY_POLICY` | 均返回 `403 SOURCE_DISABLED_BY_POLICY` | PASS |
| Stream 403 / 404 / 429 / 502 / 504 故障端点 | `syn-fault-403`, `pressure-missing`, `syn-fault-429`, `syn-fault-500`, `syn-fault-timeout` | 403 / 404 / 429 / 502 / 504 | 分别实测返回 `403 UPSTREAM_FORBIDDEN`、`404 STREAM_NOT_FOUND`、`429 UPSTREAM_RATE_LIMITED`、`502 UPSTREAM_ERROR`、`504 UPSTREAM_TIMEOUT` | PASS |
| Stream 非法 Range | `Range: bytes=999999999-` 请求 `syn-440hz` (192044 bytes) | HTTP 416 `RANGE_NOT_SATISFIABLE` | 返回 `416 RANGE_NOT_SATISFIABLE`（提示 `outside 0-192043`） | PASS |
| 搜索与流式 503（签名身份缺失/篡改） | 发送错误/缺失 `X-Sonic-Verified-Identity` 访问 `/api/sonic/search/nexus` 与 `/api/music/stream` | HTTP 503 `ENGINE_IDENTITY_UNAVAILABLE` | 两个端点均返回 `503 ENGINE_IDENTITY_UNAVAILABLE` | PASS |
| 网关限流 429（单 IP `198.51.109.12`） | 连续对 `/api/sonic/search/nexus` 发起 650 次请求（每批 50 并发） | 前 600 次 200，超过 600/min 阈值触发 429 | `allowed200=600`, `rejected429=50`, 首个 429 返回 `code=RATE_LIMITED`, `x-ratelimit-limit=600`, `x-ratelimit-remaining=0`, `retry-after=60` | PASS |
| 单 IP 流并发上限 429（`198.51.109.11`） | 持有 4 个 `syn-fault-timeout`（250ms）流在途时发起第 5 个 stream 请求 | 第 5 个返回 429 `STREAM_CONCURRENCY_LIMIT`，排空后恢复 200 | 第 5 个返回 `429 STREAM_CONCURRENCY_LIMIT`；4 个在途均以 `504` 结束释放槽位，随后请求 `syn-440hz` 返回 `200` | PASS |
| 搜索取消 (Abort) | 20 个并发 `AbortController.abort()` 中断搜索后再次正常搜索 | 20 个全部抛出 `AbortError`，服务端随后正常返回 200 | `cancelledCount=20`，后续搜索返回 `200` | PASS |
| 快速切换搜索词 | 依次发起 `Sonic-a`..`Sonic-d` 并立即 `abort()`，再发起 `Sonic` | 前 4 个中止，最终仅 `Sonic` 生效返回 | `earlierOutcomes=["aborted"x4]`，`finalQuery="Sonic"`, `finalTracks=3` | PASS |
| 快速切歌与中断槽位释放 | 同一 IP `198.51.109.10` 连续 20 次打开 stream 读取首块后中止，再拉取 `syn-chord` | 槽位不泄漏，第 21 次全量下载成功 | `abortedStreams=20`，第 21 次 `200` 且完整读取 `240044` 字节 `RIFF` WAV | PASS |
| Edge->Engine 搜索超时 / 503 / 网络拒绝与熔断 | 孤立 `handleNexusSearchRequest` 对接本地可控 mock HTTP server（`timeout=150ms`、`503 ENGINE_DRAINING`、已关闭端口 `ECONNREFUSED`） | 分别映射为 504 / 502 / 502；连续 3 次网络拒绝后熔断器 `OPEN` | Timeout -> `504 UPSTREAM_TIMEOUT`；Engine 503 -> `502 SEARCH_UPSTREAM_UNAVAILABLE`；1 次 `ECONNREFUSED` -> `502` (`CLOSED`, `consecutiveFailures=1`)，连续 3 次 -> `OPEN`，第 4 次短路 `Circuit OPEN (fetch failed)` | PASS |
| Staging 访问日志中 9 次 5xx 统计核对 | 统计 `stagingLogAudit.status5xxCount` 与 `RESOURCE-SAMPLES.csv` | 与注入的 5xx 测试一一对应 | 共 9 次：`2`（URL 表 #16 502 + #17 504）+ `4`（并发测试持有的 4 个 `syn-fault-timeout` 504）+ `2`（身份签名失效 503 测试）+ `1`（优雅停机排空中的 504 请求）= **9 次**，无任何意外 5xx | PASS |
| 重复事件写入、主体隔离、DELETE 与优雅停机重启恢复 | Subject A 重复两次写入 `evt-shared-01`、Subject B 同 eventId 独立写入；DELETE A；在途请求期间对 Staging 发 `SIGTERM` 排空并重启 | A 去重 (`deduplicated=1`)、B 保留 (`totalEvents=1`)；停机前在途请求正常结束；重启后 SQLite 维持 A=0（同一 `eventEpoch`）与 B=1；陈旧 epoch POST 返回 409 | `gracefulStop.cleanExit=true (elapsedMs=3296, inflightDrainStatus=504)`；重启后 `A=0 (eventEpoch 匹配)`、`B=1`；无新 epoch POST 返回 `409 EVENT_EPOCH_MISMATCH`；携带新 epoch POST 返回 `200 (accepted=1)`；最终清零 `eventCount=0` | PASS |

### 2.2 浏览器端 E2E 异常与降级覆写核验（Playwright Mock Server）

在本地构建产物 (`player/dist`) + `player/e2e/mock-server.mjs` 下共运行 **123** 个用例，其中明确验证客户端面对故障与竞争时的表现（非真实外部上游）：
- 搜索故障区分与重试恢复：403 / 429 / 503 / 断网 / 超时均与真实空结果区分开，显示重试面板且重试可恢复（覆盖桌面端与移动端 360px / 390px、`Songs` / `Playlists` / `MV` 与 `Trending` / `New Songs`）。
- 播放异常与降级：播放 URL 返回 `403` / `429` / `404` / `503` / 挂起超时 / 连接中断时给出明确错误提示且不产生未捕获异常（`pageErrors=[]`）。
- 快速切歌与迟到响应：快速连点下一首、切换搜索词、取流中暂停、慢歌单晚到响应均验证“旧慢响应无法覆盖当前状态或意外自动起播”。

---

## 3. 执行期阻塞与环境/边界限制（`BLOCKED` / `NOT_RUN`）

### 3.1 `PLAYWRIGHT_BROWSERS_PATH=0` 指定命令失败情况

| 命令 | 退出码 | 实际错误与原因 | 替代核验 |
|---|---:|---|---|
| `PLAYWRIGHT_BROWSERS_PATH=0 CI=true corepack pnpm --dir player exec playwright test --reporter=list` | **1** (`123 failed`) | 按要求前置执行 `rm -rf player/node_modules && CI=true pnpm --dir player install --frozen-lockfile` 清除了包内 `.local-browsers`，而 `PLAYWRIGHT_BROWSERS_PATH=0` 强制从 `player/node_modules/.pnpm/playwright-core@1.56.1/node_modules/playwright-core/.local-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell` 查找浏览器，导致全部 123 个用例因找不到可执行文件而无法启动 | 不设置 `PLAYWRIGHT_BROWSERS_PATH=0`，改用系统缓存 `/root/.cache/ms-playwright/chromium_headless_shell-1194` 运行 `CI=true corepack pnpm --dir player exec playwright test --reporter=list`，**123/123 全部通过** (`exit=0`, `7.7m`) |

### 3.2 孤立无 Durable Object 绑定警告

在执行 `run-vps-pressure-audit.mjs` 第 7 项（进程内直接调用 `handleNexusSearchRequest` 并传入构造的 `SONIC_RUNTIME: 'cf-pages'`）以及对应 Node 诊断命令时，由于未接入真实 Cloudflare Durable Object (`SONIC_RATE_LIMITER`)，系统按设计降级到内存限流并输出：
`{"type":"rate_limit_degraded","backend":"memory","scope":"sonic-search","degradedEvents":1,"note":"The shared rate limiter is absent or degraded; check the Durable Object binding and runtime"}`。

### 3.3 明确标记为 `NOT_RUN` 的生产能力边界

以下能力本次本地 loopback 内测**未验证**，不得以本地合成 WAV、Mock Server 或内存限流代替宣称具备生产通过状态：
- **真实 OAuth 登录与账号授权流**: `NOT_RUN`（本地验收边界禁止登录第三方账号，未连接 OAuth 提供商）
- **真实上游音乐提供商与外部 CDN (`netease`, `qq`, `kugou`, `kuwo`, `amll`, `lrclib`)**: `NOT_RUN`（本地 loopback 与 `strict-allowlist` synthetic 夹具下未发起真实外网音源搜索与取流）
- **真实 CDN 音频与外网 `Range` / `206` 断点传输**: `NOT_RUN`（本次 `206` 与播放解码仅针对本地生成的合成 `audio/wav` 音源及 `e2e/mock-server.mjs` 本地 20s WAV 夹具）
- **Cloudflare Pages / Worker 线上运行时与 Durable Object 分布式限流**: `NOT_RUN`
- **Docker 容器化构建与运行时测试**: `NOT_RUN`
- **真实物理移动设备与桌面浏览器兼容性**: `NOT_RUN`（移动端测试为 headless Chromium 的 Pixel 7 仿真与 360px/390px 视口）
- **人工辅助无障碍实测（屏幕阅读器 / 纯物理键盘通栏走查）**: `NOT_RUN`（仅运行了自动化 ARIA 属性与可见按钮可读名称、搜索框聚焦检查）

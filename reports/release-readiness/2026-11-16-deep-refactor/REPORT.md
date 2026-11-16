# Sonic 本机公测候选版深度重构与补强验收报告

- 验收日期：2026-11-16（Asia/Tokyo）
- 实际 patch 基线：`c9d6405111dcd4fe04226dd0c9dff16ad93d4a41`（`origin/gemini-sync-752911f`，Tree SHA `09ea785cd018df9d982199d200b7855dcd858b36`；本地对象库不含旧引用 `752911f0c2d65e03717468b91e67c152f8d69c5b`）
- 上游参照（未改写）：`1c03ce4acc36d4b28f31cba83fcd25086714650a`（`origin/main`）
- 前置冻结候选提交：`7b6ecb146b5a69ba9ca2fc79d49d99ddce2df7eb`（`origin/gemini-public-beta-20261116`，Tree SHA `a0116dfb71d46a739741f319ce6542fe0864af04`）
- 代码检查点（实际全量测试与类型检查所在提交）：`4a7ae8a66429cc422684c8cda41ad444da15da5b`
- 当前候选分支：`fix/public-beta-followup-20261116`（最终候选提交 SHA、提交后复测 `releaseId` 与 `pagesArtifactDigest` 见随附交付文件 `DELIVERY.md` 与 `FINAL-VERIFICATION.md`）
- 源码摘要（`sourceDigest`，源码与测试输入恒定指纹）：`b07b013f586f83ad5e1827cd0256e5d18c1649903011da03454e8aa5f583a077`
- 构建是否 `dirty`：`false`（所有测试与构建均在干净工作树执行）
- 已废弃旧标识说明：此前交付中出现的 `5cfeb865f90ea24d2bb81ba4d0751db75f5c63fe` 与 `3ad942aa7c83b5038a456b7c6004ba158652fc6af64063be48d1f4a68a328e54` 已完全废弃，不作为本轮候选身份。
- 测试边界：只使用本机 `127.0.0.1` loopback、合成 Provider、mock server 与本地生成 WAV；无账号登录、无公网部署、无真实凭据写入。

## 本轮实际修复与补强

在基线 `c9d6405` → `7b6ecb1`（包含 `cloudsearch type=1004` 回退、播放/切歌 retry budget 清零、移动端搜索竞态中断、分页工具规范化、外部推荐适配器 URL/字节上限加固）的基础上，本轮 `fix/public-beta-followup-20261116` 继续完成：

1. **交付证据链一致性修复**：废弃此前不一致的 `5cfeb865` / `3ad942aa` 报告记录，将 `CI=true npm run typecheck`、完整日志与 `exit-codes.txt` 统一收口并保持 `REPORT.md`、`TEST-REPORT.md` 与 `changes.zip` / `changes.patch` 完全一致。
2. **分页越界收缩与交互加固**（`SearchSongs.vue`、`pages/search.vue`、`pages/mobile/search.vue`、`Ui/Pagination.vue`）：
   - 当上游返回 `total > 0` 但当前页超出新总页数时，发出收缩后的合法 `total` 并自动 clamp 到合法页码；保留错误场景（`total = 0`）下的当前页码以便重试不回跳第 1 页；
   - 为分页按钮补充 `type="button"`、`aria-label`、`aria-current="page"` 与同页重复点击去重。
3. **音质切换去重、加载态、回退与面板布局修复**（`layout/footer.vue`）：
   - 对同档位在途切换请求进行去重，切歌或完成/失败/被新切换取代时清理加载态；
   - 音质按钮与面板选项暴露 `aria-busy` 与加载旋转指示，消除级联重试误伤并加大面板间距防止码率标签碰撞。
4. **补齐真实浏览器交互 E2E 用例**（`e2e/mock-server.mjs` 及 4 个新 spec）：
   - 桌面端分页（`pagination.spec.ts`，3 项）：Next/Prev/键盘 Enter、上游 total 收缩 clamp、快速连点取消旧页响应、Page 2 加载态与 503 重试保持页码；
   - 移动端分页（`pagination.responsive.spec.ts`，360px/390px 共 2 项）：数字页码/Prev/Next、激活页重复点击去重、503 重试、total 收缩 clamp、切词中止慢请求；
   - 桌面端音质切换（`quality-switch.spec.ts`，4 项）：点击切换音质保持播放进度与暂停态、键盘 `ArrowDown`/`ArrowUp`/`Enter`/`Escape` 操作、503 失败回滚保持菜单与后续切换恢复、同档位去重 + `aria-busy` 加载态 + 切歌取消 + 等大小探测禁用高音质；
   - 移动端音质设置与播放驱动（`quality-switch.responsive.spec.ts`，360px/390px 共 4 项）：设置页音质布局无溢出、重载持久化并驱动播放流请求携带 `quality=exhigh`、迷你播放器不泄露桌面弹窗。

## 自动化验证（执行提交：`4a7ae8a66429cc422684c8cda41ad444da15da5b`）

所有命令完整 stdout/stderr 保存于 `reports/release-readiness/2026-11-16-deep-refactor/` 对应 `.log` 文件，退出码汇总于 `exit-codes.txt`。

| 命令 | 退出码 | 实测结果摘要 | 日志文件 |
|---|---:|---|---|
| `CI=true npm run typecheck` | 0 | `tsc --noEmit` + `vue-tsc --noEmit` 通过；执行提交 `4a7ae8a66429cc422684c8cda41ad444da15da5b`，`sourceDigest=b07b013f...`，`dirty=false` | `typecheck.log` |
| `CI=true npm run lint` | 0 | `lint:theme`（453 条基线覆盖）与 `eslint` 通过 | `lint.log` |
| `CI=true npm test` | 0 | 网关 101 + 认证 44 + 封面 28 + 本地引擎 52 + 主 Vitest 14 文件 247 项 + Beta 18 文件 394 项，合计 866 项通过 | `full-test.log` |
| `CI=true corepack pnpm --dir player test` | 0 | 22 个文件、178 项通过 | `player-full-test.log` |
| 后端定向回归（runtime + external-adapters） | 0 | 2 个文件、82 项通过（76 + 6） | `targeted-backend-regressions.log` |
| 前端定向回归（pagination + search race + playback race） | 0 | 3 个文件、54 项通过（2 + 24 + 28） | `targeted-player-regressions.log` |
| `CI=true npm run build` | 0 | 前端构建与 release manifest 生成通过 | `build-clean.log` |
| `CI=true npm run build:engine` | 0 | `dist-server/index.mjs` 构建通过 | `build-engine-clean.log` |
| `CI=true node scripts/verify-built-release.mjs` | 0 | 12/12 发布检查通过（`head: 200`, `range: 206`, `invalid: 416`） | `verify-built-clean.log` |
| `CI=true npm run verify:pages-deploy` | 0 | Pages 部署树与 `compiledRelease` 校验一致 | `verify-pages-clean.log` |
| `npm run test:load` | 0 | 600 请求、8 workers、419.34 req/s、p50 18.15ms、p95 39.61ms、max 123.15ms、`rollingErrorRate5xx: 0` | `test_load.log` |
| `npm run test:pressure` | 0 | 605 请求、8 workers、465.67 req/s、p50 13.39ms、p95 39.28ms、max 62.11ms、16 次取消检查通过 | `test_pressure.log` |
| `npm run test:observability` | 0 | 脱敏、失败投递拒绝、缺失 webhook 拒绝全部通过 | `test_observability.log` |
| `npm run eval:recommend` | 0 | 6 personas 通过，Precision@10 0.6167、Recall@10 0.4728、NDCG@10 0.7729 | `eval_recommend.log` |
| `npm run eval:multi-entity` | 0 | 4 personas、4 type probes、`propagationValid: true` 通过 | `eval_multi_entity.log` |
| `PLAYWRIGHT_BROWSERS_PATH=0 ... playwright test e2e/specs/a11y.spec.ts` | 1 | 环境 `.local-browsers/chromium_headless_shell-1194` 缺失；先记录失败路径后再使用本机缓存浏览器执行 | `playwright-system.log` |
| `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright ... playwright test --reporter=line` | 0 | 桌面 85/85 + 移动 51/51，合计 136/136 通过（含新增分页与音质切换 E2E 共 13 项），耗时 8.3m | `playwright-project-browser.log` |

代码检查点（`4a7ae8a66429cc422684c8cda41ad444da15da5b`）构建身份：

- `releaseId`: `4a7ae8a66429cc422684c8cda41ad444da15da5b`
- `sourceDigest`: `b07b013f586f83ad5e1827cd0256e5d18c1649903011da03454e8aa5f583a077`
- `dirty`: `false`
- `pagesArtifactDigest`: `c976ff2e6ec04b7f188ae1b8aedaccc039207c12db4164b657066f764154e8cb`

（本报告提交后形成的最终候选提交 Commit SHA 及提交后复测 `releaseId` / `pagesArtifactDigest` 见交付清单 `DELIVERY.md` 与 `FINAL-VERIFICATION.md`。）

## 压力测试与隐私边界实测细节

- 总请求数 `605`（`8` workers × `75` req + `5` 条基准探测），耗时 `1299.19ms`，吞吐量 `465.67 req/s`；
- 延迟分布：p50 `13.39ms`、p95 `39.28ms`、max `62.11ms`；
- 取消检查 `16/16` 通过，5xx 错误率 `0`（`test:load` `rollingErrorRate5xx: 0`）；
- Range 响应：`stream-200` / `stream-206` / `stream-416` / `stream-404` 及 `verify-built-release` 的 `head: 200`、`range: 206`、`invalid: 416` 全部通过；
- 隐私隔离：8 个匿名主体各 15 条事件全部 `isolated: true`；清理后 `eventStoreEmptyAfterCleanup: true`（`eventCount === 0`）。

## 外部环境边界（明确 NOT_RUN）

以下依赖真实账号、生产凭据或公网生产基础设施的项目在本机均未执行，明确标记为 `NOT_RUN`（不得作为公网生产 GO 依据）：

- 真实 OAuth 登录 / 回调 / 退出 / 撤销
- 真实 Provider 音源与真实 CDN 拉流
- 真实外部音频解码与持续播放
- Cloudflare Pages / Engine 线上部署与 Durable Object 线上限流
- SQLite 生产持久化卷、公网容量压测与真实 Webhook 告警投递
- Safari / Chrome 真机实测、VoiceOver / TalkBack 读屏实测
- 版权与 ToS 书面授权核验

结论：本版本可作为**本机冻结公测候选版与代码审阅同步分支**交付；在完成上述 `NOT_RUN` 外部链路独立核验前，**不可宣称公网生产上线 GO**。

# Sonic 本地公测候选测试报告

## 固定基线

- 远端基线提交：`2554f4c69c15ec365d641240b153fbdef059a75e`（父提交：`f64cb4a14a92c552b5b4f2f95e00851dd9f40208`）
- 已验证代码提交：`f314ae61a0a5c4a9c07b3c8f8e0397e7e39890fd`（在 `2554f4c` 基础上修复 `player/e2e/mock-server.mjs` 按搜索类型返回空数组字段）
- Release ID：与最终构建时干净工作树 `HEAD` 一致（代码提交阶段为 `f314ae61a0a5c4a9c07b3c8f8e0397e7e39890fd`；docs-only 报告提交后以最新 `dist/release.json` 的 `releaseId`/`baseCommit` 重新构建并核验）
- Source digest：`ee9a155ddc41b352411a37556127fb8236838cf63e9a14dabe7150201b9c178b`
- 分支：`codex/refactor-public-beta`
- 运行范围：本地 Work VPS，仅限 `127.0.0.1` loopback
- 外部网络：压力脚本为 `false`

## 完整验证命令（基于 `f314ae6`）

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm ci` | 0 | 根依赖清洁安装通过 |
| `corepack pnpm@10.34.5 --dir player install --frozen-lockfile` | 0 | Player 冻结安装通过 |
| `npm run typecheck` | 0 | 根与 Player TypeScript 检查通过 |
| `npm run lint` | 0 | `lint:theme` 与 ESLint 通过 |
| `npm test` | 0 | Gateway 101、Auth 44、Cover 28、Engine 52、主 Vitest 14 files / 247 tests、Beta 18 files / 390 tests |
| `corepack pnpm@10.34.5 --dir player test` | 0 | 20 files、169 tests |
| `npm run build` | 0 | 前端构建、`dist/release.json` 生成与静态复制通过 |
| `npm run build:engine` | 0 | Engine 编译构建通过 |
| `node scripts/release-inputs.mjs --verify dist/release.json` | 0 | 478 个发布输入通过摘要校验 |
| `npm run verify:pages-deploy` | 0 | Pages deploy tree、release identity 与 compiled release 通过 |
| `TMPDIR=<scratch-tmp> node --experimental-sqlite scripts/verify-built-release.mjs` | 0 | HTTP、SQLite、备份恢复、擦除隔离与 production synthetic gate 12/12 通过 |
| `npm run test:observability` | 0 | 可观测性与告警红线自测通过 |
| `npm run eval:recommend` | 0 | 离线推荐评估通过（`livePlaybackVerified: false`） |
| `npm run eval:multi-entity` | 0 | 多实体混合评估通过 |
| `npm run test:load` | 0 | 本地混合负载 600 请求（453.78 req/s）与 webhook 告警通过 |
| `CI=true SONIC_PRESSURE_WORKERS=8 SONIC_PRESSURE_REQUESTS_PER_WORKER=75 npm run test:pressure` | 0 | 本地并发压力门禁通过（`externalNetwork: false`） |
| `CI=true corepack pnpm@10.34.5 --dir player run e2e --reporter=list` | 0 | Chromium 无头 E2E 实跑 123/123 通过（基于本地 `vite preview` + `player/e2e/mock-server.mjs`，耗时 7.8m） |
| `npm audit --omit=dev --audit-level=high` | 0 | 根生产依赖（及完整根 `npm audit`）0 漏洞 |
| `corepack pnpm@10.34.5 --dir player audit --prod --audit-level=high --registry=https://registry.npmjs.org` | 0 | Player 生产依赖 0 漏洞（默认镜像 `registry.npmmirror.com` 未实现 audit 接口返回 404，需指定官方 registry） |

### 开发期依赖审计说明（`pnpm --dir player audit`）

- 完整（含 `devDependencies`）审计检出 **3 high、7 moderate、0 critical**：
  - High（3）：`postcss`（2 项 sourceMappingURL 路径读取/遍历）、`decode-uri-component`（1 项 ReDoS）
  - Moderate（7）：`postcss`（4 项）、`micromatch`（1 项）、`decode-uri-component`（1 项）、`minimatch`（1 项）
- 上述告警均位于前端开发/构建期工具链，不进入运行时生产包或 Engine 部署产物；仍建议后续在锁版本升级计划中处理。

## 本地 Engine Smoke（`127.0.0.1` loopback）

分别以 `staging`（`SONIC_ALLOWED_SOURCES=synthetic`、`SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1`）和 `production`（`SONIC_ALLOWED_SOURCES=netease`）通过 `scripts/start-bare-metal-engine.mjs` 启动并在 `scripts/verify-engine-smoke.mjs` 下验证，测试结束后均立即关闭进程：

- `GET /api/sonic/engine/health` 无 Key 返回 `401`
- 大小写路径 `GET /API/Sonic/Engine/Health` 无 Key 仍返回 `401`
- 带 Key 返回 `200`
- Engine `release` 身份字段与 `dist/release.json`、`X-Sonic-Release` 完全一致
- SQLite readiness（`recommendEngine.storageKind === "sqlite"`）正常
- `staging` 模式下 synthetic WAV `/api/music/stream?id=syn-440hz&source=synthetic` 返回 `200`、Range `bytes=0-43` 返回 `206`、越界 Range 返回 `416`
- `production` 模式下即使设置 `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1` 也拒绝 synthetic 音源（`403`）
- smoke 退出码均为 `0`

## 压力结果（`f314ae6` 执行记录）

```bash
CI=true SONIC_PRESSURE_WORKERS=8 SONIC_PRESSURE_REQUESTS_PER_WORKER=75 npm run test:pressure
```

- 执行时间：`2026-11-14T18:15:12.071Z`
- 总请求数：`605`（8 workers × 75 req/worker + 启动专项检查）
- 测试耗时：`1324.53 ms`
- 吞吐：`456.77 req/s`
- P50：`13.77 ms`
- P95：`40.58 ms`
- 最大延迟：`61.81 ms`
- 取消检查：`16/16`
- subject 隔离：`8/8`
- 清理后事件数：`0`
- `externalNetwork`：`false`
- 结果：`ok: true`

压力覆盖 `/api/sonic/search/nexus` 返回 `200`、`/api/music/stream` `200`/`206`/`416`、未知音源 `404`（`STREAM_NOT_FOUND`）、请求取消、并发 Range、错误响应、事件写入、profile 查询、SQLite 隔离和 `DELETE` 清理。

机器可读证据位于 `reports/release-readiness/evidence/public-beta-pressure.json`。

## 代码重构核对（`Audit search playback` 已完成，无保留待办）

- `cloudsearch` 按歌曲、歌单、歌手、专辑和 MV 类型分别校验结构化结果
- 字符串与 malformed result 返回可观察错误
- provider 全失败返回 `502` 或超时 `504`
- `type=1004` MV 搜索将关键词 `s` 传递给上游，并兼容结构化 `result.mvs` 与旧式数组
- Nexus 空结果与 provider 全失败分离
- 分页总数通过 `totalKnown` 明确表达，避免伪造总数
- 前端歌曲、歌单、MV 与移动搜索页按结果类型校验响应，并具备 `requestGeneration` 与 `AbortController` 取消保护
- `qualityProbe` 去重和取消键覆盖来源、平台 ID、URL 与 `qualities`；缺少高音质 URL 时不把同一外部 URL 冒充成高质量档位
- 单测与集成回归覆盖搜索错误契约与音质探测
- 根目录声明 `packageManager: pnpm@10.34.5`

推荐评估保持 `livePlaybackVerified: false`。本地 synthetic 播放、Range 验证与基于 `player/e2e/mock-server.mjs` 的 Chromium E2E 均不能替代真实公网 CDN 与真实浏览器的实际音频解码与起播。

## 公众生产环境门禁（当前仍为 NO-GO）

当前仅完成本地代码、构建、发布身份与 loopback synthetic 候选验收；公众生产上线前仍必须由发布负责人完成以下外部/生产门禁：

- 真实 OAuth 登录、回调、刷新、退出和撤销
- 获准 provider 逐源真实搜索与播放
- 真实 CDN Range、Seek、暂停、恢复和 `currentTime` 推进
- `403`、`404`、`429`、`502`、`504`、过期签名和断网恢复实测
- Cloudflare Durable Object invite 存储与 Durable rate-limit binding
- Pages 与 Engine 独立 HTTPS origin 联调
- 生产 `strict-allowlist` 内容策略配置核验
- 真实 Docker 或等价 VPS 容器构建与部署验收
- iOS Safari、Android Chrome、桌面跨浏览器兼容实测
- 人工无障碍（A11y）验收
- 生产备份、恢复、回滚与告警全链路演练

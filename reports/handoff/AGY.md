# Sonic Linux 后端、边缘安全网关、Staging 部署与回滚验收交接报告（AGY）

- **交付时间（UTC）**：`2026-10-30T06:52:00Z`
- **负责角色**：Linux 主开发 AI（`agy`，Gemini Argon High）
- **协作对象**：Windows 前端与最终 RC 集成负责人（`ZCode`，DeepSeek V4.1 Flash 1017 Max）
- **仓库地址**：`https://github.com/shijianus/sonic`

---

## 1. Base SHA 与分支信息

| 维度 | 值 | 说明 |
|---|---|---|
| 原始安全收敛基线 SHA | `1d45e4cb38f6346f9a964d31fdba421c01d5e28b` | `reports/handoff/BASELINE.md` 确立的共同祖先 |
| 最新 RC 集成基线分支 | `origin/rc/sonic-20261031` | 已包含 ZCode 前端竞态修复、Browser E2E、`45b9a5e`、`d29a32f`、`20e399f` |
| 本轮直接父提交（Base SHA） | `20e399f846a7a306f5f28434d5809aa9fa4f5fb2` | `work/agy-release-20261031` 直接基于该 SHA 快进构建，零冲突 |
| Linux 交付主分支 | `work/agy-release-20261031` | 已推送至 `origin`，可直接快进合并入 `rc/sonic-20261031` |
| 兼容别名分支 | `work/agy-20261031` | 与 `work/agy-release-20261031` 指向同一 HEAD SHA（对齐 `BASELINE.md` §6） |
| PR 比较与创建链接 | `https://github.com/shijianus/sonic/compare/rc/sonic-20261031...work/agy-release-20261031?expand=1` | 宿主机无 `gh` CLI 且环境变量 Token 已过期，通过 SSH 推送并提供精确比较链接 |

---

## 2. 修改文件列表与职责说明

本轮严格遵守文件所有权边界：**未修改 `player/**` 下任何前端代码或锁文件**，所有变更集中在 `functions/**`、`server/**`、Docker/Compose、运维脚本、测试与发布文档：

### 2.1 新增文件
- [`functions/_lib/sonic/licensing.ts`](../../functions/_lib/sonic/licensing.ts)：内容授权状态矩阵（`APPROVED` / `CONDITIONAL` / `PENDING_CONFIRMATION` / `PROHIBITED`）与 `SONIC_CONTENT_POLICY=strict-allowlist`、`SONIC_ALLOWED_SOURCES` 服务端强门禁。
- [`functions/_lib/sonic/synthetic-media.ts`](../../functions/_lib/sonic/synthetic-media.ts)：零版权（CC0）第一方确定性 16-bit 24kHz PCM/WAV 合成音频生成器（`syn-440hz`、`syn-528hz`、`syn-chord`）与 HTTP Byte-Range 切片解析器。
- [`functions/api/sonic/test-audio.ts`](../../functions/api/sonic/test-audio.ts)：受控测试音源与故障注入端点（支持 `200`/`206`/`416`/`HEAD` 及 `syn-fault-403`/`429`/`500`/`timeout`，支持 Pages → Tunnel → Linux Engine 穿透）。
- [`functions/_lib/sonic/observability.ts`](../../functions/_lib/sonic/observability.ts)：统一请求计数、5xx 率、分路由 P95 延迟（滑动样本窗口）、流代理状态统计、限流降级统计、敏感信息正则脱敏器与 Webhook 告警投递器（含 SSRF 校验与冷却去重）。
- [`functions/_middleware.ts`](../../functions/_middleware.ts)：全局边缘中间件，实现 `SONIC_STAGING_ACCESS_TOKEN` 常量时间访问门禁、Staging `X-Robots-Tag: noindex, nofollow, noarchive`、全路由延迟/状态码采集、5xx 阈值自动告警与 `X-Sonic-Release` 响应头注入。
- [`functions/api/sonic/engine/metrics.ts`](../../functions/api/sonic/engine/metrics.ts)：受 `X-Sonic-Engine-Key` 保护的观测快照（`GET`）与真实告警通道自检触发端点（`POST ?action=test-alert`）。
- [`scripts/verify-observability-and-alerts.mjs`](../../scripts/verify-observability-and-alerts.mjs)：可观测性、日志/告警脱敏与本地 Webhook 闭环自检脚本（`npm run test:observability`）。
- [`scripts/restore-recommend-db.mjs`](../../scripts/restore-recommend-db.mjs)：非破坏性 SQLite 恢复脚本（恢复前 `PRAGMA integrity_check`、自动生成 `.pre-restore-<timestamp>.sqlite` 安全快照、清理陈旧 WAL/SHM 并原子替换）。
- [`docs/CONTENT-LICENSING-MATRIX.md`](../../docs/CONTENT-LICENSING-MATRIX.md)：逐源音频/歌词/封面/元数据授权状态清单与受控内测配置规范。
- [`docs/RUNBOOK-ROLLBACK.md`](../../docs/RUNBOOK-ROLLBACK.md)：Staging/生产部署前检查、SQLite 备份恢复与分层快速回滚手册。
- [`tests/release-p0-p1-gate.test.ts`](../../tests/release-p0-p1-gate.test.ts)：13 项 P0/P1 服务端门禁回归测试。
- [`reports/handoff/evidence/docker-sqlite-drill-20261030.json`](evidence/docker-sqlite-drill-20261030.json) 与 [`reports/handoff/evidence/staging-and-rollback-20261030.json`](evidence/staging-and-rollback-20261030.json)：脱敏实测证据。

### 2.2 修改文件
- **OAuth 与鉴权（P0-A）**：[`functions/_lib/auth.ts`](../../functions/_lib/auth.ts)、[`functions/api/auth/login.ts`](../../functions/api/auth/login.ts)、[`functions/api/auth/callback.ts`](../../functions/api/auth/callback.ts)、[`functions/api/auth/logout.ts`](../../functions/api/auth/logout.ts)、[`functions/api/auth/revoke.ts`](../../functions/api/auth/revoke.ts)
- **流代理、SSRF、缓存与限流（P0-B）**：[`functions/api/music/stream.ts`](../../functions/api/music/stream.ts)、[`functions/proxy.ts`](../../functions/proxy.ts)、[`functions/api/sonic/forward.ts`](../../functions/api/sonic/forward.ts)、[`functions/_lib/sonic/security.ts`](../../functions/_lib/sonic/security.ts)、[`functions/_lib/sonic/local-engine.ts`](../../functions/_lib/sonic/local-engine.ts)、[`functions/_lib/sonic/route-helpers.ts`](../../functions/_lib/sonic/route-helpers.ts)
- **内容授权边界与多源适配（P0-C）**：[`functions/_lib/sonic/config.ts`](../../functions/_lib/sonic/config.ts)、[`functions/_lib/sonic/native-protocols.ts`](../../functions/_lib/sonic/native-protocols.ts)、[`functions/_lib/sonic/nexus-search.ts`](../../functions/_lib/sonic/nexus-search.ts)、[`functions/_lib/sonic/nexus-lyrics.ts`](../../functions/_lib/sonic/nexus-lyrics.ts)、[`functions/_lib/sonic/upstream.ts`](../../functions/_lib/sonic/upstream.ts)、[`functions/_lib/sonic/providers/index.ts`](../../functions/_lib/sonic/providers/index.ts)、[`functions/_lib/sonic/recommend/seed-catalog.ts`](../../functions/_lib/sonic/recommend/seed-catalog.ts)、[`functions/_lib/sonic/recommend/engine.ts`](../../functions/_lib/sonic/recommend/engine.ts)、[`functions/_lib/sonic/recommend/smart-search.ts`](../../functions/_lib/sonic/recommend/smart-search.ts)、[`functions/_lib/music.ts`](../../functions/_lib/music.ts)、[`functions/api/music/search.ts`](../../functions/api/music/search.ts)、[`functions/api/music/cover.ts`](../../functions/api/music/cover.ts)、[`functions/api/sonic/resolve/stream.ts`](../../functions/api/sonic/resolve/stream.ts)、[`functions/palette.ts`](../../functions/palette.ts)
- **健康检查、SQLite、Docker 与配置（P1-A/B/C）**：[`functions/api/index.ts`](../../functions/api/index.ts)、[`functions/api/sonic/engine/health.ts`](../../functions/api/sonic/engine/health.ts)、[`server/index.ts`](../../server/index.ts)、[`server/recommend-sqlite.ts`](../../server/recommend-sqlite.ts)、[`Dockerfile`](../../Dockerfile)、[`docker-compose.yml`](../../docker-compose.yml)、[`.env.example`](../../.env.example)、[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)、[`package.json`](../../package.json)

---

## 3. 安全、OAuth、音频代理、内容授权完成状态

> 状态词严格限定为：`PASS`、`FAIL`、`BLOCKED`、`NOT RUN`、`NOT APPLICABLE`。

| 编号 / 检查项 | 状态 | 验证方式与证据 |
|---|---|---|
| **P0-A1**：OAuth PKCE (`S256`)、256-bit `state`、常量时间比对、一次性消费、`HttpOnly; Secure; SameSite=Lax` 会话 Cookie（禁止 URL 传 Key） | `PASS` | `tests/oauth-security.test.ts`（18 例）+ `tests/release-p0-p1-gate.test.ts` |
| **P0-A2**：`POST /api/auth/logout` 跨站 `Origin` 与 `Referer` 双重同源 CSRF 校验（与 `/api/auth/key`、`/api/auth/revoke` 对齐） | `PASS` | [`functions/api/auth/logout.ts`](../../functions/api/auth/logout.ts) + 单测验证跨站 `Referer` 返回 `403` |
| **P0-A3**：Epomail Token 交换兼容 RFC 6749 `application/x-www-form-urlencoded`（`EPOMAIL_TOKEN_CONTENT_TYPE=form\|json`）及错误日志脱敏 | `PASS` | [`functions/_lib/auth.ts`](../../functions/_lib/auth.ts) + 单测验证 |
| **P0-A4**：受控内测 OAuth 入口服务端开关 `SONIC_ENABLE_OAUTH=0`（返回 `403 OAUTH_DISABLED_BY_POLICY`，**不削弱** `verifyAuth` 或 `SONIC_REQUIRE_AUTH`） | `PASS` | 本地单测 + Staging 实测 `GET /api/auth/login` 返回 `403 OAUTH_DISABLED_BY_POLICY` |
| **SONIC-P0-05**：使用真实 Epomail 账号在测试环境执行完整 OAuth 登录/回调/会话/退出/撤销联调 | `BLOCKED` | 当前环境未配置真实 `EPOMAIL_CLIENT_ID` / `EPOMAIL_CLIENT_SECRET` 及批准的测试账号；绝不伪造回调冒充通过，已在 Staging 启用 `SONIC_ENABLE_OAUTH=0` 隔离 |
| **P0-B1**：SSRF 三重校验（仅 HTTPS、端口 80/443、内网/回环/CGNAT/Metadata IPv4&IPv6 拦截、DNS 重绑定校验、最多 3 跳逐跳重定向校验、移除 `qq.com`/`163.com` 顶点域） | `PASS` | `tests/ssrf-security.test.ts`（13 例）+ Staging 实测 `169.254.169.254` 拦截返回 `400` |
| **P0-B2**：302 重定向与签名 URL 缓存防泄漏（含签名参数的 URL 即使请求 `?redirect=1` 也强制服务端代理解析并设 `Cache-Control: private, no-store`，绝不回传 `Location`） | `PASS` | [`functions/api/music/stream.ts`](../../functions/api/music/stream.ts) + `tests/release-p0-p1-gate.test.ts` |
| **P0-B3**：`200`/`206`/`416` 状态码、`Content-Range` 与 `Content-Length` 字节跨度一致性校验、`Content-Encoding` 下移除冲突 `Content-Length`、上游 `403`/`429`/`5xx` HTML 错误页清洗 + `no-store` | `PASS` | [`functions/api/music/stream.ts`](../../functions/api/music/stream.ts) + `tests/release-p0-p1-gate.test.ts` |
| **P0-B4**：限流降级显式化（`X-RateLimit-Backend`、`X-RateLimit-Degraded` 响应头 + 结构化告警）与生产强制分布式限流开关 `SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1`（缺失原生绑定时 `503` fail-closed） | `PASS` | [`functions/_lib/sonic/security.ts`](../../functions/_lib/sonic/security.ts) + 50 并发突发测试通过 |
| **SONIC-P0-06（技术链路）**：真实 Cloudflare Pages Edge → 安全网关 → Cloudflare Tunnel → Linux Engine 第一方授权音频（CC0 WAV）`200`、多段 `206` Seek 字节连续性与 `416` 实测 | `PASS` | 在 `https://sonic-staging.pages.dev` 实测 `syn-440hz`（`192,044` 字节）3 段 Range 切片与完整流逐字节比对 100% 一致（见 §5） |
| **SONIC-P0-06（商业第三方 CDN）**：商业音乐平台真实授权流 CDN Range/206 生产验收 | `BLOCKED` | 受 `SONIC-P0-07` 商业音源书面授权未到位阻断，严禁盗用商业签名或抓取未授权商业流充当验收 |
| **SONIC-P0-07（服务端隔离机制）**：逐源授权矩阵与 `SONIC_CONTENT_POLICY=strict-allowlist` 服务端强拦截 | `PASS` | [`docs/CONTENT-LICENSING-MATRIX.md`](../../docs/CONTENT-LICENSING-MATRIX.md) + Staging 实测未授权商业源返回 `403 SOURCE_DISABLED_BY_POLICY` |
| **SONIC-P0-07（法务/商务书面确认）**：第三方商业音源/歌词/封面生产使用授权签署 | `BLOCKED` | 需项目负责人/法务书面确认；确认前保持 `strict-allowlist` 关闭全部待确认商业源 |

---

## 4. 监控、SQLite、Docker、回滚演练结果

| 模块 | 状态 | 实测结果与指标 |
|---|---|---|
| **P1-A 最小可观测性与脱敏告警** | `PASS` | 1) `/api/sonic/engine/metrics` 实时输出请求总量、5xx 比例、各路由组（search/stream/lyrics/recommend/auth/cover/engine）P95 延迟、流代理错误分布、SQLite 状态与限流降级计数。<br>2) `npm run test:observability` 验证 `Cookie`、`Bearer`、`X-Sonic-Key`、`X-Sonic-Engine-Key`、URL 签名参数（`auth`/`sig`/`token`/`vkey`）100% 替换为 `[REDACTED]`。<br>3) 本地与容器演练实测触发 `MANUAL_ALERT_SELF_CHECK` 与 `ENGINE_STORAGE_UNHEALTHY` Webhook 通知送达。 |
| **P1-B SQLite 持久化、备份恢复与故障熔断** | `PASS` | 实测证据见 [`docker-sqlite-drill-20261030.json`](evidence/docker-sqlite-drill-20261030.json)：<br>1) 写入 3 条行为事件后执行 `docker restart` 与 `docker rm -f` + 同名卷重建，`eventCount=3`、`trackCount=4` 零丢失。<br>2) 容器以非 root 用户 `node:node`（`/app/data` 权限 `755`）运行。<br>3) 在线执行 `scripts/backup-recommend-db.mjs`（`VACUUM INTO` + `integrity_check`）生成 `94,208` 字节一致性备份。<br>4) 模拟误写入第 4 条事件后执行 `scripts/restore-recommend-db.mjs`，自动保留 `.pre-restore-*.sqlite` 副本并精确恢复至 3 条事件。<br>5) 低磁盘阈值触发 `/api/sonic/engine/health` 返回 `503`（`ok: false`）并发送 `ENGINE_STORAGE_UNHEALTHY` 告警；只读挂载 `:ro` 启动以退出码 `1` fail-closed 拒绝静默退回内存。 |
| **P1-C Docker 干净构建与版本可追溯** | `PASS` | 1) Node 22 Alpine 多阶段干净构建通过，注入 `SONIC_RELEASE_COMMIT` 与 OCI 镜像标签。<br>2) 宿主机端口仅绑定 `127.0.0.1:18080:8080`，不占用生产 `8080`/`18081`/`55435`。<br>3) 匿名访问与伪造 `Host: sonic.epocanvas.tech` 访问 `/api/sonic/engine/health` 均返回 `401`，携带正确 `X-Sonic-Engine-Key` 返回 `200` 且 `release.releaseCommit` 与构建 SHA 完全一致。 |
| **P1-04 双向回滚演练（Staging Pages + Docker Engine + SQLite）** | `PASS` | 实测证据见 [`staging-and-rollback-20261030.json`](evidence/staging-and-rollback-20261030.json)：<br>1) 先部署基线 `20e399f`（Deployment A：`e64dd74e-1091-4750-b6d8-43af4885e105`），再部署当前 RC（Deployment B：`48992d04-fd67-4d55-bff7-611489887585`）。<br>2) 执行回滚（Pages Rollback API + 容器切换回 `sonic-engine:baseline-20e399f`），实测 **回滚 RTO = `2.41 秒`（`2,406 ms`）**，SQLite 事件数据完整保留（**RPO = 0 已提交事务**）。<br>3) 重新切回验证通过的 RC 并完成最小 Smoke Test（匿名门禁 `401`、合成检索 `200`、Range `206` 播放正常），实测 **前向恢复 RTO = `1.76 秒`（`1,756 ms`）**。 |

---

## 5. Staging 部署地址、Deployment ID、Engine 镜像 Digest

- **隔离 Staging 域名（Cloudflare Pages）**：`https://sonic-staging.pages.dev`（受 `SONIC_STAGING_ACCESS_TOKEN` 保护，未授权请求一律返回 `HTTP 401 STAGING_ACCESS_REQUIRED` 与 `X-Robots-Tag: noindex, nofollow, noarchive`；**未触碰生产 `cfsolara` 项目**）
- **隔离 Cloudflare Tunnel**：`sonic-staging-engine-20261030`（Tunnel ID：`65454bdb-f04a-41f4-8be6-9672fd434af9`，演练域名 `https://engine-sonic-staging.epocanvas.tech` → `http://127.0.0.1:18080`；演练后已自动清理临时 DNS/Tunnel 进程，**未触碰生产隧道 `af3cf7c1-a33a-4b74-99d2-e4e64bf72194`**）
- **Baseline 回滚目标（Deployment A，`20e399f`）**：
  - Cloudflare Pages Deployment ID：`e64dd74e-1091-4750-b6d8-43af4885e105`（`https://e64dd74e.sonic-staging.pages.dev`）
  - Linux Engine Docker Image Digest：`sha256:4785f88d01684ea15fe2e349a39c9d10116b59610dd80b1c950d1ce75d55ffe7`（`sonic-engine:baseline-20e399f`）
- **当前验证 RC（Deployment B）**：
  - Cloudflare Pages Deployment ID：`48992d04-fd67-4d55-bff7-611489887585`（`https://48992d04.sonic-staging.pages.dev`）
  - Linux Engine Docker Image Digest：`sha256:4ad3a85bf064c1cc8891f2c6136eb47511408d4712d3129f8f36e1dbe328a600`（`sonic-engine:rc-4fb8e79`）

---

## 6. 需要 ZCode 前端配合的 API 与契约说明（100% 向后兼容）

本轮后端未引入任何破坏性协议变更，现有前端代码可直接无缝运行。供 ZCode 在 RC 集成与浏览器 E2E 联调时使用的增强能力如下：

1. **OAuth 状态感知（可选）**：
   - `GET /api` 返回 `auth.oauthEnabled: boolean`，`GET /api/login/status` 返回 `oauthEnabled: boolean`。
   - 当内测设置 `SONIC_ENABLE_OAUTH=0` 时，`/api/auth/login` 与 `/api/auth/callback` 返回 `HTTP 403`（`error.code === "OAUTH_DISABLED_BY_POLICY"`）。前端可根据 `oauthEnabled === false` 隐藏登录按钮或展示“内测阶段暂未开放账号登录”。
2. **第一方授权测试曲目（供真实网络 E2E 与 Seek 验收）**：
   - 当服务端设置 `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1` 时，搜索关键词 `440Hz`、`528Hz`、`Chord` 或 `Sonic` 可检索到 3 首 CC0 合成测试曲目：`syn-440hz`（8s）、`syn-528hz`（10s）、`syn-chord`（12s）。
   - 播放接口 `/api/music/stream?id=syn-440hz&source=synthetic` 支持完整 `200`、任意字节范围 `206 Partial Content` 拖动与 `416`。
3. **可控故障注入 ID（供 `SONIC-P1-02` 错误降级 E2E 验收）**：
   - 请求 `/api/music/stream?id=<fault_id>&source=synthetic` 可稳定触发：
     - `syn-fault-403` → `HTTP 403`（`UPSTREAM_FORBIDDEN`）
     - `syn-fault-429` → `HTTP 429`（`UPSTREAM_RATE_LIMITED`，含 `Retry-After: 5`）
     - `syn-fault-500` → `HTTP 502`（`UPSTREAM_ERROR`）
     - `syn-fault-timeout` → `HTTP 504`（`UPSTREAM_TIMEOUT`）
4. **Staging 门禁请求头**：
   - 访问受控内测环境时，可通过请求头 `X-Sonic-Staging-Token: <token>`（或首次访问附带 `?staging_token=<token>` 自动种下 `HttpOnly` Cookie `sonic_staging_access`）通过门禁。

---

## 7. 最小人工依赖清单（供项目负责人决策）

| 依赖项 | 对应门禁 | 需要人工提供的最小输入 |
|---|---|---|
| 1. Epomail OAuth 测试凭据与账号 | `SONIC-P0-05` | 在 Staging/生产配置 `EPOMAIL_CLIENT_ID`、`EPOMAIL_CLIENT_SECRET`、`EPOMAIL_REDIRECT_URI`，并提供 1 个批准的测试邮箱账号执行真实浏览器登录回归；完成后将 `SONIC_ENABLE_OAUTH` 设为 `1`。 |
| 2. 第三方音源/歌词/封面书面授权确认 | `SONIC-P0-07` | 由负责人/法务审阅 [`docs/CONTENT-LICENSING-MATRIX.md`](../../docs/CONTENT-LICENSING-MATRIX.md) 并书面确认允许开放的来源；仅将获批来源加入 `SONIC_ALLOWED_SOURCES`。 |
| 3. Cloudflare 原生分布式限流绑定 | `P0-B` 生产限流 | 在 Cloudflare Pages 项目绑定原生 `RATE_LIMITER`（或至少绑定 `RATE_LIMIT_KV`），并在生产开启 `SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1`。 |
| 4. 生产告警通知 Webhook | `SONIC-P1-03` | 在 `.env` / Pages 配置真实运维群 HTTPS Webhook（`SONIC_ALERT_WEBHOOK_URL`），执行 `POST /api/sonic/engine/metrics?action=test-alert` 确认收信。 |

---

## 8. 残余风险与缓解措施

1. **未绑定原生 `RATE_LIMITER` 时的跨实例限流近似性**：在未配置 Cloudflare 原生 `RATE_LIMITER` 绑定时，边缘退回单实例内存限流（已在响应头标注 `X-RateLimit-Degraded: 1` 并记录观测指标）；生产环境可通过 `SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1` 强制阻断降级。
2. **第三方商业源未获授权前曲库范围受限**：在 `SONIC_CONTENT_POLICY=strict-allowlist`（`SONIC_ALLOWED_SOURCES=synthetic`）下，仅提供 3 首 CC0 合成测试音频，可完整验证播放/拖动/推荐/收藏/状态机，但不含商业版权曲目。
3. **真机与人工无障碍验收尚未执行（`SONIC-P1-05`）**：需配合 iOS Safari / Android Chrome 实机及屏幕阅读器完成最终人工签字。

---

## 9. 发布与内测建议结论（GO / NO-GO）

1. **面向公众或开放商业音源的正式发布**：**NO-GO**
   - 原因：`SONIC-P0-05`（真实 Epomail OAuth 账号联调）与 `SONIC-P0-07`（商业音源/歌词/封面法务授权确认）属于外部人工依赖，处于 `BLOCKED` 状态；`SONIC-P1-05` 真机与人工无障碍验收处于 `NOT RUN` 状态。
2. **仅开放第一方授权合成音源的隔离受控内测（Controlled Beta）**：**CONDITIONAL GO（服务端就绪）**
   - 前提条件：保持 `SONIC_STAGING_ACCESS_TOKEN` 访问控制、`X-Robots-Tag: noindex`、`SONIC_CONTENT_POLICY=strict-allowlist`、`SONIC_ALLOWED_SOURCES=synthetic`、`SONIC_ENABLE_OAUTH=0`。
   - 依据：所有服务端代码质量门禁、Docker 干净构建、SQLite 持久化/备份/无损恢复/只读熔断、可观测性脱敏告警、真实 Cloudflare Pages → Tunnel → Linux Engine 的 HTTP `200`/`206` Seek 连续性与 `2.23s` 双向回滚演练均已 **100% PASS**。

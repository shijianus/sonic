# Sonic 生产运维手册（2026-10-28）

> 本文档只描述当前代码实际实现的行为。未实现的能力（如内置 Prometheus exporter）会明确标注为“未实现”，不以计划代替现状。

## 1. 部署拓扑

- **Cloudflare Pages**：静态 SPA + `functions/` 边缘网关；面向公网，承载 OAuth 回调、API Key 校验、边缘缓存与降级。
- **Linux VPS `sonic-engine`**：Node.js 22.13+，监听 `8080`，默认只绑定 `127.0.0.1`；所有 `/api`、`/proxy`、`/palette` 路由强制要求 `X-Sonic-Engine-Key`。
- **`ncm-api`**：网易云协议侧车，仅在 Compose 内部网络 `sonic-internal:3000` 可达，不映射宿主端口。
- **数据卷**：`sonic-data` → `/app/data`，保存 `sonic-recommend.sqlite`。

## 2. 必需配置与密钥生成

```bash
openssl rand -base64 48   # SONIC_SECRET
openssl rand -base64 48   # SONIC_ENGINE_SECRET（Pages 与 VPS 必须完全一致）
```

必须项：

| 变量 | 说明 |
|---|---|
| `SONIC_SECRET` | API Key HMAC 签名密钥，长度 ≥ 32；缺失时认证与签发均 fail-closed |
| `SONIC_ENGINE_SECRET` | Pages ↔ 引擎服务间密钥，长度 ≥ 32；缺失时引擎返回 503 |
| `EPOMAIL_CLIENT_ID` / `EPOMAIL_CLIENT_SECRET` | OAuth 登录；缺失时 `/api/auth/login` 返回 503 |
| `EPOMAIL_BASE_URL` | 必须是 HTTPS（localhost 开发除外） |
| `EPOMAIL_REDIRECT_URI` 或 `SONIC_ALLOWED_ORIGINS` | 至少配置一个；否则无法建立合法回调 |

可选但建议：

```ini
SONIC_REQUIRE_AUTH=0        # 1 = 所有网关 API 拒绝匿名请求（登录端点除外）
SONIC_RATE_LIMIT_ANON_RPM=240
SONIC_RATE_LIMIT_AUTH_RPM=600
SONIC_TIMEOUT_MS=8000
SONIC_ENGINE_TIMEOUT_MS=4500
SONIC_CB_FAILURE_THRESHOLD=3
SONIC_CB_COOLDOWN_MS=30000
SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite
SONIC_RECOMMEND_RETENTION_DAYS=90
EPOMAIL_HTTP_TIMEOUT_MS=8000
```

`.env` 权限必须为 `600`，不得提交到 Git。示例值（如 `SONIC_REAL_IP=203.0.113.10`）是文档占位符，不能用于生产。

## 3. OAuth 2.0 配置与行为

1. 在 Epomail 控制台登记精确回调地址，例如 `https://sonic.example.com/api/auth/callback`。
2. 推荐显式设置 `EPOMAIL_REDIRECT_URI`，避免依赖请求 Host 动态推导。若同时在多个域名提供服务，请勿设置单一固定回调（Cookie 是 host-only，跨域回调无法带上网关事务 Cookie），应改用单一主域或为每个域独立部署。
3. 登录流程：
   - `/api/auth/login` 生成 256-bit `state` 与 PKCE `code_verifier`，写入 `HttpOnly; Secure; SameSite=Lax; Path=/api/auth` 短效 Cookie（10 分钟）；
   - 授权 URL 使用 `code_challenge_method=S256`；
   - `/api/auth/callback` 强制校验 state、PKCE verifier 与授权码格式，缺失即拒绝；
   - 成功后签发 30 天 `sonic_session` Cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`），**不把 API Key 放入 URL**；
   - 回调重定向仅携带 `?auth=success`。
4. 退出：`POST /api/auth/logout` 清除 Cookie。该操作不会自动吊销已导出的 API Key。
5. 真实 OAuth 联调需要有效的 Epomail 客户端；本仓库自动化测试使用 Mock 上游，不覆盖真实服务差异。当前 Token 交换以 `application/json` 发送；若 Epomail 要求 `application/x-www-form-urlencoded`，需在联调后调整并补充测试。

## 4. API Key 生命周期

- 格式：`sonic_live_v2.<header>.<payload>.<signature>`；HS256；载荷含 `sub/iat/exp/jti/kid/role/uid`。
- 有效期：30 天；服务端拒绝超过 90 天的令牌以及 `exp <= iat`。
- 轮换：
  1. 生成新密钥；
  2. `SONIC_SECRET_PREV=<old>`（可选 `SONIC_SECRET_PREV_KID`）；
  3. `SONIC_SECRET=<new>`，可选设置 `SONIC_SECRET_KID=<new-label>`；
  4. 重新部署；
  5. 至少等待旧 Key 自然过期（≤ 30 天）后再移除 `SONIC_SECRET_PREV`。
- 撤销：
  - 环境变量方式（无需 KV，需重新部署）：`jti` 加入 `SONIC_REVOKED_JTIS`；邮箱加入 `SONIC_REVOKED_SUBS`；全量设置 `SONIC_TOKEN_MIN_IAT=<Unix 秒>`。
  - **可选实时撤销（Cloudflare KV）**：在 Pages 绑定 KV 为 `SONIC_KEY_REVOCATION_KV`，设置 `SONIC_ENABLE_KEY_REVOCATION=1`；`POST /api/auth/revoke` 会写入 `jti`，`POST /api/auth/key` 轮换与 `POST /api/auth/logout` 也会尝试撤销当前 jti。
  - 实时撤销在同一 isolate 立即生效，其他 isolate 通过 30 秒短缓存传播；KV 读失败时默认 fail-closed（`SONIC_KEY_REVOCATION_FAIL_CLOSED=1`），可显式设为 `0` 换取可用性。
  - 未配置 KV 时，`POST /api/auth/revoke` 返回 `501 REVOCATION_STORE_NOT_CONFIGURED`，不会宣称撤销成功。
- API Key 仅接受请求头：`X-Sonic-Key`、`X-CFSolara-Key`、`X-Api-Key`、`Authorization: Bearer`。查询参数永远不接受。

## 5. 健康检查与日志

- 引擎健康：`GET /api/sonic/engine/health`，必须带 `X-Sonic-Engine-Key`。
- Docker HEALTHCHECK 使用 Node 内置 `fetch` 读取环境变量，密钥不出现在进程参数中。
- 健康载荷包含：运行时、ncm 侧车状态/延迟、provider 开关、推荐存储统计、进程 uptime/RSS、熔断状态。
- 外部请求默认有连接/响应头超时（`SONIC_TIMEOUT_MS` 等）、响应体空闲超时（30s）与响应体大小上限；音频流不限制总时长，但不能长期无数据停滞。
- Node 引擎访问日志为逐行 JSON：
  `{"type":"access","requestId":"...","method":"GET","path":"/api/...","status":200,"durationMs":12}`
  **不记录查询字符串、Cookie、Authorization 或请求体。**
- 未处理异常记录 `type=unhandled_error`，只包含 requestId、错误名与截断消息。
- Cloudflare Pages 使用 Cloudflare 日志/Analytics；进程内指标由受密钥保护的 `/api/sonic/engine/metrics` 提供。指标在每个进程/isolate 重启时归零，不跨实例聚合。

### 滚动指标与告警

- `observability.requests` 为进程累计计数；告警依据 `observability.window.requests` 的总请求数、5xx 数与 `errorRate5xx`（0..1），不使用累计错误率。窗口默认 300 秒，按 1 秒桶淘汰，最旧的部分秒不计入；`from`、`to`、`observedSec` 显示实际观察范围。启动后不必等满 300 秒，但必须达到最少请求数。
- `observability.window.latency.<group>` 为窗口内各路由组最近最多 512 个延迟样本，含 P50/P95/P99、样本数和该组窗口请求数；`latency` 原字段仍为进程累计计数与最近 512 个样本。P95 是有界样本估计，不是全窗口每个请求的精确分位数。Node 延迟包含响应结束前的耗时，长音频流应单独评估。
- 5xx 默认在窗口内至少 100 个请求、至少 5 个 5xx 后，错误率 **> 2%** 发 warning，**> 5%** 发 critical。2% 与回滚 runbook 的调查阈值一致；低流量未达门槛时不自动通知，仍需外部健康探针。warning 与 critical 独立冷却，升级不会被 warning 冷却压住。
- P95 告警默认关闭。配置毫秒阈值后，整体及每个路由组在窗口请求数达到门槛、有效样本数达到 `min(最少请求数, 512)`，且 P95 **严格大于**相应阈值时发告警。只在请求完成时评估，P95 最多每秒一次；无后台循环，不保证“持续 N 分钟”判定。未配置阈值时，P95 仅供观察，不能据此声称 P95 告警已验收。

| 配置 | 默认 | 行为 |
|---|---|---|
| `SONIC_ALERT_WEBHOOK_URL` | 空 | 自动告警关闭；配置安全 HTTPS URL 后启用；URL 不进入载荷/日志 |
| `SONIC_ALERT_WINDOW_SEC` | `300` | 滚动窗口 10..3600 秒；每秒桶计数，固定内存上限 |
| `SONIC_ALERT_MIN_REQUESTS` | `100` | 窗口/路由组最低请求数，1..1000000 |
| `SONIC_ALERT_5XX_THRESHOLD` | `5` | 窗口内最少 5xx 数（保留旧变量），1..1000000 |
| `SONIC_ALERT_5XX_WARNING_RATIO` | `0.02` | warning 错误比例；0 关闭该级别 |
| `SONIC_ALERT_5XX_PAGING_RATIO` | `0.05` | critical 错误比例；0 关闭该级别 |
| `SONIC_ALERT_P95_WARNING_MS` | `0` | 显式设置 >0 毫秒启用 P95 warning |
| `SONIC_ALERT_P95_PAGING_MS` | `0` | 显式设置 >0 毫秒启用 P95 critical |
| `SONIC_ALERT_COOLDOWN_SEC` | `300` | 按 code + severity 冷却，0..86400 秒；0 可关闭冷却，重复并发仍合并 |
| `SONIC_ALERT_ALLOW_LOCALHOST` | `0` | 仅本地开发允许 loopback webhook；非本地始终要求 HTTPS |

比例限制在 0..1，P95 限制在 0..3600000ms；非法/空值回退默认，超界值截到边界。启用的 critical 阈值若低于 warning，会提升到 warning。配置以 metrics 的 `observability.alerts.policy` 实际生效值为准。Webhook 请求最多 5 秒，不跟随重定向；非 2xx、网络错误/超时均记为失败，重试受冷却约束。载荷脱敏配置密钥、Cookie、Bearer 与签名 URL 参数；不要把额外敏感内容放进人工 note。

### 告警交付门禁

```bash
# 确定性 stub 自检；不访问真实引擎或外部 webhook
node scripts/verify-observability-and-alerts.mjs --self-test

# 经授权的 live 检查：此命令实际投递一条 MANUAL_ALERT_SELF_CHECK
# 密钥由环境提供；不要把密钥放到命令参数或 URL
SONIC_ENGINE_URL=http://127.0.0.1:8080 node scripts/verify-observability-and-alerts.mjs

# 只读采集，不发送告警；不能作为发布告警门禁
SONIC_ENGINE_URL=http://127.0.0.1:8080 node scripts/verify-observability-and-alerts.mjs --metrics-only
```

live 需要 `SONIC_ENGINE_SECRET`（≥32 字符），staging 可提供 `SONIC_STAGING_ACCESS_TOKEN`。完整门禁要求 metrics/health JSON 与 HTTP 成功、有效 release 元数据、readiness/存储健康、两端限流 `productionCompliant === true`，并要求已配置 webhook、POST HTTP 成功且 `delivery.sent === true`、`delivery.status` 为 2xx。持久化存储必须报告 SQLite 与健康可写磁盘；Linux 单进程内存限流可通过，不要求 Cloudflare binding。任何缺配置、投递失败、未就绪都以非零退出并输出 `ok:false, fullGate:false`。显式 `--metrics-only` 仅报告采集成功，始终 `fullGate:false`；`--self-test` 验证本地代码与失败分支，不代表真实 webhook 可用。

## 6. 限流与熔断

- 匿名：默认 240 次/分钟/IP；有效 API Key：默认 600 次/分钟/账户（按邮箱哈希）；引擎调用：更高额度。
- 优先使用 Cloudflare 原生 `RATE_LIMITER` binding（原子、跨 isolate）。未绑定时可退到 KV（最终一致、非原子），再退到进程内固定窗口（每 isolate，最多 4096 个桶）。
- `X-RateLimit-Limit` 在原生 binding 模式下展示的是配置值，不一定等于 binding 实际阈值；以 binding 配置为准。
- 多实例/多 isolate 部署若未绑定原生限流器，**不能**宣称严格全局限流。
- 熔断：连续 3 次失败或收到 521/522/523/524/530 立即 `OPEN`；冷却 30 秒后进入 `HALF_OPEN`，只允许一个探针；成功回 `CLOSED`，失败回 `OPEN`。当前不做自动重试，避免放大上游压力。
- 熔断状态可在健康端点 `circuit` 字段与响应头 `X-Sonic-Circuit` 观察。

## 7. 缓存与数据保留

| 数据 | Fresh TTL | Stale TTL | 说明 |
|---|---|---|---|
| Nexus 搜索 | 1 小时 | 24 小时 | 仅缓存非空结果 |
| Smart 搜索 | 10 分钟 | 2 小时 | 个性化请求不进入共享缓存 |
| 歌词 | 24 小时 | 7 天 | 空结果不缓存 |
| 音频直链 | 8 分钟 | 20 分钟 | 远低于签名 URL 常见有效期 |
| Trending | 2 分钟 | 30 分钟 | 共享缓存仅限非个性化请求 |

- 失败/空结果不会被写入共享缓存；搜索空结果在引擎降级时会尝试 stale 缓存。
- SQLite 行为事件默认保留 90 天，按写入计数触发清理；`DELETE /api/sonic/events` 可删除当前身份的数据。

## 8. SQLite 备份、恢复与迁移

### 备份（一致性快照 + 完整性校验）

在仓库根目录（或容器内）执行：

```bash
# 宿主机/本地开发（数据库在仓库 data/ 下）
npm run backup:db -- data/sonic-recommend.sqlite backup/sonic-$(date +%F-%H%M).sqlite

# 或通过运行中的容器备份到数据卷，再复制出来
docker compose exec sonic-engine \
  node --experimental-sqlite scripts/backup-recommend-db.mjs \
  /app/data/sonic-recommend.sqlite /app/data/backup-$(date +%F-%H%M).sqlite
docker cp sonic-local-engine:/app/data/backup-YYYY-MM-DD-HHMM.sqlite ./backup/
```

脚本使用 `VACUUM INTO` 生成一致性副本，然后重新打开副本执行 `PRAGMA integrity_check` 并统计表行数；任何一步失败会删除不完整副本并以非零退出。

### 恢复（需要停机）

先停用所有写入者及自动重启控制器，确认正常关闭并核对快照摘要。详细流程见 [RUNBOOK-ROLLBACK §3.2](RUNBOOK-ROLLBACK.md#32-离线原子恢复)。不要手动复制覆盖主库或删除 WAL/SHM/journal 来绕过检查。

```bash
docker compose stop -t 75 sonic-engine
test "$(docker inspect --format='{{.State.ExitCode}}' sonic-local-engine)" = 0
# 使用已核验的恢复工具镜像及实际数据挂载；备份需与目标应用镜像匹配。
docker run --rm -v "${SONIC_DATA_MOUNT:?}:/app/data" \
  "${RECOVERY_TOOL_IMAGE_DIGEST:?}" \
  node --experimental-sqlite scripts/restore-recommend-db.mjs \
  "/app/data/${MATCHED_DB_SNAPSHOT:?}" /app/data/sonic-recommend.sqlite --offline
```

恢复脚本验证空间、锁、完整性、digest 和表计数，并保留原库安全快照。失败或维护锁未释放时不得重启。只有同版本恢复才能重新启动原容器；跨版本必须使用与快照配对的镜像重建。隔离恢复单测通过不是当前运行中服务回滚演练通过。

### 迁移

当前运行时有 subject-scoped event key 迁移，会重建表/唯一键并执行 `DROP TABLE`/`RENAME`，并非纯 additive schema。没有通用降级迁移框架；未经双向兼容实测，回滚必须使用**匹配的旧镜像 + 迁移前数据库快照**，并保留新版本数据。快照之后的提交不自动恢复，不能承诺 RPO 为零。

## 9. Docker 构建与运行

先完成 [发布检查单的源码包重建与溯源门禁](release/RELEASE-CHECKLIST.md#源码包重建与溯源门禁2026-11-02)，在解压根目录执行 `node scripts/release-inputs.mjs --verify release.json --index release-files.json`，并从该清单导出五个 release 构建变量。运行 `.env` 由运维单独提供，不放进源码分发包。

```bash
# 在全量源文件核验之后构建；不依赖本机 dist/ 或 dist-server/。
docker compose build --no-cache sonic-engine
docker compose up -d

# 查看状态与日志
docker compose ps
docker compose logs -f sonic-engine
```

- 镜像多阶段构建：前端从 `player/pnpm-lock.yaml` 冻结安装并构建；引擎用 esbuild 打包；运行镜像只含 `dist/`、`dist-server/`、`LICENSE`。
- 运行用户：`node`（非 root）；数据目录已 chown 给 `node`。
- 端口：仅 `127.0.0.1:${SONIC_BIND_PORT:-8080}:8080` 映射到宿主；`ncm-api` 不暴露端口。
- 容器启用 `no-new-privileges` 与 `cap_drop: ALL`。
- 若宿主目录以绑定挂载替代命名卷，需保证 UID 1000 可写。

## 10. 回滚

### Cloudflare Pages

- 优先在 Cloudflare Dashboard 选择上一个成功部署回滚；
- 若需重发，使用上一个已验证提交的原始 Pages 产物与对应 Staging 验收记录，按发布清单执行生产提升。
- Pages 与 VPS 引擎的响应契约（如 `X-Sonic-Stream-Type`、`X-Sonic-Circuit`）需协同回滚；不要只回滚一侧。

### Docker 引擎

- 每次发布记录不可变镜像 digest、release 身份、Pages Deployment ID，以及与该镜像匹配的数据库快照摘要/表计数；tag 名称本身并不不可变。
- 停写后保留失败版本数据与容器，按 [RUNBOOK-ROLLBACK §4.2](RUNBOOK-ROLLBACK.md#42-linux-engine镜像与数据库成对回滚) 恢复匹配的旧镜像和迁移前数据库；未经双向兼容验证，不能只换镜像复用新库。
- 恢复单测/历史版本演练不代表当前运行中服务已演练。当前版本的完整回滚、前向恢复及 RTO/RPO 需单独证据。

## 11. 安全事件处置

1. **API Key 泄露**：若仍持有该 Key 且已启用 KV 撤销，调用 `POST /api/auth/revoke`；否则把对应 `jti` 加入 `SONIC_REVOKED_JTIS`（或邮箱加入 `SONIC_REVOKED_SUBS`）并重新部署。随后通知用户重新登录。
2. **`SONIC_SECRET` 泄露**：立即生成新密钥；旧密钥放 `SONIC_SECRET_PREV` 仅用于短期过渡，或直接移除并让全部用户重新登录；评估是否需要全量吊销。
3. **`SONIC_ENGINE_SECRET` 泄露**：同时更新 Pages 与 VPS 环境变量并重新部署；检查引擎访问日志中的异常调用。
4. **OAuth 客户端密钥泄露**：在 Epomail 控制台轮换 Client Secret，更新 Pages 环境变量，清空所有浏览器会话（用户重新登录）。
5. **数据库损坏**：停止全部写入/重启控制器 → 保留损坏主库及旁路文件 → 核对镜像匹配的快照和摘要 → 按 §8 使用 `--offline` 恢复 → 核验后启动。不得删除 WAL/SHM/journal 绕过活动数据库检查。

## 12. 已知限制与残余风险（必须如实告知）

- **DNS rebinding**：Cloudflare Workers 无法把 DNS 解析结果绑定到实际连接；当前依赖 HTTPS + 受控域名白名单。Node 引擎在每次请求前解析并校验 DNS，但 `fetch` 会再次解析，仍存在理论上的 TOCTOU；白名单域名不由攻击者控制，风险受限，但**不能宣称已完全消除**。
- **限流一致性**：未绑定 Cloudflare 原生 `RATE_LIMITER` 时，KV 与内存限流不具备严格全局原子性。
- **OAuth state 重放缓存**：单 isolate/进程内有效；跨 isolate 仍依赖 OAuth 授权码一次性语义。
- **令牌撤销**：可选 KV 实时撤销已实现（30 秒跨 isolate 传播，KV 读失败默认 fail-closed）；未配置 KV 时仍依赖环境变量 + 重新部署，已签发 Key 无法在部署间隔内即时失效。
- **浏览器会话**：`sonic_session` Cookie 内含签名 API Key；Cookie 被盗等同于 Key 被盗。`GET /api/auth/key` 会按需把 Key 返回给同源 JS，XSS 仍可读取（已有前端 XSS 回归测试，但不等于绝对免疫）。
- **SQLite 单写者**：引擎设计为单实例；不要水平扩展多个共享同一 SQLite 文件的副本。
- **构建期依赖告警**：`vite-plugin-svg-icons` 链路的旧版 `postcss`/`micromatch` 仍会在全量审计中出现；它们不进入运行时。
- **监控**：有进程/isolate 内的有界指标、滚动阈值告警与 webhook 自检；没有跨实例聚合、后台持续时间判定或 Prometheus/OpenTelemetry exporter。需要完整服务级指标和无请求时的故障通知时，请外接采集与健康探针。
- **未实测项**：真实 Epomail OAuth 联调、真实上游账号 Cookie 行为、生产规模压测、Docker 构建（若本机 Docker daemon 不可用）需在具备条件的环境完成。

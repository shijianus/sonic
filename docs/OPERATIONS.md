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
- Cloudflare Pages 侧没有自定义全局访问日志；请使用 Cloudflare 日志/Analytics 或外部探针，不要声称本项目内置了统一指标系统。

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

```bash
docker compose stop sonic-engine

# 1. 先把当前数据库复制到宿主机保留
docker cp sonic-local-engine:/app/data/sonic-recommend.sqlite ./sonic-recommend.pre-restore.sqlite

# 2. 把已通过 integrity_check 的备份复制回容器
docker cp ./backup/sonic-YYYY-MM-DD-HHMM.sqlite sonic-local-engine:/app/data/sonic-recommend.sqlite

# 3. 清理旧 WAL/SHM（容器内 /app/data 路径）
docker compose run --rm --no-deps --entrypoint sh sonic-engine \
  -c 'rm -f /app/data/sonic-recommend.sqlite-wal /app/data/sonic-recommend.sqlite-shm'

docker compose start sonic-engine
curl -H "X-Sonic-Engine-Key: $SONIC_ENGINE_SECRET" http://127.0.0.1:8080/api/sonic/engine/health
```

恢复前必须保留现有数据库副本；不得直接删除生产数据。若健康检查失败，停止引擎并把 `sonic-recommend.pre-restore.sqlite` 复制回去。

### 迁移

当前 schema 使用 `CREATE TABLE IF NOT EXISTS` 幂等初始化，**没有版本化迁移框架**。如果后续修改表结构，必须新增显式迁移脚本、备份步骤与回滚方案，不能依赖运行时自动改表。

## 9. Docker 构建与运行

```bash
# 干净构建（不依赖本机 dist/ 或 dist-server/）
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
- 或检出上一个已验证 commit，重新执行 `npm ci && pnpm --dir player install --frozen-lockfile && npm run build && npm run deploy`（`scripts/deploy-pages.mjs` 要求工作区干净，除非显式设置 `ALLOW_DIRTY_DEPLOY=1`）。
- Pages 与 VPS 引擎的响应契约（如 `X-Sonic-Stream-Type`、`X-Sonic-Circuit`）需协同回滚；不要只回滚一侧。

### Docker 引擎

- 每次发布使用不可变镜像标签（例如 `sonic-engine:2026-10-28-<sha>`）；
- 回滚时先备份数据库，再 `docker compose down`，切换到上一镜像标签并 `up -d`；
- 若 schema 已发生不兼容变更，必须使用对应的数据库备份恢复，不能只回滚镜像。

## 11. 安全事件处置

1. **API Key 泄露**：若仍持有该 Key 且已启用 KV 撤销，调用 `POST /api/auth/revoke`；否则把对应 `jti` 加入 `SONIC_REVOKED_JTIS`（或邮箱加入 `SONIC_REVOKED_SUBS`）并重新部署。随后通知用户重新登录。
2. **`SONIC_SECRET` 泄露**：立即生成新密钥；旧密钥放 `SONIC_SECRET_PREV` 仅用于短期过渡，或直接移除并让全部用户重新登录；评估是否需要全量吊销。
3. **`SONIC_ENGINE_SECRET` 泄露**：同时更新 Pages 与 VPS 环境变量并重新部署；检查引擎访问日志中的异常调用。
4. **OAuth 客户端密钥泄露**：在 Epomail 控制台轮换 Client Secret，更新 Pages 环境变量，清空所有浏览器会话（用户重新登录）。
5. **数据库损坏**：停止引擎 → 备份损坏文件 → 用最近一次通过完整性校验的备份恢复 → 删除 `-wal/-shm` → 启动并检查健康。

## 12. 已知限制与残余风险（必须如实告知）

- **DNS rebinding**：Cloudflare Workers 无法把 DNS 解析结果绑定到实际连接；当前依赖 HTTPS + 受控域名白名单。Node 引擎在每次请求前解析并校验 DNS，但 `fetch` 会再次解析，仍存在理论上的 TOCTOU；白名单域名不由攻击者控制，风险受限，但**不能宣称已完全消除**。
- **限流一致性**：未绑定 Cloudflare 原生 `RATE_LIMITER` 时，KV 与内存限流不具备严格全局原子性。
- **OAuth state 重放缓存**：单 isolate/进程内有效；跨 isolate 仍依赖 OAuth 授权码一次性语义。
- **令牌撤销**：可选 KV 实时撤销已实现（30 秒跨 isolate 传播，KV 读失败默认 fail-closed）；未配置 KV 时仍依赖环境变量 + 重新部署，已签发 Key 无法在部署间隔内即时失效。
- **浏览器会话**：`sonic_session` Cookie 内含签名 API Key；Cookie 被盗等同于 Key 被盗。`GET /api/auth/key` 会按需把 Key 返回给同源 JS，XSS 仍可读取（已有前端 XSS 回归测试，但不等于绝对免疫）。
- **SQLite 单写者**：引擎设计为单实例；不要水平扩展多个共享同一 SQLite 文件的副本。
- **构建期依赖告警**：`vite-plugin-svg-icons` 链路的旧版 `postcss`/`micromatch` 仍会在全量审计中出现；它们不进入运行时。
- **监控**：没有内置 Prometheus/OpenTelemetry exporter；现有可观测性为结构化日志、健康端点、限流/熔断响应头。需要指标时请外接采集。
- **未实测项**：真实 Epomail OAuth 联调、真实上游账号 Cookie 行为、生产规模压测、Docker 构建（若本机 Docker daemon 不可用）需在具备条件的环境完成。

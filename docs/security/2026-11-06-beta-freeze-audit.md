# Sonic 后端安全审计与公测冻结评估

- 审计日期：2026-11-06
- 代码基线：`rc/sonic-20261031` @ `631f8da462b51e4d28489870d06dd8b8a049092a`（工作树 clean）
- 构建身份：`releaseId=631f8da462b51e4d28489870d06dd8b8a049092a`
  `sourceDigest=a7db117ee592b1869ae7c06575d330c2dab2d79dc194d1de4233337f49e8ed5b`
  `dirty=false`
- 审计范围：`functions/`、`server/`、`Dockerfile*`、`docker-compose.yml`、`.github/workflows/ci.yml`、部署/验证脚本、Playwright/Vitest 安全回归，以及本地 `wrangler pages dev` 的真实路由探测。
- 结论：**未发现可未授权接管账户、绕过引擎鉴权或远程执行代码的零日漏洞。当前状态仍为 CONDITIONAL NO-GO：匿名存储耗尽与一条内容合规旁路必须先处理，另有若干 P1/P2 加固项建议同批收敛。**

---

## 0. 发布判断

| 项 | 结论 |
| --- | --- |
| 未授权访问门禁 | 通过。路径大小写、百分号编码、双编码、点段、重复斜杠变体均未绕过 invite/engine gate（本地真实 Worker 探测） |
| OAuth / API Key | 通过自动化测试；真实 Epomail 与真实 OAuth 账号仍 NOT RUN |
| SSRF（用户可控 URL） | 通过。`target`/`url`/`image` 均经过域名白名单 + safeFetch；重定向逐跳校验 |
| SSRF（供应商重定向） | **未完全收敛**。多处 provider/legacy 请求仍使用默认 `follow` 重定向，且 NetEase 侧车请求携带 Cookie |
| 匿名事件存储 | **存在未公开的资源耗尽向量**，公测开放模式下可由匿名用户触发 |
| 内容合规 | **发现 NCM 侧车 `ENABLE_UNBLOCK` 透传旁路**；Sonic 代码自身的 `enableUnblock=false` 不能覆盖侧车 |
| 构建/测试 | `typecheck`、`npm test`、`lint`、`build`、`build:engine`、`verify:pages-deploy` 均通过；`npm audit` 0 漏洞 |

**建议：先完成 P0-1、P0-2，并至少完成 P1-1、P1-2、P1-5；其余 P1/P2 可带记录放行。完成后再执行 §6 的冻结/部署门禁。**

---

## 1. 已验证有效的控制

以下不是推断，本轮有代码或本地真实 Worker 证据：

| 控制 | 证据 |
| --- | --- |
| Pages 路由大小写不敏感 | `/api/...`、`/API/...`、`/Api/...` 在 invite 模式下均 401 |
| 编码/点段/重复斜杠 | `/api%2Fsonic%2F...`、`/%61pi/...`、`/palette/../api/...`、`/foo/../api/...` 均 401；双编码与 `..%2f` 返回 SPA，不会进入 API |
| Engine 鉴权 | 无 `X-Sonic-Engine-Key` 时 401；带 key 时进入 handler；服务密钥支持 `_PREV` 轮换 |
| Invite 门禁 | 业务 API、`/proxy`、`/palette`、account/events 在 invite 模式均 401；`/api/access/session`、`/api/access/invite`、OAuth 生命周期可达 |
| OAuth | state 256-bit、PKCE S256、HttpOnly 事务 Cookie、一次性 state、PKCE 缺失拒绝、邮箱未验证拒绝 |
| API Key | v2 HMAC、kid 轮换、iat/exp/jti、KV 撤销、请求头专用、URL 查询参数拒绝 |
| CSRF | 跨站 `POST /api/auth/logout`、`/api/access/logout` 均 403；Cookie 写操作使用严格同源校验 |
| CORS 安全头 | API JSON 带 `nosniff`、沙箱 CSP、HSTS、`no-store`（敏感端点）；上游 `Set-Cookie`/`Content-Encoding` 不转发 |
| SSRF 媒体白名单 | `target`/`url`/`image` 仅允许已授权域名；逐跳重定向校验；HTTPS→HTTP 降级拒绝；DNS 解析私网拒绝（Node） |
| 内容策略 | 生产必须 `strict-allowlist` + 非空已授权源；PROHIBITED/PENDING 源无法通过环境变量开启 |
| 限流/熔断 | 匿名/认证/引擎分档；生产缺原生 `RATE_LIMITER` 时 fail-closed；4xx 不再投毒熔断 |
| 多 Set-Cookie | 经 `_middleware` 包裹后 5 条 `Set-Cookie` 仍独立保留（本地 Worker 实测） |
| 依赖 | 根 `npm audit --omit=dev --audit-level=high` 0；Player `pnpm audit --prod` 0 |

自动化结果：`npm test` exit 0；jiti 200（gateway 90 / auth 43 / cover 15 / engine 52），Vitest 安全 202，beta 263；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run build:engine`、`npm run verify:pages-deploy` 均 exit 0。

---

## 2. P0：公测前必须处理

### P0-1 匿名事件导致 SQLite 磁盘耗尽

**位置**
- `functions/api/sonic/events.ts:29-52`（每 IP 4,000 events/min、每 subject 600/min）
- `functions/api/sonic/events.ts:253-265`（配额检查）
- `server/recommend-sqlite.ts:542-575`（`recordEvent` 无行数/字节上限）
- `server/recommend-sqlite.ts:940-970`（`pruneRetention` 只按 90 天删除）
- `server/recommend-sqlite.ts:62-67`（未设置 `PRAGMA max_page_count`/`PRAGMA foreign_keys=ON`）

**证据**
- `/api/sonic/events` 在 open 模式匿名可达；`x-sonic-anon-id` 由客户端自证，可无限轮换。
- 网关匿名限流 240 req/min，单请求最多 50 个事件；事件配额将有效上限压到约 **4,000 events/min/IP**，即约 **5.76M events/day/IP**。
- 90 天保留期；`behavior_events`、`user_entity_feedback`、`search_query_contributions`、`cooccurrence_contributions`、`search_queries` 均无总行数/字节/DB 大小上限。
- 本轮实测（临时库，20,000 条事件）：SQLite 文件 4,255,744 bytes，约 **213 bytes/event**；仅事件表一天约 **1.2 GB/IP**（未计 WAL/索引/其他表），90 天约 **110 GB/IP**。
- `probeDiskHealth` 只在 `/api/sonic/engine/health` 中触发 503 告警，**不阻止 event 写入**；磁盘可继续被写满，影响 SQLite 与同卷其他数据。

**影响**：匿名用户或邀请制下的恶意测试者可耗尽 VPS 磁盘；健康检查变 503 后写入仍然继续，可能导致 SQLite 写入失败、WAL 膨胀、服务不可用。属于公测开放模式下的高可用性风险。

**修复建议（必须至少选一组）**
1. 在 `SqliteRecommendStore` 启动时设置 `PRAGMA max_page_count`（按磁盘预算，例如 512MB/1GB），并在 `SQLITE_FULL` 时触发清理或返回 507；对 `behavior_events`/`user_entity_feedback`/`search_queries` 设置行数或字节上限，超限删除最旧匿名行。
2. 在写入路径检查 `probeDiskHealth`，低于阈值时拒绝匿名事件（503/507），而不是只让 health 变红。
3. 增加**全局**与**每 IP 每日**事件配额（当前只有每分钟），并对匿名事件使用更短保留期（例如 7 天）；90 天只保留认证用户或聚合结果。
4. 更彻底：匿名事件只写入聚合计数/短期窗口，不落原始行；或要求服务端签发的匿名凭证。
5. 为 `entities`/`entity_relations`/`search_queries` 同步加 caps（见 P1-1）。

### P0-2 NCM 侧车 `ENABLE_UNBLOCK` 透传（内容合规旁路）

**位置**
- `docker-compose.yml:16`：`ENABLE_UNBLOCK: "${SONIC_ENABLE_UNBLOCK:-false}"`
- `docker-compose.yml:62`：`SONIC_ENABLE_UNBLOCK: "${SONIC_ENABLE_UNBLOCK:-0}"`
- `Dockerfile.ncm:12`：`ENV ENABLE_UNBLOCK=false`
- `functions/_lib/sonic/licensing.ts`：`enableUnblock` 在代码中强制 `false`
- `functions/_lib/sonic/native-protocols.ts`：`resolveNeteaseSingleStream` 直接信任侧车 `/song/url/v1` 返回

**问题**：Sonic 代码自己的 `enableUnblock` 永远为 false，但 Compose 把同一个 `SONIC_ENABLE_UNBLOCK` 变量传给了 NCM 侧车。只要部署环境里该变量为 `1`（历史 env、复制粘贴、运维误操作），侧车可能开启 VIP unblock，而引擎会把它返回的完整 URL 当作普通完整流播放。代码层的“强制关闭”无法覆盖侧车，形成合规边界旁路。

**修复**
- Compose 中把侧车环境硬编码为 `ENABLE_UNBLOCK: "false"`，不再透传该变量；或完全不向侧车提供该变量。
- 启动时如果 `SONIC_ENABLE_UNBLOCK=1`、`SONIC_ENABLE_GDSTUDIO=1`、`SONIC_ENABLE_LYRIVA=1`，在生产 profile 直接 fail-fast（而不是静默忽略），并写入 health `reasons`。
- 发布检查中审计实际容器 env（`docker inspect`），确认侧车为 false；不要只信 `.env.example`。
- 侧车包目前 `npm install -g @neteasecloudmusicapienhanced/api@4.41.1` 无独立锁文件/镜像 digest；建议固定镜像 digest 或将依赖锁入镜像，降低供应链风险。

---

## 3. P1：建议冻结前修复或明确接受

### P1-1 `entities` / `entity_relations` 无上限增长

**位置**
- `server/recommend-sqlite.ts:172-211`（`entities`/`entity_relations` 表）
- `server/recommend-sqlite.ts:737-756`（`upsertEntity` 无总量检查）
- `functions/_lib/sonic/recommend/entity-store.ts:219-274`（`ingestVerifiedMvCatalog` 每次最多 100 条，但无全局 cap）
- `functions/_lib/sonic/recommend/memory-store.ts`（`entities`/`entityRelations` Map 无 cap）
- `functions/_lib/sonic/upstream.ts:108-119`（公开 `mv/*` 响应自动写入实体）

**问题**：公开 `mv/all`、`mv/first`、`mv/detail`、`simi/mv`、`top/mv`、`artist/mv`、`personalized/mv` 会在每次成功响应后写入实体；攻击者可变化 `offset`/`type`/`order`/MV ID 持续制造新实体。数据库有 canonical track 100k 上限，但 `entities` 没有；`pruneRetention` 也不清理 `entities`/`entity_relations`。Pages 内存 store 的 `entities` Map 同样无上限，Engine 不可用时可直接打 memory。实测 5,000 个实体约 +0.8 MB；规模随请求线性增长。

**修复**：为 `entities`/`entity_relations` 增加硬上限（例如 5 万/20 万）与最旧/最少使用淘汰；公开 MV 目录只在受信后台同步或认证请求中写入，普通用户只读；在 `pruneRetention` 中清理无引用/过期实体；health 增加 entityCount/DB 大小告警。

### P1-2 Provider/legacy 请求仍跟随重定向，NetEase 侧车请求携带 Cookie

**位置**
- `functions/_lib/music.ts:18-20`（`timedFetch` 直接 `fetchWithRuntimeBudget`，默认 follow）
- `functions/_lib/music.ts:1730+`（`fetchDirectNetEaseLyrics`/`crawl*` 直接请求供应商）
- `functions/_lib/sonic/providers/netease.ts:28-38`（`ncmApiUrl` 请求带 `NETEASE_COOKIE`，无 redirect 限制）
- `functions/_lib/sonic/providers/kugou.ts:102`（Kugou 搜索使用明文 HTTP）
- `functions/_lib/sonic/providers/{qq,amll,lrclib,lyriva,gdstudio}.ts`（直接 `fetchWithRuntimeBudget`，未统一使用 `fetchProviderUrl`）
- `functions/_lib/sonic/native-protocols.ts:47-129`（已有 `fetchProviderUrl`，但上述路径未使用）

**问题**：这些请求使用默认 `follow` 重定向；Node Engine 的网络位置可以访问内网/metadata。若供应商被攻破、发生开放重定向或明文 HTTP 被中间人注入，可形成 blind SSRF；NetEase 侧车请求还携带 `NETEASE_COOKIE`，跨源重定向时存在 Cookie 泄露风险。Cloudflare 侧私网出口通常受限，但 Linux Engine 仍是实际风险面。

**修复**：把 provider/legacy 请求统一到 `fetchProviderUrl` 或新的 `fetchProviderJson`：
- HTTPS-only、按适配器域名 allowlist、`redirect: 'manual'` 逐跳校验、跨 origin 删除 Cookie/Authorization/X-Real-IP；
- 对 `ncmApiUrl` 至少 `redirect: 'error'`，并限制为内网/回环/HTTPS 配置；
- 增加响应字节上限（建议 JSON 4–8 MB、歌词 4 MB）；
- 增加“provider 302 到 127.0.0.1/169.254.169.254 不发起第二次请求”的回归测试。

### P1-3 全局媒体代理并发槽可被 64 条慢流占满

**位置**
- `functions/_lib/sonic/security.ts:1033-1038`：`MAX_CONCURRENT_UPSTREAM_FETCHES=64`、`MAX_ACTIVE_UPSTREAM_BODIES=64`
- `functions/_lib/sonic/security.ts:1309+`（`safeFetch` 全局计数）
- `functions/api/music/stream.ts:305-321`（音频最长 256MB / 30 分钟）

**问题**：`safeFetch` 的并发/活动 body 槽是进程/isolate 全局的，audio、cover、palette、forward 共用。攻击者用 64 条慢速音频流即可占满 body 槽，后续所有 cover/stream/forward 请求返回 503；每 30 秒续读即可维持。匿名 240 req/min 足以建立并维持 64 条连接。Pages 多 isolate 可部分缓解，Engine 单进程更敏感。

**修复**：把媒体流与图片/JSON 代理拆成独立并发池；为每 IP/每匿名 subject 增加并发流上限（例如 2–4）；保留非流媒体槽位；或对可 CORS 的 NetEase 流优先使用 302 直连 CDN，减少代理占比。公测期必须在 WAF/网关层增加并发与带宽保护，并监控 `UPSTREAM_BUSY`。

### P1-4 `SONIC_ENGINE_IDENTITY_SECRET_PREV` 文档存在但代码未实现

**位置**
- `.env.example:14-16`：文档建议把旧 identity secret 放入 `_PREV`
- `functions/_lib/sonic/engine-identity.ts:38-43`：`secretFor()` 只读取 `SONIC_ENGINE_IDENTITY_SECRET`

**问题**：轮换 identity secret 时，若按文档先把旧值放 `_PREV` 再改 primary，代码不会接受旧值；Pages/Engine 滚动更新窗口内所有带身份的 Engine 调用会 503。`SONIC_ENGINE_SECRET_PREV` 与 `SONIC_SECRET_PREV` 都已实现，唯独 identity 没有。

**修复**：实现 identity 的 primary/previous 双 key 验签（旧 key 只验签、不签发），或删除 `_PREV` 文档并要求原子同步轮换；在健康检查中暴露 previous 是否存在但永不泄露值。

### P1-5 CORS 仍暴露 Engine/Staging 凭据头（上一次修复不完整）

**位置**
- `functions/_lib/http.ts:5-8`：`corsHeaders()` 仍包含 `X-Sonic-Engine-Key`、`X-Sonic-Staging-Token`
- `functions/proxy.ts:50-59`、`functions/palette.ts:465-475`：`Access-Control-Allow-Headers: *`
- `functions/_lib/sonic/route-helpers.ts:95`：该路径已移除上述头（说明修复只覆盖了一部分）

**问题**：上一次提交 `631f8da` 的说明声称移除 `X-Sonic-Engine-Key`，但主要 JSON 响应路径 `corsHeaders()` 和 legacy `/proxy`、`/palette` 的 `*` 仍允许这些头。攻击者页面可对 invite/engine 端点发起带猜测头的跨源请求并读取 401/200 差异，形成浏览器侧 oracle；虽然引擎 secret 要求 ≥32 字符、staging token 要求 ≥16 字符，实际爆破难度取决于熵，但这是与提交声明不一致的硬化缺口。`X-Shijianus-Device-Id` 当前未被后端使用，也可移除。

**修复**：从所有 CORS allowlist 删除 `X-Sonic-Engine-Key`、`X-Sonic-Staging-Token`、未使用的设备头；禁止 `/proxy`/`/palette` 的 `*`；对 staging/engine key 失败增加独立低额度限流；增加 OPTIONS 回归测试。

### P1-6 Cookie 名称缺少 `__Host-` 前缀

**位置**
- `functions/_lib/auth.ts:12`：`sonic_session`
- `functions/_lib/sonic/access.ts:11`：`sonic_access`
- `functions/_lib/sonic/security.ts:143`：`sonic_staging_access`

**问题**：三个 Cookie 都是 `Path=/; Secure` 且无 `Domain`，但没有 `__Host-` 前缀。若部署域下存在任何不可信/可被接管的子域，子域可设置 `Domain=.epocanvas.tech` 的同名 Cookie，与 host-only Cookie 竞争；`readCookie` 取第一个匹配项，可能发生会话固定/登出混淆。公测若只有主域和受信子域，风险可控，但应在冻结前决定是否收紧。

**修复**：改用 `__Host-sonic_session`、`__Host-sonic_access`（`Path=/`、`Secure`、无 `Domain`），保留旧名读取一个迁移窗口，或在公测前统一强制重新登录；同时盘点 `epocanvas.tech/.com` 下所有子域归属。OAuth state/verifier 因 Path 限制不能使用 `__Host-`，保持现有 Path 即可。

### P1-7 流/歌词缓存未绑定内容策略与环境

**位置**
- `functions/_lib/sonic/native-protocols.ts:1012-1025`（`buildStreamCacheIdentifier` 只含 source/id/quality/title/artist/trial/duration）
- `functions/_lib/sonic/cache.ts:44-49`（缓存 key 无 env/release 前缀）
- `functions/api/sonic/forward.ts`、`functions/api/sonic/lyrics/nexus.ts`（歌词缓存为 public TTL）

**问题**
1. 关闭某个 `SONIC_ALLOWED_SOURCES` 后，`stream-url-v1` 的旧缓存仍可在 TTL 内命中；`source=sonic` 在 netease 被关闭但其他源开启时仍可映射到 netease 并命中旧缓存，造成策略与缓存不一致。
2. 如果 staging/production 共用同一个 KV namespace，`sonic:` key 无环境前缀，缓存数据可能跨环境串用（特别是 Signed URL / synthetic 测试数据）。

**修复**：在 stream/lyrics 缓存标识中加入内容策略 epoch（policy mode + sorted allowed sources + enable flags 的哈希）或使用版本化命名空间 `stream-url-v2:<policyHash>`；缓存 hit 前再次执行 source policy；KV 按环境独立绑定或在 key 前加 `SONIC_ENV`/releaseId。策略变更时主动失效/提升 cache namespace 版本。

### P1-8 `SONIC_REQUIRE_AUTH=1` 与 invite 模式互锁

**位置**
- `functions/_lib/sonic/security.ts:414-432`（匿名请求在 `verifyAuth` 失败且 `SONIC_REQUIRE_AUTH=1` 时返回 `auth-gate`）
- `functions/api/access/invite.ts:47`、`functions/api/access/session.ts:17`（使用 `evaluateGatewayRateLimit`）

**问题**：如果同时设置 `SONIC_REQUIRE_AUTH=1` 与 `SONIC_ACCESS_MODE=invite`，匿名访客在调用 `/api/access/session` 或 `POST /api/access/invite` 时会在限流阶段收到 401 `AUTH_REQUIRED`，无法查看/兑换邀请。`requireAccess` 虽把 access 生命周期列为 public，但限流层没有豁免。

**修复**：给 `evaluateGatewayRateLimit` 增加 `allowAnonymous`/`skipAuthGate` 选项，access invite/session/logout 使用独立 limiter（例如 `evaluateAuthRateLimit` 或匿名 IP 30/min）；增加 invite + require-auth 组合回归测试。公测若固定 `SONIC_REQUIRE_AUTH=0`，可仅记录为配置约束。

---

## 4. P2：建议公测前或公测首周修复

| ID | 问题 | 证据/影响 | 建议 |
| --- | --- | --- | --- |
| P2-1 | `/api/music/lyric` 在 `nocache`/`_t` 下仍写缓存，且 cache key 包含这些参数 | `functions/api/music/lyric.ts:35-45,146-155`；每个 `_t` 唯一值都会 `cache.put`，可污染/塞满 Edge Cache；`bypassCache` 只跳过读 | 删除 `nocache`/`_t` 后再生成 key，并在 `bypassCache` 时跳过 put |
| P2-2 | `/api/palette` 缓存 key 含任意查询参数 | `functions/palette.ts:537-546,641-646`；`?x=随机` 可无限制造缓存条目 | key 只使用规范化 image URL + 版本；忽略其余参数 |
| P2-3 | `GET /api/auth/key` 对 Cookie 会话返回完整 bearer key | `functions/api/auth/key.ts:124-138`；一旦同源 XSS，30 天 key 可被导出，绕过 HttpOnly | GET 也要求显式 header 凭据，或只返回元数据；key 材料仅 POST |
| P2-4 | Palette 对 16MP JPEG 全量解码 | `functions/palette.ts:16-20,351-371`；RGBA 约 64MB，外加源图/解码器，Workers 128MB 下可 OOM | 将像素上限降至 4MP/边长 6000，优先使用 `cf.image` 结果；Node 端加内存预算 |
| P2-5 | Provider JSON/歌词响应无字节上限 | `fetchWithRuntimeBudget().json()` 在多处使用；供应商异常/恶意可造成内存/CPU 峰值 | 统一 `readBoundedJson(4–8MB)`，超限拒绝并记录 |
| P2-6 | Recommend DB 文件权限/类型校验缺失 | `server/recommend-sqlite.ts:45-53` 未 `chmod 0600`、未校验 `application_id`、未拒绝 symlink；事件含查询/行为数据 | 创建/打开后 `chmod 0600`，目录 0700；校验 app id/user_version/regular file；WAL/SHM 权限同步 |
| P2-7 | SQLite 未启用 `foreign_keys=ON` | `server/recommend-sqlite.ts:62-67`；当前显式删除贡献行，但未来新增删除路径可能留孤儿 | 启动 `PRAGMA foreign_keys=ON`，并补级联删除测试 |
| P2-8 | Gorse/Meilisearch 允许任意 HTTP + 部分 fetch 跟随重定向 | `external-adapters.ts:11-21,49,111,180,208`；API key 可能明文/被重定向泄露 | 非 localhost 强制 HTTPS；统一 `redirect:'error'`；响应限长 |
| P2-9 | OAuth token/userinfo 请求默认跟随重定向 | `functions/_lib/auth.ts:324-333,370-377`；恶意/错误 token endpoint 的 307 可把 client_secret/access_token 发到其他源 | `redirect:'error'`，或手工校验每个跳转的 origin |
| P2-10 | 多处 provider 错误原文进入日志/响应 attempts | `music/search`、`lyrics/nexus`、`nexus-lyrics`、`native-protocols` 等 `err?.message` 未统一 redact | 统一 `redactSensitiveString`；限制 attempts 条数/长度 |
| P2-11 | TTML 元数据未完整转义 | `functions/_lib/music.ts:1666-1667` 只转义 `&`；标题含 `<` 可破坏 XML/被下游 XML 解析器利用 | 使用与 `utils.escapeXml` 一致的 `<>&"'` 转义 |
| P2-12 | Pages 上 `/api/access/status`、`/api/access/redeem` 实际 404 | `requireAccess` 把两者列为 public，但 `functions/` 无对应路由；Engine dispatcher 才有别名 | 增加别名文件或从 public list/文档删除，避免客户端误用 |
| P2-13 | `testAlertBuckets` 上限只在创建时清理过期项 | `functions/api/sonic/engine/metrics.ts:21-35`；全活跃时可超过 256 | 使用固定窗口/溢出桶，严格限制 Map 大小 |
| P2-14 | Staging token 失败无独立限流 | `checkStagingAccessGate` 在限流前执行；浏览器侧可通过 CORS 头猜测 16 字符 token | 对失败按 IP 10/min 限流；优先禁用 legacy staging token，只用 invite |
| P2-15 | Docker 无资源/日志限制；NCM 侧车依赖未锁 | `docker-compose.yml` 无 `mem_limit/cpus/pids_limit`；`Dockerfile.ncm:7` 全局 npm install | 为公测加内存/CPU/pids 限制与日志轮转；固定侧车镜像 digest/锁文件 |
| P2-16 | 公开仓库内保留 `reports/archived/*.bundle` 与历史报告 | `reports/archived/cfsolara-audit-fixes.bundle` 可含历史源码；仓库为公开仓库 | 冻结前跑 gitleaks/trufflehog 全历史扫描；如无保留价值，移除大体积归档并确认无凭据 |
| P2-17 | `Access-Control-Allow-Origin: *` 出现在带 Cookie 的 READ 端点 | 无 `Access-Control-Allow-Credentials`，浏览器不会让跨站页面读取带凭据响应；不等于 CSRF 漏洞 | 可保留，但建议对 `/api/auth/*`、`/api/account/*`、`/api/sonic/events` 改为同源/白名单 origin，减少误配空间 |

---

## 5. 已确认无需修改/可接受

| 项 | 说明 |
| --- | --- |
| `SONIC_ACCESS_MODE=open` 默认 | 公测公开模式的设计选择；生产必须显式设置，部署脚本已强制。若改为 invite，必须显式改 env 并完成邀请链路验收 |
| Pages-only invite 不可撤销/可重复兑换 | 文档已披露；需要单次/撤销必须用 Engine SQLite。公测 open 模式不受影响 |
| 匿名事件 Sybil 影响热度 | 已有文档残余项；P0-1 修复存储预算后仍建议产品层决定是否只让认证用户参与全局聚合 |
| 全局熔断器 | 按 engine URL 共享，4xx/502 投毒已关闭；按路由组拆分可作为后续优化 |
| `Access-Control-Allow-Origin: *` 本身 | 无 ACAC 时不构成带凭据跨站读取；真正的写保护由严格同源 CSRF 校验承担 |
| `RATE_LIMITER`/`SONIC_KEY_REVOCATION_KV` 未绑定 | 代码会 fail-closed/降级；属于部署必配项，不是代码漏洞，但公测前必须绑定 |

---

## 6. 冻结/上线门禁清单

### 6.1 代码与构建

- [ ] 完成 P0-1（存储预算/行数 cap/写入前磁盘检查）与 P0-2（侧车硬禁 unblock）。
- [ ] 完成 P1-1（实体 cap）、P1-2（provider fetch 统一）、P1-5（CORS 头清理）；P1-4 实现或改为原子轮换文档。
- [ ] 为以上修复补回归：事件/实体超限、磁盘低于阈值拒写、provider 302 到内网、OPTIONS 不含 engine/staging 头、invite+require-auth、缓存 key 不含 `_t`、palette 像素上限。
- [ ] `npm run typecheck && npm test && npm run lint && npm run build && npm run build:engine && npm run verify:pages-deploy` 全 exit 0。
- [ ] `git status` clean；`dist/release.json` 的 `baseCommit` 等于冻结 SHA、`dirty=false`、`sourceDigest` 记录。
- [ ] `npm audit --omit=dev --audit-level=high` 与 Player `audit --prod` 无 high/critical。
- [ ] 全历史 secret 扫描（gitleaks/trufflehog）；确认 `.env*`、reports、bundle 无真实凭据。

### 6.2 Pages / Engine 环境

- [ ] `SONIC_ENV=production`、`SONIC_ACCESS_MODE=open|invite`（显式，不用默认）。
- [ ] `SONIC_CONTENT_POLICY=strict-allowlist`、`SONIC_ALLOWED_SOURCES` 非空且仅 APPROVED。
- [ ] `SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT=1` 且 Pages 已绑定原生 `RATE_LIMITER`；health `rateLimit.productionCompliant=true`。
- [ ] `SONIC_KEY_REVOCATION_KV` 已绑定、`SONIC_ENABLE_KEY_REVOCATION=1`（否则明确接受旧 key 30 天有效）。
- [ ] `SONIC_SECRET`、`SONIC_ENGINE_SECRET`、`SONIC_ENGINE_IDENTITY_SECRET`、`SONIC_ACCESS_SECRET` 均 ≥32 且互不复用；`_PREV` 轮换策略与实际代码一致（identity `_PREV` 当前不支持）。
- [ ] `SONIC_ENABLE_UNBLOCK=0` **且** `docker inspect` 确认 ncm-api `ENABLE_UNBLOCK=false`；`SONIC_ENABLE_GDSTUDIO/LYRIVA=0`。
- [ ] 不配置 VIP/付费平台 Cookie（`NETEASE_COOKIE` 等为空），或由项目方书面确认其使用边界。
- [ ] `SONIC_REAL_IP` 为真实出口 IP；`EPOMAIL_REDIRECT_URI` 与主域一致；多域场景不要设置单一固定回调。
- [ ] Pages 未设置 `SONIC_RUNTIME=linux-engine`；Engine Compose 保持 `linux-engine`。
- [ ] 若 `SONIC_REQUIRE_AUTH=1`，必须已修复 P1-8 或确认不使用 invite/access/session。
- [ ] `SONIC_RECOMMEND_DB_PATH`/`ACCOUNT_DB_PATH`/`ACCESS_DB_PATH` 使用独立持久卷；文件权限 600；备份完成。
- [ ] 为 recommend DB 设定磁盘/行数预算（P0-1），并在监控中配置 70%/85% 告警。
- [ ] 为公测配置容器内存/CPU/pids 限制与日志轮转；Cloudflare WAF/速率限制与带宽告警。

### 6.3 部署后真实 HTTP

- [ ] `/release.json`、`X-Sonic-Release`、`health.release` 与冻结 manifest 完全一致，`dirty=false`。
- [ ] 匿名 `/api/sonic/engine/health`、`/API/...`、`/Api/...` 均 401/403；invite 模式业务 API 大小写变体均 401/403。
- [ ] 带 Engine Key 的 health `ok=true`，`contentPolicy.ok=true`，`access.ok=true`，`rateLimit.productionCompliant=true`。
- [ ] `verify:deployed` 通过；OAuth 登录/回调/退出/撤销真实账号通过；真实 CDN Range/206/Seek 通过。
- [ ] 事件刷量：单 IP 超过 4,000 events/min 返回 429；DB 大小/行数未超预算；低于磁盘阈值时匿名事件被拒绝。
- [ ] 关闭一个音源后，旧 stream/lyrics 缓存不再返回该源内容（P1-7）。
- [ ] 跨站 `POST /api/auth/logout`、`/api/access/logout` 403；跨站 account/events 写 403。
- [ ] 回滚：按 RUNBOOK 演练一次，确认上一镜像 + 匹配 DB 快照可恢复。

---

## 7. 残余风险（需产品/运维签字）

1. **匿名事件污染热度**：即使修复磁盘预算，轮换 IP + 匿名 ID 的 Sybil 仍可影响 trending/共现；彻底方案是认证用户才参与全局聚合或服务端签发匿名凭证。
2. **Pages-only invite**：签名会话可重复兑换且不可服务端撤销；只适合短 TTL 受控内测，公测 open 或 Engine DB 不受影响。
3. **RATE_LIMITER/KV 依赖 Cloudflare 控制台**：仓库没有自动创建绑定；漏配时生产会 fail-closed 503，必须在部署前人工确认。
4. **真实 OAuth/CDN/NCM 侧车**：本轮只能验证代码/测试/本地 Worker；真实供应商、真实 OAuth、真实 CDN Range 和侧车行为仍需 staging 证据。
5. **NCM 侧车供应链**：全局 npm 安装、无独立传递依赖锁；公测前应固定镜像 digest 或锁文件。
6. **公测开放模式的带宽/滥用**：匿名 240 req/min + 媒体代理 256MB/请求，需要 WAF/带宽告警与并发限制；否则可能产生高额流量或上游封禁。

---

## 8. 建议修复顺序与验证

| 顺序 | 内容 | 预估 | 验收 |
| --- | --- | --- | --- |
| 1 | P0-1 事件/DB 预算 | 2–4h | 超限 429/507、磁盘低于阈值拒写、DB 不超预算；20k events 回归 |
| 2 | P0-2 侧车 unblock 硬禁 | 0.5h | compose inspect false；`SONIC_ENABLE_UNBLOCK=1` 启动 fail-fast |
| 3 | P1-1 实体/关系 cap | 1–2h | 公开 mv 目录无法无限增长；内存/磁盘有界 |
| 4 | P1-2 统一 provider fetch | 2–4h | 302 到 127.0.0.1/169.254 不发起第二跳；Cookie 跨源剥离；响应限长 |
| 5 | P1-5 CORS 清理 | 0.5h | OPTIONS 不含 engine/staging；`/proxy`/`/palette` 不用 `*` |
| 6 | P1-3 媒体并发配额 | 1–2h | 单 IP 慢流不能占满全部槽；非流媒体仍可用 |
| 7 | P1-4 identity 轮换 | 1h | primary/previous 双验签或文档改为原子轮换 |
| 8 | P1-6 Cookie 前缀 | 1–2h | 旧会话迁移/重登；子域无法覆盖 `__Host-` |
| 9 | P1-7 缓存 policy/env | 1–2h | 关闭音源后缓存不越权；staging/prod 不串缓存 |
| 10 | P1-8 require-auth/invite | 0.5h | invite 兑换在 require-auth=1 下仍可达 |
| 11 | P2 批次 | 1d | 逐项回归 + 配置/权限/日志 |

---

## 9. 本轮审计命令与证据摘要

```text
npm run typecheck                         exit 0
npm test                                  exit 0
  jiti: gateway 90 / auth 43 / cover 15 / engine 52 = 200
  vitest security: 13 files / 202 tests
  vitest beta:     18 files / 263 tests
npm run lint                              exit 0
npm run build                             exit 0; dist/release.json dirty=false
npm run build:engine                      exit 0
npm run verify:pages-deploy               exit 0
npm audit --omit=dev --audit-level=high  0 vulnerabilities
pnpm --dir player audit --prod           0 vulnerabilities
```

本地 `wrangler pages dev` 探测（invite 模式）：
- `/api/...`、`/API/...`、`/Api/...` → 401
- `/api%2Fsonic%2F...`、`/%61pi/...`、`/palette/../api/...`、`/foo/../api/...` → 401
- `/api%252F...`、`/palette/..%2Fapi/...`、`//api/...` → SPA HTML，无 API 数据
- 跨站 `POST /api/auth/logout`、`/api/access/logout` → 403
- `POST /api/auth/logout` 同源 → 5 条独立 `Set-Cookie`，中间件未合并破坏

临时 SQLite 吞吐探测：
- 20,000 条事件 → 4,255,744 bytes（约 213 B/event）
- 5,000 个 MV 实体 → +0.8 MB，无总量上限

---

## 10. 结论

当前代码的**认证/授权主链路**质量较高：路径规范化、Engine 服务密钥、OAuth state/PKCE、API Key v2、CSRF、SSRF 媒体白名单、内容 strict-allowlist、熔断与测试门禁都经过了本轮复核，未发现可直接接管账户或执行代码的零日。

但公测是**开放写/开放代理**场景，当前最现实的风险从“认证绕过”转向“匿名资源耗尽与配置合规”：
- **P0-1 事件/实体无界写入**可在数天内耗尽 VPS 磁盘；
- **P0-2 NCM 侧车 unblock 透传**可能让公测突破 VIP 内容边界；
- **P1-2 provider 重定向**仍是内网 SSRF/Cookie 泄露的残余面；
- 其余 P1/P2 属于会话固定、缓存越权/污染、CORS、日志与运维硬化。

**冻结建议：先完成 P0-1/P0-2 与 P1-1/P1-2/P1-5，按 §6 全门禁验收后再开公测；未完成时至少设置 DB 预算/每日事件配额、硬禁侧车 unblock，并把其余项列为已知风险。**

---

## 11. 修复实施记录（2026-11-07）

以下 P0/P1 已在本分支落地并通过回归；各项均有自动化测试锁定（`tests/beta-freeze-hardening.test.ts`，30 项）。

| 项 | 状态 | 实施摘要 |
| --- | --- | --- |
| P0-1 | ✅ 已修复 | SQLite 启动设置 `PRAGMA max_page_count`（`SONIC_RECOMMEND_DB_MAX_BYTES`，默认 1 GiB）；`SQLITE_FULL` 映射为 `RecommendStoreBudgetExceededError` → 网关 507；匿名事件/反馈行数硬上限（可配 `SONIC_RECOMMEND_MAX_EVENT_ROWS`/`_MAX_FEEDBACK_ROWS`），淘汰最旧行；匿名主体独立短保留期（`SONIC_ANON_EVENT_RETENTION_DAYS`，默认 7 天）；事件路由写入前磁盘预算检查（Engine 507）；新增每 IP/每 subject UTC 日配额（`SONIC_EVENTS_DAILY_PER_IP=200000`/`_PER_SUBJECT=50000`） |
| P0-2 | ✅ 已修复 | `docker-compose.yml` 侧车 `ENABLE_UNBLOCK: "false"` 硬编码，不再透传 `SONIC_ENABLE_UNBLOCK`；Engine 生产启动 fail-fast 拒绝 `SONIC_ENABLE_UNBLOCK/GDSTUDIO/LYRIVA=1`；`.env.example` 注明需 `docker inspect` 复核 |
| P1-1 | ✅ 已修复 | `entities`/`entity_relations` 硬上限（默认 5 万/20 万，可配），SQLite 与 Pages 内存 store 均有淘汰；`pruneRetention` 增加实体过期清理与孤儿关系回收（仅按 parent 判孤儿，child 允许指向 canonical track） |
| P1-2 | ✅ 已修复 | 新建无依赖叶子模块 `functions/_lib/sonic/provider-fetch.ts`（HTTPS-only + 域名族白名单 + 逐跳 manual redirect + 跨源剥 Cookie + `readBoundedProviderJson` 8MB 限长）；全部 provider 适配器（netease/qq/kugou/amll/lrclib/lyriva）与 legacy `music.ts` `timedFetch` 统一接入；NCM 侧车请求 `redirect:'error'`；Kugou 明文 HTTP 全部升级 HTTPS；回归验证 302 → 169.254.169.254 不发起第二跳 |
| P1-3 | ✅ 已修复 | safeFetch 拆分为 media(48)/json(16) 独立并发与 body 槽池；stream/forward(audio) 使用 media 池；新增每 IP 并发音频流上限 4，槽位仅随真实音频响应体生命周期获取/释放（策略拒绝、解析失败不占槽） |
| P1-4 | ✅ 已修复 | `SONIC_ENGINE_IDENTITY_SECRET_PREV` 实现：旧 key 仅验签、不签发；`getEngineIdentityReadiness` 暴露 `previousConfigured`（不泄露值）；拒绝与其它服务密钥复用 |
| P1-5 | ✅ 已修复 | `corsHeaders()` 与 `/proxy`、`/palette` OPTIONS 的 allowlist 移除 `X-Sonic-Engine-Key`/`X-Sonic-Staging-Token`/`X-Shijianus-Device-Id`，`*` 全部替换为显式列表 |
| P1-6 | ✅ 已修复 | `sonic_session`/`sonic_access`/`sonic_staging_access` 在 Secure 源写 `__Host-` 前缀名；读取双名（前缀优先）迁移窗口；登出/撤销以独立 Set-Cookie 头清除双名；observability 脱敏与 engine-identity 探测正则同步覆盖前缀名 |
| P1-7 | ✅ 已修复 | 流缓存标识加入内容策略 epoch（`computeContentPolicyEpoch`：policy mode + enabled sources + flags）；缓存命中前按当前策略复核 source；全部缓存 key 加 `SONIC_ENV` 环境前缀（`sonic:<env>:<ns>:...`），staging/prod 不串缓存 |
| P1-8 | ✅ 已修复 | `evaluateGatewayRateLimit` 增加 `allowAnonymous` 选项；`/api/access/invite`、`/api/access/session` 匿名可达（仍走匿名限流桶），invite 兑换在 `SONIC_REQUIRE_AUTH=1` 下不再 401 |
| P2-7 | ✅ 顺手 | `PRAGMA foreign_keys=ON`（迁移重建表期间临时关闭，防 CASCADE 误删贡献行） |
| P2-9 | ✅ 顺手 | OAuth token/userinfo 请求 `redirect:'error'`，30x 不再重放 client_secret/bearer |
| P2-11 | ✅ 顺手 | TTML `ttm:title`/`ttm:agent` 使用完整 `<>&"'` 转义 |
| P2-15 | ✅ 顺手 | Compose 增加内存/CPU/pids 限制与日志轮转（侧车 512m/1cpu/128pids，Engine 1g/2cpu/256pids） |
| P2-3 | ✅ 已修复 | `GET /api/auth/key` 对 Cookie 会话只返回元数据（`keyMaterial:false`）；key 原文仅对显式 header 凭据返回，同源 XSS 无法再导出 30 天 bearer key |
| P2-6 | ✅ 已修复 | SQLite 打开前校验 regular file/拒绝 symlink；非 win32 上对 DB、WAL/SHM 侧车 `chmod 0600`、数据目录 `0700`（best-effort，只读卷不阻断启动） |
| P2-10 | ✅ 已修复 | `music/search`、`lyrics/nexus`、`nexus-search`、`native-protocols`（attempts/error 文案）全部经 `redactSensitiveString` 后再进入响应与日志 |
| P2-14 | ✅ 已修复 | staging token 独立失败预算：每 IP 10 次/分钟，10 次后返回 429 + Retry-After；成功即重置；有界 Map |
| P2-1/2/4/8/12/13 | ✅ 前批已在位 | 经复核确认 `631f8da` 已含：lyric 缓存键剥离 `nocache/_t` 且 bypass 跳过 put；palette 规范化缓存键；4MP/6000px 像素上限；Gorse/Meili 非 loopback 强制 HTTPS + `redirect:'error'`；Pages `/api/access/status`、`/redeem` 路由存在；metrics 告警桶硬上限 |

**未在本批处理的项**：P2-16（公开仓库历史 bundle/gitleaks 全历史扫描，属运维扫描动作）与 P2-17（`Access-Control-Allow-Origin:*` 带 READ 端点，报告 §5 已判定不构成漏洞）按授权放行；P2-5（供应商响应限长）已部分收敛（eapi/linuxapi/侧车歌词/provider-fetch 路径均限 8MB），其余 `.json()` 调用点留待后续统一。§7 残余风险（Sybil、Pages-only invite、RATE_LIMITER 绑定、真实供应商/侧车 staging 验证、WAF/带宽）仍需产品/运维签字。

**验证（2026-11-07，修复后）**：`npm test` exit 0（jiti 200：gateway 90/auth 43/cover 15/engine 52；vitest security 14 files/232 tests；vitest beta 18 files/264 tests）；`typecheck`/`lint`/`build`/`build:engine`/`verify:pages-deploy` 均 exit 0；`npm audit --omit=dev --audit-level=high` 0 漏洞。构建 manifest 因工作树未提交为 `dirty=true`（`releaseId=631f8da4…-eec95226…`）；按门禁要求，提交本批修复并按新 HEAD 重新生成 `dist/release.json` 后再执行部署。

# Sonic 全面核验与整改记录（2026-10-28）

> 本文件以实际代码、实际命令输出为准。未执行的测试会明确标注，不以推断代替结果。
>
> **本轮结束状态（2026-10-28）**：改动均在当前工作区，未提交/未推送；最新验证见第 3 节。

## 0. 基线与仓库信息

| 项目 | 值 |
|---|---|
| 分支 | `security/audit-round-2026-10` |
| 基线 commit | `259e41102c158d8209b95477569b15481615ac2f` |
| 项目版本 | `sonic@2.2.0` |
| Node.js | `v24.14.0`（项目声明 Node >= 22） |
| npm | `11.9.0` |
| pnpm | `10.34.5` |
| TypeScript | `5.9.3` |
| Docker / Compose | `29.1.2` / `v2.40.3-desktop.1` |
| 工作区初始状态 | clean，无未提交修改 |

### 基线命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过（exit 0） | `tsconfig.json` 当前 `strict: false` |
| `npm test` | 通过 | 4 个 jiti 脚本 + 5 个 Vitest 文件，Vitest 88 tests passed |
| `npm run test:security` | 通过 | 4 个文件，66 tests passed |
| `pnpm --dir player test` | 通过 | 7 个文件，33 tests passed |
| `npm run lint:theme` | **失败**（5 项既有违规） | `player/src/App.vue:42`、`player/src/components/Dialog/AddToPlaylistDialog.vue:94/96/150/156` |
| `npm audit --omit=dev` | 0 漏洞 | 根依赖生产面 |
| `pnpm --dir player audit --prod` | 存在中危/高危开发链告警 | 主要来自 `vite-plugin-svg-icons -> svg-baker -> postcss/micromatch` 构建期依赖，需逐项判断 |

### 旧审计发现核验结论（先核验，不假定）

| 旧发现 | 当前状态 | 证据 |
|---|---|---|
| API Key 仅解析邮箱、无签名 | **不成立**（已在 259e411 修复） | `functions/_lib/auth.ts` 实现 `sonic_live_v2` + HMAC-SHA256、iat/exp/jti/kid、轮换与撤销；负向测试存在 |
| 接受 URL 查询参数 `api_key` | **不成立** | `extractAuthCredentials` 只读请求头；`tests/security.test.ts` 覆盖 |
| OAuth 缺少 state | **不成立** | `login.ts` 生成 256-bit state，`callback.ts` 校验 cookie |
| OAuth 缺少 PKCE | **部分成立** | login 已生成 S256 challenge/verifier；但 callback 在 verifier cookie 缺失时会无 PKCE 继续交换，缺少 fail-closed |
| OAuth 会话通过 URL hash 泄露 API Key | **已确认（本次修复）** | `callback.ts` 将完整 session（含 apiKey）写入 `Location` 的 `#session=` |
| SSRF 仅字符串黑名单 | **不成立** | `security.ts` 有 IP 规范化、IPv4/IPv6 特殊段、域名白名单、重定向逐跳校验、大小上限 |
| 代理无内容类型/响应头限制 | **不成立** | `forward.ts`/`stream.ts`/`cover.ts` 均有类型与响应头白名单 |
| 限流可伪造 IP / 无身份分层 | **不成立** | `CF-Connecting-IP` + Node socket 覆盖、匿名/API Key/engine 分层 |
| Docker 依赖本地 `dist/` | **已确认（本次修复）** | `Dockerfile` 直接 `COPY dist ./dist`，干净克隆无该目录 |
| 构建脚本吞错 | **未发现** | `build`/`copy-dist` 失败会传播；未发现 `|| true` |
| CI 质量门禁 | **缺失** | 仓库无 `.github/` 工作流 |
| 许可证声明一致 | **已确认不一致** | 根 `LICENSE` 为 MIT，README badge/正文与 `player/package.json` 声称 CC BY-NC-SA |

## 1. 本次整改计划与状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 基线、核验、整改记录 | 已完成 |
| 1 | 认证与 API Key | 已完成（可选 KV 实时撤销已实现；生产 KV 绑定未实测） |
| 2 | OAuth state/PKCE/会话 | 已完成（真实 Epomail 联调待做） |
| 3 | SSRF 与外部请求 | 已完成（DNS rebinding 残余风险已记录） |
| 4 | 凭证入口/客户端 IP/限流 | 已完成（无原生 binding 时非严格全局限流） |
| 5 | 构建与 Docker | 部分完成：代码/干净构建/Compose 已验证；Docker 镜像构建受本机 daemon 限制未执行 |
| 6 | 类型/Lint/测试/CI | 已完成：根 + Player `vue-tsc` 均 0 错误，ESLint/主题/测试/CI 已配置 |
| 7 | 缓存/熔断/SQLite/日志 | 已完成（备份脚本已实测，生产恢复演练待做） |
| 8 | 配置/监控/部署 | 已完成文档与健康/日志；无内置指标 exporter |
| 9 | 许可证/依赖/SBOM | 部分完成：SBOM/依赖审计完成；许可证冲突待维护者裁决 |
| 10 | 文档与交付 | 已完成本轮可执行范围 |

> 后续每阶段完成后在此追加「修改内容 / 测试命令 / 结果 / 回归 / 剩余问题」。

## 2. 阶段记录

### 阶段 1：认证与 API Key

**修改内容**
- `functions/_lib/auth.ts`
  - `extractAuthCredentials` 增加凭据来源 `header | cookie`，请求头优先；Query 永不接受。
  - `verifyAuth` 返回值携带来源，供高风险接口做二次授权判断。
  - 角色收敛为 `user | developer | admin`，未知值降级为 `user`。
  - 新增可选 KV 实时撤销：`SONIC_KEY_REVOCATION_KV` + `SONIC_ENABLE_KEY_REVOCATION=1`；按 jti 写入 30 秒短缓存，其他 isolate 30 秒内传播；KV 读失败默认 fail-closed（可配置 `SONIC_KEY_REVOCATION_FAIL_CLOSED=0`）。
  - OAuth 配置强制 HTTPS（localhost 开发例外），拒绝 userinfo/query/hash 形式的服务地址。
  - Token 交换与 userinfo 增加超时，校验 `access_token` 形状，拒绝 `email_verified=false`。
- `functions/api/auth/key.ts`
  - `POST /api/auth/key` 必须通过显式 `X-Sonic-Key` / `Authorization` 请求头认证；仅凭 Cookie 返回 `403 REAUTH_REQUIRED`。
  - 重新签发时同步刷新 `sonic_session` Cookie。
  - 增加网关限流与 `Cache-Control: no-store`。
- `functions/api/auth/user.ts`：只返回资料，不再返回 bearer key；增加 no-store。
- `functions/api/auth/logout.ts`（新增）：清除 `sonic_session` 与 OAuth 事务 Cookie；拒绝跨站 POST；KV 撤销启用时同时撤销当前 jti。
- `functions/api/auth/revoke.ts`（新增）：`POST /api/auth/revoke` 必须显式请求头认证；无 KV 时返回 501，不伪装撤销成功。
- `functions/api/auth/key.ts`：配置 KV 撤销存储时，`POST /api/auth/key` 轮换会撤销旧 jti；撤销失败则不返回新 Key。
- `server/index.ts`：注册 logout 路由；修复 Node `Set-Cookie` 多条被覆盖的问题；增加请求 ID 与脱敏访问日志。
- `js/index.js` / `player/src/stores/modules/recommend.ts`：前端不再从 URL hash 解析 API Key，不再持久化/读取 `sonic_api_key`；登录后通过 Cookie 会话调用 API。

**验证**
- `npm run test:security`：新增 OAuth/API Key 用例全部通过。
- `tests/security.test.ts` 原有的伪造、篡改、过期、未知 kid、撤销、缺 Secret 用例继续通过。
- 新增 `tests/oauth-security.test.ts` 覆盖：Cookie 认证、Cookie 单独重签发拒绝、刷新 Cookie、登出清 Cookie、跨站写拒绝、key 端点不再返回在 user 资料中。
- 新增 5 项实时撤销测试：jti 撤销跨冷缓存、轮换撤销旧 Key、登出撤销当前 jti、无 KV 返回 501、KV 读失败 fail-closed。

**剩余问题**
- 实时撤销是可选的，需要 Cloudflare KV；未配置 KV 的 Node/自托管环境仍只能使用 `SONIC_REVOKED_JTIS` + 重新部署。
- 跨 isolate 撤销传播窗口为 30 秒；KV 读失败默认 fail-closed，可能影响可用性，需运维按业务选择。
- `GET /api/auth/key` 会按需把 Key 返回给同源 JS；XSS 仍可读取，Cookie 只消除了 URL/持久化泄露面。

### 阶段 2：OAuth 2.0

**修改内容**
- `functions/api/auth/login.ts`
  - 强制校验 OAuth 配置；state 256-bit + PKCE S256；事务 Cookie 使用 `HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600`，Secure 默认开启（localhost HTTP 例外）。
  - 增加 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。
- `functions/api/auth/callback.ts`
  - 强制 state 格式、Cookie 匹配与常量时间比较；新增单 isolate state 重放缓存。
  - **强制 PKCE verifier**：缺失/格式错误直接失败，禁止降级为无 PKCE 交换。
  - 校验授权码长度/控制字符；清理 state/verifier Cookie。
  - 成功会话只通过 `sonic_session` HttpOnly Cookie 下发；重定向仅 `?auth=success`，**不再包含 API Key**。
  - 失败路径不签发会话，错误参数白名单化，日志截断。
- 新增 `tests/oauth-security.test.ts`（18 项，其中 13 项 OAuth、5 项实时撤销）：正常流程、缺失 state、错误 state、重放 state、缺失 PKCE、用户取消、`email_verified=false`、Token 交换字段断言、URL 不含 Key、Cookie 属性、会话可用性。

**结果**
- 全部通过；真实 Epomail 账户联调 **未执行**（缺少真实 OAuth 客户端），标记为待完成。

**剩余问题**
- state 重放缓存为单 isolate/进程内，跨 isolate 仍依赖授权码一次性语义。
- 未验证 Epomail 是否要求 `application/x-www-form-urlencoded` Token 请求；当前沿用项目原有的 JSON 请求格式，真实联调需确认。
- 未使用 `id_token` 做身份断言，身份来源是 TLS 下的 userinfo 端点；若未来改用 OIDC，需补 issuer/audience/nonce/签名校验。

### 阶段 3：SSRF 与外部请求

**修改内容**
- `functions/_lib/sonic/security.ts`
  - 修复 `timingSafeEqualStr` 的冗余非常量时间字符串比较。
  - 补充 IPv4-translated IPv6（`::ffff:0:a.b.c.d`）封禁。
  - `safeFetch` 统一剥离 Cookie、Authorization、`X-Api-Key`、转发 IP 头、Sonic 身份/上下文头；每次重定向重新校验；外部 AbortSignal 监听器清理；URL 长度上限 8192；响应体 30 秒空闲超时（不限制长音频总时长）。
- `functions/api/sonic/forward.ts` / `music/stream.ts` / `music/cover.ts` / `palette.ts` / `proxy.ts`
  - 非预期 Content-Type 时取消上游响应体。
  - TTML/LRC 响应补 `nosniff` + sandbox CSP。
  - GDStudio 上游改用 `safeFetch` 并限制查询参数白名单。
  - Kuwo 直链探测改用 `safeFetch`，不再裸 `fetch`。
- `functions/_lib/sonic/cache.ts`：缓存键整体 URI 编码，消除用户输入中 `:`/`=` 造成的键碰撞；内存缓存单值上限 512KB。

**验证**
- 新增 `tests/ssrf-security.test.ts`（9 项）：IPv4-translated、非 HTTP 协议、userinfo/端口、敏感头剥离、逐跳 DNS 校验、白名单外重定向、重定向循环、响应头超时 Abort、响应体空闲超时。
- 既有 `security-hardening.test.ts` 的重定向降级、响应体上限、HTML/SVG 拒绝继续通过。

**剩余问题**
- Workers 环境无法把 DNS 结果绑定到连接，DNS rebinding 只能依靠 HTTPS + 域名白名单限制。
- Node 引擎在 fetch 前解析并校验 DNS，但 fetch 会再次解析，存在 TOCTOU 理论窗口；受控白名单降低了可利用性，但不能宣称完全消除。

### 阶段 4：凭证入口、客户端 IP、限流

**核验结果**
- Query `?api_key=` 在代码与测试中均已禁用；`SONIC_ALLOW_QUERY_KEY` 不再存在。
- Node 适配器覆盖 `CF-Connecting-IP`，剥离 `X-Forwarded-*`/`Forwarded`/`X-Real-IP`；`X-Sonic-Client-IP` 仅在有效引擎密钥下信任。
- 限流分层：anonymous / api-key / engine；认证端点独立 30/min/IP；内存桶上限 4096，溢出共享桶避免逐出活跃用户。
- 新增 Cookie 认证写操作的同源校验（`Origin`/`Referer`/`Sec-Fetch-Site`），拒绝跨站写。

**测试**
- `tests/security.test.ts`、`security-p0-regression.test.ts`、`oauth-security.test.ts` 覆盖 IP 伪造、分层限流、Cookie CSRF、引擎密钥。
- 未绑定 Cloudflare `RATE_LIMITER` 时仍是近似限流，已在运维文档标注。

### 阶段 5：构建与 Docker

**修改内容**
- `Dockerfile` 重写为三阶段：
  1. `frontend`：pnpm 10.34.5 + `player/pnpm-lock.yaml` 冻结安装并构建 SPA；
  2. `engine`：从根 `package-lock.json` 执行 `npm ci`，再用锁定版本的 esbuild 打包 `server/index.ts`；
  3. `runtime`：仅复制 `dist/`、`dist-server/`、`LICENSE`、`THIRD_PARTY_NOTICES.md`，非 root `node` 用户运行。
- 健康检查改为 Node `fetch` 从环境变量读取密钥，不再把密钥放进进程参数。
- `CMD` 增加 `--experimental-sqlite`；默认监听地址在独立运行时改为 `127.0.0.1`（容器显式覆盖 `0.0.0.0`）。
- `.dockerignore` 增加 `dist`、`dist-server`、`data`、`reports`、临时目录等，防止把本地产物/数据带入构建。
- `docker-compose.yml` 增加 `init`、`no-new-privileges`、`cap_drop: ALL`、优雅停止；引擎端口仍仅绑定 `127.0.0.1`。
- 构建期依赖（Tailwind/PostCSS/Vite 插件等）从 `dependencies` 移入 `devDependencies`，生产依赖审计归零。

**验证**
- 干净目录（无 `node_modules`、`dist`、`dist-server`、`.git`）执行：
  - `npm ci` 通过；
  - `pnpm --dir player install --frozen-lockfile` 通过；
  - `npm run typecheck` 通过（根 + Player 0 错误）；
  - `npm run build` 通过（生成 `dist/index.html`）；
  - `npm run build:engine` 通过（生成 `dist-server/index.mjs`）。
- `docker compose config` 通过（使用临时 `.env`，验证后删除）。
- **Docker 镜像构建未执行**：本机 Docker Desktop Linux engine 未启动，且当前会话无权限启动 `com.docker.service`（`Start-Service` 返回 “Cannot open com.docker.service”）。已写入 GitHub Actions，仍需在具备 Docker 的环境实际跑通后勾选。
- 已用构建产物做本地运行时冒烟（Node 24 与 Node 22.13.0）：无密钥健康检查 401、带密钥 200、静态首页 200、访问日志不含查询参数。Node 22.13 实际启动打包后的 `dist-server/index.mjs` 成功。

### 阶段 6：类型、Lint、测试、CI

**修改内容**
- 新增根 `npm run lint`：主题令牌 lint + Player ESLint。
- 新增 `player/eslint.config.mjs`（ESLint 9 flat config），修复原 `.eslintrc.cjs` 在 ESLint 9 下无法启动的问题；`lint` 不再自动 `--fix`。
- `package.json` 增加 `engines.node >= 22.5`、`backup:db`、`sbom`、`lint` 脚本。
- 新增 `.github/workflows/ci.yml`：锁文件安装、根 typecheck、lint、安全测试、推荐测试、Player 测试、前端/引擎构建、根/Player 生产依赖审计、SBOM、Docker 构建与健康检查冒烟。
- CI 只纳入确定性测试；`test-sonic-gateway` / `test-cover-gateway` 的 jiti 套件依赖外部上游，未放入 CI，本地 `npm test` 已执行通过，但不能保证 CI 环境可重复。
- 修复 `player` 主题 Lint 的 5 个新增硬编码白色值，并收紧基线。
- 修复 Player 的 51 个历史 `vue-tsc` 错误：包括移动端歌词跟随引用错误字段/未绑定滚动函数、MiniPlayer i18n、three 类型解析、Axios 泛型、空值保护、未使用变量等；`tsconfig` 的 `types: ["vite,client"]` 拼写错误修正为 `vite/client`，模块解析改为 `bundler`，并将 `@types/three`/`@types/nprogress` 纳入开发依赖。
- `npm run typecheck` 现在同时执行 `tsc --noEmit` 与 `pnpm --dir player run typecheck`。

**结果**
- `npm run typecheck`：通过（根 0 错误；Player `vue-tsc` 0 错误）。
- `npm run lint`：通过（主题基线 430 项历史值；ESLint 0 error/0 warning）。
- `npm run test:security`：7 文件 95 tests passed。
- `npm test`：4 个 jiti 脚本（60+43+15+49）+ 8 个 Vitest 文件，Vitest 117 tests passed，exit 0。
- `pnpm --dir player test`：7 文件 33 tests passed。
- `npm audit --omit=dev`：0 漏洞。
- `pnpm --dir player audit --prod`：0 漏洞。
- `pnpm --dir player exec vue-tsc --noEmit`：通过（0 错误，已纳入根 typecheck 与 CI）。
- 浏览器冒烟（Vite dev + 内置浏览器）：首页与设置页正常渲染；控制台仅有本地无后端导致的 `/api/sonic/recommend/for-you` 404，以及既有 Vue 属性继承 warning；未发现新增运行时异常。移动端播放抽屉的歌词拖动/逐字跟随需要真实播放与移动视口，**未完整人工验证**。

### 阶段 7-8：缓存、熔断、数据库、日志、配置

**修改内容**
- 缓存键编码、内存单值上限；缓存仅写入成功/非空结果（核验既有调用链）。
- 熔断状态机核验：3 次失败或 52x/530 立即 OPEN、30s 冷却、HALF_OPEN 单探针、成功回 CLOSED；未发现需要改写的状态竞争。
- 新增 `scripts/backup-recommend-db.mjs` 与 `npm run backup:db`：`VACUUM INTO` + 重新打开副本 `PRAGMA integrity_check` + 统计行数；失败删除残件。
- 引擎退出时关闭 SQLite；增加 headers/request/keep-alive 超时；静态文件路径解析改为 `path.resolve` + 根前缀校验，拒绝反斜杠/空字节；新增 `tests/engine-static.test.ts` 验证路径穿越与 Node 多条 `Set-Cookie` 保留。
- 结构化访问日志：`requestId/method/path/status/durationMs`，不含查询串与凭证；健康端点增加进程 uptime/RSS。
- 配置解析：上游 URL 强制 HTTPS、拒绝 userinfo/query/hash；超时值与并发参数收敛范围。
- 新增 `docs/OPERATIONS.md`：部署、OAuth、密钥轮换/撤销、备份/恢复、回滚、监控、安全事件处置与残余风险。

**验证**
- 备份脚本在启用 WAL 的临时数据库上实测成功（`integrity_check ok`，输出 tracks/events 统计）。
- 本地引擎运行时冒烟通过（见阶段 5）。
- 真实生产数据库备份/恢复演练 **未执行**（无可用的生产数据副本）。

### 阶段 9-10：许可证、依赖、文档

**修改内容**
- 核验许可证冲突：根 `LICENSE` 与 `player/LICENSE` 均为 MIT；历史 README 与 `player/package.json` 声明 CC BY-NC-SA。**未擅自更换许可证**；将 `player/package.json` 对齐为 MIT，并在 README/`docs/COMPLIANCE.md` 披露冲突、声明裁决前以根 LICENSE 为准。
- 新增 `THIRD_PARTY_NOTICES.md`；新增 `scripts/generate-sbom.mjs` 与 `npm run sbom`，生成 `reports/sbom/sonic-player.cdx.json`（99 个生产依赖组件）。
- 更新 `README.md`、`API.md`、`.env.example`；历史安全报告加“已过时”说明。
- 新增本文件与 `docs/COMPLIANCE.md`、`docs/OPERATIONS.md`。

**验证**
- SBOM 生成成功：99 components；许可证复核项：GSAP 标准免费许可、一个通用 `BSD` 字段（需人工确认具体包）。
- `npm view @neteasecloudmusicapienhanced/api@4.41.1 license` → MIT。
- 构建期依赖仍有历史公告（`postcss`/`micromatch`/`decode-uri-component`），不进入运行时；未通过升级/替换来“清零”。

## 3. 最终验证汇总

| 检查 | 命令 | 结果 |
|---|---|---|
| 根 + Player 类型检查 | `npm run typecheck` | 通过（0 错误） |
| 主题 + ESLint | `npm run lint` | 通过 |
| 安全/OAuth/SSRF 回归 | `npm run test:security` | 95 passed |
| 完整测试 | `npm test` | 117 Vitest passed + 4 jiti suites (60+43+15+49)，exit 0 |
| Player 单元测试 | `pnpm --dir player test` | 33 passed |
| 根生产依赖审计 | `npm audit --omit=dev --audit-level=high` | 0 漏洞 |
| Player 生产依赖审计 | `pnpm --dir player audit --prod --audit-level=high` | 0 漏洞 |
| 干净目录构建 | 临时目录执行 `npm ci` + `pnpm install --frozen-lockfile` + `npm run typecheck` + `npm run build` + `npm run build:engine` | 通过 |
| Node 22.13 运行时 | `npx node@22.13.0 --experimental-sqlite dist-server/index.mjs` + 健康检查 | 通过（200/200） |
| Compose 配置 | `docker compose config` | 通过 |
| Docker 镜像构建 | `docker build` | **未执行**（daemon 不可用） |
| 真实 OAuth 联调 | 真实 Epomail 客户端 | **未执行** |
| 生产备份/恢复演练 | 生产数据 | **未执行** |

## 4. 剩余技术债与未完成事项（按优先级）

1. **Docker 镜像构建未实测**：本机 Docker daemon 不可用；CI 已配置，需在有 Docker 的环境确认。不要在当前状态宣称镜像已验证。
2. **真实 Epomail OAuth 联调**：state/PKCE/Cookie 逻辑有 Mock 测试，但 Token 端点请求格式、用户字段、取消授权行为需真实客户端确认。
3. **API Key 实时撤销**：已提供可选 KV 实现（`/api/auth/revoke`、轮换/登出联动）；但生产 KV 绑定、真实故障切换与多 isolate 传播尚未实测，无 KV 环境仍依赖环境变量 + 重新部署。
4. **限流全局一致性**：未绑定 Cloudflare 原生 `RATE_LIMITER` 时，KV/内存限流不是严格全局原子。
5. **DNS rebinding 残余风险**：Workers 无法固定 DNS；Node 端存在 fetch 二次解析的 TOCTOU 理论窗口。
6. **构建期依赖公告**：`vite-plugin-svg-icons` 的旧 postcss/micromatch 链仍需替换或隔离。
7. **许可证最终裁决**：根 LICENSE（MIT）与历史 CC BY-NC-SA 声明冲突，需维护者/法律顾问决定；当前未擅自更改根许可证。
8. **监控 exporter 缺失**：只有结构化日志、健康端点、限流/熔断响应头；未实现 Prometheus/OpenTelemetry。
9. **匿名事件存储滥用面**：opt-in 匿名 ID 由客户端生成，仍可能被用于有限度的存储消耗；已有 64KB 请求体、50 事件/请求和网关限流，但没有按匿名 ID 的硬配额。

## 5. 续接说明（如后续继续整改）

- 先读本文件与 `git status`；不要重复已完成阶段。
- 优先项：在可用 Docker 环境执行 `.github/workflows/ci.yml` 的 docker job；真实 OAuth 联调；生产 KV 撤销绑定演练。
- Player `vue-tsc --noEmit` 已纳入 `npm run typecheck` 与 CI；后续新增代码必须保持 0 错误，禁止用 `any`/关闭规则掩盖。
- 任何数据库结构变更必须先提供迁移与回滚脚本，并复用 `npm run backup:db` 做恢复演练。
- 许可证只能由维护者决定；不要在后续整改中单方面替换根 `LICENSE`。

# Sonic 全专案安全审计报告

- 审计日期：2026-10-28
- 审计对象：`shijianus/sonic`（工作副本 `D:\Users\Smart Kevin\OneDrive\Desktop\sonic`）
- 分支 / 基线提交：`feat/smart-reco` / `f8f1129 fix(deps): 补回 player 锁文件 overrides，修复冻结安装失败`
- 审计开始时工作区：干净（`git status --short` 无输出）
- 本次审计产生的变更：24 个修改文件 + 4 个新增代码/测试文件（另有本报告与修复摘要），**未提交**（遵守“不得擅自提交”的要求）
- 审计者角色：应用安全 / 全端 / DevSecOps 代码审计

> 说明：本报告只记录当前检出源码与真实执行结果。未在本机执行的检查（Docker 构建、线上黑盒扫描、Wrangler 发布）均明确标注为“未执行”，不视为通过。

---

## 1. 执行摘要

Sonic 是「Cloudflare Pages 边缘 Functions + Linux Node 22 本地协议引擎」的同构双层音乐聚合平台。项目已有较完整的安全基础设施：HMAC-SHA256 API Key、OAuth 2.0 + PKCE + state 校验、`X-Sonic-Engine-Key` 服务间认证、SSRF 域名/端口/IP 三重校验、`safeFetch` 逐跳重定向校验、分级限流、参数化 SQLite、隐私化匿名身份。

本次审计确认并修复了 **2 个 P1、10 个 P2、4 个 P3** 问题：

| 级别 | 已修复 | 未修复（已记录） |
| :--- | :--- | :--- |
| P0 | 0 | 0 |
| P1 | 2 | 0 |
| P2 | 10 | 1（API Key 生命周期设计） |
| P3 | 4 | 6（工程/供应链/残余风险） |

最关键的两个 P1 均为 **同源 XSS → API Key 窃取**：

1. **P1-A**：部署中的 Vue 卡片（`HeroCard`/`MVCard`）把第三方封面 URL 直接拼进 `innerHTML`；仓库内旧版播放器还会把第三方曲名/歌手拼进播放列表 `innerHTML`。攻击者只需让音乐平台元数据中出现含 `"` 的封面 URL 或 HTML 曲名，即可在 Sonic 源执行脚本，读取 `localStorage` 中的 `sonic_session`（含 HMAC API Key）。
2. **P1-B**：音频流 / 通用转发 / 封面 / 酷我代理会把上游 `Content-Type` 原样回传。由于 `y.qq.com`、`music.163.com` 等**整个注册域**都在允许列表内，任何返回 `text/html` 或 `image/svg+xml` 的允许域名 URL 都会被 Sonic 源以文档形式渲染，形成同源 XSS。已用本地 stub 上游复现并修复为 415 / 静态 SVG 兜底。

修复后最终状态（真实执行）：

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| TypeScript（Functions/Server） | `npm run typecheck` | 通过，exit 0 |
| 全量测试 | `npm test` | 通过，exit 0 |
| Vitest | 4 个文件 | **67 passed (67)** |
| 网关 / 认证 / 封面 / 引擎脚本 | 同上 | 60 / 36 / 15 / 47 项全部通过 |
| 引擎单文件打包 | `npm run build:engine` | 通过，exit 0 |
| 生产构建 | `npm run build` | 通过，exit 0；dist 无 sourcemap、无密钥 |
| 根依赖漏洞 | `npm audit` | 0 |
| Player 依赖漏洞 | `pnpm audit` | 由 3 high + 12 moderate 降至 **2 high + 6 moderate**，剩余全部为构建期 `vite-plugin-svg-icons > svg-baker` 链路 |
| Player 类型检查 | `vue-tsc --noEmit` | 51 个历史错误，**与修复前集合完全一致**（无新增） |

**部署建议：修复本身可以部署；但上线前必须完成第 15 节的清单（尤其是提交后重建 dist、清理工作区、轮换可能已泄漏的 API Key）。**

---

## 2. 审计范围与不在范围

### 2.1 在范围内

- `functions/**`（Cloudflare Pages Functions：路由、认证、SSRF、限流、缓存、推荐、歌词/搜索/代理）
- `server/**`（Linux 引擎：HTTP 服务器、SQLite 推荐存储）
- `player/**`（Vue 3 播放器：构建配置、XSS sink、Token 处理、依赖）
- 根目录 `index.html` / `js/**`（旧版静态播放器，仍在仓库中）
- `scripts/**`（部署脚本、测试/审计脚本、品牌审计）
- `Dockerfile`、`docker-compose.yml`、`.env.example`、`.dockerignore`、`player/public/_headers`
- 依赖锁定文件（`package-lock.json`、`player/pnpm-lock.yaml`）
- 当前 Git 分支与工作区状态

### 2.2 不在范围内 / 未执行

- **未对生产站点做任何请求**（`https://sonic.epocanvas.tech`、`https://cfsolara-dho.pages.dev` 等）。仓库自带 `scripts/audit_sonic_gateway.py` 会直接请求线上 Pages 域名，本次**未运行**。
- **未执行 Docker 构建**：本机 Docker daemon 未运行（`failed to connect to the docker API at npipe://...`）。
- **未执行 Wrangler 发布**、未验证 Cloudflare 账户级配置（KV、Tunnel、WAF、Rate Limiting 规则）。
- 未做真实浏览器端到端点击验证（依赖 CDN 的 jQuery/字体在隔离测试环境中不可用）；前端修复使用 jsdom 单元测试 + 源码守卫验证，详见 §9。
- 未审计第三方音乐平台本身、Epomail OAuth 服务端实现、Cloudflare 平台内部实现。
- 未做渗透测试式的真实凭证/真实用户数据测试；所有测试均使用本地 stub、合成密钥和保留文档网段 IP。

---

## 3. 仓库架构与攻击面

### 3.1 技术栈（以当前源码为准）

| 层 | 技术 | 关键文件 |
| :--- | :--- | :--- |
| 边缘控制面 | Cloudflare Pages Functions（Web Fetch API） | `functions/api/**`、`functions/proxy.ts`、`functions/palette.ts` |
| 本地数据面 | Node.js 22 HTTP + 原生 `fetch`，esbuild 单文件打包 | `server/index.ts` → `dist-server/index.mjs` |
| 推荐/行为存储 | Node 22 内置 `node:sqlite`（WAL + FTS5）；边缘为有界内存 LRU | `server/recommend-sqlite.ts`、`functions/_lib/sonic/recommend/memory-store.ts` |
| 前端（部署） | Vue 3 + Vite + Pinia + hls.js + Artplayer | `player/**` → `dist/**`（`scripts/deploy-pages.mjs` 发布的目录） |
| 前端（旧版，仍提交） | 原生 JS + jQuery 3.6.0（CDN） | 根 `index.html`、`js/index.js` |
| 部署 | Docker Compose（引擎 + ncm-api，引擎仅绑定 `127.0.0.1`）+ Cloudflare Pages | `Dockerfile`、`docker-compose.yml` |

**部署事实核对**：`npm run deploy` → `npm run build`（构建 `player/dist` 并复制到 `dist/`）→ `wrangler pages deploy dist`。因此**线上前端是 `dist/`（Vue 播放器）**；根 `index.html`/`js/index.js` 不被该部署脚本发布，但仍可通过其他静态托管方式暴露，且属于仓库攻击面。

### 3.2 信任边界

| 边界 | 机制 | 证据 |
| :--- | :--- | :--- |
| 匿名用户 → 边缘 API | 分级限流（匿名 240 rpm / API Key 600 rpm，可配）；`SONIC_REQUIRE_AUTH` 可强制登录 | `functions/_lib/sonic/security.ts:169`、`:283` |
| 用户 → API Key | HMAC-SHA256，密钥 ≥32 字符，30 天过期，支持 `SONIC_SECRET_PREV` 轮换；常量时间验证 | `functions/_lib/auth.ts:184`、`:299` |
| 边缘 → 本地引擎 | `X-Sonic-Engine-Key`（≥32 字符，常量时间比较）；引擎主机名/`/api/sonic/engine/*`、`/api/sonic/resolve/*` 强制 | `security.ts:43`、`:53`、`server/index.ts:316` |
| 客户端 IP | 仅信任 `CF-Connecting-IP`；`X-Sonic-Client-IP` 仅当请求带合法引擎密钥时采信 | `security.ts:126`、`:134` |
| 引擎 → ncm-api | 固定容器地址 + **22 个只读端点允许列表** | `functions/_lib/sonic/upstream.ts:132-160` |
| 边缘/引擎 → 外网 CDN | `validateSafeUrl`（https、仅 80/443、拒绝 userinfo、域名允许列表、私网/元数据 IP）+ `safeFetch` 逐跳重定向复验 | `security.ts:522`、`:609` |
| OAuth | Epomail OAuth 2.0；state 256-bit + HttpOnly/Secure/SameSite=Lax Cookie；PKCE S256；redirect 白名单 | `functions/api/auth/login.ts:33-60`、`callback.ts:62` |
| 匿名推荐身份 | `x-sonic-anon-id`（`anon_[A-Za-z0-9_-]{8,64}`）经 SHA-256 哈希为 subjectKey；**不是认证** | `recommend/identity.ts:8-22`、`:99` |

### 3.3 外部入口清单

| 方法/路径 | 处理函数 | 认证 | 主要控制 | 自动化测试 |
| :--- | :--- | :--- | :--- | :--- |
| GET `/api` | `functions/api/index.ts` | 公开 | 无（静态信息，含架构/开关提示） | 引擎脚本 |
| GET `/api/cover`、`/api/music/cover` | `music/cover.ts` | 公开 | 限流、引擎密钥、SSRF 允许列表、`image/*` 过滤、拒绝 SVG（新增）、nosniff/CSP（新增） | cover 脚本 + 新增 |
| GET `/api/lyric`、`/api/lyrics`、`/api/music/lyric(s)` | `music/lyric.ts` | 公开 | 限流、SSRF（固定上游）、参数长度上限（新增）、公共缓存 | 网关脚本 |
| GET `/api/music/search` | `music/search.ts` | 公开 | 限流、引擎密钥、参数长度上限（新增） | 网关脚本 |
| GET `/api/music/random` | `music/random.ts` | 公开 | 限流、count ≤30 | — |
| GET `/api/music/stream` | `music/stream.ts` | 公开 | 限流、SSRF 允许列表、Range 透传、媒体类型过滤（新增）、nosniff/CSP | 新增 |
| GET `/palette`、`/api/music/palette` | `functions/palette.ts` | 公开 | **新增**限流、`safeFetch` 逐跳校验、8MB 上限、仅 JPEG 解码 | 新增 |
| GET `/proxy` | `functions/proxy.ts` | 公开 | 限流、仅 `*.kuwo.cn`、`safeFetch`（新增）、音频类型过滤（新增） | 新增 |
| GET `/api/**`（未匹配的商业目录） | `functions/api/[[path]].ts` → `upstream.ts` | 公开 | 限流、引擎密钥、ncm-api 端点允许列表、未知 404 | 引擎脚本 |
| GET `/api/sonic/search/{nexus,smart,[platform]}` | `route-helpers.ts` / `smart.ts` | 公开 | 限流、引擎密钥、查询长度上限（新增） | 推荐/搜索测试 |
| GET `/api/sonic/lyrics/{nexus,sync,[platform]}` | `route-helpers.ts` | 公开 | 限流、引擎密钥、参数长度上限（新增） | 网关脚本 |
| GET `/api/sonic/forward` | `forward.ts` | 公开 | 限流、SSRF 允许列表、**内容类型白名单/头部白名单（新增）** | 新增 |
| GET `/api/sonic/recommend/{for-you,trending,similar,discover}` | `recommend/*.ts` | 公开/可选身份 | 限流、`private, no-store`（有身份信号时） | 推荐测试 |
| GET/POST/DELETE `/api/sonic/events` | `events.ts` | 匿名/可选身份 | 限流、64KB（按字节，新增）、事件类型白名单、每批 50 条、删库接口 | 推荐测试 |
| GET `/api/auth/login` | `auth/login.ts` | 公开 | **新增 30 次/分/IP**、PKCE、state Cookie | 新增 |
| GET `/api/auth/callback` | `auth/callback.ts` | 公开（依赖 state Cookie） | **新增 30 次/分/IP**、state 常量时间比较、Cookie 清理 | security.test + 新增 |
| GET/POST `/api/auth/key`、`/api/auth/user` | `auth/key.ts`、`user.ts` | HMAC API Key | 失败即 401；key 轮换有界缓存（新增） | security.test |
| GET `/api/sonic/engine/health` | `engine/health.ts` | **引擎密钥** | 不返回密钥；仅布尔标志与电路状态 | 引擎脚本 |
| GET `/api/sonic/resolve/stream` | `resolve/stream.ts` | **引擎密钥** | 限流、上游结果再过 SSRF 校验 | 引擎脚本 |

---

## 4. 工具、版本与执行环境

| 项 | 值 |
| :--- | :--- |
| OS | Windows 10.0.26200（x64），Git Bash |
| Node.js | v24.14.0（本机）；项目目标 Node ≥22 |
| pnpm | 10.34.5 |
| TypeScript | 5.9.3 |
| Vitest | 5.0.5（jsdom 30 可用） |
| esbuild | 0.25.4（Dockerfile 与 `build:engine` 一致） |
| Cloudflare 工具 | Wrangler **未运行**（无凭据/不部署） |
| Docker | **不可用**（daemon 未启动），镜像构建未执行 |
| 网络 | 可访问 npm registry；网关脚本会访问第三方音乐上游（非确定性因素，见 §10） |

---

## 5. 漏洞清单与严重度

评级依据：可利用性 × 影响（同源脚本执行/凭证窃取 = P1；远程资源耗尽/条件性 SSRF/供应链 = P2；纵深防御/工程 = P3）。所有条目均给出代码证据；“待验证”项单独标注。

| ID | 级别 | 状态 | 标题 |
| :--- | :--- | :--- | :--- |
| SONIC-01 | **P1** | 已修复 | 第三方元数据 → `innerHTML` 同源 XSS（Vue 卡片 + 旧版播放列表/封面） |
| SONIC-02 | **P1** | 已修复 | 资产代理回传上游 `Content-Type`，允许域 HTML/SVG 形成同源 XSS |
| SONIC-03 | P2 | 已修复 | 酷我音频代理使用裸 `fetch`，重定向不校验（SSRF 绕过） |
| SONIC-04 | P2 | 已修复 | `/palette` 无限流、裸 `fetch` 跟随重定向、无响应大小上限 |
| SONIC-05 | P2 | 已修复 | `/api/auth/login`、`/api/auth/callback` 无限流（未认证外呼放大） |
| SONIC-06 | P2 | 已修复 | `/api/sonic/forward` 回传全部上游响应头（`Set-Cookie` 注入、`Content-Encoding` 错配） |
| SONIC-07 | P2 | 已修复 | `/api/sonic/events` 先整包读入再判大小（内存放大） |
| SONIC-08 | P2 | 已修复 | `/api/auth/key` 每次轮换写入认证缓存，`createSession` 不做容量淘汰 |
| SONIC-09 | P2 | 已修复 | 运行时客户端依赖 `music-metadata@7.14.0` 存在多项 DoS 漏洞 |
| SONIC-10 | P2 | 已修复 | 部署脚本强制 `--commit-dirty=true`，允许未提交流水线发布 |
| SONIC-11 | P2 | 已修复 | 部署站点缺少 `nosniff` / 防点击劫持 / Permissions-Policy；API 响应可被当文档渲染 |
| SONIC-12 | P3 | 已修复 | SSRF 未拦截 IPv4-compatible IPv6（`::7f00:1` 等） |
| SONIC-13 | P3 | 已修复 | 搜索/歌词查询参数无长度上限 |
| SONIC-14 | P3 | 已修复 | 限流桶 Map 在全部桶未过期时可超过 4096 上限 |
| SONIC-15 | P3 | 未修复 | 无 CI；ESLint 9 无 flat config；主题 lint 基线过期；51 个历史 `vue-tsc` 错误 |
| SONIC-16 | P3 | 未修复 | 旧版 `index.html` 从 CDN 加载 jQuery/FontAwesome，无 SRI；全站无完整 CSP |
| SONIC-17 | P2（设计） | 未修复 | API Key 无法单键吊销、30 天 Bearer、通过 URL fragment 下发 |
| SONIC-18 | P3（设计） | 未修复 | 匿名事件可被批量伪造，影响站内热度/推荐数据完整性 |
| SONIC-19 | P3 | 未修复 | 内存限流按 isolate 生效，跨实例不一致（KV 可选） |
| SONIC-20 | P3 | 未修复 | DNS 重绑定 TOCTOU；`server/index.ts` 的 `checkDnsRebinding` 为死代码 |

---

## 6. 关键问题：代码证据与影响

> 标注“修复前”的行号为变更前文件行号；其余行号为当前工作区行号。

### SONIC-01（P1）第三方元数据 → `innerHTML` 同源 XSS

**修复前证据**

- `player/src/components/Ui/HeroCard.vue:94`：`const cleanCover = formatCoverUrl(props.coverUrl, { size: 400 })`，随后 `:103`/`:121` 在 `clone.innerHTML` 中插入 `background-image: url(${cleanCover})` 与 `<img src="${cleanCover}" onerror=...>`。
- `player/src/components/Ui/MVCard.vue:209`：同样把 `formatCoverUrl(...)` 直接插入 `innerHTML`。
- `js/index.js`（修复前 `:2963`）：播放列表用模板字符串拼接 `${song.name}`、`${song.artist}` 后赋给 `dom.playlistItems.innerHTML`；`:1189`：`<img src="${url}">` 拼接封面 URL；`:1306`：调试日志 `innerHTML +=`。
- `player/src/utils/imageUrl.ts:44-90` 的 `formatCoverUrl` 不做任何 HTML 转义，只做协议/尺寸处理；曲名、歌手、封面均来自第三方搜索/榜单接口。
- 会话密钥存储：`js/index.js`（`initEpomailAuth` 区域）把 OAuth 回调返回的 `{ apiKey, ... }` 写入 `localStorage` 的 `sonic_session`；播放器 `player/src/stores/modules/recommend.ts:104` 也从 `localStorage` 读取 API Key。

**攻击前提与影响**

1. 攻击者在任一聚合平台投放曲名/歌手/封面元数据（用户生成内容平台可行），或诱导用户打开一个带恶意 `cover` 的分享链接/被污染的本地播放列表状态；
2. 用户搜索并播放该曲目（旧版）或点击 Hero/MV 卡片（Vue 版）触发 `innerHTML`；
3. 脚本在 `sonic.epocanvas.tech` 源执行，读取 `localStorage` 中的 API Key（30 天有效），并可调用全部受保护 API。

**修复**

- 新增 `player/src/utils/escapeHtml.ts`（`escapeHtmlAttribute`，转义 `& < > " '`）；
- `HeroCard.vue:95`、`MVCard.vue:210` 在插入前调用 `escapeHtmlAttribute(...)`；
- 新增 `js/playlist-view.js`：用 `createElement` + `textContent` + `dataset` 构建播放列表，**不使用任何 HTML 字符串**；`js/index.js:2957` 改调 `SonicPlaylistView.renderInto`，缺失该模块时拒绝渲染（fail-closed）；
- `setAlbumCoverImage` 改为 `createElement('img')` + `replaceChildren`；`debugLog` 改为 `textContent`；
- `index.html` 在 `js/index.js` 之前加载 `js/playlist-view.js`。

**残余**：旧版页面仍从 `code.jquery.com` 加载 jQuery（无 SRI、无 CSP），若该 CDN 被投毒仍可执行脚本（见 SONIC-16）。Vue 页面未做真实浏览器 E2E，仅做了 jsdom 行为测试与源码路径守卫。

---

### SONIC-02（P1）资产代理内容类型导致同源 XSS

**修复前证据**

- `functions/api/music/stream.ts`（修复前 `:232-237`）：把上游 `content-type` 原样写入响应；允许的目标域包含 `qq.com`、`163.com` 等**整个注册域**（`security.ts:13-27`）。请求 `/api/music/stream?target=https://y.qq.com/` 会把 QQ 音乐首页 HTML 以 `text/html` 从 Sonic 源返回。
- `functions/api/sonic/forward.ts`（修复前 `:88`）：`new Headers(upstreamResp.headers)` 全量回传，包含 `Content-Type`、`Set-Cookie`、`Content-Encoding`。
- `functions/api/music/cover.ts`（修复前 `:81-82`）：只判断 `contentType.includes('image/')`，因此 `image/svg+xml` 会被回传；SVG 作为文档打开时可执行脚本。
- `functions/proxy.ts`：酷我音频响应只白名单部分头部，但仍会回传上游 `Content-Type`。

**攻击前提与影响**：攻击者构造一个指向允许域、返回攻击者可控 HTML/SVG 的 URL（例如平台上的用户主页、歌词分享页、开放重定向页面），诱导用户直接访问 `https://sonic.epocanvas.tech/api/music/stream?target=...`，脚本即以 Sonic 源执行并读取 `localStorage` API Key。无需先攻破 Sonic。

**修复**

- `stream.ts`：新增 `isPlayableMediaType`，仅允许 `audio/*`、`video/*`、`application/octet-stream`、`binary/octet-stream`（空类型放行，保持旧 CDN 兼容）；否则 415。
- `forward.ts`：新增 `isForwardableAssetType`，拒绝 HTML/XHTML/SVG；文本类仅允许 `text/plain`、XML、JSON、TTML、LRC、octet-stream；响应头改为白名单（`buildSafeUpstreamResponseHeaders`）并加 `nosniff` + `CSP sandbox`。
- `cover.ts`：拒绝 `image/svg+xml` / `image/svg`（回退到站内静态 SVG）；成功响应加 `nosniff` + `CSP sandbox`。
- `proxy.ts`：酷我代理拒绝非音频内容类型（抛错 → 502），并加 `nosniff` + `CSP sandbox`。
- `functions/_lib/http.ts` 与 `route-helpers.buildGatewayHeaders`：所有 JSON/文本 API 响应统一加 `X-Content-Type-Options: nosniff` 与 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`。

**兼容性影响**：见 §12。

---

### SONIC-03（P2）酷我代理 SSRF（重定向绕过）

**证据（修复前）**：`functions/proxy.ts:95` 使用 `fetch(normalized.toString(), init)`，`redirect` 默认 `follow`。`normalizeKuwoUrl` 只校验初始 URL 属于 `*.kuwo.cn`。若 `kuwo.cn` 存在任意开放重定向，即可把代理跳转到 `http://127.0.0.1` / `169.254.169.254` 并把内网响应体回传。

**修复**：改用 `safeFetch(normalized, init, { allowedDomains: ['kuwo.cn'], maxRedirects: 2, timeoutMs: 15000 })`，逐跳复验并禁止 https→http 降级；`onRequest` 捕获异常返回 502。
**回归测试**：stub 上游 302 → `http://127.0.0.1/evil`，断言 502 且未跟随；非 kuwo 目标直接 400 且不发起外呼。

---

### SONIC-04（P2）`/palette` 资源耗尽与重定向 SSRF

**证据（修复前）**：`functions/palette.ts:419` 直接 `fetch()`（默认跟随重定向，无超时参数），`:457` `await upstream.arrayBuffer()` 无大小上限；整个 handler 无限流。攻击者可让允许域返回 302 → 内网，或返回数 GB JPEG 触发 isolate OOM（Pages 内存上限）。

**修复**：限流 `music-palette`；`safeFetch` 逐跳校验（保留 `cf.image` 缩放，失败时降级为不带 `cf` 的 `safeFetch`）；`readBoundedArrayBuffer` 先看 `content-length` 再流式累计，超过 8MB 返回 413。
**回归测试**：声明 16MB → 拒绝；流式超限 → 拒绝；上游 32MB → 413；第二次请求 → 429。

---

### SONIC-05（P2）OAuth 端点无速率限制

**证据（修复前）**：`functions/api/auth/login.ts` 与 `callback.ts` 仅做 OPTIONS / 配置检查。未认证攻击者可循环「`/api/auth/login` 取 state Cookie → `/api/auth/callback?code=垃圾`」，每次 callback 触发 2 次到 Epomail 的 token/userinfo 外呼，形成放大与第三方资源消耗。

**修复**：新增 `evaluateAuthRateLimit`（`security.ts:283`）：**按 `CF-Connecting-IP` 每 scope 30 次/分**，忽略 `SONIC_REQUIRE_AUTH`（登录必须匿名可达），不接受 API Key 提权，支持 KV；`login`/`callback` 各用独立 scope。超限返回 429 + `Retry-After`。
**回归测试**：30 次放行、第 31 次 429；伪造 `X-Sonic-Client-IP` 不改变桶；`REQUIRE_AUTH=1` 下登录仍可匿名进入限流器。

---

### SONIC-06（P2）转发响应头泄漏/注入

**证据（修复前）**：`functions/api/sonic/forward.ts:88` `new Headers(upstreamResp.headers)`。影响：
- 允许域可向 Sonic 源写入任意 `Set-Cookie`（例如伪造 `sonic_oauth_state`，虽 Cookie Path 限定 `/api/auth`，仍属越权写 Cookie）；
- `Content-Encoding` 被回传但 body 已被运行时解压，客户端解码失败；
- 回传 `Server`/`X-Powered-By` 等指纹。

**修复**：`buildSafeUpstreamResponseHeaders`（`security.ts:592`）仅保留 `content-type`、`content-range`、`accept-ranges`、`etag`、`last-modified`、`expires`、`cache-control`；仅当上游无 `Content-Encoding` 时保留 `content-length`。
**回归测试**：含 `set-cookie`/`content-encoding`/`server` 的 Headers → 全部剥离；无编码时保留长度。

---

### SONIC-07（P2）事件接口先读后判

**证据（修复前）**：`events.ts:147-154` `await request.text()` 之后才判断 `rawText.length > 64KB`；Workers 单请求可达 100MB（付费计划），会先完整缓冲。
**修复**：`readBoundedRequestBody`（`route-helpers.ts:129`）先检查 `Content-Length`，再流式累计，超限立即 `cancel()`；按 UTF-8 字节计数（比原字符数更严格）。
**回归测试**：流式 1.2KB / 上限 1KB → `too_large`；正常 JSON 原样返回。

---

### SONIC-08（P2）认证缓存无界增长

**证据（修复前）**：`auth.ts:249` `createSession` 直接 `authCache.set(...)`；淘汰逻辑只存在于 `verifyAuth`。持有合法 Key 的调用者可反复 `POST /api/auth/key` 生成新 Key，每个新 Key 都插入缓存，isolate 内存持续增长。
**修复**：抽取 `storeVerifiedAuth`（`auth.ts:184`），两处统一走容量淘汰（1000 上限、过期清理、最旧淘汰）。

---

### SONIC-09（P2）客户端依赖 DoS（`music-metadata@7.14.0`）

**证据**：`player/package.json` 依赖 `music-metadata-browser@2.5.11`，其传递依赖被 override 锁定为 `music-metadata >=7.14.0 <8`；安装版本 7.14.0。`pnpm audit` 报告 1 high（ASF 解析无限循环）+ 5 moderate（MP4/APEv2/ID3v2/EBML 内存耗尽、DSF 崩溃），路径 `.>music-metadata-browser>music-metadata`。`player/src/stores/modules/localMusic.ts:35` 对用户选择的本地文件调用 `mm.parseBlob(file)`，恶意音频文件可卡死/崩溃标签页。
**修复**：移除 `music-metadata-browser` 与旧 override，改为 `music-metadata@^11.16.0`（实际安装 11.16.1），import 改为 `music-metadata`，`parseBlob` API 不变。
**验证**：`pnpm --dir player build` 成功；Node 冒烟 `typeof parseBlob === 'function'`，对 10 字节 ID3 头返回可捕获的 `CouldNotDetermineFileTypeError`；`pnpm audit` 中 6 项 music-metadata 相关漏洞全部消失。未做浏览器内真实文件导入点击测试（如实记录）。

---

### SONIC-10（P2）部署门禁允许脏工作树

**证据（修复前）**：`scripts/deploy-pages.mjs` 固定 `--commit-dirty=true`，可发布未提交/未审核代码。
**修复**：部署前执行 `git status --porcelain`；有变更且未设置 `ALLOW_DIRTY_DEPLOY=1` 时 exit 1；`--commit-dirty` 随开关取值。该门禁会在本次变更提交前阻止 `npm run deploy`（预期行为）。

---

### SONIC-11（P2）安全响应头缺失

**证据**：`player/public/_headers`（构建后 `dist/_headers`）只设置 `Referrer-Policy`、`ACAO: *` 与缓存；无 `X-Content-Type-Options`、无防框架嵌入、无 `Permissions-Policy`。API 响应也无 `nosniff`/CSP。
**修复**：`_headers` 增加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`；API JSON 响应统一加 `nosniff` + `CSP default-src 'none'; sandbox`。
**验证**：重新构建后 `dist/_headers` 含新头；`frontend-xss.test.ts` 守卫这三项配置。

---

### SONIC-12（P3）IPv4-compatible IPv6 SSRF 缺口

**证据**：`isBlockedIpv6` 处理 `::1`、`::ffff:x`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`64:ff9b::/96`，但漏掉已废弃的 `::/96` 兼容地址（`::7f00:1` = 127.0.0.1、`::a00:1` = 10.0.0.1）。URL 规范会把 `https://[::127.0.0.1]/` 规范化成 `[::7f00:1]` 后进入该函数。
**修复**：`security.ts:456` 新增 `::x:y` → IPv4 映射并复用 `isBlockedIpv4`。
**回归测试**：`::7f00:1`、`[::7f00:1]`、`::a00:1`、`::c0a8:101` 均拦截；`2606:4700:4700::1111`、`2a03:2880:...` 放行；`https://[::127.0.0.1]/secret` 判定非法。

---

### SONIC-13 / SONIC-14（P3）输入长度与限流桶上限

- 搜索查询、歌词标题/歌手/ID 无长度上限 → 上游 URL 膨胀与 CPU 消耗。已在 `parseSearchParams`（256）、`parseLyricsParams`（200/128）、`music/search.ts`（256）、`music/lyric.ts`（200/128/256）加截断。**回归测试**：5000 字符输入被截为上限。
- `bumpInMemoryWindow` 在全部桶都未过期时会继续新增桶 → 内存可超 4096。已增加“最旧桶淘汰”。（未编写大规模并发单测，属代码级约束。）

---

## 7. 已实施的修复（按文件）

| 文件 | 变更 |
| :--- | :--- |
| `functions/_lib/sonic/security.ts` | 新增 `evaluateAuthRateLimit`、`bumpInMemoryWindow` 抽取与最旧淘汰、`buildSafeUpstreamResponseHeaders`、IPv4-compatible IPv6 拦截 |
| `functions/_lib/sonic/route-helpers.ts` | 查询/歌词参数长度上限；`readBoundedRequestBody`；API 响应新增 `nosniff` + CSP |
| `functions/_lib/http.ts` | 所有 JSON 响应新增 `nosniff` + `CSP default-src 'none'; frame-ancestors 'none'; sandbox` |
| `functions/_lib/auth.ts` | `storeVerifiedAuth` 统一容量淘汰（`createSession` 不再无界写入） |
| `functions/api/auth/login.ts`、`callback.ts` | 新增 30 次/分/IP 认证限流（登录保持匿名可达） |
| `functions/api/sonic/forward.ts` | 内容类型白名单（拒绝 HTML/XHTML/SVG）、响应头白名单、`nosniff` + CSP |
| `functions/api/sonic/events.ts` | 有界请求体读取（Content-Length + 流式字节上限） |
| `functions/api/music/stream.ts` | 媒体类型校验（415）、`nosniff` + CSP（经 `corsHeaders`） |
| `functions/api/music/cover.ts` | 拒绝 SVG、`nosniff` + CSP、静态 SVG 兜底同样加固 |
| `functions/api/music/search.ts`、`lyric.ts` | 输入长度上限 |
| `functions/palette.ts` | 限流、`safeFetch`（逐跳重定向校验）、8MB 有界读取、413 处理 |
| `functions/proxy.ts` | 酷我代理改用 `safeFetch` + 音频类型校验 + 502 兜底 + `nosniff`/CSP |
| `player/src/utils/escapeHtml.ts`（新） | HTML 属性转义工具 |
| `player/src/components/Ui/HeroCard.vue`、`MVCard.vue` | 封面 URL 插入 `innerHTML` 前转义 |
| `js/playlist-view.js`（新） | 纯 DOM 播放列表渲染器（`textContent`/`dataset`） |
| `js/index.js` | 播放列表、封面、调试日志移除不安全 `innerHTML`；模块缺失时 fail-closed |
| `index.html` | 在旧版脚本前加载 `js/playlist-view.js` |
| `player/public/_headers` | 新增 `nosniff`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`Permissions-Policy` |
| `player/package.json`、`player/pnpm-lock.yaml`、`player/src/stores/modules/localMusic.ts` | `music-metadata-browser@2.5.11` → `music-metadata@11.16.1`；移除旧 override |
| `scripts/deploy-pages.mjs` | 脏工作树部署门禁（`ALLOW_DIRTY_DEPLOY=1` 例外） |
| `tests/security-hardening.test.ts`（新） | 24 项后端回归测试 |
| `tests/frontend-xss.test.ts`（新） | 6 项 jsdom/源码守卫测试 |
| `package.json` | `test` / `test:security` 纳入新测试文件 |

---

## 8. 修改原因与设计取舍

- **优先“根治 sink”而不是过滤输入**：XSS 修复全部改为 DOM API / 转义，不做黑名单字符串替换。
- **优先“拒绝”而不是“清洗”**：资产代理遇到 HTML/SVG 直接 415/回退静态图，避免清洗器绕过。
- **不改变认证协议**：保留 HMAC Key 格式、OAuth 流程与 API 响应结构；仅新增限流与响应头。
- **不引入新依赖**（除升级 `music-metadata`）：转义与有界读取均为本地实现，减少供应链面。
- **不重写无关模块**：所有后端补丁集中在既有安全库与目标 handler；未触碰推荐算法、歌词解析算法。

---

## 9. 回归测试与真实执行结果

### 9.1 命令与退出码

| 命令 | 退出码 | 结果 |
| :--- | :--- | :--- |
| `npm run typecheck` | 0 | 无错误 |
| `npm test` | 0 | 网关 60 / 认证 36 / 封面 15 / 引擎 47 全通过；Vitest 4 文件 **67 passed** |
| `npm run build:engine` | 0 | `dist-server/index.mjs` 683.6 KB |
| `npm run build` | 0 | `player/dist` → `dist/`；`dist` 无 `.map`，无密钥匹配（仅客户端 `sonic_live_v1.` 前缀常量） |
| `npm run lint:theme` | 1 | **修复前即失败**：5 处硬编码白色，位于未修改的 `player/src/App.vue:42`、`AddToPlaylistDialog.vue:94/96/150/156` |
| `pnpm --dir player exec eslint ...` | 2 | **修复前即不可用**：ESLint 9 找不到 `eslint.config.js` |
| `pnpm exec vue-tsc --noEmit` | 2 | 51 个历史错误；与修复前（临时还原依赖后实测）**错误集合完全一致** |
| `npm audit`（根） | 0 | 0 漏洞 |
| `pnpm audit`（player，修复后） | 0（报告生成） | 2 high + 6 moderate，全部构建期 |
| `docker build` | 未执行 | Docker daemon 不可用 |

### 9.2 新增测试清单（全部真实通过）

**`tests/security-hardening.test.ts`（24）**

- SSRF：IPv4-compatible IPv6（4 组拦截、2 组放行、1 组 URL 规范化）
- `safeFetch`：重定向到内网被拒；https→http 降级被拒
- 酷我代理：302→回环返回 502；非酷我目标 400 且零外呼
- 响应头：剥离 `Set-Cookie`/`Content-Encoding`/`Server`；保留安全头
- `/palette`：声明超限、流式超限、上游 32MB→413、限流 429
- 认证限流：30 次放行/第 31 次 429、伪造客户端 IP 无效、`REQUIRE_AUTH=1` 下登录仍可达
- 长度上限：搜索 256、歌词 200/128
- 有界请求体：流式超限、正常解析
- 资产代理：stream HTML→415、真实音频→200+nosniff+CSP、cover SVG→站内兜底、forward HTML→415、`corsHeaders` 含 nosniff/frame-ancestors

**`tests/frontend-xss.test.ts`（6，jsdom）**

- 恶意曲名/歌手（`<img onerror>`、`" onclick=`）渲染为纯文本，无 `img/script`
- 播放列表操作按钮 `dataset` 保持完整；两条曲目渲染无注入
- `escapeHtmlAttribute` 行为（引号、尖括号、`&`、`'`、null）
- 源码守卫：旧版走 `SonicPlaylistView`；Vue 卡片使用 `escapeHtmlAttribute`；`_headers` 含 nosniff/XFO/frame-ancestors

### 9.3 未自动化 / 未执行

- 真实浏览器中的完整 OAuth 登录 → 播放 → 搜索 → 封面 → 调色板链路（无可用授权测试账号；未对生产站测试）。
- Docker 镜像构建与 HEALTHCHECK。
- 线上 Wrangler 部署与 Cloudflare WAF/KV/Tunnel 配置验证。
- `music-metadata` 在浏览器中的真实文件导入（仅构建 + Node API 冒烟）。
- 大规模并发/压力测试（限流桶、SQLite 写入竞争）。

---

## 10. 扫描器专项审计

### 10.1 结论：仓库内没有漏洞扫描器

- `scripts/audit_sonic_gateway.py`：**黑盒 E2E QA 脚本**，目标硬编码 `https://cfsolara-dho.pages.dev`，27 个 `run_http_test` 用例覆盖歌词/搜索/降级/缓存/参数校验。它不读取 CVE 情报、不做版本匹配、不产出漏洞列表，因此**不是**安全扫描器。
- `scripts/test-*.mjs`、`scripts/verify_*.{mjs,py}`、`scripts/brand-audit.mjs`：功能回归 / 品牌审计 / 线上验证脚本。
- 因此 **precision / recall / TP / FP / TN / FN 对“扫描器”不适用**，本报告不作臆造数字。

### 10.2 对现有审计脚本的真实审查（按任务书 14 项）

| 检查项 | 结论（证据） |
| :--- | :--- |
| 目标枚举完整性 | 仅覆盖 HTTP 端点，未枚举管理/内部入口（脚本本意如此） |
| 输入规范化一致性 | 使用 `requests` + 固定路径，未复刻应用层 URL 解析 |
| 规则是否真正执行 | 是：每个用例真实发请求并断言状态码/字段 |
| 正则/性能风险 | 未见灾难性回溯；脚本为顺序请求 |
| 误报/漏报 | **漏报风险高**：只断言 200 与字段存在，不检测 XSS/SSRF/认证绕过 |
| 情报来源/版本匹配 | 无 |
| 严重度依据 | 无（无严重度概念） |
| 扫描失败是否被当安全 | 否：异常记为 FAIL，退出码 1 |
| 报告证据 | 有 URL、状态码、耗时、错误信息、JSON 报告 |
| 扫描器自身安全 | 目标为自有域名；未校验重定向；会写 `audit_results.json` 到 CWD |
| 并发/超时/取消 | 单线程、30s 超时，无取消 |
| 任务结果覆盖 | 单次运行写同一文件，并发运行会互相覆盖 |
| 退出码语义 | 正确：`0 if failed==0 else 1`（`:732-733`） |
| CI 门禁 | **仓库无 CI**，脚本不会被自动执行 |
| 是否将线上目标作为测试对象 | 是（生产 Pages 域名）。本次按“不得对生产做攻击性测试”**未运行** |

### 10.3 本次使用的安全控制基准集（本地、可复现）

| 控制 | 恶意样本 | 良性样本 | 结果 |
| :--- | :--- | :--- | :--- |
| API Key HMAC | 伪造/篡改 email/篡改 exp/过期/旧格式/短密钥 | 合法 Key、轮换前密钥 | 全部符合预期 |
| OAuth state | 缺失/不匹配/无 Cookie | 匹配 state | 400 |
| SSRF | 127.0.0.1、十进制/八进制/十六进制、`::ffff`、`::7f00:1`、169.254.169.254、私网、userinfo、`evil-music.com`、302→内网、https→http | 公网 CDN、合法子域、公网 IPv6 | 全部符合预期 |
| 引擎认证 | 错误/缺失密钥、未配置密钥（503） | 合法密钥 | 全部符合预期 |
| 资源上限 | 16MB 声明、流式 1.2KB/1KB、上游 32MB、HTML/SVG 上游 | 真实音频、正常 JSON | 全部符合预期 |
| XSS | `<img onerror>`、`" onclick=`、SVG `onload` | 普通曲名/封面 | 全部符合预期 |

在上述**人工构造的基准集**内：真阳性 = 全部恶意样本被阻止；真阴性 = 全部良性样本被放行；假阳性/假阴性 = 0。该结果只证明**这些控制对这批样本有效**，不等价于对未知攻击面的完备性证明，也不构成“扫描器准确率”。

---

## 11. 依赖与供应链风险

### 11.1 已修复

- `music-metadata` 7.14.0 → 11.16.1：6 项 DoS 漏洞消除（详见 SONIC-09）。

### 11.2 仍存在（全部为构建期）

`pnpm audit` 剩余 2 high + 6 moderate，唯一根路径：`. > vite-plugin-svg-icons > svg-baker > postcss/micromatch/...`

- `postcss@5.2.18`：任意文件读取、source map 路径穿越（high）。
- `postcss` 多个 ReDoS/XSS（moderate）。
- `micromatch` ReDoS（moderate）。
- `decode-uri-component` 指数解码 DoS（moderate）。

**评估**：`svg-baker` 是构建 SVG 雪碧图的旧工具，仅在开发者/构建机处理**仓库内受信 SVG**时运行，不进入浏览器运行时，也不处理用户输入。强行 override 到 postcss 8 会破坏 `svg-baker`（API 不兼容），属于“为消警而破坏构建”。**处置：接受并记录；后续以替换 `vite-plugin-svg-icons` 为主，不做危险的强制升级。**

### 11.3 其他供应链观察

- `Dockerfile` 使用 `node:22-alpine`（未固定 digest）与 `npm install --no-save esbuild@0.25.4`（版本固定、来源 npm）。
- 根 `package-lock.json` 与 `player/pnpm-lock.yaml` 均存在；`npm audit` 根为 0。
- 根 `index.html` 从 `code.jquery.com`、`cdnjs.cloudflare.com` 加载脚本/样式，**无 SRI**；这些资源不在 `dist/` 部署中，但若旧页面被单独托管仍有风险。
- 无 CI/CD 工作流（`.github/` 不存在），依赖漏洞不会阻断发布。

---

## 12. 兼容性与迁移注意事项

| 变更 | 影响 | 迁移建议 |
| :--- | :--- | :--- |
| `/api/music/stream?target=` 非音频 415 | HLS 播放列表（`application/vnd.apple.mpegurl`）、JSON、HTML 不再被代理 | 外部客户端改用 `?mode=redirect` 或直连 CDN；播放器自身不使用 `?target=` |
| `/api/music/cover` 不再代理 SVG | 极少数 SVG 封面将回退为站内渐变图 | 可接受；如需 SVG 请本地转码 |
| `/api/sonic/forward?url=` 拒绝文档类型 | 仅影响把该端点当通用 HTTP 代理的用法 | 该端点文档定位为歌词/音频/封面代理 |
| API 响应新增 CSP/nosniff | 仅响应头；XHR/fetch/`<audio>`/`<img>` 不受影响 | 无 |
| 认证端点 30 次/分/IP | 高频自动化登录测试会被 429 | 测试环境可调高 `evaluateAuthRateLimit` 参数或使用独立 IP |
| `/palette` 8MB 上限、限流 | 超大封面返回 413 | 封面正常 <1MB |
| 事件体按字节 64KB | 多字节中文内容上限略降 | 无实际影响 |
| 搜索/歌词参数截断 | 超长查询被截断 | 正常查询远低于上限 |
| `music-metadata` 11 | `parseBlob` API 不变；类型变化（`Buffer`→`Uint8Array`） | 无运行时迁移 |
| 部署门禁 | 未提交变更时 `npm run deploy` 失败 | 先提交；紧急情况 `ALLOW_DIRTY_DEPLOY=1` |
| `_headers` 新增 XFO DENY | 第三方若用 iframe 嵌入站点将被阻止 | 如确有嵌入需求，改为 `SAMEORIGIN` + `frame-ancestors` 白名单 |

**API/数据库兼容性**：未修改 API 认证协议、响应 JSON 结构、数据库 schema 或迁移；无需数据迁移。

---

## 13. 尚未解决的问题（真实状态）

1. **SONIC-15**：无 CI/CD 安全门禁；ESLint 9 缺 flat config（`pnpm --dir player lint` 直接失败）；`lint:theme` 基线过期（5 处历史违规）；`vue-tsc` 51 个历史错误。已建立“修复前=修复后 51 且集合一致”的基线，但未逐模块消除。
2. **SONIC-16**：无完整 CSP（仅 `frame-ancestors`）；旧版 CDN 脚本无 SRI；旧版 `index.html` 未被 `deploy-pages.mjs` 发布，但仍存在于仓库。
3. **SONIC-17**：API Key 无法单键吊销；30 天 Bearer；OAuth 回调通过 URL fragment 下发会话（不进入服务器日志，但留在浏览器历史，且同源脚本可读）。建议引入短期授权码 + 服务端换 Key，或引入 `kid`+吊销表。
4. **SONIC-18**：匿名 `x-sonic-anon-id` 可批量生成并写入行为事件，污染站内热度/UV。现有限流（240 rpm/IP、50 条/请求）只能减缓，无法证明数据未被刷。
5. **SONIC-19**：边缘限流为 isolate 内存态；未配置 KV 时多实例不一致。
6. **SONIC-20**：`safeFetch` 校验主机名但不固定 DNS 解析结果（TOCTOU）；`server/index.ts:89` 的 `checkDnsRebinding` **从未被调用**，Linux 引擎没有实际 DNS 重绑定防护。
7. **未验证**：Docker 镜像构建/健康检查、Wrangler 发布、Cloudflare KV/Tunnel/WAF 配置、真实浏览器全链路、`music-metadata` 浏览器导入。
8. **低风险观察（未改）**：`upstream.ts` 中 `limit`/`offset` 未编码直接拼入上游 URL（参数注入到固定主机，响应回给同一请求者，影响低）；`/api` 索引公开电路状态与开关（信息量低）。

---

## 14. 残余风险

| 风险 | 可能性 | 影响 | 说明 |
| :--- | :--- | :--- | :--- |
| 已泄漏 API Key 被继续使用 | 中（若历史 XSS 被利用） | 高 | 无法单键吊销；**建议立即轮换 `SONIC_SECRET`**（旧 Key 全部失效） |
| DNS 重绑定 | 低 | 高 | 需控制允许域的子域；引擎未固定解析 |
| 匿名推荐数据被刷 | 中 | 中 | 影响榜单可信度，不影响机密性 |
| 构建机供应链（svg-baker/postcss 5） | 低 | 中 | 仅构建期、受信输入 |
| 允许域过宽（整个注册域） | 低 | 中 | 已通过内容类型限制与 `safeFetch` 降低影响；可进一步收窄到具体 CDN 子域 |
| 内存限流不一致 | 中 | 低 | 可被多 isolate 绕过配额 |
| 旧版前端 CDN 依赖 | 低 | 高（若被托管） | 无 SRI/CSP |
| 30 秒试听/版权内容 | — | 法律/合规 | 不属于安全审计结论 |

---

## 15. 发布前检查清单

- [ ] 提交本次变更（代码变更 28 个文件 + 2 份报告均为未提交状态），确认 `git status` 干净。
- [ ] 重新执行 `npm test`、`npm run build:engine`、`npm run build`，确认 exit 0。
- [ ] 确认 `dist/_headers` 含 `nosniff` / `X-Frame-Options` / `frame-ancestors` / `Permissions-Policy`。
- [ ] 确认 `dist` 无 `*.map`、无 `SONIC_SECRET`/`EPOMAIL_CLIENT_SECRET` 等真实值。
- [ ] 生产环境变量：`SONIC_SECRET`/`SONIC_ENGINE_SECRET` ≥32 字符；`SONIC_ALLOW_QUERY_KEY=0`；`SONIC_ENABLE_GDSTUDIO/LYRIVA/UNBLOCK=0`；`SONIC_REQUIRE_AUTH` 按业务设定。
- [ ] **轮换 `SONIC_SECRET`**（历史 XSS 可能导致 API Key 泄漏）；轮换时先把旧值放入 `SONIC_SECRET_PREV`，30 天后移除。
- [ ] 引擎仅监听 `127.0.0.1` 或经 Cloudflare Tunnel；确认公网无法直连 `:8080`。
- [ ] 部署后抽查：`/api/music/stream?target=https://y.qq.com/` 返回 415；`/api/music/cover?url=<svg>` 返回站内 SVG；连续 31 次 `/api/auth/login` 出现 429。
- [ ] 观察 415/429 指标，确认播放器正常播放（音频/FLAC 封面）。
- [ ] 若配置 KV，确认 `RATE_LIMIT_KV` 绑定生效；否则接受 isolate 级限流。
- [ ] 记录发布版本（commit SHA）与回滚部署 ID。

---

## 16. 回滚方案

1. **代码回滚（未提交状态）**：`git checkout -- <本次修改的文件>` 并删除 4 个新增文件即可恢复；`dist/` 为构建产物，重新 `npm run build` 即可。
2. **依赖回滚**：`git checkout -- player/package.json player/pnpm-lock.yaml player/src/stores/modules/localMusic.ts && pnpm --dir player install --frozen-lockfile && npm run build`。注意：回滚会重新引入 `music-metadata` 6 项 DoS 漏洞。
3. **线上回滚**：Cloudflare Pages 保留历史部署，可在控制台将上一个 Deployment 设为生产；引擎镜像使用上一版本重新 `docker compose up -d`。
4. **数据回滚**：本次未变更数据库 schema/迁移，无需数据回滚。
5. **紧急发布**：若必须发布未提交树，设置 `ALLOW_DIRTY_DEPLOY=1`（不推荐），并在发布记录中注明原因与 diff。

---

## 17. 后续优先级建议

1. **P1（本周）**：轮换 `SONIC_SECRET`；为旧版前端加 SRI/下线旧版入口；在真实浏览器回归播放/搜索/封面/OAuth。
2. **P2（两周）**：引入 CI（typecheck + test + `npm audit`/`pnpm audit` + 构建 + 脏树检查）；修复 ESLint flat config 与 51 个 `vue-tsc` 错误（先禁止新增，再逐模块清理）；为 API Key 增加吊销/短期化方案。
3. **P2（一个月）**：替换 `vite-plugin-svg-icons` 以消除 postcss 5 构建链；收窄 `SONIC_ALLOWED_MUSIC_DOMAINS` 到实际 CDN 子域；评估完整 CSP（先 Report-Only）。
4. **P3**：把 `checkDnsRebinding` 接入引擎出站路径或删除死代码；为事件接口增加服务端匿名身份签发/签名，降低刷量；为限流引入 KV/Durable Object 以获得全局一致性。

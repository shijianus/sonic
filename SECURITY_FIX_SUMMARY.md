# Sonic 安全修复摘要与发布验收清单

> **2026-10-28 第二轮整改（当前）**：新增 HttpOnly OAuth 会话 Cookie、强制 PKCE、移除回调 URL 中的 API Key、API Key 重签发二次授权、Cookie 写操作同源校验、SSRF/缓存键加固。本文为历史摘要；最新验证结果见 `docs/AUDIT_REMEDIATION.md`。

> **2026-10-28 P0 后续加固**：API Key 已升级为 `sonic_live_v2`（`sub/iat/exp/jti/kid`，移除内存认证缓存与 URL Query Key，v1 一律拒绝）；Linux 引擎按 `SONIC_RUNTIME=linux-engine` 对所有 API 强制服务认证，不再依赖 Host。本文中 SONIC-08（认证缓存）及下方旧版 Query Key 验收项已失效，以本轮代码与 `tests/security-p0-regression.test.ts` 为准。

- 对应报告：`SECURITY_AUDIT_REPORT.md`
- 基线：`feat/smart-reco` @ `f8f1129`（审计开始时工作区干净）
- 修复变更：24 个修改文件 + 4 个新增文件（不含本摘要与审计报告）
- 状态：**代码修复与本地验证已完成，未提交、未发布**

---

## 一、修复摘要

| ID | 级别 | 修复内容 | 代码位置 | 回归测试 |
| :--- | :--- | :--- | :--- | :--- |
| SONIC-01 | P1 | 移除第三方元数据进入 `innerHTML` 的路径：Vue 卡片封面转义；旧版播放列表改为纯 DOM 渲染；封面/调试日志改 `textContent` | `player/src/utils/escapeHtml.ts`、`HeroCard.vue:95`、`MVCard.vue:210`、`js/playlist-view.js`、`js/index.js:1188/1306/2957`、`index.html` | `tests/frontend-xss.test.ts`（6） |
| SONIC-02 | P1 | 资产代理拒绝文档型内容：stream 仅音频/视频/octet-stream；forward 拒绝 HTML/XHTML/SVG；cover 拒绝 SVG；酷我代理仅音频；API 响应统一 `nosniff` + CSP `sandbox` | `api/music/stream.ts`、`api/sonic/forward.ts`、`api/music/cover.ts`、`proxy.ts`、`_lib/http.ts`、`route-helpers.ts` | `security-hardening.test.ts`（5 项资产代理用例） |
| SONIC-03 | P2 | 酷我代理改用 `safeFetch`（逐跳重定向复验、禁协议降级），异常返回 502 | `proxy.ts:95` | 302→回环 502；非目标域零外呼 |
| SONIC-04 | P2 | `/palette` 增加限流、SSRF 逐跳校验、8MB 有界读取、413 | `palette.ts:430/329/525` | 声明/流式/上游超限 + 429 |
| SONIC-05 | P2 | OAuth login/callback 增加 30 次/分/IP 限流（不影响匿名登录、不接受 Key 提权） | `security.ts:283`、`auth/login.ts:16`、`auth/callback.ts:35` | 30 次放行、31 次 429、伪造 IP 无效 |
| SONIC-06 | P2 | 转发响应头白名单，剥离 `Set-Cookie`/`Content-Encoding`/指纹 | `security.ts:592`、`forward.ts:91` | 头部剥离/保留用例 |
| SONIC-07 | P2 | 事件接口有界读取请求体（Content-Length + 流式字节上限） | `route-helpers.ts:127`、`events.ts:146` | 流式超限/正常解析 |
| SONIC-08 | P2 | 认证缓存统一容量淘汰 | `auth.ts:184` | 由既有认证测试覆盖 |
| SONIC-09 | P2 | `music-metadata-browser@2.5.11` → `music-metadata@11.16.1`，移除旧 override | `player/package.json`、`pnpm-lock.yaml`、`localMusic.ts:4` | 构建 + `parseBlob` 冒烟 + audit |
| SONIC-10 | P2 | 部署前脏工作树门禁（`ALLOW_DIRTY_DEPLOY=1` 例外） | `scripts/deploy-pages.mjs:5-30` | 脚本逻辑审查 |
| SONIC-11 | P2 | 站点与 API 安全响应头（nosniff / XFO / frame-ancestors / Permissions-Policy / CSP sandbox） | `player/public/_headers`、`_lib/http.ts`、`route-helpers.ts` | `frontend-xss` 配置守卫 + `corsHeaders` 测试 |
| SONIC-12 | P3 | 拦截 IPv4-compatible IPv6（`::7f00:1` 等） | `security.ts:456` | 4 拦截 + 2 放行 + 1 URL 用例 |
| SONIC-13 | P3 | 搜索/歌词参数长度上限（256/200/128） | `route-helpers.ts:13-67`、`music/search.ts`、`music/lyric.ts` | 5000 字符截断用例 |
| SONIC-14 | P3 | 限流桶满时淘汰最旧桶 | `security.ts:244` | 代码级约束（未做压力测试） |

### 未修复（已记录，不伪装为已解决）

- API Key 无单键吊销、30 天 Bearer、fragment 下发（设计级，建议后续改造）。
- 匿名事件可刷量（隐私优先设计的固有权衡）。
- 边缘内存限流非全局一致（KV 可选）。
- DNS 重绑定 TOCTOU；`checkDnsRebinding` 为死代码。
- 构建期 `postcss@5` / `micromatch` 等 2 high + 6 moderate（仅 `vite-plugin-svg-icons > svg-baker`，不进入运行时）。
- 无 CI；ESLint 9 配置缺失；51 个历史 `vue-tsc` 错误；主题 lint 基线过期。
- 旧版 CDN 脚本无 SRI；无完整 CSP。

---

## 二、真实验证结果

| 检查 | 命令 | 退出码 | 结果 |
| :--- | :--- | :--- | :--- |
| 类型检查 | `npm run typecheck` | 0 | 通过 |
| 全量测试 | `npm test` | 0 | 脚本 60/36/15/47 + Vitest **67/67** |
| 引擎打包 | `npm run build:engine` | 0 | 683.6 KB |
| 生产构建 | `npm run build` | 0 | dist 就绪，无 sourcemap，无密钥 |
| 根依赖审计 | `npm audit` | 0 | 0 漏洞 |
| Player 依赖审计 | `pnpm audit` | 0 | 2 high + 6 moderate（构建期） |
| Player 类型检查 | `pnpm exec vue-tsc --noEmit` | 2 | 51 个历史错误，修复前后集合一致 |
| 主题 lint | `npm run lint:theme` | 1 | 5 处历史违规（未修改文件） |
| ESLint | `pnpm --dir player exec eslint` | 2 | 无 `eslint.config.js`（历史问题） |
| Docker 构建 | `docker build` | 未执行 | Docker daemon 不可用 |
| 生产黑盒扫描 | `scripts/audit_sonic_gateway.py` | **未执行** | 目标为生产 Pages，按规不测试生产 |

---

## 三、发布验收清单

### 必须（阻断发布）

- [ ] 提交全部代码变更；`git status` 干净。
- [ ] `npm test`、`npm run build:engine`、`npm run build` 均 exit 0。
- [ ] `dist/_headers` 包含：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`Permissions-Policy`。
- [ ] `dist` 无 `*.map`；grep 不到任何真实密钥值。
- [ ] 生产环境 `SONIC_SECRET`、`SONIC_ENGINE_SECRET` ≥32 字符；API Key 仅走请求头（Query Key 已移除）；用户重新 OAuth 登录以获取 `sonic_live_v2`。
- [ ] **轮换 `SONIC_SECRET`**（历史 XSS 可能已导致 API Key 泄漏）；使用 `SONIC_SECRET_PREV` 平滑过渡，30 天后移除旧密钥。
- [ ] 引擎仅监听 `127.0.0.1` 或经 Tunnel；公网不可直连 `:8080`。

### 建议（发布后 24 小时内）

- [ ] 抽查 `/api/music/stream?target=https://y.qq.com/` → 415。
- [ ] 抽查 `/api/music/cover?url=<svg>` → 站内 SVG 兜底（`X-Sonic-Cover-Fallback: svg`）。
- [ ] 连续 31 次 `/api/auth/login` → 第 31 次 429。
- [ ] 播放器回归：搜索、播放、FLAC、封面、逐字歌词、推荐。
- [ ] 监控 415/429 比例；异常升高说明有客户端依赖被收紧的行为。

### 回滚

- 代码：`git checkout -- <修改文件>` + 删除新增文件 → `npm run build`。
- 依赖：还原 `player/package.json`、`player/pnpm-lock.yaml`、`localMusic.ts` → `pnpm --dir player install --frozen-lockfile` → `npm run build`（注意会恢复 DoS 漏洞）。
- 线上：Cloudflare Pages 回退到上一 Deployment；引擎用上一镜像 `docker compose up -d`。
- 数据：未变更 schema，无需回滚。

---

## 四、部署结论

- **修复本身可以部署**：所有已修复问题都有对应代码变更与本地回归测试，构建/类型检查/全量测试通过。
- **当前不建议立即发布**，阻断原因是流程而非代码：
  1. 变更**未提交**（部署门禁现在会主动阻止脏树发布）；
  2. 尚未在生产等价环境完成浏览器端到端回归；
  3. 必须先把 `SONIC_SECRET` 轮换计划纳入发布窗口（历史 XSS 的最坏情况是 API Key 已泄漏）。
- 完成上述清单后，可判定为**可发布**；未修复项均为已记录的设计/工程问题，不构成本次阻断。

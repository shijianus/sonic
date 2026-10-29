# Sonic 上线整改 — 安全复核（SECURITY-REVIEW）

- 复核 SHA：`ccd63e5`
- 范围：OAuth/会话、引擎鉴权、SSRF/代理、缓存边界、敏感信息、第三方内容授权
- 原则：已有修复不重复实现；本次只补缺口与回归

## 1. OAuth 与会话（SONIC-P0-05）

**实现现状**

- `functions/api/auth/login.ts`：32 字节随机 `state`；32 字节 `code_verifier`，S256 `code_challenge`；state 与 verifier 写入 HttpOnly Cookie（Samesite/Path/有效期见实现）。
- `functions/api/auth/callback.ts`：校验 state 长度/字符集/与 Cookie 时序安全比较；校验 PKCE verifier；`consumeOAuthState` 防重放；失败清理事务 Cookie；会话仅通过 HttpOnly Cookie 下发。
- API Key：v2 签名格式；拒绝 v1/未签名/截断 key；支持 `SONIC_SECRET_PREV` 轮换与 KV 撤销（未配置时 501，不伪装成功）。

**测试（18 例，全部通过）**

- 正向：state/PKCE/Cookie 属性；code 交换携带 verifier；会话仅 Cookie。
- 负向：非 HTTPS OAuth base；verifier 缺失；state 不匹配；state 重放；provider 拒绝；邮箱未验证；跨站 Cookie 写；KV 撤销失败 fail-closed。

**残余风险**

- 真实 Epomail 账号、生产 redirect URI、Cookie Domain/Secure 配置未在真实环境验证（**NOT RUN**）。
- 多标签页并发登录未做浏览器级验证。

## 2. 引擎鉴权

- `requiresEngineAuth`：`SONIC_RUNTIME=linux-engine` 时 `/api*`、`/proxy`、`/palette` 全部要求 `X-Sonic-Engine-Key`；不信任 Host/X-Forwarded-Host。
- 密钥缺失或短于 32 字符时拒绝（503），不降级放行。
- CI Docker smoke 验证：无密钥 401、带密钥健康 200（run 40874656070）。

## 3. SSRF 与代理（SONIC-P0-06）

**覆盖入口**

| 入口 | 使用 safeFetch | 备注 |
|---|---|---|
| `functions/api/music/stream.ts` | 是 | 3 跳重定向、15s、256MB、媒体类型白名单 |
| `functions/api/sonic/forward.ts` | 是 | 服务端转发 |
| `functions/api/music/cover.ts` | 是 | 图片代理，拒绝 SVG |
| `functions/proxy.ts` | 是 | 通用代理 |
| `functions/palette.ts` | 是 | 封面取色 |
| `functions/_lib/sonic/native-protocols.ts` | 是 | 原生协议解析 |

**机制**

- DNS 解析在 Node 侧注入（`setSafeFetchHostResolver`），每次重定向重新解析并校验。
- 阻断 loopback、私网、链路本地、IPv4-mapped/translated IPv6 等变体。
- 剥离客户端凭据与 Sonic 身份头；限制重定向次数、超时、响应大小。
- 非音频 `Content-Type` 返回 415，不中转 HTML/SVG。

**测试**：`tests/ssrf-security.test.ts` 9 例 + `tests/security-hardening.test.ts` 26 例，全部通过；覆盖 IPv6 变体、协议/端口、重定向跨域、重定向循环、超时、响应体停滞、凭据剥离、超大响应。

**残余风险**：真实 CDN 的 Range/206、HEAD、客户端断开取消、多跳签名 URL 未做实流联调。

## 4. 缓存边界（本次修复）

**问题**：`stream.ts` 对成功响应固定写入 `Cache-Control: public, max-age=600`，会覆盖上游 `private`/`no-store`；带 `auth/token/vkey/sign/expires/guid` 等参数的签名 URL 可能进入共享缓存。

**修复**（`functions/api/music/stream.ts`）：

1. 上游 `no-store` → `no-store`；
2. 上游 `private` → 原样透传；
3. 目标 URL 命中敏感参数（auth/token/key/sign/vkey/guid/expires/session/cookie/uid 等）→ `private, no-store`；
4. 其余公开 CDN 音频维持 `public, max-age=600`。

**测试**：新增 2 例（private 透传、签名 URL 私有化），`test:security` 98 例通过。

**残余风险**：敏感参数判定为启发式；新增 provider 参数名需同步；CDN 实际缓存行为需在 staging 验证。

## 5. 敏感信息与日志

- Node access log 仅记录 method/path/status/duration/requestId，不记录 query、Cookie、Header。
- 健康端点不返回密钥、Cookie 值，仅返回布尔配置状态。
- 本次仅在本地创建过测试用 `.env` 与临时密钥，验证后已删除；未提交任何凭据。
- 仓库 `.gitignore` 覆盖 `.env`、`*.sqlite`、`data/` 等。

## 6. 第三方内容授权（SONIC-P0-07，OPEN）

以下事项**无法由代码测试替代**，需项目负责人/法务确认：

| 类别 | 来源 | 当前默认 | 待确认 |
|---|---|---|---|
| 音源 | NetEase / QQ / Kugou / Kuwo | 前三个启用，Kuwo 视配置 | 各平台 ToS、缓存与转发授权、地区限制 |
| 歌词 | AMLL / LRCLIB / Lyriva / GDStudio | AMLL、LRCLIB 启用；Lyriva/GDStudio 关闭 | 歌词版权与再分发许可 |
| VIP 解锁 | `SONIC_ENABLE_UNBLOCK` | 0（关闭） | 不得开启 |
| 封面 | 各平台 CDN | 随音源 | 缓存与展示授权 |
| 依赖许可 | GSAP 标准许可、BSD（SBOM 标记） | — | 人工复核分发方式 |

**结论**：授权范围未确认前，P0-07 保持 OPEN，发布结论必须为 NO-GO。

# 2026-11-06 后端安全加固记录（冻结/公测前）

## 结论

本轮审计发现并修复了两个可直接影响公测访问控制的 P0 缺陷，以及一个可被匿名请求触发的全局可用性缺陷。修复后：

- `npm run typecheck` 通过；
- `npm test` 全量通过（200 jiti + 189 security Vitest + 263 beta；含新增路径/熔断/配额回归用例）；
- `pnpm --dir player test` 128 例通过（含新增桥接 origin 用例）；
- `npm run lint`、`npm run build`、`npm run build:engine`、`npm run verify:pages-deploy` 通过；
- 使用固定版本 wrangler 4.157.0 重新生成 Pages Worker 后，真实 HTTP 探测确认大小写变体不再绕过门禁、事件配额返回 429。

## P0 修复

### 1. 路径大小写绕过访问门禁（Critical）

**根因**：Cloudflare Pages 的 Functions 路由大小写不敏感（生成的 worker 使用 `path-to-regexp`，未设置 `sensitive`，flags 为 `i`），而 `requireAccess` / `requiresEngineAuth` 使用原始路径做大小写敏感的前缀判断。`/API/...` 不以 `/api/` 开头，被当作静态资源放行，随后仍被路由到 API handler。

**修复**：新增 `canonicalPolicyPath()`（`functions/_lib/sonic/security.ts`），对策略判断路径做解码、去尾斜杠、转小写；`requireAccess`（`access.ts`）与 `requiresEngineAuth`（`security.ts`）统一使用。`_middleware.ts` 的 health 豁免也改用规范路径。

**验证**（重建 Worker 后真实请求）：

| 请求 | invite 模式 | open 模式 |
| --- | --- | --- |
| `/api/sonic/recommend/trending` | 401 | — |
| `/API/sonic/recommend/trending` | 401 | — |
| `/Api/sonic/recommend/trending` | 401 | — |
| `/API/sonic/events` | 401 | — |
| `/api/sonic/engine/health`（无 Key） | 401 | 401 |
| `/api/Sonic/Engine/Health`（无 Key） | 401 | 401 |
| `/API/Sonic/Engine/Health`（无 Key） | 401 | 401 |
| `/Api/Sonic/Engine/Health`（带 Key） | — | 200 |

### 2. 匿名请求投毒全局熔断（High）

**根因**：`callLocalEngineJson` 把引擎 401/403 计为熔断失败，`/api/access/status` 又是公开路径，**3 个匿名请求**即可让共享熔断器 OPEN 30 秒；502 还会立即跳闸。

**修复**（`functions/_lib/sonic/local-engine.ts`）：

- 4xx 一律视为“引擎可达的正常回答”，不计失败；
- 仅 Cloudflare 52x/530（隧道/源站不可达）保留立即跳闸，移除 502；
- `EngineIdentityError` 是配置错误，不计熔断；
- 流式与 JSON 两条路径行为一致。

**验证**：5 次匿名 401 后 `circuit.state=CLOSED`、`consecutiveFailures=0`，随后 `/api/playlist/detail` 仍能到达引擎。

### 3. 引擎运维端点暴露

- health/metrics 新增独立限流（`evaluateGatewayRateLimit`），`POST metrics?action=test-alert` 不再是无界操作；
- 引擎透传响应的 `Cache-Control` 不再被强制改为 `public, max-age=1800`，只透传引擎显式声明的 public 指令，否则 `private, no-store`；
- `/api/mv/url` 的签名 CDN URL 改为 `private, no-store`。

## P1 修复

| 项 | 修复 |
| --- | --- |
| 邀请码比较 | `hashInviteCode(...) === codeHash` → `timingSafeEqualStr` |
| Staging 开放重定向 | `Location` 折叠前导斜杠，`//evil.example` 不再跨站 |
| 原型链查询 | `PINYIN_QUERY_REWRITES` 增加 `hasOwnProperty` 判断，`q=constructor` 不再注入函数 |
| 推荐参数 | `title/artist/album/genre/seed*/exclude` 统一截断；`exclude` 限制 100 项 |
| 曲库污染 | 客户端 genre 只允许映射到 `GENRE_SYNONYMS` 的规范 genre；SQLite `canonical_tracks` 硬上限 100,000，超出后只更新既有行，不再无限增长 |
| 访问会话登出 | `revokeAccessSession` 返回 `{revoked, durable}`；`/api/access/logout` 如实返回撤销状态；OAuth 登出同时清除 `sonic_access` / `sonic_staging_access` 并尝试撤销访问会话 |
| API Key 撤销 | 存在 `SONIC_KEY_REVOCATION_KV` 时默认启用撤销（`SONIC_ENABLE_KEY_REVOCATION` 默认 true）；`.env.example` 更新 |
| forward 代理 | 按 `type` 限制响应大小：audio 128MB、cover 16MB、其它 8MB |
| radar 响应 | 不再回显确定性邮箱哈希 `subjectKey` |

## 部署/验收改动

- `scripts/verify-deployed-release.mjs` 新增负向鉴权探测：
  - 匿名 `/api/sonic/engine/health`、`/API/...`、`/Api/...` 必须 401/403；
  - invite 模式下匿名 `/api|API|Api/sonic/recommend/trending` 必须 401/403。
- `docs/release/RELEASE-CHECKLIST.md` 增加 B10/B11 与部署后大小写冒烟项。
- `package.json` 的 `test` / `test:security` 纳入 `tests/security-route-hardening.test.ts`。

## 新增回归测试

`tests/security-route-hardening.test.ts`（21 例）：路径规范化、invite 大小写、引擎鉴权大小写、staging 重定向、熔断 4xx/502/530、原型链、访问会话撤销状态、Key 撤销默认开关。

## 第二轮补充（公测前）

| 项 | 修复 |
| --- | --- |
| 桥接跨站指令/数据广播 | `player/src/utils/sonicBlogBridge.ts` 新增 origin allowlist：只接受同源、`https://blog.shijianus.com` 或 `VITE_SONIC_BRIDGE_ORIGINS` 中显式配置的 origin；广播只向 allowlist 中的 origin `postMessage`，不再使用 `'*'`。`player/.env.example` 已补充配置说明。 |
| Provider 重定向 SSRF/Cookie 泄露 | `native-protocols.ts` 新增 `fetchProviderUrl`：逐跳 `redirect:'manual'`、仅允许 HTTPS provider 域名族、跨 origin 时剥离 Cookie/Authorization/X-Real-IP、最多 3 跳。`nativeFetch` 使用该函数；`upstream.ts` 的 catalog `timedFetch` 改为 `redirect:'error'`。 |
| 匿名事件刷量 | `events.ts` 新增写入配额：每 IP 4,000 events/min、每匿名 subject 600 events/min，超出返回 429 + `Retry-After`；桶数有界（4096）。 |
| 部署可复现 | `wrangler@4.157.0` 固定为 devDependency；`deploy-pages.mjs` 使用 `npx --no-install wrangler`，部署时不会静默下载不同版本的 router/runtime。 |

## 仍需在公测前人工确认的残余项

1. **Cloudflare 原生 `RATE_LIMITER` 绑定**：生产默认要求；未绑定时 API/health 会 fail-closed 503。本轮未在代码中放宽该要求。
2. **API Key 轮换撤销**：只有绑定 `SONIC_KEY_REVOCATION_KV` 才能真正撤销旧 Key；未绑定时旧 Key 仍可用至 30 天 TTL。公测前应绑定 KV，或明确接受该风险并缩短 TTL。
3. **匿名事件刷量（残余）**：写入配额已限制单 IP/单 subject 的放大倍数，但 `X-Sonic-Anon-Id` 仍是客户端自证；轮换 IP + 匿名 ID 的 Sybil 仍可影响全局热度/共现。彻底解决需要服务端签发匿名凭证或仅用认证用户参与全局聚合，属于产品级改造。
4. **桥接 origin 配置**：默认只允许同源与 `https://blog.shijianus.com`；其它博客/集成域名必须在构建时显式加入 `VITE_SONIC_BRIDGE_ORIGINS`，不存在通配符。
5. **`timedFetch` 与 legacy `music.ts`**：`upstream.ts` 已禁止跟随重定向；`functions/_lib/music.ts` 的遗留聚合路径仍使用默认 `follow`，但其请求头不携带用户会话 Cookie，风险较低，建议后续统一。
6. **熔断器仍为全局**：匿名的 4xx/502 触发向量已关闭，但未按路由组拆分；后续可将 breaker key 按 endpoint group 隔离。


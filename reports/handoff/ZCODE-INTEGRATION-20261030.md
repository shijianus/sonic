# ZCode 集成交接 — agy 后端加固回合并入 RC

- 环境：Windows 11 / ZCode / DeepSeek V4.1 Flash
- 时间（UTC）：2026-10-30T13:07:44Z
- 分支：`rc/sonic-20261031`
- 集成前 HEAD：`20e399f846a7a306f5f28434d5809aa9fa4f5fb2`
- 集成后 HEAD：`e0adb20755f0fe38494c517addb0ce9d273fb6a6`
- 远端默认分支：`main`（**不存在 `master`**）

## 1. Git 协作事实

| 项 | 结果 |
|---|---|
| `git fetch origin --prune` | 新增 `work/agy-20261031`、`work/agy-release-20261031` |
| 我方未推送提交 | 无（HEAD 与 `origin/rc/sonic-20261031` 同 SHA） |
| 分叉情况 | 无分叉；`20e399f` 是 `e0adb20` 的严格祖先 |
| 集成方式 | `git merge --ff-only origin/work/agy-release-20261031` — 快进，零冲突，未覆盖任何一方提交 |
| 使用的破坏性命令 | 无（未用 reset/clean/restore/force-push，未 stash） |

agy 两个提交：`4fb8e79`（后端 P0/P1 加固，46 文件）与 `e0adb20`（回滚手册与演练证据）。

## 2. 本轮独立验证（Windows 环境，非引用 agy 结论）

全部在集成后的 `e0adb20` 工作树上实际执行：

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 根类型检查 | `npx tsc --noEmit` | 0 错误 | 0 |
| 全量根测试 | `npm test` | Vitest 10 文件 **142 例全通过**；jiti 套件通过 | 0 |
| Lint | `npm run lint` | 主题基线 430 项既有；ESLint 0 | 0 |
| 前端构建 | `npm run build` | `player/dist` → `dist/` 成功 | 0 |
| 浏览器 E2E | `E2E_CHANNEL=chrome pnpm --dir player exec playwright test` | **24/24 PASS**（桌面 20 + 移动 4，4.8 分钟） | 0 |

补充执行（同一工作树）：

| 检查 | 命令 | 结果 | exit |
|---|---|---|---|
| 引擎构建 | `npm run build:engine` | `dist-server/index.mjs` 816.3kb | 0 |
| 可观测性自检 | `npm run test:observability` | `ok:true`，`redactionVerified:true`，`alertDelivered:true` | 0 |
| 引擎鉴权冒烟 | 本地 `dist-server` + curl | 无 Key 401；带 Key 200 且 `releaseCommit` 回显；匿名 `/api` 401；伪造 Host 401；静态首页 200 | — |
| 默认/演示凭据扫描 | grep `functions`/`server`/`.env.example` | 无默认管理员或演示口令；未提交 `.env`/`.dev.vars` | — |

唯一命中的硬编码常量是 `NETEASE_EAPI_KEY`（网易公开协议常量，非本项目机密，且 NetEase 源已被授权策略关闭）。

未执行（NOT RUN）：Docker 本地构建（本机未运行）、真机与真实 OAuth 联调。

## 2.1 远端 CI

- 代码 SHA `4bf253a`（集成 + 文档）：[run 41060939932](https://github.com/shijianus/sonic/actions/runs/41060939932) — **success**
  - Typecheck, lint, tests and build：success
  - Docker build and runtime smoke test：success
  - Browser E2E (mocked gateway, real media element)：success
- 上一成功：`40986753701`（`20e399f`）、`40986077957`（`d29a32f`）。

> 本文件若在 `4bf253a` 之后有追加提交，均为纯文档变更，不改变上述代码门禁结论。

## 3. 对 agy 证据的核验（非复跑）

AGY 声称的 Staging 与回滚结论来自 `reports/handoff/evidence/*.json`。本轮**未复跑**这些远程动作，
仅做证据一致性核验：

- `staging-and-rollback-20261030.json`：匿名 401、`X-Robots-Tag: noindex`、`strict-allowlist`、
  `oauthEnabled=false`；`syn-440hz` 192,044 字节，三段 206 切片 `byteExactMatch: true`，416 正常；
  未授权源与 SSRF Metadata 分别 403/400；回滚 RTO **2,406 ms**、RPO **0**、前向恢复 1,756 ms。
- 证据含真实 Pages Deployment ID、Docker digest、Tunnel ID，且明确 `productionProjectTouched: false`。

**结论口径**：这些是 agy 环境的一次性实测记录，可作为受控内测依据；若负责人要求，应在发布前
由第二环境复跑一次核心链路。不得把它们表述为“Windows 环境已验证”。

## 4. 集成后的真实门禁状态

| 门禁 | 状态 | 说明 |
|---|---|---|
| P0-05 真实 OAuth 闭环 | **BLOCKED** | 缺 Epomail 真实客户端凭据与测试账号；Staging 以 `SONIC_ENABLE_OAUTH=0` 服务端拒绝（403） |
| P0-06 真实 CDN Range/206 | **PARTIAL** | 第一方 CC0 合成音源经真实 Pages→Tunnel→Engine 链路 200/206/416 全部 PASS；商业第三方 CDN 仍 BLOCKED（依赖授权） |
| P0-07 内容授权 | **BLOCKED** | 法务未书面确认；已用 `strict-allowlist` 服务端强制关闭未授权源 |
| P1-03 可观测性与告警 | **CLOSED（agy 环境）** | metrics 端点、脱敏、Webhook 实测送达 |
| P1-04 Staging 部署与回滚 | **CLOSED（agy 环境）** | 双向回滚演练 RTO 2.4s / RPO 0 |
| P1-05 真机与无障碍 | **PARTIAL** | 自动化 a11y 24 例含 3 例通过；真机与人工签字 NOT RUN |
| 版本追踪 | **CLOSED** | `X-Sonic-Release` 与 `/api` 的 `releaseCommit` 实测为部署 SHA |

## 5. 前端与登录现状（本轮实测结论）

- `player/src` 中**没有任何** `/api/auth/login` 调用，也**不存在**登录页面组件；
  登录相关 i18n 字符串来自上游 NCM 客户端残留，未被任何视图引用。
- `SONIC_REQUIRE_AUTH` 默认 `0`（`.env.example`），因此受控内测实际是**匿名 + 限流**模式。
- 影响：关闭 OAuth 时前端不会出现“点了必 403 的登录按钮”，降级是干净的；
  但同时也意味着**产品当前没有用户登录/账号会话 UI**。
  对“仅开放合成音源的受控内测”不构成阻断；对“开放账号体系”构成阻断，需单独立项。

## 6. 结论

- **面向公众 / 开放商业音源的正式发布：NO-GO。** 阻断项为外部依赖：OAuth 真实账号、
  商业音源法务授权、真机人工验收。
- **仅开放第一方 CC0 合成音源的隔离受控内测：CONDITIONAL GO（服务端与前端均已就绪）**，
  前提是保持 `SONIC_STAGING_ACCESS_TOKEN`、`noindex`、`strict-allowlist`、`SONIC_ENABLE_OAUTH=0`、
  `SONIC_REQUIRE_AUTH=0` 与分布式限流策略。
- 生产部署、生产迁移与密钥轮换**未执行，且未获批准**，本轮仅做了本地构建、测试与只读核验。

## 7. 下一轮最短可执行动作

1. 负责人提供 Epomail OAuth 测试凭据与账号 → 关闭 P0-05。
2. 负责人/法务书面确认可开放音源 → 更新 `SONIC_ALLOWED_SOURCES`，关闭 P0-07。
3. 在获批的隔离 Staging 复跑核心链路（匿名门禁、搜索、200/206/416、403/429/降级、回滚）。
4. 真机与跨浏览器人工验收（P1-05）后，重新评估是否对公众 GO。

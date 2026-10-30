# Windows / ZCode 交接 — Sonic RC 2026-10-31

- UTC 更新时间：2026-10-30T01:31:03Z
- 当前分支：`rc/sonic-20261031`
- 当前代码 SHA：`d29a32ff61caef96507176325f9b5e296360e3f4`
- 基线 SHA：`1d45e4cb38f6346f9a964d31fdba421c01d5e28b`
- 上一验收 SHA：`bb5183c`（CI run 40980948598 success）
- 本轮新增代码 SHA：`45b9a5e`、`d29a32f`
- 分支关系：`release/rc-20261031` 是基线；协作方已建立 `rc/sonic-20261031` 并在其上完成前端竞态、E2E 与 CI 工作。
  本文件所在分支为 `rc/sonic-20261031`，不覆盖、不强推任何协作提交。

## 1. 本轮已完成（实际提交）

| 任务 | 结果 | 证据 |
|---|---|---|
| 核对远端 HEAD 与审计基线 | 完成 | 审计基准 `main@3eb34dd` 落后 RC 53+ 提交，旧 P0-A/B/C/D 已在 RC 修复 |
| SSRF/开放代理边界收紧 | 完成 `45b9a5e` | 移除 `qq.com`/`163.com` 顶点域，保留音乐 CDN；新增 2 条负向测试 |
| 环境变量名漂移 | 完成 `d29a32f` | 旧名 `SONIC_ENABLE_FREE_MATCH` 兼容读取，新名优先；测试锁定 |
| 版本/UA 统一 | 完成 `d29a32f` | 根 2.2.0、player 2.2.0、UA `Sonic/2.2.0` |
| README 内测范围与 P95 口径 | 完成 `d29a32f` | 明确未验证项；P95 限定为离线合成库基准 |
| 发布门禁文档 | 本文件及同目录三份 | — |

## 2. 已验证（实际命令与结果）

| 命令 | 结果 | exit |
|---|---|---|
| `npm run typecheck` | 根 0 错误；Player `vue-tsc` 0 错误 | 0 |
| `npm run lint` | 主题基线 430 项为既有；ESLint 0 | 0 |
| `npm test` | gateway 60 / auth 43 / cover 15 / engine 49；Vitest 9 文件 129 例 | 0 |
| `pnpm --dir player test` | 8 文件 38 例 | 0 |
| `E2E_CHANNEL=chrome pnpm --dir player exec playwright test` | 24/24 PASS（桌面 20 + 移动 4） | 0 |
| `npm run build` | `dist/` 生成 | 0 |
| `npm run build:engine` | `dist-server/index.mjs` 生成 | 0 |
| 引擎鉴权 curl 冒烟 | 带 Key 200；无 Key 401；伪造 Host 401；首页 200；无 Key API 401 | — |
| 真实上游取流（本地引擎） | NetEase/QQ/Kugou/Kuwo 均 `404 unavailable`；搜索 200 | 未通过 |

E2E 使用 `player/e2e/mock-server.mjs` 与本地 WAV，**不等同于真实 CDN/OAuth**。

## 3. 远程交付

- Branch：`rc/sonic-20261031`（已推送 `bb5183c..d29a32f`）
- PR：**未创建**。当前环境没有 `gh` CLI，且 GitHub 管理员权限未确认；可用 compare 链接人工创建：
  `https://github.com/shijianus/sonic/compare/release/rc-20261031...rc/sonic-20261031`
- CI：`https://github.com/shijianus/sonic/actions/runs/40986077957`（`d29a32f`）— **success**
  - Typecheck, lint, tests and build：success
  - Docker build and runtime smoke test：success
  - Browser E2E (mocked gateway, real media element)：success
- 上一成功 CI：`https://github.com/shijianus/sonic/actions/runs/40980948598`（`bb5183c`）
- 标签：未创建 `v2.2.0-rc.2`；发布标签必须在 GO 后由负责人创建

## 4. 本轮实际修改文件

```
functions/_lib/sonic/security.ts
tests/ssrf-security.test.ts
functions/_lib/sonic/config.ts
functions/_lib/types.ts
functions/_lib/music.ts
functions/_lib/sonic/providers/kugou.ts
player/package.json
package.json
.env.example
README.md
tests/config-parity.test.ts (新增)
docs/release/RC-SUMMARY.md (新增)
docs/release/HANDOFF-WINDOWS.md (新增)
docs/release/RELEASE-CHECKLIST.md (新增)
docs/release/DECISIONS.md (新增)
```

## 5. 风险、兼容与回滚

| 风险 | 说明 | 回滚 |
|---|---|---|
| 白名单收紧导致未知 CDN 400 | 仅使用仓库已登记的 `*.y.qq.com`、`*.qqmusic.qq.com`、`*.music.163.com` 等 | revert `45b9a5e` |
| 旧 Key 全部失效 | v2 之前格式无签名/有效期，无法安全兼容；用户需重新登录 | 无安全回滚；属预期迁移 |
| OAuth 未真实联调 | 不得关闭 state/PKCE 或恢复 URL 传 Key | 修复而非回退安全逻辑 |
| E2E 为 Mock | 不能证明真实 CDN/206/OAuth | 需 Staging 真实链路 |
| 真实取流在本环境不可用 | 版权/地区/上游限制；搜索结果正常 | 不作为代码回滚依据，需授权测试源与 Staging |
| 错误 Toast 叠加 | 连续自动切歌失败时多个错误提示同时存在（手测观察） | 后续去重/合并，不阻断安全门禁 |

## 6. 阻塞与所需输入

1. Epomail 真实测试账号 + Staging 域名（P0-05）。
2. 授权测试音源与 CDN（P0-06）及逐源授权/ToS 结论（P0-07）。
3. Staging 部署凭据、访问控制方案、回滚演练授权（P1-04）。
4. 监控告警方案/凭据（P1-03）。
5. iOS Safari / Android Chrome 真机（人工）。

## 7. 下一位 Agent 从哪里开始

- 起点 SHA：`d29a32f`（本文件提交后以最新 docs commit 为准）。
- 先做：确认 CI `40986077957` 结论；若 success，继续推动负责人提供 Staging/OAuth/授权输入，
  不重复修改已闭环的认证/SSRF 代码。
- 不要在未获书面授权与访问控制前部署 Preview/生产。
- 发布判断保持 **NO-GO**，直到 `RELEASE-CHECKLIST.md` 全部硬门禁 PASS。

## 8. 计划但未完成

- 真实 OAuth 联调、真实 CDN Range/206、Staging 部署、回滚演练、真机验收、metrics/告警、
  健康端点 release SHA 字段。
- 错误 Toast 合并、hash 路由直链策略评估（当前 `/#/search` 可用，裸 `/search` 回落首页）。

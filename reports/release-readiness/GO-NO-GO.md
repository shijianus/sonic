# Sonic Release Gate — GO / NO-GO

- 评估时间：2026-10-29
- Candidate branch：`fix/release-readiness-20261029`
- Candidate SHA：`bd1a97f`（报告提交后以最终 SHA 为准）
- CI：[run 40877176265](https://github.com/shijianus/sonic/actions/runs/40877176265) — **success**
  - Typecheck, lint, tests and build：success
  - Docker build and runtime smoke test：success
  - 容器重建持久化步骤：success
- Docker image digest：CI 运行时生成，本次未导出；发布前需在 staging 记录
- Cloudflare Pages artifact / deployment id：**无**（未部署）
- **Recommendation：NO-GO**

## 1. 门禁结果

| Gate | 结果 | 说明 |
|---|---|---|
| P0 全部关闭 | **否** | 3 项未完全闭环（见下） |
| CI 全绿 | **是** | 质量、Docker 与容器持久化步骤均 success |
| 类型检查/构建 | **是** | 本地与 CI 均通过 |
| 数据可持久化 | **是** | 应用层重启/备份恢复 + CI 容器重建保留均通过 |
| 凭证无泄漏 | **是（本次范围）** | 无生产凭据使用；测试 `.env` 已删除；日志无 query/header |
| 内容授权确认 | **否** | 音源/歌词/封面 ToS 未确认 |
| 可回滚 | **未验证** | 仅文档，未演练 |
| 核心人工验收 | **否** | 真机、真实 OAuth、真实音源未执行 |

## 2. P0 状态

| ID | 状态 | 证据 | 负责人/确认 |
|---|---|---|---|
| SONIC-P0-01 `httpGet`/CI | **CLOSED** | 干净检出 741→0 errors；CI success；`c44bd02` | 代码验证完成 |
| SONIC-P0-02 干净构建 | **CLOSED（CI）** | Docker job success；多阶段无预置 dist | CI runner |
| SONIC-P0-03 数据卷/持久化 | **CLOSED** | Compose 卷映射 + CI 同名卷容器重建 `eventCount=1`（run 40877176265） | CI runner |
| SONIC-P0-04 持久化故障模式 | **CLOSED** | fail-closed 退出码 1；健康 503；`418f63c` | 代码+测试完成 |
| SONIC-P0-05 OAuth 真实闭环 | **OPEN** | 18 例自动化通过；无真实账号 | 待项目负责人提供账号 |
| SONIC-P0-06 SSRF/缓存/Range | **OPEN（实流）** | 缓存修复 `ccd63e5`；SSRF 测试通过；真实 CDN Range/206 未验证 | 待 staging/测试音源 |
| SONIC-P0-07 内容授权 | **OPEN** | 无逐源授权证据 | 项目负责人/法务 |

**P0 未完全关闭：3 项（P0-05、P0-06、P0-07）。**

## 3. P1 状态

| ID | 状态 | 缺口 |
|---|---|---|
| SONIC-P1-01 竞态 | PARTIAL | 代码守卫存在；无浏览器级竞态 E2E |
| SONIC-P1-02 错误降级 | PARTIAL | 单测覆盖；异常 UI 未 E2E |
| SONIC-P1-03 可观测性 | OPEN | 无 metrics/告警 |
| SONIC-P1-04 staging/回滚 | OPEN | 未部署、未演练 |
| SONIC-P1-05 真机/OAuth/无障碍 | NOT RUN | 无设备/账号 |

**P1 未完成：5 项。**

## 4. 本次实际完成

- 修复干净检出 `typecheck` 失败（CI P0-01），并在本地复现 741 个错误作为前后对比。
- 生产 SQLite 持久化 fail-closed，健康检查不再伪报；新增 4 个回归用例。
- 音频代理缓存策略修正：尊重上游 `private/no-store`，签名 URL 不进入共享缓存。
- 本机真实引擎进程完成“写入 → 重启 → 备份 → 模拟丢失 → 恢复”演练；CI 完成同名卷容器删除/重建后 `eventCount=1` 验证。
- 全部本地质量门禁通过：typecheck、lint、98 security、43 auth、49 engine、25 recommend、33 player、build、双端依赖审计、SBOM。
- 远端 CI 质量、Docker 与容器持久化步骤在 `bd1a97f` 全部成功。

## 5. 阻断 GO 的事项（必须人工完成）

1. 在 staging 完成完整部署与 Pages/引擎双向回滚演练，记录 RTO/RPO。
2. 使用真实测试账号完成 OAuth 登录/刷新/退出/撤销闭环。
3. 使用授权测试音源验证 Range/206 拖动、切歌竞态、403/429/断网降级。
4. 确认生产备份频率、异地保存、磁盘告警与值班响应。
5. 逐源确认音源、歌词、封面授权/ToS，未确认源默认关闭。
6. 接入 5xx/P95/健康/存储错误告警。
7. 桌面三浏览器 + 移动真机 + 无障碍人工验收。

## 6. 签署

```markdown
# Sonic Release Gate
- Candidate branch: fix/release-readiness-20261029
- Candidate SHA: bd1a97f (code+CI verified; report commit follows)
- CI URL and conclusion: https://github.com/shijianus/sonic/actions/runs/40877176265 — success (bd1a97f)
- Docker image digest: PENDING (record at staging)
- Cloudflare Pages artifact / deployment id: NONE (not deployed)
- P0 open count: 3 (P0-05 real account, P0-06 live stream, P0-07 licensing)
- P1 open count and exceptions: 5
- Security regression: PASS (98 security tests; cache fix verified)
- Data backup/restore result: PASS (app-level restart/backup/restore; CI container recreation)
- Cross-browser / mobile smoke: NOT RUN
- Source/lyrics licensing review: NOT DONE
- Monitoring and rollback drill: NOT DONE
- Known limitations: see FINDINGS.md
- Recommendation: NO-GO
- Human approver and time: ____________________
```

> 本结论由自动化整改过程给出，**未经人工批准不得部署生产**。只有上述阻断项全部关闭并由负责人签字后，才可重新评估 GO。

---

# 2026-10-30 RC 更新（rc/sonic-20261031）

- 基线：`1d45e4c`（承接 2026-10-29 NO-GO）
- Windows 工作分支：`work/zcode-20261031` @ `5f97383`
- CI：https://github.com/shijianus/sonic/actions/runs/40977983806 — **success**
  - quality（typecheck/lint/tests/build）：success
  - Docker build + runtime smoke：success
  - Browser E2E（新增）：success
- 本地：typecheck/lint PASS；player 38 tests PASS；root 123 tests PASS；E2E 24 PASS。

## 新增闭环

| ID | 旧状态 | 新状态 | 证据 |
|---|---|---|---|
| SONIC-P1-01 搜索/切歌竞态 | PARTIAL | **CLOSED（Mock 浏览器层）** | `player/e2e/specs/resilience.spec.ts`、`core.spec.ts`（含快速改搜索词） |
| SONIC-P1-02 异常降级 | PARTIAL | **CLOSED（Mock 浏览器层）** | 403/429/断网/异常 JSON/空结果用例 |
| SONIC-P1-05 无障碍 | NOT RUN | **PARTIAL（自动化）** | `a11y.spec.ts`、移动端可访问名称 |

本轮修复的真实缺陷：暂停后迟到取流恢复播放、过期请求覆盖新状态、切歌中断误报、
网络中断误判为音源错误、搜索上游失败伪装为空结果、加载中无法取消、歌词过期回调。

## 仍未闭环（维持 NO-GO）

- P0-05 真实 OAuth：无真实账号与 Staging。
- P0-06 真实 CDN Range/206：只有 Mock WAV。
- P0-07 音源/歌词/封面授权：无逐源证据。
- P1-03 指标与告警：未接入。
- P1-04 Staging 与回滚演练：未部署、未演练。
- P1-05 真机/跨浏览器人工验收：未执行。
- 运行版本追踪：健康端点尚未暴露 release SHA/version。

**Recommendation：NO-GO（维持）。** 本 RC 的可发布性取决于 §1 阻断项；
在上述真实环境证据关闭前，不得对公众发布，也不得宣称受控内测已完成。

---

# 2026-10-30 集成交叉验证（`rc/sonic-20261031` @ `e0adb20`）

- 集成动作：`git merge --ff-only origin/work/agy-release-20261031`，零冲突，未覆盖任何一方提交。
- 集成内容：agy 后端加固 `4fb8e79`（46 文件）与回滚手册/演练证据 `e0adb20`。
- Windows 环境独立复跑：`tsc --noEmit` 0 错误；`npm test` **142 例通过**；`npm run lint` 0；
  `npm run build` 成功；Playwright **24/24 PASS**。
- 详细交接：`reports/handoff/ZCODE-INTEGRATION-20261030.md`。

## 状态变更

| ID | 旧状态 | 新状态 | 依据 |
|---|---|---|---|
| P1-03 可观测性与告警 | OPEN | **CLOSED（agy 环境）** | metrics 端点 + 脱敏 + Webhook 实测送达 |
| P1-04 Staging 与回滚 | OPEN | **CLOSED（agy 环境）** | 回滚 RTO 2,406 ms / RPO 0 / 前向恢复 1,756 ms |
| P0-06 真实 Range/206 | OPEN | **PARTIAL** | 第一方 CC0 音源经真实 Pages→Tunnel→Engine 链路 200/206/416 PASS；商业 CDN 仍 BLOCKED |
| 运行版本追踪 | OPEN | **CLOSED** | `X-Sonic-Release` 与 `/api` `releaseCommit` 等于部署 SHA |
| P0-05 真实 OAuth | OPEN | **BLOCKED（未变）** | 缺真实凭据与账号；Staging 以 403 服务端拒绝 |
| P0-07 内容授权 | OPEN | **BLOCKED（未变）** | 缺法务书面确认；已 `strict-allowlist` 强制关闭 |

## 结论不变的部分

- 对公众发布：**NO-GO**。P0-05、P0-07 为外部人工依赖。
- 前端不存在登录页与 OAuth 调用入口，受控内测为匿名 + 限流模式（`SONIC_REQUIRE_AUTH=0`）；
  关闭 OAuth 时无“点击必失败的登录按钮”，降级干净，但产品当前**没有账号会话 UI**。
- 受控内测（仅第一方合成音源）：服务端与前端均就绪，可作为 **CONDITIONAL GO** 候选，
  必须保持访问令牌、`noindex`、`strict-allowlist`、`SONIC_ENABLE_OAUTH=0`。

---

# 2026-10-31 Windows 公测冲刺复跑（`work/zcode-beta-20261031-20261031T013704Z` @ `1cc1ac8`）

- 基线：`401dbce`（`origin/rc/sonic-20261031`）。
- 修复：起播挂起 15s 看门狗；503 降级文案不再被同类型泛化 Toast 节流吞掉。
- 新增：404/503/挂起超时 E2E；12 条主要路由 + 路由切换 + 404 + 无登录入口 E2E。
- 复跑：`npm test` 167 jiti + 142 Vitest；player 38；typecheck/lint/build/build:engine 全过；
  Playwright **43/43 PASS**。详细证据：`reports/handoff/evidence/public-beta-windows-20261031.log`。
- 远端 CI：[run 41161277751](https://github.com/shijianus/sonic/actions/runs/41161277751)（`205171e`）—
  **success**（quality / Docker smoke / Browser E2E 三作业）。

## 状态更新

| ID | 旧状态 | 新状态 | 依据 |
|---|---|---|---|
| P1-02 异常降级 | PARTIAL | **CLOSED（Mock 浏览器层）** | 403/404/429/503/断网/挂起超时/异常 JSON 均有 E2E |
| P1-06 起播挂起无限加载 | — | **CLOSED（代码 + Mock E2E）** | 15s 看门狗，超时后停止媒体并提示 |
| 主要路由不白屏 | NOT RUN | **PASS（Mock）** | routes 15 例 |
| 匿名模式登录死入口 | 文档核验 | **PASS（E2E）** | 无登录路由/按钮 |

外部阻断不变：P0-05 OAuth **BLOCKED**、P0-06 商业 CDN **PARTIAL**、P0-07 授权 **BLOCKED**；
真机与人工无障碍仍 **NOT RUN**。

**Recommendation：受控公测 CONDITIONAL GO；公众商业发布 NO-GO。**

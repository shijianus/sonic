# Sonic 上线整改 — R0 事实基线

- 核验日期：2026-10-29（本地时区 UTC+8）
- 仓库：`shijianus/sonic`
- 工作分支：`fix/release-readiness-20261029`
- 起始 HEAD：`81d8886`（integration/main-work-recovery-20261029-141918）
- 整改后 HEAD：`ccd63e5`（R0–R2 代码提交，报告提交另计）
- `origin/main`：`3eb34dd`
- 本地 `main`：`a5e7695`
- `security/audit-round-2026-10`：`dc23084`
- 工作区状态（开始时）：`git status --short` 无输出，干净

## 1. 分支关系

`81d8886` 是 `dc23084`（security 审计分支）与 `origin/main@3eb34dd` 的合并提交，merge-base 为 `a5e7695`。本整改分支从 `81d8886` 切出，未改写任何历史。

## 2. 审计项复核（按当前仓库，不照单全收）

| 审计 ID | 审计快照描述 | 当前事实 | 判定 |
|---|---|---|---|
| SONIC-P0-01 | `httpGet` 未定义，CI #2 10 errors | 在干净检出（移除被 gitignore 的 `player/src/auto-import`）下复现 **741 个 TS 错误**，其中 `Cannot find name 'httpGet'` **61 处**；范围比审计快照更大 | **确认存在**，已修复 |
| SONIC-P0-02 | main Dockerfile 依赖预制 `dist` | 当前候选 `Dockerfile` 已是三阶段构建：frontend（pnpm frozen lockfile 构建）→ engine（esbuild）→ runtime（仅复制产物、非 root）；`.dockerignore` 排除 `dist` | **候选分支已改造**；CI Docker 作业在 `ccd63e5` 成功 |
| SONIC-P0-03 | main Compose 无数据库卷 | `docker-compose.yml` 已配置 `sonic-data:/app/data`，`SONIC_RECOMMEND_DB_PATH` 默认 `/app/data/sonic-recommend.sqlite`；`docker compose config` 退出码 0，卷映射确认 | **配置已存在**；容器重建级验证见 DATA-RECOVERY |
| SONIC-P0-04 | SQLite 不可用可能静默回退内存、就绪探针失真 | `createServerRecommendStore` 原先无条件 catch 后返回 `MemoryRecommendStore`；健康端点固定 `ok:true` | **确认存在**，已修复 |
| SONIC-P0-05 | OAuth state/PKCE/重放/会话 | `login.ts` 生成 256-bit state + S256 PKCE，HttpOnly 事务 Cookie；`callback.ts` 校验 state、PKCE、一次性消费；`tests/oauth-security.test.ts` 18 例 | **机制已实现**；真实账号闭环 **NOT RUN** |
| SONIC-P0-06 | SSRF/重定向/缓存/Range | `safeFetch` 已用于 `stream.ts`、`sonic/forward.ts`、`music/cover.ts`、`proxy.ts`、`palette.ts`、`native-protocols.ts`；Node 侧注入 DNS 解析结果；审计指出的 `Cache-Control: public` 会覆盖上游 `private/no-store` | **部分存在**；缓存策略已修复，Range/CDN 实流 **NOT RUN** |
| SONIC-P0-07 | 音源/歌词版权与 ToS | 仓库无逐源授权证据；`SONIC_ENABLE_UNBLOCK`/`SONIC_ENABLE_GDSTUDIO`/`SONIC_ENABLE_LYRIVA` 默认关闭 | **未解决**，需负责人/法务 |
| SONIC-P1-01 | 搜索/切歌竞态 | 搜索组件已有 `AbortController` + generation 守卫；播放 store 有 `playbackGeneration` 与 `pendingUrlRequests` 去重 | **代码已具备**；浏览器竞态 E2E **NOT RUN** |
| SONIC-P1-02 | 错误降级与 UI 反馈 | `tests/playbackErrors.test.ts`、`queueIntegration.test.ts` 覆盖部分路径 | **部分覆盖**；UI 异常态 E2E **NOT RUN** |
| SONIC-P1-03 | 可观测性 | Node 引擎输出结构化 access log（path/status/duration/requestId），健康端点提供 circuit/存储状态；无指标导出与告警配置 | **未完成** |
| SONIC-P1-04 | staging/回滚 | 无独立 staging 环境记录；本报告给出回滚手册，但未演练 | **未完成** |
| SONIC-P1-05 | 真机/OAuth/无障碍 | 无真实 OAuth 账号、无移动真机执行 | **NOT RUN** |
| SONIC-P2-01 | 非关键动画/推荐排序/新音源 | 未触碰 | 不适用 |

## 3. 已存在、未重复实现的修复

- `safeFetch` 的 SSRF 防护与重定向逐跳校验（`functions/_lib/sonic/security.ts`）。
- OAuth state + PKCE + 一次性 state 消费（`functions/api/auth/login.ts`、`callback.ts`）。
- 引擎 API 强制服务密钥（`checkEngineAccess`，`SONIC_RUNTIME=linux-engine` 时全 API 生效）。
- 多阶段 Dockerfile、非 root 运行、`HEALTHCHECK` 使用环境变量密钥。
- 推荐 SQLite（WAL/FTS5）与 `VACUUM INTO` 一致性备份脚本。

## 4. 证据

- 干净检出 typecheck 失败原文：`reports/release-readiness/evidence/typecheck-clean-checkout-BEFORE.log`
- Docker/Compose：`evidence/compose-config.log`
- CI：<https://github.com/shijianus/sonic/actions/runs/40874656070>（`ccd63e5`，两项作业 success）

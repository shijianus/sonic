# Sonic 上线整改 — 测试结果（TEST-RESULTS）

- 执行环境：Windows 11 10.0.26200 x64，Git Bash
- Node：v24.14.0（CI 使用 Node 22）
- npm：11.9.0；pnpm：10.34.5
- 工作分支：`fix/release-readiness-20261029`
- 代码 SHA：`ccd63e5`（CI 运行 SHA 相同）
- 日志目录：`reports/release-readiness/evidence/`
- 说明：所有结果均为本机真实执行；未执行项明确标 `NOT RUN`。

## 1. 依赖安装

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `npm ci` | 0 | 39 packages，0 vulnerabilities | 终端记录（20:00） |
| `pnpm --dir player install --frozen-lockfile` | 0 | Already up to date | `evidence/pnpm-install-r1.log` |

## 2. 类型检查（P0-01）

| 命令 | 环境 | 退出码 | 结果 | 日志 |
|---|---|---|---|---|
| `pnpm --dir player run typecheck` | 模拟干净检出（移除 `src/auto-import`） | 2 | **FAIL**：741 errors，61× `Cannot find name 'httpGet'` | `evidence/typecheck-clean-checkout-BEFORE.log` |
| `pnpm --dir player run typecheck` | 仅保留纳入版本控制的两份声明 | 0 | PASS | — |
| `npm run typecheck`（tsc + vue-tsc） | 整改后工作区 | 0 | PASS | `evidence/typecheck-r1-after.log` |
| `npm run typecheck` | R2 改动后 | 0 | PASS | `evidence/typecheck-r1-current.log` |

## 3. Lint 与测试

| 命令 | 退出码 | 结果摘要 | 日志 |
|---|---|---|---|
| `npm run lint` | 0 | theme baseline 通过；ESLint 无错误 | `evidence/lint-r1.log` |
| `npm run test:security` | 0 | 7 files / **98 tests passed**（含 OAuth 18、SSRF 9、P0 回归 16、hardening 26、engine 3、XSS 6、security 20） | `evidence/test-security-r2.log` |
| `npm run test:auth` | 0 | **43 passed, 0 failed** | `evidence/test-auth-r1-current.log` |
| `npm run test:engine` | 0 | **49 passed, 0 failed** | `evidence/test-engine-r2.log` |
| `npm run test:recommend` | 0 | **25 tests passed**（新增 3 个 fail-closed 用例） | `evidence/test-recommend-r2.log` |
| `pnpm --dir player test` | 0 | 7 files / **33 tests passed** | `evidence/test-player-r1-current.log` |
| `npm test`（聚合） | 0 | gateway 60 / auth 43 / cover 15 / engine 49 / vitest 8 files **123 tests**，全部通过 | `evidence/npm-test-final.log` |

## 4. 构建与制品

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `pnpm --dir player run build` | 0 | Vite 构建成功；auto-import 声明哈希未变化 | `evidence/build-r1.log` |
| `npm run build` | 0 | SPA 构建 + copy-dist 成功 | `evidence/build-r1.log` |
| `npm run build:engine` | 0 | `dist-server/index.mjs` 726.2 kb | `evidence/build-engine.log` |
| `npm run sbom` | 0 | 99 组件；2 项许可证待人工复核（GSAP 标准许可、BSD） | `evidence/sbom.log` |

## 5. 依赖审计

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `npm audit --omit=dev --audit-level=high` | 0 | 0 vulnerabilities | `evidence/audit-root.log` |
| `pnpm --dir player audit --prod --audit-level=high` | 0 | No known vulnerabilities | `evidence/audit-player.log` |

## 6. 容器（P0-02）

| 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|
| `docker compose config` | 0 | 配置有效；`sonic-data:/app/data` 映射确认 | `evidence/compose-config.log` |
| `docker compose build --no-cache sonic-engine` | 1 | **NOT RUN（环境阻断）**：Docker Desktop 引擎 stopped；`wsl -l -v` 无发行版，Linux 引擎无法启动 | `evidence/docker-build.log` |
| CI `docker build` + 容器启动 + 鉴权健康检查 | 0 | **PASS（远端）**：run 40874656070 / job 123450881570 | <https://github.com/shijianus/sonic/actions/runs/40874656070> |

## 7. 持久化与恢复（P0-03/04）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 以 `/tmp` 临时 SQLite 启动引擎（`NODE_ENV=production`） | 健康 200，`storageKind=sqlite` | `evidence/engine-run1.log`、`health1.json` |
| 匿名健康检查 | 401 | 终端记录 |
| POST 行为事件（`anon_drill_user_001`） | `accepted:1`，`storageKind:sqlite` | 终端记录 |
| 健康统计 | `eventCount=1` | `evidence/health2.json` |
| 终止进程并重启（同一 DB） | `eventCount=1`、`trackCount=59`，200 | `evidence/engine-run2.log`、`health3.json` |
| `VACUUM INTO` 备份 + `integrity_check` | `ok:true`，184320 bytes，tracks 59 / events 1 | `evidence/db-backup.log` |
| 模拟丢失（移走 db/wal/shm）并恢复备份 | `eventCount=1`、`trackCount=59`，健康 200 | `evidence/engine-run3-restored.log`、`evidence/health-after-restore.json` |
| 不可写 DB 路径 + 生产环境启动 | **退出码 1**，`Fatal: Failed to open the persistent recommendation store` | `evidence/engine-failclosed.log` |
| 健康端点伪就绪回归 | 配置持久化路径但 store 为内存 → 503、`ok:false` | `evidence/test-security-r2.log` |

## 8. 远端 CI

| 项目 | 值 |
|---|---|
| Run | [40874656070](https://github.com/shijianus/sonic/actions/runs/40874656070) |
| Branch / SHA | `security/release-readiness-20261029` / `ccd63e5` |
| Event | push |
| 结论 | **success** |
| Typecheck, lint, tests and build | success，0 failed steps |
| Docker build and runtime smoke test | success，0 failed steps |

> 说明：远端分支由环境中已发生的推送创建；本会话未显式执行 `git push`。本地与远端 SHA 一致，CI 结果可直接引用。

## 9. 未执行项（NOT RUN）

| 项目 | 原因 |
|---|---|
| 本地 `docker compose build` / volume 重建保留 | Docker Desktop 引擎无法启动（WSL 无发行版） |
| 容器内持久化重建（up → down → up，不带 `-v`） | 同上；需在 staging/CI 主机执行 |
| 真实 OAuth 账号登录/退出 | 无授权测试账号与生产 redirect 配置 |
| 真实音源播放、Range/206 拖动、切歌竞态 | 无授权测试音源与可用后端链路 |
| 桌面/移动真机、Safari、读屏 | 无设备环境 |
| staging 部署与回滚演练 | 未获准部署，且无独立 staging 环境 |

# Sonic 上线整改 — 数据持久化与恢复（DATA-RECOVERY）

- 核验 SHA：`ccd63e5`
- 数据库：Node 22 `node:sqlite`（WAL + FTS5）
- 生产路径：`SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite`（Dockerfile 默认）
- 卷映射：`sonic-data:/app/data`（`docker compose config` 已确认）

## 1. 配置核验

| 检查 | 结果 | 证据 |
|---|---|---|
| Compose 定义命名卷 `sonic-data` | 通过 | `evidence/compose-config.log` |
| 容器内路径 `/app/data` 由 node 用户拥有 | Dockerfile `chown -R node:node /app/data` | `Dockerfile` |
| 引擎默认 DB 路径 | `/app/data/sonic-recommend.sqlite` | `Dockerfile` ENV |
| 显式 `memory`/`off` 才使用内存 | `server/recommend-sqlite.ts` | 代码 + 单测 |

## 2. 故障模式修复（P0-04）

**修复前**：`createServerRecommendStore` 捕获所有异常并返回 `MemoryRecommendStore`；健康端点固定 `ok:true`。生产磁盘不可写时，服务仍显示健康，重启后行为数据全部丢失。

**修复后**：

- `NODE_ENV=production` 且未显式 `SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK=1` 时，SQLite 打开失败抛出 `RecommendStorePersistenceError`。
- 引擎主入口在 `listen` 前初始化存储，失败打印 Fatal 并 `process.exit(1)`。
- 健康端点：配置了持久化路径但实际 `storageKind=memory`，或读取统计失败时，返回 **503** 且 `ok:false`。
- `memory`/`off` 显式配置仍允许（用于开发/测试）。

## 3. 实测流程与结果

环境：本机 Node v24.14.0，`NODE_ENV=production`，临时目录 SQLite。

### 3.1 写入 → 重启 → 读回

| 步骤 | 结果 | 证据 |
|---|---|---|
| 启动引擎（18081，SQLite） | 200；`storageKind=sqlite`，`eventCount=0` | `evidence/engine-run1.log` |
| 匿名访问健康端点 | 401（符合预期） | 终端记录 |
| POST `favorite` 事件（`X-Sonic-Anon-Id: anon_drill_user_001`） | `accepted:1`，`storageKind:sqlite` | 终端记录 |
| 健康统计 | `eventCount=1` | `evidence/health2.json` |
| 终止进程并用同一 DB 重启 | `eventCount=1`、`trackCount=59`，200 | `evidence/engine-run2.log`、`evidence/health3.json` |

**结论**：进程重启不丢数据。

### 3.2 一致性备份 → 模拟丢失 → 隔离恢复

| 步骤 | 结果 | 证据 |
|---|---|---|
| `node --experimental-sqlite scripts/backup-recommend-db.mjs <db> <backup>` | `ok:true`，`VACUUM INTO` + `integrity_check`，184320 bytes，tracks 59 / events 1 | `evidence/db-backup.log` |
| 停止引擎，移走 `db`、`db-wal`、`db-shm`（模拟主文件丢失） | 主文件仅 4096 bytes，WAL 374952 bytes | 终端记录 |
| 将备份复制回原路径并重启 | `eventCount=1`、`trackCount=59`、`storageKind=sqlite`、`storageHealthy=true` | `evidence/engine-run3-restored.log`、`evidence/health-after-restore.json` |

**结论**：一致性备份可在隔离路径恢复；简单复制正在写入的 DB 不可靠，脚本使用 `VACUUM INTO` 正确。

### 3.3 不可写路径 fail-closed

| 步骤 | 结果 | 证据 |
|---|---|---|
| `NODE_ENV=production` + DB 父路径为普通文件 | 进程退出码 **1** | `evidence/engine-failclosed.log` |
| stderr | `[Sonic Local Engine] Fatal: Failed to open the persistent recommendation store ... EEXIST` | 同上 |

**结论**：不会以内存状态伪报就绪。

## 4. 未执行项（NOT RUN）

| 项目 | 原因 | 建议执行位置 |
|---|---|---|
| 容器 `up → restart → down（不带 -v）→ up` 数据保留 | 本机 Docker Desktop 引擎无法启动（WSL 无发行版） | staging/CI 主机 |
| 容器重建（重新 build 后 `up`）数据保留 | 同上 | staging |
| 生产卷备份定时任务与异地保存 | 未获准触碰生产 | 运维窗口 |
| 磁盘满/只读文件系统故障注入 | 需要容器或可挂载只读卷 | staging |

## 5. RPO / RTO

本次未能由项目负责人确认生产指标。建议值（**待批准**）：

- **RPO ≤ 24h**：每日 `VACUUM INTO` 备份 + 每小时 WAL 归档（如条件允许）。
- **RTO ≤ 30min**：恢复备份、校验 `integrity_check`、重启容器、健康检查 200。

备份保存要求：加密、限制访问、与数据卷分离存放；保留至少 7 个日备份。实际数值须由发布负责人写入 `GO-NO-GO.md` 并签字。

## 6. 残余风险

- 运行中磁盘变为只读时，写入错误会在请求路径暴露；当前无主动磁盘告警。
- WAL 文件与主库需一起管理；恢复时必须先停服务，避免混用旧 WAL。
- 容器级卷保留尚未本机演练，发布前必须在 staging 补做。

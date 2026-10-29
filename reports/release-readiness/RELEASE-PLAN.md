# Sonic 上线整改 — 发布计划（RELEASE-PLAN）

> 本文是**待执行**的发布手册，不代表已部署。本次整改未触碰生产环境、未使用生产凭据、未部署任何环境。

## 1. 候选制品

| 制品 | 来源 | 标识 |
|---|---|---|
| 前端 SPA + 边缘函数 | Cloudflare Pages（仓库根） | 提交 SHA `ccd63e5`（后续仅报告文档变更） |
| Node 引擎镜像 | `Dockerfile` 多阶段构建 | CI 构建镜像，需记录 `docker image inspect` 的 RepoDigest |
| 推荐数据库 | `sonic-data` 卷内 SQLite | 由引擎自动初始化；发布前做一次一致性备份 |
| SBOM | `reports/sbom/sonic-player.cdx.json` | 99 组件；GSAP/BSD 待人工复核 |

**可追溯性要求**：发布记录必须同时记录 Git SHA、Pages deployment id、引擎镜像 digest、数据库备份文件名。三者不一致不得发布。

## 2. 环境变量清单（只列名称）

**边缘/Pages**

- `SONIC_ENGINE_SECRET`、`SONIC_SECRET`、`SONIC_SECRET_KID`（可选轮换：`SONIC_SECRET_PREV`、`SONIC_SECRET_PREV_KID`）
- `SONIC_LOCAL_ENGINE_URL`、`SONIC_REQUIRE_ENGINE_AUTH`、`SONIC_REQUIRE_AUTH`
- `EPOMAIL_BASE_URL`、`EPOMAIL_CLIENT_ID`、`EPOMAIL_CLIENT_SECRET`、`EPOMAIL_REDIRECT_URI`
- 限流/超时：`SONIC_RATE_LIMIT_ANON_RPM`、`SONIC_RATE_LIMIT_AUTH_RPM`、`SONIC_TIMEOUT_MS`、`SONIC_ENGINE_TIMEOUT_MS`
- 功能开关：`SONIC_ENABLE_NETEASE`、`SONIC_ENABLE_QQ`、`SONIC_ENABLE_KUGOU`、`SONIC_ENABLE_KUWO`、`SONIC_ENABLE_AMLL`、`SONIC_ENABLE_LRCLIB`、`SONIC_ENABLE_UNBLOCK`、`SONIC_ENABLE_GDSTUDIO`、`SONIC_ENABLE_LYRIVA`、`SONIC_ENABLE_LISTENBRAINZ`
- 撤销存储：`SONIC_KEY_REVOCATION_KV`（绑定）、`SONIC_REVOKED_JTIS`、`SONIC_REVOKED_SUBS`、`SONIC_TOKEN_MIN_IAT`
- 可选上游：`SONIC_UPSTREAM_AMLL`、`SONIC_UPSTREAM_LRCLIB`、`SONIC_GORSE_URL`、`SONIC_GORSE_API_KEY`、`SONIC_MEILISEARCH_URL`、`SONIC_MEILISEARCH_KEY`

**引擎/容器**

- `SONIC_ENGINE_SECRET`、`SONIC_SECRET`、`SONIC_RUNTIME=linux-engine`
- `SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite`
- `SONIC_RECOMMEND_RETENTION_DAYS`、`SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK`（生产**不要**设为 1）
- `SONIC_NCM_API_URL`、`SONIC_BIND_PORT`、`PORT`、`HOST`
- 账户 Cookie（可选）：`NETEASE_COOKIE`、`QQ_COOKIE`、`KUGOU_COOKIE`
- 合规开关：`SONIC_ENABLE_UNBLOCK=0`、`SONIC_ENABLE_GDSTUDIO=0`、`SONIC_ENABLE_LYRIVA=0`

> 密钥只通过平台 Secret/环境变量注入；不得写入镜像、`.env` 提交、日志或构建产物。

## 3. Staging 部署步骤

1. **准备**：创建独立 Cloudflare Pages staging 项目与独立引擎主机/卷；使用 staging 专用 OAuth 客户端与密钥（不得复用生产）。
2. **构建**：
   - 前端：`npm ci && pnpm --dir player install --frozen-lockfile && npm run build`
   - 引擎：`docker build -t sonic-engine:<sha> .`（干净上下文，禁止预置 `dist`）
   - 记录 `docker image inspect --format '{{index .RepoDigests 0}}' sonic-engine:<sha>`
3. **数据库**：首次启动前确认 `/app/data` 为持久卷；启动后健康检查 `storageKind=sqlite`。
4. **启动**：`docker compose up -d sonic-engine`（staging 专用 `.env`），等待 healthy。
5. **验证**：
   - 匿名 `/api/sonic/engine/health` 返回 401；
   - 带 `X-Sonic-Engine-Key` 返回 200 且 `ok:true`、`storageKind:sqlite`；
   - Pages 首页、搜索、播放、歌词、收藏；
   - 真实 OAuth 测试账号登录/退出；
   - 连续搜索与快速切歌无旧结果覆盖；
   - 断网/429/403 显示可恢复提示。
6. **记录**：SHA、Pages deployment id、镜像 digest、备份文件名写入发布记录。

## 4. 回滚

### 4.1 前端/边缘函数

1. Cloudflare Pages → Deployments → 选择上一个已验证 deployment → Rollback。
2. 验证首页与 `/api/sonic/engine/health`（经 Pages 代理）返回预期。
3. 记录回滚时间与 deployment id。

### 4.2 Node 引擎

1. 停止当前容器（保留卷）。
2. 使用上一版本镜像 digest 启动；**不要**执行 `docker compose down -v`。
3. 健康检查 200、`storageKind=sqlite`，抽查事件计数与推荐结果。

### 4.3 数据库

- 本次无 schema 破坏性变更；引擎向后兼容旧库。
- 若需恢复：停引擎 → 用最近 `VACUUM INTO` 备份替换 DB（同时移除旧 `-wal`/`-shm`）→ 启动 → `integrity_check` 通过 → 健康 200。
- 回滚不得删除卷；备份保留至少 7 天。

## 5. 监控与告警（待建设）

| 指标 | 来源 | 建议阈值 |
|---|---|---|
| 5xx 比例 | Pages/引擎访问日志 | >1% 持续 5 分钟告警 |
| P95 延迟 | 访问日志 `durationMs` | >2s 告警 |
| 引擎健康 | Docker healthcheck / 外部探针 | 连续 3 次失败告警 |
| 数据库写入错误 | 引擎错误日志 | 出现即告警 |
| 上游失败/熔断 | `X-Sonic-Circuit`、degraded 日志 | OPEN 状态告警 |

当前仓库**没有**指标导出与告警配置；上线前需由运维接入。日志需脱敏，禁止记录 query/Cookie/密钥。

## 6. 灰度与放量

- 平台不支持按比例灰度时，使用内部账号或限定访问环境验证，不得声称具备比例灰度。
- 放量前检查：P0 清零、CI 绿、备份可恢复、回滚演练完成、授权确认。
- 停止放量条件：5xx 超阈值、播放成功率下降、数据库错误、鉴权异常。

## 7. 人工验收清单（必须由人执行并记录设备/时间）

- [ ] 桌面 Chrome / Firefox / Safari：首页 → 搜索 → 播放/暂停 → 切歌 → 拖动 → 音质 → 歌词 → 收藏 → 歌单 → 刷新恢复
- [ ] 移动 Safari / Chrome：同上核心旅程 + 播放器抽屉
- [ ] 真实 OAuth 账号：登录、刷新、退出、撤销 key
- [ ] 异常：无音源、403、429、5xx、引擎离线、断网、Token 过期
- [ ] 无障碍：键盘导航、焦点顺序、VoiceOver/TalkBack 抽检
- [ ] 回滚演练：Pages 与引擎各回滚一次，确认数据保留
- [ ] 版权/ToS 确认：逐源授权证据归档

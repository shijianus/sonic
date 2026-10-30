# Sonic 受控内测与生产部署、备份恢复及双向回滚手册（RUNBOOK-ROLLBACK）

> 适用版本：`v2.2.0-rc.1`（受控内测冲刺分支 `work/agy-release-20261031` / `rc/sonic-20261031`）  
> 负责人：Linux Backend / Edge Gateway / SRE (`agy`)

---

## 1. 架构与隔离原则

Sonic 由两层组成，变更与回滚必须**成对核对版本 SHA 与配置边界**：

1. **边缘控制面（Cloudflare Pages + Pages Functions）**
   - 生产项目：`cfsolara`（主分支 `main`，生产未获 GO 前**严禁触碰**）
   - 隔离内测项目：`sonic-staging`（分支 `staging`，强制开启 `SONIC_STAGING_ACCESS_TOKEN` 门禁与 `X-Robots-Tag: noindex, nofollow, noarchive`）
2. **本地数据面（Linux Node.js 22 Engine + SQLite WAL + Cloudflare Tunnel）**
   - 镜像构建时注入 `--build-arg SONIC_RELEASE_COMMIT=<full_sha>` 与 `SONIC_BUILD_TIME=<utc_iso>`。
   - 容器仅监听宿主机回环口 `127.0.0.1:${SONIC_BIND_PORT}:8080`，绝不暴露公网 `0.0.0.0` 端口。
   - 所有 `/api`、`/proxy`、`/palette` 接口在 `SONIC_RUNTIME=linux-engine` 下强制校验常量时间 `X-Sonic-Engine-Key`（≥32 字符），与 `Host` 头完全解耦。

---

## 2. 部署前 8 项强制检查清单

在执行任何 Staging 或生产发布前，依次核验：

```bash
# 1) 固定当前发布完整 SHA 与上一可回滚基线 SHA
export RC_SHA="$(git rev-parse HEAD)"
export PREV_SHA="20e399f846a7a306f5f28434d5809aa9fa4f5fb2"
git status --porcelain # 必须为空

# 2) 本地与远端 CI 门禁通过（quality + docker + browser-e2e）
npm run lint && npm run typecheck && npm test && npm run test:observability

# 3) 构建可追溯 Docker 镜像并记录完整 sha256 Digest
docker build \
  --build-arg SONIC_RELEASE_COMMIT="${RC_SHA}" \
  --build-arg SONIC_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "sonic-engine:${RC_SHA:0:12}" .
docker inspect --format='{{.Id}}' "sonic-engine:${RC_SHA:0:12}"

# 4) 在线一致性备份当前 SQLite 数据库（VACUUM INTO + PRAGMA integrity_check）
docker exec sonic-local-engine \
  node --experimental-sqlite scripts/backup-recommend-db.mjs \
  /app/data/sonic-recommend.sqlite \
  "/app/data/backup-pre-${RC_SHA:0:8}-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
```

同时确认环境变量门禁：
- `SONIC_SECRET` 与 `SONIC_ENGINE_SECRET` 均 ≥ 32 字符高熵随机值。
- 受控内测环境必须设置：
  - `SONIC_STAGING_ACCESS_TOKEN`（≥ 16 字符，未携带直接返回 `401 STAGING_ACCESS_REQUIRED`）
  - `SONIC_CONTENT_POLICY=strict-allowlist`
  - `SONIC_ALLOWED_SOURCES=synthetic`（未获书面授权的商业/社区源全部服务端 `403 SOURCE_DISABLED_BY_POLICY` 拦截）
  - `SONIC_ENABLE_OAUTH=0`（真实 Epomail OAuth 验收完成前返回 `403 OAUTH_DISABLED_BY_POLICY`，且不削弱 `verifyAuth`）
  - `SONIC_ENABLE_UNBLOCK=0`、`SONIC_ENABLE_GDSTUDIO=0`、`SONIC_ENABLE_LYRIVA=0`

---

## 3. SQLite 在线备份与无损原子恢复流程

### 3.1 在线一致性备份（RPO = 0 已提交事务）

[`scripts/backup-recommend-db.mjs`](../scripts/backup-recommend-db.mjs) 使用 SQLite 原生 `VACUUM INTO` 在 WAL 并发读写状态下生成紧凑一致性快照，并自动重新打开备份执行 `PRAGMA integrity_check`：

```bash
# 容器内执行
docker exec sonic-local-engine \
  node --experimental-sqlite scripts/backup-recommend-db.mjs \
  /app/data/sonic-recommend.sqlite \
  /app/data/sonic-recommend.backup.sqlite
```

期望输出 JSON 包含 `"ok": true`、`"sizeBytes"`、`"tracks"` 与 `"events"` 计数。

### 3.2 非破坏性原子恢复

[`scripts/restore-recommend-db.mjs`](../scripts/restore-recommend-db.mjs) 在恢复前执行 4 重保护：
1. 对待恢复备份执行 `PRAGMA integrity_check`，损坏备份直接拒绝（退出码 `1`）。
2. 若目标库存在，先将其保存为带时间戳的 `.pre-restore-<timestamp>.sqlite` 安全副本，**绝不裸覆盖已有数据**。
3. 写入同目录临时文件，清理陈旧 `-wal` / `-shm` 旁路文件后执行 POSIX 原子 `rename`。
4. 对恢复后的目标库再次执行 `PRAGMA integrity_check`。

```bash
# 1) 停止写入容器（避免并发句柄冲突）
docker stop sonic-local-engine

# 2) 使用同镜像一次性容器挂载数据卷执行安全恢复
docker run --rm \
  -v sonic-data:/app/data \
  "sonic-engine:${PREV_SHA:0:12}" \
  node --experimental-sqlite scripts/restore-recommend-db.mjs \
  /app/data/sonic-recommend.backup.sqlite \
  /app/data/sonic-recommend.sqlite

# 3) 重新启动服务并校验健康度与事件计数
docker start sonic-local-engine
curl -fsS -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET}" \
  http://127.0.0.1:8080/api/sonic/engine/health | jq .
```

---

## 4. 分层快速回滚预案（目标 RTO < 2 分钟）

当发布后出现以下任一触发条件时**立即执行回滚**，不在故障现场排查根因：
- `/api/sonic/engine/health` 返回 `503`（`storageHealthy: false` 或 `disk.writable: false`）
- `/api/sonic/engine/metrics` 观测到 5xx 错误率 > 2% 或核心路由 P95 持续劣化
- 鉴权、SSRF、内容白名单策略异常或播放链路 `206 Partial Content` 字节错位

### 4.1 Cloudflare Pages 边缘网关回滚（秒级原子切换）

```bash
# 查询最近部署列表，确认上一稳定 Deployment ID
curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PAGES_PROJECT}/deployments?per_page=5" \
  | jq -r '.result[] | "\(.id)  \(.created_on)  \(.deployment_trigger.metadata.commit_hash)"'

# 执行一键原子回滚至目标 Deployment ID
curl -fsS -X POST \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CF_PAGES_PROJECT}/deployments/${PREV_DEPLOYMENT_ID}/rollback"
```

### 4.2 Linux Engine 容器按 Digest 回滚（保留数据卷）

```bash
# 使用已记录的上一稳定镜像 tag 或 sha256 digest 重建容器，保持原命名卷挂载不变
export SONIC_RELEASE_COMMIT="${PREV_SHA}"
docker stop sonic-local-engine && docker rm sonic-local-engine

docker run -d \
  --name sonic-local-engine \
  --restart unless-stopped \
  --env-file .env \
  -e SONIC_RELEASE_COMMIT="${PREV_SHA}" \
  -v sonic-data:/app/data \
  -p 127.0.0.1:${SONIC_BIND_PORT:-8080}:8080 \
  "${PREV_IMAGE_DIGEST}"
```

> **数据兼容性说明**：`server/recommend-sqlite.ts` 采用只增不毁（additive `CREATE TABLE IF NOT EXISTS`）Schema 设计，RC 与基线 `20e399f` 共享完全兼容的 `canonical_tracks` / `behavior_events` 表结构；常规代码回滚无需覆盖 SQLite 数据卷。仅在发生数据污染时才按 §3.2 恢复备份。

### 4.3 Cloudflare Tunnel 与 DNS 路由回滚（生产保护）

若涉及生产 Tunnel Ingress 变更，使用仓库内置非破坏性合并脚本 [`scripts/rollback-production.sh`](../scripts/rollback-production.sh)：

```bash
# 1) 先执行 dry-run 核对合并后的 Ingress JSON（确保保留 engine-sonic.epocanvas.tech）
./scripts/rollback-production.sh --dry-run

# 2) 确认无误后执行恢复
./scripts/rollback-production.sh --execute
```

---

## 5. 回滚后最小验证（Post-Rollback Smoke Check）

回滚完成后必须在 60 秒内完成以下 4 项核验：

```bash
# 1) 引擎鉴权门禁：无 Key 必须 401，带 Key 必须 200 且 storageHealthy=true
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${SONIC_BIND_PORT:-8080}/api/sonic/engine/health)" = "401"
curl -fsS -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET}" \
  "http://127.0.0.1:${SONIC_BIND_PORT:-8080}/api/sonic/engine/health" | jq '{ok, storageHealthy: .recommend.storageHealthy, eventCount: .recommend.eventCount, release}'

# 2) 内测公网门禁：无 Token 必须 401 + noindex
curl -sSI "https://${STAGING_DOMAIN}/" | grep -E "HTTP/|x-robots-tag"

# 3) 授权合成检索与 206 Range 播放冒烟
curl -fsS -H "X-Sonic-Staging-Token: ${SONIC_STAGING_ACCESS_TOKEN}" \
  "https://${STAGING_DOMAIN}/api/sonic/search/nexus?q=440Hz" | jq '.data.tracks[0].platformId'
curl -fsSI -H "X-Sonic-Staging-Token: ${SONIC_STAGING_ACCESS_TOKEN}" \
  -H "Range: bytes=0-1023" \
  "https://${STAGING_DOMAIN}/api/music/stream?id=syn-440hz&source=synthetic" | grep -E "HTTP/|content-range|x-sonic-via"

# 4) 可观测性与告警通道自检
npm run test:observability
```

---

## 6. 2026-10-30 隔离 Staging 双向回滚演练实测记录

> 完整 JSON 证据见：[`reports/handoff/evidence/staging-and-rollback-20261030.json`](../reports/handoff/evidence/staging-and-rollback-20261030.json) 与 [`reports/handoff/evidence/docker-sqlite-drill-20261030.json`](../reports/handoff/evidence/docker-sqlite-drill-20261030.json)

| 演练指标 | 实测值 | 状态 |
|---|---|---|
| 隔离 Cloudflare Pages 项目 | `sonic-staging` (`https://sonic-staging.pages.dev`) | `PASS` |
| 隔离 Cloudflare Tunnel | `sonic-staging-engine-20261030` (`65454bdb-f04a-41f4-8be6-9672fd434af9`) | `PASS` |
| 回滚目标基线（Deployment A，`20e399f`） | Pages ID: `e64dd74e-1091-4750-b6d8-43af4885e105`<br>Engine Image Digest: `sha256:4785f88d01684ea15fe2e349a39c9d10116b59610dd80b1c950d1ce75d55ffe7` | `PASS` |
| 当前验证 RC（Deployment B，`4fb8e79`） | Pages ID: `48992d04-fd67-4d55-bff7-611489887585`<br>Engine Image Digest: `sha256:4ad3a85bf064c1cc8891f2c6136eb47511408d4712d3129f8f36e1dbe328a600` | `PASS` |
| 回滚前 SQLite `VACUUM INTO` 备份 | `ok: true` (`PRAGMA integrity_check = ok`) | `PASS` |
| **向后回滚 RTO（RC → Baseline）** | **`2,406 ms`（2.41 秒）** | `PASS` |
| **前向恢复 RTO（Baseline → RC）** | **`1,756 ms`（1.76 秒）** | `PASS` |
| **数据恢复点目标（RPO）** | **`0` 条已提交事务丢失**（回滚前后 SQLite 事件数一致） | `PASS` |
| 恢复后 Smoke Test | 匿名门禁 `401`、合成搜索 `200`、Range `206` (`via: local-engine`) | `PASS` |


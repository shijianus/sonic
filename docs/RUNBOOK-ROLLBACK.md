# Sonic 受控内测与生产部署、备份恢复及双向回滚手册（RUNBOOK-ROLLBACK）

> 操作约束更新：2026-11-02。版本以本次 `release.json`、OCI 镜像 digest 与数据库快照记录为准；文末 2026-10-30 演练仅是历史证据。
>
> 负责人：Linux Backend / Edge Gateway / SRE。本文不是对当前运行中服务的回滚演练通过声明。

---

## 1. 架构与隔离原则

Sonic 由两层组成，变更与回滚必须**成对核对版本 SHA 与配置边界**：

1. **边缘控制面（Cloudflare Pages + Pages Functions）**
   - 生产项目：`cfsolara`（主分支 `main`，生产未获 GO 前**严禁触碰**）
   - 隔离内测项目：`sonic-staging`（分支 `staging`，强制开启 `SONIC_STAGING_ACCESS_TOKEN` 门禁与 `X-Robots-Tag: noindex, nofollow, noarchive`）
2. **本地数据面（Linux Node.js 22 Engine + SQLite WAL + Cloudflare Tunnel）**
   - 镜像构建前在完整解压目录核验源文件；构建参数必须来自同一份 `release.json` 的 `baseCommit`、`sourceDigest`、`releaseId`、`buildTime`、`dirty`，不能只传 Git SHA。
   - 容器仅监听宿主机回环口 `127.0.0.1:${SONIC_BIND_PORT}:8080`，绝不暴露公网 `0.0.0.0` 端口。
   - 所有 `/api`、`/proxy`、`/palette` 接口在 `SONIC_RUNTIME=linux-engine` 下强制校验常量时间 `X-Sonic-Engine-Key`（≥32 字符），与 `Host` 头完全解耦。

---

## 2. 部署前强制检查清单

在执行任何 Staging 或生产发布前，依次核验：

1. 按 [发布检查单的源码包步骤](release/RELEASE-CHECKLIST.md#源码包重建与溯源门禁2026-11-02)核对外部保存的 archive SHA-256，在空目录解压后核验 `release.json` + `release-files.json`。不依赖 `.git`；dirty 发布必须明确记录，不能把 base commit 当作修复后的唯一版本。
2. 从冻结锁文件安装，完成 typecheck、lint、测试、前端/引擎构建；再核验摘要。CI、测试与 Docker build 的输入必须是同一个冻结源码集合。
3. 确认并保存上一版 Pages Deployment ID、不可变镜像 digest、完整 release 身份、有效配置引用、数据卷实际路径，以及**与该镜像匹配的迁移前数据库快照、摘要和表计数**。配置值/密钥另存受控位置，不能写入源码包。
4. 在线备份只证明备份时点的一致性；发布前先停止写入及重启控制器，再补一份停机数据快照。保存失败版本的数据用于恢复，不覆盖或删除原快照。

```bash
# 在完整解压目录执行；任何步骤失败即停止发布。五个构建值来自同一清单。
node scripts/release-inputs.mjs --verify release.json --index release-files.json
export SONIC_RELEASE_COMMIT="$(node -p 'JSON.parse(require("fs").readFileSync("release.json")).baseCommit')"
export SONIC_SOURCE_DIGEST="$(node -p 'JSON.parse(require("fs").readFileSync("release.json")).sourceDigest')"
export SONIC_RELEASE_ID="$(node -p 'JSON.parse(require("fs").readFileSync("release.json")).releaseId')"
export SONIC_BUILD_TIME="$(node -p 'JSON.parse(require("fs").readFileSync("release.json")).buildTime')"
export SONIC_RELEASE_DIRTY="$(node -p 'JSON.parse(require("fs").readFileSync("release.json")).dirty')"
node scripts/release-inputs.mjs --verify release.json --index release-files.json
docker build \
  --build-arg SONIC_RELEASE_COMMIT --build-arg SONIC_SOURCE_DIGEST \
  --build-arg SONIC_RELEASE_ID --build-arg SONIC_BUILD_TIME --build-arg SONIC_RELEASE_DIRTY \
  -t "sonic-engine:${SONIC_RELEASE_ID}" .
docker image inspect --format='{{.Id}}' "sonic-engine:${SONIC_RELEASE_ID}"
```

镜像构建不会代替源文件核验；Docker 前端层仅有部分源码，其 `--partial-docker-stage` 只写入已由外部核验的身份，不表示该层重新算出了全量摘要。

同时确认环境变量门禁：
- `SONIC_SECRET` 与 `SONIC_ENGINE_SECRET` 均 ≥ 32 字符高熵随机值。
- 受控内测环境必须设置：
  - `SONIC_STAGING_ACCESS_TOKEN`（≥ 16 字符，未携带直接返回 `401 STAGING_ACCESS_REQUIRED`）
  - `SONIC_CONTENT_POLICY=strict-allowlist`
  - `SONIC_ALLOWED_SOURCES=synthetic`（未获书面授权的商业/社区源全部服务端 `403 SOURCE_DISABLED_BY_POLICY` 拦截）
  - `SONIC_ENABLE_OAUTH=0`（真实 Epomail OAuth 验收完成前返回 `403 OAUTH_DISABLED_BY_POLICY`，且不削弱 `verifyAuth`）
  - `SONIC_ENABLE_UNBLOCK=0`、`SONIC_ENABLE_GDSTUDIO=0`、`SONIC_ENABLE_LYRIVA=0`

---

## 3. SQLite 在线备份与离线原子恢复流程

### 3.1 在线一致性备份（恢复点为快照时点）

[`scripts/backup-recommend-db.mjs`](../scripts/backup-recommend-db.mjs) 使用 SQLite 原生 `VACUUM INTO` 在 WAL 并发读写状态下生成紧凑一致性快照，并自动重新打开备份执行 `PRAGMA integrity_check`：

```bash
# 容器内执行
docker exec sonic-local-engine \
  node --experimental-sqlite scripts/backup-recommend-db.mjs \
  /app/data/sonic-recommend.sqlite \
  /app/data/sonic-recommend.backup.sqlite
```

期望输出 JSON 包含 `"ok": true`、`"sha256"`、`"sizeBytes"`、`"tracks"` 与 `"events"` 计数。将它与当时的镜像 digest、release 身份及快照时间成对保存。快照之后的提交不在恢复点中；没有停写或已验证重放方案时，**不能承诺 RPO = 0**。

### 3.2 离线原子恢复

[`scripts/restore-recommend-db.mjs`](../scripts/restore-recommend-db.mjs) 的操作约束：
1. 必须先停止全部写入者和自动重启/调度控制器，再显式传 `--offline`；该标志不是停止服务的替代品。
2. 拒绝符号链接、硬链接、活动/未完成 checkpoint 的 WAL、SHM、journal 及未知 maintenance lock。**不能删除旁路文件来绕过拒绝**；应保留原件，用匹配的 SQLite/镜像按恢复流程完成 checkpoint 或在副本上排障。
3. 验证备份完整性和空间，获取维护锁；目标存在时，先生成经校验的 `.pre-restore-<timestamp>-<uuid>.sqlite` 安全副本及独立回退副本。
4. 同目录原子替换后核对 integrity、SHA-256、tracks/events；失败时回退并验证原库。自动回退也失败时保留维护锁与快照，禁止直接重启。

```bash
# 先明确实际卷名/绑定目录。Compose 命名卷可能带项目名前缀。
: "${SONIC_DATA_MOUNT:?Set the actual data volume or absolute bind path}"
: "${RECOVERY_TOOL_IMAGE_DIGEST:?Set an immutable image containing the tested offline restore script}"
: "${MATCHED_DB_SNAPSHOT:?Set snapshot filename matched to the intended target image}"
# 1) 先停用外部自动重启控制器，再优雅停止所有数据库写入者。
docker stop --time 75 sonic-local-engine
test "$(docker inspect --format='{{.State.Running}}' sonic-local-engine)" = false
test "$(docker inspect --format='{{.State.ExitCode}}' sonic-local-engine)" = 0

# 2) 校验已另存的快照 SHA-256 与镜像配对记录后，执行离线恢复。
# 恢复工具镜像不必是旧应用镜像，但必须含已测试的 --offline 实现。
docker run --rm \
  -v "${SONIC_DATA_MOUNT}:/app/data" \
  "${RECOVERY_TOOL_IMAGE_DIGEST}" \
  node --experimental-sqlite scripts/restore-recommend-db.mjs \
  "/app/data/${MATCHED_DB_SNAPSHOT}" \
  /app/data/sonic-recommend.sqlite --offline
```

恢复同版本时核对原容器的镜像 digest 后再启动；跨版本回滚必须按 §4.2 使用**与快照配对的目标镜像**重建，不能 `docker start` 仍指向新镜像的旧容器。恢复工具测试成功不代表旧镜像与新 schema 兼容。

---

## 4. 分层回滚预案（RTO 必须在本次匹配版本上实测）

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

### 4.2 Linux Engine：镜像与数据库成对回滚

当前 `server/recommend-sqlite.ts` 包含 subject-scoped event key 迁移，会重建表/键并执行 `DROP TABLE` + `RENAME`；这不是仅增加 `CREATE TABLE IF NOT EXISTS` 的 schema。**未验证旧镜像对已迁移数据库的双向读写兼容前，禁止只换旧镜像并复用新库。**

1. 停止新版本写入和重启控制器，保留失败容器与新数据的完整副本（包括旁路文件），记录最后提交/恢复点。
2. 核对目标镜像 digest 与迁移前数据库快照的配对记录；按 §3.2 恢复该快照，或恢复经过停写后逐文件校验的完整数据目录。
3. 使用与快照配对的不可变镜像、原数据挂载/内部网络、有效非秘密配置重建容器。恢复旧版 Pages Deployment，并核对网关与引擎契约。
4. 重新推进新版本也必须保留旧版回滚后产生的数据；重新备份并演练迁移，不能用切换前的新库直接覆盖回滚期间写入。

```bash
# 以下是已完成离线恢复之后的重建示意；网络/配置须与已记录部署一致。
: "${PREV_IMAGE_DIGEST:?Set immutable image matched to the restored snapshot}"
: "${SONIC_DATA_MOUNT:?Set verified original data volume or bind path}"
: "${PREV_CONFIG_FILE:?Set protected target-version config file outside source archive}"
: "${SONIC_INTERNAL_NETWORK:?Set the existing internal Docker network}"
: "${FAILED_CONTAINER_NAME:?Set a unique preservation name}"
# §3.2 已确认旧容器停止；保留它而不是删除。
docker rename sonic-local-engine "${FAILED_CONTAINER_NAME}"
docker run -d \
  --name sonic-local-engine \
  --restart unless-stopped --stop-timeout 75 --init \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --env-file "${PREV_CONFIG_FILE}" \
  --network "${SONIC_INTERNAL_NETWORK}" \
  -v "${SONIC_DATA_MOUNT}:/app/data" \
  -p "127.0.0.1:${SONIC_BIND_PORT:-8080}:8080" \
  "${PREV_IMAGE_DIGEST}"
```

目标配置不可携带新版本的 `SONIC_RELEASE_*` / `SONIC_SOURCE_DIGEST` / `SONIC_BUILD_TIME` 来覆盖旧镜像身份。以镜像标签、前端 `release.json` 和健康端点共同核对；“容器成功启动”不足以证明数据兼容。

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

回滚完成后立即完成以下核验；记录实际耗时，不沿用历史 RTO/RPO：

```bash
# 1) 引擎鉴权门禁：无 Key 必须 401，带 Key 必须 200 且 storageHealthy=true
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${SONIC_BIND_PORT:-8080}/api/sonic/engine/health)" = "401"
curl -fsS -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET}" \
  "http://127.0.0.1:${SONIC_BIND_PORT:-8080}/api/sonic/engine/health" | jq '{ok, recommendEngine, release}'

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

## 6. 验证范围与历史演练

### 当前代码可重复的恢复测试

`tests/backend-beta-release.test.ts` 验证在线 WAL 快照、digest/完整性校验、强制 `--offline`、拒绝活动 WAL/journal、维护锁、安全副本、原子替换失败回退和回退失败保留锁。`tests/release-followup-package.test.ts` 验证源码包缺文件、篡改、清单/索引一致性。这些是隔离临时文件/数据库测试，**不是当前运行中 Staging 的镜像 A → B → A 服务回滚演练**。

对本次 candidate 的当前运行中服务回滚/前向恢复，只有同时记录精确镜像 digest、配对快照摘要、停写点、schema/表计数、健康/写入/播放验证及实际 RTO/RPO 后才能标记 PASS；没有这组证据时标记 **NOT REHEARSED**。已有健康检查、备份成功或安全副本存在均不能替代这项演练。

### 2026-10-30 隔离 Staging 历史记录（不代表当前版本通过）

> 以下数值仅适用于表内两个历史版本。历史 JSON 报告不放入源码分发包；由发布负责人在证据存储另行保管。
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


# Sonic v2.2.0 受控公测事故恢复与重新部署报告（BETA-20261031-RECOVERY）

- **事件**：最终验收（GO/NO-GO）发现隔离 Staging 的 Linux Engine 数据面离线，判定 CONDITIONAL GO
- **处置**：在同一会话内完成全部 P0/P1 整改、重新部署与全面复验
- **验收人**：Windows ZCode（受用户指令授权在部署测试机执行部署）
- **报告时间**：2026-10-31（UTC 上午）

---

## 1. 事件还原（Engine 数据面离线）

- **现象**：`engine-sonic-staging.epocanvas.tech` 返回 HTTP 530 / Cloudflare error 1033（Tunnel 无连接器）；
  Edge 搜索 meta 报 `degradedReason: "Engine HTTP 530"`、`circuitState: "OPEN"`，音频全部由边缘降级通道提供。
- **根因**：原 Engine 宿主机（AGY Linux）离线，Staging Tunnel `sonic-staging-engine-beta`
  (`8275c237-56a2-4735-a751-6643af22883f`) 失去全部连接器。该隧道 ingress 为
  `engine-sonic-staging.epocanvas.tech → http://127.0.0.1:18080`（远程托管配置，未改动）。
- **影响**：第 9 项（SQLite 卷/健康监控/告警/备份）BLOCKED；Engine 直连 SHA 无法复核。
  用户可见播放经设计的边缘降级通道维持可用，UI 横幅如实提示。
- **生产隔离核查**：生产 Tunnel `sonic` (`af3cf7c1-…`，终结于 instabox-sonic 机器) 在事件期间短暂 530，
  系该机 cloudflared 服务 07:47Z 重启所致，与本轮操作无关，重启后自动恢复（外部探测 401 正常）。

## 2. 整改与重新部署（全部按"代码只在本地改、部署机只做部署"执行）

| 步骤 | 内容 | 结果 |
|---|---|---|
| 1 | 本地修复 `functions/api/index.ts`：`/api` 信息端点纳入 `evaluateGatewayRateLimit`（scope `api-info`） | 提交 `404998c` |
| 2 | 本地修正 `BETA-20261031-FINAL.md`：§6 部署 SHA 更正为实测 `30b3602`；明文 Staging Token 脱敏 | 同上 |
| 3 | 本地门禁：typecheck / lint / player 38 + root 142 测试 / build / test:observability | 全绿 |
| 4 | 推送 `404998c` → GitHub Actions run `41185605071` | success |
| 5 | 部署机 `instabox-sonic` 克隆仓库至 `404998c`，构建镜像 `sonic-staging-engine:rc-404998c`（`sha256:2d1a145a…`） | healthy |
| 6 | 启动容器 `sonic-staging-engine`（127.0.0.1:18080:8080，数据卷 `/data/sonic-staging-data`，`--env-file` 注入 strict-allowlist/synthetic-only/OAuth=0 策略与轮换后密钥） | healthy |
| 7 | 启动 Tunnel 连接器 `sonic-staging-tunnel`（cloudflared 官方镜像，`--network host`，TUNNEL_TOKEN 经 stdin 管道传递未落日志） | 4 条 QUIC 连接注册 |
| 8 | Pages 项目 `sonic-staging` 环境变量整体轮换并重新部署（部署 `3ab48ecd-…`，21 个变量，3 个 secret_text） | 线上生效 |
| 9 | Staging Token 轮换：旧公开 Token `stg_beta_pass_20261031_…` 立即失效 | 已失效 |

**首次 Pages 重部署期间的事故（已即时修复）**：`wrangler pages deploy` 从临时目录执行时未携带
`functions/` 目录（Functions 相对 CWD 解析），且 `[vars]` 表内误置 `compatibility_*` 键、机密与项目级
secret 重名冲突，先后产生两个失败部署（静态站、门禁短时打开约 20 分钟）。修复方式：将 `functions/`
复制进部署目录、`compatibility_date = "2026-10-30"` + `nodejs_compat` 置于 `[vars]` 之前、三个机密改用
`wrangler pages secret put` 注入。此后部署 `3ab48ecd` 完整可用。**教训已记入第 5 节。**

## 3. 修复中发现并修复的播放缺陷（P0，真机首访即触发）

**缺陷**：Engine 恢复后，浏览器点击播放出现静音。网络抓包定位：
播放器默认音质 `jymaster` 不在引擎返回的 qualities（exhigh/standard）中 → `songUrlV1`（netease 语义）被
网关以 `SOURCE_DISABLED_BY_POLICY` 403 拒绝 → 前端四处硬编码的 `&source=netease` 兜底同样 403 → 音频无流。

**修复**（提交 `404998c` 之后的新提交，四处统一改为「优先自身流、按曲目来源派生」）：
- `player/src/stores/modules/audio.ts` 两处兜底
- `player/src/utils/qualityProbe.ts` 探测 URL
- `player/src/stores/modules/download.ts` 下载兜底
- 兜底链：`qualities[].streamUrl → song.url → sources[0].platform → netease`

复验（真实 Chrome）：搜索 → 播放（206 合成流）→ 暂停 → Seek 75%（10.21s）→ 继续推进 → 暂停，全部通过。

## 4. 重新部署后全面复验（全部实时实测）

| 检查 | 结果 |
|---|---|
| 匿名访问 Staging | 401 + `X-Robots-Tag: noindex, nofollow, noarchive` |
| 旧公开 Token | **401（已作废）** |
| 新轮换 Token | 200，302 剥离 + HttpOnly Cookie 正常 |
| 线上 SHA | Pages `X-Sonic-Release` 与 `/api` releaseCommit 均为新提交 SHA |
| Pages → Engine 搜索 | `local-engine ok:true`，`degraded:false`，连续 6/6 稳定 |
| 全量流 / Range | `x-sonic-via: local-engine`，200（192,044 字节 RIFF）/ 206 精确切片 |
| 商业源/歌词/封面 | netease/qq 403、OAuth 403、SSRF 400（门禁全部维持） |
| Engine 健康 | `ok:true`、`storageKind: sqlite`、`storageHealthy: true`（容器 healthcheck healthy） |
| SQLite 备份演练 | `VACUUM INTO` 快照 `ok:true`（94,208 字节、3 tracks、integrity 通过、WAL 活跃） |
| `/api` 限流补丁 | 突发 260 → 240×200 + **20×429**（恰在 240/min 阈值），窗口后恢复 200 |
| 浏览器全流程 | 真实 Chrome：匿名 401 → 邀请兑换 → 首页（无降级横幅）→ 搜索 → 播放 → 暂停 → Seek → 恢复 |
| 已知残留 | 网关 CF-Cache 中存在断网窗口写入的过期降级缓存（`cacheLevel: cf-cache`），按 s-maxage 1 小时自愈，`nocache=1` 可绕过 |

## 5. 当前部署链与回滚对象

| 层级 | 标识 | 资源 |
|---|---|---|
| **当前发布** | `a0da6cf` | Pages 部署 `6e4d6f3c` + Engine `sonic-staging-engine:rc-a0da6cf`（三端 `X-Sonic-Release`/releaseCommit 一致） |
| 上一稳定 | `404998c` | Pages `3ab48ecd-0c96-4a27-9bac-04ceea796222` + Engine `sonic-staging-engine:rc-404998c`（`sha256:2d1a145a…`） |
| 断网前基线 | `30b3602` | Pages `941be968-4fec-41cf-b712-0cc6063d3ec0` + Engine `sonic-engine:rc-30b3602`（位于原 AGY 机，暂不可达） |

- **部署机**：instabox 沙箱 `sonic`（`instabox-sonic`，4 vCPU/8G，/data 20G）。容器均 `--restart unless-stopped`。
- **回滚步骤**：Engine 层 `docker stop/rm sonic-staging-engine` 后以 `sha256:2d1a145a…` 重建（保留 `/data/sonic-staging-data` 挂载）；
  Pages 层经 API 回滚至 `3ab48ecd-…`。数据卷独立于容器，RPO=0。
- **凭据管理**：`SONIC_ENGINE_SECRET`/`SONIC_SECRET`/`SONIC_STAGING_ACCESS_TOKEN` 均为本次轮换后的新值；
  机器侧仅存于 `/data/workspace/sonic-staging-deploy/.env.staging`（0600），仓库与文档零明文。

## 6. 遗留问题与下次迭代（≤5 项）

1. **部署机为单点**：instabox 沙箱停止即重演本次事故。建议为 Engine 数据面配置第二连接器或托管宿主，
   并增加外部存活探测（Engine 离线时现有告警通道自身失联，无法自报）。
2. **Pages 直传部署工艺脆弱**（本次 functions 缺失 / toml 键位 / 机密重名三连）：将部署固化为脚本化流程
   （`CF_PAGES_PROJECT=sonic-staging` + 仓库根执行），并在 CI 增加部署后门禁冒烟（匿名 401 + releaseCommit 断言）。
3. **限流为内存降级实现**（`productionCompliant:false`）：配置 Cloudflare 原生 `RATE_LIMITER` 绑定。
4. **Epomail OAuth 生产联调**（本轮维持关闭）与真机（iOS/Android/大屏）人工验收仍未覆盖，保持排除在本轮范围外。
5. **商业音源接入**待法务书面授权后按白名单放行。

## 7. 结论

CONDITIONAL GO 的两项放行条件均已完成：Engine 数据面恢复且复验全绿；Staging Token 已轮换（旧公开值作废）。
受控公测可向受邀人分发新邀请链接（Token 仅限私下渠道）。本轮整改之后停止继续改动，进入观察与缺陷修复阶段。

# Sonic v2.2.0 公测发布冻结与最终 RC 集成交接报告

- **发布目标**：Sonic v2.2.0 隔离 Staging 受控公测版本
- **冻结时间**：2026-10-31T05:30:00Z（北京时间 2026-10-31 13:30）
- **集成负责人**：RC 集成负责人、SRE 发布执行人
- **发布状态判定**：**READY TO DEPLOY（条件受控公测已就绪）**

---

## 1. 权威代码基线与提交历史（Git DAG 权威事实）

权威集成分支：`rc/sonic-20261031`

### 1.1 完整提交历史链条

| 提交 SHA | 归属团队 | 提交摘要与改动说明 |
|---|---|---|
| **本提交** | **集成人** | `docs(release): 发布冻结交付物与双端最终集成报告 (BETA-20261031-FINAL)` |
| `c0fe1d3` | **Linux AGY** | `fix(beta): finalize isolated staging readiness`（Staging 部署、Chrome 148 验收与容灾凭证） |
| `30b3602` | **Windows ZCode** | `docs(release): 记录最终 RC CI run 41163651090 与集成 SHA 24ac86a` |
| `24ac86a` | **Windows ZCode** | `test(e2e): 增加播放历史持久化用例，全量 43/43` |
| `95cc990` | **Windows ZCode** | `docs(release): 记录 205171e 的 CI 三作业 success` |
| `205171e` | **Windows ZCode** | `docs(release): 记录 Windows 公测回归 42/42、挂起超时修复与外部阻断` |
| `1cc1ac8` | **Windows ZCode** | `fix(player): 收敛起播挂起与 503 降级提示，补充异常与路由 E2E` |
| `401dbce` | **Windows ZCode** | `docs(release): 记录 4bf253a 的 CI 三作业 success 与引擎冒烟结果` |
| `4bf253a` | **Windows ZCode** | `docs(release): 快进合并 agy 后端加固并记录 Windows 复跑结果` |
| `e0adb20` | **Linux AGY** | `docs(handoff): add AGY handoff report, rollback runbook, and verified Staging/SQLite drill evidence` |
| `4fb8e79` | **Linux AGY** | `feat(backend): P0/P1 release gate hardening, licensing enforcement, observability, and synthetic staging media` |
| `20e399f` | **基线 RC** | `docs(release): 建立 RC 交接、门禁、决策与 NO-GO 记录` |

### 1.2 Git 集成核对规则

- **合并方式**：`git merge --ff-only`（纯快进合并，零冲突，零整文件覆盖，完全保留双方提交历史与签名）。
- **破坏性命令审查**：全过程严禁且未执行 `git reset --hard`、`git clean -fd`、`git restore .`、`git push --force`。
- **分支边界**：生产分支 `main` 全程**零触碰**。

---

## 2. 两端与远端 CI 真实测试结果汇总

### 2.1 本地与在线全量质量门禁

| 门禁项 | 命令 / 验证方式 | 执行端 | 状态与结果 |
|---|---|---|---|
| **TypeScript 类型检查** | `npm run typecheck` | 本地 Linux | **PASS**（根 tsc 与 player vue-tsc 0 错误） |
| **代码与主题规范** | `npm run lint` | 本地 Linux | **PASS**（430 主题基线无新增，ESLint 0 错误） |
| **根单元与集成测试** | `npm test` | 本地 Linux | **PASS**（10 文件 142/142 Vitest + 167 Jiti 套件全部通过） |
| **播放器前端测试** | `pnpm --dir player test` | 本地 Linux | **PASS**（8 文件 38/38 Vitest 全部通过） |
| **前端静态打包** | `npm run build` | 本地 Linux | **PASS**（生成 270 个资产，复制至 `dist/`） |
| **后端引擎构建** | `npm run build:engine` | 本地 Linux | **PASS**（生成 `dist-server/index.mjs` 816.3kb） |
| **可观测性脱敏自检** | `npm run test:observability` | 本地 Linux | **PASS**（`ok:true`, `redactionVerified:true`, `alertDelivered:true`） |
| **浏览器端到端测试** | Playwright Chromium 43 例 | 远端 CI | **PASS**（桌面 39 + 移动 4，43/43 全部通过） |
| **真实 Staging 在线验收** | Google Chrome 148 真实浏览器 | 隔离 Staging | **PASS**（25/25 项在线验收全部全绿，见证据截图） |

### 2.2 GitHub Actions 权威远端 CI 凭证

对最终集成的 SHA，远端 CI 三大作业全部通过：

* **Commit `c0fe1d3`**：Run ID [41167806058](https://github.com/shijianus/sonic/actions/runs/41167806058) — **SUCCESS**
  * `Typecheck, lint, tests and build`: 1m5s **success**
  * `Browser E2E (mocked gateway, real media element)`: 3m13s **success**（43/43 全部通过）
  * `Docker build and runtime smoke test`: 51s **success**
* **Commit `30b3602`**：Run ID [41164139883](https://github.com/shijianus/sonic/actions/runs/41164139883) — **SUCCESS**
* **Commit `24ac86a`**：Run ID [41163651090](https://github.com/shijianus/sonic/actions/runs/41163651090) — **SUCCESS**

---

## 3. 发布允许功能与明确关闭功能清单

### 3.1 本轮允许上线的功能（Allowlist）

1. **第一方 CC0 合成基准音频播放**：
   - 开放曲目：`syn-440hz`（标准音 A4 440Hz）、`syn-528hz`（修复频 528Hz）、`syn-chord`（测试和弦）。
   - 协议链路：经 Cloudflare Pages → Argo Tunnel → Linux Engine，支持 HTTP 200 全量流、HTTP 206 Range 切片与毫秒级拖拽寻道（Seek）。
2. **隔离 Staging 访问门禁**：
   - 支持受邀邀请链接 `/?staging_token=...`。
   - 首次访问自动执行 302 重定向并从浏览器地址栏剔除 Token，下发 `sonic_staging_access` HttpOnly Cookie。
   - 全站输出 `X-Robots-Tag: noindex, nofollow, noarchive` 响应标头，防止搜索引擎爬取。
3. **高可用可观测性与存储持久化**：
   - 宿主机独立持久卷 `sonic-staging-data` 挂载至 `/app/data`，开启 SQLite WAL 模式。
   - 在线备份支持 `sqlite3 VACUUM INTO` 快照，实测备份完整性通过。
   - 错误与监控指标暴露于 `/api/sonic/engine/health`，告警 Webhook 严格脱敏敏感参数。

### 3.2 本轮明确关闭的功能（Denylist / Fail-Closed）

1. **第三方商业音乐源**：
   - 网易云（NetEase）、QQ 音乐、酷狗（Kugou）、酷我（Kuwo）、GDStudio、Lyriva、VIP Unblock 等接口**在服务端逻辑中全面拒绝并返回 `403 Forbidden`**。
   - 绝不向未经书面授权的商业上游发送抓取请求。
2. **Epomail OAuth 2.0 登录**：
   - 服务端配置 `SONIC_ENABLE_OAUTH=0`，相关认证接口统一返回 403。
   - 前端无假登录死按钮，界面干净降级。
3. **SSRF 与内部网络代理**：
   - 阻断针对内网 IP、Localhost、私有网段以及云服务元数据端点（如 `169.254.169.254`）的请求，统一返回 `400 Bad Request`。

---

## 4. 已知缺陷及风险承担声明

1. **缺陷一：公测曲库仅包含 3 首基准合成音频**
   - *风险*：受邀用户可能反馈“搜不到流行歌曲”。
   - *应对*：分发邀请函时明确标注“本轮为底层播放器引擎、Range 切片拖动与网络性能技术封测，商业音乐曲库将在法务确认后择机上线”。
2. **缺陷二：无跨设备歌单与播放历史同步**
   - *风险*：因 OAuth 禁用，歌单与历史记录仅保存在当前浏览器的 LocalStorage 中，清理缓存后重置。
   - *应对*：单端持久化功能正常，技术上满足封闭测试需求。
3. **缺陷三：物理移动真机人工验收未覆盖全量机型**
   - *风险*：尽管 Chrome 148 与 Pixel 7 仿真测试全通，特定老旧移动设备可能存在边缘兼容差异。
   - *应对*：SRE 团队已准备 16 秒双向极速回滚机制，发生严重异常可即刻中止。

---

## 5. 隔离 Staging 最终部署核查清单

- [x] **绝对生产隔离**：确认生产项目 `cfsolara`、生产 Tunnel 与生产 DNS 零变动。
- [x] **发布 SHA 一致性**：确认 Pages 线上 `releaseCommit` 与 Engine 容器环境完全对齐。
- [x] **Staging 前端**：`https://sonic-staging.pages.dev`（当前部署 ID: `941be968-4fec-41cf-b712-0cc6063d3ec0`）。
- [x] **Staging Engine**：`https://engine-sonic-staging.epocanvas.tech`（Tunnel ID: `8275c237-56a2-4735-a751-6643af22883f`）。
- [x] **Docker 容器**：`sonic-staging-engine`（镜像 Digest: `sha256:8d73edd88854025105a60bddc9f162232e7b623b6c8e91650dcc658e664005eb`，内置 Healthcheck 为 `healthy`）。
- [x] **存储卷健康**：宿主机 Docker 卷 `sonic-staging-data`，非 Root 用户 `node:node` 权限隔离，`storageHealthy: true`。
- [x] **防爬防刷**：全站返回 `X-Robots-Tag: noindex, nofollow, noarchive`，匿名限流保护开启。

---

## 6. 上一可回滚 SHA 与秒级回滚基线

依据 [RUNBOOK-ROLLBACK.md](file:///home/shijian/projects/sonic/docs/RUNBOOK-ROLLBACK.md) 实测固化：

| 版本层级 | 标识 / SHA | 部署资源 / Digest | 实测回滚时间 |
|---|---|---|---|
| **当前发布版本** | `30b3602`（2026-10-31 线上实测：Pages `X-Sonic-Release` 与 `/api` releaseCommit 均为 `30b3602f52e9dc7e03f21f6f01b5eddd81491da3`；`c0fe1d3`/`f99f647` 仅含 docs 增量，代码内容与部署版本一致） | Pages `941be968` / Engine `sonic-engine:rc-30b3602` (`sha256:8d73edd...`) | 基线生效中 |
| **上一可回滚版本** | `4fb8e79` | Pages `48992d04-fd67-4d55-bff7-611489887585` / Engine `sonic-engine:rc-4fb8e79` (`sha256:4ad3a85...`) | **实测 RTO: 16 秒** |
| **基线版本** | `20e399f` | Pages `e64dd74e-1091-4750-b6d8-43af4885e105` / Engine `baseline-20e399f` (`sha256:4785f88...`) | 冷备保障 |

- **实测 RTO**：**16 秒**（后端 Docker 镜像替换 4 秒 + 前端 Pages API 回滚 12 秒）。
- **实测 RPO**：**0 秒**（SQLite WAL 独立持久卷，不因容器替换丢失任何已写事务）。

---

## 7. 公测实际访问范围与邀请方式

- **访问地址**：`https://sonic-staging.pages.dev`
- **专属邀请链接**：`https://sonic-staging.pages.dev/?staging_token=<受邀 Token 仅限私下渠道分发，禁止写入仓库>`（历史 Token 已于 2026-10-31 轮换作废；本仓库为公开仓库，任何凭据不得明文入库）
- **受众范围**：仅限持有受邀 Token 的核心开发者、测试人员与指定受邀伙伴。
- **保护机制**：无 Token 或无 Cookie 访问任何页面均直接拒绝为 401。

---

## 8. 负责人 GO / NO-GO 决策签字栏

| 决策维度 | 结论 | 负责人签字确认 | 确认日期 |
|---|---|---|---|
| **面向全网的大规模商业版公开发布** | ❌ **NO-GO** | `____________________` | 2026-10-31 |
| **第一方合成音源的隔离受控受邀公测** | ✅ **GO** | `____________________` | 2026-10-31 |

> [!NOTE]
> 签署 `GO` 代表已确认本轮仅开放 3 首第一方合成基准音频，已知悉商业第三方源与 OAuth 均已安全封禁。

---

## 9. 11 月后续迭代修复清单（限制五项以内）

1. **商业版权音源接入与合规协议**：待法务书面确认商业合作后，按白名单逐一放行音源及歌曲直链。
2. **Epomail OAuth 2.0 真实生产联调**：获取正式 Client ID/Secret，完成前端个人中心、歌单云同步与会话管理上线。
3. **物理多端真机深度人工评测**：在真实 iOS Safari、Android 移动端及各类车载/电视大屏浏览器进行全流程人机验收。
4. **Cloudflare 原生分布式限流绑定**：在 Cloudflare 平台配置原生 `RATE_LIMITER` 绑定，替代当前单实例内存降级限流。
5. **智能音乐推荐引擎调优**：引入站内搜索点击反馈流，基于持久化 SQLite 数据进一步优化相似歌曲与探索推荐准确率。

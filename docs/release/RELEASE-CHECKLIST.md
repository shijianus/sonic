# Sonic v2.2.0-rc.1 发布检查单

- UTC：2026-10-30T01:31:03Z
- 分支：`rc/sonic-20261031`
- 代码 SHA：`d29a32ff61caef96507176325f9b5e296360e3f4`
- 判定规则：任一硬门禁非 PASS，即 **NO-GO**；不得用“预计/应该”替代证据。

## 源码包重建与溯源门禁（2026-11-02）

以下是当前发布要求；本文其他历史 PASS 只适用于其注明的 SHA/日期，不能沿用到新包。

### 输入与信任边界

- `scripts/release-inputs.mjs` 的 `RELEASE_DIRECTORIES` / `REQUIRED_RELEASE_FILES` 是完整的显式输入策略，打包与摘要使用同一份列表。包含前后端源码、旧版 `js/` 安全测试输入、`player/build/public/scripts`、根/Player 单测与 E2E、`.github` CI、两份锁文件及包管理配置、根/Player tsconfig、Vite/Vitest/Playwright/ESLint/PostCSS/格式配置、主题 lint baseline、Dockerfile/Dockerfile.ncm/Compose/.dockerignore、发布/部署/备份恢复脚本、许可证、环境示例、运维/回滚手册。缺少必需文件或目录直接失败，不再静默跳过。
- `player/src/auto-import/imports.d.ts` 和 `components.d.ts` 必须入包/入摘要，保证先 typecheck 后 build；未被现行 lint 使用的生成文件 `eslintrc-auto-import.json` 不参与。构建若改写了已冻结声明，必须重新冻结/重建，不能忽略摘要变化。
- 仅打包列表中已核验的普通文件；不读取/复制私有 `.env*`、凭证/私钥、认证状态、历史、报告、SQLite、缓存、依赖目录或产物。只允许根及 Player 的 `.env.example`，拒绝软/硬链接。不要把秘密写入任何允许发布的源码文件；名称过滤不是秘密内容扫描器。
- `release.json` 保持原 `schemaVersion: 1` 的六个身份字段不变。`release-files.json` 保存排序路径、字节数、逐文件 SHA-256、聚合摘要及六字段身份校验值。必须同时验证，不能只看传入的 `SONIC_SOURCE_DIGEST`。摘要覆盖精确文件字节，解压后不要做换行转换。
- archive `.sha256` 需与独立受控渠道保存的值一致；包内清单/索引提供一致性检查，**不是签名/可信发布者证明**。不要仅信任与可疑压缩包一并替换的校验文件。

### 从空目录重建（Node 22.13+，pnpm 10.34.5）

发布负责人先完成全部源文件编辑并冻结，再 `npm run build`、`npm run build:engine`、`node scripts/package-release.mjs`。源文件变化后必须重建；打包脚本拒绝覆盖同名 archive。以下步骤针对该包的空目录解压副本，不读取本机秘密、不发布服务：

```bash
set -euo pipefail
# 先用独立保存的 SHA-256 核验 archive，再解压到空目录并进入该目录。
node scripts/release-inputs.mjs --verify release.json --index release-files.json
corepack enable
corepack prepare pnpm@10.34.5 --activate
npm ci
pnpm --dir player install --frozen-lockfile
npm run typecheck
npm run lint
npm test
pnpm --dir player test
npm run build
npm run build:engine
# archive 重建复用已核验的 release 身份，不需要 .git；禁止只校验 subset。
node scripts/release-inputs.mjs --verify release.json --index release-files.json
```

依赖目录/标准 build 输出可在二次核验时存在，不属于源码摘要。索引模式拒绝额外未索引文件（包括 `.env`、根日志和远端运行结果）；将操作报告/私有配置写到解压目录外。正常 checkout 的核验用 `node scripts/release-inputs.mjs --verify dist/release.json`；它仍校验全量源码但不要求 archive 索引。

### Docker / Compose 上下文

1. 在完整解压目录、任何 Docker build **之前**执行带 `--index` 的核验；staging 构建脚本必须先调用此 Node-only helper。后续根目录已有运行结果时，可用 `node scripts/write-release-manifest.mjs --digest` 重新算全量源摘要，但这不能替代首次严格解压核验。
2. 从同一 `release.json` 取 `baseCommit` → `SONIC_RELEASE_COMMIT`、`sourceDigest` → `SONIC_SOURCE_DIGEST`、`releaseId` → `SONIC_RELEASE_ID`、`buildTime` → `SONIC_BUILD_TIME`、`dirty` → `SONIC_RELEASE_DIRTY`，全部传给 Docker build；参见 [回滚手册 §2](../RUNBOOK-ROLLBACK.md#2-部署前强制检查清单)。不得把新构建时间/旧 SHA 拼接成另一份身份。
3. Docker 前端 stage 只有 `player` 和 manifest helpers。`--partial-docker-stage` 明确只复制传入身份并输出警告，不冒充全源码摘要对比；普通 writer（包括 `--digest`）始终重算并核对任何传入摘要。
4. 两份 Dockerfile 使用已在 2026-11-02 staging 构建验证的同一 `node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`，不是升级基底。前端 frozen pnpm lock、引擎 `npm ci`。NCM 侧车顶层包固定 `4.41.1`，但全局 npm 安装没有独立传递依赖锁；不能宣称侧车逐字节可复现，发布时另存已构建侧车镜像 digest。
5. `docker-compose.yml` 的两个 build context 都是包根目录，两份 Dockerfile 必须存在。仅做结构验证可用 `docker compose --env-file /dev/null config --no-interpolate --no-env-resolution --quiet`，不读取 `.env`。真实 build/run 需运维在源码包之外保管并按部署方式提供配置/密钥；不要把配置回打入包。
6. 构建后核对 OCI labels、前端 `release.json`、Engine health 的五个身份值。安装/编译通过不等于 UI、音频、真实上游或当前服务回滚通过；相应浏览器和运行环境证据单列。

回滚必须是**匹配的镜像 + 数据库快照**，使用 `--offline` 的恢复工具且保留新数据；隔离恢复测试与当前运行中服务的双向回滚演练分开记录，后者无证据时为 **NOT REHEARSED**。

## A. 代码与质量硬门禁

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| A1 | 已知 P0 代码层闭环（A/B/C/D） | PASS | `RC-SUMMARY.md` §3；auth/oauth/ssrf/engine 测试 |
| A2 | TypeScript 根 + Player 0 错误 | PASS | `npm run typecheck` exit 0 |
| A3 | ESLint + 主题 Lint 无新增错误 | PASS | `npm run lint` exit 0 |
| A4 | 根 jiti 套件 | PASS | gateway 60 / auth 43 / cover 15 / engine 49 |
| A5 | Vitest 安全/OAuth/SSRF/推荐 | PASS | 9 文件 129 例 |
| A6 | Player 单测 | PASS | 8 文件 38 例 |
| A7 | 浏览器 E2E（Mock 网关） | PASS | 24/24；桌面 20 + 移动 4 |
| A8 | 前端构建 | PASS | `npm run build` exit 0 |
| A9 | 引擎构建 | PASS | `npm run build:engine` exit 0 |
| A10 | 引擎鉴权 fail-closed | PASS | 200/401/401/200/401 冒烟 |
| A11 | 远端 CI（quality/Docker/Browser E2E） | PASS | run `40986077957`（`d29a32f`）三作业 success |

## B. 安全硬门禁

| # | 检查项 | 结果 | 证据/缺口 |
|---|---|---|---|
| B1 | 伪造/过期/撤销/越权 Key 拒绝 | PASS | auth 43 例、security 20 例 |
| B2 | 旧无签名 Key 拒绝 | PASS | 无兼容后门；需重新登录 |
| B3 | OAuth state 随机、一次性、PKCE S256 | PASS（Mock） | 18 例；真实账号 NOT RUN |
| B4 | 会话不在 URL/日志中泄露 | PASS（代码） | HttpOnly Cookie；no-store；日志不含 query |
| B5 | SSRF 内网/Metadata/重定向/DNS 防护 | PASS（测试） | 11 例；真实 CDN NOT RUN |
| B6 | 开放代理仅供应商音乐域 | PASS | `45b9a5e`；邮件域/后缀伪装拒绝 |
| B7 | Engine 不依赖 Host 认证 | PASS | 本地伪造 Host 仍 401 |
| B8 | 限流/配额全局一致 | PARTIAL | 无 Cloudflare 原生 `RATE_LIMITER` 时为近似限流 |
| B9 | 凭证/密钥未入库 | PASS（本轮范围） | 未提交真实密钥；测试用临时值已清理 |
| B10 | 路径大小写不能绕过访问/引擎门禁 | PASS（本轮新增） | `canonicalPolicyPath` 覆盖 `requireAccess`/`requiresEngineAuth`；回归用例含 `/API/...` 变体 |
| B11 | 匿名请求不可投毒全局熔断 | PASS（本轮新增） | 4xx 不再计失败；502 不再立即跳闸；身份配置错误不计熔断 |

## C. 真实环境硬门禁

| # | 检查项 | 结果 | 所需输入 |
|---|---|---|---|
| C1 | 真实 OAuth 登录/回调/刷新/退出/撤销 | NOT RUN | 测试账号 + Staging |
| C2 | 真实 CDN Range/206、Seek、暂停恢复 | PARTIAL | 第一方 CC0 合成源经真实 Pages→Tunnel→Engine 200/206/416 逐字节 PASS；商业 CDN BLOCKED（待授权） |
| C3 | 真实 403/429/断网降级 | PASS（合成故障注入） | `syn-fault-403/429/500/timeout` 实测 403/429/502/504 |
| C4 | 逐源音源/歌词/封面授权 | BLOCKED | 负责人/法务书面确认未到位；已 `strict-allowlist` 服务端强制关闭 |
| C5 | Staging 部署与版本 SHA 一致 | PASS（agy 环境） | `sonic-staging.pages.dev`；`X-Sonic-Release`/`releaseCommit` 等于部署 SHA |
| C6 | 应用版本回滚演练（RTO/RPO） | PASS（agy 环境） | 回滚 RTO 2,406 ms、前向恢复 1,756 ms、RPO 0 |
| C7 | 监控/告警（5xx/P95/健康/存储） | PASS（agy 环境） | metrics 端点 + 脱敏 + Webhook 实测送达 |
| C8 | iOS Safari / Android Chrome 真机 | NOT RUN | 实机 |
| C9 | 桌面跨浏览器人工验收 | NOT RUN | 浏览器矩阵 |
| C10 | 无障碍人工验收 | PARTIAL | 自动化 a11y 已跑；人工未做 |

## D. 部署前检查（仅在 C 项满足后执行）

- [ ] 固定发布 SHA，并在部署产物/健康端点暴露 `SONIC_RELEASE_COMMIT`。
- [ ] 生产部署必须显式设置 `SONIC_ENV=production`；预览部署显式设置 `SONIC_ENV=preview` 或 `SONIC_ENV=staging`。
- [ ] 生产部署必须显式设置 `SONIC_ACCESS_MODE=open` 或 `SONIC_ACCESS_MODE=invite`；缺失或非法值会被 Edge 以 503 拒绝。
- [ ] 生产部署必须设置 `SONIC_CONTENT_POLICY=strict-allowlist`，且 `SONIC_ALLOWED_SOURCES` 非空并仅包含 APPROVED/CONDITIONAL 源；缺失、`default`、空名单、PROHIBITED 或未登记源都会使 Edge/Engine 返回 503 `CONTENT_POLICY_MISCONFIGURED`。
- [ ] 已记录 2026-11-05 负责人直接授权 `netease/qq/kugou/kuwo/amll/lrclib`；正式授权文件由项目方归档，见 `CHECKLIST.log`。`gdstudio/lyriva/unblock` 仍为 PROHIBITED，禁止开启。
- [ ] 生产 readiness 还必须至少解析出一个运行时启用的音频源（`effectiveSources` 中至少一个具备 `audio` 能力）；仅有 `synthetic`（生产强制关闭）、Apple 或 catalog/lyrics-only 源会返回 503 `no_runtime_enabled_sources`。
- [ ] 邀请码每个至少 16 字符；需要单次使用或服务端撤销时必须配置 `SONIC_ACCESS_DB_PATH`（Engine），Pages-only 签名会话只适合短 TTL 的受控内测。
- [ ] 撤销邀请码使用 `npm run revoke:invite -- <access.sqlite> <code>`，并在撤销后确认 `revoked:true`；轮换 `SONIC_ACCESS_SECRET` 可让全部已签发会话失效。
- [ ] Pages 环境不得设置 `SONIC_RUNTIME=linux-engine`；该变量只属于 VPS Engine。
- [ ] 多 isolate Pages 生产必须绑定 `RATE_LIMITER`；生产默认要求分布式限流，缺失时 API 与 health 会 fail-closed（503），不得依赖 isolate 内存限流。
- [ ] 交付后真实环境验收按根目录 `CHECKLIST.log` 执行；完整管理员后台、配额/封禁/审计等滥用治理由 Epomail 统一开发并签字。
- [ ] 生产部署必须设置 `SONIC_DEPLOY_VERIFY_URL`（线上域名）并保留 `SONIC_ENGINE_SECRET`，部署后脚本会核对 `/release.json`、`X-Sonic-Release` 与 health 的 release/contentPolicy/access 五元组；无法验证时不得上线。
- [ ] 生产/内测环境配置 `SONIC_SECRET`、`SONIC_ENGINE_SECRET`（≥32 字符，随机）。
- [ ] 确认 `SONIC_ENABLE_UNBLOCK=0`、`SONIC_ENABLE_GDSTUDIO=0`、`SONIC_ENABLE_LYRIVA=0`。
- [ ] 仅启用已授权音源；未授权源不可达。
- [ ] 内测访问控制生效（Access/Basic Auth/IP 白名单），`robots`/响应头禁止索引。
- [ ] 若启用 Shijianus-Blog 随身听桥接，构建时必须设置 `VITE_SONIC_BRIDGE_ORIGINS=https://<blog-origin>`；未设置时跨站桥接按安全默认拒绝（只允许同源）。
- [ ] 公测前确认事件写入配额生效（每 IP 4,000/min、每匿名 subject 600/min，超出 429）。
- [ ] OAuth 未验收时隐藏登录入口，关闭需身份的写操作。
- [ ] 备份当前 SQLite，记录备份路径与校验结果。
- [ ] 记录上一可回滚版本 SHA 与构建产物位置。
- [ ] 确认 Tunnel/DNS 变更窗口与回滚负责人。

## E. 部署后冒烟（真实 HTTP）

- [ ] `GET /` 200，静态资源 200。
- [ ] 引擎健康：无 Key 401，带 Key 200；伪造 Host 仍 401。
- [ ] **路径大小写：`/api/sonic/engine/health`、`/API/sonic/engine/health`、`/Api/Sonic/Engine/Health` 无 Key 均须 401；invite 模式下 `/api/...` 与 `/API/...` 推荐接口均须 401（Pages 路由大小写不敏感）。**
- [ ] 搜索：真实关键词返回结果，403/429/断网有明确错误态。
- [ ] 播放：真实授权曲目可播放，Range/206 与 Seek 正常。
- [ ] 歌词：逐字/普通/无歌词降级均正常。
- [ ] 收藏/队列：刷新后恢复；清空行为符合预期。
- [ ] OAuth（若开启）：登录/回调/退出/撤销全链路。
- [ ] 版本：线上健康端点 SHA 与发布 SHA 一致。
- [ ] 回滚：按预案回滚到上一 SHA 并复测健康/首页/搜索。

## F. 当前 P0 / P1 计数（2026-10-30 集成后）

- 集成 SHA：`e0adb20755f0fe38494c517addb0ce9d273fb6a6`
- Windows 复跑：`tsc` 0 错误、`npm test` 142 例通过、`npm run lint` 0、`npm run build` 成功、Playwright 24/24。
- P0 代码层未闭环：0
- P0 环境/合规未闭环：2 BLOCKED + 1 PARTIAL
  - P0-05 真实 OAuth：BLOCKED（缺凭据与测试账号）
  - P0-06 真实流：PARTIAL（第一方合成源已 PASS；商业 CDN BLOCKED）
  - P0-07 内容授权：BLOCKED（缺法务书面确认）
- P1 未完成：1（P1-05 真机与人工无障碍；自动化 a11y 已过）
- 受控内测（仅第一方合成音源）：**CONDITIONAL GO** 候选
- 对公众发布：**NO-GO**

> 「agy 环境」表示证据来自 Linux 侧一次性实测，Windows 环境未复跑；详见
> `reports/handoff/ZCODE-INTEGRATION-20261030.md` §3。

---

# 2026-10-31 公测冲刺复跑（`1cc1ac8`）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| A12 | 公测异常态 E2E（404/503/挂起超时） | PASS | `resilience.spec.ts` 13 例 |
| A13 | 主要路由/切换/404/无登录入口 | PASS | `routes.spec.ts` 15 例 |
| A14 | 起播挂起不再无限加载 | PASS | 15s 看门狗 + E2E；修复前 25s 无提示 |
| A15 | 播放历史持久化 | PASS | 播放 → 最近播放 → 刷新后仍在 |
| A7 | 浏览器 E2E 全量 | PASS | **43/43**（桌面 39 + 移动 4） |
| A2–A9 | typecheck/lint/root tests/player tests/build/engine | PASS | 同 SHA 复跑 |

`npm test`：jiti 167 + Vitest 142；player 38。完整记录见
`reports/handoff/evidence/public-beta-windows-20261031.log`。
C 项外部门禁（OAuth、商业 CDN、逐源授权、真机）状态未变。

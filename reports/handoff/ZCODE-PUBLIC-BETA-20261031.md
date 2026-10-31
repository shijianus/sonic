# ZCode 公测冲刺交接 — Windows 前端与集成验收

- UTC：2026-10-31T02:41:48Z
- 工作分支：`work/zcode-beta-20261031-20261031T013704Z`
- 基线 RC：`401dbcee7be316300bf26375d6eec41a754f8bc2`（`origin/rc/sonic-20261031`）
- 本轮验证代码 SHA：`1cc1ac86548f7700db649a08b70f4fbbbce0f79b`
- 分支 tip：代码提交 `1cc1ac8` + 本交接/发布文档提交（推送后以 `git ls-remote` 为准）
- 环境：Windows 11 10.0.26200 x64 / Node v24.14.0 / npm 11.9.0 / pnpm 10.34.5 / 系统 Chrome
- 范围：仅 `player/src/**`、`player/e2e/**` 与发布文档；未修改 `server/**`、`functions/**`、Docker、Cloudflare 配置。

## 1. 结论

- **代码层 P0：0。** 现有 RC 的认证、SSRF、引擎鉴权、播放竞态与错误降级保持通过。
- 本轮发现并修复 **1 个真实 P1（公测阻断级）**：上游只返回响应头、不发送音频时，前端会永久 `isLoading`，用户看到无限加载且无任何提示。已用 E2E 复现并在修复后转绿。
- 附带修复 **503 降级提示被泛化文案覆盖**：播放错误 Toast 的节流键原来只含“歌曲 + 错误类型”，导致更准确的“服务降级”原因被同类型的泛化提示吞掉；现节流键包含具体文案。
- **受控公测（匿名 + 仅第一方/合成音源）：CONDITIONAL GO。** 前端 10 项公测功能均已由自动化证据覆盖；真实 OAuth、商业 CDN、逐源授权、真机仍为外部阻断。
- **对公众开放商业音源：NO-GO（维持）。** 阻断项与 2026-10-30 相同，均为外部输入，不是代码缺陷。

## 2. 实际修改

| 文件 | 修改 | 原因 |
|---|---|---|
| `player/src/stores/modules/audio.ts` | 新增 15s 起播看门狗；超时后停止媒体、递增播放代次、清除 loading、弹出可重试网络错误；Toast 节流键纳入具体文案 | 挂起流不触发 `error`，`stalled` 仅打印日志，`audio.play()` 永久 pending；503 具体原因被泛化提示覆盖 |
| `player/e2e/mock-server.mjs` | 新增 9306（200 响应头后挂起）、9307（404）、9308（503 降级）夹具与 `errors` 搜索词 | 为公测要求的 404/503/超时提供确定性复现 |
| `player/e2e/specs/resilience.spec.ts` | 新增 404、503、挂起超时 3 个用例 | 把修复锁定为浏览器级验收 |
| `player/e2e/specs/routes.spec.ts`（新增） | 12 条主要路由、侧边栏连续切换、未知路由 404、匿名模式无登录入口，共 15 例 | 覆盖“首页/主要路由不白屏”“无登录死入口” |
| `reports/handoff/evidence/public-beta-windows-20261031.log`（新增） | 本轮命令、结果、修复前失败证据 | 可复核证据 |
| `reports/handoff/ZCODE-PUBLIC-BETA-20261031.md`（本文件） | 交接 | — |
| `docs/release/RC-SUMMARY.md`、`docs/release/GO-NO-GO.md` 等 | 追加 2026-10-31 公测回归结论 | 最终发布文档统一维护 |

## 3. 修复前复现与修复后验证

修复前（同一构建产物）：

- 播放 404：PASS（有错误 Toast，页面可用）。
- 播放 503：**FAIL** — 显示 `This audio source is unavailable. Try another track.`，未显示服务降级原因。
- 挂起流 9306：**FAIL** — 25s 内无任何提示，`isLoading` 一直为 true。

修复后：

- `resilience.spec.ts`：13/13 PASS（含上述 3 例）。
- `routes.spec.ts`：15/15 PASS。
- 全量 E2E：43/43 PASS。

## 4. 完整回归结果（最终工作树）

| 命令 | 结果 | exit |
|---|---|---|
| `npm ci` | 39 packages，0 vulnerabilities | 0 |
| `pnpm --dir player install --frozen-lockfile` | lockfile 最新，Already up to date | 0 |
| `npm run typecheck` | 根 + Player `vue-tsc` 0 错误 | 0 |
| `npm run lint` | 主题基线 430 项既有；ESLint 0 | 0 |
| `npm test` | jiti 167（gateway 60 / auth 43 / cover 15 / engine 49）；Vitest 10 文件 142 例 | 0 |
| `pnpm --dir player test` | 8 文件 38 例 | 0 |
| `npm run build` | `dist/` 270 文件；`index.html` 32 个静态引用全部存在 | 0 |
| `npm run build:engine` | `dist-server/index.mjs` 816.3 kb | 0 |
| `E2E_CHANNEL=chrome pnpm --dir player exec playwright test` | **43/43 PASS**（桌面 39 + 移动 4，6.8 分钟） | 0 |

E2E 使用确定性 Mock 网关与本地 WAV，**不代表真实 CDN/OAuth/真机**。

## 5. 公测最小验收清单

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | 首页与主要路由加载 | PASS | routes 15 例（12 路由 + 切换 + 404） |
| 2 | 搜索成功 / 失败呈现 | PASS | core 搜索播放；403/429/断网/异常 JSON/空结果 |
| 3 | 起播、暂停、恢复、切歌 | PASS（Mock WAV） | core 3 例 + resilience 竞态 2 例 |
| 4 | 播放进度与 Seek | PASS（WAV 206） | core Seek 例断言 currentTime 与 aria-valuenow |
| 5 | 歌词同步 / 无歌词降级 | PASS | core 歌词 2 例 |
| 6 | 队列顺序、当前索引、上下首 | PASS | `queueIntegration.test.ts`；E2E 连续下一首 |
| 7 | 收藏与历史持久化 | PASS | 收藏刷新 E2E；播放历史 E2E（播放 → 最近播放 → 刷新后仍在）；历史在 audio persist 白名单 |
| 8 | 403/404/429/503/超时/断网提示 | PASS（Mock） | resilience 6 类错误态 |
| 9 | 不白屏 / 不无限加载 / 不连环跳歌 | PASS | routes 冒烟；挂起看门狗；错误仅提供“重试/下一首”，不自动连跳 |
| 10 | 桌面与移动端主要操作 | PASS（模拟器） | Pixel 7 4 例 + 桌面 38 例；真机 NOT RUN |
| 11 | 关闭 OAuth 后无死入口 | PASS | 无登录页面/路由/按钮；E2E 断言无 Login 入口 |
| 12 | 仅授权内容可用 | 服务端强制 | `strict-allowlist`；前端按服务端返回展示；逐源授权 NOT RUN |

## 6. 尚未验证（NOT RUN / 外部阻断）

| 项目 | 状态 | 所需输入 |
|---|---|---|
| 真实 OAuth 登录/刷新/退出/撤销 | BLOCKED | Epomail 测试账号与 Staging 凭据 |
| 商业 CDN 真实 Range/206/Seek | PARTIAL | 商业音源授权；第一方合成源已在 agy 环境通过 200/206/416 |
| 逐源音源/歌词/封面授权 | BLOCKED | 负责人/法务书面确认 |
| iOS Safari / Android Chrome 真机 | NOT RUN | 实机 |
| 桌面跨浏览器人工/无障碍人工 | NOT RUN | 人工验收 |
| Windows 环境复跑 Staging 全链路 | NOT RUN | Staging 访问与部署授权 |
| 生产部署/密钥轮换 | NOT RUN | 未获批准，未执行 |

## 7. P0 计数

- 代码层 P0：**0**
- 本轮新增代码级公测阻断：**0**（已修复的挂起无限加载按 P1 记录，修复前阻断公测）
- 外部环境 P0：**3**（2 BLOCKED：OAuth、内容授权；1 PARTIAL：商业 CDN）
- 受控公测（匿名 + 仅第一方/合成音源）代码阻断：**0**

## 8. GitHub 与合并

- 工作分支：`work/zcode-beta-20261031-20261031T013704Z`
- 分支页面：https://github.com/shijianus/sonic/tree/work/zcode-beta-20261031-20261031T013704Z
- 与 RC 对比：https://github.com/shijianus/sonic/compare/rc/sonic-20261031...work/zcode-beta-20261031-20261031T013704Z
- 远端 CI：run [41161277751](https://github.com/shijianus/sonic/actions/runs/41161277751)（`205171e`）—
  **success**：Typecheck/lint/tests/build、Docker build + runtime smoke、Browser E2E 三作业全部 success。
  后续 docs-only 提交不改变上述代码门禁结论。
- 建议合并顺序：
  1. 评审本分支 4 个代码/E2E 文件（无冲突面，未触碰 Linux 负责目录）。
  2. `git merge --ff-only` 或 PR 合入 `rc/sonic-20261031`，在 RC 上复跑 CI 三作业。
  3. 受控公测部署前确认：`SONIC_STAGING_ACCESS_TOKEN`、`noindex`、`strict-allowlist`、`SONIC_ENABLE_OAUTH=0`、`SONIC_REQUIRE_AUTH=0`、`SONIC_RELEASE_COMMIT`。
  4. `main` 保持不动，直至外部 P0 关闭并获人工 GO。
- 是否可进入最终集成：**YES（仅限受控公测）**；公众商业发布仍 **NO-GO**。

## 9. Git 安全记录

未使用 `reset --hard`、`clean`、`restore`、强制 checkout、`push --force`；未 stash、未覆盖他人提交。
工作分支从 fetch 后的 `origin/rc/sonic-20261031` 新建；合并前确认本地 `rc` 与远端同 SHA `401dbce`。

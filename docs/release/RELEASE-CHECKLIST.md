# Sonic v2.2.0-rc.1 发布检查单

- UTC：2026-10-30T01:31:03Z
- 分支：`rc/sonic-20261031`
- 代码 SHA：`d29a32ff61caef96507176325f9b5e296360e3f4`
- 判定规则：任一硬门禁非 PASS，即 **NO-GO**；不得用“预计/应该”替代证据。

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

## C. 真实环境硬门禁

| # | 检查项 | 结果 | 所需输入 |
|---|---|---|---|
| C1 | 真实 OAuth 登录/回调/刷新/退出/撤销 | NOT RUN | 测试账号 + Staging |
| C2 | 真实 CDN Range/206、Seek、暂停恢复 | NOT RUN | 授权音源 + Staging |
| C3 | 真实 403/429/断网降级 | NOT RUN | 授权音源/可控故障注入 |
| C4 | 逐源音源/歌词/封面授权 | NOT RUN | 负责人/法务 |
| C5 | Staging 部署与版本 SHA 一致 | NOT RUN | 部署凭据 |
| C6 | 应用版本回滚演练（RTO/RPO） | NOT RUN | 变更授权 |
| C7 | 监控/告警（5xx/P95/健康/存储） | NOT RUN | 监控方案 |
| C8 | iOS Safari / Android Chrome 真机 | NOT RUN | 实机 |
| C9 | 桌面跨浏览器人工验收 | NOT RUN | 浏览器矩阵 |
| C10 | 无障碍人工验收 | PARTIAL | 自动化 a11y 已跑；人工未做 |

## D. 部署前检查（仅在 C 项满足后执行）

- [ ] 固定发布 SHA，并在部署产物/健康端点暴露 `SONIC_RELEASE_COMMIT`。
- [ ] 生产/内测环境配置 `SONIC_SECRET`、`SONIC_ENGINE_SECRET`（≥32 字符，随机）。
- [ ] 确认 `SONIC_ENABLE_UNBLOCK=0`、`SONIC_ENABLE_GDSTUDIO=0`、`SONIC_ENABLE_LYRIVA=0`。
- [ ] 仅启用已授权音源；未授权源不可达。
- [ ] 内测访问控制生效（Access/Basic Auth/IP 白名单），`robots`/响应头禁止索引。
- [ ] OAuth 未验收时隐藏登录入口，关闭需身份的写操作。
- [ ] 备份当前 SQLite，记录备份路径与校验结果。
- [ ] 记录上一可回滚版本 SHA 与构建产物位置。
- [ ] 确认 Tunnel/DNS 变更窗口与回滚负责人。

## E. 部署后冒烟（真实 HTTP）

- [ ] `GET /` 200，静态资源 200。
- [ ] 引擎健康：无 Key 401，带 Key 200；伪造 Host 仍 401。
- [ ] 搜索：真实关键词返回结果，403/429/断网有明确错误态。
- [ ] 播放：真实授权曲目可播放，Range/206 与 Seek 正常。
- [ ] 歌词：逐字/普通/无歌词降级均正常。
- [ ] 收藏/队列：刷新后恢复；清空行为符合预期。
- [ ] OAuth（若开启）：登录/回调/退出/撤销全链路。
- [ ] 版本：线上健康端点 SHA 与发布 SHA 一致。
- [ ] 回滚：按预案回滚到上一 SHA 并复测健康/首页/搜索。

## F. 当前 P0 / P1 计数

- P0 代码层未闭环：0
- P0 环境/合规未闭环：3（P0-05 OAuth、P0-06 真实流、P0-07 授权）
- P1 未完成：5（竞态真实网络、异常真实链路、metrics/告警、Staging/回滚、真机/OAuth/无障碍）
- 发布判断：**NO-GO**

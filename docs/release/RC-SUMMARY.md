# Sonic v2.2.0-rc.1 RC Summary

- 更新时间：2026-10-30T01:31:03Z
- 集成分支：`rc/sonic-20261031`
- 本轮代码 SHA：`d29a32ff61caef96507176325f9b5e296360e3f4`
- **当前集成 SHA：`e0adb20755f0fe38494c517addb0ce9d273fb6a6`**（2026-10-30T13:07:44Z 快进合并 agy 后端加固，见 `reports/handoff/ZCODE-INTEGRATION-20261030.md`）
- 基线：`1d45e4cb38f6346f9a964d31fdba421c01d5e28b`（`release/rc-20261031` / `security/release-readiness-20261029` 内容）
- 远端 CI：run `40986077957` — **success**（quality / Docker smoke / Browser E2E 三作业）
- 发布判断：**NO-GO（不可对公众发布；受控内测亦未获准部署）**

## 1. 结论摘要

代码、构建、类型、Lint、安全负向测试与 Mock 层浏览器 E2E 均通过；阻断 GO 的不是工程质量，
而是缺少真实环境证据与授权：真实 OAuth 账号闭环、真实 CDN Range/206、逐源内容授权、
Staging 部署与回滚演练、真机验收、生产告警。以上任一项未关闭前，不得把当前状态描述为“已可内测”。

本轮额外收紧了 SSRF/开放代理边界，并修复了两个会静默影响运维与版本追踪的 P2 缺陷。

## 2. 本次实际修改

| 提交 | 内容 | 风险/回滚 |
|---|---|---|
| `45b9a5e` | 音乐代理白名单移除 `qq.com`、`163.com` 顶点域，新增 `qqmusic.qq.com`；负向测试覆盖邮件域拒绝、后缀伪装拒绝 | 若某个未登记的音乐 CDN 不在新白名单，会 400；回滚该提交即可恢复旧白名单 |
| `d29a32f` | `SONIC_ENABLE_FREE_MATCH` 旧名兼容读取（新名优先）；UA/player 版本统一到 2.2.0；README 内测范围与 P95 口径修正；新增 `tests/config-parity.test.ts` | 纯配置/文档/版本，回滚无数据影响 |

## 3. P0 状态（代码层已闭环，环境层未闭环）

| ID | 项目 | 代码/自动测试 | 真实环境 | 结论 |
|---|---|---|---|---|
| P0-A | API Key 身份伪造 | v2 HMAC-SHA256、iat/exp/jti/kid、轮换/撤销、旧格式拒绝；auth 43 例 + security 20 例 | 无真实老 Key 迁移样本 | **代码 CLOSED**；旧 Key 需重新登录 |
| P0-B | OAuth state/PKCE | 256-bit state、S256 PKCE 强制、HttpOnly Cookie、URL 不含 Key、重放拒绝；18 例 | 未用真实 Epomail 账号联调 | **代码 CLOSED**；真实闭环 OPEN |
| P0-C | 开放代理/SSRF | 供应商音乐域白名单、逐跳重定向校验、协议/端口/内网/Metadata 拦截、响应类型与大小限制、Range 透传；SSRF 11 例 | 真实 CDN 206/Seek 未验证 | **代码 CLOSED**；真实流 OPEN |
| P0-D | Engine 服务认证 | `SONIC_RUNTIME=linux-engine` 时所有 `/api` 强制 `X-Sonic-Engine-Key`，不读 Host/X-Forwarded-Host；本地实测 200/401/401 | Staging 未部署 | **代码 CLOSED**；部署验证 OPEN |

## 4. 本轮实际验证

环境：Windows 11 10.0.26200 x64、Node v24.14.0、npm 11.9.0、pnpm 10.34.5、系统 Chrome。

| 检查 | 命令 | 结果 |
|---|---|---|
| 根 + Player 类型 | `npm run typecheck` | PASS，exit 0 |
| 主题 + ESLint | `npm run lint` | PASS，exit 0 |
| 全量根测试 | `npm test` | PASS，exit 0：gateway 60 / auth 43 / cover 15 / engine 49 + Vitest 9 文件 129 例 |
| Player 单测 | `pnpm --dir player test` | PASS，8 文件 38 例 |
| 浏览器 E2E | `E2E_CHANNEL=chrome pnpm --dir player exec playwright test` | PASS，24/24（桌面 20 + 移动 4，3.9 分钟） |
| 前端构建 | `npm run build` | PASS，exit 0 |
| 引擎构建 | `npm run build:engine` | PASS，exit 0 |
| 引擎鉴权冒烟 | 本地 `dist-server` + curl | 带 Key health 200；无 Key 401；伪造 Host/X-Forwarded-Host 401；静态首页 200；无 Key API 401 |
| 真实上游手测 | 本地引擎 + 真实网络 | 搜索 200；NetEase/QQ/Kugou/Kuwo 取流均返回 `404 unavailable`（受版权/地区/环境限制），**真实播放未通过** |

E2E 覆盖：首页、搜索→播放→暂停→恢复、快速切歌、Seek、歌词与降级、收藏刷新持久化、
取流中暂停、403/429/断网、搜索竞态、移动端搜索/播放/暂停/可访问名称/无横向溢出。
E2E 使用 Mock 网关与本地 WAV，**不代表真实 CDN/OAuth**。

## 5. 未关闭门禁

| 门禁 | 状态 | 所需输入/动作 |
|---|---|---|
| P0-05 真实 OAuth 闭环 | OPEN | Epomail 测试账号 + Staging 域名；登录/回调/刷新/退出/撤销 |
| P0-06 真实 CDN Range/206 | OPEN | 授权测试音源 + Staging；Seek、暂停恢复、403/429/断网 |
| P0-07 内容授权/ToS | OPEN | 负责人/法务逐源确认；未确认源默认关闭 |
| P1-04 Staging 部署与回滚演练 | OPEN | 部署凭据、访问控制、RTO/RPO 演练 |
| P1-03 指标与告警 | OPEN | 5xx/P95/健康/存储错误告警方案 |
| 真机/跨浏览器/无障碍人工验收 | NOT RUN | iOS Safari、Android Chrome 实机 |
| 运行版本追踪 | OPEN | 健康端点返回 release SHA/version |

## 6. 内测功能隔离要求（若负责人批准缩小范围）

1. 隐藏 OAuth/账号入口，关闭需身份的服务端写操作；不得用假登录替代。
2. 仅启用已书面授权的音源/歌词/封面；`SONIC_ENABLE_UNBLOCK`、`SONIC_ENABLE_GDSTUDIO`、
   `SONIC_ENABLE_LYRIVA` 保持 `0`。
3. 未验证 Range 的源不得对外宣称可拖动；保留 503/不可用提示。
4. 内测环境必须加访问控制（Access/Basic Auth/IP 白名单）并禁止搜索引擎索引。
5. 部署必须写入并暴露 `SONIC_RELEASE_COMMIT`，确保线上版本与发布 SHA 可核对。

## 7. 下一步

1. 本轮 CI 已 success；保留证据链接，不重复跑同一 SHA。
2. 负责人提供 Staging 凭据、OAuth 测试账号、授权音源；完成 P0-05/06/07。
3. agy 完成健康端点版本字段、告警与回滚演练。
4. 在 Staging 复跑同款 E2E + 真机/跨浏览器人工验收。
5. 全部门禁满足后重新评估 GO；在此之前保持 NO-GO。

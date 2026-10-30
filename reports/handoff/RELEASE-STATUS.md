# Sonic RC / 内测发布状态

- 更新时间：2026-10-30 08:18 +0800 (UTC+8)
- 目标发布分支：`rc/sonic-20261031`
- RC 基线 SHA：`1d45e4cb38f6346f9a964d31fdba421c01d5e28b`
- Windows 工作分支：`work/zcode-20261031` @ `0a1b0e6`
- Linux 工作分支：`work/agy-20261031` — **不存在**；`feat/linux-backend` 已全部在 RC
- 合并到 RC 的 SHA：`0a1b0e6b1dc8dbe0c380975f417cc4bfb6f4a5ca`
- 最终 CI：https://github.com/shijianus/sonic/actions/runs/40979982255 — **success**
  （quality / Docker smoke / Browser E2E 全部通过，24 条 E2E）

## 1. 当前结论

**NO-GO（不可对公众发布；受控内测亦未获准部署）。**

原因不是构建或前端质量，而是以下发布门禁仍缺少真实环境证据：

| 阻断项 | 状态 | 说明 | 所需输入 |
|---|---|---|---|
| P0-05 真实 OAuth 闭环 | OPEN | 登录/回调/会话/退出/撤销未用真实账号验证 | 测试账号 + Staging 域名 |
| P0-06 真实 CDN Range/206 | OPEN | 仅完成 Mock 流与代理缓存单测 | 授权测试音源 + Staging |
| P0-07 内容授权/ToS | OPEN | 无逐源授权证据 | 负责人/法务确认 |
| P1-04 Staging 部署与回滚演练 | OPEN | 未部署、未演练 RTO/RPO | 部署凭据与变更授权 |
| P1-03 指标与告警 | OPEN | 有结构化日志/健康端点，无 metrics/告警 | 监控方案与凭据 |
| 运行版本追踪 | OPEN | 健康端点未返回 release SHA/version | 服务端补充并部署 |
| 真机/跨浏览器/无障碍人工验收 | NOT RUN | 仅自动化 Chromium 桌面+移动 | 设备与人工执行 |

## 2. 已完成且有证据的部分

- RC 基线、所有权与交接：`reports/handoff/BASELINE.md`（`ccf2469`）
- 前端播放/搜索/歌词竞态修复：`3b0eb4e`
- 浏览器 E2E 基础设施与 24 条用例：`player/e2e/**`，本地 24/24 PASS
- CI 覆盖 `rc/**`、`work/**` 并新增 Browser E2E：`5f97383`
- 远端 CI（`e74f376`）：https://github.com/shijianus/sonic/actions/runs/40978908684 — **success**
- 远端 CI（最终 RC `0a1b0e6`）：https://github.com/shijianus/sonic/actions/runs/40979982255 — **success**
  - Typecheck, lint, tests and build：success
  - Docker build and runtime smoke test：success
  - Browser E2E（mocked gateway, real media element）：success
- 本地证据：`reports/handoff/evidence/`（`*-20261030.log`）

## 3. 受控内测的功能隔离清单（若负责人批准缩小范围）

在以下条件全部满足前，相关能力必须关闭或不可达：

1. **登录/账号类**：隐藏 OAuth 入口，关闭收藏/云歌单/评论发布等需要身份的功能；
   不得伪造登录态或绕过服务端鉴权。
2. **未授权音源**：默认关闭未取得授权的源与 `SONIC_ENABLE_UNBLOCK` /
   `SONIC_ENABLE_GDSTUDIO` / `SONIC_ENABLE_LYRIVA`；仅保留已书面授权的测试内容。
3. **流代理**：保留 503 降级提示；未验证 Range 的源不得对外宣称可拖动。
4. **分享/公开索引**：内测环境加访问控制（Basic Auth / Access / IP 白名单），
   禁止被搜索引擎索引。
5. **发布版本**：部署时必须写入 `SONIC_RELEASE_COMMIT` 并在健康端点暴露，
   确保线上版本可核对。

## 4. 回滚

- 回滚目标版本：`1d45e4cb38f6346f9a964d31fdba421c01d5e28b`（上一 RC 基线）
- 应用侧：重新部署该 SHA 的构建产物。
- 边缘/隧道：`scripts/rollback-production.sh`（非破坏性合并 ingress，保留 engine-sonic）；
  文档见 `reports/release-readiness/RELEASE-PLAN.md` 与仓库 README。
- **演练状态：NOT RUN**。在完成演练前，不满足“可按预案回滚”的门禁。

## 5. 访问地址与部署 ID

- Staging URL：**无**
- Cloudflare Pages deployment id：**无**
- Docker image digest：**无**（本轮未构建/推送镜像；CI 仅本地构建）
- 说明：环境中存在 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，但**主动未部署**：
  1) 内测环境尚未配置访问控制（Access/Basic Auth/IP 白名单）；
  2) P0-07 音源/歌词/封面授权未确认，公开 Preview 可能构成未授权分发；
  3) 真实流代理/引擎未在 Staging 验证，前端单独部署无法形成可验收闭环。
  在负责人提供书面授权并完成访问控制与授权源隔离前，不执行任何对外部署。

## 6. 下一步（最短修复路径）

1. 负责人提供：Staging 部署凭据、OAuth 测试账号、授权测试音源/歌词授权结论。
2. agy：健康端点返回 release SHA/version；接入 5xx/P95/健康/存储告警；完成回滚演练。
3. Windows：在 Staging 复跑 `player/e2e` 同款用例（真实网络）+ 真机/跨浏览器人工验收。
4. 全部通过后重新评估 GO；在此之前保持 NO-GO。

---

## 7. 文档提交说明

本次状态更新提交仅修改 `reports/**`，不改变应用代码。代码与合并 SHA 仍为
`0a1b0e6b1dc8dbe0c380975f417cc4bfb6f4a5ca`，其 CI（quality / Docker / Browser E2E）
已 success（run 40979982255）。文档提交后的分支 HEAD 最新 CI 见：
https://github.com/shijianus/sonic/actions?query=branch%3Arc%2Fsonic-20261031

---

## 8. 2026-10-30 09:35 +0800 更新（ZCode 追加）

- 分支 HEAD：`d29a32f`（`rc/sonic-20261031`），CI run
  https://github.com/shijianus/sonic/actions/runs/40986077957 — **success**
  （quality / Docker smoke / Browser E2E 三作业）。
- 新增修复：`45b9a5e` 收紧音乐代理白名单（移除 `qq.com`/`163.com` 顶点域，新增
  `qqmusic.qq.com`，补负向测试）；`d29a32f` 修复 `SONIC_ENABLE_FREE_MATCH` 环境变量漂移，
  统一版本/UA 到 2.2.0，补 `config-parity` 测试与 README 内测范围。
- 本地复跑：typecheck/lint PASS；根测试 129 Vitest + 4 jiti；Player 38；E2E 24/24；
  build/build:engine PASS；引擎鉴权冒烟 200/401/401/200/401。
- 真实上游取流在本环境对 NetEase/QQ/Kugou/Kuwo 均返回 unavailable，搜索正常；
  P0-06 仍需授权音源与 Staging 验证。
- 发布判断不变：**NO-GO**。详细交接见 `docs/release/RC-SUMMARY.md`、
  `docs/release/HANDOFF-WINDOWS.md`、`docs/release/RELEASE-CHECKLIST.md`、`docs/release/DECISIONS.md`。
- `main` 分支保护状态无法通过未认证 API 确认；需管理员人工开启/核实。

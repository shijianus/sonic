# Sonic RC Baseline — 2026-10-31 内测收敛

- 更新时间：2026-10-30 07:00 +0800 (UTC+8)
- 目标 release branch：`rc/sonic-20261031`
- Base branch：`release/rc-20261031`
- Base SHA（完整）：`1d45e4cb38f6346f9a964d31fdba421c01d5e28b`
- 上游 `origin/main`：`ce443c8`（`origin/main` 是 base 的祖先，无需再次合并）
- 远端已有安全分支：`security/release-readiness-20261029`（与 base 同 SHA）

## 1. 为什么选这个基线

`release/rc-20261031` 由 `security/release-readiness-20261029` 推进而来，已包含：

- `81d8886` integration/main-work-recovery 合并（安全审计分支 + origin/main）
- 安全整改：XSS/SSRF/鉴权/限流/请求上限（`5d7bbb2`、`259e411`、`a48046b`）
- 搜索旧请求取消与播放地址去重（`dc23084`）
- 干净检出 typecheck 修复（`c44bd02` → RC 内 `cf947d3`）
- SQLite fail-closed 与健康检查真实性（`418f63c` → `6819197`）
- 音频代理缓存策略（`ccd63e5` → `60d3797`）
- CI 容器重建 + 命名卷持久化验证（`873e103`）
- 发布审计报告与证据：`reports/release-readiness/**`

`origin/main` 不含上述任何提交，因此**不能**以 main 为基线；也不重复 cherry-pick 已包含的修复。

## 2. 与 main 的差异

- 差异规模：224 个文件，+38537 / -1161（`git diff --stat origin/main...1d45e4c`）
- 主要范围：`server/**`（推荐引擎、SQLite、请求适配）、`functions/**`（安全与网关）、
  `player/**`（推荐/搜索/播放器）、`tests/**`（安全/OAuth/SSRF/推荐）、
  `.github/workflows/ci.yml`、`Dockerfile`、`docker-compose.yml`、`scripts/**`、发布报告。
- `origin/main` 是 base 的祖先，合并关系为快进，不存在分叉冲突。

## 3. 已纳入的安全与数据修复

| 项 | 提交 | 说明 |
|---|---|---|
| OAuth state + PKCE + 一次性消费 | 已在 base | `tests/oauth-security.test.ts` 18 例；真实账号仍 NOT RUN |
| SSRF safeFetch + 重定向逐跳校验 | 已在 base | `functions/_lib/sonic/security.ts`、`tests/ssrf-security.test.ts` |
| 流代理缓存降级 | `ccd63e5`/`60d3797` | 尊重上游 `private/no-store`，签名 URL 不进共享缓存 |
| SQLite 生产 fail-closed | `418f63c`/`6819197` | 存储不可用退出码 1，健康检查 503 |
| CI 持久化验证 | `873e103` | 同名卷删除/重建后 `eventCount=1` |
| 引擎鉴权 | 已在 base | `SONIC_RUNTIME=linux-engine` 时全 API 需 `X-Sonic-Engine-Key` |

## 4. 尚未纳入的变更

- `feat/linux-backend` 的 `b82bb3c`（`scripts/test-20-sample-songs.mjs`，20 首采样验收脚本）——
  待审查后集成。
- `3249c92`（回滚脚本非破坏性合并）——RC 中 `scripts/rollback-production.sh` 内容已与之一致
  （patch-equivalent，无需重复 cherry-pick）。
- 其他历史分支（`brand/**`、`feat/smart-reco`、`fix/ui-batch-*`、`ui/refactor-v2` 等）均已被 RC
  包含或与本次范围无关，不合并。
- 真实 Staging 部署、真实 OAuth 账号验收、音源授权确认：仍为开放阻断项。

## 5. 已知冲突

- 无 Git 文本冲突。
- 共享文件协调项：`package.json`、`player/package.json`、`pnpm-lock.yaml`、
  `package-lock.json`、`.github/workflows/ci.yml`、`.env.example`、`scripts/**`。
  本轮 Windows 侧计划对 `.github/workflows/ci.yml` 做最小改动（增加 RC/work 分支触发与
  浏览器 E2E 作业），并新增前端 E2E 依赖；改动前在本文件与 `RELEASE-STATUS.md` 记录。

## 6. 分支命名

| 角色 | 分支 | 基线 |
|---|---|---|
| Windows（ZCode，本轮） | `work/zcode-20261031` | `rc/sonic-20261031` |
| Linux（agy） | `work/agy-20261031` | `rc/sonic-20261031` |
| 集成/交付 | `rc/sonic-20261031` | `1d45e4c` |

双方不得直接写入对方工作分支；集成由 Windows 侧在 RC 分支完成，且必须重新跑完整门禁。

## 7. 当前 CI 结果

- `1d45e4c`（security/release-readiness-20261029 push）：
  https://github.com/shijianus/sonic/actions/runs/40895178350 — **success**
- 注意：现有 CI 触发规则只覆盖 `main` 与 `security/**`，`rc/sonic-20261031` 的 push
  不会自动触发 CI。本轮将把 `rc/**` 纳入触发范围（最小改动，见第 5 节）。

## 8. 文件所有权

| 范围 | Owner |
|---|---|
| `player/**`、`js/**`、`css/**`、`index.html`、前端测试/E2E | Windows (ZCode) |
| `server/**`、`functions/**`、Docker/Compose、Cloudflare/Linux 部署、流代理/鉴权/限流/健康检查、监控/备份/回滚、服务端 CI 验证 | Linux (agy) |
| `package.json`、锁文件、CI 配置、公共协议、`.env.example`、共享脚本 | 协调后最小改动，改动方在交接文件登记 |

## 9. 下一步可执行工作

1. Windows：在 `work/zcode-20261031` 修复播放暂停/停止与过期请求竞态，补单测与浏览器 E2E。
2. Windows：把浏览器 E2E 接入 CI（mock 范围明确标注，不冒充真实 CDN/OAuth）。
3. agy：以本基线创建 `work/agy-20261031`，按所有权推进服务端/部署项，并在
   `reports/handoff/AGY.md` 提供可复核证据。
4. 集成：仅接受带 CI/运行证据的 agy 分支；合并后对合并 SHA 重跑全部门禁。

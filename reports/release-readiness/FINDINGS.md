# Sonic 上线整改 — 问题清单（FINDINGS）

图例：**FIXED** 已修复并有测试；**VERIFIED** 已核验；**PARTIAL** 部分验证；**OPEN** 未解决；**NOT RUN** 未执行。

| ID | 级别 | 状态 | 证据 | 根因 | 涉及文件 | 修复/处置 | 验证 | 残余风险 |
|---|---|---|---|---|---|---|---|---|
| SONIC-P0-01 | P0 | FIXED | 干净检出 typecheck：741 errors / 61 处 `httpGet`（`evidence/typecheck-clean-checkout-BEFORE.log`） | `player/src/auto-import` 被 `player/.gitignore` 忽略，CI 在 build 之前跑 `vue-tsc`，声明文件不存在；`api/index.ts` 依赖自动导入的 `httpGet` | `player/.gitignore`、`player/src/auto-import/imports.d.ts`、`components.d.ts`、`.gitattributes` | 将 unplugin 生成且与源码一致的声明纳入版本控制，仅忽略目录内其他生成文件；固定 LF | 模拟干净检出（仅两份声明）`vue-tsc --noEmit` 退出 0；CI `ccd63e5` quality 作业 success | 声明文件未来若新增自动导入符号需随源码提交；缺失时 typecheck 会直接报错，不会静默 |
| SONIC-P0-02 | P0 | VERIFIED (CI) | CI run 40874656070 Docker 作业 success；本地 Docker 引擎不可用（WSL 无发行版） | 历史 main 使用 `COPY dist`；候选已改多阶段构建 | `Dockerfile`、`.dockerignore` | 保留现有多阶段构建，未重复改造 | CI 从干净检出 `docker build` + 启动容器 + 鉴权健康检查成功 | 本地无法独立复现构建；依赖 CI runner 环境 |
| SONIC-P0-03 | P0 | VERIFIED | `compose config` 卷映射 `sonic-data:/app/data`；CI run 40877176265 Docker 作业“Verify SQLite data survives container recreation” success；应用层重启/恢复演练通过 | 审计快照针对 main；候选已配置卷 | `docker-compose.yml`、`Dockerfile`、`.github/workflows/ci.yml` | 保留卷配置；新增容器重建持久化 CI 步骤 | 同一命名卷：写入事件 → 删除容器 → 重建 → `eventCount=1`、`storageKind=sqlite` | 本机 Docker 不可用，容器验证依赖 CI；生产备份策略仍需运维落地 |
| SONIC-P0-04 | P0 | FIXED | 原实现 catch 后返回内存 store；健康端点固定 `ok:true` | 持久化失败被静默降级，readiness 不反映真实存储 | `server/recommend-sqlite.ts`、`server/index.ts`、`functions/api/sonic/engine/health.ts` | 生产环境 fail-closed 抛错；启动先初始化、失败退出；健康端点按 store kind 返回 503 | 新增 4 个用例通过；不可写路径启动退出码 1（`evidence/engine-failclosed.log`）；DB 不可写时健康 503 | 运行中磁盘只读等故障只能在读写时暴露；建议 staging 加磁盘告警 |
| SONIC-P0-05 | P0 | OPEN (real account) | `tests/oauth-security.test.ts` 18 例通过 | 机制已实现，但真实 Epomail 账号闭环未执行 | `functions/api/auth/*`、`functions/_lib/auth/*` | 未改代码；仅核验与运行测试 | state 不匹配/缺失/重放、PKCE 缺失、跨站写、KV 撤销失败均拒绝 | 无真实账号授权验证；无法确认生产 redirect URI 与 Cookie 域配置 |
| SONIC-P0-06 | P0 | PARTIAL | 9 例 SSRF + 26 例 hardening 通过；缓存用例新增 2 例 | `stream.ts` 无条件把响应设为 `public, max-age=600`，覆盖上游 `private/no-store`，签名 URL 可进共享缓存 | `functions/api/music/stream.ts`、`tests/security-hardening.test.ts` | 按上游指令与敏感参数选择缓存策略 | private 透传、签名 URL `private, no-store` 用例通过；CI 全绿 | 真实 CDN 的 Range/206、断开取消、HEAD 未做浏览器实流验证；敏感参数白名单为启发式 |
| SONIC-P0-07 | P0 | OPEN | 仓库无逐源授权文件；SBOM 提示 GSAP/BSD 需人工复核 | 版权/ToS 属法务判断，代码无法替代 | `THIRD_PARTY_NOTICES.md`、provider 配置 | 未改默认开关；记录待确认清单 | SBOM 生成成功（99 组件），标记 2 项人工复核 | **上线阻断**：音源、歌词、封面授权范围未确认 |
| SONIC-P1-01 | P1 | PARTIAL | 搜索组件 generation + AbortController（`player/src/pages/mobile/search.vue:137-324` 等）；播放 `playbackGeneration`/`pendingUrlRequests`（`player/src/stores/modules/audio.ts:71,487-754`） | 历史竞态 | 前端搜索/播放模块 | 未改代码（已在 `dc23084` 修复） | 队列/音质/错误单测通过；无浏览器级竞态 E2E | 快速输入、连续切歌的真实 UI 行为未自动化验证 |
| SONIC-P1-02 | P1 | PARTIAL | `playbackErrors` 3 例、`queueIntegration` 6 例、`audioQuality` 2 例通过 | — | 前端播放/UI | 未改 | 单测通过 | 403/429/断网/引擎离线的 UI 提示与恢复未做 E2E |
| SONIC-P1-03 | P1 | OPEN | Node access log 仅 path/status/duration/requestId；无 metrics/告警 | 未建立可观测性栈 | `server/index.ts` | 未实施（不新增基础设施） | 日志样例见 engine 运行日志 | 5xx/P95/存储异常无告警，事故发现依赖人工 |
| SONIC-P1-04 | P1 | OPEN | 无 staging 部署记录；回滚步骤仅文档 | 发布工程未落地 | `reports/release-readiness/RELEASE-PLAN.md` | 编写手册，未执行 | 未演练 | 无法证明可回滚；**GO 阻断** |
| SONIC-P1-05 | P1 | NOT RUN | 无真机/真实账号 | 环境限制 | — | 列出人工步骤 | — | 移动端、Safari、VoiceOver/TalkBack 未验收 |

## 修复前后关键对比

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 干净检出 `pnpm --dir player typecheck` | 退出码 2，741 errors（61×httpGet） | 退出码 0 |
| DB 路径不可写（`NODE_ENV=production`） | 警告后使用内存 store，健康 `ok:true` | 启动退出码 1；若运行中降级则健康 503 |
| 上游 `Cache-Control: private` | 被覆盖为 `public, max-age=600` | 原样保留 |
| 带 `auth=` 的音频 URL | `public, max-age=600` | `private, no-store` |

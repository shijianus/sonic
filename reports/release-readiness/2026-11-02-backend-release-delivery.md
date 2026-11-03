# Sonic 后端发布交付记录 — 2026-11-02

结论：代码修复、完整回归、远端镜像构建、隔离候选容器、测试 Engine 切换和独立 Pages 预览的线上验收均已完成。此版本可用于现有邀请门禁下的受控测试；生产公开公测尚未切换，真实商业音源与生产身份/持久化配置仍需生产环境验收。

## 版本与交付物

| 项目 | 值 |
| --- | --- |
| Release ID | `a75f5cb54a2f-4f5900552319` |
| 基础提交 | `a75f5cb54a2fe3593ba0da72b7ee9b1cc5c410a8` |
| 源码 SHA-256 | `4f590055231990f2cca620ddd2cbcdc04b1c66a46e3353139442e726fb5596d6` |
| 构建时间 | `2026-11-01T22:58:34.946Z` |
| 工作树 | `dirty: true`，已通过源码摘要区分于基础提交；未擅自提交或推送 |
| 源码归档 | `artifacts/sonic-a75f5cb54a2f-4f5900552319.tar.gz`，1,365,146 bytes |
| 归档 SHA-256 | `a583ef08a1e6db7cc0b636e9332c49010d40f93255dceecd947992dfe97ff4a6` |
| Docker 不可变镜像 ID | `sha256:76cdce122a912d616d7997738ba82f3c08c0dd00f2ff25c594ef251257aebb78` |
| Pages 分支 | `rc-4f5900552319` |
| Pages deployment ID | `e1c474a0-5d18-453c-a612-7762e502b2c4` |

预览地址：https://rc-4f5900552319.sonic-staging.pages.dev

不可变部署地址：https://e1c474a0.sonic-staging.pages.dev

测试 Engine：https://engine-sonic-staging.epocanvas.tech

预览保留邀请门禁，匿名访问为 401 和 `noindex, nofollow, noarchive`。凭证没有写入本报告或发布包。稳定入口 `https://sonic-staging.pages.dev` 的前端未提升到本次预览版本；应使用上述预览地址评审此发布。

## 已完成的修复

- 统一 Engine 路由规范化和鉴权，覆盖 `/proxy/`、`/proxy///`、`/palette/` 等等价路径。
- 按音频、封面、歌词等能力收紧外部域名；识别解码后的签名参数和重定向敏感链，避免共享缓存及签名地址暴露。
- 补充上游首字节、活动 body、空闲超时和总时限预算；贯通客户端取消；避免合法长音频被短 JSON 时限截断。
- 熔断器增加请求代际，防止旧请求关闭新故障状态；SIGTERM 优雅停止并关闭 SQLite；健康检查包含磁盘、依赖、drain 和发布元数据。
- 推荐事件使用用户范围内的幂等键；跨用户相同 event ID 不互相吞并；持久化不可用时写入和删除不再伪报成功。
- 客户端行为负载不能创建或污染全局歌曲/MV 目录；MV 只通过服务端可信目录录入；修复反馈撤销折叠和重复计数。
- 移动搜索区分限流、上游错误、网络错误与真实空结果，重试保留 Tab；播放 503 显示降级原因。
- 真实线上截图发现的移动结果列表及桌面/移动底部播放器曲名截断已修复为自然换行。360px、390px 长标题浏览器用例验证文字与页面均无横向裁切。
- SQLite 在线备份使用 `VACUUM INTO`、完整性和摘要校验；离线恢复采用维护锁、停写检查、原子替换与回滚。
- 发布包、前端 manifest、Edge 编译身份、Engine 健康状态和 OCI 标签可相互核对。
- 修复 pnpm manifest 与 lockfile 覆盖配置不一致。直接依赖约束和版本不变，保留 `--frozen-lockfile`，移除旧 braces 分支。

## 验证结果

| 验证 | 结果与范围 |
| --- | --- |
| 根项目及 Vue 类型检查 | 通过；长标题修复后重跑 |
| lint 与主题检查 | 通过；长标题修复后重跑 |
| 网关契约 | 90/90 |
| 鉴权兼容/安全 | 43/43 |
| 封面网关 | 15/15 |
| Local Engine 与降级 | 49/49 |
| 原有安全、搜索、推荐等 Vitest | 158/158 |
| 新增后端发布 Vitest | 118/118 |
| 干净依赖树下播放器单元测试 | 71/71 |
| 构建后 Engine 真实 HTTP | 11/11，持久化、删除、备份恢复、HEAD/206/416 |
| 最终前端无头 Chromium | 59/59，含播放、暂停、seek、快速切歌、歌词、路由、异常反馈与长标题 |
| 远端最终镜像候选 | 12/12，真实数据库副本迁移、签名断言、鉴权、持久化、恢复、重启、生产禁用合成源 |
| 最终预览线上 API | 通过：门禁、Edge/Engine 身份一致、搜索来源、音频 HEAD/206/416、SQLite 双用户隔离、幂等、退订和删除 |
| 最终预览真实页面 | 1440×900 与 390×844 截图；完整曲名换行；无横向溢出；真实 audio duration=12、readyState=4、error=null、时间推进 |
| 生产依赖审计 | root 和 player 均为 0 已知生产依赖漏洞 |

后端完整回归在最终 UI 换行修复前通过；最后一次 UI 修复后重跑了类型、lint、构建、全部 59 项前端浏览器测试，并重建远端镜像、重跑候选和线上验证。后端业务源码未在这次 UI 修复中改变。

独立签名 subject assertion 在单元与最终实际候选镜像内通过。使用现有测试签名配置生成的临时测试用户也曾在上一候选版本验证 Edge/Engine 用户一致、SQLite 写入及权威删除；这不是 OAuth 登录验收，临时事件已清理。最终线上匿名隔离验收记录中 `authenticatedIdentityAssertionLiveVerified=false` 应保持真实，不能解释成该独立密钥已在实际 Edge/Engine 配置。

## 部署与回滚保全

远端最终源码目录：`/data/workspace/sonic-a75f5cb54a2f-4f5900552319`。

当前运行容器：`sonic-staging-engine`，绑定 `127.0.0.1:18080:8080`，持久化挂载 `/data/sonic-staging-data:/app/data`，最终健康状态 `healthy`，`SONIC_ENV=staging`，严格来源策略仅允许 synthetic，OAuth 和商业 provider 开关关闭。

本次切换前已生成并验证 `/app/data/pre-release-4f5900552319.sqlite`，SHA-256 为 `02ab4981a35201158a6795eaa018afbc3c799ec34387919beded4e0652a8eb89`。停写后完整目录副本位于最终源码目录下 `rollback-data`，文件摘要记录于 `staging-rollback-files.json`。

最近回滚容器为 `sonic-staging-engine-rollback-4f5900552319`，镜像 `sha256:d0bfa8c9905cc4636be1ff4f791adb03188f75d8167edf2c9d788c7c7ff2e290`；最初旧版本容器也保留为 `sonic-staging-engine-rollback-d1341ea3ea51`。它们当前为停止状态，Docker 保留的旧 health 标记不代表恢复测试结果。恢复工具已在隔离候选容器验证；没有为了演练而再次回滚正在运行的测试服务。

应用回滚必须先停止当前测试 Engine，核对镜像身份，恢复对应停写快照后再启动旧容器。若发生 schema 迁移，禁止只换旧镜像而继续使用迁移后的数据库。禁止使用会改写 Tunnel/DNS 的旧生产回滚脚本。

生产 `sonic-local-engine`、`sonic-ncm-api` 以及 `sonic-staging-tunnel` 的容器 ID、镜像 ID、启动时间与部署前一致。生产 Compose、DNS、Tunnel 配置、生产密钥均未修改。`/data/workspace/sonic-staging-deploy/.env.staging` 和 `tunnel.env` 保留，权限均为 0600。

预览环境原有凭证与稳定测试站不一致，已使用 Wrangler 明确的 `--env preview` 按变量合并同步现有三项测试凭证。同步前后验证主测试环境的 Cloudflare production 配置未变化，preview 绑定名与非秘密值未变化；没有提交完整 masked `env_vars` 覆盖。

## 生产公测边界

本轮交付不代表生产已切换，也不代表任意商业上游或高并发容量已通过验收。以下事项决定生产 GO/NO-GO：

1. 为生产新 Engine 明确配置专用 SQLite 持久化目录、容量告警、备份保留及迁移回滚；保留生产内部 Docker 网络。
2. 若 Edge 与 Engine 不共用用户签名配置，必须安全注入独立 `SONIC_ENGINE_IDENTITY_SECRET` 到两端，并做真实已登录用户跨 Edge/Engine 隔离验收。当前生产 Engine 缺少用户签名配置，不应在未准备身份方案时切换。
3. 使用生产实际允许的音源与侧车，测试搜索、精确曲目绑定、完整播放、Range、歌词、超时及降级。当前测试站只开放第一方合成音源；不能把它当作商业音源通过证据。
4. OAuth 登录与实际 tester 会话仍需生产等效环境验证；当前测试站明确关闭 OAuth。
5. 并发 slots、缓存预算和超时有回归覆盖，但未进行生产流量级长时间压测；当前测试不提供峰值 QPS 或 SLO 容量保证。
6. 全开发依赖审计仍有既有 PostCSS、decode-uri-component 等公告；生产依赖为 0 已知漏洞。构建仍有既有大 chunk/动态导入提示；CSS 语法错误已修复。
7. 默认动效在内置浏览器中使部分语义点击等待超时，使用屏幕坐标点击验证成功；headless 回归使用 reduced motion。真实低性能移动设备与默认动效性能不在本次容量结论内。

## 证据索引

- `evidence/2026-11-02-release-fix/full-regression.log`
- `evidence/2026-11-02-release-fix/final-4f5900552319/browser-typecheck-lint-build.log`
- `evidence/2026-11-02-release-fix/final-4f5900552319/remote-build-result.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/remote-candidate-result.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/staging-deployment-result.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/staging-live.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/browser-live.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/final-remote-state.json`
- `evidence/2026-11-02-release-fix/final-4f5900552319/mobile-full-titles.png`
- `evidence/2026-11-02-release-fix/final-4f5900552319/mobile-playing.png`
- `evidence/2026-11-02-release-fix/final-4f5900552319/desktop-final.png`

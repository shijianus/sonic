# Sonic 上线公测准入审计（2026-11-02）

## 结论摘要

**结论：当前版本不满足无条件公开公测/生产上线 GO。**

可以继续使用隔离测试站进行邀请制、限量、仅可信合成内容和测试数据的技术验证；本次发现的安全与隐私问题关闭前，不建议扩大测试范围、收集真实个人数据或开启未经确认的第三方来源。已有测试站验收记录不等于当前公开公测放行。本次审计仅新增报告和证据，未部署、未提交、未推送，也未修改业务代码。

最重要的确定性阻断项：

1. `HeroCard` 与 `MVCard` 的默认动效代码把上游标题/艺人字段直接插入 `innerHTML`，存在 DOM XSS 注入路径（静态源码确认；未主动触发/执行）。
2. 推荐画像 DELETE 失败时 store 仍清空本地画像、轮换 anonId；设置页仍提示成功，导致服务端残留身份可能无法重试删除。
3. 生产 Pages 默认发布脚本没有注入新 release identity；生产中间件会因此返回 `503 RELEASE_NOT_READY`（在无落盘内存构建下已复现）。
4. 公共 suggest 可能把个人搜索词作为热门建议返回；第三方来源开关关闭并非所有降级分支都遵守；流媒体 URL 物理探针未统一经过 `safeFetch`；雷达跨 Pages/Engine 同步存在路由/身份/失败确认缺口。
5. 版权/来源授权、真实 OAuth、生产等效负载、分布式限流、外部告警接收端及真实生产迁移/回滚证据仍需单独放行。

## 审计对象与版本

- 分支：`rc/sonic-20261031`
- HEAD：`a75f5cb54a2fe3593ba0da72b7ee9b1cc5c410a8`
- Release：`a75f5cb54a2f-4b2de40f0f30`
- 完整源码 SHA-256：`4b2de40f0f30246aee9e4eeaa9d25a3a1bcca44dae6d6187660c2772eecb18f0`
- 归档 SHA-256：`e840290c8a07ef37255aa47b8a9720a86c7c7be03db6a273c7a633e45016d2e9`
- 包索引：396 个源文件；当前工作区摘要和最新 accepted 发布包一致，`dirty: true`。工作树有 89 个已跟踪文件修改，另有新增源码、测试、发布脚本及灰测素材，不能把 Git HEAD 单独当作这次候选的完整实现。
- 最新邀请制测试站 release 的已有线上验收记录与源摘要相符；本轮浏览器匿名访问稳定站显示 `STAGING_ACCESS_REQUIRED`，已有 accepted 记录确认对应匿名 HTTP 401 与 `noindex`。本轮未重新检查该站响应头，也未进入有凭据页面；真实 OAuth/商业源未在该测试 release 中启用。

## 本轮实际验证

- `npm test`：通过（网关 90、认证兼容 43、封面 15、Engine/降级 49、基础 Vitest 158、beta/follow-up Vitest 229；合计 584 个后端/网关用例）。
- `pnpm --dir player test`：14 文件、121/121 通过。
- `npm run lint`：通过；theme baseline 仍覆盖 461 处旧颜色，含 12 条过时 allowance。
- `npm audit --omit=dev --audit-level=high` 与 `pnpm --dir player audit --prod --audit-level=high`：均报告 0 个已知生产依赖漏洞。
- `git diff --check`：通过；仅报告 Windows 换行提示。
- 发布包隔离构建：在 Windows 系统临时目录解包，`release-inputs.mjs --verify release.json --index release-files.json` 前后均通过（396 文件、索引匹配），`npm run build` 与 `npm run build:engine` 成功。复用本机已安装的 root/player 依赖，没有重做 frozen install；这是源码包完整性与可构建性检查，不是从零安装/逐字节可复现构建证明。Vite 仍提示 HLS chunk 约 592 KB 超过 500 KB 门槛。
- Docker smoke 未能本机复验：Docker daemon `/info` 返回 500。`gh` 不可用，不能宣称本次远程 CI 已跑。
- 官方浏览器：本轮稳定站匿名页面显示访问受限错误；隔离构建已取得首页 DOM 快照。1440×900 截图尝试因 IAB 截图面准备超时未获得可视验收。最新 accepted 交付证据有 83/83 headless mock E2E、51 张截图及部分真实测试站合成媒体状态，但这些并非本轮截图实测、真实商业来源或真实设备覆盖；本轮没有重跑 83 项 E2E。

## P1 公测阻断项与修复指南

以下优先级指公测前的修复顺序，不是已发生攻击或数据泄漏的证明。本轮没有确认无条件 P0 漏洞；存在足以阻断公开公测的 P1 问题。

### P1-1：默认动效路径的 DOM XSS 注入面（静态代码确认）

- `player/src/components/Ui/HeroCard.vue:114-153`：`clone.innerHTML` 模板直接插入 `props.title`、`props.subtitle`（150-151）；封面 URL 有转义，不代表文本安全。
- `player/src/components/Ui/MVCard.vue:213-263`：同样直接插入 `props.name`、`props.artist`（256、261）。
- 上游可控入口在首页 API 数据映射到这些 card props：`player/src/pages/index.vue:629-642`、`:737-747`。
- 默认动效（非 reduced-motion）下，普通主键卡片点击会构造动画 DOM。Playwright 全局 `reducedMotion: 'reduce'`（`player/playwright.config.ts:30`）使现有测试绕过该构造分支。CSP `player/public/_headers:6` 只配置 `frame-ancestors`，没有脚本执行防线。
- 当前结论是静态高置信度注入 sink + 可达数据流；本轮没有主动构造 payload、触发事件或验证浏览器执行。
- 修复：避免在含不可信字符串的字符串模板上使用 `innerHTML`。用 `createElement`、`textContent`、安全属性赋值创建克隆；如需 HTML 结构仅使用常量模板，绝不把文本拼进去。对 Hero/MV 增加 `no-preference` 真实浏览器回归，并保留 reduced-motion 回归；加更严格 CSP（逐项评估现有 inline style/script 兼容性）。

### P1-2：画像删除失败仍本地清除并显示成功

- `player/src/stores/modules/recommend.ts:346-357`：`deleteSonicEvents()` 返回 false 后仍无条件 `dislikedTracks=[]`、轮换/清空 `anonId`，最后返回 false。
- `player/src/api/recommend.ts:396-405`：网络异常或非 2xx 返回 false。
- `player/src/components/Settings/PrivacyDataSection.vue:26-37`：忽略 bool，无条件显示 success。
- `PrivacyDataSection.vue:51-69`：全部本地清除时吞掉服务端画像删除与 IndexedDB 清理异常，仍提示成功并 reload。
- 业务逻辑隔离 stub 验证：DELETE 返回 false 后旧 anonId 被替换、负反馈清零；未联网、未写工作区。
- 修复：失败时保留当前 anonId 作为重试身份；只有权威服务端清除确认后才轮换身份。UI 展示可操作错误/重试。全量清除结果应区分“本地成功/远端待删/IndexedDB 失败”，不得声称全部成功。补 503、断网、重试成功、匿名身份关闭后清理和页面重载用例。

### P1-3：公共 suggest 暴露个人搜索词

- `functions/_lib/sonic/recommend/engine.ts:170-213` 把搜索事件 `cleanQuery` 纳入可归属贡献。
- `server/recommend-sqlite.ts:671-688` 聚合搜索 query。
- `functions/_lib/sonic/recommend/smart-search.ts:54-80,120-126` 在公共建议中混合 `getTopSearchQueries()`；`functions/api/sonic/search/smart.ts:44-90` 对公共 suggest 提供响应。
- 条件：已认证用户或明确 opt-in 匿名用户上报某一搜索词，后来其他请求调用公共建议。邮件地址、电话号码、诊断/私人查询可能进入公共建议；撤回后还需考虑派生缓存失效。此为代码路径判断，未访问生产数据。
- 修复：公共 suggest 默认只返回曲库/固定精选，不用用户原始 query；若产品明确保留热搜聚合，需最小独立 subject 数阈值、隐私/敏感串过滤、反刷、短 TTL、撤回后的衍生清理与隐私告知。

### P1-4：关闭 GDStudio 时特定降级分支仍会调用

- `functions/_lib/sonic/native-protocols.ts:1186-1221`、另一个回退块 `:1441-1468`。
- `allowExternal = cfg.enableGdstudio || (commercial && policyAllowed && (degraded || skippedByCircuit || !engineRes?.ok))`。当 Engine 没有成功结果时 `!engineRes?.ok` 可成立，即使显式 `SONIC_ENABLE_GDSTUDIO=0`。
- 影响：第三方来源开关/来源政策可能被降级逻辑绕过，触发向 GDStudio 出站并接受其 URL。
- 修复：Provider 自己关闭时必须在所有路径先 fail closed；策略、provider enable、授权资格分别检查，不以 `engineRes` 状态推导授权。测试每个配置组合的实际出站调用数；关闭后必须为 0。

### P1-5：推荐雷达同步 Edge / Engine 合同断裂

- `functions/api/sonic/recommend/radar-album.ts:48-80,104-179`：handler 要求 `identity.userId`；Engine GET 异常时回落本地 store；POST 忽略 Engine hop 的结果，仍写 Edge local store 并 200 `ok:true`。
- `server/index.ts:220-238,269-282` 未显式注册 `radar-album` 路由；catch-all 可能接走不匹配路径。
- `functions/_lib/sonic/engine-identity.ts:99` 生成的签名 identity 不含 `userId`；旧 Engine handler 仍依赖 `userId`。Engine hop 会移除原始用户凭据，不能指望 handler 再从原始 token 取用户 ID。
- 修复：Node dispatcher 显式路由；用签名 subject 作为服务端授权身份，而不是要求被删除的原始凭据字段；持久化后才返回成功，失败 503/retryable；加 Edge→Engine→SQLite 重启读取、清除与双用户隔离的合同测试。

### P1-6：音频 URL 探针绕过统一的 safeFetch 路径（条件性 SSRF）

- `functions/_lib/sonic/native-protocols.ts:744-778`：物理音质探针直接 `nativeFetch` 请求解析结果中的 URL；调用点有 `:1085,1119,1298,1354`。最终媒体代理安全检查在 `functions/api/music/stream.ts:250`，不能保护提前发生的探针请求。
- 条件：供应商或被污染解析结果返回意外 URL/重定向目标。此时探针可先向不允许目标发 Range 请求，构成潜在盲 SSRF 路径。没有主动验证可利用性，须按安全代码缺陷处理。
- 修复：探针与所有供应商返回 URL 统一使用逐跳校验的 `safeFetch`（协议、域名、DNS/IP、redirect、body/Range bytes、超时）；补内部/metadata/非白名单重定向目标被拒绝测试。

### P1-7：生产 Pages 默认发布路径缺少 Release identity 注入

- `package.json:12,16` 默认部署命令调用 `scripts/deploy-pages.mjs`。
- `scripts/deploy-pages.mjs:26-34` 直接 deploy `dist`，没有调用 release staging helper/编译 metadata。
- `functions/_lib/sonic/compiled-release.ts:9` 为 `null`。
- `functions/_middleware.ts:61-67` 在 production 要求 metadata，缺 `SONIC_BUILD_TIME` 等时回 `503 RELEASE_NOT_READY`。这种情况有独立的纯内存打包复现；不是当前 staging 已坏，staging 专用 helper 已正确注入。
- 修复：生产发布入口必须在 deploy 前完整校验 release manifest、生成唯一 staging deploy tree 并注入 compiled release metadata，确保 sourceDigest/releaseId/buildTime/baseCommit/dirty 同一 manifest；部署前失败则不发布。加 CI 测试验证默认 `npm run deploy` 入口生产构建能通过 release readiness；当前 dirty tree 条件须先明确。

## P2：重要问题（按影响排序）

1. **缓存键不完整/碰撞**：`functions/_lib/sonic/cache.ts:44-48` whitespace→underscore 使 `a b` 与 `a_b` 可碰撞；`functions/api/sonic/search/smart.ts:101-188` key 未纳入 `localOnly`；`native-protocols.ts:887-900` key 漏 `allowTrial`、`durationSec`。改用结构化 JSON tuple/hash，纳入所有改变语义/授权的字段，并加策略版本；不能只靠 URL 字符串归一化。
2. **歌词跨平台 ID 猜测**：`functions/_lib/sonic/nexus-lyrics.ts:516-527` 及 `functions/_lib/music.ts:1709-1714,1749-1764` 可能把非 QQ 平台数值 ID当 NetEase ID。只在来源/ID精确配对后 fallback；否则先做标题、艺人、时长匹配，无法确定时返回无歌词，不返回其他歌的词。
3. **大响应/解压/图像预算不完整**：`upstream.ts:130-143` single-flight 聚合完整 `response.text()`；KRC `DecompressionStream` `music.ts:1178-1191` 缺解压后输出字节上限；`palette.ts:18,319-330` JPEG 输入压缩体限制不足以防超大像素图片。增加逐类型总字节、解压输出、行数/词数、像素数、并发与 RSS 预算。
4. **Engine 请求重定向策略**：`local-engine.ts:277-281,327-340,428-430` 对 Engine `fetch` 默认 follow，headers 带 service key / identity assertion。若目标/反代返回跨源 redirect，存在敏感头越界风险。默认 `redirect:'error'`；确实需要跳转时逐跳严格同源验证并剥除密钥头。
5. **原生 Cloudflare Rate Limiter 展示与配置额度不一致**：`security.ts:355-420,562-590` 本地计算匿名/认证额度，但 native binding `.limit({key})` 本身的绑定值由 Dashboard 配置。response `limit/remaining` 可能不等于实际执行额度，OAuth sensitive routes 未独立绑定层级。为 tier 配多个 binding/可执行策略，或者明确实际 binding 限额并测试多 isolate。
6. **日志脱敏不足**：`observability.ts:329-343` 等规则未覆盖所有 URL/JSON 形态的 `auth_key/accesskey/user_token` 等。把原始错误转成固定错误码；统一用 `URLSearchParams` 解码参数并共享敏感字段词表，避免 raw error/message 进入响应或日志。
7. **Metrics source 标签无界增长**：`functions/api/music/search.ts:40-50` 可接收任意 `source`，`observability.ts:586-590` 以清洗值作 map key，无过期/上限。固定 provider enum，其他归 `unknown`，限制 Map 长度。
8. **Node 目录 API 方法/分页边界**：`upstream.ts:96-106` 的方法约束弱；`upstream.ts:309-310,428-430` 等 `parseInt` 未全部 finite/range 验证。统一 405 + method allowlist、整数范围、请求体字节/总预算。

## 前端其余重要缺口

- 请求乱序仍可覆盖新状态：`player/src/pages/charts.vue:58-120`、`player/src/pages/mobile/charts.vue:45-96`、`player/src/pages/artists.vue:108-197`、`player/src/components/Recommend/StyleRadarSection.vue:37`。采用 AbortController + monotonic generation；测试慢 A、快 B 后乱序返回。
- 音质切换缺少播放代次：`player/src/stores/modules/audio.ts:1333` 捕获旧歌曲、时间、播放意图；切歌/暂停之后旧请求可能覆盖状态。将 quality 操作并入 playback generation，等待事件绑定目标曲目。
- 来源字段在二次映射中丢失：`player/src/components/Ui/SongCard.vue:55`、`player/src/components/Search/SearchSongs.vue:194`、`recommend.ts:294` 缺 source/platform/platformId/resolvedPlatformId 等。跨平台数字 ID可能被猜成 NetEase；统一用共享 transformer preserving canonical source pair。
- 官方榜单筛选隐藏结果：`player/src/pages/charts.vue:33-35` 仅前 20 个，`:337` 固定 58px + `overflow-hidden` 无展开/滚动入口；移动榜单 `player/src/pages/mobile/charts.vue:14-35` 无官方榜单 tab，筛选缺 label，与 desktop/artist page 不一致。
- 歌词首层无超时且失败可伪装无歌词：`player/src/composables/useLyrics.ts:394-477` 只在切歌时 cancel，无层级超时，异常吞掉。加总预算、分层 timeout、error/retry 态；不把真正空结果和上游失败合并。
- 歌曲详情页错误状态欠缺：`player/src/pages/mobile/song.vue:30` 详情与歌词 `Promise.all`，一层失败全部拒绝且无 catch；桌面 `player/src/pages/song.vue:97` 吞异常，页面可能像无内容。拆分详情/歌词加载并显示真实错误/重试。
- 动画播放回调可能过期：`player/src/components/SongList.vue:75` 250ms 飞行动画后调用播放，缺意图代次；动画中切歌/刷新列表可能迟到触发旧播放。动画应是纯视觉，或在新播放意图时 invalidate。
- 可访问性：`PrivacyDataSection.vue:115,143` switch 缺 accessible name；`artists.vue:294` 窄屏隐藏文字的按钮缺 aria-label；当前 automated a11y 不等于 VoiceOver/TalkBack 人工验证。

## 修改指南与先后顺序

### 阶段 0：冻结候选、保留证据

- 不要直接在当前 dirty 工作树执行发布覆盖；先独立分支/提交并为新候选生成 manifest/index/archive。
- 重新生成 release id/sourceDigest；任何修复后旧发布包摘要不能复用。
- 发布摘要采用固定依赖版本与 Node 版本，在 OS 临时目录先做 package verification，再 typecheck、lint、测试、`npm run build`、`npm run build:engine`，末次再 `--verify release.json --index release-files.json`。

### 阶段 1：先关闭安全与隐私

- Hero/MV 克隆 DOM 换成 `textContent`，补 no-preference Playwright。
- 修画像 DELETE 错误语义；服务端未确认不轮换身份，不报成功；测失败后重试/成功后的派生删除。
- 公共 suggest 移除个人原始 query；确定采样门槛和删除策略。
- Provider enable/policy 强制贯穿 resolve、探针、降级、歌词和最终代理。
- 物理 URL probe 走逐跳 `safeFetch`；敏感头不 follow redirect。
- 缓存键使用结构化对象，覆盖所有功能参数；加差异组合回归。

### 阶段 2：闭合后端权威数据与资源边界

- radar-album route 注册、subject contract 统一；只有 SQLite 权威写/删确认才返回 2xx。
- 在输入层、解压层、图像解码前限制 body/字符/像素；所有响应读取设置字节总限额、slow-body idle timeout、取消链。
- 限制 public metrics label cardinality；unknown provider 统一落到 fixed enum。
- 目录路由统一 method/pagination validation；歌词不再跨 source 猜 ID。

### 阶段 3：生产部署链路和文档

- 将 production deploy 包成单一有验证的命令：检查 clean tree/accepted manifest，注入五个 release identity 构建参数或 Pages 编译常量，构建并验证 `/release.json` 与 health identity 后才 deploy。
- README/OPERATIONS 的 Docker 快速命令同步给出 `SONIC_ENGINE_IDENTITY_SECRET` 和五项 manifest vars，说明每项来源。
- 修复 `rollback-production.sh`：API 读取失败立即终止；按完整 ingress path/rule 顺序保留现态；不静默覆盖 warp routing；不能恢复绕过 Edge 的公网 Engine 路由。
- 升级并固定最低受支持 Node 至与 frozen jsdom lock 兼容；固定 Wrangler，记录 NCM 全量依赖/镜像 digest。

### 阶段 4：公测环境与产品验证

- 取得法务逐 provider/audio/lyrics/cover 的书面许可；否则生产严格 allowlist 只允许已批准来源，测试合成源不得替代商业源。
- 完成真实 OAuth 登录/回调/退出/撤销；核验 Cookie domain/redirect URI/CSRF。
- 为 Pages 绑定并实测原生 Rate Limiter（各 tier 的真实配额）、生产 identity binding、SQLite persistent volume、外部 webhook 接收端。
- 在生产等效环境做不同并发与长会话压力、取消/断线/慢体、备份恢复、匹配镜像双向回滚。明确邀请规模、并发上限、关闭开关、值班人与 SLO。
- 做默认动效的真实 Chromium（桌面）、390/360px 移动布局与真实设备 Safari/Chrome、键盘/屏幕阅读器验收。

## 公开公测 Go 门槛（必须全部 PASS）

- [ ] P1：所有不可信字符串脱离 innerHTML；安全评审与默认动效 E2E 通过。
- [ ] P1：画像删除失败不伪报成功；公共 suggest 无个人原始搜索泄露；provider off 无出站绕过。
- [ ] P1：radar 的 Edge→Engine→持久库合同、服务身份、失败语义和重启读取通过。
- [ ] P1：所有供应商 URL 探针/代理均有逐跳 SSRF 策略；资源预算覆盖大响应、解压与 JPEG 像素。
- [ ] Production Pages 发布身份与前端/Engine/OCI 标签同一摘要，默认部署入口全程 gate 通过。
- [ ] 真实 OAuth、授权音源全长播放/Range/Seek、真实限流和告警实测完成。
- [ ] 生产等效容量、持续稳定性、备份/回滚和真机/可访问性验收通过。
- [ ] 新候选工作树、源码归档、签名/摘要、镜像 digest、Pages deployment id 和数据库快照一一绑定并经负责人签署。

## 本次未执行/未声称

仅新增本报告与本轮证据，未修改业务源码或既有文档；未部署、未提交、未推送；未做 XSS 主动触发、真实商业音频/CDN/OAuth 全链路、生产级负载或当前生产数据库回滚。`npm test` 含部分真实上游搜索/封面请求，不能称本轮测试完全离线，也不能据此宣称商业音源全长播放已验收。本机 Docker daemon 返回 500，远程 CI 状态未验证。最新 accepted release 的测试站和 83/83 mock E2E 属于该确切 release 的已有证据，不代表修复本报告阻断后新候选自动通过。

本轮命令输出存于 `evidence/2026-11-02-public-beta-readiness-audit/`；本次临时本地测试服务已停止。

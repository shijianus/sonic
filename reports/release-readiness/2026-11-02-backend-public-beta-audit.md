# Sonic 后端公测准入审查 · 2026-11-02

**结论：当前不建议直接开放公测。** 远端版本基础测试与构建通过，但独立审查复现了服务鉴权、事件数据可信度、持久化确认、撤销语义及运行时资源控制方面的缺口。前端进行了真实浏览器抽查，不能据此宣称所有页面、真实上游音源和公测容量均已验收。

## 版本与范围

- 分支：`rc/sonic-20261031`。
- 审查提交：`a75f5cb54a2fe3593ba0da72b7ee9b1cc5c410a8`。
- 已执行 `git fetch origin` 和 `git pull --ff-only origin rc/sonic-20261031`，结果 `Already up to date`，本地与对应远端 ahead/behind 均为 0。
- `origin/main` 比当前 RC 分支旧；本轮未跨分支合并。
- 用户原有 README 修改、多实体推荐草稿、docs、graytest 与 selftest 文件均保留。原有 tracked diff 前后 Git 对象摘要相同：`85efc565ce155a76ad1997960ede102128bbd2ab`。
- 本轮只新增本报告及其证据目录，未修改业务代码、提交、推送、部署或更改真实数据库。测试工具可能产生忽略目录下的编译缓存。
- 测试在 Windows、Node 24.14.0、npm 11.9.0、pnpm 10.34.5 下运行。干净 HEAD 使用 `git archive` 解出至 OS temp，并链接现有依赖；没有重装 frozen lockfile。生产 Node 22 / Linux 的结果仍需由 CI 和 Staging 验证。

## 当前验证结果

| 检查 | 本轮结果 | 解释与限制 |
| --- | --- | --- |
| 原工作树 `npm test` | **失败，exit 2** | 未跟踪 `entity-store.ts` 产生 18 个 TypeScript 错误；与远端 HEAD 区分处理 |
| 干净 HEAD `npm test` | **通过** | 包含服务端和前端 typecheck，158 个 Vitest 用例；另有网关 90、认证 43、封面 15、引擎/降级 49 项脚本断言 |
| 前端单元测试 | **12 文件 / 64 用例通过** | JSDOM 输出 media load 未实现提示，不能替代真实播放验证 |
| 干净 HEAD 前端构建 | **通过，有警告** | 移动首页 CSS 语法异常、HLS 大包等，见下文 |
| 干净 HEAD 后端构建 | **通过** | 产物位于隔离快照 |
| 干净 HEAD `npm run lint` | **通过** | theme baseline 仍覆盖 461 个既有硬编码颜色，并有 12 个过期 allowance |
| 告警自检 | **通过** | 本地 alertDelivered、redactionVerified 为 true，不能证明生产告警已送达 |
| 多实体离线评估 | **通过小样本延迟守卫** | 58 曲目、143 实体；P50 12.11ms、P95 16.61ms，非并发容量结论 |
| 真实后端 HTTP 音频链路 | **隔离合成源通过** | 未带 engine key 401；带临时 key health 200；HEAD 200 无 body；Range 206 与越界 416 正确 |
| 浏览器 UI/媒体抽查 | **部分通过，发现移动端错误态缺口** | 当前 HEAD 产物 + 确定性 Mock；详见下文 |

日志、截图及结构化观察位于 [本轮证据目录](evidence/2026-11-02-backend-beta-audit/observations.json)。独立审查的微型复现通过 stdin 执行，结果由审查 Agent 汇报，未另存可重跑脚本；运行时三项复现另保存了 [结果 JSON](evidence/2026-11-02-backend-beta-audit/runtime-reproductions.json)。下列明确区分复现、源码结论与待环境验收项目。

## 公测前必须处理

### 1. 服务鉴权与路由规范化不一致

**优先级：P1，首要公测阻断；已用全 stub 测试复现。**

`functions/_lib/sonic/security.ts:60` 只把精确的 `/proxy`、`/palette` 认定为需要内部 engine key 的路径；`server/index.ts:155` 则去除尾斜杠后分派。顶层门禁 `server/index.ts:383` 和 handler 再次鉴权时仍读取原 Request。

在 Linux Engine 环境，正常 `/proxy` 无 key 返回 401，而 `/proxy/`、`/proxy///` 无 key 可通过门禁。stub 允许域名音频返回 200，`/palette/` 也能进入上游请求。影响取决于这些路由是否可从外部到达；这并不意味着任意 URL 或内网 SSRF 已成立，原有目标白名单仍在。

**最小兼容修复：** 在顶层、路由分派和 handler 共用同一 pathname 规范化函数；所有等价路径必须有一致的鉴权结果。补齐 `/proxy`、`/proxy/`、多尾斜杠、`/palette/`、API 别名的有 key / 无 key 回归。现有 `tests/security-p0-regression.test.ts:42` 起的用例只覆盖普通路径。

### 2. 引擎故障时“写入/删除成功”与真实持久化不一致

**优先级：P1；隔离模拟主引擎 530 已复现。**

`functions/api/sonic/events.ts:117` 的 DELETE 在主引擎失败后清除本地 store，并以 `engineCleared || localClear.cleared` 报告结果。因此可返回 HTTP 200、`cleared:true`，但远端持久库里的事件仍在。

同文件 `:193` 起的 POST 主引擎失败后写本地 store，返回 200 和 degraded 标记；Edge 使用内存时，换 isolate 或重启即丢失。降级读可以允许，降级写必须说明是否真正持久化。

**最小兼容修复：** 清除操作只在权威持久存储确认后返回成功；失败返回可重试状态。事件写入使用持久队列/同一权威数据库，或明确返回 503，而非把内存接受当持久化成功。前端沿用既有 API，但正确消费失败与重试语义。补主引擎故障、超时、重试、重启及清除后再次查询的测试。

### 3. 客户端事件可以改动全局曲库

**优先级：P1；内存与临时 SQLite 均已离线复现。**

触发前提是请求通过网关，带合法匿名 ID 或登录身份、开启个性化 consent，并提供带错误/伪造 `canonicalTrackId` 的 track payload。public 无身份模式会被隐私逻辑忽略，不是无门槛匿名写入。

`functions/_lib/sonic/recommend/engine.ts:207` 直接把客户端 track 转为 canonical track 并 upsert；`recommend/track-canonical.ts:172` 接受输入 canonical ID。合并路径为 `recommend/memory-store.ts:48` 和 `server/recommend-sqlite.ts:204`。微测给既有曲目追加了错误 genre、错误 QQ source，并抬高 externalPopularity。

这会影响其他用户推荐和音源匹配，可能让前端看到正常标题但拿到不正确来源。

**最小兼容修复：** 行为上报只引用服务端已验证的曲目 ID；客户端元数据不得覆盖全局来源、标题/版本及外部热度。需要新增曲目时由服务端验证 provider ID、标题、艺人、时长和版本再写入。补用户 A 上报对用户 B 的曲库/推荐不可变测试。

### 4. 事件幂等键未包含用户身份

**优先级：P1；内存与 SQLite 均已离线复现。**

`recommend/engine.ts:175` 与 `:228` 使用原始客户端 `eventId`；内存全局 Set 在 `recommend/memory-store.ts:205` 去重，SQLite 的 `event_id PRIMARY KEY` 与 `INSERT OR IGNORE` 见 `server/recommend-sqlite.ts:87`、`:413`。

相同合法 ID 先由 A 上报，再由 B 上报，A accepted=1，B deduplicated=1，B 的事件丢失。随机 UUID 降低偶然冲突概率，但不能替代正确的数据隔离。

**最小兼容修复：** 唯一约束使用 `(subject_key,event_id)`；内存按身份组合键；为既有 SQLite 制定兼容迁移。同一用户重试仍只入库一次，不同用户相同 eventId 各自成功。

### 5. 多实体“撤销不喜欢”没有恢复推荐资格

**优先级：P1；已离线复现。**

`recommend/multi-entity.ts:393` 遍历历史反馈，负权达到阈值就加入 blockedEntityIds；后续 undislike 只增加分数，没有移除历史 block。单曲路径 `:369` 起也需按动作状态一致处理。

**最小兼容修复：** 按实体、动作和时间折叠当前状态，让 undislike、unfavorite 等撤销语义明确；阻止重复上报放大偏好。补 dislike→undislike、favorite→unfavorite、乱序到达与同时间戳回归。

### 6. 断连取消、持续流连接预算和熔断状态存在缺口

**优先级：P1；前三项已在全 mock 小型测试复现。**

- `server/request-adapter.ts:70` 创建 Web Request 时没有绑定客户端断开的 AbortSignal。IncomingMessage aborted/close 后 signal 仍 false；`server/index.ts:138` 仅在取得 Response、准备输出 body 后注册关闭处理。解析及首包前的上游工作可能继续占用资源。
- `functions/_lib/sonic/security.ts:994` 的 64 并发槽只覆盖 fetch 响应头阶段；`:1246` 的 finally 在响应 body 仍未结束时释放。微测允许 65 个未结束 body 同时存在。它可作为首包并发限制，但不是活动音频连接上限。
- `functions/_lib/sonic/local-engine.ts:205` 的故障可打开熔断；`:249` 起任何迟到成功又直接写 CLOSED。两个并发调用中，旧成功响应可覆盖更新的故障状态。

**最小兼容修复：** 从 socket disconnect 到 Request、provider 解析、媒体读取串联同一个取消链；分别限制解析并发、队列长度与活动媒体流，body 完成/取消/错误才释放流槽；为每请求设总预算。熔断采用状态 generation/epoch，仅当前半开探针可关闭对应熔断代次。响应沿用现有错误 envelope、429/503、Retry-After 和降级头。

补断连后上游取消、慢响应体、并发超限、队列取消、故障后迟到成功、半开单探针测试。

## 同批修复与功能补漏

1. **实际媒体白名单与测试白名单不一致，已 stub 复现。** `functions/_lib/sonic/licensing.ts:48`、`:60` 和 `:406` 汇总的 qq.com / 163.com 等宽域允许供应商非媒体公开服务进入 forward 链；旧窄常量 `security.ts:21` 并非生产实际来源，而 `tests/ssrf-security.test.ts:179` 仍测试它。收敛为按 audio/cover/lyrics 能力划分的单一白名单，并直接测真实 `getAllowedMediaDomains()`。不将此结论扩大为内网 SSRF。
2. **签名 URL 和跳转缓存策略不完整，已 stub 复现。** `functions/api/music/stream.ts:56` 的敏感参数集合漏项，`:326` 起基于初始 URL 判断，最终跳转带签名仍可得到 public 缓存。`forward.ts:22`、`:157` 对 raw search 的正则也漏编码参数名。统一使用 URLSearchParams 的解码字段，补 auth_key、vuutv、dis_k，逐跳累积敏感标记；任一跳带凭据则 private,no-store，禁止直接暴露对应 Location。跨用户缓存影响需共享缓存遵循 public、稳定入口被共享等条件，本轮没有验证真实串户。
3. **MV 外部 ID 未解析为推荐实体，已离线复现。** `recommend/engine.ts:167` 直接接受 entity_id；`multi-entity.ts:128` 起 bootstrap 使用内部 mv_<hash>，事件写入没有复用解析器。事件 accepted 不代表对应 MV 信号可被推荐消费。统一 provider+external ID 到内部实体的解析与关系写入，或明确接口仅接受内部 ID。对每种实体补 event→SQLite→重开→画像→feed 的合同测试。
4. **发布停机可能中断播放，源码确认。** `server/index.ts:456` 收到 SIGTERM 后最多 5 秒强退，长音频/慢请求跨发布可能断流。优雅退出应先摘除 readiness、停止新请求、排空活动流，并与容器宽限期一致；是否要求跨发布不间断需在 Staging 滚动升级验收。
5. **移动搜索把错误显示为空结果，浏览器已复现。** `player/src/pages/mobile/search.vue:251` 没检查 nexus HTTP 状态，`:298` 把 cloudsearch 错误清空为 []。本地 429 fixture 显示“暂无搜索结果”，没有限流说明或重试。复用桌面已有错误分类和极简重试控件，保持正常结果布局不变；前端改动只限错误反馈。
6. **移动首页存在 CSS 语法异常，构建证据确认。** `player/src/pages/mobile/index.vue:750` 的 dark selector 后混入重复 @keyframes，生成 `html.dark @keyframes` 和带 scope 的 0%/50%，Vite 成功但报 css-syntax-error。清理重复样式后做首页暗色与动画截图回归，不能仅凭构建成功忽略。

## 运行配置与容量补漏

以下由源码确认，尚未进行真实故障或恢复演练；应结合部署模式决定阻断级别。

- **就绪检查的依赖策略：** `functions/api/sonic/engine/health.ts:32` 探测 ncm sidecar，但 `:78` 的 ok 只取 storageHealthy。若 sidecar 是上线必需依赖，应使不可用反映在 readiness；若允许原生上游降级，应明确报告 degraded 并告警，不能把所有 optional provider 故障都升级成进程不可用。区分 liveness、readiness 和降级状态。
- **发布版本溯源：** Dockerfile 的 release 参数默认 unknown，CI Docker build 未强制传入提交 SHA；`server/index.ts:360` 仅在已知 SHA 时发 X-Sonic-Release。生产门禁应拒绝 unknown，并让镜像标签、health、前端与 Edge 的版本证据一致。
- **恢复脚本需停写保护：** `scripts/restore-recommend-db.mjs:49` 没有检查服务已停，VACUUM 失败时 `:57` 复制主库，`:65` 删除 WAL/SHM 后替换。活跃写入时运行可能与 SQLite 句柄/WAL 竞争；应以停写锁和可验证备份为前提，拒绝不完整兜底。当前备份已有 VACUUM INTO 和 integrity_check，应保留并增加异机副本、保留策略、容量检查及恢复演练。
- **明确单节点边界：** Compose 的固定单容器、本地 SQLite WAL、内存限流/熔断状态，不等于已经支持横向多副本。限量公测可以明确单写节点；扩容前要统一持久事件、限流与路由策略，避免多个互不相干的数据库或共享不受支持的网络卷。
- **缓存与上游压力：** `functions/_lib/sonic/cache.ts:12` 主要限制条目数和单值，缺总字节预算与同 key 的请求合并。为热点 miss 增加 single-flight、总内存预算和有界排队，避免多次搜索/刷新放大上游流量。
- **指标与 CI：** 流成功应区分收到响应头和 body 完整结束；body 错误、取消和超时需要独立计数。CI 的分项命令未执行 test:gateway/test:cover，建议加入确定性版本；还需覆盖取消、活动流预算、熔断竞态、SIGTERM drain、WAL 恢复。HTTP fetch 的 AbortSignal.timeout 可能继续约束响应 body，不能仅凭 fetch 在 headers 阶段返回就断言后续无限挂起；应实测首包、body idle 和总预算的真实边界。

## 前端稳定性证据与边界

本轮通过官方浏览器能力检查了当前 HEAD 的隔离生产构建。环境只提供内嵌 Chromium，未执行独立 headless 全套；不将部分截图认定为 AGENTS.md 全量视觉门禁已经通过。

- 桌面搜索 1440×900：结果标题、搜索控件、播放器可见；页级横向溢出 0。
- 移动搜索 390×844：搜索结果、底部播放器与导航可见，横向溢出 0；歌词预览存在省略显示，未验收全站长标题完整展示。
- 点击“播放全部”后，真实 HTMLAudioElement readyState=4、paused=false、currentTime>0、error=null；暂停按钮使 paused=true。音频为 Mock 服务器生成的 20 秒 WAV。
- 移动排行榜“站内趋势榜”→“新歌速递”：main 的 x/y/width/height 前后一致，390×762.6667，高度位置没有变化；后者 fixture 返回空数据，因此只能证明外层布局，不能证明真实榜单内容和加载过程无跳动。
- 隔离真实后端合成源：WAV 在浏览器解码为 12 秒，readyState=4、无媒体错误；未取得持续 playing 状态，因此只记录成功解码，不声明真实后端浏览器播放验收通过。
- 未穷尽官方榜、MV、长歌名、长榜单名、全部滚动条、所有分辨率；完整 e2e 及真实上游/OAuth 仍是发布前工作。

截图：

- [桌面搜索](evidence/2026-11-02-backend-beta-audit/desktop-search-1440x900.png)
- [移动搜索](evidence/2026-11-02-backend-beta-audit/mobile-search-390x844.png)
- [移动趋势榜](evidence/2026-11-02-backend-beta-audit/mobile-charts-trending-390x844.png)
- [移动新歌速递](evidence/2026-11-02-backend-beta-audit/mobile-charts-new-390x844.png)

## 本地草稿与远端实现应分开

未跟踪的 `functions/_lib/sonic/recommend/entity-store.ts` 不存在于 HEAD，也未被运行时 import，但 `tsconfig.json:13` 的 `functions/**/*` 将其扫入 typecheck。其 EntityRecord、EntityRelation.fromType、getEntity(type,id)、countEntities 等接口与 HEAD 类型不兼容，因此阻断原工作树 `npm test`。

干净 HEAD root/player typecheck 通过。解决方式是将草稿按当前接口完成并补测，或由文件所有者把实验稿移到编译范围外；不能直接删除用户文件，也不能把失败归因于远端已合入版本。本轮未处理该草稿。

HEAD 的多实体推荐并非“完全没实现”：实际 multi-entity 引擎和 SQLite 关系存储存在，临时 SQLite 关闭重开后数据可读。问题在身份去重、可信来源、事件与实体映射、动作折叠及降级确认等边界。

## 建议的公测准入条件

以下是待执行的验收门槛，不是本轮已经达成的保证。

1. **安全与数据：** 关闭上述鉴权/权威存储/全局曲库写入缺口；每个问题先形成回归用例。跨用户相同 eventId 各自入库，同用户重试只一次；主引擎删除失败不能报已清除；进程重启后的清除与写入结果一致。
2. **生产配置：** 禁用 synthetic/fault 测试源和测试身份；当 production 显式设置 synthetic flag 时当前代码仍会启用，因此必须做负向检查。核验实际分布式 limiter 绑定、可信代理、签名密钥、SQLite 持久卷和来源开关；缺失必要配置应拒绝启动/就绪。内容来源采用项目已确认的策略，不能用测试合成源通过冒充真实音源通过。
3. **容量上限：** 在与公测一致的机器、带宽、反向代理和数据库上分档测 10/25/50/100 并发，并覆盖持续音频连接、搜索尖峰、取消和慢连接。仅在前一档稳定后进入后一档。记录 P95/P99、首包、失败率、429/503、活动流、排队、RSS、event-loop delay、SQLite 写耗时、磁盘与外网带宽。
4. **首轮服务目标建议：** 缓存/推荐本地接口 P95≤300ms，搜索聚合 P95≤3s，可用音源首包 P95≤2s（上游不达标则显式降级），非业务预期 5xx<1%；持续故障必须在设定预算内结束。该目标需要按真实地区网络与机器容量调整，不能由本地 143 实体微基准推算可承载人数。
5. **运行演练：** 完成至少一次主引擎离线、上游慢响应、断网、重启、滚动发布、备份→恢复和回滚演练；恢复只在临时卷验证。发布产物、X-Sonic-Release、前端资源 manifest、镜像 digest 与同一 SHA 对应。
6. **UI 合同与视觉：** 冻结成功响应形状、错误 code、分页/总数、duration 单位、来源绑定、Range/206/416 和降级头；后端内部修复保持前端正常态 DOM、样式与布局。CI 跑现有 typecheck/lint/test/security/recommend/player/e2e/build，再补真实 Staging 链路。桌面1440、1280及窄屏390/360检查长标题、空态/错误态、Tab切换、滚动条和真实播放。
7. **运维告警：** 本地自检通过后，另确认真实生产告警目的地、错误预算、活动流超限、SQLite失败、磁盘余量与主引擎熔断告警。小规模公测先绑定实测连接上限，保留关闭入口与回滚能力，再逐步放开。

本轮未运行 Docker smoke、真实 OAuth/上游/CDN 验收、生产负载、备份恢复和依赖漏洞审计，也未重新安装锁定依赖。`gh` 未安装，未读取当前远端 Actions 状态，不能将历史 CI 或历史 readiness 文档作为当前上线证明。

**建议实施顺序：先修鉴权与数据正确性，再修取消/流预算/熔断和签名缓存，随后补移动错误态与视觉门禁；全部回归及 Staging 容量、恢复演练通过后再开放限量公测。**

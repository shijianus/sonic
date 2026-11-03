# Sonic 已知问题补强与交付 — 2026-11-02

## 结论

本轮已确认的隐私/身份、事件读取、保留期、可归属衍生数据删除、音源与歌词绑定、重试、界面错误状态、移动取消、完整标题、发布包缺项及告警验证问题已修复，并完成完整回归、隔离负载验证、干净构建、远端候选、匹配快照回滚演练、Preview 和稳定测试站部署验收。

当前稳定测试入口 **https://sonic-staging.pages.dev** 已提升到本次版本，不再停留于上一轮的旧前端；保留现有邀请门禁。可以继续邀请制、限定范围测试。**没有切换真实生产项目，也不将测试站合成音源、临时签名用户或本地负载结果当成商业音源/OAuth/生产容量通过证据。**

## 最终身份与文件

| 项目 | 实际值 |
| --- | --- |
| Release ID | `a75f5cb54a2f-4b2de40f0f30` |
| 基础提交 | `a75f5cb54a2fe3593ba0da72b7ee9b1cc5c410a8` |
| 完整输入摘要 | `4b2de40f0f30246aee9e4eeaa9d25a3a1bcca44dae6d6187660c2772eecb18f0` |
| 构建时间 | `2026-11-02T05:57:13.257Z` |
| 工作树 | `dirty: true`，用户和本轮变更保留，未提交或推送 |
| 索引 | `release-files.json`，396 个完整构建/测试/部署输入 |
| 源码包 | `artifacts/sonic-a75f5cb54a2f-4b2de40f0f30.tar.gz` |
| 源码包 SHA-256 | `e840290c8a07ef37255aa47b8a9720a86c7c7be03db6a273c7a633e45016d2e9` |
| 不可变镜像 ID | `sha256:133bad09432e2c7e33494aa3feccaaa45d0bf819ae3e260778c559eb7b205114` |
| Preview | `https://rc-4b2de40f0f30.sonic-staging.pages.dev` |
| Preview deployment | `0d16874b-4b07-4ce9-83a8-e3938b9e4bfe` |
| 稳定测试站 | `https://sonic-staging.pages.dev` |
| 稳定测试 deployment | `39da574c-e113-49a5-92d3-0083ada482c5` |

## 已知问题关闭情况

### 隐私、身份与事件

- `personalize=0`、`personalization=off`、重复/冲突参数中任一明确退出值均优先生效；Edge 不再丢失退出决定。
- 新 `personalization.ts` 统一判断；JSON Engine hop 携带签名 public/opt-in/authenticated 状态。退出时移除匿名 ID、上下文和原始用户凭据。
- 必需身份断言缺失、格式错误、过期或密钥不一致返回 `503 ENGINE_IDENTITY_UNAVAILABLE`，不再静默回退为匿名成功。
- 事件确认还验证 Edge 与 Engine 的隐私模式一致。已认证/opt-in 事件不能被旧 Engine 的 `ignoredByPrivacy` 当作成功确认。
- 生产 Engine 或启用 Engine hop 的生产 Edge 要求独立身份密钥；不允许与服务密钥或用户签名密钥复用。健康检查报告 `readiness.identity`。
- GET 读取权威 Engine 失败时返回可重试 503，不再伪造空内存历史。需要持久化的本地身份读写也不会接受 memory 回退。
- 外部删除未确认时返回 `503 EVENT_ERASURE_INCOMPLETE`；结果明确 `localCleared` 和外部状态。

### 保留期与删除语义

- SQLite 和 memory store 使用配置的 retention 天数；覆盖事件、实体反馈和其它实体写入触发的清理；SQLite 清理失败回滚并抛错。
- 新查询/共现贡献绑定到实际保留的 `{subjectKey,eventId}`。用户删除会清除可归属贡献、原始事件、反馈与雷达画像，不删除其他用户的贡献。
- 移除 smart-search 绕过行为事件写入的无归属查询记录。
- Gorse 用户/反馈删除有确认检查及同进程反馈队列屏障；202、错误 HTTP、畸形 200、超时均不报告完成。
- **边界不隐藏：**旧无归属聚合不能推测用户归属，只按保留期过期；不承诺全局训练模型、备份、底层文件残留字节已擦除。Gorse 多进程写入需要跨进程删除协调。物理清理在启动、1500 次写入或间隔一小时后的后续写入触发；休眠实例没有后台定时清理器。

### 播放、重试、歌词与界面

- 搜索/推荐转换保留来源列表、试听类型和已验证解析身份；兼容 `resolvedId` 与 `resolvedPlatformId`。
- 换源只使用合法平台与该平台 ID 配对；无映射时不拿原 ID 到其它平台猜测。稳定歌曲 ID 保持不变。
- 手动和自动重试使用有上限的 `nocache=1`；忽略失效播放 URL/qualities URL，后端跳过旧解析缓存并更新成功结果。
- 歌词各层兜底沿用相同解析身份；保留请求序号、取消和实际 provider/ID 变化保护。
- 完整浏览器回归发现并修复同源播放 URL 更新使无歌词面板空白的竞态：传输地址更新不再错误地使同一曲目歌词请求失效；新增修复前失败的回归。
- 桌面歌曲/歌单/MV 与移动搜索均区分 429、403、503、网络错误和真实空结果；重试后恢复正确结果和选中 Tab。
- 移动迷你播放器加载期间提供可点击的取消按钮，取消后迟到的成功结果不自动起播。
- 桌面列表及桌面/移动展开播放器完整展示曲名和歌手；长内容允许内部纵向滚动。测试明确检查歌手末尾文字可见、固定控件不移动、所有控制可达，以及真实暂停/恢复。

### 发布与可运维性

- 完整发布输入由统一白名单和文件索引驱动，包含 `Dockerfile.ncm`、`player/scripts`、类型声明、CI/测试配置、运维 runbook 等。
- 解压后先重新计算路径/长度/内容摘要并逐文件核验；缺项、额外 payload、篡改和假传入摘要都会拒绝。秘密文件/缓存/数据库/历史不进入发布包。
- Node 基础镜像固定到之前已实测的摘要；manifest 对前端 Docker 部分上下文只声明传入身份，完整验证在打包与 Docker 构建前完成。
- 干净索引目录中已完成 `npm ci`、pnpm 冻结安装、构建前类型检查、lint、前后端构建；构建后索引保持不变。
- Runbook 已修正匹配镜像/数据库恢复和 `--offline`；不再承诺任意 schema 可直接降级。
- 告警使用有界滑动窗口和可配置最少请求/失败数、warning/paging 比例；P95 只按显式配置阈值评估。没有 webhook 或投递失败，完整验收返回失败和非零退出码；metrics-only 明确不是完整 gate。
- **构建边界：**输入一致性不等同供应链全部依赖的逐字节可复现保证；NCM 仍有上游包安装依赖。默认下载脚本/外部 provider 可用性不由本报告证明。

## 最终测试结果

| 验证 | 结果 |
| --- | --- |
| `npm test` 全部后端回归 | **584/584**：网关90、鉴权43、封面15、Engine49、既有Vitest158、beta及本轮增强229 |
| 全部播放器单元/组件测试 | **121/121** |
| 完整无头 Chrome E2E | **83/83**，单 worker，5.2分钟；包含24项新增场景 |
| 强化浏览器重点 gate | **5/5**，无歌词、MV重试、长文本/控件阅读操作 |
| 类型检查、lint、前后端构建 | 通过 |
| 原混合推荐延迟守卫 | P50 **8.57ms**、P95 **12.08ms**，未放宽20/35ms阈值 |
| 隔离 Engine HTTP 备份/恢复/Range | **11项通过** |
| 本地混合请求 | 8工作线程、600请求；P50 **17.92ms**、P95 **41.81ms**，无失败 |
| 本地实际告警接收端 | 收到1次测试告警，HTTP204；完整监控自检通过 |
| 远端实际候选镜像 | **14项通过**，含签名身份失败拒绝、退出不落库、重启持久化、离线恢复 |
| Preview 线上验收 | **12项通过**；签名用户端到端、查询退出、音频、幂等、权威删除 |
| 稳定测试站线上验收 | **12项通过**，与最终 Engine 版本一致 |
| 生产依赖审计 | root和player均为0已知生产依赖漏洞 |
| 匹配旧/新镜像真实回滚演练 | 隔离旧镜像启动、新镜像迁移、离线恢复、旧镜像重启均通过，68条事件保持 |

最终 E2E 截图保存51张。已视觉检查桌面错误/恢复、桌面完整长标题与展开控件、360/390px完整歌手末尾和固定控件、移动可取消加载等代表性截图。

实际线上移动浏览器在390px下无横向溢出，搜索结果完整显示。截图工具首次超时，重试后截图成功；语义点击等待也发生超时，屏幕坐标点击成功。随后实际 audio 状态：duration=10、currentTime=0.223337、paused=false、error=null。该媒体是第一方测试音频；不是商业音源全长播放证明。

## 部署操作与数据保全

远端路径：`/data/workspace/sonic-a75f5cb54a2f-4b2de40f0f30`。

- 新运行容器 `sonic-staging-engine` 为 healthy，仅绑定 `127.0.0.1:18080:8080`，继续挂载 `/data/sonic-staging-data:/app/data`。
- 新增独立 `identity.env`，权限0600，分别注入测试 Engine、测试 Preview 和稳定测试分支。现有服务密钥、用户签名密钥、邀请凭证未轮换。
- `.env.staging`、`tunnel.env` 仍保留且为0600。新 `identity.env` 也为0600，任何秘密值没有写入报告/源码包。
- Preview 先通过精确发布身份与签名用户验收，再通过显式 `--promote-staging` 和 `accepted-preview.json` 门禁提升到稳定测试分支。
- 生产 `cfsolara` 项目、生产 Compose/DNS/Tunnel 和生产密钥没有改变。生产 `sonic-local-engine`、`sonic-ncm-api` 以及测试 Tunnel 的容器ID、启动时间与部署前相同。
- 切换前备份 `/app/data/pre-release-4b2de40f0f30.sqlite`，SHA-256 `681f836acc3f188912aa2aa908f46d3b9d006030e736e9f17fa788eba90df227`。
- 停写快照在最终远端目录 `rollback-data`，摘要表 `staging-rollback-files.json`。旧镜像 `sha256:76cdce122a912d616d7997738ba82f3c08c0dd00f2ff25c594ef251257aebb78` 保留为容器 `sonic-staging-engine-rollback-4b2de40f0f30`。
- 额外旧→新→旧演练使用独立目录和随机本机端口，不停止真实运行的测试或生产容器。结果保存在 `paired-rollback-drill.json`。

## 仍不能冒充完成的生产要求

这些不是本轮已知确定性代码缺陷，而是还缺实际配置/授权和运行证据的上线条件：

1. **实际 OAuth 提供方登录和正式用户会话。**本轮用临时签名测试用户验证真实身份 hop，不等于完成外部 OAuth 登录。
2. **生产许可来源和全长媒体。**测试站保持 strict-allowlist synthetic；未替生产启用商业 provider、第三方 cookie 或授权账户，未验证所有上游完整播放/版权/歌词结果。
3. **生产多实例限流与外部告警。**测试 Engine 单进程限流合规，但 Pages 未绑定的分布式限流不能由本地结果替代；真实外部 webhook 接收端未提供/验证。新完整监控 gate 会拒绝这些缺失条件。
4. **生产负载容量与长时间稳定性。**600请求的本地短测试是功能/退化检查，不是24小时 soak、生产峰值QPS、SLO或多地域并发结论。
5. **外部推荐系统删除。**Gorse API确认/同进程屏障有覆盖；未部署的多进程写入、离线模型、备份删除必须按实际拓扑处理。
6. **生产迁移切换。**已验证匹配镜像与数据恢复方法，但没有执行真实生产数据迁移或生产发布。必须先准备生产独立数据卷、身份密钥、回滚点，再进行生产等效验收。

因此交付口径是：**本轮已知代码缺陷关闭，稳定测试站已更新且指定验收通过；可继续邀请制测试，不能据此宣布 unrestricted 公开生产公测已经放行。**

## 复验命令

在有对应工具且不含生产秘密的开发环境：

```bash
npm run typecheck
npm run lint
npm test
pnpm --dir player test
npm run build
npm run build:engine
npm run test:load
E2E_CHANNEL=chrome pnpm --dir player e2e
```

干净解压后、写入操作日志前：

```bash
node scripts/release-inputs.mjs --verify release.json --index release-files.json
```

具有现有测试环境权限时：

```bash
node scripts/verify-staging-live.mjs
node scripts/verify-staging-live.mjs --stable
```

## 证据

最终接收目录：`evidence/followup/accepted/`。

其中包括：`full-backend.log`、`final-build-player.log`、`all83-run.log`、`stable-live.json`、`preview-live.json`、`remote-build-result.json`、`remote-candidate-result.json`、`staging-deployment-result.json`、`remote-final-state.json`、`paired-rollback-drill.json`、`accepted-extraction.json`、`mixed-load.json`、`browser-summary.json`、`live-mobile-search.png`、`live-mobile-player.png`。

完整83项浏览器截图在 `evidence/followup/ui/final-all83/`；本报告和该证据将单独打包，不改变已经部署的源码摘要。

# 🎵 Sonic（epocanvas sonic）

<div align="center">

[![Version](https://img.shields.io/badge/version-2.2.0-blue.svg?style=flat-square)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg?style=flat-square)](package.json)
[![Vue 3](https://img.shields.io/badge/Vue-3.x-4FC08D.svg?style=flat-square)](player/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?style=flat-square)](tsconfig.json)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare_Pages-Functions-orange.svg?style=flat-square)](https://pages.cloudflare.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg?style=flat-square)](docker-compose.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**Vue 3 音乐播放器 · 多源音乐网关 · 可选 Node.js / SQLite 本地引擎**

[API 参考](API.md) · [运维手册](docs/OPERATIONS.md) · [合规核验](docs/COMPLIANCE.md) · [已知问题](docs/KNOWN_ISSUES.md)

</div>

> [!IMPORTANT]
> 本文按 `rc/sonic-20261031` 分支、`a75f5cb` 源码基线更新（2026-11-02），包版本为 `2.2.0`；工作区尚未提交的并行开发改动不包含在该基线结论中。**存在实现、通过自动化测试和已在生产验证是三件不同的事。** 当前仍有来源策略、静态兜底、接口契约及前端交互缺口，详见[限制与安全边界](#限制与安全边界)。本文不构成线上可用性、内容授权、推荐效果或 SLA 承诺。

## 目录

- [项目定位](#项目定位)
- [已实现能力](#已实现能力)
- [系统架构](#系统架构)
- [源码导航](#源码导航)
- [环境要求与安装](#环境要求与安装)
- [本地开发](#本地开发)
- [测试与质量检查](#测试与质量检查)
- [构建与部署](#构建与部署)
- [配置与密钥](#配置与密钥)
- [API 快速参考](#api-快速参考)
- [推荐与隐私模型](#推荐与隐私模型)
- [限制与安全边界](#限制与安全边界)
- [进一步维护建议](#进一步维护建议)
- [相关文档与致谢](#相关文档与致谢)
- [许可证与第三方内容](#许可证与第三方内容)

## 项目定位

Sonic 是一个浏览器音乐应用和 HTTP 音乐网关，主要由三部分组成：

1. **Web 播放器**：Vue 3、TypeScript、Vite、Pinia、Vue Router、Vue I18n 和 Tailwind CSS，提供桌面与移动界面。
2. **Pages Gateway**：Cloudflare Pages Functions 提供 Sonic 规范接口及部分网易云风格兼容接口，处理搜索、歌词、媒体代理、认证和推荐请求。
3. **Local Engine**：Node.js HTTP 服务复用 Functions 处理器，使用内置 `node:sqlite` 持久化推荐数据，可连接 Compose 内部的 `ncm-api` 侧车。

Pages 可以独立运行，也可以把部分解析、目录和推荐请求交给 Local Engine。Node Engine 同时具备静态文件服务，但它是**服务间受保护入口**，并非启动后即可让浏览器匿名直连全部 API 的公共后端。

项目保留的站点入口为 [sonic.epocanvas.tech](https://sonic.epocanvas.tech) 和 [sonic.epocanvas.com](https://sonic.epocanvas.com)。这些是项目链接，不代表本次文档更新已验证站点在线或允许公开访问。

## 已实现能力

### Web 播放器

- 首页 Banner、歌曲、歌单、歌手、专辑、排行榜和 MV 浏览。
- 主搜索页支持歌曲、歌单、MV；桌面歌手页另有歌手和专辑搜索。包括搜索历史、建议、风格标签和雷达入口。
- 播放/暂停、上一首/下一首、队列、循环/随机、进度、音量、收藏、加入本地歌单和下载入口。
- 播放器抽屉支持歌词滚动、逐字填充、译文/罗马音，以及点击或拖动歌词定位；歌曲详情页主要展示静态歌词。
- MV 播放、推荐列表和合辑接续；桌面 MV 页面有评论热/新排序及本地评论功能。
- 浅色/深色/跟随系统主题，中、英、日三套语言资源，四类背景、性能模式及部分减少动效支持。
- 本地音乐文件选择/拖入、浏览器内播放；下载音频的记录、播放、导出和删除。

**界面与数据边界：**

- 收藏、歌单、播放历史、搜索历史、设置和 MV 本地评论主要保存在 `localStorage`；本地音乐和下载音频 Blob 使用 IndexedDB。它们不是完整的账号云端音乐库。
- 歌曲/歌单评论主要支持读取和分页，发表、点赞入口尚未开放；桌面 MV 评论写入和点赞保存在本机，不是第三方平台评论发布。
- 桌面与移动端不是完全相同的功能集合。例如移动榜单页只有站内趋势与新歌，桌面另有平台榜单。
- “全部播放”依入口而异：歌单详情会尝试分页加载，搜索页通常播放当前页，歌手页播放已加载歌曲，首页歌单快捷播放有数量上限。
- 音质设置是请求偏好，探测是基于响应和元数据的判断，不能保证每首歌都有对应码率、无损或完整流。
- 部分页面仍有截断、静态补位和未翻译文案；不宣称 UI、无障碍和三语翻译已全面完成。

### 音乐网关

- **Nexus 搜索**：聚合已启用来源，规范化曲目并合并 `sources[]`；默认搜索集合包含网易云、QQ、酷狗，酷我支持不等于默认加入所有聚合请求。
- **Smart 搜索**：本地目录、简繁字形映射、内置拼音/首字母和艺人别名词典、模糊匹配、建议及个性化重排；不是通用自然语言模型。
- **音频**：默认同源流式代理，转发 `Range`，校验上游 `206` 的 `Content-Range`；满足 HTTPS、解析器的 CORS-safe 标记及无敏感查询参数等条件时才允许 `mode=redirect`。
- **歌词**：解析和标准化 LRC、YRC、QRC、KRC、TTML 等格式；既有来源提供的时间轴，也有行级歌词插值。判断真实逐字质量需同时参考 `sourceQuality` 等字段，不能只看 `words` 非空。
- **封面/取色**：封面解析、代理与占位图；服务端取色内置 JPEG 解码，其他格式依赖转换条件，不是通用图片格式解码器。
- **兼容目录**：Banner、搜索、歌单、榜单、歌手、专辑、MV、评论及歌曲详情等选定路径；不是上游 API 全量透传。
- **测试媒体**：可选合成 PCM/WAV 曲目及故障响应，用于无第三方音乐内容的受控验证。

来源登记、开关和 allowlist 在 [`licensing.ts`](functions/_lib/sonic/licensing.ts)；实际调用还涉及 [`native-protocols.ts`](functions/_lib/sonic/native-protocols.ts)、Provider 和兼容分支。**开关状态不是内容授权证明，也不能替代实际出站请求审计**；当前 GDStudio 回退存在例外，见后文。

### 认证、缓存与可观测性

- Epomail OAuth 2.0 Authorization Code + PKCE（S256）；浏览器会话使用 `sonic_session` Cookie，通常为 `HttpOnly; Secure; SameSite=Lax`，本机 HTTP 开发有 Secure 例外。
- HMAC-SHA256 签名 API Key：`sonic_live_v2.<header>.<payload>.<signature>`，包含有效期、`kid`、`jti`，支持签名密钥轮换及撤销检查。签名不等于加密。
- 外部客户端使用 `X-Sonic-Key`、兼容的 `X-CFSolara-Key`/`X-Api-Key` 或 `Authorization: Bearer`；浏览器也支持会话 Cookie。URL 查询参数中的 key 不参与认证。
- JSON 缓存可使用进程内存、Cloudflare Cache API、可选 KV；带身份/上下文的推荐响应使用 `private, no-store`。不同接口的缓存策略并不完全相同。
- Pages 到 Engine 的调用包含进程内三态熔断、超时和降级分支；不是全部 Provider 的分布式熔断服务。
- 媒体代理等 `safeFetch` 路径包含协议/主机检查、逐跳重定向校验、凭证剥离和响应限制；Node 额外注册 DNS 地址检查。并非所有出站请求都经过该 helper。
- 结构化访问日志、发布标识、健康端点、实例内存指标及可选告警 webhook；不内置 Prometheus/OpenTelemetry exporter。

### 推荐系统与多实体 Feed

推荐核心是 TypeScript 规则/评分管线，结合行为权重、时间衰减、元数据相似度、会话共现、站内热度及 MMR 多样性重排。单曲相似推荐明确返回 `audioFeaturesUsed: false`；不使用真实音频特征或神经网络模型。ListenBrainz、Gorse、Meilisearch 是可选外部适配器。

已提交源码包含 `track`、`album`、`playlist`、`mv` 实体模型、关系、反馈存储和混合排序。需要区分：

- **API 已有混合响应，现有雷达 UI 仍消费单曲列表。** 前端虽然定义了混合 Feed 客户端函数，但尚无界面调用方。
- 专辑由本地 canonical tracks 分组生成，主题歌单包含内置定义；MV 候选也有从热门曲目推导的占位实体。`hasVideo: true`、`1080p` 等字段不能证明真实 MV URL、视频质量或授权。
- Album/Playlist 与 Track、Track 与 MV 之间有信号传播。部分传播参数、Playlist 弱惩罚和撤销状态处理仍需补齐，不能把设计文档的全部算法视为已经实现。
- 事件目前不会自动把任意外部专辑/MV ID 解析、建模为可召回实体；提交反馈应使用已有目录实体 ID。

契约和算法位置见 [`recommend/types.ts`](functions/_lib/sonic/recommend/types.ts)、[`recommend/engine.ts`](functions/_lib/sonic/recommend/engine.ts)、[`recommend/multi-entity.ts`](functions/_lib/sonic/recommend/multi-entity.ts)。[`docs/recommend-multi-entity.md`](docs/recommend-multi-entity.md) 提供设计背景，但其中部分目标描述仍超出当前实现。

## 系统架构

```text
浏览器 Vue SPA
  ├─ localStorage / IndexedDB：本地设置、音乐库、音频 Blob
  └─ 同源 /api
       ├─ Cloudflare Pages Functions
       │    ├─ 缓存、认证、限流、Provider / CDN 请求
       │    └─ 可选 HTTPS 服务调用 + X-Sonic-Engine-Key
       │         └─ Node.js Local Engine
       │              ├─ 共享 Functions 处理器与原生协议
       │              ├─ SQLite WAL / FTS5
       │              └─ 可选 ncm-api:3000 内部侧车
       └─ 自建可信网关 / 反向代理
            └─ 服务端注入引擎密钥后调用 Local Engine
```

| 运行面 | 入口 / 产物 | 存储与边界 |
|---|---|---|
| Cloudflare Pages | `functions/` + `dist/` | 无 Node SQLite；需要持久推荐时通常连接 Engine |
| Node Engine | `server/index.ts` → `dist-server/index.mjs` | 默认 `127.0.0.1:8080`；业务 API 要求引擎密钥 |
| ncm-api 侧车 | `Dockerfile.ncm` | Compose 内部 `3000`，默认不映射宿主端口 |

Pages 通过文件系统路由加载处理器，Node 在 `server/index.ts` 手工挂载。**共享文件不代表路由自动等价**，例如 `radar-album` 尚未接入 Node dispatcher。

音频带宽由实际代理方承担：Pages 代理可让 Engine 主要负责解析，但浏览器经 Node 流接口收听时，Node 会传输音频字节；不应一概描述为“零 VPS 带宽”。

## 源码导航

```text
sonic/
├─ player/
│  ├─ src/main.ts、App.vue          应用启动
│  ├─ src/routers/、layout/         路由与桌面/移动壳层
│  ├─ src/pages/、components/       页面、播放器、评论、雷达与背景
│  ├─ src/stores/                  Pinia 音频、认证、本地库与推荐状态
│  ├─ src/composables/、utils/      播放、歌词、存储、探测、交互工具
│  ├─ src/api/、languages/、style/   客户端接口、语言与主题
│  ├─ build/、public/               Vite 插件/代理、静态托管配置
│  └─ tests/、e2e/                  Vitest、Mock 网关、Playwright
├─ functions/
│  ├─ _middleware.ts               staging 门禁、发布标识与指标
│  ├─ api/                         认证、音乐、搜索、推荐及兼容路由
│  ├─ _lib/auth.ts、http.ts         认证与 HTTP 基础
│  ├─ _lib/music.ts                 兼容音乐与歌词解析
│  ├─ _lib/sonic/                   安全、配置、缓存、Provider、推荐核心
│  └─ lib/vendor/                  保留许可证的第三方 JPEG 解码器
├─ server/                         Node HTTP 适配、分发与 SQLite 存储
├─ scripts/、tests/                 构建、运维、评估与根级回归测试
├─ .github/workflows/ci.yml         CI 测试、构建、容器与 Mock E2E
├─ docs/                           运维、合规、设计和历史发布资料
├─ Dockerfile、Dockerfile.ncm       引擎与侧车镜像
└─ docker-compose.yml              Engine + ncm-api 编排
```

建议阅读顺序是：`types/config` → `auth/http/security` → Provider 与媒体解析 → 路由处理器 → `server/` 适配与存储 → 前端 API/store/composable → 页面组件 → 测试与部署脚本。

根目录 `index.html`、`js/`、`css/` 是旧静态播放器，不属于当前 Vite 构建入口。`player/src/api/README.md` 是历史上游 API 手册，不等于 Sonic 全部已支持接口。`dist/`、`dist-server/`、自动导入声明、历史截图/日志和灰测结果也不能替代源码或当前运行证据。

## 环境要求与安装

- Node.js **`>=22.13.0`**；CI 和容器采用 Node 22 系列。
- 根目录使用 npm + `package-lock.json`；`player/` 使用 pnpm + `pnpm-lock.yaml`，两者独立安装。
- pnpm `>=10`，CI/容器固定使用 `10.34.5`。
- Docker Compose 仅用于容器部署；Chromium/Chrome 用于浏览器 E2E。

以下多行命令按 Bash / Git Bash 编写；PowerShell 使用自己的环境变量与续行语法。

```bash
# 本文对应 RC 分支；默认 main 不等于本文的实现基线
git clone --branch rc/sonic-20261031 git@github.com:shijianus/sonic.git
cd sonic

corepack enable
corepack prepare pnpm@10.34.5 --activate
npm ci
pnpm --dir player install --frozen-lockfile
```

如果 Node 发行版没有附带 Corepack，可按 pnpm 官方方式安装对应版本。不要用一次根目录 `npm ci` 代替前端安装，也不要提交真实 `.env`、Cookie、密钥或用户数据库。

已有工作区更新前先检查 `git status`，再 `git fetch origin --prune` 并比较跟踪分支；有本地改动时不要用 `reset --hard`、`clean` 或覆盖 README 的方式“拉取”。

## 本地开发

### 前端界面开发

```bash
pnpm --dir player dev
```

Vite 默认端口为 `5089`，配置 `host: true`，会监听可用网络接口。仅需本机访问时可使用：

```bash
pnpm --dir player dev --host 127.0.0.1
```

前端不是单独启动就具备全部音乐 API：

- Axios 默认 `VITE_APP_BASE_API || '/api'`，但推荐、OAuth、部分搜索/歌词/媒体请求直接使用同源 `/api/...`。仅修改该环境变量不能重定向全部请求。
- [`player/.env.example`](player/.env.example) 的 `http://localhost:3000` 是示例，不是宿主 Sonic Gateway 的默认地址；Compose 内部侧车 `ncm-api:3000` 也不对宿主公开。
- `VITE_PROXY` 的现有 helper 会剥离匹配前缀。Sonic Gateway 自身保留 `/api` 路径，因此不能照搬面向上游的代理示例而不核对重写结果。
- 浏览器连接 Engine 需要可信服务端代理注入 `X-Sonic-Engine-Key`。**禁止把 `SONIC_ENGINE_SECRET` 放入 `VITE_*`、浏览器存储或 bundle。**

仓库尚无统一的安全本地前后端编排命令。无需真实音乐来源的界面回归可使用下文的 Mock E2E；它与真实网关联调是不同环境。

### Node.js 本地引擎

```bash
npm run build:engine

# 已在当前 shell 配置所需变量时
npm run start:engine

# 或显式读取自行准备的环境文件
node --env-file=.env --experimental-sqlite dist-server/index.mjs
```

两个启动命令任选其一。`npm run start:engine` **不会自动加载 `.env`**。直接运行 Node 时使用 `HOST` / `PORT`；`SONIC_BIND_PORT` 只用于 Compose 的宿主端口映射。

本机环境至少需要有效的 `SONIC_ENGINE_SECRET`；OAuth/API Key 签发另需 `SONIC_SECRET` 和相应 OAuth 配置。模板中的 `/app/data/sonic-recommend.sqlite` 是容器路径，裸机开发应改为自己的可写路径，例如 `./data/sonic-recommend-dev.sqlite`。

生产裸机启动需设置 `NODE_ENV=production`。SQLite 打开失败时是否拒绝启动取决于它，而不只是 `SONIC_ENV`；开发环境可退回内存，`SONIC_RECOMMEND_DB_PATH=memory` 或 `off` 也会显式使用内存。

```bash
# 仅在可信终端运行；密钥已通过安全方式导入 shell
curl --fail-with-body \
  -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET:?请先设置引擎密钥}" \
  http://127.0.0.1:8080/api/sonic/engine/health
```

引擎能服务根 `dist/` 的 SPA；只有执行 `build:engine` 不会生成前端。静态页面能打开，也不表示页面中的 API 已通过服务认证。

## 测试与质量检查

### 类型与 lint

```bash
npm run typecheck          # Functions/Server + player
npm run typecheck:server   # 根 tsconfig：functions/ 与 server/
npm run typecheck:player   # Vue / TypeScript
npm run lint              # 主题 token + player ESLint
npm run lint:theme
```

根 `tsconfig` 包含 `functions/**/*`，所以该目录中的**未跟踪实验文件也会被检查**。遇到报错应区分提交态和工作区补丁，不要为了“全绿”直接删除已有文件。

### 测试分组与副作用

```bash
npm run test:auth
npm run test:recommend
npm run test:security
npm run test:engine
npm run test:observability
pnpm --dir player test
```

- `test:recommend` 运行两个 Vitest 文件，使用离线目录、内存或系统临时目录 SQLite；包含直接处理器调用，不等于真实 HTTP、真实音乐或跨重启验收。
- 安全/引擎/可观测性测试含本地 HTTP Mock、临时端口或存储操作。运行前应阅读脚本并使用隔离配置。
- `test:observability` 使用 `--self-test`；不要把脚本的 live 分支或告警端点 POST 当作纯读取，它们可能发送 webhook。

以下命令存在，但会涉及真实上游，应在获得授权、隔离环境并检查目标后运行：

```bash
npm run test:gateway
npm run test:cover
npm test
```

`test:engine` 主要验证本地 Mock/引擎，但会创建服务和存储；`npm test` 先做类型检查，再组合网关、认证、封面、引擎及根级回归，因此**不是纯离线测试总开关**。`scripts/` 中历史 live、审计和截图脚本也不是统一跨平台入口，部分写死了环境路径或线上目标。

### 浏览器 E2E

```bash
pnpm --dir player build
pnpm --dir player exec playwright install chromium
pnpm --dir player e2e
```

已有系统 Chrome 时可用 `E2E_CHANNEL=chrome pnpm --dir player e2e`。测试由 [`playwright.config.ts`](player/playwright.config.ts) 和 [`e2e/mock-server.mjs`](player/e2e/mock-server.mjs) 提供确定性 API 与本地 WAV，覆盖路由、播放控件、Seek、部分错误/响应式/无障碍行为。

Mock E2E 不证明真实 Epomail 登录、第三方 CDN Range、付费/地区限制音源或真机体验。涉及 UI 的变更仍需按 [`AGENTS.md`](AGENTS.md) 做真实浏览器截图与交互核验；类型检查和构建不能替代它。

### 离线评估与依赖清单

```bash
npm run eval:recommend
npm run eval:multi-entity
npm run sbom
```

评估使用内存 SQLite 和合成用户场景，输出相关性、多样性、分布与延迟；不是线上效果或 SLA，也不是所有指标超限都会失败的门禁。`sbom` 写入 `reports/sbom/sonic-player.cdx.json`，主要覆盖 **player 生产依赖**，不代表完整供应链或许可证审查完成。

CI 包含类型/lint、若干回归、前端测试、构建、依赖审计、SBOM、容器冒烟与 Mock E2E；不等于运行了每个 `scripts/` 文件、完整 Compose 拓扑或两套离线评估。以 [`ci.yml`](.github/workflows/ci.yml) 为准。

## 构建与部署

### 构建产物

```bash
npm run build          # Vite player/dist，再复制到根 dist/
npm run build:engine   # 生成 dist-server/index.mjs
```

`build:server` 是 `build:engine` 的别名。`copy-dist.mjs` 会重建根 `dist/` 并复制 favicon；不要把手工修改仅保存在构建目录中。

### Cloudflare Pages

完成依赖安装、环境配置和发布门禁后，才运行真实部署：

```bash
npm run deploy
```

该命令会构建并执行 `wrangler pages deploy dist`；默认项目 **`cfsolara`**、目标分支 **`main`**，可通过 `CF_PAGES_PROJECT` / `CF_PAGES_BRANCH` 覆盖。RC 验证应显式选择预览目标，不要把当前 Git 分支当作脚本自动采用的部署分支。

部署脚本默认拒绝 dirty working tree。`ALLOW_DIRTY_DEPLOY=1` 是显式绕过，不建议用于常规发布。Pages 项目、Secret、KV、`RATE_LIMITER`、OAuth 回调、Tunnel/DNS 均需另行配置，仓库没有自动创建这些资源的流程。

### Docker Compose

```bash
# 若 .env 已存在，请编辑它，不要覆盖
test -e .env || cp .env.example .env
# 编辑 .env：设置强随机 SONIC_ENGINE_SECRET、SONIC_SECRET，审查来源策略
# Unix 可使用 chmod 600 .env

docker compose up -d --build
docker compose ps
docker compose logs -f sonic-engine
```

镜像分三阶段构建前端、打包引擎并以非 root 用户运行。Engine 默认绑定宿主 `127.0.0.1:8080`，SQLite 使用命名卷 `sonic-data:/app/data`；ncm-api 只加入 `sonic-internal` 网络。公开访问还需自己配置可信入口，不能把侧车直接暴露成公共网关。

镜像基础标签为 `node:22-alpine`，不是 digest 固定的完全锁定供应链。`Dockerfile.ncm` 固定侧车包版本 `@neteasecloudmusicapienhanced/api@4.41.1`，构建仍需访问包源。

备份、恢复与回滚见 [`docs/OPERATIONS.md`](docs/OPERATIONS.md) 和 [`docs/RUNBOOK-ROLLBACK.md`](docs/RUNBOOK-ROLLBACK.md)。`backup:db` 会创建文件；`restore:db` 会替换目标数据库，须按手册停机并先备份，不能作为无副作用的验证命令。

## 配置与密钥

以 [`.env.example`](.env.example)、[`config.ts`](functions/_lib/sonic/config.ts)、[`licensing.ts`](functions/_lib/sonic/licensing.ts) 和实际部署配置共同核对；**模板值不一定等于代码空配置时的默认值**。

| 配置 | 用途 / 注意 |
|---|---|
| `SONIC_ENGINE_SECRET` | 服务间密钥，至少 32 字符；Pages/Engine 对接时两侧一致 |
| `SONIC_SECRET` | 用户 API Key 签名密钥，至少 32 字符；不是引擎密钥 |
| `SONIC_SECRET_PREV`、`SONIC_SECRET_KID` | 签名密钥轮换；不等于立即撤销所有旧 key |
| `SONIC_LOCAL_ENGINE_URL` | Pages 调用 Engine；远程使用 HTTPS，本机 HTTP 有例外；Engine 不指向自己 |
| `HOST`、`PORT` | 裸机 Node 监听地址/端口，默认 `127.0.0.1:8080` |
| `SONIC_BIND_PORT` | Compose 宿主映射端口，不是 Node 的 `PORT` |
| `NODE_ENV` | `production` 时默认禁止持久库失败后静默退回内存 |
| `SONIC_RECOMMEND_DB_PATH` | SQLite 路径；容器默认 `/app/data/sonic-recommend.sqlite` |
| `SONIC_CONTENT_POLICY`、`SONIC_ALLOWED_SOURCES` | 内容策略与来源名单；不自动核验法律授权 |
| `SONIC_ENABLE_NETEASE`、`SONIC_ENABLE_QQ`、`SONIC_ENABLE_KUGOU`、`SONIC_ENABLE_KUWO` | 原生来源配置开关 |
| `SONIC_ENABLE_AMLL`、`SONIC_ENABLE_LRCLIB` | 歌词来源开关 |
| `SONIC_ENABLE_FREE_CROSS_MATCH` | 跨源匹配，代码默认启用；旧名 `SONIC_ENABLE_FREE_MATCH` 仅作兼容 |
| `SONIC_ENABLE_GDSTUDIO`、`SONIC_ENABLE_LYRIVA`、`SONIC_ENABLE_UNBLOCK` | 示例/Compose 显式关闭；GDStudio 空配置默认和音频回退有例外，见下文 |
| `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE` | 启用合成测试媒体，常规生产配置应显式审查 |
| `SONIC_REQUIRE_AUTH` | 网关匿名访问策略；有效引擎调用有单独档位，不等于所有路径同时要求用户 key |
| `SONIC_RATE_LIMIT_ANON_RPM`、`SONIC_RATE_LIMIT_AUTH_RPM` | KV/内存限流预算；不配置原生 `RATE_LIMITER` 的实际阈值 |
| `SONIC_REQUIRE_DISTRIBUTED_RATE_LIMIT` | 配合 fail-closed 策略要求边缘绑定原生 limiter，不提供全球强一致保证 |
| `SONIC_ENGINE_TIMEOUT_MS`、`SONIC_TIMEOUT_MS` | 引擎/上游超时；模板引擎值 4500ms，代码空配置默认 2500ms |
| `EPOMAIL_BASE_URL`、`EPOMAIL_CLIENT_ID`、`EPOMAIL_CLIENT_SECRET` | OAuth 服务与凭据；未配置时不能完成真实登录 |
| `EPOMAIL_REDIRECT_URI`、`SONIC_ALLOWED_ORIGINS` | 固定回调或回调 origin 推导；不是 API CORS 白名单 |
| `SONIC_ENABLE_KEY_REVOCATION` + `SONIC_KEY_REVOCATION_KV` | 可选 KV 撤销检查；有缓存与跨位置传播延迟 |
| `SONIC_GORSE_URL`、`SONIC_MEILISEARCH_URL` | 外部适配器，留空使用内置实现 |
| `SONIC_ENV`、`SONIC_RELEASE_COMMIT`、`SONIC_STAGING_ACCESS_TOKEN` | 环境标识、发布追溯、可选 staging 访问门禁 |
| `SONIC_ALERT_WEBHOOK_URL` | 告警接收地址；启用后会向外部服务发送告警数据 |

### 来源策略的当前差异

- 标准模式空配置会启用 NetEase、QQ、Kugou、Kuwo、AMLL、LRCLIB，**GDStudio 也默认启用**；模板与 Compose 则显式设置 GDStudio 为 `0`。
- 音频解析的 `allowExternal` 条件在部分原生/Engine 失败路径允许聚合回退，即使 `SONIC_ENABLE_GDSTUDIO=0`。修复并验证之前，不能把该开关当成禁止所有 GDStudio 出站请求的保证。
- `strict-allowlist` 依赖明确名单与开关，并强制禁用 Lyriva/Unblock；但登记为待确认的来源也可被名单启用。GDStudio 在当前代码被标记为 `APPROVED`，与历史授权矩阵不一致，必须由负责人核实依据。
- Apple/YouTube Music 歌词适配器目前是保留骨架，不能通过配置凭据就视为已完成来源。

不要将模板中的 `203.0.113.10` 当成真实出口 IP。账号 Cookie 只应配置在服务端，并遵守所属账号权限与上游条款。

## API 快速参考

[`API.md`](API.md) 提供更长的接口参考，但其中仍有旧示例和与源码不一致的契约；下列示例按当前实现区分运行面。`/api/sonic/*` 通常返回 `{ brand, data, meta }`，兼容路径的响应结构可能不同。

### 请求身份

```http
X-Sonic-Key: sonic_live_v2.<header>.<payload>.<signature>
```

或 `Authorization: Bearer <key>`。浏览器同源 OAuth 会话使用 Cookie。用户 API Key 与 `X-Sonic-Engine-Key` 不能互相替代；后者仅限可信服务/终端使用。

API Key 不要放进 URL、Referer 或公开前端配置。持有 key 的 curl 请求不要盲目使用 `-L` 跟随跨域重定向，以免把自定义认证头发给其他目标。

### 搜索、音频和歌词

以下使用部署者自己配置的 **HTTPS Pages Gateway**，请替换示例地址与 key；不对应本机 Engine：

```bash
API_BASE="https://your-sonic-gateway.example"
SONIC_KEY="sonic_live_v2.<header>.<payload>.<signature>"

curl --fail-with-body --get "$API_BASE/api/sonic/search/nexus" \
  --data-urlencode 'q=晴天' --data-urlencode 'count=10' \
  -H "X-Sonic-Key: $SONIC_KEY"

# 仅测试你有权访问的曲目；默认代理模式，不自动跟随重定向
curl --fail-with-body -D - --output sample-audio.bin \
  -H "X-Sonic-Key: $SONIC_KEY" -H 'Range: bytes=0-65535' \
  "$API_BASE/api/music/stream?id=186016&source=netease&quality=320"

curl --fail-with-body --get "$API_BASE/api/sonic/lyrics/nexus" \
  --data-urlencode 'title=晴天' --data-urlencode 'artist=周杰伦' \
  -H "X-Sonic-Key: $SONIC_KEY"
```

本机 Engine 请求必须额外带服务密钥，例如：

```bash
curl --fail-with-body \
  -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET:?请先设置引擎密钥}" \
  -H "X-Sonic-Key: $SONIC_KEY" \
  'http://127.0.0.1:8080/api/sonic/recommend/for-you?count=12'
```

主要路径与参数：

| 方法 / 路径 | 用途 |
|---|---|
| `GET /api/sonic/search/nexus` | 多源搜索：`q`、`count`、`page`；合并结果数量可能超过单源 count |
| `GET /api/sonic/search/smart` | 智能搜索/建议 |
| `GET /api/music/search` | 兼容单源搜索：`q`、`source` |
| `GET /api/music/stream` | 音频代理：`id`、`source`、`quality`，支持 Range |
| `GET /api/sonic/lyrics/nexus` | 歌词聚合：`title/artist` 或 `platform/platformId` |
| `GET /api/sonic/lyrics/sync` | 歌词格式输出 |
| `GET /api/music/lyric` | 兼容歌词：`id/source`；顶层 lyric/lyrics 是此入口的别名 |
| `GET /api/music/cover` | 封面解析/代理 |
| `GET /api/music/palette` | 图片取色：`image` 或 `url` |

Nexus 歌词和 legacy lyric 不可混用参数或响应字段。Sonic 词/行的 `startMs`、`durationMs` 以及兼容的 `start/duration/end` 使用毫秒，`*Sec` 使用秒。

### 推荐与混合 Feed

```text
GET /api/sonic/recommend/for-you?mode=for-you&count=12
GET /api/sonic/recommend/trending?window=7d&count=20
GET /api/sonic/recommend/similar?trackId=<existing-track-id>
GET /api/sonic/recommend/discover?genre=rock&count=12
```

普通 `for-you` 响应在 `data.tracks`；模式包括 `for-you/recent/favorites/next/radio`。显式混合请求：

```bash
curl --fail-with-body \
  -H "X-Sonic-Key: $SONIC_KEY" \
  "$API_BASE/api/sonic/recommend/for-you?feed=mixed&count=12&types=track,album,playlist,mv"
```

混合响应在 `data` 数组，每项有 `type/id/title/subtitle/cover/score/reason/payload`，`meta` 含 `strategy/distribution/total`。以下是字段形态示意，不是真实授权内容或固定分布：

```json
{
  "brand": "Sonic",
  "data": [
    {
      "type": "album",
      "id": "alb_example",
      "title": "示例派生专辑",
      "subtitle": "示例歌手 · 专辑",
      "cover": "",
      "score": 0.82,
      "reason": "因为你深度收听了该专辑内的曲目",
      "payload": { "trackCount": 10 }
    }
  ],
  "meta": {
    "strategy": "hybrid-multi-entity",
    "distribution": { "track": 0, "album": 1, "playlist": 0, "mv": 0 },
    "total": 1
  }
}
```

`types` 含 album/playlist/mv 等也会触发混合分支。**仅 `types=track` 不会切换响应形态**；若要单一 track 类型的混合数组，须同时传 `feed=mixed&types=track`。混合分支不使用单曲模式的全部 seed/mode 参数。

### 行为事件与清除

```bash
# alb_example 仅为占位：请替换为混合 Feed 中实际返回的实体 ID
curl --fail-with-body -X POST "$API_BASE/api/sonic/events" \
  -H 'Content-Type: application/json' \
  -H "X-Sonic-Key: $SONIC_KEY" \
  -d '{"events":[{"type":"favorite","entity_type":"album","entity_id":"alb_example"}]}'
```

接口支持 `type/action`、`entity_type/entityType`、`entity_id/entityId`。请求体上限 64 KiB，最多处理前 50 条；当前校验 action/type，但**尚未严格校验实体类型、ID 存在性及关系**。不要依赖非法实体字段必定返回 4xx，也不要把示例 ID 当成自动创建实体的请求。

`GET /api/sonic/events` 查看当前身份摘要；以下是删除操作，只对明确要清除的当前身份使用：

```bash
curl --fail-with-body -X DELETE "$API_BASE/api/sonic/events" \
  -H "X-Sonic-Key: $SONIC_KEY"
```

它清除当前存储中该身份的行为事件与实体反馈，不等于清除浏览器文件、全部聚合统计、雷达档案、备份或可选外部推荐服务数据。配置 Engine 时还会尝试远端清除；边缘返回成功不能替代远端删除结果核验。

### 认证与引擎运维入口

- OAuth：`GET /api/auth/login`、`callback`、`user`。
- Key：`GET/POST /api/auth/key`、`POST /api/auth/revoke`；轮换/撤销要求显式 key 请求头。
- 登出：`POST /api/auth/logout`。未配置有效撤销存储时，清 Cookie 不代表已导出的 key 立即失效。
- `GET /api`：配置/发布摘要及部分端点索引，不是完整能力探测；Node 内部 origin 也不应作为公开 OAuth URL 使用。
- `GET /api/sonic/engine/health`：主要判断推荐存储与注入的磁盘检查；sidecar 状态可见，但其失败不一定让整体 `ok` 变为 false。
- `GET /api/sonic/engine/metrics`：实例内存指标。该路径的 **POST 会触发告警测试**，不是普通只读探针。

引擎健康、指标及 resolve 内部接口在 Pages 上也要求引擎服务密钥。

## 推荐与隐私模型

| 身份模式 | 条件 | 个性化行为 |
|---|---|---|
| `authenticated` | 验证通过的用户 key / 会话 | 使用哈希后的用户 subject |
| `anonymous-opt-in` | 显式发送合法 `X-Sonic-Anon-Id` | 使用哈希后的匿名 subject |
| `public` | 无持久身份或明确关闭个性化 | 不保存该请求的个人行为反馈；未关闭个性化时可使用请求上下文 |

没有身份且没有上下文时返回公共/冷启动结果；合法 `X-Sonic-Context` 可在 `public` 模式下参与本次请求的重排，并不产生持久身份。`X-Sonic-Personalization: off` 或 `personalize=0` 等关闭值优先于身份和上下文。匿名客户端可显式发送 `anon_` 前缀的随机 `X-Sonic-Anon-Id`，但它不是账号密码，不应当成强身份认证或访问控制凭据。启用 Gorse 等外部服务时，数据流还包括相应适配器，不能笼统宣称“所有数据永不离开本机”。

Node 存储包含 canonical tracks、FTS5 索引、行为事件、搜索聚合、共现、实体/关系/反馈和雷达档案。`entity_stats` 目前有表结构但没有完整更新管线；SQLite 初始化采用幂等 DDL，并非版本化 migration 系统。

浏览器 MV 合辑会本地持久化并在认证条件下尝试上送；当前云端回读方法未接入调用，Node 又缺少 `radar-album` 分发，所以不能承诺完整跨设备同步。

数据清除 UI 当前会吞掉部分失败并仍显示成功，服务端删除也有范围限制。需要严格删除保证的部署，应额外验证各存储、备份和外部适配器的处理结果。

## 限制与安全边界

1. **返回成功不等于真实内容。** 兼容上游和前端 MV 页面仍存在固定视频、推荐、评论、播放量及详情补位；MV 兼容搜索还有未传关键词的分支。生产发布前应移除或明确标记演示数据。
2. **来源策略存在实现/文档差异。** GDStudio 的空配置默认、显式关闭后的回退及授权登记与历史矩阵不一致。未确认授权的来源不应开放；不要依赖代码里的 `APPROVED` 标签替代授权凭据。
3. **降级状态尚未贯通所有链路。** 无音频 URL 当前返回 `404 STREAM_NOT_FOUND`，不是旧 API 文档中的 `503 STREAM_UNAVAILABLE_DEGRADED`；Nexus 歌词和前端健康状态还有清除降级标记的逻辑。不能承诺所有故障都正确显示降级提示或使用 stale cache。
4. **限流不是全球强一致总额度。** 内存按进程/isolate，KV 为非原子计数；原生 binding 的阈值由平台配置，代码只传 key，不能用 RPM 环境变量或响应头推导严格全局剩余额度。参见 [Cloudflare 限流说明](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。
5. **KV 撤销有一致性延迟。** 本地 30 秒缓存不是全球撤销 SLA；只有开关和 binding 都有效才启用该检查。参见 [KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。
6. **认证与出站保护不能过度概括。** OAuth origin 配置不控制 API CORS，当前 API 返回通配 origin；部分 OAuth、Engine RPC、目录/Provider 请求直接使用 fetch，不具备与媒体 `safeFetch` 完全相同的边界。
7. **SQLite 按单 Engine 写入设计。** 不应让多个副本共享同一文件；没有完整 schema migration/回滚框架。裸机生产须显式设置 `NODE_ENV=production`，并验证备份恢复。
8. **前端仍有安全和交互待修项。** 动画卡片存在未经文本转义的 `innerHTML` 插值；空搜索页初始化、移动历史列表索引、路由复用、分页、重试与分享也有静态审查发现，不能把现有测试通过等同全面安全或可用。
9. **历史测试资料不证明当前发布。** `docs/release/` 的 SHA、报告数量及旧环境结果必须核对日期与分支。Mock、合成音频及离线评分不能代替真实 OAuth、授权 CDN、真机、无障碍和回滚演练。
10. **音质、歌词与第三方权利各自独立。** 请求 FLAC/320 不保证实际质量；插值词轴不等于真实字级标注；源码许可证不授予音乐、歌词、封面或 MV 的再分发权。

## 进一步维护建议

以下是源码审阅后的建议，**不表示本次 README 更新已经修复这些问题**。

### 优先处理：安全、内容真实性与数据正确性

- **消除动画卡片 HTML 注入入口。** [`HeroCard.vue`](player/src/components/Ui/HeroCard.vue) 和 [`MVCard.vue`](player/src/components/Ui/MVCard.vue) 将上游名称拼接到 `innerHTML`；改用 `textContent`/安全 DOM，并为标题、歌手和副标题补组件交互回归。现有 XSS 测试主要检查封面属性及旧播放列表，覆盖不完整。
- **统一来源策略和真实失败响应。** 对 [`licensing.ts`](functions/_lib/sonic/licensing.ts)、[`native-protocols.ts`](functions/_lib/sonic/native-protocols.ts) 建立空配置/模板/严格名单/显式关闭矩阵，验证实际出站请求；移除 [`upstream.ts`](functions/_lib/sonic/upstream.ts) 及 MV 页的无关内容补位。
- **补实体输入和删除结果校验。** 在 [`events.ts`](functions/api/sonic/events.ts) 校验类型、ID、关系、动作一致性；让 [`PrivacyDataSection.vue`](player/src/components/Settings/PrivacyDataSection.vue) 区分各存储删除成功/失败，不吞错后统一报成功。
- **先修阻断性前端路径。** 修复 [`search.vue`](player/src/pages/search.vue) 的 immediate watcher 调用尚未初始化函数、[`mobile/recent.vue`](player/src/pages/mobile/recent.vue) 的历史/队列索引混用，以及详情路由切换时旧状态残留。

### 随后处理：契约、运维与体验

- 为 Pages 路由与 Node dispatcher 建立自动对照，补齐 `radar-album`；同步修订 [`API.md`](API.md) 的 URL key、歌词参数、错误码和带宽描述。
- 提供保留 `/api` 前缀、服务端注入密钥的统一本地开发入口；统一 Axios 与直接 fetch 的基址、认证和错误处理。
- 将混合 Feed 派生实体明确标为 derived/placeholder，验证真实 provider ID 与可播放性后再接 UI；补 Playlist 惩罚、撤销反馈及传播系数 `0` 的处理。
- 建立 SQLite 版本迁移与跨重启实体测试；CI 保存评估数据/硬件条件，增加真实 HTTP 认证、实体持久化、Compose 和路由契约验证。
- 统一请求取消/过期响应保护，修复歌单分享、失败重试与完整加载判断；治理 WebGL/Canvas 监听器、Blob URL 和高 DPI 绘制生命周期。
- 按项目 UI 准则统一筛选栏、完整名称及可见滚动条；逐分辨率截图检查 Tab 稳定性，并补真实键盘/触摸与减少动效验收。
- 清理历史 `CFSolara` 展示文案和旧许可证说明，但保留协议头、缓存键及存储键兼容性；更新 `player/README.md` 与历史上游 API 手册的适用范围。

## 相关文档与致谢

- [`API.md`](API.md)：接口参考；已知漂移见本文建议。
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)：部署、备份恢复、密钥、监控及回滚。
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md)、[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)：源码/依赖与第三方内容边界。
- [`docs/CONTENT-LICENSING-MATRIX.md`](docs/CONTENT-LICENSING-MATRIX.md)：历史来源授权矩阵，须与当前代码和有效授权重新核对。
- [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md)：音频探测、试听与其他历史限制。
- [`docs/recommend-multi-entity.md`](docs/recommend-multi-entity.md)：多实体设计与评估背景。
- [`docs/RUNBOOK-ROLLBACK.md`](docs/RUNBOOK-ROLLBACK.md)：回滚步骤及历史演练记录。
- [`docs/release/RC-SUMMARY.md`](docs/release/RC-SUMMARY.md)、[`RELEASE-CHECKLIST.md`](docs/release/RELEASE-CHECKLIST.md)：历史发布门禁，不能代替当前 commit 的验收。
- [`AGENTS.md`](AGENTS.md)：项目开发与视觉验收约束。

感谢 Vue、Vite、Pinia、Artplayer、Meting、NeteaseCloudMusicApi、AMLL、LRCLIB 等项目和社区。历史实现参考还包括 [Meting-API-Serverless](https://github.com/Warma10032/Meting-API-Serverless)、[ourcraft-music-api](https://github.com/Yuncan050115/ourcraft-music-api)、[music-lib](https://github.com/guohuiyuan/music-lib)、[QQMusicApi](https://github.com/jsososo/QQMusicApi)，以及 Linux.do 社区的交流。引用或致谢不代表合作、背书或内容授权。

## 许可证与第三方内容

根 [`LICENSE`](LICENSE)、[`player/LICENSE`](player/LICENSE) 及当前两个包的元数据均声明 **MIT**；分别保留其中的版权署名。历史文档中的 CC BY-NC-SA 或非商业意图文字不应被混写成当前 MIT 文本的附加条款，本次文档更新不更换许可证。

依赖另有各自许可证，例如 hls.js 和 vendored JPEG 解码器使用 Apache-2.0，GSAP 适用其单独许可；详情见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

音乐录音、歌词、封面、艺人图片、MV、上游 API 及商标权利归各自权利人所有。部署者必须确认内容授权、上游条款、隐私与保留义务；不要绕过付费权限、访问限制或服务条款。源码开源不等于第三方内容可以自由分发。

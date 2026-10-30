# Sonic 内容来源授权边界与服务端门禁清单 (SONIC-P0-07)

- **文档版本**：2026-10-30（对应分支 `work/agy-release-20261031`）
- **代码唯一事实源**：[`functions/_lib/sonic/licensing.ts`](../functions/_lib/sonic/licensing.ts)
- **合规治理铁律**：法律授权结论**必须由项目负责人或授权负责人书面确认**。AI 与服务端代码严禁自行将第三方平台公开接口或服务条款（ToS）解释为“已获商用/内测分发授权”。

---

## 1. 授权状态定义

| 状态枚举 (`ContentAuthorizationStatus`) | 中文名称 | 服务端执行语义 |
| --- | --- | --- |
| `APPROVED` | 已确认可使用 | 自研/CC0 无版权负担资源，可在受控内测与 Staging 全链路开放。 |
| `CONDITIONAL` | 仅在指定条件下可使用 | 具备官方开发者协议或开源开放数据协议，**仅在配置组织自有合法凭证且满足归属/速率条款时**由负责人显式开启。 |
| `PENDING_CONFIRMATION` | 待确认 | 尚未取得项目负责人确认的版权/平台接口授权依据；**在受控内测 `strict-allowlist` 模式下强制服务端拦截（HTTP `403 SOURCE_DISABLED_BY_POLICY`）**。 |
| `PROHIBITED` | 禁止使用 | 未授权第三方聚合站或付费墙/DRM 绕过组件；**所有环境默认关闭且在 `strict-allowlist` 模式下硬性封禁，无论环境变量如何误配均拒绝启用**。 |

---

## 2. 全量音源 / 歌词 / 封面 / 曲库来源矩阵

| 来源 ID | 名称与上游域名 | 涉及能力 | 当前授权状态 | 环境变量开关 | 标准模式默认 | 受控内测 (`strict-allowlist`) | 条件说明 / 阻断原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `synthetic` | Sonic First-Party Synthetic PCM/WAV + 内联 SVG + 原创测试 LRC | 音频 / 歌词 / 封面 / 曲库 | **已确认可使用** (`APPROVED`) | `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE` | `0` (按需开启) | **允许**（当列入 `SONIC_ALLOWED_SOURCES`） | 纯数学正弦波实时合成 16-bit PCM WAV (`syn-440hz` / `syn-528hz` / `syn-chord`)，零第三方版权内容，支持完整 `200`/`206`/`416`/Seek 与故障注入验证。 |
| `apple` | Apple Music Official Catalog API (`api.music.apple.com`) | 歌词 | **仅在指定条件下可使用** (`CONDITIONAL`) | `SONIC_ENABLE_APPLE` + `SONIC_APPLE_MUSIC_TOKEN` | `0` | 默认拦截（需凭证+显式白名单） | 需组织自有 Apple Developer MusicKit 密钥并遵守 Apple Music API 服务条款；缺失密钥返回 `501 PROVIDER_DISABLED`。 |
| `ytmusic` | YouTube Data API v3 (`googleapis.com`) | 歌词 / 元数据 | **仅在指定条件下可使用** (`CONDITIONAL`) | `SONIC_ENABLE_YTMUSIC` + `SONIC_YOUTUBE_API_KEY` | `0` | 默认拦截（需凭证+显式白名单） | 需组织自有 Google Cloud YouTube API Key 并遵守配额与展示归属条款；默认关闭返回 `501 PROVIDER_DISABLED`。 |
| `listenbrainz` | MetaBrainz ListenBrainz Public API (`api.listenbrainz.org`) | 曲库相似歌手元数据 | **仅在指定条件下可使用** (`CONDITIONAL`) | `SONIC_ENABLE_LISTENBRAINZ` | `0` | 默认关闭 | CC0/开放社区元数据，代码内置 `<= 1 req/s` 限速与 6h 缓存；需负责人确认隐私与归属策略后显式开启。 |
| `netease` | 网易云音乐 (`music.163.com` / `music.126.net`) | 音频 / 歌词 / 封面 / 曲库榜单 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_NETEASE` | `1` | **强制拦截 (`403`)** | 商业音乐平台音源、YRC/LRC 歌词、封面与榜单；缺少项目负责人确认的授权协议，受控内测不得对未授权对象开放。 |
| `qq` | QQ 音乐 (`y.qq.com` / `gtimg.cn` / `qpic.cn`) | 音频 / 歌词 / 封面 / 曲库 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_QQ` | `1` | **强制拦截 (`403`)** | 商业音乐平台音源、QRC 歌词、专辑与歌手图片；缺少项目负责人确认的授权依据。 |
| `kugou` | 酷狗音乐 (`kugou.com`) | 音频 / 歌词 / 封面 / 曲库 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_KUGOU` | `1` | **强制拦截 (`403`)** | 商业音乐平台音源、KRC 逐字歌词与封面；缺少项目负责人确认的授权依据。 |
| `kuwo` | 酷我音乐 (`kuwo.cn`) | 音频 / 歌词 / 封面 / 曲库 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_KUWO` | `1` | **强制拦截 (`403`)** | 商业音乐平台音源、歌词与封面（含历史 `/proxy?target=` 兼容路由）；缺少项目负责人确认的授权依据。 |
| `amll` | AMLL TTML Database (`api.amll.dev`) | 歌词 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_AMLL` | `1` | **强制拦截 (`403`)** | 社区贡献 TTML 逐字歌词库；歌词词曲著作权归属权利人，需项目负责人确认内测/生产使用边界。 |
| `lrclib` | LRCLIB Community Lyrics (`lrclib.net`) | 歌词 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_ENABLE_LRCLIB` | `1` | **强制拦截 (`403`)** | 社区公开 LRC 接口；歌词著作权与公开分发合规性需项目负责人确认。 |
| `musixmatch` | Musixmatch Desktop Subtitles (`apic-desktop.musixmatch.com`) | 歌词 | **待确认** (`PENDING_CONFIRMATION`) | `SONIC_CONTENT_POLICY` 管控 | 随通用引擎 | **强制禁用** | 桌面端非商业授权接口，缺少 Musixmatch 商业 API 授权协议，受控内测 `strict-allowlist` 下完全禁止调用。 |
| `gdstudio` | GDStudio 第三方聚合代理 (`gdstudio.xyz`) | 音频 / 歌词 / 封面 / 曲库 | **禁止使用** (`PROHIBITED`) | `SONIC_ENABLE_GDSTUDIO` | `0` | **硬性封禁 (`403`)** | 未获授权第三方聚合代理服务；代码在 `strict-allowlist` 下即使误设 `=1` 也强制置 `false` 并拒绝转发。 |
| `lyriva` | Lyriva 第三方歌词代理 (`lyriva.xyz`) | 歌词 | **禁止使用** (`PROHIBITED`) | `SONIC_ENABLE_LYRIVA` | `0` | **硬性封禁 (`403`)** | 未获授权第三方聚合歌词服务；代码在 `strict-allowlist` 下硬性封禁。 |
| `unblock` | UnblockNeteaseMusic 灰歌/VIP 解锁组件 | 音频 | **禁止使用** (`PROHIBITED`) | `SONIC_ENABLE_UNBLOCK` | `0` | **硬性封禁** | 绕过商业平台付费/版权限制属明确合规红线，严禁在任何受控内测、Staging 或生产环境开启。 |

---

## 3. 服务端强制执行与可审计机制

当服务端配置受控内测白名单策略时：

```ini
SONIC_CONTENT_POLICY=strict-allowlist
SONIC_ALLOWED_SOURCES=synthetic
SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1
```

服务端在**全部入口层**执行统一拦截并累计 `licensing.blockedByPolicy` 审计计数（不发起任何未授权外部上游网络请求）：

1. **音频流与解析**：`/api/music/stream`、`/api/sonic/resolve/stream`、`/proxy?target=...`、`/api/sonic/forward?url=...`（同时通过 `getAllowedMediaDomains(env)` 动态收紧域名白名单）。
2. **搜索与曲库榜单**：`/api/music/search`、`/api/sonic/search/nexus`、`/api/sonic/search/[platform]`、`/api/*`（`handleUpstreamEndpoint` 商业榜单/歌单/歌手接口）、`/proxy?types=search`、冷启动推荐种子库 (`ensureCatalogSeeded` 仅注入 `synthetic` 测试曲目，零商业曲目入库)。
3. **歌词**：`/api/sonic/lyrics/nexus`、`/api/sonic/lyrics/[platform]`、`/api/music/lyric`（含 `getUniversalLyrics` 内部爬虫分支门禁）。
4. **封面与取色**：`/api/music/cover`、`/palette` / `/api/music/palette`。

### 在线审计核验命令

```bash
curl -sS -H "X-Sonic-Engine-Key: ${SONIC_ENGINE_SECRET}" \
  http://127.0.0.1:18080/api/sonic/engine/metrics | jq '.licensing, .observability.licensing'
```

---

## 4. 商业音源恢复开放的人工审批流程

若后续项目负责人完成某音源（例如 `netease` 或自建获批测试音频对象存储域名）的版权/接口授权签署：

1. 将对应授权依据编号与适用范围登记至本文件并提交 PR 留痕。
2. 若为自建授权测试音频 CDN 域名，仅需设置 `SONIC_AUTHORIZED_TEST_DOMAINS=cdn-test.example.com`（仍强制经过 HTTPS + SSRF 私网/元数据地址拦截 + 签名 URL `private, no-store` 保护）。
3. 若为获批平台来源，由负责人在环境变量中显式更新 `SONIC_ALLOWED_SOURCES=synthetic,<approved_source>`。

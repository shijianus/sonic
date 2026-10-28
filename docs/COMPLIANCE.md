# 许可证、依赖与内容合规核验（2026-10-28）

> 本文档是工程核验记录，不构成法律意见。涉及许可选择、商业使用与内容授权的最终判断，应由维护者与专业法律顾问确认。

## 1. 项目许可证现状（存在未决冲突）

| 位置 | 当前声明 | 核验结果 |
|---|---|---|
| 根目录 `LICENSE` | MIT License | 文件完整，实际存在 |
| `player/LICENSE` | MIT License | 文件完整，实际存在 |
| `player/package.json` | 本次整改前为 `CC BY-NC-SA`，已改为 `MIT` | 与 `player/LICENSE` 对齐 |
| `README.md`（历史版本） | 声称 CC BY-NC-SA 4.0，并链接根 `LICENSE` | 与根 `LICENSE` 的 MIT 文本冲突 |
| 本次整改后的 README | 明确标注冲突待维护者裁决，以根 `LICENSE` 为准 | 不再宣称 CC BY-NC-SA |

**结论：** 仓库中实际存在的两份 `LICENSE` 文件均为 MIT。历史 README 与 `player/package.json` 的 CC BY-NC-SA 声明没有对应许可证文件支撑。本次整改**没有**擅自选择或替换项目许可证，只做了两项可逆处理：

1. 将 `player/package.json` 的 `license` 字段改为与同目录 `LICENSE` 一致的 `MIT`；
2. 在 README 中公开披露冲突，并声明裁决前以根 `LICENSE` 为准。

**待维护者决定：**
- 若最终采用 MIT：删除 README 中的 CC 历史描述与徽章，补充 `NOTICE`/第三方声明即可。
- 若最终采用 CC BY-NC-SA 4.0：必须新增完整的 CC BY-NC-SA 4.0 法律文本替换根 `LICENSE`，并评估 MIT 代码已被分发后的不可撤回性。
- 在裁决前，不应对外发布新的许可承诺。

## 2. 第三方依赖许可证

### 2.1 运行时直接依赖（浏览器 SPA）

| 包 | 版本范围 | 许可证 | 备注 |
|---|---|---|---|
| `vue`, `vue-router`, `vue-i18n`, `pinia`, `pinia-plugin-persistedstate` | 见 `player/package.json` | MIT | 宽松许可 |
| `@vueuse/core` | `^13.9.0` | MIT | 宽松许可 |
| `axios` | `^1.12.2` | MIT | 宽松许可 |
| `artplayer`, `artplayer-plugin-hls-control` | `^5.3.0` / `^1.0.1` | MIT | 宽松许可 |
| `hls.js` | `^1.6.15` | Apache-2.0 | 需保留 NOTICE/版权声明 |
| `lottie-web`, `nprogress`, `swiper`, `three`, `music-metadata` | 见清单 | MIT | 宽松许可 |
| `ogl` | `^1.0.11` | Unlicense | 公共领域式许可 |
| `gsap` | `^3.13.0` | **GSAP Standard "no charge" License** | 非 OSI 标准许可证；商业/闭源分发前必须阅读 <https://gsap.com/standard-license/> 并评估是否需要商业授权 |

### 2.2 构建期依赖（不进入运行时镜像）

`vite`、`typescript`、`vitest`、ESLint、`@tailwindcss/postcss`、`vite-plugin-svg-icons` 等已归入 `devDependencies`。它们不随静态产物或 Node 运行时镜像分发，但仍属于 CI 供应链的一部分。

已知构建期告警：`vite-plugin-svg-icons@2.0.1 -> svg-baker -> postcss@5 / micromatch@3` 存在历史 ReDoS 公告。该链路只在构建阶段处理本地 SVG 资源，不接收运行时用户输入；风险被限定在构建机。后续可替换为维护中的 SVG 图标插件或改为内联资源，届时删除该依赖。

### 2.3 Node 引擎

Node 引擎由 `esbuild` 打包为单文件，仅依赖 Node.js 22 内置模块（`http`、`fs`、`dns`、`node:sqlite` 等），**不携带第三方 npm 运行时依赖**。

仓库内含一个 vendored 源码文件 `functions/lib/vendor/jpeg-decoder.js`（Copyright 2011 notmasteryet，Apache-2.0），其许可证头保留在文件内；它会随引擎/Pages 产物一起分发。

### 2.4 容器侧车

`Dockerfile.ncm` 安装 `@neteasecloudmusicapienhanced/api@4.41.1`。经 `npm view` 核验其 `license` 字段为 **MIT**。该容器仅在 Compose 内部网络可达，不对外暴露端口。

## 3. 依赖漏洞核验

| 范围 | 命令 | 结果（2026-10-28） |
|---|---|---|
| 根依赖（生产面） | `npm audit --omit=dev` | 0 漏洞 |
| Player 生产依赖 | `pnpm --dir player audit --prod` | 0 漏洞（整改前为 2 high / 6 moderate，均来自被误归为生产依赖的构建插件） |
| Player 全量依赖（含构建期） | `pnpm --dir player audit` | 仍有构建期 `postcss` / `micromatch` / `decode-uri-component` 告警；不进入运行时，待替换插件 |

CI 中的门禁为 `npm audit --omit=dev --audit-level=high` 与 `pnpm --dir player audit --prod --audit-level=high`，构建期告警单独在技术债中跟踪，不会伪装成已清零。

## 4. SBOM 与依赖清单

生成命令：

```bash
npm run sbom
# 输出 reports/sbom/sonic-player.cdx.json（CycloneDX 1.5 风格，生产依赖）
```

脚本 `scripts/generate-sbom.mjs` 直接读取 `pnpm licenses list --prod --json`，不会联网推断许可证。CI 应将该文件作为构建产物归档。

## 5. 音乐内容与代理合规

1. **源代码许可不等于内容许可。** 音乐录音、歌词、封面、艺人图片、MV 的版权归各权利人所有。本项目不授予、也无法授予这些内容的再分发权。
2. **上游条款。** 网易云音乐、QQ 音乐、酷狗、酷我、LRCLIB、AMLL、GDStudio、Lyriva 等上游均有各自服务条款。启用某个 provider 前，部署者必须自行确认其使用方式符合条款与当地法律。
3. **代理与缓存。** `/api/sonic/forward`、`/api/music/stream`、`/api/music/cover`、`/palette`、`/proxy` 会转发或缓存第三方资源。默认只允许受控音乐 CDN 域名、HTTPS、标准端口，并剥离 `Set-Cookie` 与凭证头；这降低了开放代理风险，但不改变内容本身的授权状态。
4. **会员凭证。** `NETEASE_COOKIE`、`QQ_COOKIE`、`KUGOU_COOKIE` 仅由部署者自行提供，代码不内置任何真实账号 Cookie。不得使用他人账号、共享会员或规避付费墙。
5. **版权投诉/下架。** 维护者应提供公开的联系渠道，并在收到有效通知后：停止对应 provider/缓存、清理缓存与派生数据、保留处理记录。当前仓库未内置工单系统，需由部署者补充。
6. **非商业声明。** 若最终采用 MIT，MIT 本身不限制商业使用；README 历史中的“非商业”描述不能作为法律限制。若维护者希望限制商业使用，应选择相应许可证并统一所有声明。

## 6. 部署者需自行确认的事项

- 是否拥有公开展示/分发相关音乐元数据、歌词、封面与音频流的权利；
- 是否遵守上游 API 的速率、缓存、署名与再分发条款；
- 是否完成个人信息保护影响评估（匿名设备 ID、行为事件、IP、OAuth 邮箱）；
- 是否配置了数据删除与保留策略（默认行为事件保留 90 天）；
- 是否就 GSAP 的许可模式取得所需授权；
- 是否就最终项目许可证取得维护者/法律顾问确认。

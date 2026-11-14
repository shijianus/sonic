# Sonic 本地公测候选测试报告

## 固定基线

- Commit：`5e8151a2e68a14aa2553371003abe3172880d3e0`
- Release ID：`5e8151a2e68a14aa2553371003abe3172880d3e0`
- Source digest：`834c26c6d75f0c85ff0a81835de505caee9b59acdb5f5b78852e63df23d407a8`
- 分支：`codex/refactor-public-beta`
- 运行范围：本地 Work VPS，loopback only
- 外部网络：压力脚本为 `false`

## 完整验证命令

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm ci` | 0 | 根依赖安装通过 |
| `corepack pnpm@10.34.5 --dir player install --frozen-lockfile` | 0 | Player 冻结安装通过 |
| `npm test` | 0 | Gateway 101、Auth 44、Cover 28、Engine 52、主 Vitest 247、Beta 390 |
| `corepack pnpm@10.34.5 --dir player test` | 0 | 20 files、169 tests |
| `npm run lint` | 0 | 主题 lint 和 ESLint 通过 |
| `npm run build` | 0 | 前端构建和静态复制通过 |
| `npm run build:engine` | 0 | Engine 构建通过 |
| `node scripts/release-inputs.mjs --verify dist/release.json` | 0 | 478 个发布输入通过摘要校验 |
| `npm run verify:pages-deploy` | 0 | Pages tree、release identity、compiled release 通过 |
| `TMPDIR=../audit-current/tmp node --experimental-sqlite scripts/verify-built-release.mjs` | 0 | HTTP、SQLite、恢复和 production synthetic gate 通过 |
| `npm run test:pressure` | 0 | 本地并发压力门禁通过 |
| `npm audit --omit=dev --audit-level=high` | 0 | 根生产依赖无已知漏洞 |
| `pnpm --dir player audit --prod --audit-level=high` | 0 | Player 生产依赖无已知漏洞 |

浏览器 E2E 最终尝试运行 123 项，但 Chromium 在启动阶段因当前沙箱的 `socket() failed: Operation not permitted` 和 `ptrace: Operation not permitted` 退出，退出码为 `1`，没有进入页面断言。Docker 和 Docker Compose 不在当前 Work 环境中，因此容器构建保持未运行。

## 本地 Engine smoke

通过 `scripts/start-bare-metal-engine.mjs` 在 `127.0.0.1:18080` 启动并执行 `scripts/verify-engine-smoke.mjs`。

- Engine health 无 Key 返回 401
- 大小写路径仍返回 401
- 带 Key 返回 200
- release identity 和 `X-Sonic-Release` 一致
- SQLite readiness 正常
- synthetic WAV 返回 200
- Range 返回 206
- 越界 Range 返回 416
- Engine 日志只记录路径，不记录 query、Cookie 或 Authorization
- smoke 退出码为 0

## 压力结果

最终命令：

```bash
CI=true SONIC_PRESSURE_WORKERS=8 SONIC_PRESSURE_REQUESTS_PER_WORKER=75 npm run test:pressure
```

- 执行时间：2026-11-14T14:42:57.317Z
- 总请求数：605
- 并发 workers：8
- 每 worker 请求数：75
- 测试耗时：1239.90 ms
- 吞吐：487.94 req/s
- P50：12.58 ms
- P95：38.11 ms
- 最大延迟：76.91 ms
- 取消检查：16/16
- subject 隔离：8/8
- 清理后事件数：0
- `externalNetwork`：false
- 结果：`ok: true`

压力覆盖搜索、音频 200/206/416、未知音源 404、取消、并发 Range、错误响应、事件写入、profile 查询、SQLite 隔离和 DELETE 清理。

机器可读证据位于 `reports/release-readiness/evidence/public-beta-pressure.json`。

## 代码重构验证

- cloudsearch 按歌曲、歌单、歌手、专辑和 MV 类型校验结构化结果
- 字符串和 malformed result 返回可观察错误
- provider 全失败返回 502 或超时 504
- MV 搜索将关键词传递给上游，并兼容结构化 `result.mvs` 与旧式 `data` 数组
- Nexus 空结果与 provider 全失败分离
- 分页总数标记为未知，避免伪造总数
- 前端歌曲、歌单、MV 按结果类型校验响应
- quality probe 缓存和取消键包含来源、平台 ID、URL 和 qualities
- 缺少音质 URL 时不把同一外部 URL 冒充成更高档位
- 根目录声明 `packageManager: pnpm@10.34.5`

推荐评估保持 `livePlaybackVerified: false`。本地 synthetic 播放和 Range 验证不能替代真实浏览器解码与真实 CDN 起播。

## 未覆盖项目

本地验证不包含真实 OAuth、真实 provider、真实 CDN、Cloudflare Durable Object、公网容量、真机和人工无障碍验收。

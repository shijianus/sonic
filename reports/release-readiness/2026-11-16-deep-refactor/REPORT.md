# Sonic 本机公测候选版深度重构验收报告

- 验收日期：2026-11-16（Asia/Tokyo）
- 本轮基线：`752911f0c2d65e03717468b91e67c152f8d69c5b`
- 本轮提交：`5cfeb865f90ea24d2bb81ba4d0751db75f5c63fe`
- 上游参照：`1c03ce4acc36d4b28f31cba83fcd25086714650a`
- 当前工作区：干净；未向 GitHub 推送本轮提交
- 测试边界：只使用本机 loopback、合成 Provider、mock server 和本地生成 WAV；没有登录账户、没有公网部署、没有写入真实凭据

## 本轮实际修复

1. `cloudsearch type=1004`：Web 上游返回 malformed envelope 或 HTML 时，不再直接返回 502；会记录失败原因并按 LinuxAPI → EAPI 回退，统一输出 `result.mvs`、`mvCount`、规范化标题/歌手和可观察 attempts。
2. 播放容灾：播放成功、刷新重播成功或音质切换成功后，清空本歌曲的 source retry budget，避免旧故障耗尽后续独立故障的回退次数。
3. 移动端搜索竞态：清空查询、路由/标签变化会 abort 在途请求并递增 generation，迟到响应不能回填隐藏结果或覆盖新查询。
4. 分页边界：新增分页值规范化和页码 clamp；上游 total 缩小时自动回到合法页码，避免产生无效 offset。
5. 外部推荐适配器：拒绝带 userinfo/query/hash 的服务 URL；Gorse、Meilisearch、ListenBrainz JSON 响应增加字节上限，避免无界 `response.json()` 分配。

本轮相对基线共 12 个文件，332 行新增、31 行删除；新增 3 个测试/工具文件。

## 自动化验证

所有命令的完整 stdout/stderr 保存在本目录对应 `.log` 文件，命令退出码保存在 `exit-codes.txt`。

| 命令 | 结果 |
|---|---|
| `CI=true npm test` | 0；网关 101、认证 44、封面 28、本地引擎 52、主 Vitest 247、Beta 394，合计 866 项通过 |
| `CI=true corepack pnpm --dir player test` | 0；22 个文件、178 项通过 |
| 后端定向回归（runtime + external-adapters） | 0；2 个文件、82 项通过 |
| 前端定向回归（pagination + search race + playback race） | 0；3 个文件、54 项通过 |
| `CI=true npm run lint` | 0；theme lint 与 ESLint 通过 |
| `CI=true npm run build` | 0 |
| `CI=true npm run build:engine` | 0 |
| `CI=true node scripts/verify-built-release.mjs` | 0；12/12 发布检查通过 |
| `CI=true npm run verify:pages-deploy` | 0；Pages 构建树和 release manifest 一致 |
| `npm run test:load` | 0；600 请求、8 workers、416.67 req/s、p95 38.05ms |
| `npm run test:pressure` | 0；605 请求、8 workers、490.36 req/s、p95 36.98ms、16 次取消检查通过 |
| `npm run test:observability` | 0；脱敏、失败投递拒绝、缺失 webhook 拒绝均通过 |
| `npm run eval:recommend` | 0；6 personas、Precision@10 0.6167、NDCG@10 0.7729 |
| `npm run eval:multi-entity` | 0；4 personas、4 type probes、传播校验全部通过 |
| `PLAYWRIGHT_BROWSERS_PATH=0 CI=true corepack pnpm --dir player exec playwright test --reporter=line` | 0；桌面/移动端共 123/123 通过，耗时约 7.7 分钟 |

构建后的发布身份：

- `releaseId`: `5cfeb865f90ea24d2bb81ba4d0751db75f5c63fe`
- `sourceDigest`: `be0bd32f3d508a65ca8ec5d08c0efd14e3e6d986e8c8f151cb3e8b701e7d3a1b`
- `dirty`: `false`
- `pagesArtifactDigest`: `3ad942aa7c83b5038a456b7c6004ba158652fc6af64063be48d1f4a68a328e54`

## 浏览器证据说明

第一次不设置 `PLAYWRIGHT_BROWSERS_PATH` 的命令退出码为 130，原因是当前用户缓存目录 `/home/agent/.cache/ms-playwright/...` 没有浏览器二进制；该命令在确认环境路径问题后停止，没有将其当作代码失败。随后使用项目依赖内的 Chromium（`PLAYWRIGHT_BROWSERS_PATH=0`）先通过单用例，再完成全量 123/123 浏览器验证。完整原始日志保存在 `playwright-system.log` 和 `playwright-project-browser.log`。

## 本地压力与部署边界

已在 loopback 完成构建后的 HTTP、Range（200/206/416）、鉴权、SSRF、防护、取消、隐私隔离和压力验证。压测使用合成音源，明确没有测量公网容量、真实 Provider 可用性、真实 CDN 拉流、真实 OAuth 交换、Cloudflare Durable Object 线上限流或浏览器连接真实外部音源。

因此本版本可以作为**本机公测候选版和本地压力测试版**交付；公网生产上线仍需要发布负责人在具备真实环境条件后独立验证上述外部链路，不能把本地合成测试结果标记为生产通过。

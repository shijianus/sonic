# Sonic 受限公测远端交接说明

> 本文随邀请制访问、OAuth 保留和账号数据同步改动提交。它是远端 Codex/CI/Cloudflare 测试的前置合同，不代表生产 GO。

## 1. 受限产品边界

- `SONIC_ACCESS_MODE=invite` 时，邀请码只授予受限公测访问资格。
- 邀请码不会创建 EpoMail 用户、不会签发 `sonic_session`、不会生成 Sonic API Key，也不会改变用户认证限流档位。
- EpoMail OAuth 必须保留。OAuth 仍独立负责账号身份、PKCE、回调、会话、退出和 API Key 生命周期。
- 没有邀请码时业务 API、`/proxy`、`/palette` 等受保护业务入口必须拒绝；访问页面本身、邀请码接口和 OAuth 生命周期接口必须仍可达。
- 未登录但已兑换邀请码的用户可以使用受限公测；收藏、歌单、历史和设置保存在本机。
- OAuth 服务端核验成功后才进入账号本地命名空间；账号收藏/歌单同步不上传下载文件、导入 Blob、临时播放 URL 或 OAuth 凭证。
- 访客本地数据不得静默上传。只有用户明确点击“合并本机数据”后，才生成账号库操作。
- 未获得授权的商业音源、歌词、封面和 MV 不得因为邀请码而开启；测试合成源只能用于受控验证。

## 2. 必须由远端注入的秘密和绑定

不要把下列值写入 Git、`VITE_*`、前端 bundle、报告或命令行参数：

```text
SONIC_ENGINE_SECRET              # Pages -> Engine 服务密钥，>=32 字符
SONIC_ENGINE_IDENTITY_SECRET     # 独立 Engine 身份断言密钥，不能复用上面两项
SONIC_SECRET                     # OAuth/API Key HMAC 密钥，>=32 字符
SONIC_ACCESS_SECRET              # Pages invite 签名 session 密钥，>=32 字符，独立
EPOMAIL_CLIENT_ID
EPOMAIL_CLIENT_SECRET
SONIC_INVITE_CODES               # 仅在受控密钥管理中提供；不得写入 commit
```

建议：

- Node Engine 使用独立持久文件：
  - `SONIC_RECOMMEND_DB_PATH=/app/data/sonic-recommend.sqlite`
  - `SONIC_ACCOUNT_DB_PATH=/app/data/sonic-account.sqlite`
  - `SONIC_ACCESS_DB_PATH=/app/data/sonic-access.sqlite`
- Pages invite 模式没有 SQLite 时必须设置 `SONIC_ACCESS_SECRET` 和服务端邀请码来源；无安全持久/签名配置时应 fail closed。
- 邀请码每个至少 16 字符。Pages-only 签名会话可被重复兑换且无法服务端撤销，只适合短 TTL 的受控内测；需要单次使用或撤销时必须使用 Engine SQLite（`SONIC_ACCESS_DB_PATH`），并用 `npm run revoke:invite -- <db> <code>` 撤销。
- `SONIC_CONTENT_POLICY=strict-allowlist` 时只列入已书面批准的来源。
- 邀请制环境设置 `SONIC_ACCESS_MODE=invite`，不要同时依赖旧的共享 `SONIC_STAGING_ACCESS_TOKEN`。
- 继续设置 `X-Robots-Tag: noindex, nofollow, noarchive`、外部访问门禁和独立测试域名。

## 2.1 远端 staging 脚本的运行参数

`verify-staging-live.mjs`、`deploy-staging-engine.py`、`verify-staging-candidate.py` 和 `build-staging-release.sh` 不包含项目当前环境的 SSH 账号、主机、绝对路径或旧镜像默认值。远端运行者必须在受控 shell 中提供：

```text
SONIC_STAGING_SSH_TARGET=user@approved-host
SONIC_STAGING_SSH_PORT=<approved SSH port>
SONIC_STAGING_ENV_PATH=<local protected env path>
SONIC_STAGING_REMOTE_ENV_PATH=<remote protected env path>
SONIC_STAGING_REMOTE_IDENTITY_PATH=<remote protected identity env path>
SONIC_STAGING_REMOTE_DATA_DIR=<remote staging data directory>
SONIC_STAGING_DATA_DIR=<local/remote data mount used by docker checks>
SONIC_STAGING_ENV_FILE=<protected staging env file>
SONIC_STAGING_IDENTITY_FILE=<protected identity env file>
SONIC_EXPECTED_STAGING_IMAGE_ID=sha256:<previous immutable image digest>
SONIC_STAGING_TEST_INVITE_CODE=<disposable staging invite from secure storage>
```

这些值不得写入源码、报告、命令参数、浏览器 URL 或提交记录；远端脚本在缺少必要变量时应 fail closed。

在能访问受控 Staging VPS SSH 的执行环境中运行 `node scripts/verify-staging-live.mjs --preflight`，核对稳定 Staging 的访问模式、匿名门禁与 Engine 就绪状态。预检不兑换邀请码。

使用已部署的候选制品执行 `node scripts/verify-staging-live.mjs --url <isolated-preview-url>`，再对同一份制品的稳定 Staging 执行 `node scripts/verify-staging-live.mjs --stable`。每次邀请制验收都使用独立的测试邀请码，通过受控环境注入 `SONIC_STAGING_TEST_INVITE_CODE`。脚本向 Staging 的兑换接口提交邀请码，核对受保护 API、无效会话和退出后的访问控制，并在结束时清理测试会话。发布证据须包含 `accessGateMode: "invite"` 和 `inviteAccessLiveVerified: true`。

`inviteSessionRevocationDurable` 记录是否验证了服务端撤销与旧 Cookie 重放拒绝。Pages 签名会话验收会验证浏览器 Cookie 清理，并报告该字段为 `false`。使用短有效期并在验收后移除临时测试邀请码。`--serve-browser` 用于旧共享门禁。产品邀请制浏览器测试应使用另一个专用邀请码在 Staging 页面表单兑换。

Staging Engine 默认仅启用 `synthetic`。在邀请门禁开启的同一候选发布上测试真实媒体时，可设置 `SONIC_STAGING_APPROVED_SOURCES`，按需从 `netease,qq,kugou,kuwo,amll,lrclib` 选择已获批准的来源。`python3 scripts/deploy-staging-engine.py --check-source-policy` 只打印会使用的内容策略与来源开关。保持 Pages 的受限访问门禁，并根据本次测试范围配置 Pages 白名单和真实 OAuth。

候选 Engine 尝试启动后，部署失败会停止候选并保留当前 SQLite 数据与清除恢复保护。按回滚手册选用兼容版本和经过恢复保护验证的快照。



在干净 checkout、受控临时数据和 Node/pnpm 锁定版本中执行：

```bash
npm ci
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm --dir player install --frozen-lockfile
npm run typecheck
npm run lint
npm test
npm run build
npm run build:engine
pnpm --dir player exec playwright install --with-deps chromium
pnpm --dir player exec playwright test
```

Node/SQLite 邀请验收至少覆盖：

1. 错误/过期/撤销邀请码均拒绝，响应不回显原始邀请码。
2. 并发兑换同一单次邀请码最多成功一次。
3. 邀请码核销和访问 session 创建必须同一事务；任一步失败都不能消耗邀请码。
4. 访问 session 过期、撤销、退出后拒绝；OAuth Cookie 不随访问退出被清除。
5. 只有访问 Cookie 无 OAuth 身份时仍是访客，不能访问账号库/API Key。
6. OAuth 登录后账号库按服务端 verified subject 隔离；两用户不得互读。
7. 账号库版本冲突、重复 operationId、断网重试和删除 tombstone 不得复活旧数据。
8. 访客本地数据只有显式合并后才上传；下载/导入音频始终留在本机。
9. 访问资格失效不改变 OAuth 会话；OAuth 退出不伪造访问成功。

Cloudflare/Engine 线上验收至少覆盖：

- 匿名、邀请码兑换、有效访问 Cookie、失效 Cookie 的真实 HTTP 状态/响应头。
- Pages -> Tunnel -> Engine 的 `X-Sonic-Engine-Key` 和独立 identity assertion。
- `GET/POST /api/account/library` 的 Edge/Engine/SQLite 重启持久化。
- OAuth login/callback/logout/revoke 使用真实测试账号；不能用临时签名 subject 冒充 OAuth 完成。
- `RATE_LIMITER` binding、外部告警、P95/5xx、磁盘余量和回滚演练。
- 只在获得许可的音源上验证 Range/206/416、Seek、歌词和完整播放。

## 4. 交付限制

- 本提交不包含生产密钥、邀请码明文、Cookie、用户数据库、浏览器 profile、Playwright trace、临时日志或未经筛选的运行归档。
- 本提交不会自动部署、推送、修改 DNS/Tunnel、切换 Cloudflare 项目或操作真实数据库。
- 当前质量门禁通过不等于真实 OAuth、商业来源授权、生产容量、真机和生产回滚已经通过。
- 远端 Codex 应先在隔离分支完成上述验证和必要修复，再生成新的 release manifest/source digest；不得复用旧 dirty release 身份。
- 在远端验收闭环、内容授权、容量和负责人签署前，状态保持 **受限邀请制测试 / public production NO-GO**。

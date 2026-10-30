# Sonic RC 决策记录（DECISIONS）

- UTC：2026-10-30T01:31:03Z
- 适用分支：`rc/sonic-20261031`
- 代码 SHA：`d29a32ff61caef96507176325f9b5e296360e3f4`

## D-01 API Key：拒绝旧格式，不做“补 HMAC”兼容

**背景**：旧 `sonic_live_<base64(email)>_<sig>` 不含可验证的 iat/exp/jti/kid，无法安全重算签名或撤销。

**决定**：只接受 `sonic_live_v2.<header>.<payload>.<sig>`；旧 Key 一律拒绝，用户重新登录获取 v2 Key。
不为“兼容”保留任何“格式正确即认证”的路径。

**后果**：已发旧 Key 失效；这是安全迁移，不是回归。回滚只能回滚代码，不能恢复旧 Key 的合法性。

## D-02 OAuth：state + PKCE 强制，缺失即失败

**背景**：历史实现可被请求指定 state，callback 未验证，PKCE 可降级。

**决定**：state 256-bit 随机、HttpOnly Cookie 绑定、常量时间比较、一次性消费；PKCE S256 强制，
verifier 缺失/非法直接 400；会话只经 `sonic_session` HttpOnly Cookie 下发，绝不放入 URL。
OAuth 配置不完整时 503 fail-closed，不提供假登录。

**后果**：真实 Epomail 未联调前，登录入口不得作为内测已验收能力。

## D-03 音乐代理：只允许供应商音乐域，移除顶点域

**背景**：原白名单包含 `qq.com`、`163.com`，会连带放行 `mail.qq.com`、`mail.163.com` 等非音乐服务，
扩大开放代理与带宽滥用面。

**决定**：白名单收敛为仓库实际使用的音乐域：`music.126.net`、`music.163.com`、`y.qq.com`、
`qqmusic.qq.com`、`gtimg.cn`、`qpic.cn`、`kugou.com`、`kuwo.cn` 及歌词供应商域。
保留逐跳重定向校验、HTTPS、端口、内网/Metadata 拦截、响应类型与大小限制、Range 透传。

**后果**：未登记的 CDN 会 400；如真实播放发现遗漏，按“新增具体音乐子域”修复，不回退到顶点域。

## D-04 Linux Engine：认证与 Host 解耦，默认 fail-closed

**背景**：历史逻辑部分依赖 Host/X-Forwarded-Host，客户端可伪造。

**决定**：`SONIC_RUNTIME=linux-engine` 时所有 `/api`、`/proxy`、`/palette` 必须携带
`X-Sonic-Engine-Key`；密钥缺失/短于 32 字符返回 503，错误 Key 返回 401；从不读取 Host 做授权判断。
Node 进程启动时强制覆盖 `SONIC_RUNTIME=linux-engine`，防止环境变量误配关闭门禁。

**后果**：Engine 只能由持有服务密钥的网关调用；静态 SPA 仍公开，但 SPA 直连 Engine API 会 401。

## D-05 环境变量：新名优先，旧名只读兼容

**背景**：代码读 `SONIC_ENABLE_FREE_CROSS_MATCH`，示例/README 写 `SONIC_ENABLE_FREE_MATCH`，
运维关闭跨源补齐会静默失效。

**决定**：新名非空时优先；新名为空/未设时读取旧名；`tests/config-parity.test.ts` 锁定行为。
旧名在 2.2 线保留，后续版本移除。

**后果**：现有部署无需立即改配置；新部署使用新名。

## D-06 版本：统一 2.2.0

**决定**：根 `package.json`、`player/package.json`、网关 UA、各 provider UA 统一为 `2.2.0`。
RC 标识通过分支/标签表达，不在包版本中制造第四种字符串。

**后果**：缓存/日志中的 UA 从 2.0/2.1.0 变为 2.2.0，属预期。

## D-07 分支：以 `rc/sonic-20261031` 为集成权威

**背景**：指令要求 `release/rc-20261031`；协作方已创建 `rc/sonic-20261031` 并在其上完成
前端竞态修复、E2E、CI 扩展；`origin/main` 是基线祖先。

**决定**：以 `rc/sonic-20261031` 为集成/交付分支，`release/rc-20261031` 保留为基线。
不回退、不强推协作提交；本轮修复以追加提交进入 RC。

**后果**：PR/部署引用 `rc/sonic-20261031`；如需统一命名，在 GO 前由负责人决定是否快进
`release/rc-20261031` 到同一 SHA。

## D-08 发布判断：NO-GO 与内测隔离

**决定**：代码/构建/自动化测试通过不等于可发布。真实 OAuth、真实 CDN Range/206、内容授权、
Staging 部署与回滚、真机验收、监控告警任一未闭环，即 NO-GO。
若负责人批准缩小范围做受控内测，必须隐藏账号功能、关闭未授权源、加访问控制、禁止索引，
并在健康端点暴露发布 SHA；不得把 Mock E2E 表述为真实链路验收。

**后果**：当前不得部署 Preview/生产；下一步是获取外部输入与 Staging 证据，而不是继续重构。

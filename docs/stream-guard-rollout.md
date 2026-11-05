# Stream Guard 灰度上线与运维演练手册（Rollout & Runbook）

本文档规定了 Sonic 流媒体安全防护机制（Stream Guard）从旁路监控到全量强制拦截的渐进式灰度上线流程、指标监控、阈值调整、缓存与 Cookie 隔离规范及应急回滚预案。

---

## 1. 核心铁律与上线前置检查

> [!CRITICAL]
> **前端必须先发布，严禁服务端先行开启 `enforce`！**
> 
> * **原因剖析**：未加载新版客户端代码的浏览器标签页、离线 PWA 缓存用户以及旧版前端不会主动调用 `/api/music/ticket` 换取播放票据。若在旧版前端仍有流量时直接将服务端切换为 `SONIC_STREAM_GUARD=enforce`，所有未携带票据的正常用户播放请求将直接触发 HTTP 403 `STREAM_TICKET_REQUIRED`，引发全站播放大面积瘫痪。
> * **上线次序**：
>   1. **第一步**：前端与后端代码同步发布，但服务端配置强制保持 `SONIC_STREAM_GUARD=off` 或 `monitor`。
>   2. **第二步**：在 `monitor` 模式下观察**建议不少于 7 天**，确认前端票据附带率稳定达标（`MISSING_TICKET` 告警接近归零），并完整覆盖工作日与周末的收听峰谷周期。
>   3. **第三步**：人工确认后，才可将环境变量调整为 `SONIC_STREAM_GUARD=enforce`。

---

## 2. 三阶段灰度演进路径

```
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  Phase 0: off (当前)    │ ───> │  Phase 1: monitor      │ ───> │  Phase 2: enforce      │
│  - 纯旁路直通          │      │  - 签发票据            │      │  - 针对性拦截无票据    │
│  - 零拦截、零影响      │      │  - 记录日志、不阻断    │      │  - API Key 100% 直通   │
└────────────────────────┘      └────────────────────────┘      └────────────────────────┘
```

### 阶段 0：静默就绪（`SONIC_STREAM_GUARD=off`，默认）
* **系统行为**：
  * `/api/music/ticket` 开放可用，前端已具备自动换取票据与静默降级能力。
  * `/api/music/stream` 完全旁路所有 Stream Guard 检查，维持改动前的原有直通行为。
  * API Key 鉴权用户与匿名用户不受任何校验或配额影响。
* **验证目标**：
  * 确认前端构建与新代码部署无白屏、控制台无未捕获异常。
  * 验证手动调用 `POST /api/music/ticket` 能正常返回 `200` 及签名票据。

### 阶段 1：旁路监控与基线采集（`SONIC_STREAM_GUARD=monitor`）
* **配置变更**：
  * 在 Cloudflare Pages / Linux Engine 环境变量设置：
    ```env
    SONIC_STREAM_GUARD=monitor
    ```
* **系统行为**：
  * 服务端对所有请求执行票据解码、CORS 检查、播放授权升级、防盗链匹配与滑动窗口抓取配额统计。
  * **发现异常（如缺少票据、跨域不符、超出频次）时仅输出 Warning 日志，绝对不阻断请求**，状态码依然正常返回 200/206。
  * 持续积累真实流量的会话分布与票据命中基线。
* **观察周期**：**建议不少于 7 天**（完整覆盖周内工作日、周末听歌高峰及周期性抓取爬虫脚本的扫描规律）。

### 阶段 2：强制保护拦截（`SONIC_STREAM_GUARD=enforce`）
* **范围与定性（重要）**：
  > [!IMPORTANT]
  > **`enforce` 仅对“匿名且无有效 API Key”的请求生效，绝非对全站流量的“全量拦截”**。
  > 持有效 API Key（`X-Sonic-Key` / `Bearer`）或 Linux Engine 内部密钥的调用享有 **100% 绝对直通保证（C1/C5 铁律）**，响应头、Range 206 状态及行为与改动前完全一致。
* **配置变更**：
  * 在 Cloudflare Pages / Linux Engine 环境变量设置：
    ```env
    SONIC_STREAM_GUARD=enforce
    SONIC_CORS_STRICT=1
    SONIC_DOWNLOAD_GUARD=1
    ```
* **系统行为**：
  * 匿名/网页端无票据请求拒绝（HTTP 403 `STREAM_TICKET_REQUIRED`）。
  * 伪造、篡改或过期票据拒绝（HTTP 403 `INVALID_TICKET`）。
  * 票据首次校验成功后升级为“播放授权（Playback Grant）”，有效期根据曲目时长延长至 `min(曲长×2, 30分钟)`，放行后续所有同一会话的 Range/Seek 缓冲拉取。
  * 盗用他人票据（跨会话/不同 IP 伪造）直接拦截（HTTP 403 `TICKET_SESSION_MISMATCH`）。
  * 非白名单 Origin 跨域请求直接拦截（HTTP 403 `CORS_FORBIDDEN`）。
  * 1 分钟内顺序扫描超过 30 首不同曲目的爬虫限流拦截（HTTP 429 `STREAM_QUOTA_EXCEEDED`）。
  * 强制关闭 `?mode=redirect` 直链暴露，所有流量必须经由同源反代。

---

## 3. 关键观察指标与日志审计

### 3.1 核心日志特征（Cloudflare Workers / Engine 控制台）

| 日志关键字 | 严重级别 | 含义与判定标准 | 应对建议 |
| :--- | :--- | :--- | :--- |
| `[Stream Guard Monitor] Invalid or missing ticket: MISSING_TICKET` | WARN | 客户端未附带票据。在 `monitor` 阶段早期存在属于正常（旧缓存未失效），若持续高频则需排查特定端未更新。 | 检查该请求的 User-Agent 与 Referer，评估是否为旧客户端或爬虫 |
| `[Stream Guard Monitor] Quota exceeded for <subject>: <reason>` | WARN | 检测到批量抓取特征（如 1 分钟内抓取 > 30 首不同曲目）。 | 确认为恶意爬虫后，可作为开启 `enforce` 的依据 |
| `[Stream Guard] Blocked <reason> for <subject>` | ERROR | `enforce` 模式下拦截非法请求（返回 403/429）。 | 检查拦截量是否激增，确认是否有合法用户被误杀 |
| `{"type":"rate_limit_binding_missing", ...}` | WARN | 原生 KV / RateLimiter 绑定未配置，降级为本地内存计数。 | 非致命，若需多 Isolate 强一致可绑定 `STREAM_GUARD_KV` |

### 3.2 运维度量端点 (`GET /api/sonic/engine/metrics`)

定期拉取监控指标，重点观察以下度量项：
* `stream_metric_total{status="proxied_200"}`：正常音频完整拉取量
* `stream_metric_total{status="proxied_206"}`：正常 Range 分片拉取量
* `stream_metric_total{status="err_403"}`：拦截非法请求量（开启 `enforce` 后出现爬虫拦截属预期；若伴随播放报错则属于误拦截）
* `stream_metric_total{status="err_429"}`：配额超限拦截量

---

## 4. 阈值与环境变量调整指南

| 环境变量名 | 默认值 | 推荐调优范围 | 说明 |
| :--- | :--- | :--- | :--- |
| `SONIC_STREAM_GUARD` | `off` | `off` / `monitor` / `enforce` | 防护主开关 |
| `SONIC_CORS_STRICT` | `0` | `0` / `1` | 是否严格限制 Origin。建议在 `enforce` 时置为 `1` |
| `SONIC_ALLOWED_ORIGINS` | 空 | 逗号分隔的合法域名列表 | 例如：`https://sonic.example.com,https://app.sonic.com` |
| `SONIC_DOWNLOAD_GUARD` | `0` | `0` / `1` | 下载专用票据与每日限额防护开关 |
| `SONIC_ANON_DOWNLOAD_LIMIT_DAILY` | `20` | `10` ~ `100` | 匿名会话每日允许下载的单曲上限 |
| `SONIC_RATE_LIMIT_ANON_RPM` | `240` | `120` ~ `600` | 网关匿名访问基础限流阈值（每分钟请求数） |

---

## 5. 缓存架构、无状态授权与 Cookie 隔离规范（Cache & Cookie Architecture）

### 5.1 匿名流缓存安全与边缘命中率影响（如实说明）
* **Cache-Control 安全收紧**：
  * 在 `monitor` 与 `enforce` 模式下，针对**匿名且需要票据**的音频流响应，服务端统一返回：
    ```http
    Cache-Control: private, no-store
    ```
  * **技术必要性**：若允许共享缓存（如 Cloudflare Edge CDN）缓存匿名音频响应，则未经票据鉴权的未授权爬虫只需请求相同 URL 即可从边缘缓存节点直接读取音频文件，彻底绕过 Stream Guard 守卫逻辑。
  * **对边缘缓存命中率的客观影响**：
    * **匿名播放流量**：边缘公共缓存命中率降低至 0%（每个 Range 切片均经由 Worker 执行无状态票据/授权验签并向源站代理），Worker 调用量与上游代理回源量呈 1:1 线性对应。
    * **有效 API Key 调用者**：严格维持原有 `streamCacheControl` 规则（如 `public, max-age=600`），100% 保留原有边缘高速缓存与免回源收益（满足 C1 约束）。

### 5.2 无状态播放授权令牌（Stateless Playback Grant）
* **多 Isolate 与冷启动自愈**：
  * 首次验票通过后，服务端签发 HMAC 签名的无状态授权令牌：
    ```
    sg_grant_v1.<payload_base64url>.<sig_base64url>
    ```
  * Payload 包含 `sub`（会话标识）、`tid`（曲目指纹 `source:id:br`）、`p`（play/download）、`iat`、`exp`（有效期设定为 `min(曲长×2, 30分钟)`）、`nonce` 与 `uip`（客户端 IP 哈希）。
  * 后续 Range 请求由任意 Worker Isolate 纯密码学验签放行，**不依赖服务端进程内存，也不依赖 KV 存储**。
  * `STREAM_GUARD_KV` 仅作为可选的“黑名单吊销/防重放”增强，未绑定或读写降级时绝不影响正常播放。

### 5.3 预加载冲突隔离与曲目作用域 Cookie
* **曲目指纹 Cookie 命名隔离**：
  * 授权 Cookie 严格采用曲目指纹短哈希隔离命名：
    ```
    sonic_grant_${sha256Hex(tid).slice(0, 12)}=sg_grant_v1...
    ```
  * **预加载互不干扰**：当播放曲目 A 并后台触发 `preloadNextTrack()` 预加载曲目 B 时，曲目 B 换取的授权 Cookie 为 `sonic_grant_B`，与曲目 A 的 `sonic_grant_A` 在浏览器中共存，彻底杜绝全局 Cookie 覆盖导致曲目 A 无法 Seek/Range 的问题。
* **Path 限制与 8 个 Cookie LRU 淘汰**：
  * 所有 `sonic_grant_*` Cookie 的 `Path` 强制限制为 `/api/music/stream`，避免普通页面与静态资源请求冗余携带。
  * 同一会话最多保留最近 8 个 grant Cookie。当超过 8 个时，服务端在返回新 Cookie 时附带最旧 Cookie 的 `Max-Age=0` 淘汰指令，即使连续播放 50 首以上，请求头总大小依然稳定在 ~2KB（严格 <= 4KB 浏览器头上限）。
  * Cookie `Max-Age` 与 grant 的 `exp` 绝对对齐。
* **IP 绑定软化与移动网络漫游支持**：
  * 在 `enforce` 模式下，针对同一会话内因 Wi-Fi 切蜂窝数据引起的 IP 变化，系统记录审计日志并计入指标，**不直接返回 403 阻断**，确保移动端通勤播放不断流。
  * 仅当检测到“不同会话 + 不同 IP”跨客户端盗用票据时才予以 403 拒绝。
* **多通道透明兼容**：
  * 前端 `<audio>` 原生播放优先在 `src` URL 中附带 `?t=<ticket>`。
  * 服务端支持从 Cookie（`sonic_grant_*`）、请求头（`X-Sonic-Grant` / `X-Sonic-Ticket`）及 Query 参数（`?grant=` / `?t=`）多通道识别授权。

---

## 6. 秒级应急与回滚步骤

如在灰度切换至 `enforce` 过程中发现任何异常（例如用户反馈偶发无法切歌、第三方合作端报错），严格按照以下两级预案处置：

### 预案 A：秒级配置回滚（无损、无需重新部署代码）
1. 打开 Cloudflare Dashboard -> Workers & Pages -> 项目设置 -> 环境变量（或 Linux Engine 的 `.env`）；
2. 将 `SONIC_STREAM_GUARD` 的值直接修改为 `off`（完全关闭）或 `monitor`（退回旁路观察）；
3. 保存并部署配置。边缘节点将在 **30 秒内全网同步生效**，拦截立即解除。

### 预案 B：代码级撤销回滚
若需要彻底回退代码版本：
```bash
git revert HEAD
git push origin <branch>
```
重新执行生产发布流水线。

---

## 7. 预览环境手动验收清单（Manual Verification Checklist）

在预览环境（Preview Deployment）开启 `SONIC_STREAM_GUARD=enforce` 并进入正式生产前，必须在以下各终端完成全量手动验收并记录核验结果：

### 7.1 桌面端 Chrome（已安装“猫抓 / Cat Catch”扩展）
- [ ] **完整播放一首**：在扩展开启并监控所有网络请求的情况下，歌曲从头至尾流畅播放无卡顿；检查猫抓嗅探到的音频请求，确认无法直接在无 Session 环境复用。
- [ ] **拖动进度条（Seek）**：在播放第 10 秒跳跃至第 1 分钟、第 2 分钟，连续拖拽 5 次以上，观察 Range 206 响应正常，音频无缝续播。
- [ ] **暂停 5 分钟后恢复**：播放 30 秒后暂停，静置 5 分钟以上（超出初始票据 120s TTL），再次点击播放，依靠生效的 Playback Grant 依然顺畅续播，无 403 报错。
- [ ] **切歌后回切**：播放歌曲 A -> 切换到歌曲 B 播放 10 秒 -> 切换回歌曲 A 继续播放，两首歌曲均能正常 Seek 和缓冲。
- [ ] **预加载下一首**：打开 DevTools Network 面板，观察播放接近尾声或列表初始化时 `preloadNextTrack()` 发起的下一首拉取，确认两首歌曲的 `sonic_grant_*` Cookie 正常共存、互不覆盖。
- [ ] **下载一首**：点击单曲下载按钮，验证通过 `purpose=download` 票据走 XHR blob 完整下载，保存文件能正常本地双击播放。
- [ ] **API Key 脚本调用**：使用 curl 或 Python 脚本携带有效 `X-Sonic-Key` 发送带 `Range: bytes=0-1023` 请求，验证返回 206、响应头符合 C1 规范且完全不受票据限制。

### 7.2 移动端 iOS Safari（WebKit 引擎）
- [ ] **完整播放一首**：Safari 原生音频播放，锁屏/切后台后台音频播放正常。
- [ ] **拖动进度条**：原生控制条随意拖动，Range 206 快速缓冲并解码。
- [ ] **暂停 5 分钟后恢复**：锁屏暂停 5 分钟后点亮屏幕恢复，音频无死锁或重载失败。
- [ ] **切歌后回切**：列表切歌顺畅，回切原曲无播放中断。
- [ ] **预加载下一首**：下一首顺利预载无报错。
- [ ] **下载一首**：iOS 触发下载弹窗并可存入“文件”App。
- [ ] **网络漫游（Wi-Fi 切 4G/5G）**：在连接 Wi-Fi 播放时断开 Wi-Fi 切换到蜂窝移动网络，继续拖动进度条，验证 IP 漂移时仍能正常 Range 续播。

### 7.3 移动端 Android Chrome
- [ ] **完整播放一首**：前台与后台通知栏播放顺畅。
- [ ] **拖动进度条**：多次快速拖动进度条正常解码。
- [ ] **暂停 5 分钟后恢复**：暂停 5 分钟后恢复播放，验证 grant 延续有效。
- [ ] **切歌后回切**：多曲目交替切换播放正常。
- [ ] **预加载下一首**：后台预载不影响当前播放。
- [ ] **下载一首**：正常触发下载并存入本地存储。
- [ ] **网络漫游（蜂窝切 Wi-Fi）**：播放中切换网络环境，Range 请求顺畅不中断。

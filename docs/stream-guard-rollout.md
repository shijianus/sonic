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

## 5. 缓存架构与 Cookie 隔离规范（Cache & Cookie Architecture）

1. **音频流接口绝对不含 `Set-Cookie`**：
   * `/api/music/stream` 媒体代理接口**严禁下发任何 `Set-Cookie` 响应头**。
   * 会话 Cookie（`sonic_anon_session`）仅在 `POST /api/music/ticket`（标有 `no-store, no-cache, must-revalidate` 的非缓存 JSON 接口）上下发。
   * 这彻底避免了 RFC 9111 中共享 CDN（Cloudflare 边缘缓存节点、中继代理）在缓存公共音频切片时错误缓存并广播用户私人 Cookie 的风险。
2. **`?t=` 对缓存命中率的影响与多途径支持**：
   * **URL 参数的局限性**：若将票据放于 URL（`?t=...`），由于票据包含随机 `nonce` 与动态时间戳，不同用户的请求 URL 各不相同，会导致公共边缘 CDN 缓存无法跨用户命中。
   * **多途径透明传递**：服务端已实现同时支持：
     - 请求头：`X-Sonic-Ticket: <ticket>`（供 fetch / XHR 使用）
     - 会话 Cookie：`sonic_play_ticket=<ticket>`（供 `<audio>` 播放器自动携带）
     - Query 参数：`?t=<ticket>`（兼容性回退）
   * 采用 Cookie 或请求头传递时，音频 URL 保持干净统一（`/api/music/stream?id=...&source=...&br=...`），既能实现强鉴权防盗，又能享受 100% 的边缘公共缓存与浏览器强缓存优势。

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

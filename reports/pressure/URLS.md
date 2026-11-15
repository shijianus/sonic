# Sonic 本地 VPS URL 验证清单

- 验证时间: `2026-11-15T15:52:40.706Z`
- Release ID: `1c03ce4acc36d4b28f31cba83fcd25086714650a`
- Source Digest: `af33ace2ff5fe969f321c0f8f9939c131b937781c5b9e837ec26b40e85abec8e`
- 启动入口: `scripts/start-bare-metal-engine.mjs`（仅绑定 `127.0.0.1`，Staging `19080`、Production `19081`）
- 覆盖汇总: 共 **27** 个请求，**27/27** 符合预期（`passed=true`）
- 脱敏说明: 所有认证请求头（`X-Sonic-Engine-Key`、`X-Sonic-Verified-Identity`）均已按 `[REDACTED]` / `[SIGNED]` 脱敏展示，不包含任何环境变量密钥原文。

## Staging (`http://127.0.0.1:19080`)

`SONIC_ENV=staging`, `SONIC_CONTENT_POLICY=strict-allowlist`, `SONIC_ALLOWED_SOURCES=synthetic`, `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1`

| # | Method | URL | Headers | Expected | Actual | Result | Response Summary |
|---:|---|---|---|---|---|---|---|
| 1 | `GET` | `http://127.0.0.1:19080/api/sonic/engine/health` | `(none - anonymous)` | 401 | 401 | PASS | `error.code=ENGINE_UNAUTHORIZED, message=Valid X-Sonic-Engine-Key header is required to access Sonic Local Engine` |
| 2 | `GET` | `http://127.0.0.1:19080/api/sonic/engine/health` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `ok=true, env=staging, storage=sqlite, enableSynthetic=true, sources=[synthetic]` |
| 3 | `GET` | `http://127.0.0.1:19080/release.json` | `(none)` | 200 | 200 | PASS | `releaseId=1c03ce4acc36d4b28f31cba83fcd25086714650a, dirty=false, baseCommit=1c03ce4acc36d4b28f31cba83fcd25086714650a` |
| 4 | `GET` | `http://127.0.0.1:19080/api/sonic/engine/metrics` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `ok=true, reqTotal=5, rateLimitBackend=memory` |
| 5 | `GET` | `http://127.0.0.1:19080/api/sonic/search/nexus?q=Sonic&count=3` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `brand=Sonic, tracks=3, provider=nexus` |
| 6 | `GET` | `http://127.0.0.1:19080/api/music/search?q=Sonic&source=synthetic&count=3` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `ok=true, source=synthetic, count=3, tracks=3` |
| 7 | `GET` | `http://127.0.0.1:19080/api/music/search?q=Sonic&source=netease&count=3` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=SOURCE_DISABLED_BY_POLICY, message=Source 'netease' is disabled by server content policy` |
| 8 | `GET` | `http://127.0.0.1:19080/api/sonic/search/gdstudio?q=Sonic` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=SOURCE_DISABLED_BY_POLICY, message=Search provider 'gdstudio' is disabled by server content policy` |
| 9 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-440hz&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `audioBytes=192044, magic=RIFF, content-type=audio/wav` |
| 10 | `HEAD` | `http://127.0.0.1:19080/api/music/stream?id=syn-440hz&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `HEAD bodyBytes=0, content-type=audio/wav, content-length=192044` |
| 11 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-440hz&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED], Range: bytes=0-1023` | 206 | 206 | PASS | `audioBytes=1024, magic=RIFF, content-type=audio/wav, content-range=bytes 0-1023/192044` |
| 12 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-440hz&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED], Range: bytes=999999999-` | 416 | 416 | PASS | `error.code=RANGE_NOT_SATISFIABLE, message=Requested byte range is outside 0-192043` |
| 13 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=pressure-missing&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 404 | 404 | PASS | `error.code=STREAM_NOT_FOUND, message=当前曲目暂无可用音源或受版权限制` |
| 14 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-fault-403&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=UPSTREAM_FORBIDDEN, message=Simulated upstream 403 forbidden fault` |
| 15 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-fault-429&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 429 | 429 | PASS | `error.code=UPSTREAM_RATE_LIMITED, message=Simulated upstream 429 rate limit fault` |
| 16 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-fault-500&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 502 | 502 | PASS | `error.code=UPSTREAM_ERROR, message=Simulated upstream 502 gateway fault` |
| 17 | `GET` | `http://127.0.0.1:19080/api/music/stream?id=syn-fault-timeout&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 504 | 504 | PASS | `error.code=UPSTREAM_TIMEOUT, message=Simulated upstream stream timeout fault` |
| 18 | `POST` | `http://127.0.0.1:19080/api/sonic/events` | `X-Sonic-Engine-Key: [REDACTED], X-Sonic-Verified-Identity: [SIGNED], X-Sonic-Identity-Required: 1, Content-Type: application/json` | 200 | 200 | PASS | `brand=Sonic, accepted=1, deduplicated=0, ignoredByPrivacy=0, storageKind=sqlite` |
| 19 | `GET` | `http://127.0.0.1:19080/api/sonic/events` | `X-Sonic-Engine-Key: [REDACTED], X-Sonic-Verified-Identity: [SIGNED], X-Sonic-Identity-Required: 1` | 200 | 200 | PASS | `brand=Sonic, privacyMode=anonymous-opt-in, eventEpoch=null, personalizationEnabled=true, totalEvents=1` |
| 20 | `DELETE` | `http://127.0.0.1:19080/api/sonic/events` | `X-Sonic-Engine-Key: [REDACTED], X-Sonic-Verified-Identity: [SIGNED], X-Sonic-Identity-Required: 1` | 200 | 200 | PASS | `brand=Sonic, cleared=true, removedEvents=1, storageKind=sqlite, localCleared=true, aggregateScope=subject-attributed` |
| 21 | `GET` | `http://127.0.0.1:19080/api/sonic/recommend/for-you?count=6&feed=mixed` | `X-Sonic-Engine-Key: [REDACTED], X-Sonic-Verified-Identity: [SIGNED], X-Sonic-Identity-Required: 1` | 200 | 200 | PASS | `brand=Sonic, items=4, strategy=hybrid-multi-entity, total=4` |

## Production (`http://127.0.0.1:19081`)

`SONIC_ENV=production`, `SONIC_CONTENT_POLICY=strict-allowlist`, `SONIC_ALLOWED_SOURCES=netease,qq,kugou,kuwo,amll,lrclib`, `SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1`（生产模式下强制关闭 `synthetic`）

| # | Method | URL | Headers | Expected | Actual | Result | Response Summary |
|---:|---|---|---|---|---|---|---|
| 22 | `GET` | `http://127.0.0.1:19081/api/sonic/engine/health` | `(none - anonymous)` | 401 | 401 | PASS | `error.code=ENGINE_UNAUTHORIZED, message=Valid X-Sonic-Engine-Key header is required to access Sonic Local Engine` |
| 23 | `GET` | `http://127.0.0.1:19081/api/sonic/engine/health` | `X-Sonic-Engine-Key: [REDACTED]` | 200 | 200 | PASS | `ok=true, env=production, storage=sqlite, enableSynthetic=false, sources=[netease,qq,kugou,kuwo,amll,lrclib]` |
| 24 | `GET` | `http://127.0.0.1:19081/release.json` | `(none)` | 200 | 200 | PASS | `releaseId=1c03ce4acc36d4b28f31cba83fcd25086714650a, dirty=false, baseCommit=1c03ce4acc36d4b28f31cba83fcd25086714650a` |
| 25 | `GET` | `http://127.0.0.1:19081/api/music/stream?id=syn-440hz&source=synthetic` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=SOURCE_DISABLED_BY_POLICY, message=音源 'synthetic' 在当前内容授权策略 (strict-allowlist) 下已禁用` |
| 26 | `GET` | `http://127.0.0.1:19081/api/sonic/test-audio?id=syn-440hz` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=SOURCE_DISABLED_BY_POLICY, message=Synthetic test audio source is disabled (set SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1 outside production)` |
| 27 | `GET` | `http://127.0.0.1:19081/api/music/search?q=Sonic&source=synthetic&count=3` | `X-Sonic-Engine-Key: [REDACTED]` | 403 | 403 | PASS | `error.code=SOURCE_DISABLED_BY_POLICY, message=Source 'synthetic' is disabled by server content policy` |

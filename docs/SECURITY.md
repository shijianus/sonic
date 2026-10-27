# Sonic Security Model & Deployment Boundaries

This document describes the security properties implemented in this repository. It is
not a claim of absolute production safety.

## 1. API keys (HMAC-SHA256 v1)

- Format: `sonic_live_v1.<payloadB64url>.<sigB64url>`.
- Signed payload: `{ "v": 1, "sub": "...", "email": "...", "iat": <unix-sec>, "exp": <unix-sec> }`.
- `sub` comes from the OAuth userinfo response (`sub`, then `id`, then verified email).
  It is used as `user.id`; it is never derived from a token or Base64 prefix.
- Signature: full HMAC-SHA256 over `v1.<payloadB64url>`, verified with
  `crypto.subtle.verify` (constant-time). The signature must decode to 32 bytes.
- `SONIC_SECRET` is required and must be at least 32 characters. Missing or short
  secrets fail closed (authentication rejected; key issuance returns an error).
- There is no default signing secret, no `Math.random` fallback, and no legacy
  Base64-email key path. Legacy `sonic_live_<b64email>_<sig>` and `solara_live_*`
  keys are rejected. `SOLARA_SECRET` is no longer read.
- Verification is stateless: no process-local verification cache. Removing a secret
  or letting a key expire takes effect immediately.
- Rotation: set `SONIC_SECRET_PREV` to the previous (>=32 character) secret. Keys
  signed by either secret verify during the transition. Remove `SONIC_SECRET_PREV`
  to retire old keys. There is no online revocation list; short key lifetimes and
  secret rotation are the revocation mechanisms.
- Validation limits: token <= 4096 characters, payload Base64URL <= 2048 characters,
  signature exactly 43 Base64URL characters (32 bytes), TTL <= 90 days, clock skew
  <= 300 seconds, `sub` <= 128 characters.
- Query-string keys are disabled by default (`SONIC_ALLOW_QUERY_KEY=0`). When
  enabled, `?api_key=` / `?key=` are accepted, but they leak through logs, browser
  history and Referer headers.

## 2. OAuth (Epomail)

- Login generates a 256-bit random `state` and a 256-bit PKCE verifier; only the
  S256 challenge is sent to the provider.
- `state` and verifier are stored in `HttpOnly; Secure; SameSite=Lax;
  Path=/api/auth; Max-Age=600` cookies. The callback requires a constant-time
  matching state, consumes the cookies (including on error paths), and rejects
  missing/expired/mismatched state.
- The callback requires the PKCE verifier; it never silently falls back to a
  non-PKCE exchange.
- `redirect_uri` is a fixed `EPOMAIL_REDIRECT_URI`, or an exact
  `SONIC_ALLOWED_ORIGINS` origin match. Only HTTPS origins are accepted; fixed
  redirect URIs must also belong to the configured allowlist when one is present.
- The post-login redirect uses the configured redirect origin, not the request Host.
- Provider support for PKCE and the exact Epomail userinfo claims are external
  acceptance items because this repository cannot verify the live provider.

## 3. Outbound proxy and SSRF

- Default allowlist (exact suffixes): `music.126.net`, `vod.126.net`,
  `music.163.com`, `interface3.music.163.com`, `qqmusic.qq.com`, `y.qq.com`,
  `u.y.qq.com`, `gtimg.cn`, `qpic.cn`, `kugou.com`, `kuwo.cn`, `lrclib.net`,
  `amll.dev`, `lyriva.xyz`, `gdstudio.xyz`.
- Operators can replace the list with `SONIC_ALLOWED_MUSIC_DOMAINS`. Domain
  matching is on label boundaries (`host === domain` or `host.endsWith("." + domain)`),
  never `includes`. An explicitly configured invalid list fails closed.
- URLs must be HTTPS (no `http`), use port 443 (or no explicit port), contain no
  userinfo, and resolve to an allowed host. IPv4/IPv6 canonical checks block
  loopback, RFC1918, CGNAT, link-local, ULA, multicast, reserved/documentation,
  IPv4-mapped IPv6, IPv4-compatible IPv6, NAT64, 6to4 and Teredo forms.
- Redirects are manual, limited (`SONIC_PROXY_MAX_REDIRECTS`, default 3, max 5),
  revalidated on every hop, and HTTPS-to-HTTP downgrade is forbidden.
- Cookie, Authorization, proxy-authorization and internal Sonic headers are
  stripped before outbound requests.
- `/api/sonic/forward?url=` is an arbitrary asset forwarder and is disabled by
  default (`SONIC_ENABLE_ASSET_FORWARD=0`). When enabled it still enforces the
  allowlist, MIME class and byte limits.
- **DNS pinning:** Cloudflare Pages cannot control the connected IP after DNS
  resolution. This project does not claim DNS pinning on Cloudflare; it relies on
  the fixed hostname allowlist and platform network isolation. The Node engine is
  not a general-purpose outbound fetcher and is reachable only through the tunnel
  and the internal engine key. If a future Node path performs DNS validation, it
  must connect to the validated address while preserving Host, TLS SNI and
  certificate verification.
- Limits are configurable: `SONIC_PROXY_TIMEOUT_MS`,
  `SONIC_PROXY_MAX_REDIRECTS`, `SONIC_PROXY_MAX_CONCURRENCY`,
  `SONIC_COVER_MAX_BYTES`, `SONIC_AUDIO_MAX_BYTES`,
  `SONIC_FORWARD_MAX_BYTES`, `SONIC_PALETTE_MAX_BYTES`. Audio and lyrics remain
  streamed with a hard actual-byte cap (lyrics retain Range/206 where applicable);
  covers and palettes are buffered with a hard actual-byte limit (not only
  Content-Length). The concurrency cap is per process/isolate and fails fast when
  the outbound fetch slots are exhausted.

## 4. Proxy response policy

- Upstream response headers are not copied wholesale. Only
  `content-type`, `content-range`, `accept-ranges`, `etag`, `last-modified` and a
  safe `content-length` are forwarded. `Set-Cookie` and other headers are dropped.
- Resource classes are enforced: images must be raster (`image/jpeg`, `png`,
  `webp`, `gif`, `avif`, `bmp`, `apng`); audio must be `audio/*` or an allowed
  opaque/playlist type; lyrics must be `text/plain` or `application/ttml+xml`;
  JSON must be JSON. HTML, XHTML, JavaScript, ECMAScript and SVG are rejected.
- Proxied responses set `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: cross-origin`.
- HEAD returns headers without an upstream body. Range/206 and Content-Range are
  preserved for audio and forwarded assets.
- The built-in SVG cover fallback is generated locally and served with the same
  nosniff/CSP headers; upstream SVG is never proxied.

## 5. Client IP and rate limiting

- Cloudflare: the public client identity is `CF-Connecting-IP` only.
  `X-Sonic-Client-IP` from clients is ignored.
- Engine calls: `X-Sonic-Client-IP` is trusted only when the request carries a
  valid `X-Sonic-Engine-Key`; the edge overwrites it for forwarded calls. The Node
  engine also records the socket peer address for public-tier bucketing.
- In-memory buckets are per process and hard-capped at 4096 entries with expired
  and oldest-entry eviction.
- Optional Cloudflare KV counting is best-effort: read-modify-write is not atomic.
  The response reports `X-RateLimit-Scope: kv` but this is not a strict global
  quota. Use a Durable Object or WAF if a strict global limit is required.
- The anonymous limit is never bypassed by changing IP-like headers; the
  authenticated limit is keyed on the stable `user.id` from the signed `sub`.

## 6. Node engine authentication and network boundary

- Every `/api/*` business route, plus `/proxy` and `/palette`, is rejected unless
  `X-Sonic-Engine-Key` matches a configured `SONIC_ENGINE_SECRET` of at least 32
  characters. The check runs before business logic and does not depend on the Host
  header. Missing/short secrets return 503; wrong/missing keys return 401.
- Static frontend assets remain public.
- `docker-compose.yml` publishes the engine only on `127.0.0.1`. Do not change that
  binding to a public interface; Cloudflare Tunnel is the intended ingress.
- The Docker health check uses the authenticated health endpoint.

## 7. Remaining external acceptance items

- Verify the live Epomail provider actually enforces/echoes PKCE S256 and returns
  the expected `sub`/`email` claims.
- Verify production CDN hosts are covered by the configured allowlist; a new CDN
  hostname requires an explicit configuration change.
- Verify Cloudflare's network isolation and WAF/rate-limit behavior at the edge.
- Rotate any secret that was previously exposed or defaulted. This repository no
  longer contains default signing or OAuth client secrets, but old deployments may
  still have them configured.

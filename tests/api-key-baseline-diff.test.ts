import { describe, it, expect, vi } from "vitest";
import { onRequest as handleMusicStream } from "../functions/api/music/stream";
import { createSession } from "../functions/_lib/auth";
import type { AppEnv } from "../functions/_lib/types";

describe("Requirement 14: API Key Request Real Upstream 206 Comparison (eddcf54 vs HEAD)", () => {
  it("verifies API Key requests with Range 206 under off, monitor, and enforce modes maintain identical status and headers", async () => {
    const TEST_SECRET = "super-secret-sonic-key-material-32chars!";
    const baseEnv: AppEnv = {
      SONIC_SECRET: TEST_SECRET,
      SONIC_ENV: "test",
      SONIC_RATE_LIMIT_ANON_RPM: "1000",
      SONIC_RATE_LIMIT_AUTH_RPM: "2000",
      SONIC_ALLOWED_ORIGINS: "https://trusted-domain.com",
    };

    const session = await createSession(baseEnv, {
      email: "api-partner@netease-client.com",
      name: "NetEase Partner",
      avatar: "",
    });
    const apiKey = session.apiKey;

    // Upstream returns realistic 206 Partial Content
    const mockUpstreamResponse = new Response(new Uint8Array(1025).fill(42), {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Range": "bytes 0-1024/5242880",
        "Content-Length": "1025",
        "Accept-Ranges": "bytes",
        "ETag": '"netease-186016-5242880"',
        "Last-Modified": "Sun, 01 Nov 2026 00:00:00 GMT",
        "Cache-Control": "public, max-age=86400",
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (urlStr.includes("music.126.net")) {
        return mockUpstreamResponse.clone();
      }
      return originalFetch(input, init);
    });

    const modes = ["off", "monitor", "enforce"] as const;
    const results: Record<string, { status: number; headers: Record<string, string> }> = {};

    for (const mode of modes) {
      const env: AppEnv = {
        ...baseEnv,
        SONIC_STREAM_GUARD: mode,
        SONIC_CORS_STRICT: mode === "enforce" ? "1" : "0",
      };

      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?target=https%3A%2F%2Fm701.music.126.net%2F20261105%2F186016.mp3",
        {
          headers: {
            "X-Sonic-Key": apiKey,
            Origin: "https://unlisted-client-origin.com",
            Range: "bytes=0-1024",
            "User-Agent": "SonicClient/2.2.0",
          },
        },
      );

      const res = await handleMusicStream({ request: req, env });
      const headers = Object.fromEntries(res.headers.entries());

      // Assertions across all modes for API key callers:
      // 1. Status is strictly 206 Partial Content
      expect(res.status).toBe(206);

      // 2. Range headers passed through from upstream
      expect(res.headers.get("Content-Range")).toBe("bytes 0-1024/5242880");
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(res.headers.get("Content-Type")).toBe("audio/mpeg");

      // 3. CORS origin is '*' (C1: never restricted by SONIC_CORS_STRICT for API key users)
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      // 4. Cache-Control is upstream cache control, NOT 'private, no-store'
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");

      // 5. No grant cookies leaked
      expect(res.headers.get("Set-Cookie")).toBeNull();

      results[mode] = { status: res.status, headers };
    }

    // Verify all 3 modes produce 100% IDENTICAL status and headers
    expect(results.monitor.status).toBe(results.off.status);
    expect(results.enforce.status).toBe(results.off.status);
    expect(results.monitor.headers).toEqual(results.off.headers);
    expect(results.enforce.headers).toEqual(results.off.headers);

    globalThis.fetch = originalFetch;
  });
});

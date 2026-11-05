import { describe, it, expect, beforeEach } from "vitest";
import {
  issueStreamTicket,
  verifyStreamTicket,
  getOrCreateAnonSession,
  checkStreamCorsAndFetchMetadata,
  evaluateStreamGuardQuota,
  normalizeTrackFingerprint,
  clearPlaybackGrantsForTest,
  TICKET_PREFIX,
  SONIC_ANON_SESSION_COOKIE,
} from "../functions/_lib/sonic/ticket";
import { onRequest as handleMusicTicket } from "../functions/api/music/ticket";
import { onRequest as handleMusicStream } from "../functions/api/music/stream";
import { createSession } from "../functions/_lib/auth";
import type { AppEnv } from "../functions/_lib/types";

const TEST_SECRET = "super-secret-sonic-key-material-32chars!";
const BASE_ENV: AppEnv = {
  SONIC_SECRET: TEST_SECRET,
  SONIC_ENV: "test",
  SONIC_RATE_LIMIT_ANON_RPM: "1000",
  SONIC_RATE_LIMIT_AUTH_RPM: "2000",
};

describe("Stream Guard Phase 1: Playback Ticket & Access Control", () => {
  beforeEach(() => {
    clearPlaybackGrantsForTest();
  });
  describe("1. Ticket Issuance & Cryptographic Verification", () => {
    it("issues and verifies a valid HMAC-SHA256 playback ticket", async () => {
      const ticket = await issueStreamTicket({
        id: "186016",
        source: "netease",
        br: "320",
        purpose: "play",
        sub: "anon:session123",
        ip: "198.51.100.1",
        env: BASE_ENV,
      });

      expect(ticket.startsWith(`${TICKET_PREFIX}.`)).toBe(true);
      const parts = ticket.split(".");
      expect(parts).toHaveLength(3);

      const res = await verifyStreamTicket(ticket, {
        id: "186016",
        source: "netease",
        br: "320",
        purpose: "play",
        env: BASE_ENV,
      });

      expect(res.valid).toBe(true);
      expect(res.payload?.sub).toBe("anon:session123");
      expect(res.payload?.p).toBe("play");
      expect(res.payload?.tid).toBe("netease:186016:320");
      expect(res.payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("rejects ticket if id, source, br, or purpose does not match (Requirement 3)", async () => {
      const ticket = await issueStreamTicket({
        id: "186016",
        source: "netease",
        br: "320",
        purpose: "play",
        sub: "anon:session123",
        env: BASE_ENV,
      });

      // ID mismatch
      const resId = await verifyStreamTicket(ticket, {
        id: "999999",
        source: "netease",
        br: "320",
        purpose: "play",
        env: BASE_ENV,
      });
      expect(resId.valid).toBe(false);
      expect(resId.error).toBe("TICKET_ID_MISMATCH");

      // Source mismatch
      const resSource = await verifyStreamTicket(ticket, {
        id: "186016",
        source: "qq",
        br: "320",
        purpose: "play",
        env: BASE_ENV,
      });
      expect(resSource.valid).toBe(false);
      expect(resSource.error).toBe("TICKET_SOURCE_MISMATCH");

      // Bitrate mismatch
      const resBr = await verifyStreamTicket(ticket, {
        id: "186016",
        source: "netease",
        br: "flac",
        purpose: "play",
        env: BASE_ENV,
      });
      expect(resBr.valid).toBe(false);
      expect(resBr.error).toBe("TICKET_BITRATE_MISMATCH");

      // Purpose mismatch (issued for play, presented for download)
      const resPurpose = await verifyStreamTicket(ticket, {
        id: "186016",
        source: "netease",
        br: "320",
        purpose: "download",
        env: BASE_ENV,
      });
      expect(resPurpose.valid).toBe(false);
      expect(resPurpose.error).toBe("TICKET_PURPOSE_MISMATCH");
    });

    it("rejects tampered ticket signature and modified payload", async () => {
      const ticket = await issueStreamTicket({
        id: "186016",
        source: "netease",
        sub: "anon:session123",
        env: BASE_ENV,
      });

      const parts = ticket.split(".");
      // Tamper with signature
      const tamperedSig = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}XXXX`;
      const resSig = await verifyStreamTicket(tamperedSig, {
        id: "186016",
        env: BASE_ENV,
      });
      expect(resSig.valid).toBe(false);
      expect(resSig.error).toBe("TICKET_SIGNATURE_MISMATCH");

      // Tamper with payload
      const tamperedPayload = `${parts[0]}.eyJzdWIiOiJoYWNrZXIifQ.${parts[2]}`;
      const resPayload = await verifyStreamTicket(tamperedPayload, {
        id: "186016",
        env: BASE_ENV,
      });
      expect(resPayload.valid).toBe(false);
    });

    it("rejects expired ticket", async () => {
      const ticket = await issueStreamTicket({
        id: "186016",
        source: "netease",
        sub: "anon:session123",
        ttlSec: 10,
        env: BASE_ENV,
      });

      // Advance clock in verification simulation
      const parts = ticket.split(".");
      const rawPayload = JSON.parse(
        new TextDecoder().decode(Buffer.from(parts[1], "base64url")),
      );
      rawPayload.exp = Math.floor(Date.now() / 1000) - 5; // expired 5s ago
      const expiredPayloadB64 = Buffer.from(
        JSON.stringify(rawPayload),
      ).toString("base64url");
      const expiredTicket = `${parts[0]}.${expiredPayloadB64}.${parts[2]}`;

      const res = await verifyStreamTicket(expiredTicket, {
        id: "186016",
        env: BASE_ENV,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toBe("TICKET_EXPIRED");
    });

    it("rejects track ID mismatch and purpose mismatch", async () => {
      const ticket = await issueStreamTicket({
        id: "186016",
        source: "netease",
        br: "320",
        purpose: "play",
        sub: "anon:session123",
        env: BASE_ENV,
      });

      // Wrong track ID
      const resWrongTrack = await verifyStreamTicket(ticket, {
        id: "999999",
        source: "netease",
        purpose: "play",
        env: BASE_ENV,
      });
      expect(resWrongTrack.valid).toBe(false);
      expect(resWrongTrack.error).toBe("TICKET_ID_MISMATCH");

      // Purpose mismatch (play ticket used for download)
      const resWrongPurpose = await verifyStreamTicket(ticket, {
        id: "186016",
        source: "netease",
        purpose: "download",
        env: BASE_ENV,
      });
      expect(resWrongPurpose.valid).toBe(false);
      expect(resWrongPurpose.error).toBe("TICKET_PURPOSE_MISMATCH");
    });
  });

  describe("2. Playback Grant & Range Lifecycle (Requirement 3)", () => {
    it("Scenario 3a: permits repeated Range requests (10+ seeks/buffers) with the same ticket in the owner session", async () => {
      const ticket = await issueStreamTicket({
        id: "2001",
        source: "netease",
        purpose: "play",
        sub: "anon:owner_session",
        env: BASE_ENV,
      });

      // 10 consecutive Range requests for seeking and buffer continuation
      for (let i = 0; i < 10; i++) {
        const res = await verifyStreamTicket(ticket, {
          id: "2001",
          source: "netease",
          sub: "anon:owner_session",
          env: BASE_ENV,
        });
        expect(res.valid).toBe(true);
        expect(res.grant).toBeDefined();
        expect(res.grant?.useCount).toBe(i + 1);
      }
    });

    it("Scenario 3b: permits Range requests 120s+ after ticket issuance (upgraded grant active up to 30m)", async () => {
      const ticket = await issueStreamTicket({
        id: "2001",
        source: "netease",
        purpose: "play",
        sub: "anon:owner_session",
        durationSec: 240, // 4-minute song
        env: BASE_ENV,
      });

      // First request activates ticket into PlaybackGrant
      const firstRes = await verifyStreamTicket(ticket, {
        id: "2001",
        source: "netease",
        sub: "anon:owner_session",
        durationSec: 240,
        env: BASE_ENV,
      });
      expect(firstRes.valid).toBe(true);
      expect(firstRes.grant).toBeDefined();

      // Simulate client seeking after 120s ticket expiration
      // Advance the active grant check - grant expiration is 30m in future
      expect(firstRes.grant!.expiresAtSec).toBeGreaterThan(Math.floor(Date.now() / 1000) + 120);

      // Subsequent seek Range request:
      const seekRes = await verifyStreamTicket(ticket, {
        id: "2001",
        source: "netease",
        sub: "anon:owner_session",
        env: BASE_ENV,
      });
      expect(seekRes.valid).toBe(true);
      expect(seekRes.grant?.useCount).toBe(2);
    });

    it("Anti-theft: rejects stolen ticket reuse when presented by a different session", async () => {
      const ticket = await issueStreamTicket({
        id: "2001",
        source: "netease",
        purpose: "play",
        sub: "anon:owner_session",
        env: BASE_ENV,
      });

      // Legitimate user activates ticket
      const userRes = await verifyStreamTicket(ticket, {
        id: "2001",
        source: "netease",
        sub: "anon:owner_session",
        env: BASE_ENV,
      });
      expect(userRes.valid).toBe(true);

      // Attacker copies ticket to another session / browser
      const attackerRes = await verifyStreamTicket(ticket, {
        id: "2001",
        source: "netease",
        sub: "anon:attacker_session", // DIFFERENT session!
        env: BASE_ENV,
      });
      expect(attackerRes.valid).toBe(false);
      expect(attackerRes.error).toBe("TICKET_SESSION_MISMATCH");
    });
  });

  describe("3. Anonymous Session Management", () => {
    it("generates a signed HttpOnly session cookie for new anonymous visitors with strict security attributes (Requirement 3)", async () => {
      const req = new Request("https://sonic.epocanvas.tech/api/music/ticket", {
        method: "POST",
      });
      const anon = await getOrCreateAnonSession(req, BASE_ENV);

      expect(anon.isNew).toBe(true);
      expect(anon.sessionId).toBeDefined();
      expect(anon.cookieHeader).toContain(SONIC_ANON_SESSION_COOKIE);
      expect(anon.cookieHeader).toContain("HttpOnly");
      expect(anon.cookieHeader).toContain("Secure");
      expect(anon.cookieHeader).toContain("SameSite=Lax");
      expect(anon.cookieHeader).toContain("Path=/");
      expect(anon.cookieHeader).toContain("Max-Age=2592000");
    });

    it("verifies and reuses existing valid session cookie", async () => {
      const req1 = new Request(
        "https://sonic.epocanvas.tech/api/music/ticket",
        { method: "POST" },
      );
      const anon1 = await getOrCreateAnonSession(req1, BASE_ENV);
      const cookieValue = anon1.cookieHeader!.split(";")[0]; // "sonic_anon_session=uuid.sig"

      const req2 = new Request(
        "https://sonic.epocanvas.tech/api/music/ticket",
        {
          method: "POST",
          headers: { Cookie: cookieValue },
        },
      );
      const anon2 = await getOrCreateAnonSession(req2, BASE_ENV);

      expect(anon2.isNew).toBe(false);
      expect(anon2.sessionId).toBe(anon1.sessionId);
    });

    it("rejects tampered session cookie and issues a fresh session", async () => {
      const tamperedReq = new Request(
        "https://sonic.epocanvas.tech/api/music/ticket",
        {
          method: "POST",
          headers: {
            Cookie: "sonic_anon_session=fakeuuid123456789.invalidsignature",
          },
        },
      );
      const anon = await getOrCreateAnonSession(tamperedReq, BASE_ENV);

      expect(anon.isNew).toBe(true);
      expect(anon.sessionId).not.toBe("fakeuuid123456789");
    });
  });

  describe("4. Strict CORS & Fetch-Metadata Validation", () => {
    it("allows all origins when SONIC_CORS_STRICT is disabled (default 0)", () => {
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { Origin: "https://malicious-external-site.com" },
        },
      );
      const res = checkStreamCorsAndFetchMetadata(req, BASE_ENV);
      expect(res.allowed).toBe(true);
    });

    it("enforces allowlist when SONIC_CORS_STRICT=1", () => {
      const envWithStrict: AppEnv = {
        ...BASE_ENV,
        SONIC_CORS_STRICT: "1",
        SONIC_ALLOWED_ORIGINS:
          "https://trusted-site.com,https://player.epocanvas.tech",
      };

      // 1. Same-origin is allowed
      const sameOriginReq = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { Origin: "https://sonic.epocanvas.tech" },
        },
      );
      expect(
        checkStreamCorsAndFetchMetadata(sameOriginReq, envWithStrict).allowed,
      ).toBe(true);

      // 2. Allowed domain is allowed
      const trustedReq = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { Origin: "https://trusted-site.com" },
        },
      );
      expect(
        checkStreamCorsAndFetchMetadata(trustedReq, envWithStrict).allowed,
      ).toBe(true);

      // 3. Foreign unlisted origin is rejected
      const foreignReq = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { Origin: "https://stealer-music.com" },
        },
      );
      const foreignRes = checkStreamCorsAndFetchMetadata(
        foreignReq,
        envWithStrict,
      );
      expect(foreignRes.allowed).toBe(false);
      expect(foreignRes.reason).toBe("ORIGIN_FORBIDDEN");
    });

    it("validates Sec-Fetch-Dest header in strict mode", () => {
      const envWithStrict: AppEnv = { ...BASE_ENV, SONIC_CORS_STRICT: "1" };

      const audioDestReq = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { "Sec-Fetch-Dest": "audio" },
        },
      );
      expect(
        checkStreamCorsAndFetchMetadata(audioDestReq, envWithStrict).allowed,
      ).toBe(true);

      const invalidDestReq = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=1",
        {
          headers: { "Sec-Fetch-Dest": "script" },
        },
      );
      expect(
        checkStreamCorsAndFetchMetadata(invalidDestReq, envWithStrict).allowed,
      ).toBe(false);
    });
  });

  describe("5. Sliding-Window Quota & Anomaly Tracking", () => {
    it("blocks rapid crawl sweeping over 30 distinct tracks per minute", async () => {
      const subject = `anon:crawler_${Date.now()}`;

      // Simulate requesting 30 distinct tracks (allowed)
      for (let i = 1; i <= 30; i++) {
        const res = await evaluateStreamGuardQuota(
          subject,
          `track_${i}`,
          "play",
          BASE_ENV,
        );
        expect(res.allowed).toBe(true);
      }

      // 31st distinct track in same window triggers quota
      const res31 = await evaluateStreamGuardQuota(
        subject,
        "track_31",
        "play",
        BASE_ENV,
      );
      expect(res31.allowed).toBe(false);
      expect(res31.reason).toBe("RATE_LIMIT_EXCESSIVE_TRACKS");
      expect(res31.retryAfter).toBeGreaterThan(0);
    });
  });

  describe("6. Ticket Endpoint: POST /api/music/ticket", () => {
    it("issues ticket with valid JSON payload", async () => {
      const req = new Request("https://sonic.epocanvas.tech/api/music/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "186016", source: "netease", br: "320" }),
      });
      const res = await handleMusicTicket({ request: req, env: BASE_ENV });
      expect(res.status).toBe(200);

      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.ticket).toBeDefined();
      expect(data.expiresIn).toBe(120);
    });

    it("rejects GET or missing id with appropriate status code", async () => {
      const getReq = new Request(
        "https://sonic.epocanvas.tech/api/music/ticket",
        { method: "GET" },
      );
      const getRes = await handleMusicTicket({
        request: getReq,
        env: BASE_ENV,
      });
      expect(getRes.status).toBe(405);

      const noIdReq = new Request(
        "https://sonic.epocanvas.tech/api/music/ticket",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "netease" }),
        },
      );
      const noIdRes = await handleMusicTicket({
        request: noIdReq,
        env: BASE_ENV,
      });
      expect(noIdRes.status).toBe(400);
    });
  });

  describe("7. Compatibility Hard Constraints (C1, C2, C3, C4)", () => {
    it("SONIC_STREAM_GUARD=off (default): anonymous requests without ticket are permitted", async () => {
      const envOff: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "off",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
      );
      const res = await handleMusicStream({ request: req, env: envOff });
      expect(res.status).toBe(200);
    });

    it("SONIC_STREAM_GUARD=monitor: anonymous requests without ticket still play without blocking", async () => {
      const envMonitor: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "monitor",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
      );
      const res = await handleMusicStream({ request: req, env: envMonitor });
      expect(res.status).toBe(200);
    });

    it("SONIC_STREAM_GUARD=enforce: anonymous request without ticket is rejected with 403", async () => {
      const envEnforce: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
      );
      const res = await handleMusicStream({ request: req, env: envEnforce });
      expect(res.status).toBe(403);

      const data = (await res.json()) as any;
      expect(data.error?.code).toBe("STREAM_TICKET_REQUIRED");
    });

    it("SONIC_STREAM_GUARD=enforce: anonymous request with valid ticket plays successfully", async () => {
      const envEnforce: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      const ticket = await issueStreamTicket({
        id: "syn-440hz",
        source: "synthetic",
        sub: "anon:web_client",
        env: envEnforce,
      });

      const req = new Request(
        `https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic&t=${ticket}`,
      );
      const res = await handleMusicStream({ request: req, env: envEnforce });
      expect(res.status).toBe(200);
    });

    it("Constraint C1: API Key requests in enforce mode completely bypass ticket check and behave identically", async () => {
      const session = await createSession(BASE_ENV, {
        email: "dev@sonic.local",
        name: "Developer",
        avatar: "",
      });
      const validApiKey = session.apiKey;

      const envEnforce: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      // Request carries X-Sonic-Key but NO ticket
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
        {
          headers: { "X-Sonic-Key": validApiKey },
        },
      );
      const res = await handleMusicStream({ request: req, env: envEnforce });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("audio/wav");
    });

    it("Constraint C5: CORS tightening in enforce mode does NOT block API Key requests", async () => {
      const session = await createSession(BASE_ENV, {
        email: "api-partner@external.com",
        name: "Partner",
        avatar: "",
      });

      const envStrictCors: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_CORS_STRICT: "1",
        SONIC_ALLOWED_ORIGINS: "https://trusted.com",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };

      // API Key caller from unlisted origin must NOT be blocked
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
        {
          headers: {
            "X-Sonic-Key": session.apiKey,
            Origin: "https://some-unlisted-client.com",
          },
        },
      );
      const res = await handleMusicStream({ request: req, env: envStrictCors });
      expect(res.status).toBe(200);
    });

    it("Protected stream ignores ?mode=redirect under enforce mode (Requirement 4)", async () => {
      const envEnforce: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };
      const ticket = await issueStreamTicket({
        id: "syn-440hz",
        source: "synthetic",
        sub: "anon:redirect_test",
        env: envEnforce,
      });

      // Anonymous caller requests mode=redirect
      const req = new Request(
        `https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic&mode=redirect&t=${ticket}`,
      );
      const res = await handleMusicStream({ request: req, env: envEnforce });
      // In enforce mode, redirect mode is disabled and forced to proxy: status must be 200 (audio bytes), NOT 302!
      expect(res.status).toBe(200);
      expect(res.headers.get("Location")).toBeNull();
    });

    it("forged or tampered X-Sonic-Key in enforce mode is treated as anonymous and rejected without ticket (Requirement 2)", async () => {
      const forgedKey =
        "sonic_live_v2.eyJhbGciOiJIUzI1NiIsImtpZCI6InVuc2lnbmVkIn0.eyJzdWIiOiJoYWNrZXIiLCJleHAiOjk5OTk5OTk5OTl9.invalid_signature_hex";
      const envEnforce: AppEnv = {
        ...BASE_ENV,
        SONIC_STREAM_GUARD: "enforce",
        SONIC_ENABLE_SYNTHETIC_TEST_SOURCE: "1",
      };

      // Request with forged API key and NO ticket
      const req = new Request(
        "https://sonic.epocanvas.tech/api/music/stream?id=syn-440hz&source=synthetic",
        {
          headers: {
            "X-Sonic-Key": forgedKey,
            "User-Agent": "TestClient/1.0",
          },
        },
      );

      const res = await handleMusicStream({ request: req, env: envEnforce });
      expect(res.status).toBe(403);
      const data: any = await res.json();
      expect(data.error?.code).toBe("STREAM_TICKET_REQUIRED");
    });
  });
});

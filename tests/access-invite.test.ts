import { beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/api/access/invite';
import { resetRateLimitsForTest } from '../functions/_lib/sonic/security';

const env = {
  SONIC_ENV: 'test',
  SONIC_ACCESS_MODE: 'invite',
  SONIC_INVITE_CODES: 'VALID-CODE-123456',
  SONIC_ACCESS_SECRET: 's'.repeat(48),
  SONIC_RATE_LIMIT_ANON_RPM: '10000',
} as any;
const url = 'https://sonic.test/api/access/invite';
const headers = (ip: string) => ({
  'Content-Type': 'application/json',
  'CF-Connecting-IP': ip,
});

beforeEach(() => {
  resetRateLimitsForTest();
});

describe('invite endpoint body limits', () => {
  it('rejects a declared oversized body before parsing', async () => {
    const request = new Request(url, {
      method: 'POST',
      headers: headers('203.0.113.11'),
      body: JSON.stringify({ code: 'x'.repeat(5000) }),
    });
    const response = await onRequest({ request, env });
    expect(response.status).toBe(413);
    expect((await response.json())?.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an oversized chunked body without trusting Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'x'.repeat(5000) })));
        controller.close();
      },
    });
    const request = new Request(url, {
      method: 'POST',
      headers: headers('203.0.113.12'),
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const response = await onRequest({ request, env });
    expect(response.status).toBe(413);
    expect((await response.json())?.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects invalid JSON with a 400 instead of treating it as an invalid invite', async () => {
    const request = new Request(url, {
      method: 'POST',
      headers: headers('203.0.113.13'),
      body: '{not-json',
    });
    const response = await onRequest({ request, env });
    expect(response.status).toBe(400);
    expect((await response.json())?.error?.code).toBe('INVALID_PAYLOAD');
  });

  it('redeems a valid invite and sets the HttpOnly access cookie', async () => {
    const request = new Request(url, {
      method: 'POST',
      headers: headers('203.0.113.14'),
      body: JSON.stringify({ code: 'VALID-CODE-123456' }),
    });
    const response = await onRequest({ request, env });
    expect(response.status).toBe(200);
    // Secure origins write the __Host- prefixed cookie (audit P1-6).
    expect(response.headers.get('set-cookie')).toContain('__Host-sonic_access=');
  });

  it('rejects configured invite codes shorter than 16 characters', async () => {
    const shortCodeEnv = { ...env, SONIC_INVITE_CODES: 'SHORT-CODE' };
    const request = new Request(url, {
      method: 'POST',
      headers: headers('203.0.113.15'),
      body: JSON.stringify({ code: 'SHORT-CODE' }),
    });
    const response = await onRequest({ request, env: shortCodeEnv });
    expect(response.status).toBe(401);
    expect((await response.json())?.error?.code).toBe('INVITE_INVALID');
  });

  it('does not truncate an oversized invite into a valid code', async () => {
    const code = 'x'.repeat(256);
    const request = new Request(url, { method: 'POST', headers: headers('203.0.113.16'), body: JSON.stringify({ code: code + 'x' }) });
    const response = await onRequest({ request, env: { ...env, SONIC_INVITE_CODES: code } });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

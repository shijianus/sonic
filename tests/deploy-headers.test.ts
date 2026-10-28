import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Deployed security headers', () => {
  it('ships anti-sniffing, anti-framing and permissions policy headers', () => {
    const headers = readFileSync(new URL('../player/public/_headers', import.meta.url), 'utf8');
    expect(headers).toMatch(/X-Content-Type-Options:\s*nosniff/i);
    expect(headers).toMatch(/X-Frame-Options:\s*DENY/i);
    expect(headers).toMatch(/Content-Security-Policy:\s*frame-ancestors 'none'/i);
    expect(headers).toMatch(/Permissions-Policy:/i);
  });
});

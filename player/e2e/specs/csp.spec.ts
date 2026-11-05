import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const headersFile = readFileSync(join(root, 'public/_headers'), 'utf8');
const csp = /Content-Security-Policy:\s*(.+)/i.exec(headersFile)?.[1]?.trim();

test('the deployed CSP allows the built app without violations', async ({ page }) => {
  expect(csp).toBeTruthy();
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).toMatch(/object-src 'none'/);
  expect(csp).toMatch(/base-uri 'self'/);

  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy|refused to|violates/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (/content security policy|refused to|violates/i.test(error.message)) violations.push(error.message);
  });

  // The mock server does not apply Cloudflare Pages `_headers`; inject the exact
  // shipped CSP onto the document response so the browser enforces the
  // production policy. Static assets inherit the document CSP.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': csp! },
    });
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForTimeout(1500);
    expect((await page.locator('body').innerText()).length).toBeGreaterThan(10);
    expect(await page.locator('script:not([src])').count()).toBe(0);
    expect(await page.evaluate(() =>
      performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/bootstrap.js'))
    )).toBe(true);
  }

  expect(violations).toEqual([]);
});

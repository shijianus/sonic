import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/_middleware';
import { RELEASE_DIRECTORIES, REQUIRED_RELEASE_FILES } from '../scripts/release-inputs.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Release artifact identity and Edge gate', () => {
  it('changes the source digest when implementation changes but not when private env or build output changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'sonic-manifest-test-'));
    directories.push(root);
    for (const name of RELEASE_DIRECTORIES) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'fixture.ts'), 'export {};\n');
    }
    for (const name of REQUIRED_RELEASE_FILES) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), 'fixture\n');
    }
    mkdirSync(join(root, 'player', 'dist'), { recursive: true });
    for (const name of ['write-release-manifest.mjs', 'release-inputs.mjs']) {
      cpSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(root, 'scripts', name));
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'functions', 'example.ts'), 'export const value = 1;\n');
    const env = { ...process.env, SONIC_RELEASE_COMMIT: 'a'.repeat(40), SONIC_RELEASE_DIRTY: '1', SONIC_SOURCE_DIGEST: '', SONIC_RELEASE_ID: '', SONIC_BUILD_TIME: '' };
    const run = () => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/write-release-manifest.mjs')], { cwd: root, env, encoding: 'utf8' }));
    const initial = run();
    writeFileSync(join(root, 'functions', '.env.private'), 'PRIVATE_TEST_VALUE=not-public\n');
    writeFileSync(join(root, 'player', 'dist', 'index.html'), '<main>generated</main>');
    const unchanged = run();
    expect(unchanged).toEqual(initial);
    expect(JSON.stringify(unchanged)).not.toContain('not-public');
    writeFileSync(join(root, 'functions', 'example.ts'), 'export const value = 2;\n');
    const changed = run();
    expect(changed.sourceDigest).not.toBe(initial.sourceDigest);
    expect(changed.releaseId).not.toBe(initial.releaseId);
    expect(changed.dirty).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'player/dist/release.json'), 'utf8'))).toEqual(changed);
  });

  it('rejects production without release identity before invoking a handler', async () => {
    let dispatched = false;
    const response = await onRequest({
      request: new Request('https://sonic.example/api/sonic/search/smart?q=test'),
      env: { SONIC_ENV: 'production' },
      next: async () => { dispatched = true; return new Response('unexpected'); },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(dispatched).toBe(false);
  });

  it('reports the exact dirty release identity instead of presenting the base commit as the fixed version', async () => {
    const releaseId = 'a75f5cb54a2f-123456abcdef';
    const response = await onRequest({
      request: new Request('https://sonic.example/api'),
      env: {
        SONIC_ENV: 'staging',
        SONIC_REQUIRE_RELEASE_METADATA: '1',
        SONIC_ACCESS_MODE: 'open',
        SONIC_CONTENT_POLICY: 'strict-allowlist',
        SONIC_RELEASE_COMMIT: 'a'.repeat(40),
        SONIC_RELEASE_ID: releaseId,
        SONIC_RELEASE_DIRTY: '1',
        SONIC_SOURCE_DIGEST: 'b'.repeat(64),
        SONIC_BUILD_TIME: '2026-11-02T00:00:00.000Z',
      },
      next: async () => new Response('ok'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-sonic-release')).toBe(releaseId);
  });

  it('marks invite-gated responses noindex without a staging token', async () => {
    const response = await onRequest({
      request: new Request('https://sonic.example/'),
      env: {
        SONIC_ENV: 'staging',
        SONIC_REQUIRE_RELEASE_METADATA: '1',
        SONIC_ACCESS_MODE: 'invite',
        SONIC_CONTENT_POLICY: 'strict-allowlist',
        SONIC_RELEASE_COMMIT: 'a'.repeat(40),
        SONIC_RELEASE_ID: 'a75f5cb54a2f-123456abcdef',
        SONIC_RELEASE_DIRTY: '1',
        SONIC_SOURCE_DIGEST: 'b'.repeat(64),
        SONIC_BUILD_TIME: '2026-11-02T00:00:00.000Z',
      },
      next: async () => new Response('ok'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });
});

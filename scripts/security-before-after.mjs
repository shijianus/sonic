// Same-input before/after evidence for the security remediation.
// Baseline: origin/main worktree. Fixed: this integration worktree.
// Run: pnpm exec jiti scripts/security-before-after.mjs

import { createJiti } from 'jiti';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fixedRoot = process.cwd();
const baselineRoot = process.env.SONIC_BASELINE_ROOT;
if (!baselineRoot) {
  console.error('Set SONIC_BASELINE_ROOT to an origin/main worktree, e.g. D:/sonic-security-worktrees/baseline-main');
  process.exit(2);
}
const jiti = createJiti(import.meta.url);

async function load(root, relative) {
  return jiti.import(join(root, relative));
}

const [bAuth, fAuth, bSec, fSec, bLogin, fLogin, bCallback, fCallback, bForward, fForward, bCover, fCover, bStream, fStream, bServer, fServer] = await Promise.all([
  load(baselineRoot, 'functions/_lib/auth.ts'),
  load(fixedRoot, 'functions/_lib/auth.ts'),
  load(baselineRoot, 'functions/_lib/sonic/security.ts'),
  load(fixedRoot, 'functions/_lib/sonic/security.ts'),
  load(baselineRoot, 'functions/api/auth/login.ts'),
  load(fixedRoot, 'functions/api/auth/login.ts'),
  load(baselineRoot, 'functions/api/auth/callback.ts'),
  load(fixedRoot, 'functions/api/auth/callback.ts'),
  load(baselineRoot, 'functions/api/sonic/forward.ts'),
  load(fixedRoot, 'functions/api/sonic/forward.ts'),
  load(baselineRoot, 'functions/api/music/cover.ts'),
  load(fixedRoot, 'functions/api/music/cover.ts'),
  load(baselineRoot, 'functions/api/music/stream.ts'),
  load(fixedRoot, 'functions/api/music/stream.ts'),
  load(baselineRoot, 'server/index.ts'),
  load(fixedRoot, 'server/index.ts'),
]);

const results = [];
function check(name, before, after, beforeExpected, afterExpected) {
  const ok = before === beforeExpected && after === afterExpected;
  results.push({ name, before, after, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}: baseline=${before}, fixed=${after}`);
}

const SECRET = 'evidence_secret_abcdefghijklmnopqrstuvwxyz';
const ENGINE_SECRET = 'evidence_engine_secret_abcdefghijklmnopqrstuvwxyz';
const OAUTH_ENV = {
  EPOMAIL_BASE_URL: 'https://mail.example',
  EPOMAIL_CLIENT_ID: 'client-id',
  EPOMAIL_CLIENT_SECRET: 'client-secret',
  EPOMAIL_REDIRECT_URI: 'https://sonic.example/api/auth/callback',
  SONIC_SECRET: SECRET,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 1. Default signing secret / weak fallback
let beforeDefault = 'rejected';
let afterDefault = 'accepted';
try {
  await bAuth.createSession({}, { email: 'alice@example.com', name: 'Alice', avatar: '' });
  beforeDefault = 'accepted';
} catch {}
try {
  await fAuth.createSession({}, { sub: 'u1', email: 'alice@example.com', name: 'Alice', avatar: '' });
} catch {
  afterDefault = 'rejected';
}
check('missing SONIC_SECRET fails closed', beforeDefault, afterDefault, 'accepted', 'rejected');

// 2. Legacy Base64-email key
const legacyKey = `sonic_live_${btoa('victim@example.com').replace(/=/g, '')}_deadbeef`;
const legacyReq = new Request('https://sonic.example/api/test', { headers: { 'X-Sonic-Key': legacyKey } });
const beforeLegacy = (await bAuth.verifyAuth(legacyReq, { SONIC_SECRET: SECRET })).authenticated;
const afterLegacy = (await fAuth.verifyAuth(legacyReq, { SONIC_SECRET: SECRET })).authenticated;
check('legacy base64-email key rejected', beforeLegacy, afterLegacy, true, false);

// 3. OAuth login state
const loginRequest = new Request('https://sonic.example/api/auth/login');
const beforeLogin = await bLogin.onRequest({ request: loginRequest, env: OAUTH_ENV });
const afterLogin = await fLogin.onRequest({ request: loginRequest, env: OAUTH_ENV });
const beforeLocation = new URL(beforeLogin.headers.get('Location'));
const afterLocation = new URL(afterLogin.headers.get('Location'));
const beforeState = beforeLocation.searchParams.get('state') || '';
const afterState = afterLocation.searchParams.get('state') || '';
check(
  'OAuth login uses unpredictable state',
  beforeState,
  `${afterState.length} chars, challenge=${Boolean(afterLocation.searchParams.get('code_challenge'))}`,
  'sonic_login',
  '43 chars, challenge=true',
);

// 4. OAuth callback without state/cookie (CSRF)
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/oauth/token')) return json({ access_token: 'token' });
  if (url.endsWith('/oauth/userinfo')) return json({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
  return json({});
};
const callbackRequest = () => new Request('https://sonic.example/api/auth/callback?code=code-1&format=json', {
  headers: { Accept: 'application/json' },
});
const beforeCallback = await bCallback.onRequest({ request: callbackRequest(), env: OAUTH_ENV });
const afterCallback = await fCallback.onRequest({ request: callbackRequest(), env: OAUTH_ENV });
globalThis.fetch = originalFetch;
check('OAuth callback rejects missing state', beforeCallback.status, afterCallback.status, 200, 400);

// 5. Client IP spoofing
const spoofReq = new Request('https://sonic.example/api/test', {
  headers: { 'CF-Connecting-IP': '198.51.100.10', 'X-Sonic-Client-IP': '1.2.3.4' },
});
const beforeIp = bSec.extractClientIp(spoofReq);
const afterIp = fSec.getPublicClientIp(spoofReq, {});
check('public caller cannot choose X-Sonic-Client-IP', beforeIp, afterIp, '1.2.3.4', '198.51.100.10');

// 6. SSRF canonical forms
const beforeMapped = bSec.isBlockedSsrfHost('::ffff:127.0.0.1');
const afterMapped = fSec.isBlockedSsrfHost('::ffff:127.0.0.1');
check('IPv4-mapped IPv6 loopback blocked', beforeMapped, afterMapped, false, true);
const beforeDecimal = bSec.isBlockedSsrfHost('2130706433');
const afterDecimal = fSec.isBlockedSsrfHost('2130706433');
check('decimal IPv4 loopback blocked', beforeDecimal, afterDecimal, false, true);

// 7. Arbitrary forward host + response header copy
const stubAudio = async () => new Response(new Uint8Array([1, 2, 3]), {
  status: 200,
  headers: { 'content-type': 'audio/mpeg', 'content-length': '3', 'set-cookie': 'evil=1; Path=/' },
});
globalThis.fetch = stubAudio;
const beforeArbitrary = await bForward.onRequest({
  request: new Request('https://sonic.example/api/sonic/forward?type=audio&url=https%3A%2F%2Fevil.example%2Fa.mp3'),
  env: {},
  waitUntil: () => {},
});
const afterArbitrary = await fForward.onRequest({
  request: new Request('https://sonic.example/api/sonic/forward?type=audio&url=https%3A%2F%2Fevil.example%2Fa.mp3'),
  env: { SONIC_ENABLE_ASSET_FORWARD: '1' },
  waitUntil: () => {},
});
check('arbitrary forward host rejected', beforeArbitrary.status, afterArbitrary.status, 200, 400);

globalThis.fetch = stubAudio;
const beforeHeader = await bForward.onRequest({
  request: new Request('https://sonic.example/api/sonic/forward?type=audio&url=https%3A%2F%2Fmusic.126.net%2Fa.mp3'),
  env: {},
  waitUntil: () => {},
});
const afterHeader = await fForward.onRequest({
  request: new Request('https://sonic.example/api/sonic/forward?type=audio&url=https%3A%2F%2Fmusic.126.net%2Fa.mp3'),
  env: { SONIC_ENABLE_ASSET_FORWARD: '1' },
  waitUntil: () => {},
});
globalThis.fetch = originalFetch;
check(
  'upstream Set-Cookie stripped',
  beforeHeader.headers.get('set-cookie') ? 'present' : 'absent',
  afterHeader.headers.get('set-cookie') ? 'present' : 'absent',
  'present',
  'absent',
);

// 8. Cover SVG (executable content) and arbitrary image host
const svgBody = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>';
globalThis.fetch = async () => new Response(svgBody, {
  status: 200,
  headers: { 'content-type': 'image/svg+xml' },
});
const beforeCover = await bCover.onRequest({
  request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fevil.example%2Fa.svg'),
  env: {},
});
const afterCover = await fCover.onRequest({
  request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fevil.example%2Fa.svg'),
  env: {},
});
const afterCoverAllowedSvg = await fCover.onRequest({
  request: new Request('https://sonic.example/api/music/cover?url=https%3A%2F%2Fmusic.126.net%2Fa.svg'),
  env: {},
});
const beforeCoverBody = await beforeCover.text();
const afterCoverBody = await afterCover.text();
const afterAllowedSvgBody = await afterCoverAllowedSvg.text();
globalThis.fetch = originalFetch;
check(
  'arbitrary image host does not reach upstream',
  beforeCover.headers.get('x-sonic-cover-fallback') ? 'fallback' : 'upstream',
  afterCover.headers.get('x-sonic-cover-fallback') ? 'fallback' : 'upstream',
  'upstream',
  'fallback',
);
check(
  'upstream executable SVG not proxied',
  beforeCoverBody.includes('onload=') ? 'upstream-svg' : 'safe',
  afterAllowedSvgBody.includes('onload=') ? 'upstream-svg' : 'fallback-svg',
  'upstream-svg',
  'fallback-svg',
);

// 9. Stream HTML
globalThis.fetch = async () => new Response('<script>alert(1)</script>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
});
const beforeStream = await bStream.onRequest({
  request: new Request('https://sonic.example/api/music/stream?target=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
  env: {},
});
const afterStream = await fStream.onRequest({
  request: new Request('https://sonic.example/api/music/stream?target=https%3A%2F%2Fm701.music.126.net%2Fa.mp3'),
  env: {},
});
globalThis.fetch = originalFetch;
check('HTML stream response rejected', beforeStream.status, afterStream.status, 200, 415);

// 10. Engine route gate regardless of Host
const engineRequest = new Request('http://127.0.0.1:8080/api');
const beforeEngine = bSec.checkEngineAccess(engineRequest, { SONIC_RUNTIME: 'linux-engine', SONIC_ENGINE_SECRET: ENGINE_SECRET });
const afterEngine = fSec.requireEngineSecret(engineRequest, { SONIC_RUNTIME: 'linux-engine', SONIC_ENGINE_SECRET: ENGINE_SECRET });
check('engine business route requires key', beforeEngine ? beforeEngine.status : 'allowed', afterEngine ? afterEngine.status : 'allowed', 'allowed', 401);

// 11. Actual Node server on localhost
const previousRuntime = process.env.SONIC_RUNTIME;
const previousSecret = process.env.SONIC_ENGINE_SECRET;
process.env.SONIC_RUNTIME = 'linux-engine';
process.env.SONIC_ENGINE_SECRET = ENGINE_SECRET;
const staticDir = mkdtempSync(join(tmpdir(), 'sonic-before-after-'));
async function startServer(module) {
  const server = module.createSonicServer(staticDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const bNode = await startServer(bServer);
const fNode = await startServer(fServer);
const base = (server) => `http://127.0.0.1:${server.address().port}`;
const beforeNode = await fetch(`${base(bNode)}/api`);
const afterNode = await fetch(`${base(fNode)}/api`);
await new Promise((resolve) => bNode.close(resolve));
await new Promise((resolve) => fNode.close(resolve));
if (previousRuntime === undefined) delete process.env.SONIC_RUNTIME;
else process.env.SONIC_RUNTIME = previousRuntime;
if (previousSecret === undefined) delete process.env.SONIC_ENGINE_SECRET;
else process.env.SONIC_ENGINE_SECRET = previousSecret;
rmSync(staticDir, { recursive: true, force: true });
check('Node engine /api rejects anonymous Host=localhost', beforeNode.status, afterNode.status, 200, 401);

// 12. innerHTML sinks
const countInnerHtml = (root) => ['player/src/components/Ui/HeroCard.vue', 'player/src/components/Ui/MVCard.vue']
  .map((file) => (readFileSync(join(root, file), 'utf8').match(/innerHTML/g) || []).length)
  .reduce((a, b) => a + b, 0);
check('dynamic innerHTML sinks removed', countInnerHtml(baselineRoot), countInnerHtml(fixedRoot), 2, 0);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} evidence checks matched expectations.`);
if (failed.length > 0) process.exit(1);

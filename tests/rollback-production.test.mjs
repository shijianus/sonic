import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { execute, mergeTunnel, recover } from '../scripts/rollback-production.mjs';

const host = 'sonic.epocanvas.tech';
const engine = { hostname: 'engine-sonic.epocanvas.tech', service: 'http://engine' };
const wildcard = { path: '^/private', service: 'http_status:403' };
const fallback = { service: 'http_status:404' };
const route = service => ({ hostname: host, service });
const original = {
  tunnel: { ingress: [wildcard, engine, route('http://before'), fallback], 'warp-routing': { enabled: true } },
  dns: { name: host, type: 'CNAME', proxied: false, ttl: 300, content: 'before.invalid' },
};
const target = {
  tunnel: { ...original.tunnel, ingress: [wildcard, engine, route('http://after'), fallback] },
  dns: { ...original.dns, ttl: 1, proxied: true, content: 'after.invalid' },
};

function fixture(t, fault = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'rollback-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = join(root, 'journal.json');
  const state = structuredClone(original);
  const api = {
    async read(key) { fault('read', key, state, journal); return structuredClone(state[key]); },
    async write(key, value) {
      fault('before-write', key, state, journal);
      state[key] = structuredClone(value);
      fault('after-write', key, state, journal);
    },
  };
  return { api, root, journal, state };
}

test('route merge preserves hostless path rules, the Engine route, catchall and other settings', () => {
  const input = structuredClone(original.tunnel);
  assert.deepEqual(mergeTunnel(input, { ingress: [route('http://after'), fallback] }), target.tunnel);
  assert.deepEqual(input, original.tunnel);
  assert.deepEqual(mergeTunnel({ ingress: [wildcard, fallback] }, target.tunnel).ingress,
    [wildcard, engine, route('http://after'), fallback]);
});

test('rollback reads both final states, tolerating an ambiguous write ACK after a successful PATCH', async t => {
  const { api, journal, state } = fixture(t, (step, key, _state, path) => {
    if (step !== 'after-write') return;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path)), { original, target });
    if (key === 'dns') throw new Error('lost ACK');
  });
  await execute(api, { original, target }, journal);
  assert.deepEqual(state, target);
  assert.equal(existsSync(journal), false);
});

for (const failure of ['tunnel-readback', 'dns-patch', 'dns-readback']) {
  test(`${failure}: both original states verified and journal closed`, async t => {
    let failed = false;
    const { api, state, journal } = fixture(t, (step, key, state) => {
      if (failed) return;
      const matches = failure === 'dns-patch'
        ? step === 'before-write' && key === 'dns'
        : step === 'read' && failure === key + '-readback' && JSON.stringify(state[key]) === JSON.stringify(target[key]);
      if (matches) { failed = true; throw new Error(failure); }
    });
    await assert.rejects(execute(api, { original, target }, journal), /both original states have been verified/);
    assert.equal(failed, true);
    assert.deepEqual(state, original);
    assert.equal(existsSync(journal), false);
  });
}

test('unavailable DNS readback keeps the Tunnel and a durable journal for explicit recovery', async t => {
  let broken = true;
  const { api, state, journal } = fixture(t, (step, key, state) => {
    if (broken && step === 'read' && key === 'dns' && state.dns.content === target.dns.content)
      throw new Error('DNS disconnected');
  });
  await assert.rejects(execute(api, { original, target }, journal), /recovery unverified/);
  assert.deepEqual(state.tunnel, target.tunnel);
  const saved = JSON.parse(readFileSync(journal));
  await assert.rejects(execute(api, { original, target }, journal), { code: 'EEXIST' });
  broken = false;
  await recover(api, saved);
  assert.deepEqual(state, original);
});

test('unexpected external DNS edits block compensation without changing the Tunnel', async t => {
  const { api, state } = fixture(t);
  state.tunnel = structuredClone(target.tunnel);
  state.dns.ttl = 120;
  await assert.rejects(recover(api, { original, target }), /Unexpected dns state/);
  assert.equal(state.dns.ttl, 120);
  assert.deepEqual(state.tunnel, target.tunnel);
});

test('documented shell entry point uses read-only dry-run and preserves DNS fields in execution', t => {
  const { root } = fixture(t);
  const script = fileURLToPath(new URL('../scripts/rollback-production.sh', import.meta.url));
  const env = {
    ...process.env, CLOUDFLARE_API_TOKEN: 'fixture', SONIC_ROLLBACK_STATE_DIR: root,
    TUNNEL_BACKUP: join(root, 'tunnel.json'), DNS_BACKUP: join(root, 'dns.json'),
    NODE_OPTIONS: '--import=' + join(root, 'mock.mjs'), ROLLBACK_FIXTURE: join(root, 'state.json'),
  };
  writeFileSync(env.TUNNEL_BACKUP, JSON.stringify({ accountId: 'test', tunnelId: 'test', config: target.tunnel }));
  writeFileSync(env.DNS_BACKUP, JSON.stringify({ zoneId: 'test', records: [{ ...target.dns, id: 'test' }] }));
  writeFileSync(env.ROLLBACK_FIXTURE, JSON.stringify({ ...original, calls: [] }));
  writeFileSync(join(root, 'mock.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async (url, { method, body }) => {
      const file = process.env.ROLLBACK_FIXTURE;
      const state = JSON.parse(readFileSync(file));
      const key = url.includes('/dns_records/') ? 'dns' : 'tunnel';
      state.calls.push(method + ' ' + key);
      if (method === 'PUT') state.tunnel = JSON.parse(body).config;
      if (method === 'PATCH') state.dns = JSON.parse(body);
      writeFileSync(file, JSON.stringify(state));
      const result = key === 'dns' ? { id: 'test', ...state.dns } : { config: state.tunnel };
      return Response.json({ success: true, result });
    };
  `);
  const run = mode => spawnSync('bash', [script, mode], { env, encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).target, target);
  assert.deepEqual(JSON.parse(readFileSync(env.ROLLBACK_FIXTURE)).calls, ['GET tunnel', 'GET dns']);
  const live = run('--execute');
  assert.equal(live.status, 0, live.stderr);
  const { calls, ...state } = JSON.parse(readFileSync(env.ROLLBACK_FIXTURE));
  assert.deepEqual(state, target);
  assert.deepEqual(calls.filter(c => !c.startsWith('GET')), ['PUT tunnel', 'PATCH dns']);
  const originalPlan = { ids: { accountId: 'test', tunnelId: 'test', zoneId: 'test', recordId: 'test' }, original, target };
  writeFileSync(join(root, 'production-rollback-state.json'), JSON.stringify(originalPlan), { mode: 0o600 });
  assert.notEqual(run('--execute').status, 0);
  const recovered = run('--recover');
  assert.equal(recovered.status, 0, recovered.stderr);
  const { calls: recoveredCalls, ...recoveredState } = JSON.parse(readFileSync(env.ROLLBACK_FIXTURE));
  assert.deepEqual(recoveredState, original);
  assert.deepEqual(recoveredCalls.filter(c => !c.startsWith('GET')).slice(-2), ['PATCH dns', 'PUT tunnel']);
  assert.equal(existsSync(join(root, 'production-rollback-state.json')), false);
});

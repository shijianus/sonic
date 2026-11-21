import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';

const host = 'sonic.epocanvas.tech';
const engineHost = 'engine-sonic.epocanvas.tech';
const backupDir = fileURLToPath(new URL('../rollback-backups/', import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function backupPath(explicit, kind) {
  if (explicit) return explicit;
  const matches = readdirSync(backupDir).filter(name => name.endsWith('.json') && name.includes(kind));
  if (matches.length !== 1) throw new Error(`Select a single ${kind} backup using its environment variable`);
  return join(backupDir, matches[0]);
}

function dnsFields(record) {
  if (record?.name !== host || !['A', 'AAAA', 'CNAME'].includes(record.type) ||
      typeof record.content !== 'string' || !record.content || typeof record.proxied !== 'boolean' ||
      !Number.isInteger(record.ttl) || record.ttl < 1) throw new Error('Unexpected DNS record');
  const { type, name, content, proxied, ttl } = record;
  return { type, name, content, proxied, ttl };
}

export function mergeTunnel(current, backup) {
  if (!Array.isArray(current?.ingress) || !Array.isArray(backup?.ingress)) throw new Error('Missing Tunnel ingress');
  const target = backup.ingress.filter(r => r.hostname === host);
  const preservedEngine = current.ingress.some(r => r.hostname === engineHost);
  const restoredEngine = preservedEngine ? [] : backup.ingress.filter(r => r.hostname === engineHost);
  if (!target.length || !(preservedEngine || restoredEngine.length)) throw new Error('Missing Sonic or Engine ingress');
  const ingress = current.ingress.filter(r => r.hostname !== host);
  const originalPosition = current.ingress.findIndex(r => r.hostname === host);
  const fallback = ingress.findIndex(r => !r.hostname && !r.path);
  const insertAt = originalPosition >= 0 ? originalPosition : fallback >= 0 ? fallback : ingress.length;
  ingress.splice(insertAt, 0, ...restoredEngine, ...target);
  if (fallback < 0) ingress.push(backup.ingress.find(r => !r.hostname && !r.path) || { service: 'http_status:404' });
  return { ...current, ingress };
}

function cloudflare(ids, token) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  if (!['accountId', 'tunnelId', 'zoneId', 'recordId'].every(k => typeof ids?.[k] === 'string' && /^[a-zA-Z0-9-]+$/.test(ids[k]))) {
    throw new Error('Invalid backup or recovery identifiers');
  }
  const urls = {
    tunnel: `https://api.cloudflare.com/client/v4/accounts/${ids.accountId}/cfd_tunnel/${ids.tunnelId}/configurations`,
    dns: `https://api.cloudflare.com/client/v4/zones/${ids.zoneId}/dns_records/${ids.recordId}`,
  };
  async function request(resource, method, payload) {
    const response = await fetch(urls[resource], {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: payload && JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${method} ${resource} returned HTTP ${response.status}`);
    const body = await response.json();
    if (body?.success !== true) throw new Error(`${method} ${resource} was rejected`);
    return body.result;
  }
  return {
    async read(resource) {
      const result = await request(resource, 'GET');
      if (resource === 'dns') {
        if (result?.id !== ids.recordId) throw new Error('Unexpected DNS record ID');
        return dnsFields(result);
      }
      if (!Array.isArray(result?.config?.ingress)) throw new Error('Invalid Tunnel response');
      return result.config;
    },
    write(resource, value) {
      return resource === 'dns' ? request(resource, 'PATCH', value) : request(resource, 'PUT', { config: value });
    },
  };
}

// A lost write response is ambiguous. Only an independent read can confirm success.
async function change(api, key, from, to) {
  const before = await api.read(key);
  if (equal(before, to)) return;
  if (!equal(before, from)) throw new Error(`${key} changed since the snapshot; refusing to overwrite`);
  try {
    await api.write(key, to);
  } catch (error) {
    if (equal(await api.read(key), to)) return;
    throw error;
  }
  if (!equal(await api.read(key), to)) throw new Error(`${key} readback differs from the intended state`);
}

async function verifyPair(api, expected) {
  for (const key of ['tunnel', 'dns']) {
    if (!equal(await api.read(key), expected[key])) throw new Error(`Final ${key} state differs`);
  }
}

export async function recover(api, { original, target }) {
  // If either resource has an unrelated change or is unreadable, retain the journal.
  for (const key of ['dns', 'tunnel']) {
    const live = await api.read(key);
    if (!equal(live, original[key]) && !equal(live, target[key])) throw new Error(`Unexpected ${key} state during recovery`);
  }
  // Restore and verify DNS before removing the Tunnel routing it may point at.
  await change(api, 'dns', target.dns, original.dns);
  await change(api, 'tunnel', target.tunnel, original.tunnel);
  await verifyPair(api, original);
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export async function execute(api, plan, journal) {
  const fd = openSync(journal, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(plan));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(journal);
  try {
    await change(api, 'tunnel', plan.original.tunnel, plan.target.tunnel);
    await change(api, 'dns', plan.original.dns, plan.target.dns);
    await verifyPair(api, plan.target);
  } catch (forwardError) {
    try {
      await recover(api, plan);
    } catch (recoveryError) {
      throw new Error(`Rollback failed (${forwardError.message}); recovery unverified (${recoveryError.message}). Retain ${journal} and use --recover`);
    }
    unlinkSync(journal);
    syncDirectory(journal);
    throw new Error(`Rollback failed (${forwardError.message}); both original states have been verified`);
  }
  unlinkSync(journal);
  syncDirectory(journal);
}

async function main() {
  const [mode = '--dry-run', ...extra] = process.argv.slice(2);
  if (extra.length || !['--dry-run', '--execute', '--recover'].includes(mode)) {
    throw new Error('Usage: rollback-production.sh [--dry-run | --execute | --recover]');
  }
  const journal = resolve(process.env.SONIC_ROLLBACK_STATE_DIR || backupDir, 'production-rollback-state.json');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (mode === '--recover') {
    const plan = readJson(journal);
    await recover(cloudflare(plan.ids, token), plan);
    unlinkSync(journal);
    syncDirectory(journal);
    console.log('Both original states restored and verified.');
    return;
  }
  if (existsSync(journal)) throw new Error(`An unfinished operation exists at ${journal}; inspect it before --recover`);
  const tunnel = readJson(backupPath(process.env.TUNNEL_BACKUP, 'tunnel'));
  const dns = readJson(backupPath(process.env.DNS_BACKUP, 'dns'));
  const record = dns.records?.find(r => r.name === host);
  if (!record || (record.type && record.type !== 'CNAME')) throw new Error('Missing CNAME backup for Sonic');
  const ids = { accountId: tunnel.accountId, tunnelId: tunnel.tunnelId, zoneId: dns.zoneId, recordId: record.id };
  const api = cloudflare(ids, token);
  const original = { tunnel: await api.read('tunnel'), dns: await api.read('dns') };
  const target = {
    tunnel: mergeTunnel(original.tunnel, tunnel.config),
    dns: dnsFields({ ...record, type: 'CNAME', ttl: record.ttl ?? 1 }),
  };
  const plan = { ids, original, target };
  if (mode === '--dry-run') {
    console.log(JSON.stringify({ mode, target }, null, 2));
    return;
  }
  await execute(api, plan, journal);
  console.log('Both target states applied and verified.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

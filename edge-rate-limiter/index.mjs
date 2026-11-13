import { DurableObject } from 'cloudflare:workers';

const windowMs = 60_000;
const counterKey = 'window-v1';

export class SonicRateBucket extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || path !== '/v1/consume') return new Response(null, { status: 404 });
    const limit = Number(request.headers.get('x-sonic-bucket-limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) return new Response(null, { status: 400 });

    const storage = this.ctx.storage;
    const now = Date.now();
    // No await between the read and write. SQLite commits before the response leaves the object.
    const previous = storage.kv.get(counterKey);
    const expired = !previous || previous.resetAt <= now;
    const resetAt = expired ? now + windowMs : previous.resetAt;
    const count = expired ? 0 : previous.count;
    const allowed = count < limit;
    if (allowed) storage.kv.put(counterKey, { count: count + 1, resetAt });
    if (expired) await storage.setAlarm(resetAt);
    return Response.json({
      allowed,
      remaining: Math.max(0, limit - count - Number(allowed)),
      resetSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    });
  }

  async alarm() {
    const storage = this.ctx.storage;
    const window = storage.kv.get(counterKey);
    if (window && window.resetAt > Date.now()) {
      await storage.setAlarm(window.resetAt);
      return;
    }
    await storage.deleteAll();
  }
}

const inviteKey = /^sonic:access:invite:[a-f0-9]{64}$/;
const sessionKey = /^sonic:access:session:[a-f0-9]{64}$/;
const maxSessionAge = 30 * 24 * 60 * 60 * 1000;
const accessHeaders = { 'X-Sonic-Access-Store': 'v1' };
const accessResponse = status => new Response(null, { status, headers: accessHeaders });

// Pages calls this object through its binding. The public Worker handler below
// does not forward any requests here. Each environment has its own namespace.
export class SonicAccessStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS consumed_invites (invite_key TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE IF NOT EXISTS access_sessions (
        session_key TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS access_sessions_expiry ON access_sessions (expires_at);
    `);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const storage = this.ctx.storage;
    const sql = storage.sql;
    if (request.method === 'GET' && path === '/v1/health') {
      sql.exec('SELECT invite_key FROM consumed_invites LIMIT 1').toArray();
      sql.exec('SELECT session_key FROM access_sessions LIMIT 1').toArray();
      return accessResponse(204);
    }
    if (request.method !== 'POST' || !['/v1/redeem', '/v1/session', '/v1/revoke'].includes(path)) {
      return new Response(null, { status: 404 });
    }
    const payload = await request.json().catch(() => null);
    const key = payload?.sessionHash;
    if (typeof key !== 'string' || !sessionKey.test(key)) return accessResponse(400);
    const now = Date.now();
    if (path === '/v1/session') {
      const [record] = sql.exec(`SELECT session_key AS sessionHash, created_at AS createdAt, expires_at AS expiresAt
        FROM access_sessions WHERE session_key = ? AND expires_at > ?`, key, now).toArray();
      return record ? Response.json(record, { headers: accessHeaders }) : accessResponse(404);
    }
    if (path === '/v1/revoke') {
      sql.exec('DELETE FROM access_sessions WHERE session_key = ?', key);
      return accessResponse(204);
    }

    const { codeHash, createdAt, expiresAt } = payload;
    if (typeof codeHash !== 'string' || !inviteKey.test(codeHash) || !Number.isSafeInteger(createdAt) ||
        !Number.isSafeInteger(expiresAt) || createdAt > now + 60_000 || expiresAt <= now ||
        expiresAt <= createdAt || expiresAt - createdAt > maxSessionAge) return accessResponse(400);
    const redeemed = storage.transactionSync(() => {
      const changed = sql.exec(`INSERT INTO consumed_invites (invite_key) VALUES (?)
        ON CONFLICT (invite_key) DO NOTHING RETURNING invite_key`, codeHash).toArray();
      if (changed.length === 0) return false;
      sql.exec(`DELETE FROM access_sessions WHERE session_key IN
        (SELECT session_key FROM access_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`, now);
      // A failed session write rolls back the invite marker. Markers never expire.
      sql.exec('INSERT INTO access_sessions (session_key, created_at, expires_at) VALUES (?, ?, ?)', key, createdAt, expiresAt);
      return true;
    });
    return accessResponse(redeemed ? 201 : 409);
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };

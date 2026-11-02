import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../functions/_lib/sonic/crypto';
import type { AccessRepository, AccessSessionRecord, InviteRedemption } from '../functions/_lib/sonic/access';

const APPLICATION_ID = 0x53414332;

function parseSeedCodes(raw = ''): string[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(value => value.length >= 8 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value));
}

export class SqliteAccessStore implements AccessRepository {
  private readonly db: DatabaseSync;

  constructor(public readonly dbPath: string, seedCodes = '') {
    if (!dbPath?.trim() || ['memory', 'off'].includes(dbPath) || dbPath.startsWith('file:')) {
      throw new Error('SONIC_ACCESS_DB_PATH must be a dedicated persistent file');
    }
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    let fresh = false;
    try {
      fs.closeSync(fs.openSync(dbPath, 'wx', 0o600));
      fresh = true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      if (!fs.lstatSync(dbPath).isFile()) throw new Error('Access DB must be a regular file');
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const appId = Number((probe.prepare('PRAGMA application_id').get() as any)?.application_id || 0);
        const userVersion = Number((probe.prepare('PRAGMA user_version').get() as any)?.user_version || 0);
        if (appId !== APPLICATION_ID || userVersion !== 1) throw new Error('Refusing an existing non-access database');
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
      if (fresh) {
        this.db.exec(`
          PRAGMA application_id=${APPLICATION_ID};
          PRAGMA user_version=1;
          CREATE TABLE access_invites (
            invite_key TEXT PRIMARY KEY,
            invite_id TEXT NOT NULL,
            max_uses INTEGER NOT NULL DEFAULT 1,
            used_count INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER,
            revoked_at INTEGER
          );
          CREATE TABLE access_sessions (
            session_hash TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER
          );
          CREATE INDEX access_sessions_expiry ON access_sessions(expires_at);
        `);
      }
      this.seed(seedCodes);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private seed(raw: string): void {
    const codes = parseSeedCodes(raw);
    if (!codes.length) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO access_invites(invite_key, invite_id, max_uses, used_count, expires_at, revoked_at)
      VALUES (?, ?, 1, 0, NULL, NULL)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const code of codes) {
        const hash = sha256Hex(`sonic-access-invite-v1:${code}`);
        insert.run(`sonic:access:invite:${hash}`, `seed_${hash.slice(0, 16)}`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  redeemInvite(codeHash: string, nowMs: number): InviteRedemption | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM access_invites WHERE invite_key=?').get(codeHash) as any;
      if (!row || row.revoked_at || (row.expires_at !== null && Number(row.expires_at) <= nowMs) || Number(row.used_count) >= Number(row.max_uses)) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('UPDATE access_invites SET used_count=used_count+1 WHERE invite_key=?').run(codeHash);
      this.db.exec('COMMIT');
      return { inviteId: String(row.invite_id), ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  redeemInviteAndCreateSession(codeHash: string, record: AccessSessionRecord, nowMs: number): InviteRedemption | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM access_invites WHERE invite_key=?').get(codeHash) as any;
      if (!row || row.revoked_at || (row.expires_at !== null && Number(row.expires_at) <= nowMs) || Number(row.used_count) >= Number(row.max_uses)) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare('UPDATE access_invites SET used_count=used_count+1 WHERE invite_key=?').run(codeHash);
      this.db.prepare('INSERT INTO access_sessions(session_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?)')
        .run(record.sessionHash, record.createdAt, record.expiresAt, record.revokedAt ?? null);
      this.db.exec('COMMIT');
      return { inviteId: String(row.invite_id), ...(row.expires_at ? { expiresAt: Number(row.expires_at) } : {}) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  createSession(record: AccessSessionRecord): void {
    this.db.prepare('INSERT INTO access_sessions(session_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?)')
      .run(record.sessionHash, record.createdAt, record.expiresAt, record.revokedAt ?? null);
  }

  getSession(sessionHash: string, nowMs: number): AccessSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM access_sessions WHERE session_hash=?').get(sessionHash) as any;
    if (!row) return null;
    if (Number(row.expires_at) <= nowMs) return null;
    return {
      sessionHash: String(row.session_hash),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      ...(row.revoked_at ? { revokedAt: Number(row.revoked_at) } : {}),
    };
  }

  revokeSession(sessionHash: string, nowMs: number): void {
    this.db.prepare('UPDATE access_sessions SET revoked_at=? WHERE session_hash=? AND revoked_at IS NULL').run(nowMs, sessionHash);
  }

  close(): void { this.db.close(); }
}

export function createServerAccessStore(dbPath: string, seedCodes = ''): SqliteAccessStore {
  return new SqliteAccessStore(dbPath, seedCodes);
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from '../functions/_lib/sonic/crypto';
import { ACCOUNT_LIMITS, AccountError, emptyAccountSnapshot, normalizeAccountMutation, type AccountCollection, type AccountMutation, type AccountMutationResult, type AccountSnapshot, type AccountStore } from '../functions/_lib/account/library';

const APPLICATION_ID = 0x53414331;
export class SqliteAccountStore implements AccountStore {
  readonly kind = 'sqlite' as const;
  readonly schemaVersion = 1 as const;
  private db: DatabaseSync;
  constructor(public readonly dbPath: string) {
    if (!dbPath?.trim() || ['memory', 'off'].includes(dbPath) || dbPath.startsWith('file:')) throw new Error('Explicit account database path required');
    let fresh = dbPath === ':memory:';
    if (!fresh) {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
      try { fs.closeSync(fs.openSync(dbPath, 'wx', 0o600)); fresh = true; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.lstatSync(dbPath).isFile()) throw new Error('Account DB must be a regular file');
        const probe = new DatabaseSync(dbPath, { readOnly: true });
        try {
          if (Number(probe.prepare('PRAGMA application_id').get()!.application_id) !== APPLICATION_ID || Number(probe.prepare('PRAGMA user_version').get()!.user_version) !== 1) throw new Error('Refusing an existing non-account database');
        } finally { probe.close(); }
      }
    }
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (fresh) this.db.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        CREATE TABLE account_users(subject TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE account_items(subject TEXT NOT NULL REFERENCES account_users(subject),collection TEXT NOT NULL,id TEXT NOT NULL,value_json TEXT,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(subject,collection,id));
        CREATE TABLE account_operations(subject TEXT NOT NULL REFERENCES account_users(subject),operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(subject,operation_id),UNIQUE(subject,version));
        COMMIT;`);
    } catch (error) { this.db.close(); throw error; }
  }
  private subject(subject: string): void {
    if (typeof subject !== 'string' || !/^usr_[a-f0-9]{24,64}$/.test(subject)) throw new AccountError('INVALID_ACCOUNT_SUBJECT', 'Verified account required', 401);
  }
  private transaction<T>(write: boolean, run: () => T): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  getLibrary(subject: string): AccountSnapshot {
    this.subject(subject);
    return this.transaction(false, () => {
      const result = emptyAccountSnapshot();
      const user = this.db.prepare('SELECT version,updated_at FROM account_users WHERE subject=?').get(subject);
      if (!user) return result;
      result.version = Number(user.version); result.updatedAt = Number(user.updated_at);
      for (const row of this.db.prepare('SELECT * FROM account_items WHERE subject=? ORDER BY version DESC,collection,id').all(subject)) {
        const collection = String(row.collection) as AccountCollection;
        if (row.value_json === null) result.tombstones.push({ collection, id: String(row.id), version: Number(row.version), deletedAt: Number(row.updated_at) });
        else result[collection].push(JSON.parse(String(row.value_json)));
      }
      return result;
    });
  }
  applyLibraryMutation(subject: string, input: AccountMutation): AccountMutationResult {
    this.subject(subject);
    const mutation = normalizeAccountMutation(input);
    const fingerprint = sha256Hex(JSON.stringify(mutation));
    return this.transaction(true, () => {
      const receipt = this.db.prepare('SELECT * FROM account_operations WHERE subject=? AND operation_id=?').get(subject, mutation.operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new AccountError('IDEMPOTENCY_CONFLICT', 'operationId already used with different content', 409);
        return { operationId: mutation.operationId, version: Number(receipt.version), updatedAt: Number(receipt.updated_at), replayed: true };
      }
      const user = this.db.prepare('SELECT version FROM account_users WHERE subject=?').get(subject);
      const currentVersion = Number(user?.version || 0);
      if (mutation.baseVersion !== currentVersion) throw new AccountError('VERSION_CONFLICT', 'Read latest library before applying changes', 409, currentVersion);
      if (currentVersion >= Number.MAX_SAFE_INTEGER) throw new AccountError('ACCOUNT_LIMIT_EXCEEDED', 'Account version limit reached', 409);
      const version = currentVersion + 1, updatedAt = Date.now();
      this.db.prepare('INSERT INTO account_users VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at').run(subject, version, updatedAt);
      const put = this.db.prepare('INSERT INTO account_items VALUES(?,?,?,?,?,?) ON CONFLICT(subject,collection,id) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,updated_at=excluded.updated_at');
      for (const op of mutation.operations) put.run(subject, op.collection, op.id, op.type === 'delete' ? null : JSON.stringify(op.value), version, updatedAt);
      const totals = this.db.prepare(`SELECT COUNT(*) AS records,COUNT(value_json) AS live,COALESCE(SUM(length(CAST(value_json AS BLOB))),0) AS bytes,COALESCE(SUM(CASE WHEN collection='userPlaylists' AND value_json IS NOT NULL THEN 1 ELSE 0 END),0) AS playlists FROM account_items WHERE subject=?`).get(subject)!;
      if (Number(totals.records) > ACCOUNT_LIMITS.records || Number(totals.live) > ACCOUNT_LIMITS.items || Number(totals.bytes) > ACCOUNT_LIMITS.bytes || Number(totals.playlists) > ACCOUNT_LIMITS.playlists) throw new AccountError('ACCOUNT_LIMIT_EXCEEDED', 'Account library quota exceeded', 409, currentVersion);
      this.db.prepare('INSERT INTO account_operations VALUES(?,?,?,?,?)').run(subject, mutation.operationId, fingerprint, version, updatedAt);
      // Evicted receipt replays remain stale via baseVersion; tombstones are never pruned.
      this.db.prepare('DELETE FROM account_operations WHERE subject=? AND version<=?').run(subject, version - ACCOUNT_LIMITS.receipts);
      return { operationId: mutation.operationId, version, updatedAt, replayed: false };
    });
  }
  close(): void { this.db.close(); }
}
export function createServerAccountStore(dbPath: string): SqliteAccountStore {
  if (dbPath === ':memory:') throw new Error('Account server storage requires a dedicated persistent file');
  return new SqliteAccountStore(dbPath);
}

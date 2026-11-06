// Revoke a seeded invite code in the Engine's SQLite access database.
// Usage: node --experimental-sqlite scripts/revoke-invite.mjs <db-path> <invite-code>
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x53414332;
const [dbPathArg, codeArg] = process.argv.slice(2);
const code = String(codeArg || '');
if (!dbPathArg || code.length < 16 || code.length > 256 || /[\u0000-\u0020\u007f]/.test(code)) {
  console.error('Usage: node --experimental-sqlite scripts/revoke-invite.mjs <db-path> <invite-code>');
  console.error('The invite code must be 16-256 characters with no whitespace/control characters.');
  process.exit(2);
}

const dbPath = resolve(dbPathArg);
if (!existsSync(dbPath) || !lstatSync(dbPath).isFile()) {
  console.error(`[revoke:invite] access database not found: ${dbPath}`);
  process.exit(1);
}

const hash = createHash('sha256').update(`sonic-access-invite-v1:${code}`).digest('hex');
const inviteKey = `sonic:access:invite:${hash}`;
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA busy_timeout=3000;');
  const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id || 0);
  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (applicationId !== APPLICATION_ID || userVersion !== 1) {
    throw new Error('Refusing to modify a database that is not a Sonic access database');
  }
  const result = db.prepare(
    'UPDATE access_invites SET revoked_at=? WHERE invite_key=? AND revoked_at IS NULL',
  ).run(Date.now(), inviteKey);
  console.log(JSON.stringify({ ok: true, revoked: Number(result.changes) > 0, inviteKey }));
} catch (error) {
  console.error(`[revoke:invite] ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  db.close();
}

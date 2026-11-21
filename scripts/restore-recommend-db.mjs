// Offline-only restore. Stop the engine (including restart supervisors) before --offline.
// Usage: node --experimental-sqlite scripts/restore-recommend-db.mjs <backup.sqlite> [target.sqlite] --offline
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { assertSnapshotPreservesErasures } from './recommend-recovery-guard.mjs';
import {
  acquireMaintenanceLock, assertDatabaseFile, assertNoSidecars, backupDatabase,
  checkCapacity, databaseType, defaultDatabaseFile, digestFile, syncDirectory, syncFile, verifyDatabase,
} from './backup-recommend-db.mjs';

// For account and access, versions, tombstones, spent invites and revoked sessions
// must survive rollback. Refuse to replace an existing store with divergent state.
function assertSameBusinessState(current, candidate, kind) {
  const db = new DatabaseSync(current, { readOnly: true });
  try {
    db.prepare('ATTACH DATABASE ? AS candidate').run(candidate);
    for (const table of databaseType(kind).tables) {
      const currentRows = 'SELECT * FROM main.' + table;
      const restoredRows = 'SELECT * FROM candidate.' + table;
      if (db.prepare(currentRows + ' EXCEPT ' + restoredRows + ' LIMIT 1').get() ||
          db.prepare(restoredRows + ' EXCEPT ' + currentRows + ' LIMIT 1').get()) {
        throw new Error('Snapshot differs from current ' + kind + ' state; retain both copies for reconciliation');
      }
    }
  } finally {
    db.close();
  }
}

// io is injectable for offline failure/rollback tests; the CLI always uses the real fs.
export function restoreDatabase(backupFile, targetFile, { offline = false, io = fs, kind = 'recommend', finalSha256 } = {}) {
  if (!offline) throw new Error('Restore requires --offline after stopping all database writers and restart supervisors');
  databaseType(kind);
  if (kind !== 'recommend' && !/^[0-9a-f]{64}$/.test(finalSha256 || '')) {
    throw new Error('Account/access recovery requires the trusted final SHA-256 recorded after stopping writers');
  }
  backupFile = path.resolve(backupFile);
  targetFile = path.resolve(targetFile);
  assertDatabaseFile(backupFile);
  assertNoSidecars(backupFile);
  if (backupFile === targetFile) throw new Error('Backup and target must be different files');
  const directory = path.dirname(targetFile);
  fs.mkdirSync(directory, { recursive: true });
  const releaseLock = acquireMaintenanceLock(targetFile, 'restore');
  const token = randomUUID();
  const staging = `${targetFile}.restoring-${token}.tmp`;
  const rollback = `${targetFile}.rollback-${token}.tmp`;
  let preRestoreSafetyCopy = null;
  let originalDigest = null;
  let db;
  let replaced = false;
  let keepLock = false;
  try {
    // Never delete WAL/SHM/journal files to make a database appear offline.
    assertNoSidecars(targetFile);
    const targetExisted = fs.existsSync(targetFile);
    const originalStat = targetExisted ? fs.lstatSync(targetFile) : null;
    if (targetExisted) {
      assertDatabaseFile(targetFile);
      db = new DatabaseSync(targetFile);
      db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
      // Exclusive locking mode retains SQLite's lock after COMMIT while VACUUM runs.
      preRestoreSafetyCopy = `${targetFile}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${token}.sqlite`;
    }
    checkCapacity(directory, fs.statSync(backupFile).size + 2 * (originalStat?.size || 0));
    let expected;
    if (kind === 'recommend') {
      expected = backupDatabase(backupFile, staging, { storedSnapshot: true });
      assertSnapshotPreservesErasures(staging, targetFile, db);
    } else {
      if (fs.existsSync(targetFile + '.erasure-recovery.json')) throw new Error('Target belongs to a protected recommendation store');
      // Copy first, then verify the exact bytes we will publish against the off-volume record.
      fs.copyFileSync(backupFile, staging, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staging, 0o600);
      syncFile(staging);
      if (digestFile(staging) !== finalSha256) throw new Error('Snapshot does not match the trusted final SHA-256');
      expected = { ...verifyDatabase(staging, kind), sha256: finalSha256 };
    }
    if (db) {
      db.exec(`VACUUM INTO '${preRestoreSafetyCopy.replace(/'/g, "''")}'`);
      fs.chmodSync(preRestoreSafetyCopy, 0o600);
      verifyDatabase(preRestoreSafetyCopy, kind);
      if (kind !== 'recommend') assertSameBusinessState(preRestoreSafetyCopy, staging, kind);
      syncFile(preRestoreSafetyCopy);
      // Keep a separate verified rollback file: the safety snapshot remains available.
      fs.copyFileSync(preRestoreSafetyCopy, rollback, fs.constants.COPYFILE_EXCL);
      syncFile(rollback);
      originalDigest = digestFile(preRestoreSafetyCopy);
      if (digestFile(rollback) !== originalDigest) throw new Error('Rollback snapshot verification failed');
      db.close();
      db = undefined;
    }
    assertNoSidecars(targetFile);
    // Check the inspected target again before replacing it. The maintenance lock
    // prevents engine startup until verification (or verified rollback) completes.
    if (targetExisted) {
      const current = fs.lstatSync(targetFile);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== originalStat.dev || current.ino !== originalStat.ino) {
        throw new Error('Target changed during restore; refusing to overwrite it');
      }
    } else if (fs.existsSync(targetFile)) {
      throw new Error('Target appeared during restore; refusing to overwrite it');
    }
    syncDirectory(directory);
    io.renameSync(staging, targetFile);
    replaced = true;
    syncDirectory(directory);
    const actual = verifyDatabase(targetFile, kind);
    if (digestFile(targetFile) !== expected.sha256 || Object.entries(actual).some(([key, value]) => expected[key] !== value)) {
      throw new Error('Post-restore verification failed');
    }
    return {
      ok: true, kind, restoredFrom: backupFile, target: targetFile, preRestoreSafetyCopy,
      sizeBytes: fs.statSync(targetFile).size, sha256: expected.sha256, ...actual,
    };
  } catch (error) {
    if (replaced) {
      try {
        assertNoSidecars(targetFile);
        if (preRestoreSafetyCopy) {
          io.renameSync(rollback, targetFile);
          syncDirectory(directory);
          verifyDatabase(targetFile, kind);
          if (digestFile(targetFile) !== originalDigest) throw new Error('Rollback digest mismatch');
        } else {
          fs.unlinkSync(targetFile);
          syncDirectory(directory);
        }
      } catch (rollbackError) {
        keepLock = true;
        throw new Error(`Restore failed (${error.message}); rollback failed (${rollbackError.message}). Maintenance lock retained; recover from ${preRestoreSafetyCopy || 'the original backup'} before restarting.`);
      }
      throw new Error(`Restore failed; original target restored and verified: ${error.message}`);
    }
    throw error;
  } finally {
    try { db?.close(); } finally {
      try {
        fs.rmSync(staging, { force: true });
        if (!keepLock) fs.rmSync(rollback, { force: true });
      } finally {
        if (!keepLock) releaseLock();
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      offline: { type: 'boolean' }, kind: { type: 'string', default: 'recommend' }, 'final-sha256': { type: 'string' },
    } });
    if (!positionals[0] || positionals.length > 2) {
      throw new Error('Usage: restore <snapshot> [target] --offline [--kind recommend|account|access] [--final-sha256 DIGEST]');
    }
    console.log(JSON.stringify(restoreDatabase(positionals[0], positionals[1] || defaultDatabaseFile(values.kind), {
      offline: values.offline, kind: values.kind, finalSha256: values['final-sha256'],
    })));
  } catch (error) {
    console.error(`[restore] failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

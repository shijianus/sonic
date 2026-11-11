// Offline-only restore. Stop the engine (including restart supervisors) before --offline.
// Usage: node --experimental-sqlite scripts/restore-recommend-db.mjs <backup.sqlite> [target.sqlite] --offline
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertSnapshotPreservesErasures } from './recommend-recovery-guard.mjs';
import {
  acquireMaintenanceLock, assertDatabaseFile, assertNoSidecars, backupDatabase,
  checkCapacity, digestFile, syncDirectory, syncFile, verifyDatabase,
} from './backup-recommend-db.mjs';

// io is injectable for offline failure/rollback tests; the CLI always uses the real fs.
export function restoreDatabase(backupFile, targetFile, { offline = false, io = fs } = {}) {
  if (!offline) throw new Error('Restore requires --offline after stopping all database writers and restart supervisors');
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
    const expected = backupDatabase(backupFile, staging, { storedSnapshot: true });
    assertSnapshotPreservesErasures(staging, targetFile, db);
    if (db) {
      db.exec(`VACUUM INTO '${preRestoreSafetyCopy.replace(/'/g, "''")}'`);
      fs.chmodSync(preRestoreSafetyCopy, 0o600);
      verifyDatabase(preRestoreSafetyCopy);
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
    const actual = verifyDatabase(targetFile);
    if (digestFile(targetFile) !== expected.sha256 || actual.tracks !== expected.tracks || actual.events !== expected.events) {
      throw new Error('Post-restore verification failed');
    }
    return {
      ok: true, restoredFrom: backupFile, target: targetFile, preRestoreSafetyCopy,
      sizeBytes: fs.statSync(targetFile).size, sha256: expected.sha256, ...actual,
    };
  } catch (error) {
    if (replaced) {
      try {
        assertNoSidecars(targetFile);
        if (preRestoreSafetyCopy) {
          io.renameSync(rollback, targetFile);
          syncDirectory(directory);
          verifyDatabase(targetFile);
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
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const paths = args.filter(arg => arg !== '--offline');
  try {
    if (!paths[0] || paths.length > 2 || paths.some(arg => arg.startsWith('--'))) {
      throw new Error('Usage: restore-recommend-db.mjs <backup.sqlite> [target.sqlite] --offline');
    }
    console.log(JSON.stringify(restoreDatabase(paths[0], paths[1] || process.env.SONIC_RECOMMEND_DB_PATH || 'data/sonic-recommend.sqlite', { offline })));
  } catch (error) {
    console.error(`[restore] failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

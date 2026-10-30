#!/usr/bin/env node
// Safe, non-destructive SQLite restore script with pre-restore safety snapshot & WAL cleanup.
// Usage: node --experimental-sqlite scripts/restore-recommend-db.mjs <backup.sqlite> [target.sqlite]

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const backupFile = process.argv[2] ? path.resolve(process.argv[2]) : '';
const targetFile = path.resolve(
  process.argv[3] || process.env.SONIC_RECOMMEND_DB_PATH || 'data/sonic-recommend.sqlite',
);

if (!backupFile || !fs.existsSync(backupFile)) {
  console.error('[restore] usage: node --experimental-sqlite scripts/restore-recommend-db.mjs <backup.sqlite> [target.sqlite]');
  console.error(`[restore] backup file not found: ${backupFile || '(missing)'}`);
  process.exit(1);
}

// 1. Verify backup integrity BEFORE touching target database
let backupTracks = 0;
let backupEvents = 0;
try {
  const verifyDb = new DatabaseSync(backupFile);
  const check = verifyDb.prepare('PRAGMA integrity_check').get();
  const status = check?.integrity_check ?? Object.values(check || {})[0];
  if (String(status).toLowerCase() !== 'ok') {
    verifyDb.close();
    throw new Error(`Backup integrity_check failed: ${String(status)}`);
  }
  const counts = verifyDb
    .prepare(
      'SELECT (SELECT COUNT(*) FROM canonical_tracks) AS tracks, (SELECT COUNT(*) FROM behavior_events) AS events',
    )
    .get();
  backupTracks = Number(counts?.tracks || 0);
  backupEvents = Number(counts?.events || 0);
  verifyDb.close();
} catch (err) {
  console.error(`[restore] refusing to restore invalid backup: ${err?.message || err}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(targetFile), { recursive: true });

// 2. Preserve existing target database as a timestamped pre-restore safety snapshot (never blindly overwrite)
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let preRestoreSafetyCopy = null;
if (fs.existsSync(targetFile)) {
  preRestoreSafetyCopy = `${targetFile}.pre-restore-${stamp}.sqlite`;
  try {
    const existingDb = new DatabaseSync(targetFile);
    const escaped = preRestoreSafetyCopy.replace(/'/g, "''");
    existingDb.exec(`VACUUM INTO '${escaped}'`);
    existingDb.close();
  } catch {
    fs.copyFileSync(targetFile, preRestoreSafetyCopy);
  }
}

// 3. Stage verified backup to same-directory temp file, remove stale WAL/SHM sidecars, and rename atomically
const stagingTemp = `${targetFile}.restoring-${process.pid}.tmp`;
fs.copyFileSync(backupFile, stagingTemp);

for (const sidecar of [`${targetFile}-wal`, `${targetFile}-shm`]) {
  if (fs.existsSync(sidecar)) {
    fs.unlinkSync(sidecar);
  }
}
fs.renameSync(stagingTemp, targetFile);

// 4. Verify restored target database
const targetDb = new DatabaseSync(targetFile);
const postCheck = targetDb.prepare('PRAGMA integrity_check').get();
targetDb.close();
const postStatus = postCheck?.integrity_check ?? Object.values(postCheck || {})[0];
if (String(postStatus).toLowerCase() !== 'ok') {
  console.error(`[restore] post-restore integrity_check failed: ${String(postStatus)}`);
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    restoredFrom: backupFile,
    target: targetFile,
    preRestoreSafetyCopy,
    sizeBytes: fs.statSync(targetFile).size,
    tracks: backupTracks,
    events: backupEvents,
  }),
);

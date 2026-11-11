// Online SQLite backup: VACUUM INTO includes committed WAL data; never copy a live main file.
// Usage: node --experimental-sqlite scripts/backup-recommend-db.mjs [source.sqlite] [destination.sqlite]
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { assertBackupPreservesErasures, syncDirectory } from './recommend-recovery-guard.mjs';

export { syncDirectory };

export function assertDatabaseFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Database must be a regular, unlinked file: ${file}`);
  }
}

export function assertNoSidecars(file) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(file + suffix)) {
      throw new Error(`Refusing active or uncheckpointed database (${suffix}); stop all writers and checkpoint it offline first: ${file}`);
    }
  }
}

export function acquireMaintenanceLock(file, operation) {
  // Same protocol as runtime initialization. Never reclaim a stale lock automatically.
  const directory = `${file}.maintenance-lock`;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Database maintenance lock exists; verify the owner has stopped before removing it: ${directory}`);
    throw error;
  }
  const owner = path.join(directory, 'owner.json');
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, operation }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmdirSync(directory);
    throw error;
  }
  return () => {
    fs.unlinkSync(owner);
    fs.rmdirSync(directory);
  };
}

export function syncFile(file) {
  // Windows FlushFileBuffers requires a write-capable handle. These are owned snapshots.
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function checkCapacity(directory, requiredBytes) {
  const reserveMb = Number(process.env.SONIC_MIN_FREE_DISK_MB || 64);
  if (!Number.isFinite(reserveMb) || reserveMb < 0) throw new Error('Invalid SONIC_MIN_FREE_DISK_MB');
  const disk = fs.statfsSync(directory);
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < requiredBytes + reserveMb * 1024 * 1024) {
    throw new Error('Insufficient free disk space for a verified database snapshot and reserve');
  }
}

export function verifyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA integrity_check').all();
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
      throw new Error('SQLite integrity_check failed');
    }
    const stats = db.prepare('SELECT (SELECT COUNT(*) FROM canonical_tracks) AS tracks, (SELECT COUNT(*) FROM behavior_events) AS events').get();
    return { tracks: Number(stats.tracks), events: Number(stats.events) };
  } finally {
    db.close();
  }
}

export function digestFile(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function backupDatabase(source, destination, { storedSnapshot = false } = {}) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  assertDatabaseFile(source);
  if (source === destination || fs.existsSync(destination)) throw new Error(`Refusing to overwrite existing file: ${destination}`);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  checkCapacity(directory, fs.statSync(source).size + (fs.existsSync(`${source}-wal`) ? fs.statSync(`${source}-wal`).size : 0));
  const releaseLock = acquireMaintenanceLock(source, 'backup');
  const staging = `${destination}.backup-${randomUUID()}.tmp`;
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
    db.close();
    db = undefined;
    fs.chmodSync(staging, 0o600);
    assertNoSidecars(staging);
    const stats = verifyDatabase(staging);
    syncFile(staging);
    const sha256 = digestFile(staging);
    // Offline restore checks the snapshot against the destination's guard.
    if (!storedSnapshot) assertBackupPreservesErasures(staging, source);
    // Atomic publication without clobbering a destination created since our initial check.
    fs.linkSync(staging, destination);
    fs.unlinkSync(staging);
    syncDirectory(directory);
    return { ok: true, source, destination, sizeBytes: fs.statSync(destination).size, sha256, ...stats };
  } finally {
    try { db?.close(); } finally {
      try { fs.rmSync(staging, { force: true }); } finally { releaseLock(); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = path.resolve(process.argv[2] || process.env.SONIC_RECOMMEND_DB_PATH || 'data/sonic-recommend.sqlite');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.resolve(process.argv[3] || `${source}.backup-${stamp}.sqlite`);
  try {
    console.log(JSON.stringify(backupDatabase(source, destination)));
  } catch (error) {
    console.error(`[backup] failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}

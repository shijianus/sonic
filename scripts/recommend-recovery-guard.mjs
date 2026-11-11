import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const ERASURE_RECOVERY_VERSION = 1;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const isId = value => typeof value === 'string' && uuid.test(value);

function guardPath(database) {
  return `${path.resolve(database)}.erasure-recovery.json`;
}

function refuses(reason) {
  return new Error(`Erasure recovery guard: ${reason}`);
}

export function syncDirectory(directory) {
  // Windows does not permit opening directories with fs.open; POSIX must persist the rename.
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function readGuardFile(database) {
  const filename = guardPath(database);
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) {
    throw refuses('the retained guard must be a small, regular, unlinked file');
  }
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value?.version !== ERASURE_RECOVERY_VERSION || !isId(value.lineage) || !isId(value.generation) ||
      !['ready', 'initializing', 'erasing'].includes(value.phase)) {
    throw refuses('the retained guard is invalid');
  }
  return value;
}

export function assertRecoveryDatabasePresent(database) {
  if (!fs.existsSync(database) && readGuardFile(database)) {
    throw refuses('the protected database is missing; restore a verified snapshot with the retained generation');
  }
}

function writeGuardFile(database, state, phase) {
  const filename = guardPath(database);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify({ version: ERASURE_RECOVERY_VERSION, ...state, phase }) + '\n');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readDatabaseGuard(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'recommendation_recovery_guard'").get();
  if (!table) return null;
  const state = db.prepare('SELECT lineage, generation FROM recommendation_recovery_guard WHERE singleton = 1').get();
  if (!state || !isId(state.lineage) || !isId(state.generation)) {
    throw refuses('the SQLite generation is invalid');
  }
  return state;
}

function matches(a, b) {
  return a && b && a.lineage === b.lineage && a.generation === b.generation;
}

function writeTransaction(db, perform) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = perform();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function confirmGeneration(db, database) {
  const state = readDatabaseGuard(db);
  const retained = readGuardFile(database);
  if (!matches(state, retained)) {
    throw refuses('SQLite does not match the retained erasure generation');
  }
  // A crash between SQLite COMMIT and sealing the guard is recoverable only
  // when SQLite already contains the pending generation.
  if (retained.phase !== 'ready') writeGuardFile(database, state, 'ready');
  return state;
}

export function initializeErasureRecovery(db, database) {
  db.exec('PRAGMA synchronous=FULL');
  try {
    writeTransaction(db, () => {
      const state = readDatabaseGuard(db);
      const retained = readGuardFile(database);
      if (state || (retained && retained.phase !== 'initializing')) {
        confirmGeneration(db, database);
        return;
      }
      // A crash before the initial SQLite COMMIT may resume initialization.
      // Initialization records no erasure and therefore cannot undo one.
      const lineage = retained?.lineage ?? randomUUID();
      const generation = retained?.generation ?? randomUUID();
      if (!retained) writeGuardFile(database, { lineage, generation }, 'initializing');
      db.exec(`CREATE TABLE recommendation_recovery_guard (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), lineage TEXT NOT NULL, generation TEXT NOT NULL
      )`);
      db.prepare('INSERT INTO recommendation_recovery_guard VALUES (1, ?, ?)').run(lineage, generation);
    });
    writeTransaction(db, () => confirmGeneration(db, database));
  } finally {
    db.exec('PRAGMA synchronous=NORMAL');
  }
}

export function eraseWithRecoveryGuard(db, database, erase) {
  db.exec('PRAGMA synchronous=FULL');
  try {
    const result = writeTransaction(db, () => {
      const { lineage } = confirmGeneration(db, database);
      const result = erase();
      const generation = randomUUID();
      db.prepare('UPDATE recommendation_recovery_guard SET generation = ? WHERE singleton = 1').run(generation);
      // Retain the new generation durably before SQLite can acknowledge the
      // clear. An older main file cannot match it, including after a crash.
      writeGuardFile(database, { lineage, generation }, 'erasing');
      return result;
    });
    writeTransaction(db, () => confirmGeneration(db, database));
    return result;
  } finally {
    db.exec('PRAGMA synchronous=NORMAL');
  }
}

export function verifiedErasureRecoveryVersion(db, database) {
  const retained = readGuardFile(database);
  if (retained?.phase !== 'ready' || !matches(readDatabaseGuard(db), retained)) {
    throw refuses('SQLite does not match a ready retained generation');
  }
  return ERASURE_RECOVERY_VERSION;
}

function hasPersonalEvents(db) {
  return db.prepare('PRAGMA table_info(behavior_events)').all().some(column => column.name === 'subject_key');
}

export function assertSnapshotPreservesErasures(snapshot, target, targetDb) {
  const retained = readGuardFile(target);
  const sourceDb = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const source = readDatabaseGuard(sourceDb);
    if (retained?.phase === 'ready' && matches(source, retained)) return;
    if (retained || source || hasPersonalEvents(sourceDb) ||
        (targetDb && (readDatabaseGuard(targetDb) || hasPersonalEvents(targetDb)))) {
      throw refuses('snapshot cannot prove it preserves acknowledged erasures; use a verified snapshot with the retained lineage and generation');
    }
  } finally {
    sourceDb.close();
  }
}

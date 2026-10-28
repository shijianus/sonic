#!/usr/bin/env node
// Consistent SQLite backup using VACUUM INTO, followed by a reopen + integrity_check.
// Usage: node scripts/backup-recommend-db.mjs [source.sqlite] [destination.sqlite]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const source = path.resolve(
  process.argv[2] || process.env.SONIC_RECOMMEND_DB_PATH || 'data/sonic-recommend.sqlite',
);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.resolve(
  process.argv[3] || `${source}.backup-${stamp}.sqlite`,
);

if (!fs.existsSync(source)) {
  console.error(`[backup] source database not found: ${source}`);
  process.exit(1);
}
if (fs.existsSync(destination)) {
  console.error(`[backup] refusing to overwrite existing file: ${destination}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });

const escapedDestination = destination.replace(/'/g, "''");
let db;
try {
  db = new DatabaseSync(source);
  db.exec(`VACUUM INTO '${escapedDestination}'`);
  db.close();
  db = undefined;

  const restored = new DatabaseSync(destination);
  const row = restored.prepare('PRAGMA integrity_check').get();
  const stats = restored
    .prepare('SELECT (SELECT COUNT(*) FROM canonical_tracks) AS tracks, (SELECT COUNT(*) FROM behavior_events) AS events')
    .get();
  restored.close();

  const result = row?.integrity_check ?? Object.values(row || {})[0];
  if (String(result).toLowerCase() !== 'ok') {
    throw new Error(`integrity_check failed: ${String(result)}`);
  }
  const size = fs.statSync(destination).size;
  console.log(
    JSON.stringify({
      ok: true,
      source,
      destination,
      sizeBytes: size,
      tracks: Number(stats?.tracks || 0),
      events: Number(stats?.events || 0),
    }),
  );
} catch (error) {
  try {
    db?.close();
  } catch {}
  try {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
  } catch {}
  console.error(`[backup] failed: ${error?.message || error}`);
  process.exit(1);
}

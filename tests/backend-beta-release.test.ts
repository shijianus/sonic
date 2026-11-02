import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, digestFile, verifyDatabase } from '../scripts/backup-recommend-db.mjs';
import { restoreDatabase } from '../scripts/restore-recommend-db.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-beta-release-'));
  temporaryDirectories.push(directory);
  return { directory, source: path.join(directory, 'source.sqlite'), backup: path.join(directory, 'backup.sqlite'), target: path.join(directory, 'target.sqlite') };
}

function database(file: string, value: string, wal = false) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=${wal ? 'WAL' : 'DELETE'}; CREATE TABLE canonical_tracks(id TEXT PRIMARY KEY); CREATE TABLE behavior_events(event_id TEXT PRIMARY KEY);`);
  db.prepare('INSERT INTO canonical_tracks VALUES (?)').run(value);
  db.prepare('INSERT INTO behavior_events VALUES (?)').run(value);
  return db;
}

function ids(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT id FROM canonical_tracks ORDER BY id').all().map(row => row.id); }
  finally { db.close(); }
}

function closedDatabase(file: string, value: string, wal = false) {
  database(file, value, wal).close();
}

const root = path.resolve(import.meta.dirname, '..');

describe('beta release SQLite backup and offline recovery', () => {
  it('backs up committed WAL data while an online writer is open, with a verifiable digest', () => {
    const files = fixture();
    const writer = database(files.source, 'committed-wal', true);
    try {
      expect(fs.statSync(files.source + '-wal').size).toBeGreaterThan(0);
      const result = backupDatabase(files.source, files.backup);
      expect(result).toMatchObject({ ok: true, tracks: 1, events: 1 });
      expect(result.sha256).toBe(digestFile(files.backup));
      expect(ids(files.backup)).toEqual(['committed-wal']);
      writer.prepare('INSERT INTO canonical_tracks VALUES (?)').run('written-after-backup');
      expect(ids(files.backup)).toEqual(['committed-wal']);
      expect(fs.existsSync(files.backup + '-wal')).toBe(false);
    } finally { writer.close(); }
  });

  it('never overwrites an existing backup and fails closed when disk reserve cannot be met', () => {
    const files = fixture();
    closedDatabase(files.source, 'source');
    fs.writeFileSync(files.backup, 'must remain');
    expect(() => backupDatabase(files.source, files.backup)).toThrow(/overwrite/);
    expect(fs.readFileSync(files.backup, 'utf8')).toBe('must remain');
    vi.stubEnv('SONIC_MIN_FREE_DISK_MB', String(Number.MAX_SAFE_INTEGER));
    expect(() => backupDatabase(files.source, files.backup + '.other')).toThrow(/free disk/);
    expect(fs.existsSync(files.backup + '.other')).toBe(false);
  });

  it('requires explicit offline acknowledgement before touching the target', () => {
    const files = fixture();
    closedDatabase(files.backup, 'backup');
    closedDatabase(files.target, 'original');
    const original = digestFile(files.target);
    const result = spawnSync(process.execPath, ['--experimental-sqlite', path.join(root, 'scripts/restore-recommend-db.mjs'), files.backup, files.target], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--offline');
    expect(digestFile(files.target)).toBe(original);
    expect(fs.readdirSync(files.directory).sort()).toEqual(['backup.sqlite', 'target.sqlite']);
  });

  it('refuses an active WAL target without unlinking WAL/SHM or dropping a committed row', () => {
    const files = fixture();
    closedDatabase(files.backup, 'backup');
    const writer = database(files.target, 'active-target', true);
    try {
      const before = fs.readFileSync(files.target + '-wal');
      expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/active or uncheckpointed/);
      expect(fs.readFileSync(files.target + '-wal')).toEqual(before);
      expect(fs.existsSync(files.target + '-shm')).toBe(true);
      expect(ids(files.target)).toEqual(['active-target']);
      writer.prepare('INSERT INTO canonical_tracks VALUES (?)').run('writer-still-works');
    } finally { writer.close(); }
  });

  it('refuses live rollback-journal writers and leaves the writer transaction intact', () => {
    const files = fixture();
    closedDatabase(files.backup, 'backup');
    const writer = database(files.target, 'original');
    writer.exec("BEGIN IMMEDIATE; INSERT INTO canonical_tracks VALUES ('uncommitted')");
    try {
      expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/active or uncheckpointed|locked|busy/i);
      expect(writer.prepare("SELECT COUNT(*) AS n FROM canonical_tracks WHERE id='uncommitted'").get()?.n).toBe(1);
    } finally { writer.exec('ROLLBACK'); writer.close(); }
  });

  it('refuses a backup with WAL sidecars and an invalid backup before replacing a valid target', () => {
    const files = fixture();
    closedDatabase(files.target, 'original');
    const original = digestFile(files.target);
    const writer = database(files.backup, 'backup-wal', true);
    try { expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/uncheckpointed/); }
    finally { writer.close(); }
    fs.writeFileSync(files.backup, 'not a SQLite database');
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow();
    expect(digestFile(files.target)).toBe(original);
    expect(fs.existsSync(files.target + '.maintenance-lock')).toBe(false);
  });

  it('respects a startup/maintenance lock without deleting an unknown owner lock', () => {
    const files = fixture();
    closedDatabase(files.backup, 'backup');
    closedDatabase(files.target, 'original');
    const lock = files.target + '.maintenance-lock';
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), '{"pid":123,"operation":"startup"}');
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/maintenance lock/);
    expect(fs.existsSync(path.join(lock, 'owner.json'))).toBe(true);
    expect(ids(files.target)).toEqual(['original']);
  });

  it('restores atomically through the real CLI, verifies a safety snapshot, then rolls back using that snapshot', () => {
    const files = fixture();
    closedDatabase(files.backup, 'restored');
    closedDatabase(files.target, 'original', true);
    const output = execFileSync(process.execPath, ['--experimental-sqlite', path.join(root, 'scripts/restore-recommend-db.mjs'), files.backup, files.target, '--offline'], { encoding: 'utf8' });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ ok: true, target: files.target, tracks: 1, events: 1 });
    expect(ids(files.target)).toEqual(['restored']);
    expect(ids(result.preRestoreSafetyCopy)).toEqual(['original']);
    expect(result.sha256).toBe(digestFile(files.target));
    const rollback = restoreDatabase(result.preRestoreSafetyCopy, files.target, { offline: true });
    expect(rollback.ok).toBe(true);
    expect(ids(files.target)).toEqual(['original']);
    expect(fs.readdirSync(files.directory).some(name => /restoring-|rollback-|maintenance-lock/.test(name))).toBe(false);
  });

  it('leaves the target unchanged if the atomic replacement fails', () => {
    const files = fixture();
    closedDatabase(files.backup, 'restored');
    closedDatabase(files.target, 'original');
    const before = digestFile(files.target);
    const io = { renameSync() { throw new Error('simulated rename failure'); } };
    expect(() => restoreDatabase(files.backup, files.target, { offline: true, io })).toThrow('simulated rename failure');
    expect(digestFile(files.target)).toBe(before);
    expect(verifyDatabase(files.target)).toEqual({ tracks: 1, events: 1 });
  });

  it('verifies automatic rollback when the installed database fails its post-check', () => {
    const files = fixture();
    closedDatabase(files.backup, 'restored');
    closedDatabase(files.target, 'original');
    let renames = 0;
    const io = {
      renameSync(from: string, to: string) {
        fs.renameSync(from, to);
        if (++renames === 1) fs.writeFileSync(to, 'simulated write corruption');
      },
    };
    expect(() => restoreDatabase(files.backup, files.target, { offline: true, io })).toThrow(/original target restored and verified/);
    expect(renames).toBe(2);
    expect(ids(files.target)).toEqual(['original']);
    expect(fs.existsSync(files.target + '.maintenance-lock')).toBe(false);
  });

  it('retains a maintenance lock and recovery snapshot if automatic rollback cannot complete', () => {
    const files = fixture();
    closedDatabase(files.backup, 'restored');
    closedDatabase(files.target, 'original');
    let renames = 0;
    const io = {
      renameSync(from: string, to: string) {
        if (++renames > 1) throw new Error('simulated rollback failure');
        fs.renameSync(from, to);
        fs.writeFileSync(to, 'simulated write corruption');
      },
    };
    expect(() => restoreDatabase(files.backup, files.target, { offline: true, io })).toThrow(/rollback failed.*Maintenance lock retained/);
    expect(fs.existsSync(files.target + '.maintenance-lock')).toBe(true);
    const safety = fs.readdirSync(files.directory).find(name => name.includes('.pre-restore-'))!;
    expect(ids(path.join(files.directory, safety))).toEqual(['original']);
  });

  it('restores a new target and removes it again if its post-check fails', () => {
    const files = fixture();
    closedDatabase(files.backup, 'restored');
    const io = { renameSync(from: string, to: string) { fs.renameSync(from, to); fs.writeFileSync(to, 'simulated corruption'); } };
    expect(() => restoreDatabase(files.backup, files.target, { offline: true, io })).toThrow(/original target restored and verified/);
    expect(fs.existsSync(files.target)).toBe(false);
    expect(fs.existsSync(files.target + '.maintenance-lock')).toBe(false);
  });
});

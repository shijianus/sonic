import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { backupDatabase, digestFile, verifyDatabase } from '../scripts/backup-recommend-db.mjs';
import { restoreDatabase } from '../scripts/restore-recommend-db.mjs';
import { SqliteRecommendStore } from '../server/recommend-sqlite';

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

  it('refuses pre-erasure snapshots and restores the verified current generation with other subjects intact', () => {
    const files = fixture();
    const currentBackup = files.backup + '.current';
    const first = 'anon_first_subject';
    const second = 'anon_other_subject';
    const epoch = 'a'.repeat(32);
    const writer = new SqliteRecommendStore(files.target);
    const peer = new SqliteRecommendStore(files.target);
    try {
      for (const subjectKey of [first, second]) {
        writer.recordEvent({ subjectKey, eventId: 'before-erasure', type: 'search', query: 'temporary', createdAt: Date.now(), weight: 1 });
      }
      backupDatabase(files.target, files.backup);
      expect(peer.clearUserEvents(first, epoch)).toBe(1);
      expect(writer.getEventEpoch(first)).toBe(epoch);
      expect(writer.getStats().erasureRecoveryVersion).toBe(1);
      backupDatabase(files.target, currentBackup);
      writer.recordEvent({ subjectKey: first, eventId: 'after-erasure', type: 'search', query: 'fresh', createdAt: Date.now(), weight: 1 });
    } finally {
      peer.close();
      writer.close();
    }
    const before = digestFile(files.target);
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
    expect(digestFile(files.target)).toBe(before);

    // A lost main file does not permit an older snapshot to become a new database.
    fs.renameSync(files.target, files.source);
    expect(() => new SqliteRecommendStore(files.target)).toThrow(/protected database is missing/);
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
    expect(fs.existsSync(files.target)).toBe(false);
    expect(restoreDatabase(currentBackup, files.target, { offline: true })).toMatchObject({ ok: true, events: 1 });

    const recovered = new SqliteRecommendStore(files.target);
    try {
      expect(recovered.getUserEvents(first)).toEqual([]);
      expect(recovered.getUserEvents(second).map(event => event.eventId)).toEqual(['before-erasure']);
      expect(recovered.getEventEpoch(first)).toBe(epoch);
      expect(() => recovered.withEventEpoch(first, null, () => undefined)).toThrow();
      expect(recovered.withEventEpoch(first, epoch, () => 'current')).toBe('current');
    } finally { recovered.close(); }
  });

  it('fails closed on a replaced or untracked protected database, including after anonymous epoch rollover', () => {
    vi.stubEnv('SONIC_RECOMMEND_MAX_ANON_ERASURE_ROWS', '1');
    const files = fixture();
    const store = new SqliteRecommendStore(files.target);
    try {
      store.clearUserEvents('anon_first_subject', 'a'.repeat(32));
      backupDatabase(files.target, files.backup);
      store.clearUserEvents('anon_other_subject', 'b'.repeat(32));
      expect(store.getEventEpoch('anon_first_subject')).not.toBe('a'.repeat(32));
      backupDatabase(files.target, files.source);
    } finally { store.close(); }
    fs.copyFileSync(files.backup, files.target);
    expect(() => new SqliteRecommendStore(files.target)).toThrow(/does not match the retained/);
    expect(restoreDatabase(files.source, files.target, { offline: true })).toMatchObject({ ok: true });
    fs.unlinkSync(files.target + '.erasure-recovery.json');
    expect(() => new SqliteRecommendStore(files.target)).toThrow(/does not match the retained/);
    expect(() => restoreDatabase(files.source, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
  });

  it('seals a committed pending guard on startup and rejects a pending generation absent from SQLite', () => {
    const files = fixture();
    const filename = files.target + '.erasure-recovery.json';
    const store = new SqliteRecommendStore(files.target);
    store.close();
    const ready = JSON.parse(fs.readFileSync(filename, 'utf8'));
    fs.writeFileSync(filename, JSON.stringify({ ...ready, phase: 'erasing' }));
    const recovered = new SqliteRecommendStore(files.target);
    recovered.close();
    expect(JSON.parse(fs.readFileSync(filename, 'utf8'))).toEqual(ready);
    backupDatabase(files.target, files.backup);
    fs.writeFileSync(filename, JSON.stringify({ ...ready, generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', phase: 'erasing' }));
    expect(() => new SqliteRecommendStore(files.target)).toThrow(/does not match the retained/);
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
  });

  it.each([false, true])('restarts after abrupt erasure interruption (SQLite committed=%s)', committed => {
    const files = fixture();
    const guardPath = files.target + '.erasure-recovery.json';
    const subject = 'usr_interrupted_erasure';
    const store = new SqliteRecommendStore(files.target);
    store.recordEvent({ subjectKey: subject, eventId: 'before-interruption', type: 'search', query: 'old', createdAt: Date.now(), weight: 1 });
    store.close();
    const ready = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    backupDatabase(files.target, files.backup);

    const helper = pathToFileURL(path.join(root, 'scripts/recommend-recovery-guard.mjs')).href;
    const child = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', `
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const [target, helper, subject, committed] = process.argv.slice(1);
      const { eraseWithRecoveryGuard } = await import(helper);
      const db = new DatabaseSync(target);
      const rename = fs.renameSync;
      const interrupt = () => process.platform === 'win32' ? process.exit(73) : process.kill(process.pid, 'SIGKILL');
      fs.renameSync = (from, to) => {
        const phase = to === target + '.erasure-recovery.json' && JSON.parse(fs.readFileSync(from, 'utf8')).phase;
        if (committed === 'true' && phase === 'ready') interrupt();
        rename(from, to);
        if (committed === 'false' && phase === 'erasing') interrupt();
      };
      eraseWithRecoveryGuard(db, target, () => db.prepare('DELETE FROM behavior_events WHERE subject_key = ?').run(subject));
    `, files.target, helper, subject, String(committed)], { encoding: 'utf8' });
    if (process.platform === 'win32') expect(child.status, child.stderr).toBe(73);
    else expect(child.signal, child.stderr).toBe('SIGKILL');

    const pending = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
    expect(pending).toMatchObject({ lineage: ready.lineage, phase: 'erasing', previousGeneration: ready.generation });
    expect(pending.generation).not.toBe(ready.generation);
    expect(() => backupDatabase(files.target, files.source)).toThrow(/backup does not match the ready retained generation/);
    expect(fs.existsSync(files.source)).toBe(false);
    fs.copyFileSync(guardPath, files.source + '.erasure-recovery.json');
    expect(() => restoreDatabase(files.backup, files.source, { offline: true })).toThrow(/preserves acknowledged erasures/);
    expect(fs.existsSync(files.source)).toBe(false);

    const recovered = new SqliteRecommendStore(files.target);
    try {
      expect(recovered.getStats().erasureRecoveryVersion).toBe(1);
      expect(recovered.getUserEvents(subject)).toHaveLength(committed ? 0 : 1);
      expect(JSON.parse(fs.readFileSync(guardPath, 'utf8'))).toEqual({ ...ready,
        generation: committed ? pending.generation : ready.generation });
    } finally { recovered.close(); }
    if (committed) expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
    else expect(restoreDatabase(files.backup, files.target, { offline: true })).toMatchObject({ ok: true, events: 1 });
  });

  it.each(['missing', 'tampered'])('rejects event writes and new snapshots with a %s live guard', state => {
    const files = fixture();
    const filename = files.target + '.erasure-recovery.json';
    const store = new SqliteRecommendStore(files.target);
    try {
      const ready = fs.readFileSync(filename, 'utf8');
      if (state === 'missing') fs.unlinkSync(filename);
      else fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(ready), generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
      const write = vi.fn(() => 'accepted');
      expect(() => store.withEventEpoch('usr_untrusted_recovery', null, write)).toThrow(/ready retained generation/);
      expect(write).not.toHaveBeenCalled();
      expect(() => backupDatabase(files.target, files.backup)).toThrow(/backup does not match the ready retained generation/);
      expect(fs.existsSync(files.backup)).toBe(false);
      fs.writeFileSync(filename, ready);
      expect(store.withEventEpoch('usr_untrusted_recovery', null, write)).toBe('accepted');
      expect(backupDatabase(files.target, files.backup)).toMatchObject({ ok: true });
    } finally { store.close(); }
  });

  it('upgrades an existing legacy store in place and rejects untracked personal backups', () => {
    const files = fixture();
    const store = new SqliteRecommendStore(files.target);
    const subjectKey = 'usr_legacy_subject';
    store.recordEvent({ subjectKey, eventId: 'legacy', type: 'search', query: 'old', createdAt: Date.now(), weight: 1 });
    store.close();
    const legacy = new DatabaseSync(files.target);
    legacy.exec('DROP TABLE recommendation_recovery_guard');
    legacy.close();
    fs.unlinkSync(files.target + '.erasure-recovery.json');
    backupDatabase(files.target, files.backup);
    expect(() => restoreDatabase(files.backup, files.source, { offline: true })).toThrow(/preserves acknowledged erasures/);
    const upgraded = new SqliteRecommendStore(files.target);
    expect(upgraded.getUserEvents(subjectKey)).toHaveLength(1);
    expect(upgraded.getStats().erasureRecoveryVersion).toBe(1);
    upgraded.close();
    expect(() => restoreDatabase(files.backup, files.target, { offline: true })).toThrow(/preserves acknowledged erasures/);
  });
});

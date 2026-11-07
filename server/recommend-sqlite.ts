// Sonic Local Engine — Native SQLite (WAL + FTS5) Persistent Recommendation & Search Store
// Runs on Linux VPS Node.js 22 (`node:sqlite` built-in, zero native C++ npm dependencies).
// Falls back to `MemoryRecommendStore` only in development/tests or with an explicit opt-in;
// production startup fails closed instead of pretending persistence works.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  CanonicalTrack,
  EntityRelation,
  RecommendContributionSource,
  RecommendStore,
  SonicEntity,
  SonicEntityType,
  StoredBehaviorEvent,
  TrackEdition,
  UserEntityFeedback,
} from '../functions/_lib/sonic/recommend/types';
import {
  buildFtsTokens,
  compactNormalize,
  computeFuzzySimilarity,
  expandQueryAliases,
  toPinyinInfo,
} from '../functions/_lib/sonic/recommend/text-norm';
import { canMergeCanonicalTracks, mergeCanonicalTracks } from '../functions/_lib/sonic/recommend/track-canonical';
import { MemoryRecommendStore, normalizeRecommendRetentionDays } from '../functions/_lib/sonic/recommend/memory-store';
import { upsertTrackMvEntities } from '../functions/_lib/sonic/recommend/entity-store';
import { recordSqliteMetric, redactSensitiveString } from '../functions/_lib/sonic/observability';

// Hard ceiling for the shared canonical catalog. Search traffic is persisted
// into this table, so an unbounded catalog is a disk-exhaustion vector.
const MAX_CANONICAL_TRACKS = 100_000;
// Hard row ceilings for anonymous-writable tables. Every one of these is fed by
// public traffic, so without a cap a single client can grow the SQLite file
// without bound (audit P0-1: ~213 bytes/event => ~1.2 GB/day/IP unbounded).
// Operators may tighten the budgets via env; the defaults stay generous.
const MAX_BEHAVIOR_EVENTS = readPositiveEnvInt('SONIC_RECOMMEND_MAX_EVENT_ROWS', 2_000_000);
const MAX_USER_ENTITY_FEEDBACK = readPositiveEnvInt('SONIC_RECOMMEND_MAX_FEEDBACK_ROWS', 1_000_000);
// Catalog entities/relations are public-write-adjacent (every successful mv/*
// response ingests up to 100 rows), so they get their own budgets (audit P1-1).
const MAX_ENTITIES = readPositiveEnvInt('SONIC_RECOMMEND_MAX_ENTITIES', 50_000);
const MAX_ENTITY_RELATIONS = readPositiveEnvInt('SONIC_RECOMMEND_MAX_ENTITY_RELATIONS', 200_000);

function readPositiveEnvInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export class SqliteRecommendStore implements RecommendStore {
  public readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private writeCounter = 0;
  private retentionDays: number;
  private lastRetentionAt = 0;
  private canonicalTrackCount = -1;
  private entityCount = -1;
  private lastDiskCheckAt = 0;
  private lastDiskCheckOk = true;
  private anonEventRetentionDays: number;

  constructor(public readonly dbPath: string = ':memory:', retentionDays: number | string = process.env.SONIC_RECOMMEND_RETENTION_DAYS || 90) {
    this.retentionDays = normalizeRecommendRetentionDays(retentionDays);
    const configuredAnonDays = readPositiveEnvInt('SONIC_ANON_EVENT_RETENTION_DAYS', 7);
    this.anonEventRetentionDays = Math.min(this.retentionDays, Math.max(1, configuredAnonDays));
    if (dbPath !== ':memory:') {
      const resolved = path.resolve(dbPath);
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      // The DB holds per-user behavioral data: refuse to open anything that is
      // not a plain regular file (a symlink or directory swap would bypass the
      // permission model), then pin owner-only modes on it and its sidecars.
      if (fs.existsSync(resolved)) {
        const stat = fs.lstatSync(resolved);
        if (!stat.isFile()) {
          throw new Error(`Recommend DB path is not a regular file: ${resolved}`);
        }
      }
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:' && process.platform !== 'win32') {
      try {
        const resolved = path.resolve(dbPath);
        fs.chmodSync(resolved, 0o600);
        for (const suffix of ['-wal', '-shm']) {
          const sidecar = `${resolved}${suffix}`;
          if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
        }
        const parent = path.dirname(resolved);
        if ((fs.statSync(parent).mode & 0o077) !== 0) {
          fs.chmodSync(parent, 0o700);
        }
      } catch {
        // Best-effort hardening (e.g. read-only mount); startup continues.
      }
    }
    try {
      this.initSchema();
      this.pruneRetention();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16000;
      PRAGMA foreign_keys = ON;
    `);
    // Storage budget (audit P0-1): cap the database file so a flood of anonymous
    // events cannot exhaust the volume. The PRAGMA fails when an existing file is
    // already larger than the budget — keep the store usable in that case and let
    // retention pruning shrink it back under the ceiling.
    const maxDbBytes = readPositiveEnvInt('SONIC_RECOMMEND_DB_MAX_BYTES', 1024 * 1024 * 1024);
    try {
      const pageSizeRow = this.db.prepare('PRAGMA page_size').get() as { page_size?: number } | undefined;
      const pageSize = Number(pageSizeRow?.page_size || 4096) || 4096;
      const maxPages = Math.max(1024, Math.floor(maxDbBytes / pageSize));
      this.db.exec(`PRAGMA max_page_count = ${maxPages};`);
    } catch {
      recordSqliteMetric('write_error');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canonical_tracks (
        canonical_track_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_track_id TEXT NOT NULL,
        clean_title TEXT NOT NULL,
        canonical_artist_norm TEXT NOT NULL,
        edition TEXT NOT NULL,
        pinyin_full TEXT NOT NULL,
        pinyin_initials TEXT NOT NULL,
        external_popularity REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tracks_title_artist
        ON canonical_tracks(clean_title, canonical_artist_norm, edition);
      CREATE INDEX IF NOT EXISTS idx_tracks_updated
        ON canonical_tracks(updated_at DESC);

      CREATE TABLE IF NOT EXISTS platform_track_links (
        link_key TEXT PRIMARY KEY,
        canonical_track_id TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
        canonical_track_id UNINDEXED,
        title_tokens,
        artist_tokens,
        album_tokens,
        pinyin_tokens,
        genre_tokens,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS behavior_events (
        event_id TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        canonical_track_id TEXT,
        artist_key TEXT,
        genres_json TEXT,
        language TEXT,
        query TEXT,
        weight REAL NOT NULL,
        progress_ratio REAL,
        created_at INTEGER NOT NULL,
        track_ref TEXT,
        PRIMARY KEY (subject_key, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_subject_time
        ON behavior_events(subject_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_time
        ON behavior_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS track_cooccurrence (
        track_a TEXT NOT NULL,
        track_b TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (track_a, track_b)
      );

      CREATE INDEX IF NOT EXISTS idx_cooc_a_weight
        ON track_cooccurrence(track_a, weight DESC);

      CREATE TABLE IF NOT EXISTS search_queries (
        norm_query TEXT PRIMARY KEY,
        display_query TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_query_contributions (
        subject_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        norm_query TEXT NOT NULL,
        display_query TEXT NOT NULL,
        hit_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (subject_key, event_id, norm_query),
        FOREIGN KEY (subject_key, event_id) REFERENCES behavior_events(subject_key, event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_query_contributions_query
        ON search_query_contributions(norm_query);
      CREATE INDEX IF NOT EXISTS idx_query_contributions_time
        ON search_query_contributions(created_at);

      CREATE TABLE IF NOT EXISTS cooccurrence_contributions (
        subject_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        track_a TEXT NOT NULL,
        track_b TEXT NOT NULL,
        weight REAL NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (subject_key, event_id, track_a, track_b),
        FOREIGN KEY (subject_key, event_id) REFERENCES behavior_events(subject_key, event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cooc_contributions_tracks
        ON cooccurrence_contributions(track_a, track_b);
      CREATE INDEX IF NOT EXISTS idx_cooc_contributions_time
        ON cooccurrence_contributions(created_at);

      CREATE TABLE IF NOT EXISTS entities (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        artist_id TEXT,
        artist_name TEXT,
        cover_url TEXT,
        source TEXT NOT NULL DEFAULT 'sonic',
        source_id TEXT,
        tags_json TEXT,
        language TEXT,
        duration INTEGER DEFAULT 0,
        external_popularity REAL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type_updated
        ON entities(entity_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entities_artist
        ON entities(artist_name);

      CREATE TABLE IF NOT EXISTS entity_relations (
        relation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        parent_type TEXT NOT NULL,
        child_id TEXT NOT NULL,
        child_type TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        position INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rel_parent
        ON entity_relations(parent_id, child_id);
      CREATE INDEX IF NOT EXISTS idx_rel_child
        ON entity_relations(child_id, parent_id);

      CREATE TABLE IF NOT EXISTS user_entity_feedback (
        feedback_id TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        weight REAL NOT NULL,
        progress REAL,
        context_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (subject_key, feedback_id)
      );

      CREATE INDEX IF NOT EXISTS idx_uef_user_time
        ON user_entity_feedback(subject_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uef_entity_time
        ON user_entity_feedback(entity_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uef_user_entity
        ON user_entity_feedback(subject_key, entity_id);

      CREATE TABLE IF NOT EXISTS entity_stats (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        play_count INTEGER DEFAULT 0,
        complete_count INTEGER DEFAULT 0,
        favorite_count INTEGER DEFAULT 0,
        open_count INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        score REAL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_radar_profiles (
        subject_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.migrateSubjectEventKeys();
  }

  private migrateSubjectEventKeys(): void {
    // SQLite cannot drop an inline PK/UNIQUE constraint. Rebuild only the affected
    // tables in one write transaction; any unexpected schema/duplicate fails closed.
    // Inspect indexes as well as table_info: some deployments have event_id UNIQUE.
    // FK enforcement must stay OFF for the rebuild: dropping the parent
    // behavior_events table with foreign_keys=ON would fire the contributions'
    // ON DELETE CASCADE and silently erase every retained contribution row.
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(behavior_events)').all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'track_ref')) this.db.exec('ALTER TABLE behavior_events ADD COLUMN track_ref TEXT');
      for (const [table, id] of [['behavior_events', 'event_id'], ['user_entity_feedback', 'feedback_id']] as const) {
        const indexes = this.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; partial: number }>;
        const uniqueColumns = indexes.filter((i) => i.unique).map((i) => ({
          ...i, columns: (this.db.prepare(`PRAGMA index_info(${quote(i.name)})`).all() as Array<{ name: string }>).map((c) => c.name),
        }));
        const hasScoped = uniqueColumns.some((i) => !i.partial && i.columns.length === 2 && i.columns.includes(id) && i.columns.includes('subject_key'));
        const hasGlobal = uniqueColumns.some((i) => i.columns.length === 1 && i.columns[0] === id);
        if (hasScoped && !hasGlobal) continue;
        const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
        const ancillary = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL")
          .all(table) as Array<{ sql: string }>;
        const replacement = `${table}_subject_key_migration`;
        let sql = schema.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `CREATE TABLE ${replacement}`);
        const idPattern = `(?:"${id}"|\\[${id}\\]|${id})`;
        sql = sql.replace(new RegExp(`(${idPattern}\\s+TEXT(?:\\s+NOT\\s+NULL)?)\\s+(?:PRIMARY\\s+KEY|UNIQUE)`, 'ig'), '$1');
        sql = sql.replace(new RegExp(`,\\s*(?:CONSTRAINT\\s+\\w+\\s+)?(?:PRIMARY\\s+KEY|UNIQUE)\\s*\\(\\s*${idPattern}\\s*\\)`, 'ig'), '');
        if (!hasScoped) sql = sql.replace(/\)(\s*(?:WITHOUT ROWID|STRICT)?\s*;?\s*)$/i, `, UNIQUE(subject_key, ${id}))$1`);
        this.db.exec(sql);
        const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => quote(c.name)).join(', ');
        this.db.exec(`INSERT INTO ${replacement} (${cols}) SELECT ${cols} FROM ${table}`);
        this.db.exec(`DROP TABLE ${table}; ALTER TABLE ${replacement} RENAME TO ${table}`);
        for (const item of ancillary) {
          // Standalone global UNIQUE indexes are the other old schema variant.
          if (/^CREATE\s+UNIQUE\s+INDEX/i.test(item.sql) && new RegExp(`\\(\\s*${idPattern}\\s*\\)`, 'i').test(item.sql)) continue;
          this.db.exec(item.sql);
        }
        const migratedIndexes = this.db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; partial: number }>;
        const keys = migratedIndexes.filter((i) => i.unique).map((i) => ({
          ...i, columns: (this.db.prepare(`PRAGMA index_info(${quote(i.name)})`).all() as Array<{ name: string }>).map((c) => c.name),
        }));
        if (keys.some((i) => i.columns.length === 1 && i.columns[0] === id) ||
            !keys.some((i) => !i.partial && i.columns.length === 2 && i.columns.includes(id) && i.columns.includes('subject_key'))) {
          throw new Error(`Unsupported event-key schema for ${table}; migration rolled back`);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private beforeWrite(): void {
    if (++this.writeCounter >= 1500 || Date.now() - this.lastRetentionAt >= 3600_000) {
      this.pruneRetention();
    }
  }

  /**
   * Write-path disk gate (audit P0-1). The health endpoint alone cannot stop a
   * flood: anonymous event writes must be refused once the SQLite volume is
   * below the free-space threshold, instead of filling the disk until SQLite
   * itself crashes. Result is cached briefly to keep statfs off the hot path.
   */
  private ensureDiskBudget(): void {
    if (this.dbPath === ':memory:') return;
    const now = Date.now();
    if (now - this.lastDiskCheckAt > 30_000) {
      this.lastDiskCheckAt = now;
      try {
        const minFreeMb = readPositiveEnvInt('SONIC_MIN_FREE_DISK_MB', 64);
        const dir = path.dirname(path.resolve(this.dbPath));
        if (typeof fs.statfsSync === 'function') {
          const stat = fs.statfsSync(dir);
          const freeBytes = Number(stat.bavail) * Number(stat.bsize || 4096);
          this.lastDiskCheckOk = freeBytes >= minFreeMb * 1024 * 1024;
        } else {
          this.lastDiskCheckOk = true;
        }
      } catch {
        // Unreadable statfs must not brick all writes; the health check reports it.
        this.lastDiskCheckOk = true;
      }
    }
    if (!this.lastDiskCheckOk) {
      throw new RecommendStoreBudgetExceededError('disk_below_threshold');
    }
  }

  private currentEntityCount(): number {
    if (this.entityCount < 0) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c?: number } | undefined;
      this.entityCount = Number(row?.c || 0);
    }
    return this.entityCount;
  }

  private currentTrackCount(): number {
    if (this.canonicalTrackCount < 0) {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM canonical_tracks').get() as { c?: number } | undefined;
      this.canonicalTrackCount = Number(row?.c || 0);
    }
    return this.canonicalTrackCount;
  }

  upsertTrack(incoming: CanonicalTrack): void {
    if (!incoming?.canonicalTrackId) return;
    this.beforeWrite();

    const existing = this.getTrack(incoming.canonicalTrackId);
    let finalTrack = incoming;
    if (existing && canMergeCanonicalTracks(existing, incoming)) {
      finalTrack = mergeCanonicalTracks(existing, incoming);
    } else if (existing && !canMergeCanonicalTracks(existing, incoming)) {
      finalTrack = {
        ...incoming,
        canonicalTrackId: `${incoming.canonicalTrackId}_${incoming.duration || 'alt'}`,
      };
    }

    // The catalog is shared by every user and search results are persisted into
    // it. Without a hard ceiling, anonymous search traffic can grow the SQLite
    // file without bound. Existing rows still refresh; only brand-new rows are
    // refused once the cap is reached.
    const targetExisted = finalTrack.canonicalTrackId === incoming.canonicalTrackId
      ? Boolean(existing)
      : Boolean(this.getTrack(finalTrack.canonicalTrackId));
    if (!targetExisted && this.currentTrackCount() >= MAX_CANONICAL_TRACKS) return;

    const artistNorm = compactNormalize(finalTrack.canonicalArtist);
    const payloadJson = JSON.stringify(finalTrack);

    const upsertStmt = this.db.prepare(`
      INSERT INTO canonical_tracks (
        canonical_track_id, provider, provider_track_id, clean_title, canonical_artist_norm,
        edition, pinyin_full, pinyin_initials, external_popularity, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_track_id) DO UPDATE SET
        provider = excluded.provider,
        provider_track_id = excluded.provider_track_id,
        external_popularity = excluded.external_popularity,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);

    upsertStmt.run(
      finalTrack.canonicalTrackId,
      finalTrack.provider,
      finalTrack.providerTrackId,
      finalTrack.cleanTitle,
      artistNorm,
      finalTrack.edition,
      finalTrack.pinyinFull,
      finalTrack.pinyinInitials,
      finalTrack.externalPopularity,
      finalTrack.updatedAt,
      payloadJson,
    );

    // Update platform links
    const linkStmt = this.db.prepare(`
      INSERT OR REPLACE INTO platform_track_links (link_key, canonical_track_id)
      VALUES (?, ?)
    `);
    if (finalTrack.provider && finalTrack.providerTrackId) {
      linkStmt.run(`${finalTrack.provider}:${finalTrack.providerTrackId}`, finalTrack.canonicalTrackId);
      linkStmt.run(`raw:${finalTrack.providerTrackId}`, finalTrack.canonicalTrackId);
    }
    for (const [plat, pid] of Object.entries(finalTrack.sourceIds || {})) {
      if (plat && pid) {
        linkStmt.run(`${plat}:${pid}`, finalTrack.canonicalTrackId);
        linkStmt.run(`raw:${pid}`, finalTrack.canonicalTrackId);
      }
    }

    // Refresh FTS5 document
    this.db.prepare(`DELETE FROM tracks_fts WHERE canonical_track_id = ?`).run(finalTrack.canonicalTrackId);
    const artistPy = toPinyinInfo(finalTrack.canonicalArtist);
    const titleTokens = buildFtsTokens(`${finalTrack.title} ${finalTrack.simpTitle} ${finalTrack.cleanTitle}`);
    const artistTokens = buildFtsTokens(`${finalTrack.canonicalArtist} ${finalTrack.artists.join(' ')}`);
    const albumTokens = buildFtsTokens(finalTrack.album);
    const pinyinTokens = `${finalTrack.pinyinFull} ${finalTrack.pinyinInitials} ${artistPy.full} ${artistPy.initials}`.trim();
    const genreTokens = [...finalTrack.genres, ...finalTrack.tags, finalTrack.language].join(' ');

    this.db
      .prepare(
        `INSERT INTO tracks_fts (canonical_track_id, title_tokens, artist_tokens, album_tokens, pinyin_tokens, genre_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(finalTrack.canonicalTrackId, titleTokens, artistTokens, albumTokens, pinyinTokens, genreTokens);
    upsertTrackMvEntities(this, finalTrack);
    if (!targetExisted && this.canonicalTrackCount >= 0) this.canonicalTrackCount += 1;
  }

  upsertTracks(tracks: CanonicalTrack[]): void {
    if (tracks.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of tracks) {
        this.upsertTrack(t);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      // The in-memory counter may have advanced for rows that were rolled back.
      this.canonicalTrackCount = -1;
      throw err;
    }
  }

  getTrack(idOrPlatformId: string): CanonicalTrack | null {
    if (!idOrPlatformId) return null;
    const directRow = this.db
      .prepare(`SELECT payload_json FROM canonical_tracks WHERE canonical_track_id = ?`)
      .get(idOrPlatformId) as { payload_json?: string } | undefined;
    if (directRow?.payload_json) {
      return this.safeParseTrack(directRow.payload_json);
    }

    const linkKey = idOrPlatformId.includes(':') ? idOrPlatformId : `raw:${idOrPlatformId}`;
    const linkRow = this.db
      .prepare(`SELECT canonical_track_id FROM platform_track_links WHERE link_key = ?`)
      .get(linkKey) as { canonical_track_id?: string } | undefined;
    if (linkRow?.canonical_track_id) {
      const row2 = this.db
        .prepare(`SELECT payload_json FROM canonical_tracks WHERE canonical_track_id = ?`)
        .get(linkRow.canonical_track_id) as { payload_json?: string } | undefined;
      if (row2?.payload_json) return this.safeParseTrack(row2.payload_json);
    }
    return null;
  }

  findTrackByTitleArtist(cleanTitle: string, canonicalArtist: string, edition: TrackEdition = 'studio'): CanonicalTrack | null {
    const row = this.db
      .prepare(
        `SELECT payload_json FROM canonical_tracks
         WHERE clean_title = ? AND canonical_artist_norm = ? AND edition = ?
         LIMIT 1`,
      )
      .get(cleanTitle, compactNormalize(canonicalArtist), edition) as { payload_json?: string } | undefined;
    return row?.payload_json ? this.safeParseTrack(row.payload_json) : null;
  }

  listTracks(limit = 500): CanonicalTrack[] {
    const rows = this.db
      .prepare(`SELECT payload_json FROM canonical_tracks ORDER BY updated_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(3000, limit))) as Array<{ payload_json: string }>;
    const out: CanonicalTrack[] = [];
    for (const r of rows) {
      const parsed = this.safeParseTrack(r.payload_json);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  searchLocalTracks(query: string, limit = 30): CanonicalTrack[] {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const exp = expandQueryAliases(trimmed);
    const foundMap = new Map<string, CanonicalTrack>();

    // 1. SQLite FTS5 BM25 lexical + CJK bigram + Pinyin prefix search
    const rawFtsTerms = buildFtsTokens(
      [exp.simplified, exp.matchedArtist || '', ...exp.expandedQueries, ...exp.inferredGenres].join(' '),
    )
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9\u4e00-\u9fff]/gi, ''))
      .filter((t) => t.length >= 1)
      .slice(0, 10);

    if (rawFtsTerms.length > 0) {
      const ftsExpr = rawFtsTerms.map((t) => `"${t}"*`).join(' OR ');
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT c.payload_json
             FROM tracks_fts f
             JOIN canonical_tracks c ON c.canonical_track_id = f.canonical_track_id
             WHERE tracks_fts MATCH ?
             ORDER BY bm25(tracks_fts, 0.0, 5.0, 3.5, 1.5, 2.5, 1.5)
             LIMIT ?`,
          )
          .all(ftsExpr, limit * 2) as Array<{ payload_json: string }>;
        for (const r of ftsRows) {
          const ct = this.safeParseTrack(r.payload_json);
          if (ct) foundMap.set(ct.canonicalTrackId, ct);
        }
      } catch {
        // Fallback smoothly if special syntax rejected by FTS5
      }
    }

    // 2. Direct Pinyin / Initials SQL index lookup (handles short initials like "qt", "zjl")
    if (/^[a-z0-9]+$/i.test(exp.compact) && exp.compact.length >= 2) {
      const pyRows = this.db
        .prepare(
          `SELECT payload_json FROM canonical_tracks
           WHERE pinyin_full LIKE ? OR pinyin_initials LIKE ?
           ORDER BY external_popularity DESC
           LIMIT ?`,
        )
        .all(`${exp.compact}%`, `${exp.compact}%`, limit) as Array<{ payload_json: string }>;
      for (const r of pyRows) {
        const ct = this.safeParseTrack(r.payload_json);
        if (ct) foundMap.set(ct.canonicalTrackId, ct);
      }
    }

    // 3. Typo-tolerant Damerau-Levenshtein scan when FTS5 + prefix yielded < 3 hits
    if (foundMap.size < 3 && exp.compact.length >= 3) {
      const recentPool = this.listTracks(400);
      for (const t of recentPool) {
        const sim = Math.max(
          computeFuzzySimilarity(exp.compact, t.cleanTitle),
          computeFuzzySimilarity(exp.compact, compactNormalize(t.canonicalArtist)),
          /^[a-z]+$/.test(exp.compact) ? computeFuzzySimilarity(exp.compact, t.pinyinFull) : 0,
        );
        if (sim >= 0.68) {
          foundMap.set(t.canonicalTrackId, t);
        }
      }
    }

    return Array.from(foundMap.values()).slice(0, limit);
  }

  recordEvent(event: StoredBehaviorEvent): { inserted: boolean; deduplicated: boolean } {
    if (!event?.eventId || !event?.subjectKey) {
      return { inserted: false, deduplicated: false };
    }
    this.ensureDiskBudget();
    this.beforeWrite();
    const stmt = this.db.prepare(`
      INSERT INTO behavior_events (
        event_id, subject_key, event_type, canonical_track_id, artist_key,
        genres_json, language, query, weight, progress_ratio, created_at, track_ref
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_entity_feedback WHERE subject_key = ? AND feedback_id = ?)
      ON CONFLICT(subject_key, event_id) DO NOTHING
    `);
    let info;
    try {
      info = stmt.run(
        event.eventId,
        event.subjectKey,
        event.type,
        event.canonicalTrackId ?? null,
        event.artistKey ?? null,
        event.genres ? JSON.stringify(event.genres) : null,
        event.language ?? null,
        event.query ?? null,
        event.weight,
        event.progressRatio ?? null,
        event.createdAt,
        event.trackRef ?? null,
        event.subjectKey,
        event.eventId,
      );
    } catch (err: any) {
      // The max_page_count budget turning the file full must surface as an
      // explicit capacity error (507 at the gateway), never a silent drop.
      if (err?.code === 'SQLITE_FULL' || /database or disk is full/i.test(String(err?.message))) {
        recordSqliteMetric('write_error');
        throw new RecommendStoreBudgetExceededError('sqlite_full');
      }
      throw err;
    }

    const inserted = Number(info.changes) > 0;
    return {
      inserted,
      deduplicated: !inserted,
    };
  }

  getUserEvents(subjectKey: string, limit = 200, sinceMs = 0): StoredBehaviorEvent[] {
    if (!subjectKey) return [];
    const rows = this.db
      .prepare(
        `SELECT event_id, subject_key, event_type, canonical_track_id, artist_key,
                genres_json, language, query, weight, progress_ratio, created_at, track_ref
         FROM behavior_events
         WHERE subject_key = ? AND created_at >= ?
         ORDER BY created_at DESC,
           CASE event_type WHEN 'undislike' THEN 4 WHEN 'unfavorite' THEN 3 WHEN 'dislike' THEN 2 WHEN 'favorite' THEN 1 ELSE 0 END DESC,
           event_id DESC
         LIMIT ?`,
      )
      .all(subjectKey, sinceMs, Math.min(1000, Math.max(1, limit))) as Array<Record<string, any>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  clearUserEvents(subjectKey: string): number {
    if (!subjectKey) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const count = this.db.prepare(`SELECT COUNT(*) AS cnt FROM (
        SELECT event_id AS id FROM behavior_events WHERE subject_key = ?
        UNION SELECT feedback_id AS id FROM user_entity_feedback WHERE subject_key = ?
      )`).get(subjectKey, subjectKey) as { cnt: number };
      this.db.prepare(`DELETE FROM search_query_contributions WHERE subject_key = ?`).run(subjectKey);
      this.db.prepare(`DELETE FROM cooccurrence_contributions WHERE subject_key = ?`).run(subjectKey);
      this.db.prepare(`DELETE FROM behavior_events WHERE subject_key = ?`).run(subjectKey);
      this.db.prepare(`DELETE FROM user_entity_feedback WHERE subject_key = ?`).run(subjectKey);
      this.db.prepare(`DELETE FROM user_radar_profiles WHERE subject_key = ?`).run(subjectKey);
      this.db.exec('COMMIT');
      return Number(count.cnt);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getAllRecentEvents(sinceMs: number, limit = 10000): StoredBehaviorEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, subject_key, event_type, canonical_track_id, artist_key,
                genres_json, language, query, weight, progress_ratio, created_at, track_ref
         FROM behavior_events
         WHERE created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, Math.min(25000, Math.max(1, limit))) as Array<Record<string, any>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  incrementCooccurrence(trackA: string, trackB: string, delta: number, source?: RecommendContributionSource): void {
    if (!trackA || !trackB || trackA === trackB || !Number.isFinite(delta) || delta <= 0) return;
    this.beforeWrite();
    if (source) {
      if (!source.subjectKey || !source.eventId) return;
      const [a, b] = [trackA, trackB].sort();
      this.db.prepare(`INSERT INTO cooccurrence_contributions
        (subject_key, event_id, track_a, track_b, weight, created_at)
        SELECT subject_key, event_id, ?, ?, ?, created_at FROM behavior_events
        WHERE subject_key = ? AND event_id = ? AND created_at >= ?
        ON CONFLICT(subject_key, event_id, track_a, track_b) DO NOTHING`)
        .run(a, b, Math.min(200, delta), source.subjectKey, source.eventId, Date.now() - this.retentionDays * 86400_000);
      return;
    }
    // Legacy/admin callers have no reliable owner; do not guess or mix them with
    // attributable contributions, which must remain independently removable.
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO track_cooccurrence (track_a, track_b, weight, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(track_a, track_b) DO UPDATE SET
        weight = MIN(200.0, track_cooccurrence.weight + excluded.weight),
        updated_at = excluded.updated_at
    `);
    stmt.run(trackA, trackB, delta, now);
    stmt.run(trackB, trackA, delta, now);
  }

  getCooccurringTracks(trackId: string, limit = 20): Array<{ canonicalTrackId: string; weight: number }> {
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    return this.db.prepare(`
      SELECT neighbor AS canonicalTrackId, MIN(200.0, SUM(weight)) AS weight FROM (
        SELECT track_b AS neighbor, weight FROM track_cooccurrence WHERE track_a = ? AND updated_at >= ?
        UNION ALL
        SELECT track_b, weight FROM cooccurrence_contributions WHERE track_a = ? AND created_at >= ?
        UNION ALL
        SELECT track_a, weight FROM cooccurrence_contributions WHERE track_b = ? AND created_at >= ?
      ) GROUP BY neighbor ORDER BY weight DESC LIMIT ?
    `).all(trackId, cutoff, trackId, cutoff, trackId, cutoff, limit) as Array<{ canonicalTrackId: string; weight: number }>;
  }

  recordSearchQuery(normQuery: string, displayQuery: string, clicked = false, source?: RecommendContributionSource): void {
    const key = normQuery.trim();
    if (!key || key.length > 64) return;
    this.beforeWrite();
    const inc = clicked ? 3 : 1;
    if (source) {
      if (!source.subjectKey || !source.eventId) return;
      this.db.prepare(`INSERT INTO search_query_contributions
        (subject_key, event_id, norm_query, display_query, hit_count, created_at)
        SELECT subject_key, event_id, ?, ?, ?, created_at FROM behavior_events
        WHERE subject_key = ? AND event_id = ? AND created_at >= ?
        ON CONFLICT(subject_key, event_id, norm_query) DO NOTHING`)
        .run(key, displayQuery.trim(), inc, source.subjectKey, source.eventId, Date.now() - this.retentionDays * 86400_000);
      return;
    }
    this.db.prepare(`INSERT INTO search_queries (norm_query, display_query, hit_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(norm_query) DO UPDATE SET
        hit_count = search_queries.hit_count + excluded.hit_count, updated_at = excluded.updated_at`)
      .run(key, displayQuery.trim(), inc, Date.now());
  }

  getTopSearchQueries(prefix: string, limit = 8): Array<{ query: string; count: number }> {
    const pNorm = compactNormalize(prefix);
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    // Pick the display only from remaining contributions; deleting an owner must
    // not leave their exact query text as the display for another user's key.
    return this.db.prepare(`WITH contributions AS (
        SELECT norm_query, display_query, hit_count, updated_at FROM search_queries WHERE updated_at >= ?
        UNION ALL
        SELECT norm_query, display_query, hit_count, created_at FROM search_query_contributions WHERE created_at >= ?
      ), totals AS (
        SELECT norm_query, SUM(hit_count) AS count, MAX(updated_at) AS updated_at FROM contributions GROUP BY norm_query
      ) SELECT (SELECT display_query FROM contributions c WHERE c.norm_query = t.norm_query
          ORDER BY updated_at DESC, display_query LIMIT 1) AS query, count
        FROM totals t
        WHERE ? = '' OR norm_query LIKE ? OR EXISTS (
          SELECT 1 FROM contributions c WHERE c.norm_query = t.norm_query AND c.display_query LIKE ?
        ) ORDER BY count DESC, updated_at DESC LIMIT ?`)
      .all(cutoff, cutoff, pNorm, `${pNorm}%`, `%${prefix.trim()}%`, limit) as Array<{ query: string; count: number }>;
  }

  getStats(): { trackCount: number; entityCount: number; eventCount: number; cooccurrencePairs: number; storageKind: string } {
    const tRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM canonical_tracks`).get() as { cnt: number };
    const entRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM entities`).get() as { cnt: number };
    const eRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM (
      SELECT subject_key, event_id AS id FROM behavior_events
      UNION SELECT subject_key, feedback_id AS id FROM user_entity_feedback
    )`).get() as { cnt: number };
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    const cRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM (
      SELECT MIN(track_a, track_b) AS a, MAX(track_a, track_b) AS b FROM track_cooccurrence WHERE updated_at >= ?
      UNION SELECT track_a, track_b FROM cooccurrence_contributions WHERE created_at >= ?
    )`).get(cutoff, cutoff) as { cnt: number };
    return {
      trackCount: Number(tRow?.cnt || 0),
      entityCount: Number(entRow?.cnt || 0),
      eventCount: Number(eRow?.cnt || 0),
      cooccurrencePairs: Number(cRow?.cnt || 0),
      storageKind: this.kind,
    };
  }

  upsertEntity(entity: SonicEntity): void {
    if (!entity?.id || !entity?.type) return;
    this.beforeWrite();
    // Hard ceiling (audit P1-1): public mv/* responses ingest entities on every
    // successful upstream response. Refreshes of known rows stay allowed; only
    // brand-new rows are refused once the cap is reached.
    const exists = this.db.prepare(`SELECT 1 FROM entities WHERE entity_id = ?`).get(entity.id);
    if (!exists && this.currentEntityCount() >= MAX_ENTITIES) return;
    const stmt = this.db.prepare(`
      INSERT INTO entities (
        entity_id, entity_type, title, subtitle, artist_id, artist_name,
        cover_url, source, source_id, tags_json, language, duration,
        external_popularity, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        artist_name = excluded.artist_name,
        cover_url = excluded.cover_url,
        tags_json = excluded.tags_json,
        duration = excluded.duration,
        external_popularity = excluded.external_popularity,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `);
    stmt.run(
      entity.id,
      entity.type,
      entity.title,
      entity.subtitle ?? null,
      entity.artistId ?? null,
      entity.artistName ?? null,
      entity.coverUrl ?? null,
      entity.source || 'sonic',
      entity.sourceId ?? null,
      entity.tags ? JSON.stringify(entity.tags) : '[]',
      entity.language ?? null,
      entity.duration ?? 0,
      entity.externalPopularity ?? 0,
      entity.createdAt || Date.now(),
      entity.updatedAt || Date.now(),
      JSON.stringify(entity.payload || {}),
    );
    if (!exists && this.entityCount >= 0) this.entityCount += 1;
  }

  upsertEntities(entities: SonicEntity[]): void {
    if (!entities?.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entities) {
        this.upsertEntity(e);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  getEntity(id: string): SonicEntity | null {
    if (!id) return null;
    const row = this.db.prepare(`SELECT * FROM entities WHERE entity_id = ?`).get(id) as Record<string, any> | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  listEntities(type?: SonicEntityType, limit = 500): SonicEntity[] {
    const lim = Math.max(1, Math.min(2000, limit));
    const rows = type
      ? (this.db
          .prepare(`SELECT * FROM entities WHERE entity_type = ? ORDER BY updated_at DESC LIMIT ?`)
          .all(type, lim) as Array<Record<string, any>>)
      : (this.db
          .prepare(`SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?`)
          .all(lim) as Array<Record<string, any>>);
    return rows.map((r) => this.rowToEntity(r)).filter((x): x is SonicEntity => x !== null);
  }

  upsertEntityRelation(rel: EntityRelation): void {
    if (!rel?.parentId || !rel?.childId) return;
    this.beforeWrite();
    const relationId = rel.relationId || `${rel.parentId}:::${rel.childId}:::${rel.relationType}`;
    // Hard ceiling (audit P1-1): relations grow with every ingested MV catalog row.
    const exists = this.db.prepare(`SELECT 1 FROM entity_relations WHERE relation_id = ?`).get(relationId);
    if (!exists) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM entity_relations`).get() as { c?: number } | undefined;
      if (Number(row?.c || 0) >= MAX_ENTITY_RELATIONS) return;
    }
    const stmt = this.db.prepare(`
      INSERT INTO entity_relations (
        relation_id, parent_id, parent_type, child_id, child_type,
        relation_type, weight, position, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relation_id) DO UPDATE SET
        weight = excluded.weight,
        position = excluded.position
    `);
    stmt.run(
      relationId,
      rel.parentId,
      rel.parentType,
      rel.childId,
      rel.childType,
      rel.relationType,
      rel.weight ?? 1.0,
      rel.position ?? 0,
      rel.createdAt || Date.now(),
    );
  }

  upsertEntityRelations(rels: EntityRelation[]): void {
    if (!rels?.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rels) {
        this.upsertEntityRelation(r);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  getEntityRelations(entityId: string, direction: 'children' | 'parents' = 'children'): EntityRelation[] {
    if (!entityId) return [];
    const rows =
      direction === 'children'
        ? (this.db
            .prepare(`SELECT * FROM entity_relations WHERE parent_id = ? ORDER BY position ASC, weight DESC`)
            .all(entityId) as Array<Record<string, any>>)
        : (this.db
            .prepare(`SELECT * FROM entity_relations WHERE child_id = ? ORDER BY weight DESC`)
            .all(entityId) as Array<Record<string, any>>);
    return rows.map((r) => ({
      relationId: String(r.relation_id),
      parentId: String(r.parent_id),
      parentType: r.parent_type,
      childId: String(r.child_id),
      childType: r.child_type,
      relationType: r.relation_type,
      weight: Number(r.weight || 1.0),
      position: Number(r.position || 0),
      createdAt: Number(r.created_at || 0),
    }));
  }

  recordEntityFeedback(feedback: UserEntityFeedback): { inserted: boolean; deduplicated: boolean } {
    if (!feedback?.feedbackId || !feedback?.subjectKey || !feedback?.entityId) {
      return { inserted: false, deduplicated: false };
    }
    this.ensureDiskBudget();
    this.beforeWrite();
    const stmt = this.db.prepare(`
      INSERT INTO user_entity_feedback (
        feedback_id, subject_key, entity_type, entity_id, action,
        weight, progress, context_json, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM behavior_events WHERE subject_key = ? AND event_id = ?)
      ON CONFLICT(subject_key, feedback_id) DO NOTHING
    `);
    const info = stmt.run(
      feedback.feedbackId,
      feedback.subjectKey,
      feedback.entityType,
      feedback.entityId,
      feedback.action,
      feedback.weight,
      feedback.progress ?? null,
      feedback.context ? JSON.stringify(feedback.context) : null,
      feedback.createdAt,
      feedback.subjectKey,
      feedback.feedbackId,
    );
    const inserted = Number(info.changes) > 0;
    return {
      inserted,
      deduplicated: !inserted,
    };
  }

  getUserEntityFeedbacks(subjectKey: string, limit = 200, sinceMs = 0): UserEntityFeedback[] {
    if (!subjectKey) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM user_entity_feedback
         WHERE subject_key = ? AND created_at >= ?
         ORDER BY created_at DESC,
           CASE action WHEN 'undislike' THEN 4 WHEN 'unfavorite' THEN 3 WHEN 'dislike' THEN 2 WHEN 'favorite' THEN 1 ELSE 0 END DESC,
           feedback_id DESC
         LIMIT ?`,
      )
      .all(subjectKey, sinceMs, Math.min(1000, Math.max(1, limit))) as Array<Record<string, any>>;
    return rows.map((r) => ({
      feedbackId: String(r.feedback_id),
      subjectKey: String(r.subject_key),
      entityType: r.entity_type,
      entityId: String(r.entity_id),
      action: r.action,
      weight: Number(r.weight || 0),
      progress: r.progress !== null && r.progress !== undefined ? Number(r.progress) : undefined,
      context: r.context_json ? JSON.parse(r.context_json) : undefined,
      createdAt: Number(r.created_at || 0),
    }));
  }

  clearUserEntityFeedbacks(subjectKey: string): number {
    if (!subjectKey) return 0;
    const info = this.db.prepare(`DELETE FROM user_entity_feedback WHERE subject_key = ?`).run(subjectKey);
    return Number(info.changes) || 0;
  }

  pruneRetention(retentionDays = this.retentionDays): void {
    const days = normalizeRecommendRetentionDays(retentionDays);
    const now = Date.now();
    const cutoff = now - days * 24 * 3600 * 1000;
    // Anonymous subjects rotate IDs freely, so their raw rows are only useful
    // short-term; authenticated rows keep the full retention window (audit P0-1).
    const anonCutoff = now - this.anonEventRetentionDays * 24 * 3600 * 1000;
    this.db.exec('SAVEPOINT sonic_recommend_retention');
    try {
      this.db.prepare(`DELETE FROM search_query_contributions WHERE created_at < ? OR NOT EXISTS (
        SELECT 1 FROM behavior_events e WHERE e.subject_key = search_query_contributions.subject_key
          AND e.event_id = search_query_contributions.event_id AND e.created_at >= ?
      )`).run(cutoff, cutoff);
      this.db.prepare(`DELETE FROM cooccurrence_contributions WHERE created_at < ? OR NOT EXISTS (
        SELECT 1 FROM behavior_events e WHERE e.subject_key = cooccurrence_contributions.subject_key
          AND e.event_id = cooccurrence_contributions.event_id AND e.created_at >= ?
      )`).run(cutoff, cutoff);
      this.db.prepare(`DELETE FROM behavior_events WHERE created_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM behavior_events WHERE created_at < ? AND subject_key LIKE 'anon_%'`).run(anonCutoff);
      this.db.prepare(`DELETE FROM user_entity_feedback WHERE created_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM user_entity_feedback WHERE created_at < ? AND subject_key LIKE 'anon_%'`).run(anonCutoff);
      this.db.prepare(`DELETE FROM search_queries WHERE updated_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM track_cooccurrence WHERE updated_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM user_radar_profiles WHERE updated_at < ?`).run(cutoff);
      // Entities/relations were previously never pruned (audit P1-1); expire
      // untouched catalog rows on the same window and drop relations whose MV
      // parent vanished. A child may be a canonical track (canonical_tracks)
      // rather than an entity, so only the parent side decides orphaning.
      this.db.prepare(`DELETE FROM entity_relations WHERE created_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM entities WHERE updated_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM entity_relations WHERE NOT EXISTS (
        SELECT 1 FROM entities p WHERE p.entity_id = entity_relations.parent_id
      )`).run();
      this.enforceRowCaps();
      this.db.exec('RELEASE sonic_recommend_retention');
      this.retentionDays = days;
      this.lastRetentionAt = now;
      this.writeCounter = 0;
      this.entityCount = -1;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK TO sonic_recommend_retention; RELEASE sonic_recommend_retention');
      } catch {}
      recordSqliteMetric('write_error');
      throw error;
    }
  }

  /**
   * Absolute row ceilings for anonymous-writable tables (audit P0-1/P1-1). The
   * per-minute quotas bound the rate; these caps bound the total regardless of
   * how many identities an attacker rotates. Oldest rows are evicted first.
   */
  private enforceRowCaps(): void {
    const caps: Array<[string, string, number]> = [
      ['behavior_events', 'created_at', MAX_BEHAVIOR_EVENTS],
      ['user_entity_feedback', 'created_at', MAX_USER_ENTITY_FEEDBACK],
    ];
    for (const [table, column, cap] of caps) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c?: number } | undefined;
      const count = Number(row?.c || 0);
      if (count <= cap) continue;
      this.db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (
           SELECT rowid FROM ${table} ORDER BY ${column} ASC LIMIT ?
         )`,
      ).run(count - cap);
    }
    // Deleting events orphans their contribution rows; CASCADE only covers the
    // FK-declared tables and only when the parent delete comes from the FK path.
    this.db.prepare(`DELETE FROM search_query_contributions WHERE NOT EXISTS (
      SELECT 1 FROM behavior_events e WHERE e.subject_key = search_query_contributions.subject_key
        AND e.event_id = search_query_contributions.event_id
    )`).run();
    this.db.prepare(`DELETE FROM cooccurrence_contributions WHERE NOT EXISTS (
      SELECT 1 FROM behavior_events e WHERE e.subject_key = cooccurrence_contributions.subject_key
        AND e.event_id = cooccurrence_contributions.event_id
    )`).run();
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }

  verifyWritable(): { writable: boolean; error?: string } {
    if (this.dbPath === ':memory:') {
      return { writable: true };
    }
    try {
      this.db.exec('SAVEPOINT sonic_health_write_check; RELEASE sonic_health_write_check;');
      const dir = path.dirname(path.resolve(this.dbPath));
      fs.accessSync(dir, fs.constants.W_OK);
      if (fs.existsSync(this.dbPath)) {
        fs.accessSync(this.dbPath, fs.constants.W_OK);
      }
      return { writable: true };
    } catch (err: any) {
      recordSqliteMetric('write_error');
      return {
        writable: false,
        error: redactSensitiveString(err?.code || err?.message || 'sqlite_unwritable'),
      };
    }
  }

  private safeParseTrack(jsonStr: string): CanonicalTrack | null {
    try {
      return JSON.parse(jsonStr) as CanonicalTrack;
    } catch {
      return null;
    }
  }

  private rowToEvent(r: Record<string, any>): StoredBehaviorEvent {
    let genres: string[] | undefined;
    if (typeof r.genres_json === 'string' && r.genres_json) {
      try {
        genres = JSON.parse(r.genres_json);
      } catch {}
    }
    return {
      eventId: String(r.event_id),
      subjectKey: String(r.subject_key),
      type: r.event_type,
      canonicalTrackId: r.canonical_track_id ? String(r.canonical_track_id) : undefined,
      trackRef: r.track_ref ? String(r.track_ref) : undefined,
      artistKey: r.artist_key ? String(r.artist_key) : undefined,
      genres,
      language: r.language ? (String(r.language) as any) : undefined,
      query: r.query ? String(r.query) : undefined,
      weight: Number(r.weight || 0),
      progressRatio: r.progress_ratio !== null && r.progress_ratio !== undefined ? Number(r.progress_ratio) : undefined,
      createdAt: Number(r.created_at || 0),
    };
  }

  private rowToEntity(r: Record<string, any>): SonicEntity | null {
    if (!r?.entity_id || !r?.entity_type) return null;
    let tags: string[] = [];
    if (typeof r.tags_json === 'string' && r.tags_json) {
      try {
        tags = JSON.parse(r.tags_json);
      } catch {}
    }
    let payload: Record<string, any> = {};
    if (typeof r.payload_json === 'string' && r.payload_json) {
      try {
        payload = JSON.parse(r.payload_json);
      } catch {}
    }
    return {
      id: String(r.entity_id),
      type: r.entity_type as SonicEntityType,
      title: String(r.title || ''),
      subtitle: r.subtitle ? String(r.subtitle) : undefined,
      artistId: r.artist_id ? String(r.artist_id) : undefined,
      artistName: r.artist_name ? String(r.artist_name) : undefined,
      coverUrl: r.cover_url ? String(r.cover_url) : undefined,
      source: String(r.source || 'sonic'),
      sourceId: r.source_id ? String(r.source_id) : undefined,
      tags,
      language: r.language ? (String(r.language) as any) : undefined,
      duration: Number(r.duration || 0),
      externalPopularity: Number(r.external_popularity || 0),
      createdAt: Number(r.created_at || 0),
      updatedAt: Number(r.updated_at || 0),
      payload,
    };
  }

  saveUserRadarProfile(subjectKey: string, payloadJson: string): void {
    if (!subjectKey || !payloadJson) return;
    this.beforeWrite();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO user_radar_profiles (subject_key, payload_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(subject_key) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `);
      stmt.run(subjectKey, payloadJson, Date.now());
    } catch (err: any) {
      recordSqliteMetric('write_error');
      throw new RecommendStorePersistenceError(this.dbPath, err);
    }
  }

  getUserRadarProfile(subjectKey: string): { payloadJson: string; updatedAt: number } | null {
    if (!subjectKey) return null;
    try {
      const stmt = this.db.prepare(
        `SELECT payload_json, updated_at FROM user_radar_profiles WHERE subject_key = ?`,
      );
      const row = stmt.get(subjectKey) as any;
      if (!row) return null;
      return { payloadJson: String(row.payload_json), updatedAt: Number(row.updated_at) };
    } catch (err: any) {
      recordSqliteMetric('read_error');
      throw new RecommendStorePersistenceError(this.dbPath, err);
    }
  }
}

export class RecommendStorePersistenceError extends Error {
  constructor(
    public readonly dbPath: string,
    cause: unknown,
  ) {
    super(
      `Failed to open the persistent recommendation store at ${dbPath}: ${
        (cause as any)?.message || String(cause)
      }`,
    );
    this.name = 'RecommendStorePersistenceError';
  }
}

/** Storage budget exhausted (disk below threshold or SQLite file full). */
export class RecommendStoreBudgetExceededError extends Error {
  readonly code = 'RECOMMEND_STORE_BUDGET_EXCEEDED';
  constructor(public readonly reason: 'disk_below_threshold' | 'sqlite_full') {
    super(`Recommendation store storage budget exceeded (${reason})`);
    this.name = 'RecommendStoreBudgetExceededError';
  }
}

// Persistence failures must never be silently downgraded to an in-memory store in
// production: the service would look healthy while losing all behavioural data on
// restart. Development and tests keep the fallback, and an explicit opt-in exists
// for constrained environments.
function allowMemoryFallback(): boolean {
  return (
    process.env.SONIC_RECOMMEND_ALLOW_MEMORY_FALLBACK === '1' ||
    process.env.NODE_ENV !== 'production'
  );
}

export function createServerRecommendStore(dbPath?: string): RecommendStore {
  const effectivePath =
    (dbPath ?? process.env.SONIC_RECOMMEND_DB_PATH ?? '').trim() ||
    path.resolve(process.cwd(), 'data', 'sonic-recommend.sqlite');

  const retentionDays = normalizeRecommendRetentionDays(process.env.SONIC_RECOMMEND_RETENTION_DAYS);
  if (effectivePath === 'memory' || effectivePath === 'off') {
    return new MemoryRecommendStore(retentionDays);
  }

  try {
    return new SqliteRecommendStore(effectivePath, retentionDays);
  } catch (err: any) {
    recordSqliteMetric('memory_fallback');
    if (!allowMemoryFallback()) {
      throw new RecommendStorePersistenceError(effectivePath, err);
    }
    console.warn(
      `[Sonic Recommend] Failed to open SQLite store at ${effectivePath} (${redactSensitiveString(err?.message || 'error')}); falling back to MemoryRecommendStore`,
    );
    return new MemoryRecommendStore(retentionDays);
  }
}

export function probeDiskHealth(
  dbPath?: string,
  minFreeMb = 64,
  store?: RecommendStore | null,
): {
  ok: boolean;
  writable: boolean;
  path: string;
  freeBytes?: number;
  totalBytes?: number;
  freeMb?: number;
  freeRatio?: number;
  lowSpace?: boolean;
  error?: string;
} {
  const effectivePath =
    (dbPath ?? process.env.SONIC_RECOMMEND_DB_PATH ?? '').trim() ||
    path.resolve(process.cwd(), 'data', 'sonic-recommend.sqlite');

  if (effectivePath === 'memory' || effectivePath === 'off' || effectivePath === ':memory:') {
    return {
      ok: true,
      writable: true,
      path: effectivePath,
      lowSpace: false,
    };
  }

  const resolvedDbPath = path.resolve(effectivePath);
  const dir = path.dirname(resolvedDbPath);
  let writable = true;
  let error: string | undefined;

  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    if (fs.existsSync(resolvedDbPath)) {
      fs.accessSync(resolvedDbPath, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (err: any) {
    writable = false;
    error = redactSensitiveString(err?.code || err?.message || 'dir_not_writable');
  }

  if (writable && store && typeof (store as any).verifyWritable === 'function') {
    const dbCheck = (store as SqliteRecommendStore).verifyWritable();
    if (!dbCheck.writable) {
      writable = false;
      error = dbCheck.error || 'sqlite_readonly';
    }
  }

  let freeBytes: number | undefined;
  let totalBytes: number | undefined;
  let freeMb: number | undefined;
  let freeRatio: number | undefined;
  let lowSpace = false;

  try {
    if (typeof fs.statfsSync === 'function' && fs.existsSync(dir)) {
      const stat = fs.statfsSync(dir);
      const bsize = Number(stat.bsize || 4096);
      freeBytes = Number(stat.bavail) * bsize;
      totalBytes = Number(stat.blocks) * bsize;
      freeMb = Math.round((freeBytes / (1024 * 1024)) * 10) / 10;
      freeRatio = totalBytes > 0 ? Number((freeBytes / totalBytes).toFixed(4)) : undefined;
      const thresholdBytes = Math.max(1, minFreeMb) * 1024 * 1024;
      if (freeBytes < thresholdBytes) {
        lowSpace = true;
        error = error || `low_disk_space (${freeMb}MB < ${minFreeMb}MB)`;
      }
    }
  } catch (err: any) {
    if (!error) {
      error = redactSensitiveString(err?.code || err?.message || 'statfs_failed');
    }
  }

  return {
    ok: writable && !lowSpace,
    writable,
    path: resolvedDbPath,
    freeBytes,
    totalBytes,
    freeMb,
    freeRatio,
    lowSpace,
    ...(error ? { error } : {}),
  };
}

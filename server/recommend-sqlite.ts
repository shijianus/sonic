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
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { recordSqliteMetric, redactSensitiveString } from '../functions/_lib/sonic/observability';

export class SqliteRecommendStore implements RecommendStore {
  public readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private writeCounter = 0;

  constructor(public readonly dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -16000;

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
        event_id TEXT PRIMARY KEY,
        subject_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        canonical_track_id TEXT,
        artist_key TEXT,
        genres_json TEXT,
        language TEXT,
        query TEXT,
        weight REAL NOT NULL,
        progress_ratio REAL,
        created_at INTEGER NOT NULL
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
        feedback_id TEXT PRIMARY KEY,
        subject_key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        weight REAL NOT NULL,
        progress REAL,
        context_json TEXT,
        created_at INTEGER NOT NULL
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
    `);
  }

  upsertTrack(incoming: CanonicalTrack): void {
    if (!incoming?.canonicalTrackId) return;

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
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO behavior_events (
        event_id, subject_key, event_type, canonical_track_id, artist_key,
        genres_json, language, query, weight, progress_ratio, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
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
    );

    const inserted = Number(info.changes) > 0;
    if (inserted) {
      this.writeCounter += 1;
      if (this.writeCounter % 1500 === 0) {
        this.pruneRetention();
      }
    }
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
                genres_json, language, query, weight, progress_ratio, created_at
         FROM behavior_events
         WHERE subject_key = ? AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(subjectKey, sinceMs, Math.min(1000, Math.max(1, limit))) as Array<Record<string, any>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  clearUserEvents(subjectKey: string): number {
    if (!subjectKey) return 0;
    const info1 = this.db.prepare(`DELETE FROM behavior_events WHERE subject_key = ?`).run(subjectKey);
    const info2 = this.db.prepare(`DELETE FROM user_entity_feedback WHERE subject_key = ?`).run(subjectKey);
    return (Number(info1.changes) || 0) + (Number(info2.changes) || 0);
  }

  getAllRecentEvents(sinceMs: number, limit = 10000): StoredBehaviorEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, subject_key, event_type, canonical_track_id, artist_key,
                genres_json, language, query, weight, progress_ratio, created_at
         FROM behavior_events
         WHERE created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, Math.min(25000, Math.max(1, limit))) as Array<Record<string, any>>;

    return rows.map((r) => this.rowToEvent(r));
  }

  incrementCooccurrence(trackA: string, trackB: string, delta: number): void {
    if (!trackA || !trackB || trackA === trackB || delta <= 0) return;
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
    const rows = this.db
      .prepare(
        `SELECT track_b AS canonicalTrackId, weight
         FROM track_cooccurrence
         WHERE track_a = ?
         ORDER BY weight DESC
         LIMIT ?`,
      )
      .all(trackId, limit) as Array<{ canonicalTrackId: string; weight: number }>;
    return rows;
  }

  recordSearchQuery(normQuery: string, displayQuery: string, clicked = false): void {
    const key = normQuery.trim();
    if (!key || key.length > 64) return;
    const inc = clicked ? 3 : 1;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO search_queries (norm_query, display_query, hit_count, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(norm_query) DO UPDATE SET
           hit_count = search_queries.hit_count + excluded.hit_count,
           updated_at = excluded.updated_at`,
      )
      .run(key, displayQuery.trim(), inc, now);
  }

  getTopSearchQueries(prefix: string, limit = 8): Array<{ query: string; count: number }> {
    const pNorm = compactNormalize(prefix);
    const rows = pNorm
      ? (this.db
          .prepare(
            `SELECT display_query AS query, hit_count AS count
             FROM search_queries
             WHERE norm_query LIKE ? OR display_query LIKE ?
             ORDER BY hit_count DESC, updated_at DESC
             LIMIT ?`,
          )
          .all(`${pNorm}%`, `%${prefix.trim()}%`, limit) as Array<{ query: string; count: number }>)
      : (this.db
          .prepare(
            `SELECT display_query AS query, hit_count AS count
             FROM search_queries
             ORDER BY hit_count DESC, updated_at DESC
             LIMIT ?`,
          )
          .all(limit) as Array<{ query: string; count: number }>);
    return rows;
  }

  getStats(): { trackCount: number; entityCount: number; eventCount: number; cooccurrencePairs: number; storageKind: string } {
    const tRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM canonical_tracks`).get() as { cnt: number };
    const entRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM entities`).get() as { cnt: number };
    const eRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM behavior_events`).get() as { cnt: number };
    const cRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM track_cooccurrence`).get() as { cnt: number };
    return {
      trackCount: Number(tRow?.cnt || 0),
      entityCount: Number(entRow?.cnt || 0),
      eventCount: Number(eRow?.cnt || 0),
      cooccurrencePairs: Math.floor(Number(cRow?.cnt || 0) / 2),
      storageKind: this.kind,
    };
  }

  upsertEntity(entity: SonicEntity): void {
    if (!entity?.id || !entity?.type) return;
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
    const relationId = rel.relationId || `${rel.parentId}:::${rel.childId}:::${rel.relationType}`;
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
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO user_entity_feedback (
        feedback_id, subject_key, entity_type, entity_id, action,
        weight, progress, context_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      feedback.createdAt || Date.now(),
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
         ORDER BY created_at DESC
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

  pruneRetention(retentionDays = 90): void {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    try {
      this.db.prepare(`DELETE FROM behavior_events WHERE created_at < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM user_entity_feedback WHERE created_at < ?`).run(cutoff);
    } catch {}
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

  if (effectivePath === 'memory' || effectivePath === 'off') {
    return new MemoryRecommendStore();
  }

  try {
    const store = new SqliteRecommendStore(effectivePath);
    store.pruneRetention(
      Math.max(7, parseInt(String(process.env.SONIC_RECOMMEND_RETENTION_DAYS || '90'), 10) || 90),
    );
    return store;
  } catch (err: any) {
    recordSqliteMetric('memory_fallback');
    if (!allowMemoryFallback()) {
      throw new RecommendStorePersistenceError(effectivePath, err);
    }
    console.warn(
      `[Sonic Recommend] Failed to open SQLite store at ${effectivePath} (${redactSensitiveString(err?.message || 'error')}); falling back to MemoryRecommendStore`,
    );
    return new MemoryRecommendStore();
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

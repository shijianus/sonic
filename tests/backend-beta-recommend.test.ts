import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MemoryRecommendStore, ensureMultiEntityCatalogSeeded, toCanonicalTrack,
  ingestBehaviorEvents, buildMultiEntityPreferenceProfile, buildUserPreferenceProfile,
  computeMvEntityId, computeCatalogPopularity, getMultiEntityRecommendationsForYou, ingestVerifiedMvCatalog,
  type RecommendStore, type SonicBehaviorEventInput, type UserIdentityContext,
} from '../functions/_lib/sonic/recommend';
import { SqliteRecommendStore } from '../server/recommend-sqlite';
import { onRequest as eventsHttp } from '../functions/api/sonic/events';
import { onRequest as feedHttp } from '../functions/api/sonic/recommend/for-you';
import { resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';

const identity = (subject = 'anon:beta_A'): UserIdentityContext => ({
  mode: 'anonymous-opt-in', subjectKey: subject, personalizationEnabled: true, isAuthenticated: false,
});
const envFor = (store: RecommendStore) => ({ RECOMMEND_STORE: store, SONIC_RECOMMEND_OFFLINE: '1' });
const tempDirs: string[] = [];
const openStores: SqliteRecommendStore[] = [];
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-beta-recommend-'));
  tempDirs.push(dir);
  return path.join(dir, 'test.sqlite');
}
function sqlite(file = tempDb()): SqliteRecommendStore {
  const store = new SqliteRecommendStore(file);
  openStores.push(store);
  return store;
}
function request(method: string, body?: unknown, anon = 'anon_backend_beta_user_01'): Request {
  return new Request('https://sonic.test/api/sonic/events', {
    method, headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': anon },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture(store: RecommendStore) {
  ensureMultiEntityCatalogSeeded(store);
  // Deterministic provider-detail fixture, injected at the SERVER catalog boundary.
  const track = store.getTrack('186016')!;
  store.upsertTrack({ ...track, mvSourceIds: { netease: '550001' } });
  return { track: store.getTrack('186016')!, mv: store.getEntity!(computeMvEntityId('netease', '550001'))! };
}

beforeEach(() => resetLocalEngineCircuitForTest());
afterEach(() => {
  vi.restoreAllMocks();
  resetLocalEngineCircuitForTest();
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`backend beta recommendation (${kind})`, () => {
    let store: RecommendStore;
    beforeEach(() => { store = kind === 'memory' ? new MemoryRecommendStore() : sqlite(); });

    it('isolates event and feedback IDs by subject and counts each input only once', async () => {
      const { track, mv } = fixture(store);
      const batch: SonicBehaviorEventInput[] = [
        { eventId: 'shared_track_id', entityType: 'track', entityId: track.canonicalTrackId, action: 'play_complete', track: { id: '186016' } },
        { eventId: 'shared_video_id', entity_type: 'mv', entity_id: mv.id, action: 'watch_complete', track: { id: '550001', title: 'Untrusted video title' } },
      ];
      for (const subject of ['anon:beta_A', 'anon:beta_B']) {
        expect(await ingestBehaviorEvents(batch, identity(subject), envFor(store))).toMatchObject({ accepted: 2, deduplicated: 0 });
        expect(await ingestBehaviorEvents(batch, identity(subject), envFor(store))).toMatchObject({ accepted: 0, deduplicated: 2 });
        expect(store.getUserEvents(subject)).toHaveLength(1);
        expect(store.getUserEntityFeedbacks!(subject)).toHaveLength(1);
      }
      expect(store.getStats().eventCount).toBe(4);
      expect(store.clearUserEvents('anon:beta_A')).toBe(2);
      expect(store.getStats().eventCount).toBe(2);
      expect(store.getUserEntityFeedbacks!('anon:beta_A')).toEqual([]);
      expect(store.getUserEntityFeedbacks!('anon:beta_B')).toHaveLength(1);
      // Changing the path/type does not let the same user's retry become a second event.
      expect(await ingestBehaviorEvents([{ ...batch[1], eventId: 'shared_track_id' }], identity('anon:beta_B'), envFor(store)))
        .toMatchObject({ accepted: 0, deduplicated: 1 });
    });

    it('does not let client metadata or canonical IDs alter any global catalog field', async () => {
      const { track } = fixture(store);
      const before = JSON.stringify(store.getTrack(track.canonicalTrackId));
      const count = store.getStats().trackCount;
      await ingestBehaviorEvents([{
        eventId: 'poison_payload', type: 'play_complete', track: {
          canonicalTrackId: track.canonicalTrackId, id: '186016', title: 'Malicious rename',
          artist: 'Fake artist', album: 'Fake album', genres: ['poison'], platform: 'netease',
          sources: [{ platform: 'qq', platformId: 'WRONG' }], externalPopularity: 100, mvId: '999999',
        } as any,
      }], identity(), envFor(store));
      expect(JSON.stringify(store.getTrack(track.canonicalTrackId))).toBe(before);
      expect(store.getTrack('qq:WRONG')).toBeNull();
      expect(store.getStats().trackCount).toBe(count);
      const recorded = store.getUserEvents(identity().subjectKey!)[0];
      expect(recorded.canonicalTrackId).toBe(track.canonicalTrackId);
      expect(recorded.artistKey).toBe(track.canonicalArtist);
      expect(recorded.genres).not.toContain('poison');
      const clientCanonical = toCanonicalTrack({ id: 'new_id', title: 'Different song', artist: 'Different artist', canonicalTrackId: track.canonicalTrackId })!;
      expect(clientCanonical.canonicalTrackId).not.toBe(track.canonicalTrackId);
    });

    it('retains unknown playback references privately and resolves them after trusted catalog upsert', async () => {
      fixture(store);
      const count = store.getStats().trackCount;
      const event = { eventId: 'unknown_playback', type: 'play_complete', track: { id: '987654321', platform: 'netease', title: 'Untrusted title', artist: 'Fake artist' } } as const;
      expect(await ingestBehaviorEvents([event], identity(), envFor(store))).toMatchObject({ accepted: 1 });
      expect(store.getStats().trackCount).toBe(count);
      expect(store.getUserEvents(identity().subjectKey!)[0]).toMatchObject({ trackRef: 'netease:987654321' });
      expect(store.getUserEvents(identity().subjectKey!)[0].canonicalTrackId).toBeUndefined();
      const trusted = toCanonicalTrack({ id: '987654321', platform: 'netease', title: 'Verified song', artist: 'Verified artist', duration: 180 })!;
      store.upsertTrack(trusted);
      expect(buildUserPreferenceProfile(identity(), store).longTermArtists['Verified artist']).toBeGreaterThan(0);
      expect(buildMultiEntityPreferenceProfile(identity(), store).directEntityScores.get(trusted.canonicalTrackId)).toBeGreaterThan(0);
    });

    it('maps MV external IDs and does not create fake global video entities or client relations', async () => {
      const { mv, track } = fixture(store);
      const before = store.listEntities!('mv', 2000).length;
      const relations = store.getEntityRelations!(mv.id, 'children');
      const events: SonicBehaviorEventInput[] = [
        { eventId: 'mv_raw_reference', entity_type: 'mv', entity_id: '550001', action: 'watch_complete', track: { id: '65538', title: 'Wrong mapping' } },
        { eventId: 'mv_new_reference', entityType: 'mv', entityId: 'netease:999999', action: 'open', track: { id: '999999', title: 'Invented MV' } },
      ];
      expect(await ingestBehaviorEvents(events, identity(), envFor(store))).toMatchObject({ accepted: 2 });
      const feedbacks = store.getUserEntityFeedbacks!(identity().subjectKey!);
      expect(feedbacks.find((f) => f.feedbackId === 'mv_raw_reference')?.entityId).toBe(mv.id);
      expect(feedbacks.find((f) => f.feedbackId === 'mv_new_reference')?.entityId).toBe('netease:999999');
      expect(store.listEntities!('mv', 2000)).toHaveLength(before);
      expect(store.getEntityRelations!(mv.id, 'children')).toEqual(relations);
      expect(store.getUserEvents(identity().subjectKey!)).toEqual([]);
      const profile = buildMultiEntityPreferenceProfile(identity(), store);
      expect(profile.propagatedEntityScores.get(track.canonicalTrackId)).toBeCloseTo(2.5 * 0.45, 2);
      const feed = await getMultiEntityRecommendationsForYou(identity(), { count: 20, temperature: 0 }, envFor(store));
      expect(feed.data.some((item) => item.type === 'mv' && item.id === mv.id && item.payload.mvId === '550001')).toBe(true);
    });

    it('folds undo states chronologically, including reverse arrival, equal timestamps and duplicate favorites', async () => {
      const { track, mv } = fixture(store);
      const album = store.listEntities!('album', 1)[0];
      const playlist = store.listEntities!('playlist', 1)[0];
      const ts = Date.now() - 1000;
      for (const [type, id] of [['track', track.canonicalTrackId], ['album', album.id], ['playlist', playlist.id], ['mv', mv.id]] as const) {
        for (const equalTime of [false, true]) {
          const subject = `anon:${type}_${equalTime}`;
          const base = { entityType: type, entityId: id };
          const actions: SonicBehaviorEventInput[] = [
            { ...base, eventId: 'z_late_dislike', action: 'dislike', timestamp: ts },
            { ...base, eventId: 'a_undo_dislike', action: 'undislike', timestamp: ts + (equalTime ? 0 : 10) },
            { ...base, eventId: 'z_late_favorite', action: 'favorite', timestamp: ts },
            { ...base, eventId: 'a_undo_favorite', action: 'unfavorite', timestamp: ts + (equalTime ? 0 : 10) },
          ];
          await ingestBehaviorEvents([...actions].reverse(), identity(subject), envFor(store));
          const profile = buildMultiEntityPreferenceProfile(identity(subject), store, undefined, ts + 100);
          expect(profile.blockedEntityIds.has(id)).toBe(false);
          expect(profile.directEntityScores.get(id) || 0).toBe(0);
          expect(profile.penalizedEntities.size).toBe(0);
          const legacy = buildUserPreferenceProfile(identity(subject), store, ts + 100);
          expect(legacy.blockedTrackIds.size).toBe(0);
          expect(legacy.likedTrackIds.size).toBe(0);
          expect(Object.keys(legacy.penalizedArtists)).toHaveLength(0);
        }
        await ingestBehaviorEvents(Array.from({ length: 10 }, (_, i) => ({
          entityType: type, entityId: id, action: 'favorite', eventId: `repeat_${type}_${i}`, timestamp: ts,
        })), identity(`anon:repeat_${type}`), envFor(store));
        expect(buildMultiEntityPreferenceProfile(identity(`anon:repeat_${type}`), store, undefined, ts).directEntityScores.get(id)).toBe(4);
      }
    });
  });
}

describe('request-local preference lookup memoization', () => {
  it('resolves 600 repeated history references once per unique target without changing scores', () => {
    for (const store of [new MemoryRecommendStore(), sqlite()]) {
      const { track, mv } = fixture(store);
      const subject = identity('anon:memo_history');
      const now = Date.now();
      for (let i = 0; i < 150; i++) {
        store.recordEvent({ eventId: `memo_event_${i}`, subjectKey: subject.subjectKey!, type: 'play_complete', trackRef: 'netease:186016', weight: 2.5, createdAt: now });
        store.recordEntityFeedback!({ feedbackId: `memo_track_${i}`, subjectKey: subject.subjectKey!, entityType: 'track', entityId: i % 2 ? track.canonicalTrackId : 'netease:186016', action: 'play_complete', weight: 2.5, createdAt: now });
        store.recordEntityFeedback!({ feedbackId: `memo_mv_${i}`, subjectKey: subject.subjectKey!, entityType: 'mv', entityId: mv.id, action: 'watch_complete', weight: 2.5, createdAt: now });
        store.recordEntityFeedback!({ feedbackId: `memo_unknown_${i}`, subjectKey: subject.subjectKey!, entityType: 'mv', entityId: 'netease:987654321', action: 'watch_complete', weight: 2.5, createdAt: now });
      }
      const events = vi.spyOn(store, 'getUserEvents');
      const feedbacks = vi.spyOn(store, 'getUserEntityFeedbacks');
      const tracks = vi.spyOn(store, 'getTrack');
      const entities = vi.spyOn(store, 'getEntity');
      const catalogScans = vi.spyOn(store, 'listEntities');
      const relations = vi.spyOn(store, 'getEntityRelations');
      const profile = buildMultiEntityPreferenceProfile(subject, store, envFor(store), now);
      expect(events).toHaveBeenCalledTimes(1);
      expect(feedbacks).toHaveBeenCalledTimes(1);
      expect(tracks).toHaveBeenCalledTimes(1);
      expect(entities).toHaveBeenCalledTimes(3); // Known MV once; missing raw/deterministic IDs once each.
      expect(catalogScans).toHaveBeenCalledTimes(1);
      expect(relations.mock.calls.filter(([id, direction]) => id === mv.id && direction === 'children')).toHaveLength(1);
      expect(profile.directEntityScores.get(track.canonicalTrackId)).toBe(750);
      expect(profile.directEntityScores.get(mv.id)).toBe(375);
      expect(profile.directEntityScores.get('netease:987654321')).toBe(375);
      expect(profile.propagatedEntityScores.get(track.canonicalTrackId)).toBeCloseTo(375 * 0.45, 8);
      for (const spy of [events, feedbacks, tracks, entities, catalogScans, relations]) spy.mockRestore();
    }
  });

  it('does not retain reference misses, metadata or user state across profile calls', async () => {
    for (const store of [new MemoryRecommendStore(), sqlite()]) {
      fixture(store);
      const subject = identity('anon:memo_refresh');
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        store.recordEvent({ eventId: `late_song_${i}`, subjectKey: subject.subjectKey!, type: 'play_complete', trackRef: 'netease:987654321', weight: 2.5, createdAt: now });
        store.recordEntityFeedback!({ feedbackId: `late_mv_${i}`, subjectKey: subject.subjectKey!, entityType: 'mv', entityId: 'netease:7654321', action: 'watch_complete', weight: 2.5, createdAt: now });
      }
      const pending = buildMultiEntityPreferenceProfile(subject, store, envFor(store), now);
      expect(pending.directEntityScores.get('netease:7654321')).toBe(7.5);
      expect(pending.propagatedEntityScores.size).toBe(0);
      const track = toCanonicalTrack({ id: '987654321', platform: 'netease', title: 'New trusted song', artist: 'New artist', duration: 180 })!;
      store.upsertTrack(track);
      ingestVerifiedMvCatalog([{ id: '7654321', title: 'New trusted video', artistName: 'New artist', songId: '987654321' }], store);
      const mvId = computeMvEntityId('netease', '7654321');
      const resolved = buildMultiEntityPreferenceProfile(subject, store, envFor(store), now);
      expect(resolved.directEntityScores.get('netease:7654321')).toBeUndefined();
      expect(resolved.directEntityScores.get(mvId)).toBe(7.5);
      expect(resolved.directEntityScores.get(track.canonicalTrackId)).toBe(7.5);
      expect(resolved.propagatedEntityScores.get(track.canonicalTrackId)).toBeCloseTo(7.5 * 0.45, 8);
      expect(buildUserPreferenceProfile(subject, store, now).longTermArtists['New artist']).toBeGreaterThan(0);
      await ingestBehaviorEvents([{ eventId: 'memo_dislike_video', entityType: 'mv', entityId: mvId, action: 'dislike', timestamp: now + 1 }], subject, envFor(store));
      expect(buildMultiEntityPreferenceProfile(subject, store, envFor(store), now + 2).blockedEntityIds.has(mvId)).toBe(true);
      expect(store.clearUserEvents(subject.subjectKey!)).toBe(7);
      expect(buildMultiEntityPreferenceProfile(subject, store, envFor(store), now + 3).hasSignals).toBe(false);
      expect(buildUserPreferenceProfile(subject, store, now + 3).totalEvents).toBe(0);
    }
  });
});

describe('server-verified MV catalog boundary', () => {
  it('imports a real provider ID, resolves client external IDs and serves mixed feed after SQLite reopen', async () => {
    const file = tempDb();
    let store = sqlite(file);
    ensureMultiEntityCatalogSeeded(store);
    const track = store.getTrack('186016')!;
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('catalog/event path must not fetch'));
    const providerItem = {
      id: 550001, name: '晴天', artists: [{ id: 6452, name: '周杰伦' }],
      cover: 'http://p1.music.126.net/verified-cover.jpg', duration: 269000, songId: 186016,
    };
    expect(ingestVerifiedMvCatalog([providerItem], store)).toBe(1);
    const mvId = computeMvEntityId('netease', '550001');
    expect(store.getEntity(mvId)).toMatchObject({
      type: 'mv', title: '晴天', artistName: '周杰伦', source: 'netease', sourceId: '550001',
      coverUrl: 'https://p1.music.126.net/verified-cover.jpg', duration: 269,
      payload: { mvId: '550001', relatedTrackId: track.canonicalTrackId },
    });
    const createdAt = store.getEntity(mvId)!.createdAt;
    expect(ingestVerifiedMvCatalog([{ ...providerItem, name: '晴天 MV' }], store)).toBe(1);
    expect(store.getEntity(mvId)!.createdAt).toBe(createdAt);
    expect(store.getEntityRelations(mvId, 'children')).toHaveLength(1);
    const payload = { eventId: 'verified_route_mv', entity_type: 'mv', entity_id: '550001', action: 'watch_complete', track: { id: '65538', title: 'Client cannot rename MV' } };
    expect(await (await eventsHttp({ request: request('POST', payload), env: envFor(store) })).json()).toMatchObject({ data: { accepted: 1 } });
    store.close(); store = sqlite(file);
    expect(await (await eventsHttp({ request: request('POST', payload), env: envFor(store) })).json()).toMatchObject({ data: { accepted: 0, deduplicated: 1 } });
    const response = await feedHttp({
      request: new Request('https://sonic.test/api/sonic/recommend/for-you?feed=mixed&types=mv', { headers: request('GET').headers }),
      env: envFor(store),
    });
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toContainEqual(expect.objectContaining({ id: mvId, type: 'mv', title: '晴天 MV', payload: expect.objectContaining({ mvId: '550001' }) }));
    expect(store.getEntityRelations(mvId, 'children')[0].childId).toBe(track.canonicalTrackId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not infer track relations from MV IDs, titles, client canonical IDs or unknown provider song IDs', async () => {
    const store = new MemoryRecommendStore();
    ensureMultiEntityCatalogSeeded(store);
    const track = store.getTrack('186016')!;
    const count = store.getStats().trackCount;
    // Retain an event before the server's provider response has populated the catalog.
    await ingestBehaviorEvents([{ eventId: 'pending_verified_mv', entityType: 'mv', entityId: '7654321', action: 'watch_complete' }], identity(), envFor(store));
    expect(store.listEntities('mv')).toEqual([]);
    expect(ingestVerifiedMvCatalog([
      { id: '7654321', title: track.title, artistName: track.canonicalArtist, songId: '999999999', canonicalTrackId: track.canonicalTrackId },
      { id: '186016', title: track.title, artistName: track.canonicalArtist, trackId: track.canonicalTrackId },
    ], store)).toBe(2);
    const mvId = computeMvEntityId('netease', '7654321');
    expect(store.getEntityRelations(mvId)).toEqual([]);
    expect(store.getEntityRelations(computeMvEntityId('netease', '186016'))).toEqual([]);
    expect(store.getStats().trackCount).toBe(count);
    const profile = buildMultiEntityPreferenceProfile(identity(), store);
    expect(profile.directEntityScores.get(mvId)).toBeGreaterThan(0);
    expect(profile.propagatedEntityScores.size).toBe(0);
    const feed = await getMultiEntityRecommendationsForYou(identity(), { allowedTypes: ['mv'], temperature: 0 }, envFor(store));
    expect(feed.data.some((item) => item.id === mvId && item.payload.relatedTrackId === undefined)).toBe(true);
  });

  it('validates provider metadata and bounds work to the first 100 records', () => {
    const store = new MemoryRecommendStore();
    const valid = { id: '550001', title: 'Validated MV', artistName: 'Artist', cover: 'https://p1.music.126.net/cover.jpg', duration: 180000 };
    expect(ingestVerifiedMvCatalog([valid], store, 'unknown')).toBe(0);
    expect(ingestVerifiedMvCatalog({ data: [valid] }, store)).toBe(0);
    const invalid = [
      null, [], { ...valid, id: 0 }, { ...valid, id: 'mv_forged' },
      { ...valid, title: '' }, { ...valid, title: 'x'.repeat(257) },
      { ...valid, artistName: {} }, { ...valid, artistName: 'bad\u0000name' },
      { ...valid, source: 'qq' }, { ...valid, provider: 'missing' },
      { ...valid, cover: 'javascript:alert(1)' }, { ...valid, cover: 'https://user:pass@p1.music.126.net/a.jpg' },
      { ...valid, cover: 'http://127.0.0.1/a.jpg' }, { ...valid, duration: -1 },
      { ...valid, duration: Infinity }, { ...valid, duration: 'not-a-number' },
    ];
    expect(ingestVerifiedMvCatalog(invalid, store)).toBe(0);
    const records = Array.from({ length: 101 }, (_, i) => ({ ...valid, id: String(550001 + i) }));
    expect(ingestVerifiedMvCatalog(records, store, 'ncm')).toBe(100);
    expect(store.listEntities('mv', 200)).toHaveLength(100);
    expect(store.getEntity(computeMvEntityId('netease', '550101'))).toBeNull();
    const qq = { id: 'qqVerifiedVid', name: 'QQ MV', artist: 'Artist', duration: 180 };
    expect(ingestVerifiedMvCatalog([qq, qq], store, 'qq')).toBe(1);
    expect(store.getEntity(computeMvEntityId('qq', qq.id))).toMatchObject({ duration: 180, source: 'qq', sourceId: qq.id });
  });
});

describe('SQLite upgrade and durable HTTP contracts', () => {
  for (const constraint of ['PRIMARY KEY', 'UNIQUE', 'INDEX']) {
    it(`migrates old ${constraint} event/feedback IDs atomically, preserves rows and survives reopen`, async () => {
      const file = tempDb();
      const old = new DatabaseSync(file);
      const inline = constraint === 'INDEX' ? '' : constraint;
      old.exec(`
        CREATE TABLE behavior_events (event_id TEXT ${inline}, subject_key TEXT NOT NULL, event_type TEXT NOT NULL,
          canonical_track_id TEXT, artist_key TEXT, genres_json TEXT, language TEXT, query TEXT, weight REAL NOT NULL,
          progress_ratio REAL, created_at INTEGER NOT NULL);
        CREATE TABLE user_entity_feedback (feedback_id TEXT ${inline}, subject_key TEXT NOT NULL, entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL, action TEXT NOT NULL, weight REAL NOT NULL, progress REAL, context_json TEXT, created_at INTEGER NOT NULL);
        ${constraint === 'INDEX' ? 'CREATE UNIQUE INDEX old_event_unique ON behavior_events(event_id); CREATE UNIQUE INDEX old_feedback_unique ON user_entity_feedback(feedback_id);' : ''}
      `);
      const now = Date.now();
      old.prepare('INSERT INTO behavior_events(event_id,subject_key,event_type,weight,created_at) VALUES (?,?,?,?,?)').run('old_event_id', 'anon:A', 'search', 0.3, now);
      old.prepare('INSERT INTO user_entity_feedback VALUES (?,?,?,?,?,?,?,?,?)').run('old_feedback_id', 'anon:A', 'mv', 'netease:550001', 'watch_complete', 2.5, 1, '{"from":"old"}', now);
      old.close();
      let store = sqlite(file);
      expect(store.getUserEvents('anon:A')[0]).toMatchObject({ eventId: 'old_event_id', type: 'search' });
      expect(store.getUserEntityFeedbacks('anon:A')[0].context).toEqual({ from: 'old' });
      const ev = store.getUserEvents('anon:A')[0];
      const fb = store.getUserEntityFeedbacks('anon:A')[0];
      expect(store.recordEvent({ ...ev, subjectKey: 'anon:B' }).inserted).toBe(true);
      expect(store.recordEntityFeedback({ ...fb, subjectKey: 'anon:B' }).inserted).toBe(true);
      expect(store.recordEvent(ev).deduplicated).toBe(true);
      expect(store.recordEntityFeedback(fb).deduplicated).toBe(true);
      store.close();
      store = sqlite(file);
      expect(store.getStats().eventCount).toBe(4);
      expect(store.clearUserEvents('anon:A')).toBe(2);
      store.close();
      store = sqlite(file);
      expect(store.getUserEvents('anon:A')).toHaveLength(0);
      expect(store.getUserEntityFeedbacks('anon:A')).toHaveLength(0);
      expect(store.getStats().eventCount).toBe(2);
    });
  }

  it('rolls back an unsupported unique-key migration without changing existing rows', () => {
    const file = tempDb();
    const old = new DatabaseSync(file);
    // An externally edited inline named constraint must either migrate correctly
    // or abort atomically, never boot with an unnoticed globally unique key.
    old.exec(`CREATE TABLE behavior_events (event_id TEXT CONSTRAINT external_key UNIQUE,
      subject_key TEXT NOT NULL, event_type TEXT NOT NULL, canonical_track_id TEXT,
      artist_key TEXT, genres_json TEXT, language TEXT, query TEXT, weight REAL NOT NULL,
      progress_ratio REAL, created_at INTEGER NOT NULL);
      INSERT INTO behavior_events(event_id, subject_key, event_type, weight, created_at)
      VALUES ('old_event_id', 'A', 'search', 0.3, 1);`);
    old.close();
    expect(() => new SqliteRecommendStore(file)).toThrow(/migration rolled back/);
    const check = new DatabaseSync(file);
    try {
      expect(check.prepare('SELECT event_id FROM behavior_events').all()).toEqual([{ event_id: 'old_event_id' }]);
      expect(check.prepare('PRAGMA table_info(behavior_events)').all().some((c: any) => c.name === 'track_ref')).toBe(false);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_subject_key_migration'").all()).toEqual([]);
    } finally { check.close(); }
  });

  it('retains provider entity relationships, signals and mixed/legacy shapes across SQLite restart', async () => {
    const file = tempDb();
    let store = sqlite(file);
    const { track, mv } = fixture(store);
    const album = store.listEntities('album', 1)[0];
    const playlist = store.listEntities('playlist', 1)[0];
    const batch = [
      { eventId: 'http_track_id', type: 'play_complete', track: { id: '186016' } },
      { eventId: 'http_album_id', entityType: 'album', entityId: album.id, action: 'favorite' },
      { eventId: 'http_playlist_id', entity_type: 'playlist', entity_id: playlist.id, action: 'favorite' },
      { eventId: 'http_mv_id', entityType: 'mv', entityId: 550001, action: 'watch_complete' },
    ];
    let response = await eventsHttp({ request: request('POST', { events: batch }), env: envFor(store) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ brand: 'Sonic', data: { ok: true, accepted: 4, deduplicated: 0, storageKind: 'sqlite' } });
    store.close(); store = sqlite(file);
    response = await eventsHttp({ request: request('POST', { events: batch }), env: envFor(store) });
    expect(await response.json()).toMatchObject({ data: { accepted: 0, deduplicated: 4 } });
    const status = await eventsHttp({ request: request('GET'), env: envFor(store) });
    expect(await status.json()).toMatchObject({ data: { totalEvents: 4 } });
    expect(store.getEntityRelations(mv.id, 'children')[0].childId).toBe(track.canonicalTrackId);
    for (const mixed of [false, true]) {
      const feed = await feedHttp({ request: new Request(`https://sonic.test/api/sonic/recommend/for-you?count=20${mixed ? '&feed=mixed' : ''}`, { headers: request('GET').headers }), env: envFor(store) });
      const body = await feed.json();
      expect(Array.isArray(mixed ? body.data : body.data.tracks)).toBe(true);
      if (mixed) {
        expect(body.data.items).toBeUndefined();
        expect(body.data.some((i: any) => i.type === 'mv' && i.id === mv.id)).toBe(true);
      }
    }
    response = await eventsHttp({ request: request('DELETE'), env: envFor(store) });
    expect(await response.json()).toMatchObject({ data: { cleared: true, removedEvents: 4 } });
    store.close(); store = sqlite(file);
    expect(store.getStats().eventCount).toBe(0);
    expect(await (await eventsHttp({ request: request('GET'), env: envFor(store) })).json()).toMatchObject({ data: { totalEvents: 0 } });
  });

  it.each([
    { entity_type: 'video', entity_id: '123', action: 'open' },
    { entityType: 'video', entityId: '123', action: 'open' },
    { entity_type: 'mv', entityType: 'album', entity_id: '123', action: 'open' },
    { entity_type: 'mv', entity_id: { bad: true }, action: 'open' },
    { entityType: 'mv', entityId: '123', action: 'open', type: 'dislike' },
    { type: 'search', query: { injected: true } },
  ])('rejects invalid entity aliases before any write (%j)', async (event) => {
    const store = sqlite();
    const response = await eventsHttp({ request: request('POST', event), env: envFor(store) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toMatch(/^INVALID_/);
    expect(store.getStats().eventCount).toBe(0);
  });

  it.each(['POST', 'DELETE'])('returns retryable 503 on primary %s failure without local mutation', async (method) => {
    const edge = new MemoryRecommendStore();
    fixture(edge);
    await ingestBehaviorEvents([{ eventId: 'existing_local', type: 'search', query: 'keep' }], identity(), envFor(edge));
    const env = { ...envFor(edge), SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_LOCAL_ENGINE_URL: 'https://engine-beta.test' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('engine offline', { status: 530 }));
    const response = await eventsHttp({ request: request(method, method === 'POST' ? { events: [{ eventId: 'retry_event_01', type: 'search', query: 'new' }] } : undefined), env });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'EVENT_STORAGE_UNAVAILABLE' }, meta: { retryable: true } });
    expect(edge.getStats().eventCount).toBe(1);
  });

  it('fails closed on timeout, malformed success, memory acknowledgments and durable write errors', async () => {
    const edge = new MemoryRecommendStore();
    const env = { ...envFor(edge), SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_LOCAL_ENGINE_URL: 'https://engine-beta.test' };
    const fetch = vi.spyOn(globalThis, 'fetch');
    const body = { events: [{ eventId: 'retry_event_02', type: 'search', query: 'new' }] };
    fetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect((await eventsHttp({ request: request('POST', body), env })).status).toBe(503);
    fetch.mockResolvedValueOnce(Response.json({ brand: 'Sonic', data: { ok: true, storageKind: 'memory', accepted: 1 } }));
    expect((await eventsHttp({ request: request('POST', body), env })).status).toBe(503);
    fetch.mockResolvedValueOnce(Response.json({ brand: 'Sonic', data: { cleared: false, removedEvents: 0 } }));
    expect((await eventsHttp({ request: request('DELETE'), env })).status).toBe(503);
    fetch.mockResolvedValueOnce(Response.json({ brand: 'Sonic', data: { cleared: true, removedEvents: 1, storageKind: 'memory' } }));
    expect((await eventsHttp({ request: request('DELETE'), env })).status).toBe(503);
    expect(edge.getStats().eventCount).toBe(0);
    expect((await eventsHttp({ request: request('POST', body), env: envFor(edge) })).status).toBe(503);
    const durable = sqlite();
    fixture(durable);
    vi.spyOn(durable, 'recordEvent').mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    expect((await eventsHttp({ request: request('POST', body), env: envFor(durable) })).status).toBe(503);
  });

  it('returns authority removal count and keeps subject retries durable after a lost acknowledgment', async () => {
    const durable = sqlite();
    fixture(durable);
    const edge = new MemoryRecommendStore();
    const env = { ...envFor(edge), SONIC_ENABLE_LOCAL_ENGINE: '1', SONIC_LOCAL_ENGINE_URL: 'https://engine-beta.test' };
    let dropAck = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const result = await eventsHttp({ request: new Request('https://authority.test/api/sonic/events', init), env: envFor(durable) });
      if (dropAck) { dropAck = false; throw new DOMException('lost ack', 'TimeoutError'); }
      return result;
    });
    const payload = { events: [{ eventId: 'lost_ack_event', type: 'play_complete', track: { id: '186016' } }] };
    expect((await eventsHttp({ request: request('POST', payload), env })).status).toBe(503);
    expect(durable.getStats().eventCount).toBe(1);
    const retried = await eventsHttp({ request: request('POST', payload), env });
    expect(await retried.json()).toMatchObject({ data: { accepted: 0, deduplicated: 1 } });
    const deleted = await eventsHttp({ request: request('DELETE'), env });
    expect(await deleted.json()).toMatchObject({ data: { cleared: true, removedEvents: 1 } });
    expect(durable.getStats().eventCount).toBe(0);
  });

  it('removes all retained memory rows/keys beyond the old 600-row user index', () => {
    const store = new MemoryRecommendStore();
    for (let i = 0; i < 650; i++) store.recordEvent({ eventId: `large_${i}`, subjectKey: 'A', type: 'search', weight: 0.3, createdAt: i });
    expect(store.clearUserEvents('A')).toBe(650);
    expect(store.getStats().eventCount).toBe(0);
    expect(store.recordEvent({ eventId: 'large_0', subjectKey: 'A', type: 'search', weight: 0.3, createdAt: 0 }).inserted).toBe(true);
  });

  it('keeps station favorite/dislike state independent of input ordering', () => {
    const track = toCanonicalTrack({ title: 'Song', artist: 'Artist', id: '123' })!;
    const now = Date.now();
    const events = [
      { eventId: 'favorite_01', subjectKey: 'A', canonicalTrackId: track.canonicalTrackId, type: 'favorite' as const, weight: 4, createdAt: now - 100 },
      { eventId: 'unfavorite_01', subjectKey: 'A', canonicalTrackId: track.canonicalTrackId, type: 'unfavorite' as const, weight: -1.5, createdAt: now },
    ];
    expect(computeCatalogPopularity([track], events, { nowMs: now }).get(track.canonicalTrackId)?.internalScore).toBe(0);
    expect(computeCatalogPopularity([track], [...events].reverse(), { nowMs: now })).toEqual(computeCatalogPopularity([track], events, { nowMs: now }));
  });
});

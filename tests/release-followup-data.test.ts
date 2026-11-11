import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as eventsHttp } from '../functions/api/sonic/events';
import type { AppEnv } from '../functions/_lib/types';
import { resetLocalEngineCircuitForTest } from '../functions/_lib/sonic/local-engine';
import { MemoryRecommendStore } from '../functions/_lib/sonic/recommend/memory-store';
import { SqliteRecommendStore, createServerRecommendStore } from '../server/recommend-sqlite';
import {
  clearUserRecommendationData, clearUserRecommendationDataAndExternal, ingestBehaviorEvents,
} from '../functions/_lib/sonic/recommend/engine';
import { deleteGorseUserData, syncFeedbackToGorse } from '../functions/_lib/sonic/recommend/external-adapters';
import { resolveUserIdentity } from '../functions/_lib/sonic/recommend/identity';
import { ensureCatalogSeeded } from '../functions/_lib/sonic/recommend/seed-catalog';
import { executeSmartSearch } from '../functions/_lib/sonic/recommend/smart-search';
import type { RecommendStore, SonicEntity, StoredBehaviorEvent, UserIdentityContext } from '../functions/_lib/sonic/recommend/types';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 10, 2);
const dirs: string[] = [];
const stores: SqliteRecommendStore[] = [];
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-retention-test-'));
  dirs.push(dir);
  return path.join(dir, 'recommend.sqlite');
}
function sqlite(file = ':memory:', days = 90): SqliteRecommendStore {
  const store = new SqliteRecommendStore(file, days);
  stores.push(store);
  return store;
}
const identity = (subjectKey = 'anon:data_A'): UserIdentityContext => ({
  mode: 'anonymous-opt-in', subjectKey, personalizationEnabled: true, isAuthenticated: false,
});
const publicIdentity: UserIdentityContext = {
  mode: 'public', subjectKey: null, personalizationEnabled: false, isAuthenticated: false,
};
const envFor = (store: RecommendStore) => ({ RECOMMEND_STORE: store, SONIC_RECOMMEND_OFFLINE: '1' });

it('rolls over a full anonymous epoch budget without accepting old activity or changing account epochs', async () => {
  vi.stubEnv('SONIC_RECOMMEND_MAX_ANON_ERASURE_ROWS', '1');
  const file = tempDb();
  let store = sqlite(file);
  const guestA = 'anon_epoch_budget_a';
  const guestB = 'anon_epoch_budget_b';
  const guestC = 'anon_epoch_budget_c';
  const accountEpoch = 'a'.repeat(32);
  store.clearUserEvents('usr_epoch_budget', accountEpoch);
  const send = (request: Request) => eventsHttp({ request, env: envFor(store) });
  const read = async (guest: string) => {
    const response = await send(eventRequest('GET', guest));
    expect(response.status).toBe(200);
    return (await response.json()).data;
  };
  const clear = async (guest: string, removedEvents: number) => {
    const response = await send(eventRequest('DELETE', guest));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ cleared: true, removedEvents, eventEpoch: expect.stringMatching(/^[0-9a-f]{32}$/) });
    return data.eventEpoch as string;
  };
  const batch = [{ type: 'search', query: 'epoch capacity', eventId: 'epoch_budget_event' }];
  const firstA = await clear(guestA, 0);
  const refreshedA = await clear(guestA, 0);
  expect(refreshedA).not.toBe(firstA);
  expect((await read(guestB)).eventEpoch).toBeNull();
  expect((await send(eventRequest('POST', guestB, { events: batch }))).status).toBe(200);
  const oldA = eventRequest('POST', guestA, { events: batch, eventEpoch: refreshedA });
  const unmarkedC = eventRequest('POST', guestC, { events: batch });

  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TRIGGER block_epoch_insert BEFORE INSERT ON recommendation_event_epochs BEGIN SELECT RAISE(ABORT, 'epoch insert blocked'); END");
    expect((await send(eventRequest('DELETE', guestB))).status).toBe(503);
    expect((await read(guestA)).eventEpoch).toBe(refreshedA);
    expect(await read(guestB)).toMatchObject({ eventEpoch: null, totalEvents: 1 });
  } finally {
    db.exec('DROP TRIGGER IF EXISTS block_epoch_insert');
    db.close();
  }

  const overrideB = await clear(guestB, 1);
  const derivedA = (await read(guestA)).eventEpoch;
  const derivedC = (await read(guestC)).eventEpoch;
  for (const derived of [derivedA, derivedC]) expect(derived).toMatch(/^[0-9a-f]{32}$/);
  expect(new Set([refreshedA, overrideB, derivedA, derivedC]).size).toBe(4);
  expect(await clear(guestB, 0)).not.toBe(overrideB);
  expect((await read(guestA)).eventEpoch).toBe(derivedA);
  expect((await read(guestC)).eventEpoch).toBe(derivedC);

  store.close();
  store = sqlite(file);
  expect((await read(guestA)).eventEpoch).toBe(derivedA);
  expect((await read(guestC)).eventEpoch).toBe(derivedC);
  expect(store.getEventEpoch('usr_epoch_budget')).toBe(accountEpoch);
  expect(store.getEventEpoch('usr_untouched')).toBeNull();
  for (const [incoming, expected] of [[oldA, derivedA], [unmarkedC, derivedC]] as const) {
    const rejected = await send(incoming);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'EVENT_EPOCH_MISMATCH' },
      data: { eventEpoch: expected, privacyMode: 'anonymous-opt-in' },
    });
  }
  expect(store.getStats().eventCount).toBe(0);
  const fresh = await send(eventRequest('POST', guestA, { events: batch, eventEpoch: derivedA }));
  expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({ data: { accepted: 1 } });
});
function eventRequest(method: 'GET' | 'POST' | 'DELETE', guestId: string, body?: unknown): Request {
  return new Request('https://edge.erasure.test/api/sonic/events', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': guestId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const event = (id: string, subject = 'anon:data_A', createdAt = NOW): StoredBehaviorEvent => ({
  eventId: id, subjectKey: subject, type: 'search', query: 'private query', weight: 0.3, createdAt,
});
function addRows(store: RecommendStore, subject: string, time: number) {
  store.recordEvent(event('track_event', subject, time));
  store.recordEntityFeedback!({ feedbackId: 'entity_event', subjectKey: subject, entityType: 'mv', entityId: 'netease:123', action: 'watch_complete', weight: 2.5, createdAt: time });
}
const entity = (): SonicEntity => ({
  id: 'alb_test', type: 'album', title: 'Album', source: 'sonic', tags: [], externalPopularity: 0,
  createdAt: Date.now(), updatedAt: Date.now(), payload: {},
});

// Tests use only local temp SQLite databases and mocked fetch; never real services.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLocalEngineCircuitForTest();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable event epoch after erasure', () => {
  const guestA = 'anon_epoch_subject_a';
  const guestB = 'anon_epoch_subject_b';

  it.each(['local SQLite', 'signed Engine hop'])('blocks old event batches and accepts new activity (%s)', async (runtime) => {
    const file = tempDb();
    let store = sqlite(file);
    store.upsertEntity(entity());
    const shared: AppEnv = {
      SONIC_ENV: 'test',
      SONIC_RATE_LIMIT_ANON_RPM: '10000',
      SONIC_ENGINE_SECRET: 'epoch-service-key-at-least-32-characters',
      SONIC_ENGINE_IDENTITY_SECRET: 'epoch-identity-key-at-least-32-characters',
      SONIC_REQUIRE_ENGINE_IDENTITY: '1',
    };
    const throughEngine = runtime === 'signed Engine hop';
    const edgeEnv: AppEnv = { ...shared, SONIC_LOCAL_ENGINE_URL: 'https://engine.erasure.test' };
    if (throughEngine) {
      vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => eventsHttp({
        request: new Request(String(url), init),
        env: { ...shared, ...envFor(store), SONIC_RUNTIME: 'linux-engine' },
      }));
    }
    const send = (incoming: Request) => eventsHttp({
      request: incoming, env: throughEngine ? edgeEnv : { ...shared, ...envFor(store) },
    });
    const batch = [
      { type: 'search', query: 'stale private search', eventId: 'epoch_search' },
      { type: 'open', entityType: 'album', entityId: 'alb_test', eventId: 'epoch_album', timestamp: Date.now() + 30_000 },
    ];
    const heldBeforeFirstClear = eventRequest('POST', guestA, { events: batch });
    const before = await send(eventRequest('GET', guestA));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ data: { eventEpoch: null, totalEvents: 0 } });
    expect((await send(eventRequest('POST', guestB, { events: [batch[0]] }))).status).toBe(200);

    const cleared = await send(eventRequest('DELETE', guestA));
    expect(cleared.status).toBe(200);
    const first = await cleared.json();
    expect(first.data).toMatchObject({ cleared: true, removedEvents: 0, eventEpoch: expect.stringMatching(/^[0-9a-f]{32}$/) });

    store.close();
    store = sqlite(file);
    const reopened = await send(eventRequest('GET', guestA));
    expect(await reopened.json()).toMatchObject({ data: { eventEpoch: first.data.eventEpoch, totalEvents: 0 } });
    const assertConflict = async (incoming: Request, eventEpoch: string) => {
      const conflict = await send(incoming);
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get('cache-control')).toContain('no-store');
      expect(await conflict.json()).toMatchObject({
        brand: 'Sonic',
        error: { code: 'EVENT_EPOCH_MISMATCH' },
        data: { eventEpoch, privacyMode: 'anonymous-opt-in' },
      });
      const profile = await send(eventRequest('GET', guestA));
      expect(await profile.json()).toMatchObject({ data: { eventEpoch, totalEvents: 0 } });
      expect(store.getStats().eventCount).toBe(1);
    };
    await assertConflict(heldBeforeFirstClear, first.data.eventEpoch);

    const current = await send(eventRequest('POST', guestA, { events: batch, eventEpoch: first.data.eventEpoch }));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ data: { accepted: 2 } });
    const heldBeforeSecondClear = eventRequest('POST', guestA, { events: batch, eventEpoch: first.data.eventEpoch });
    const clearedAgain = await send(eventRequest('DELETE', guestA));
    expect(clearedAgain.status).toBe(200);
    const second = await clearedAgain.json();
    expect(second.data).toMatchObject({ cleared: true, removedEvents: 2, eventEpoch: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(second.data.eventEpoch).not.toBe(first.data.eventEpoch);
    await assertConflict(heldBeforeSecondClear, second.data.eventEpoch);

    const fresh = await send(eventRequest('POST', guestA, { events: batch, eventEpoch: second.data.eventEpoch }));
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ data: { accepted: 2 } });
    const other = await send(eventRequest('GET', guestB));
    expect(await other.json()).toMatchObject({ data: { totalEvents: 1, eventEpoch: null } });
    const optedOut = eventRequest('GET', guestA);
    optedOut.headers.set('X-Sonic-Personalization', 'off');
    const publicProfile = await send(optedOut);
    const publicData = (await publicProfile.json()).data;
    expect(publicData).toMatchObject({ privacyMode: 'public', totalEvents: 0 });
    expect(publicData.eventEpoch).not.toBe(second.data.eventEpoch);
  });
});

describe('configured SQLite retention', () => {
  it.each([7, 90])('uses %i days on startup and subsequent automatic sweeps', (days) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.stubEnv('SONIC_RECOMMEND_RETENTION_DAYS', String(days));
    const file = tempDb();
    const seed = sqlite(file);
    addRows(seed, 'age30', NOW - 30 * DAY);
    addRows(seed, 'age100', NOW - 100 * DAY);
    addRows(seed, 'age1', NOW - DAY);
    seed.close();
    const store = createServerRecommendStore(file) as SqliteRecommendStore;
    stores.push(store);
    expect(store.getUserEvents('age30')).toHaveLength(days === 7 ? 0 : 1);
    expect(store.getUserEntityFeedbacks('age30')).toHaveLength(days === 7 ? 0 : 1);
    expect(store.getUserEvents('age100')).toEqual([]);
    expect(store.getUserEntityFeedbacks('age100')).toEqual([]);
    expect(store.getUserEvents('age1')).toHaveLength(1);
    // Backdated imports after startup must get the same window on the 1500-write sweep.
    addRows(store, 'periodic30', NOW - 30 * DAY);
    addRows(store, 'periodic100', NOW - 100 * DAY);
    for (let i = 0; i < 1500; i++) store.recordEvent(event(`write_${i}`, 'writer'));
    expect(store.getUserEvents('periodic30')).toHaveLength(days === 7 ? 0 : 1);
    expect(store.getUserEntityFeedbacks('periodic30')).toHaveLength(days === 7 ? 0 : 1);
    expect(store.getUserEvents('periodic100')).toEqual([]);
    expect(store.getUserEntityFeedbacks('periodic100')).toEqual([]);
  });

  it.each(['feedback', 'catalog'] as const)('prunes during %s-only writes without requiring track events', (writer) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = sqlite(':memory:', 7);
    addRows(store, 'expired', NOW - 30 * DAY);
    addRows(store, 'retained', NOW - DAY);
    for (let i = 0; i < 1500; i++) {
      if (writer === 'feedback') store.recordEntityFeedback({ feedbackId: `feedback_${i}`, subjectKey: 'writer', entityType: 'album', entityId: 'alb_test', action: 'open', weight: 0.5, createdAt: NOW });
      else store.upsertEntity(entity());
    }
    expect(store.getUserEvents('expired')).toEqual([]);
    expect(store.getUserEntityFeedbacks('expired')).toEqual([]);
    expect(store.getUserEvents('retained')).toHaveLength(1);
    expect(store.getUserEntityFeedbacks('retained')).toHaveLength(1);
  });

  it('also sweeps on the next write after one hour of low traffic', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = sqlite(':memory:', 7);
    addRows(store, 'boundary', NOW - 7 * DAY + 1000);
    clock.mockReturnValue(NOW + 3600_001);
    store.upsertEntity(entity());
    expect(store.getUserEvents('boundary')).toEqual([]);
    expect(store.getUserEntityFeedbacks('boundary')).toEqual([]);
  });

  it('rolls back a failed sweep, surfaces the error, and retries before acknowledging a write', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const file = tempDb();
    const store = sqlite(file, 7);
    addRows(store, 'expired', NOW - 30 * DAY);
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER block_retention BEFORE DELETE ON user_entity_feedback BEGIN SELECT RAISE(ABORT, 'retention blocked'); END");
      clock.mockReturnValue(NOW + 3600_001);
      expect(() => store.recordEvent(event('unacknowledged', 'writer'))).toThrow(/retention blocked/);
      expect(store.getUserEvents('expired')).toHaveLength(1);
      expect(store.getUserEntityFeedbacks('expired')).toHaveLength(1);
      expect(store.getUserEvents('writer')).toEqual([]);
      db.exec('DROP TRIGGER block_retention');
      expect(store.recordEvent(event('unacknowledged', 'writer')).inserted).toBe(true);
      expect(store.getUserEvents('expired')).toEqual([]);
      expect(store.getUserEntityFeedbacks('expired')).toEqual([]);
    } finally { db.close(); }
  });

  it('closes and fails startup when configured retention cannot be applied', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const file = tempDb();
    const seed = sqlite(file);
    addRows(seed, 'expired', NOW - 30 * DAY);
    seed.close();
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER block_startup BEFORE DELETE ON user_entity_feedback BEGIN SELECT RAISE(ABORT, 'startup retention blocked'); END");
      expect(() => new SqliteRecommendStore(file, 7)).toThrow(/startup retention blocked/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM behavior_events').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM user_entity_feedback').get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it('retention savepoints compose with an existing entity batch transaction', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = sqlite(':memory:', 7);
    addRows(store, 'expired', NOW - 30 * DAY);
    clock.mockReturnValue(NOW + 3600_001);
    expect(() => store.upsertEntities([entity(), { ...entity(), id: 'alb_second' }])).not.toThrow();
    expect(store.getUserEvents('expired')).toEqual([]);
    expect(store.listEntities('album')).toHaveLength(2);
  });
});

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`subject erasure and derived activity (${kind})`, () => {
    const open = (days = 90) => kind === 'sqlite' ? sqlite(':memory:', days) : new MemoryRecommendStore(days);

    it('removes the owner query text/edges/radar and leaves other users plus legacy baselines intact', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const store = open();
      const a = 'anon:data_A', b = 'anon:data_B';
      for (const subject of [a, b]) {
        addRows(store, subject, NOW);
        store.saveUserRadarProfile!(subject, JSON.stringify({ private: subject }));
      }
      const sourceA = { subjectKey: a, eventId: 'track_event' };
      const sourceB = { subjectKey: b, eventId: 'track_event' };
      store.recordSearchQuery('samenorm', 'Private spelling A', true, sourceA);
      store.recordSearchQuery('samenorm', 'Retained spelling B', false, sourceB);
      store.recordSearchQuery('legacy', 'Legacy query', false);
      store.incrementCooccurrence('track_a', 'track_b', 2, sourceA);
      store.incrementCooccurrence('track_a', 'track_b', 3, sourceB);
      store.incrementCooccurrence('track_a', 'track_c', 4, sourceA);
      store.incrementCooccurrence('track_a', 'track_b', 5);
      expect(store.getTopSearchQueries('', 10)).toContainEqual(expect.objectContaining({ count: 4 }));
      expect(store.getCooccurringTracks('track_a')).toContainEqual({ canonicalTrackId: 'track_b', weight: 10 });
      const result = await clearUserRecommendationDataAndExternal(identity(a), envFor(store));
      expect(result).toMatchObject({ cleared: true, localCleared: true, removedEvents: 2, aggregateScope: 'subject-attributed-only', legacyAggregates: 'retained-until-expiry', external: { gorse: 'not-configured', retryable: false } });
      expect(store.getUserEvents(a)).toEqual([]);
      expect(store.getUserEntityFeedbacks!(a)).toEqual([]);
      expect(store.getUserRadarProfile!(a)).toBeNull();
      expect(store.getUserEvents(b)).toHaveLength(1);
      expect(store.getUserEntityFeedbacks!(b)).toHaveLength(1);
      expect(store.getUserRadarProfile!(b)).not.toBeNull();
      expect(store.getTopSearchQueries('', 10)).toEqual(expect.arrayContaining([
        { query: 'Retained spelling B', count: 1 }, { query: 'Legacy query', count: 1 },
      ]));
      expect(JSON.stringify(store.getTopSearchQueries('', 10))).not.toContain('Private spelling A');
      expect(store.getCooccurringTracks('track_a')).toEqual([{ canonicalTrackId: 'track_b', weight: 8 }]);
      expect(store.getCooccurringTracks('track_c')).toEqual([]);
      expect((await clearUserRecommendationDataAndExternal(identity(a), envFor(store))).removedEvents).toBe(0);
      // Late callbacks need the retained source event, so cannot resurrect erased activity.
      store.recordSearchQuery('late', 'late private input', false, sourceA);
      store.incrementCooccurrence('track_a', 'track_c', 4, sourceA);
      expect(store.getTopSearchQueries('late')).toEqual([]);
      expect(store.getCooccurringTracks('track_c')).toEqual([]);
    });

    it('keeps attributed retry dedupe and other subjects even when aggregate caps saturate', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const store = open();
      store.recordEvent(event('same_id', 'A'));
      store.recordEvent(event('same_id', 'B'));
      for (const subject of ['A', 'B']) {
        const source = { subjectKey: subject, eventId: 'same_id' };
        store.recordSearchQuery('key', `${subject} display`, true, source);
        store.recordSearchQuery('key', `${subject} display`, true, source);
        store.incrementCooccurrence('a', 'b', 180, source);
        store.incrementCooccurrence('b', 'a', 180, source);
      }
      expect(store.getTopSearchQueries('key')[0].count).toBe(6);
      expect(store.getCooccurringTracks('a')[0].weight).toBe(200);
      store.clearUserEvents('A');
      expect(store.getTopSearchQueries('key')).toEqual([{ query: 'B display', count: 3 }]);
      expect(store.getCooccurringTracks('a')).toEqual([{ canonicalTrackId: 'b', weight: 180 }]);
    });

    it('purges raw/derived data and legacy aggregates using the same configured TTL', () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const store = open(7);
      addRows(store, 'A', NOW);
      store.recordSearchQuery('attributed', 'Sensitive text', false, { subjectKey: 'A', eventId: 'track_event' });
      store.incrementCooccurrence('a', 'b', 1, { subjectKey: 'A', eventId: 'track_event' });
      store.recordSearchQuery('legacy', 'Legacy text');
      store.incrementCooccurrence('c', 'd', 2);
      store.saveUserRadarProfile!('A', '{"private":true}');
      clock.mockReturnValue(NOW + 8 * DAY);
      for (let i = 0; i < 1500; i++) store.upsertEntity!(entity());
      expect(store.getUserEvents('A')).toEqual([]);
      expect(store.getUserEntityFeedbacks!('A')).toEqual([]);
      expect(store.getUserRadarProfile!('A')).toBeNull();
      expect(store.getTopSearchQueries('')).toEqual([]);
      expect(store.getCooccurringTracks('a')).toEqual([]);
      expect(store.getCooccurringTracks('c')).toEqual([]);
      expect(store.getStats().cooccurrencePairs).toBe(0);
    });

    it('ingests attributed activity only once and completely removes new owner-only queries/edges', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const store = open();
      ensureCatalogSeeded(store);
      const tracks = store.listTracks(2);
      expect(tracks).toHaveLength(2);
      const batch = [
        { eventId: 'private_query', type: 'search' as const, query: 'erase-this-secret' },
        { eventId: 'private_play1', type: 'play_complete' as const, track: { id: tracks[0].canonicalTrackId } },
        { eventId: 'private_play2', type: 'play_complete' as const, track: { id: tracks[1].canonicalTrackId } },
      ];
      expect(await ingestBehaviorEvents(batch, identity(), envFor(store))).toMatchObject({ accepted: 3 });
      expect(await ingestBehaviorEvents(batch, identity(), envFor(store))).toMatchObject({ accepted: 0, deduplicated: 3 });
      expect(store.getTopSearchQueries('')).toEqual([{ query: 'erase-this-secret', count: 1 }]);
      expect(store.getCooccurringTracks(tracks[0].canonicalTrackId)).toHaveLength(1);
      expect(store.getStats().cooccurrencePairs).toBe(1);
      clearUserRecommendationData(identity(), envFor(store));
      expect(store.getTopSearchQueries('')).toEqual([]);
      expect(store.getCooccurringTracks(tracks[0].canonicalTrackId)).toEqual([]);
    });

    it('makes a public/no-subject erase a safe no-op without any external request', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      const store = open();
      addRows(store, 'A', NOW);
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must never fetch'));
      const result = await clearUserRecommendationDataAndExternal(publicIdentity, { ...envFor(store), SONIC_GORSE_URL: 'https://gorse.test' });
      expect(result).toMatchObject({ cleared: false, localCleared: false, removedEvents: 0 });
      expect(store.getStats().eventCount).toBe(2);
      expect(store.clearUserEvents('')).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}

describe('transactional erasure and physical SQLite scope', () => {
  it('rolls every owned table back on a deletion failure and keeps the failure unacknowledged', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const file = tempDb();
    const store = sqlite(file);
    const guestId = 'anon_erasure_rollback';
    const env = envFor(store);
    const who = await resolveUserIdentity(eventRequest('GET', guestId), env);
    const subject = who.subjectKey!;
    addRows(store, subject, NOW);
    const source = { subjectKey: subject, eventId: 'track_event' };
    store.recordSearchQuery('sensitive', 'private text', false, source);
    store.incrementCooccurrence('a', 'b', 2, source);
    store.saveUserRadarProfile(subject, '{"private":true}');
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TRIGGER block_erasure BEFORE DELETE ON user_radar_profiles BEGIN SELECT RAISE(ABORT, 'erase blocked'); END");
      await expect(clearUserRecommendationDataAndExternal(who, env)).rejects.toThrow(/erase blocked/);
      const afterFailure = await eventsHttp({ request: eventRequest('GET', guestId), env });
      expect(afterFailure.status).toBe(200);
      expect(await afterFailure.json()).toMatchObject({ data: { eventEpoch: null } });
      expect(store.getUserEvents(subject)).toHaveLength(1);
      expect(store.getUserEntityFeedbacks(subject)).toHaveLength(1);
      expect(store.getTopSearchQueries('')).toEqual([{ query: 'private text', count: 1 }]);
      expect(store.getCooccurringTracks('a')).toHaveLength(1);
      expect(store.getUserRadarProfile(subject)).not.toBeNull();
      db.exec('DROP TRIGGER block_erasure');
      expect((await clearUserRecommendationDataAndExternal(who, env)).cleared).toBe(true);
      const afterRetry = await eventsHttp({ request: eventRequest('GET', guestId), env });
      expect(await afterRetry.json()).toMatchObject({ data: { eventEpoch: expect.stringMatching(/^[0-9a-f]{32}$/) } });
      for (const table of ['behavior_events', 'user_entity_feedback', 'user_radar_profiles', 'search_query_contributions', 'cooccurrence_contributions']) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE subject_key = ?`).get(subject)).toEqual({ count: 0 });
      }
      store.close();
      const reopened = sqlite(file);
      expect(reopened.getStats().eventCount).toBe(0);
      expect(reopened.getTopSearchQueries('')).toEqual([]);
      expect(reopened.getCooccurringTracks('a')).toEqual([]);
    } finally { db.close(); }
  });

  it('search reads never store raw query popularity outside opted-in event ingestion', async () => {
    const store = new MemoryRecommendStore();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no real network'));
    for (const who of [publicIdentity, identity()]) {
      await executeSmartSearch('a-private-search', { skipLiveUpstream: true }, who, envFor(store));
    }
    expect(store.getTopSearchQueries('')).toEqual([]);
    expect(store.getStats().eventCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit optional Gorse erasure acknowledgments', () => {
  it.each([503, 202, 404, 200])('does not acknowledge completed deletion on status %i without a valid completed response', async (status) => {
    const store = new MemoryRecommendStore();
    const who = identity(`anon:gorse_failure_${status}`);
    store.recordEvent(event('erase_external', who.subjectKey!, Date.now()));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not a completed Gorse erasure', { status }));
    const env = { ...envFor(store), SONIC_GORSE_URL: 'https://gorse.test' };
    expect(clearUserRecommendationData(who, env)).toMatchObject({ cleared: false, localCleared: true, external: { gorse: 'pending', retryable: true } });
    const result = await clearUserRecommendationDataAndExternal(who, env);
    expect(result).toMatchObject({ cleared: false, localCleared: true, external: { gorse: 'failed', retryable: true } });
    expect(store.getUserEvents(who.subjectKey!)).toEqual([]);
  });

  it('reports retryable failure on timeout or invalid configured URL, then retries explicitly', async () => {
    const store = new MemoryRecommendStore();
    const who = identity('anon:gorse_retry');
    const env = { ...envFor(store), SONIC_GORSE_URL: 'https://gorse.test' };
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    expect((await clearUserRecommendationDataAndExternal(who, env)).cleared).toBe(false);
    fetch.mockResolvedValueOnce(Response.json({ RowAffected: 0 }));
    expect(await clearUserRecommendationDataAndExternal(who, env)).toMatchObject({ cleared: true, localCleared: true, external: { gorse: 'deleted', retryable: false } });
    const invalid = await clearUserRecommendationDataAndExternal(who, { ...env, SONIC_GORSE_URL: 'not-a-url' });
    expect(invalid).toMatchObject({ cleared: false, external: { gorse: 'failed' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('encodes the subject once, accepts confirmed Gorse deletion and never clears shared catalog', async () => {
    const store = new MemoryRecommendStore();
    const who = identity('usr:subject/with?reserved');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ RowAffected: 1 }));
    const result = await clearUserRecommendationDataAndExternal(who, { ...envFor(store), SONIC_GORSE_URL: 'https://gorse.test/' });
    expect(result).toMatchObject({ cleared: true, external: { gorse: 'deleted' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://gorse.test/api/user/${encodeURIComponent(who.subjectKey!)}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE', redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('drains active feedback, suppresses queued/late callbacks, and shares concurrent deletion acknowledgment', async () => {
    const who = 'anon:gorse_race';
    const env = { SONIC_GORSE_URL: 'https://gorse.test' };
    let resolveWrite!: (response: Response) => void;
    const active = new Promise<Response>((resolve) => { resolveWrite = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(active).mockResolvedValue(new Response(null, { status: 204 }));
    const write = syncFeedbackToGorse(who, 'track_a', 'play_complete', Date.now(), env);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    const queued = syncFeedbackToGorse(who, 'track_b', 'play_complete', Date.now(), env);
    const deletion = deleteGorseUserData(who, env);
    const deletionAgain = deleteGorseUserData(who, env);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await syncFeedbackToGorse(who, 'track_c', 'play_complete', Date.now(), env)).toBe(false);
    resolveWrite(new Response(null, { status: 204 }));
    expect(await write).toBe(true);
    expect(await queued).toBe(false);
    expect(await deletion).toBe('deleted');
    expect(await deletionAgain).toBe('deleted');
    expect(await syncFeedbackToGorse(who, 'track_d', 'play_complete', Date.now(), env)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
    // The erasure guard is bounded in time; future newly authorized activity can resume.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    expect(await syncFeedbackToGorse(who, 'track_new', 'play_complete', Date.now(), env)).toBe(true);
  });
});

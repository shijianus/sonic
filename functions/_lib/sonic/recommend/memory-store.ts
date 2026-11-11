// Sonic Intelligent Recommendation & Smart Search — Pure-TS Bounded In-Memory Store
// Used on Cloudflare Edge Isolates, read-only environments, and unit tests.
// On Linux VPS, `server/recommend-sqlite.ts` injects `SqliteRecommendStore` via `env.RECOMMEND_STORE`.

import type { AppEnv } from '../../types';
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
} from './types';
import {
  compactNormalize,
  computeFuzzySimilarity,
  expandQueryAliases,
  toPinyinInfo,
  toSimplifiedChinese,
} from './text-norm';
import { canMergeCanonicalTracks, mergeCanonicalTracks } from './track-canonical';
import { compareEventOrder, comparePopularityEventOrder, isPopularityEvent, subjectEventKey } from './event-state';
import { upsertTrackMvEntities } from './entity-store';

const MAX_TRACKS = 6000;
const MAX_EVENTS = 25000;
const MAX_COOCCURRENCE_ANCHORS = 3000;
const MAX_QUERIES = 2000;
// Public mv/* responses ingest entities on every hit; without a ceiling an
// attacker could grow the Edge isolate's memory by varying offsets/IDs (P1-1).
const DEFAULT_MAX_ENTITIES = 50_000;
const DEFAULT_MAX_ENTITY_RELATIONS = 200_000;
const DAY_MS = 24 * 3600 * 1000;

export function normalizeRecommendRetentionDays(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(7, parsed) : 90;
}

export class MemoryRecommendStore implements RecommendStore {
  public readonly kind = 'memory' as const;

  private tracks = new Map<string, CanonicalTrack>();
  private platformIndex = new Map<string, string>(); // "netease:186016" or "186016" -> canonicalTrackId
  private titleArtistIndex = new Map<string, string>(); // "cleantitle:::artist:::edition" -> canonicalTrackId
  private eventIds = new Set<string>();
  private events: StoredBehaviorEvent[] = [];
  private userEventsIndex = new Map<string, StoredBehaviorEvent[]>();
  private cooccurrence = new Map<string, Map<string, { weight: number; updatedAt: number }>>();
  private searchQueries = new Map<string, { display: string; count: number; updatedAt: number }>();
  private queryContributions = new Map<string, { norm: string; display: string; count: number; createdAt: number }>();
  private cooccurrenceContributions = new Map<string, { createdAt: number; edges: Map<string, { a: string; b: string; weight: number }> }>();
  private retentionDays: number;
  private maxEntities: number;
  private maxEntityRelations: number;
  private writeCounter = 0;
  private lastRetentionAt = Date.now();

  constructor(retentionDays: number | string = 90, caps?: { entities?: number; entityRelations?: number }) {
    this.retentionDays = normalizeRecommendRetentionDays(retentionDays);
    this.maxEntities = Math.max(1, Math.floor(caps?.entities ?? DEFAULT_MAX_ENTITIES));
    this.maxEntityRelations = Math.max(1, Math.floor(caps?.entityRelations ?? DEFAULT_MAX_ENTITY_RELATIONS));
  }

  setRetentionDays(retentionDays: number | string): void {
    const days = normalizeRecommendRetentionDays(retentionDays);
    if (days !== this.retentionDays) this.pruneRetention(days);
  }

  private beforeWrite(): void {
    if (++this.writeCounter >= 1500 || Date.now() - this.lastRetentionAt >= 3600_000) this.pruneRetention();
  }

  pruneRetention(retentionDays = this.retentionDays): void {
    this.retentionDays = normalizeRecommendRetentionDays(retentionDays);
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    this.events = this.events.filter((e) => e.createdAt >= cutoff);
    this.eventIds.clear();
    this.userEventsIndex.clear();
    for (const e of this.events) {
      this.eventIds.add(subjectEventKey(e.subjectKey, e.eventId));
      const list = this.userEventsIndex.get(e.subjectKey) || [];
      list.push(e);
      this.userEventsIndex.set(e.subjectKey, list);
    }
    this.entityFeedbackIds.clear();
    for (const [subject, list] of this.userEntityFeedbacks) {
      const retained = list.filter((f) => f.createdAt >= cutoff);
      if (retained.length) this.userEntityFeedbacks.set(subject, retained);
      else this.userEntityFeedbacks.delete(subject);
      for (const f of retained) this.entityFeedbackIds.add(subjectEventKey(subject, f.feedbackId));
    }
    for (const [key, v] of this.queryContributions) {
      if (v.createdAt < cutoff || !this.eventIds.has(key)) this.queryContributions.delete(key);
    }
    for (const [key, v] of this.cooccurrenceContributions) {
      if (v.createdAt < cutoff || !this.eventIds.has(key)) this.cooccurrenceContributions.delete(key);
    }
    for (const [key, v] of this.searchQueries) if (v.updatedAt < cutoff) this.searchQueries.delete(key);
    for (const [a, edges] of this.cooccurrence) {
      for (const [b, v] of edges) if (v.updatedAt < cutoff) edges.delete(b);
      if (!edges.size) this.cooccurrence.delete(a);
    }
    for (const [key, v] of this.userRadarProfiles) if (v.updatedAt < cutoff) this.userRadarProfiles.delete(key);
    this.lastRetentionAt = Date.now();
    this.writeCounter = 0;
  }


  // Multi-entity storage
  private entities = new Map<string, SonicEntity>();
  private entityRelations = new Map<string, EntityRelation>();
  private userEntityFeedbacks = new Map<string, UserEntityFeedback[]>();
  private entityFeedbackIds = new Set<string>();
  private userRadarProfiles = new Map<string, { payloadJson: string; updatedAt: number }>();

  upsertTrack(incoming: CanonicalTrack): void {
    if (!incoming?.canonicalTrackId) return;
    this.beforeWrite();

    const existing = this.tracks.get(incoming.canonicalTrackId);
    let finalTrack = incoming;
    if (existing && canMergeCanonicalTracks(existing, incoming)) {
      finalTrack = mergeCanonicalTracks(existing, incoming);
    } else if (existing && !canMergeCanonicalTracks(existing, incoming)) {
      // Duration anomaly (e.g. 30s ringtone): disambiguate ID so studio original is untouched
      finalTrack = {
        ...incoming,
        canonicalTrackId: `${incoming.canonicalTrackId}_${incoming.duration || 'alt'}`,
      };
    }

    if (!this.tracks.has(finalTrack.canonicalTrackId) && this.tracks.size >= MAX_TRACKS) {
      const oldestKey = this.tracks.keys().next().value;
      if (oldestKey) this.tracks.delete(oldestKey);
    }

    this.tracks.set(finalTrack.canonicalTrackId, finalTrack);
    upsertTrackMvEntities(this, finalTrack);
    const taKey = `${finalTrack.cleanTitle}:::${compactNormalize(finalTrack.canonicalArtist)}:::${finalTrack.edition}`;
    this.titleArtistIndex.set(taKey, finalTrack.canonicalTrackId);

    if (finalTrack.provider && finalTrack.providerTrackId) {
      this.platformIndex.set(`${finalTrack.provider}:${finalTrack.providerTrackId}`, finalTrack.canonicalTrackId);
      if (!this.platformIndex.has(finalTrack.providerTrackId)) {
        this.platformIndex.set(finalTrack.providerTrackId, finalTrack.canonicalTrackId);
      }
    }
    for (const [plat, pid] of Object.entries(finalTrack.sourceIds || {})) {
      if (plat && pid) {
        this.platformIndex.set(`${plat}:${pid}`, finalTrack.canonicalTrackId);
        if (!this.platformIndex.has(pid)) {
          this.platformIndex.set(pid, finalTrack.canonicalTrackId);
        }
      }
    }
  }

  upsertTracks(tracks: CanonicalTrack[]): void {
    for (const t of tracks) this.upsertTrack(t);
  }

  getTrack(idOrPlatformId: string): CanonicalTrack | null {
    if (!idOrPlatformId) return null;
    const direct = this.tracks.get(idOrPlatformId);
    if (direct) return direct;
    const mapped = this.platformIndex.get(idOrPlatformId);
    if (mapped) return this.tracks.get(mapped) || null;
    return null;
  }

  findTrackByTitleArtist(cleanTitle: string, canonicalArtist: string, edition: TrackEdition = 'studio'): CanonicalTrack | null {
    const key = `${cleanTitle}:::${compactNormalize(canonicalArtist)}:::${edition}`;
    const id = this.titleArtistIndex.get(key);
    return id ? this.tracks.get(id) || null : null;
  }

  listTracks(limit = 500): CanonicalTrack[] {
    const all = Array.from(this.tracks.values());
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all.slice(0, limit);
  }

  searchLocalTracks(query: string, limit = 30): CanonicalTrack[] {
    const trimmed = (query || '').trim();
    if (!trimmed) return [];
    const exp = expandQueryAliases(trimmed);
    const qCompact = exp.compact;
    const qPyFull = exp.pinyinFull;
    const qPyInit = exp.pinyinInitials;
    const qArtist = exp.matchedArtist ? compactNormalize(exp.matchedArtist) : '';

    const scored: Array<{ track: CanonicalTrack; score: number }> = [];
    for (const track of this.tracks.values()) {
      let s = 0;
      const tComp = track.cleanTitle;
      const tSimpComp = compactNormalize(track.simpTitle);
      const arComp = compactNormalize(track.canonicalArtist);
      const rawArComp = compactNormalize(track.primaryArtist);
      const alComp = track.cleanAlbum;

      if (tComp === qCompact || tSimpComp === qCompact) s += 100;
      else if (tComp.startsWith(qCompact) || tSimpComp.startsWith(qCompact)) s += 78;
      else if (qCompact.length >= 2 && (tComp.includes(qCompact) || tSimpComp.includes(qCompact))) s += 58;

      if (arComp === qCompact || rawArComp === qCompact || (qArtist && arComp === qArtist)) s += 85;
      else if (qCompact.length >= 2 && (arComp.includes(qCompact) || rawArComp.includes(qCompact))) s += 55;

      if (qCompact.length >= 2 && alComp && alComp.includes(qCompact)) s += 35;

      // Pinyin full & initials matching (e.g. "qingtian" or "qt" or "zjl")
      if (/^[a-z0-9]+$/i.test(qCompact) && qCompact.length >= 2) {
        const artistPy = toPinyinInfo(track.canonicalArtist);
        if (track.pinyinFull === qCompact || artistPy.full === qCompact) s += 82;
        else if (track.pinyinFull.startsWith(qCompact) || artistPy.full.startsWith(qCompact)) s += 62;
        else if (track.pinyinInitials === qCompact || artistPy.initials === qCompact) s += 74;
        else if (qCompact.length >= 3 && (track.pinyinInitials.startsWith(qCompact) || artistPy.initials.startsWith(qCompact))) {
          s += 50;
        } else if (qPyFull && track.pinyinFull === qPyFull && s === 0) {
          s += 55;
        }
      }

      // Genre / style match
      if (exp.inferredGenres.length > 0) {
        const gHits = exp.inferredGenres.filter((g) => track.genres.includes(g)).length;
        if (gHits > 0) s += gHits * 35;
      }

      // Combined query like "周杰伦 晴天" or "jay chou qingtian"
      if (s === 0 && trimmed.includes(' ')) {
        const parts = toSimplifiedChinese(trimmed).toLowerCase().split(/\s+/).filter(Boolean);
        let partMatches = 0;
        for (const p of parts) {
          const pComp = compactNormalize(p);
          if (!pComp) continue;
          if (
            tSimpComp.includes(pComp) ||
            arComp.includes(pComp) ||
            track.pinyinFull.includes(pComp) ||
            (qArtist && arComp === qArtist)
          ) {
            partMatches++;
          }
        }
        if (partMatches >= Math.min(2, parts.length)) {
          s += 72;
        }
      }

      // Fuzzy typo tolerance fallback
      if (s === 0 && qCompact.length >= 3) {
        const simTitle = computeFuzzySimilarity(qCompact, tComp);
        const simArtist = computeFuzzySimilarity(qCompact, arComp);
        const simPy = /^[a-z]+$/.test(qCompact) ? computeFuzzySimilarity(qCompact, track.pinyinFull) : 0;
        const bestSim = Math.max(simTitle, simArtist, simPy);
        if (bestSim >= 0.68) {
          s += bestSim * 52;
        }
      }

      if (s > 0) {
        scored.push({ track, score: s });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.track.externalPopularity - a.track.externalPopularity);
    return scored.slice(0, limit).map((x) => x.track);
  }

  recordEvent(event: StoredBehaviorEvent): { inserted: boolean; deduplicated: boolean } {
    if (!event?.eventId || !event?.subjectKey) {
      return { inserted: false, deduplicated: false };
    }
    this.beforeWrite();
    const key = subjectEventKey(event.subjectKey, event.eventId);
    if (this.eventIds.has(key) || this.entityFeedbackIds.has(key)) {
      return { inserted: false, deduplicated: true };
    }

    if (this.events.length >= MAX_EVENTS) {
      const evicted = this.events.shift();
      if (evicted) {
        const key = subjectEventKey(evicted.subjectKey, evicted.eventId);
        this.eventIds.delete(key);
        this.queryContributions.delete(key);
        this.cooccurrenceContributions.delete(key);
        const uList = this.userEventsIndex.get(evicted.subjectKey);
        const index = uList?.findIndex((e) => e.eventId === evicted.eventId) ?? -1;
        if (index >= 0) uList!.splice(index, 1);
        if (uList?.length === 0) this.userEventsIndex.delete(evicted.subjectKey);
      }
    }

    this.eventIds.add(key);
    this.events.push(event);
    let userList = this.userEventsIndex.get(event.subjectKey);
    if (!userList) {
      userList = [];
      this.userEventsIndex.set(event.subjectKey, userList);
    }
    userList.push(event);
    return { inserted: true, deduplicated: false };
  }

  getUserEvents(subjectKey: string, limit = 200, sinceMs = 0): StoredBehaviorEvent[] {
    if (!subjectKey) return [];
    const list = this.userEventsIndex.get(subjectKey) || [];
    return list.filter((e) => e.createdAt >= sinceMs)
      .sort((a, b) => compareEventOrder(b, a)).slice(0, Math.min(1000, Math.max(1, limit)));
  }

  clearUserEvents(subjectKey: string): number {
    if (!subjectKey) return 0;
    const list = this.userEventsIndex.get(subjectKey) || [];
    const removed = list.length;
    for (const ev of list) {
      const key = subjectEventKey(subjectKey, ev.eventId);
      this.eventIds.delete(key);
      this.queryContributions.delete(key);
      this.cooccurrenceContributions.delete(key);
    }
    this.userRadarProfiles.delete(subjectKey);
    this.userEventsIndex.delete(subjectKey);
    if (removed > 0) {
      this.events = this.events.filter((e) => e.subjectKey !== subjectKey);
    }
    const removedFeedbacks = this.clearUserEntityFeedbacks(subjectKey);
    return removed + removedFeedbacks;
  }

  getAllRecentEvents(sinceMs: number, limit = 10000): StoredBehaviorEvent[] {
    return this.events.filter((e) => e.createdAt >= sinceMs)
      .sort((a, b) => compareEventOrder(b, a)).slice(0, Math.min(25000, Math.max(1, limit)));
  }

  iteratePopularityEvents(trackIds: readonly string[], sinceMs: number, untilMs: number): Iterable<StoredBehaviorEvent> {
    const candidates = new Set(trackIds);
    const cutoff = Math.max(sinceMs, untilMs - this.retentionDays * DAY_MS);
    return this.events.filter((event) => event.canonicalTrackId !== undefined && candidates.has(event.canonicalTrackId) &&
      event.createdAt >= cutoff && event.createdAt <= untilMs && isPopularityEvent(event))
      .sort(comparePopularityEventOrder);
  }

  private contributionEvent(source: RecommendContributionSource): StoredBehaviorEvent | undefined {
    if (!source.subjectKey || !source.eventId) return undefined;
    return this.userEventsIndex.get(source.subjectKey)?.find((e) =>
      e.eventId === source.eventId && e.createdAt >= Date.now() - this.retentionDays * DAY_MS);
  }

  incrementCooccurrence(trackA: string, trackB: string, delta: number, source?: RecommendContributionSource): void {
    if (!trackA || !trackB || trackA === trackB || !Number.isFinite(delta) || delta <= 0) return;
    this.beforeWrite();
    if (source) {
      const event = this.contributionEvent(source);
      if (!event) return;
      const key = subjectEventKey(source.subjectKey, source.eventId);
      const contribution = this.cooccurrenceContributions.get(key) || { createdAt: event.createdAt, edges: new Map() };
      const [a, b] = [trackA, trackB].sort();
      const pair = JSON.stringify([a, b]);
      if (!contribution.edges.has(pair) && contribution.edges.size < 4) {
        contribution.edges.set(pair, { a, b, weight: Math.min(200, delta) });
        this.cooccurrenceContributions.set(key, contribution);
      }
      return;
    }
    const addEdge = (from: string, to: string) => {
      let neighbors = this.cooccurrence.get(from);
      if (!neighbors) {
        if (this.cooccurrence.size >= MAX_COOCCURRENCE_ANCHORS) {
          const oldest = this.cooccurrence.keys().next().value;
          if (oldest) this.cooccurrence.delete(oldest);
        }
        neighbors = new Map();
        this.cooccurrence.set(from, neighbors);
      }
      neighbors.set(to, { weight: Math.min(200, (neighbors.get(to)?.weight || 0) + delta), updatedAt: Date.now() });
    };
    addEdge(trackA, trackB);
    addEdge(trackB, trackA);
  }

  getCooccurringTracks(trackId: string, limit = 20): Array<{ canonicalTrackId: string; weight: number }> {
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    const weights = new Map<string, number>();
    for (const [id, edge] of this.cooccurrence.get(trackId) || []) {
      if (edge.updatedAt >= cutoff) weights.set(id, edge.weight);
    }
    for (const contribution of this.cooccurrenceContributions.values()) {
      if (contribution.createdAt < cutoff) continue;
      for (const edge of contribution.edges.values()) {
        const id = edge.a === trackId ? edge.b : edge.b === trackId ? edge.a : '';
        if (id) weights.set(id, Math.min(200, (weights.get(id) || 0) + edge.weight));
      }
    }
    return Array.from(weights, ([canonicalTrackId, weight]) => ({ canonicalTrackId, weight }))
      .sort((a, b) => b.weight - a.weight).slice(0, limit);
  }

  recordSearchQuery(normQuery: string, displayQuery: string, clicked = false, source?: RecommendContributionSource): void {
    const key = normQuery.trim();
    if (!key || key.length > 64) return;
    this.beforeWrite();
    const inc = clicked ? 3 : 1;
    if (source) {
      const event = this.contributionEvent(source);
      if (!event) return;
      const eventKey = subjectEventKey(source.subjectKey, source.eventId);
      if (!this.queryContributions.has(eventKey)) {
        this.queryContributions.set(eventKey, { norm: key, display: displayQuery.trim(), count: inc, createdAt: event.createdAt });
      }
      return;
    }
    const existing = this.searchQueries.get(key);
    if (existing) {
      existing.count += inc;
      existing.updatedAt = Date.now();
    } else {
      if (this.searchQueries.size >= MAX_QUERIES) {
        const firstKey = this.searchQueries.keys().next().value;
        if (firstKey) this.searchQueries.delete(firstKey);
      }
      this.searchQueries.set(key, { display: displayQuery.trim(), count: inc, updatedAt: Date.now() });
    }
  }

  getTopSearchQueries(prefix: string, limit = 8): Array<{ query: string; count: number }> {
    const pNorm = compactNormalize(prefix);
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    const totals = new Map<string, { display: string; count: number; updatedAt: number }>();
    const add = (key: string, display: string, count: number, updatedAt: number) => {
      if (updatedAt < cutoff) return;
      const existing = totals.get(key);
      totals.set(key, {
        display: !existing || updatedAt >= existing.updatedAt ? display : existing.display,
        count: (existing?.count || 0) + count, updatedAt: Math.max(existing?.updatedAt || 0, updatedAt),
      });
    };
    for (const [key, value] of this.searchQueries) add(key, value.display, value.count, value.updatedAt);
    for (const value of this.queryContributions.values()) add(value.norm, value.display, value.count, value.createdAt);
    return Array.from(totals).filter(([key, v]) =>
      !pNorm || key.startsWith(pNorm) || toSimplifiedChinese(v.display).toLowerCase().includes(pNorm))
      .sort(([, a], [, b]) => b.count - a.count || b.updatedAt - a.updatedAt)
      .slice(0, limit).map(([, { display, count }]) => ({ query: display, count }));
  }

  getStats(): { trackCount: number; entityCount: number; eventCount: number; cooccurrencePairs: number; storageKind: string } {
    const pairs = new Set<string>();
    const cutoff = Date.now() - this.retentionDays * DAY_MS;
    for (const [a, edges] of this.cooccurrence) {
      for (const [b, v] of edges) if (v.updatedAt >= cutoff) pairs.add(JSON.stringify([a, b].sort()));
    }
    for (const contribution of this.cooccurrenceContributions.values()) {
      if (contribution.createdAt >= cutoff) for (const pair of contribution.edges.keys()) pairs.add(pair);
    }
    return {
      trackCount: this.tracks.size,
      entityCount: this.entities.size,
      eventCount: this.eventIds.size + this.entityFeedbackIds.size,
      cooccurrencePairs: pairs.size,
      storageKind: this.kind,
    };
  }

  // Multi-entity operations
  upsertEntity(entity: SonicEntity): void {
    if (!entity?.id || !entity?.type) return;
    this.beforeWrite();
    if (!this.entities.has(entity.id) && this.entities.size >= this.maxEntities) {
      const oldestKey = this.entities.keys().next().value;
      if (oldestKey) this.entities.delete(oldestKey);
    }
    this.entities.set(entity.id, entity);
  }

  upsertEntities(entities: SonicEntity[]): void {
    for (const e of entities) this.upsertEntity(e);
  }

  getEntity(id: string): SonicEntity | null {
    if (!id) return null;
    return this.entities.get(id) || null;
  }

  listEntities(type?: SonicEntityType, limit = 500): SonicEntity[] {
    const all = Array.from(this.entities.values());
    const filtered = type ? all.filter((e) => e.type === type) : all;
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    return filtered.slice(0, Math.max(1, limit));
  }

  upsertEntityRelation(rel: EntityRelation): void {
    if (!rel?.parentId || !rel?.childId) return;
    this.beforeWrite();
    const relationId = rel.relationId || `${rel.parentId}:::${rel.childId}:::${rel.relationType}`;
    if (!this.entityRelations.has(relationId) && this.entityRelations.size >= this.maxEntityRelations) {
      const oldestKey = this.entityRelations.keys().next().value;
      if (oldestKey) this.entityRelations.delete(oldestKey);
    }
    this.entityRelations.set(relationId, { ...rel, relationId });
  }

  upsertEntityRelations(rels: EntityRelation[]): void {
    for (const r of rels) this.upsertEntityRelation(r);
  }

  getEntityRelations(entityId: string, direction: 'children' | 'parents' = 'children'): EntityRelation[] {
    if (!entityId) return [];
    const out: EntityRelation[] = [];
    for (const rel of this.entityRelations.values()) {
      if (direction === 'children' && rel.parentId === entityId) {
        out.push(rel);
      } else if (direction === 'parents' && rel.childId === entityId) {
        out.push(rel);
      }
    }
    if (direction === 'children') {
      out.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (b.weight ?? 1) - (a.weight ?? 1));
    } else {
      out.sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
    }
    return out;
  }

  recordEntityFeedback(feedback: UserEntityFeedback): { inserted: boolean; deduplicated: boolean } {
    if (!feedback?.feedbackId || !feedback?.subjectKey || !feedback?.entityId) {
      return { inserted: false, deduplicated: false };
    }
    this.beforeWrite();
    const key = subjectEventKey(feedback.subjectKey, feedback.feedbackId);
    if (this.entityFeedbackIds.has(key) || this.eventIds.has(key)) {
      return { inserted: false, deduplicated: true };
    }
    if (this.entityFeedbackIds.size >= MAX_EVENTS) {
      const oldestSubject = this.userEntityFeedbacks.keys().next().value;
      const oldestList = oldestSubject ? this.userEntityFeedbacks.get(oldestSubject) : undefined;
      const evicted = oldestList?.shift();
      if (evicted) this.entityFeedbackIds.delete(subjectEventKey(evicted.subjectKey, evicted.feedbackId));
      if (oldestList?.length === 0) this.userEntityFeedbacks.delete(oldestSubject!);
    }
    this.entityFeedbackIds.add(key);
    let list = this.userEntityFeedbacks.get(feedback.subjectKey);
    if (!list) {
      list = [];
      this.userEntityFeedbacks.set(feedback.subjectKey, list);
    }
    list.push(feedback);
    return { inserted: true, deduplicated: false };
  }

  getUserEntityFeedbacks(subjectKey: string, limit = 200, sinceMs = 0): UserEntityFeedback[] {
    if (!subjectKey) return [];
    const list = this.userEntityFeedbacks.get(subjectKey) || [];
    return list.filter((e) => e.createdAt >= sinceMs)
      .sort((a, b) => compareEventOrder(b, a)).slice(0, Math.min(1000, Math.max(1, limit)));
  }

  clearUserEntityFeedbacks(subjectKey: string): number {
    if (!subjectKey) return 0;
    const list = this.userEntityFeedbacks.get(subjectKey) || [];
    const count = list.length;
    for (const f of list) {
      this.entityFeedbackIds.delete(subjectEventKey(subjectKey, f.feedbackId));
    }
    this.userEntityFeedbacks.delete(subjectKey);
    return count;
  }

  saveUserRadarProfile(subjectKey: string, payloadJson: string): void {
    if (!subjectKey || !payloadJson) return;
    this.beforeWrite();
    this.userRadarProfiles.set(subjectKey, { payloadJson, updatedAt: Date.now() });
    if (this.userRadarProfiles.size > 2000) {
      const oldest = this.userRadarProfiles.keys().next().value;
      if (oldest) this.userRadarProfiles.delete(oldest);
    }
  }

  getUserRadarProfile(subjectKey: string): { payloadJson: string; updatedAt: number } | null {
    if (!subjectKey) return null;
    return this.userRadarProfiles.get(subjectKey) || null;
  }

  clearAll(): void {
    this.tracks.clear();
    this.platformIndex.clear();
    this.titleArtistIndex.clear();
    this.eventIds.clear();
    this.events = [];
    this.userEventsIndex.clear();
    this.cooccurrence.clear();
    this.searchQueries.clear();
    this.queryContributions.clear();
    this.cooccurrenceContributions.clear();
    this.writeCounter = 0;
    this.lastRetentionAt = Date.now();
    this.entities.clear();
    this.entityRelations.clear();
    this.userEntityFeedbacks.clear();
    this.entityFeedbackIds.clear();
    this.userRadarProfiles.clear();
  }
}

let singletonMemoryStore: MemoryRecommendStore | null = null;

export function getMemoryRecommendStore(): MemoryRecommendStore {
  if (!singletonMemoryStore) {
    singletonMemoryStore = new MemoryRecommendStore();
  }
  return singletonMemoryStore;
}

export function getRecommendStore(env?: AppEnv): RecommendStore {
  if (env?.RECOMMEND_STORE && typeof env.RECOMMEND_STORE.upsertTrack === 'function') {
    return env.RECOMMEND_STORE as RecommendStore;
  }
  const store = getMemoryRecommendStore();
  if (env?.SONIC_RECOMMEND_RETENTION_DAYS !== undefined) store.setRetentionDays(env.SONIC_RECOMMEND_RETENTION_DAYS);
  return store;
}

export function resetMemoryRecommendStoreForTest(): void {
  if (singletonMemoryStore) {
    singletonMemoryStore.clearAll();
  }
}

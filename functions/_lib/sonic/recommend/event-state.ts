// One ordering/fold for legacy tracks, mixed entities and popularity. Undo wins
// equal timestamps; eventId is the deterministic final tie-breaker (not arrival order).
import type { CanonicalTrack, RecommendStore, SonicEntity, SonicEntityType, SonicEventType, StoredBehaviorEvent } from './types';
import { resolveEventEntity } from './entity-store';

export function subjectEventKey(subject: string, id: string): string {
  return JSON.stringify([subject, id]);
}

const STATE_ACTIONS = new Set(['favorite', 'unfavorite', 'dislike', 'undislike']);
const ACTION_ORDER: Record<string, number> = { favorite: 1, dislike: 2, unfavorite: 3, undislike: 4 };

export const POPULARITY_EVENT_TYPES = [
  'play_start', 'play_progress', 'play_complete', 'replay',
  'favorite', 'unfavorite', 'dislike', 'undislike',
] as const satisfies readonly SonicEventType[];

export function isPopularityEvent(event: StoredBehaviorEvent): boolean {
  // Anonymous device IDs are client-selected and can still personalize an
  // individual's feed, but do not count as accounts on the global chart.
  return event.subjectKey.startsWith('usr_') && (POPULARITY_EVENT_TYPES as readonly SonicEventType[]).includes(event.type);
}

export function comparePopularityEventOrder(a: StoredBehaviorEvent, b: StoredBehaviorEvent): number {
  const trackA = a.canonicalTrackId || '';
  const trackB = b.canonicalTrackId || '';
  if (trackA !== trackB) return trackA < trackB ? -1 : 1;
  if (a.subjectKey !== b.subjectKey) return a.subjectKey < b.subjectKey ? -1 : 1;
  return compareEventOrder(a, b);
}

export function compareEventOrder(
  a: { createdAt: number; type?: string; action?: string; eventId?: string; feedbackId?: string },
  b: { createdAt: number; type?: string; action?: string; eventId?: string; feedbackId?: string },
): number {
  const time = a.createdAt - b.createdAt;
  if (time) return time;
  const action = (ACTION_ORDER[a.action || a.type] || 0) - (ACTION_ORDER[b.action || b.type] || 0);
  if (action) return action;
  const left = a.eventId || a.feedbackId || '';
  const right = b.eventId || b.feedbackId || '';
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PreferenceSignal extends StoredBehaviorEvent {
  entityType: SonicEntityType;
  entityId?: string;
}

export function foldPreferenceSignals(signals: PreferenceSignal[]): PreferenceSignal[] {
  const ordered = [...signals].sort(compareEventOrder);
  const states = new Map<string, { favorite?: PreferenceSignal; dislike?: PreferenceSignal }>();
  const effective: PreferenceSignal[] = [];
  const seen = new Set<string>();
  for (const signal of ordered) {
    const eventKey = subjectEventKey(signal.subjectKey, signal.eventId);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    if (!STATE_ACTIONS.has(signal.type) || !signal.entityId) {
      effective.push(signal);
      continue;
    }
    const key = JSON.stringify([signal.subjectKey, signal.entityType, signal.entityId]);
    const state = states.get(key) || {};
    if (signal.type === 'favorite') {
      state.favorite = signal;
      state.dislike = undefined;
    } else if (signal.type === 'dislike') {
      state.dislike = signal;
      state.favorite = undefined;
    } else if (signal.type === 'unfavorite') {
      state.favorite = undefined;
    } else if (signal.type === 'undislike') {
      state.dislike = undefined;
    }
    states.set(key, state);
  }
  for (const state of states.values()) {
    if (state.favorite) effective.push(state.favorite);
    if (state.dislike) effective.push(state.dislike);
  }
  return effective.sort(compareEventOrder);
}

export function collectUserPreferenceSignals(store: RecommendStore, subjectKey: string, sinceMs: number): {
  signals: PreferenceSignal[]; totalEvents: number;
} {
  // Request-local only: repeated plays/progress rows must not repeat SQLite
  // lookups or whole-catalog scans. Cache misses too, but never retain them across
  // calls: a later trusted catalog import or user-data clear must be visible.
  const tracks = new Map<string, CanonicalTrack | null>();
  const getTrack = (id: string): CanonicalTrack | null => {
    if (!tracks.has(id)) {
      const track = store.getTrack(id);
      tracks.set(id, track);
      if (track) tracks.set(track.canonicalTrackId, track);
    }
    return tracks.get(id)!;
  };
  const entities = new Map<string, { entityId: string; entity: SonicEntity | null }>();
  const events = store.getUserEvents(subjectKey, 1000, sinceMs).map((event) => {
    if (!event.trackRef || event.canonicalTrackId) return event;
    const track = getTrack(event.trackRef);
    return track ? {
      ...event, canonicalTrackId: track.canonicalTrackId, artistKey: track.canonicalArtist,
      genres: track.genres, language: track.language,
    } : event;
  });
  const signals: PreferenceSignal[] = events.map((e) => ({
    ...e, entityType: 'track', entityId: e.canonicalTrackId || e.trackRef,
  }));
  const eventIds = new Set(events.map((e) => e.eventId));
  for (const fb of store.getUserEntityFeedbacks?.(subjectKey, 1000, sinceMs) || []) {
    // Earlier versions wrote both rows for a single explicit track event.
    if (eventIds.has(fb.feedbackId)) continue;
    const track = fb.entityType === 'track' ? getTrack(fb.entityId) : null;
    const key = `${fb.entityType}:${fb.entityId}`;
    if (!entities.has(key)) {
      entities.set(key, fb.entityType === 'track'
        ? { entityId: track?.canonicalTrackId || fb.entityId, entity: null }
        : resolveEventEntity(store, { entityType: fb.entityType, entityId: fb.entityId }));
    }
    const resolved = entities.get(key)!;
    signals.push({
      eventId: fb.feedbackId, subjectKey: fb.subjectKey, type: fb.action as SonicEventType,
      entityType: fb.entityType, entityId: resolved.entityId,
      canonicalTrackId: track?.canonicalTrackId, artistKey: track?.canonicalArtist || resolved.entity?.artistName,
      genres: track?.genres || resolved.entity?.tags, language: track?.language || resolved.entity?.language,
      weight: fb.weight, progressRatio: fb.progress, createdAt: fb.createdAt,
    });
  }
  return { signals: foldPreferenceSignals(signals), totalEvents: signals.length };
}

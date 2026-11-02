// Entity identity and reference resolution. Catalog writes are SERVER-ONLY: behavior
// payloads may reference catalog IDs, but never supply global metadata or relations.
// Adapted from the multi-entity draft to SonicEntity / parent-child EntityRelation.
import type { AppEnv } from '../../types';
import type {
  CanonicalTrack, RecommendStore, SonicBehaviorEventInput, SonicEntity,
  SonicEntityType, SonicEventType, StoredBehaviorEvent,
} from './types';
import { compactNormalize } from './text-norm';
import { deterministicHash16 } from './track-canonical';

const ENTITY_TYPES = new Set(['track', 'album', 'playlist', 'mv']);
const EVENT_TYPES = new Set([
  'search', 'search_click', 'play_start', 'play_progress', 'play_complete',
  'skip', 'replay', 'favorite', 'unfavorite', 'dislike', 'undislike', 'open',
  'add_to_playlist', 'watch_progress', 'watch_complete',
]);
const PROVIDERS = new Set(['netease', 'qq', 'kugou', 'kuwo', 'gdstudio', 'apple', 'ytmusic', 'spotify', 'synthetic']);

export function normalizeCatalogProvider(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim().toLowerCase();
  const provider = raw === 'ne' || raw === 'ncm' ? 'netease' : raw;
  return PROVIDERS.has(provider) ? provider : undefined;
}

function referenceId(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) return undefined;
  const id = String(value).trim();
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(id) ? id : undefined;
}

export function normalizeBehaviorEventInput(input: unknown): {
  event?: SonicBehaviorEventInput;
  error?: 'INVALID_EVENT_TYPE' | 'INVALID_ENTITY_TYPE' | 'INVALID_EVENT';
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'INVALID_EVENT' };
  const ev = input as SonicBehaviorEventInput;
  const action = ev.action ?? ev.type;
  if (!EVENT_TYPES.has(action) || (ev.type !== undefined && !EVENT_TYPES.has(ev.type)) ||
      (ev.action !== undefined && ev.type !== undefined && ev.action !== ev.type)) {
    return { error: 'INVALID_EVENT_TYPE' };
  }
  if ((ev.entity_type !== undefined && !ENTITY_TYPES.has(ev.entity_type)) ||
      (ev.entityType !== undefined && !ENTITY_TYPES.has(ev.entityType)) ||
      (ev.entity_type !== undefined && ev.entityType !== undefined && ev.entity_type !== ev.entityType)) {
    return { error: 'INVALID_ENTITY_TYPE' };
  }
  const entityType = ev.entity_type ?? ev.entityType;
  const entityId = referenceId(ev.entity_id ?? ev.entityId);
  if ((ev.entity_id !== undefined && ev.entityId !== undefined && String(ev.entity_id) !== String(ev.entityId)) ||
      ((ev.entity_id !== undefined || ev.entityId !== undefined) && (!entityType || !entityId)) ||
      (entityType && entityType !== 'track' && !entityId) ||
      (ev.track !== undefined && (!ev.track || typeof ev.track !== 'object' || Array.isArray(ev.track))) ||
      (ev.query !== undefined && typeof ev.query !== 'string') ||
      (ev.context !== undefined && (!ev.context || typeof ev.context !== 'object' || Array.isArray(ev.context)))) {
    return { error: 'INVALID_EVENT' };
  }
  const source = ev.entity_source ?? ev.entitySource;
  if ((source !== undefined && !normalizeCatalogProvider(source)) ||
      (ev.entity_source !== undefined && ev.entitySource !== undefined &&
        normalizeCatalogProvider(ev.entity_source) !== normalizeCatalogProvider(ev.entitySource))) {
    return { error: 'INVALID_EVENT' };
  }
  for (const key of ['timestamp', 'progress', 'progressRatio', 'playedSeconds', 'durationSeconds'] as const) {
    if (ev[key] !== undefined && (typeof ev[key] !== 'number' || !Number.isFinite(ev[key]) || ev[key] < 0)) {
      return { error: 'INVALID_EVENT' };
    }
  }
  if ((ev.progress ?? 0) > 1 || (ev.progressRatio ?? 0) > 1) return { error: 'INVALID_EVENT' };
  return { event: { ...ev, type: action as SonicEventType, entityType, entityId, entitySource: normalizeCatalogProvider(source) } };
}

/** Keep the existing production album identity, not the draft's incompatible hash. */
export function computeAlbumEntityId(cleanAlbum: string, canonicalArtist: string): string {
  return `alb_${deterministicHash16(`alb:${compactNormalize(cleanAlbum)}:::${compactNormalize(canonicalArtist)}`)}`;
}

export function computeEntityId(type: SonicEntityType, naturalKey: string): string {
  const prefix = type === 'album' ? 'alb' : type === 'playlist' ? 'pl' : type === 'track' ? 'trk' : 'mv';
  return `${prefix}_${deterministicHash16(`${prefix}:${naturalKey}`)}`;
}

export function computeMvEntityId(provider: string, externalId: string): string {
  return computeEntityId('mv', `${provider}:${externalId}`);
}

/** Unknown references stay private until a SERVER search/catalog upsert verifies them. */
export function resolveEventTrack(store: RecommendStore, ev: SonicBehaviorEventInput): {
  track: CanonicalTrack | null; trackRef?: string;
} {
  if (ev.entityType && ev.entityType !== 'track') return { track: null };
  const raw = ev.track;
  const canonicalId = referenceId(raw?.canonicalTrackId);
  const entityId = referenceId(ev.entityId ?? ev.entity_id);
  const rawId = referenceId(raw?.platformId ?? raw?.id ?? entityId);
  const provider = normalizeCatalogProvider(raw?.platform || raw?.source || ev.entitySource);
  let trackRef = rawId;
  if (rawId && !rawId.startsWith('trk_')) {
    const prefixed = /^(netease|ne|ncm|qq|kugou|kuwo|gdstudio|apple|ytmusic|spotify|synthetic)[:_](.+)$/.exec(rawId);
    trackRef = prefixed ? `${normalizeCatalogProvider(prefixed[1])}:${prefixed[2]}`
      : provider ? `${provider}:${rawId}` : /^\d+$/.test(rawId) ? `netease:${rawId}` : rawId;
  }
  const fromSource = trackRef ? store.getTrack(trackRef) : null;
  if (fromSource) return { track: fromSource };
  // A canonical reference can only select an existing record. Never upsert or trust
  // its attached title, genres, sources, popularity, or claimed MV ID.
  const fromCanonical = canonicalId ? store.getTrack(canonicalId) : entityId ? store.getTrack(entityId) : null;
  if (fromCanonical && (!trackRef || trackRef === fromCanonical.canonicalTrackId || !provider)) {
    return { track: fromCanonical };
  }
  return { track: null, trackRef: trackRef || canonicalId };
}

export function hydrateBehaviorEvent(store: RecommendStore, event: StoredBehaviorEvent): StoredBehaviorEvent {
  if (!event.trackRef || event.canonicalTrackId) return event;
  const track = store.getTrack(event.trackRef);
  return track ? {
    ...event, canonicalTrackId: track.canonicalTrackId, artistKey: track.canonicalArtist,
    genres: track.genres, language: track.language,
  } : event;
}

/** No event can create an entity or attach an arbitrary track to an existing MV. */
export function resolveEventEntity(
  store: RecommendStore,
  ev: SonicBehaviorEventInput,
): { entity: SonicEntity | null; entityId: string; resolvedFrom: 'exact-id' | 'provider-id' | 'unresolved' } {
  const type = ev.entityType ?? ev.entity_type;
  const rawId = referenceId(ev.entityId ?? ev.entity_id) || '';
  const exact = rawId ? store.getEntity?.(rawId) : null;
  if (exact?.type === type && isTrustedCatalogEntity(exact)) {
    return { entity: exact, entityId: exact.id, resolvedFrom: 'exact-id' };
  }
  const qualified = /^([a-z]+):(.+)$/.exec(rawId);
  const source = normalizeCatalogProvider(qualified?.[1] || ev.entitySource || ev.entity_source || ev.track?.platform || ev.track?.source)
    || (/^\d+$/.test(rawId) ? 'netease' : undefined);
  const externalId = qualified?.[2] || rawId;
  if (source && externalId && store.listEntities) {
    const deterministic = type === 'mv' ? store.getEntity?.(computeMvEntityId(source, externalId)) : null;
    const match = deterministic?.type === type ? deterministic : store.listEntities(type, 2000)
      .find((e) => e.source === source && e.sourceId === externalId && isTrustedCatalogEntity(e));
    if (match && isTrustedCatalogEntity(match)) return { entity: match, entityId: match.id, resolvedFrom: 'provider-id' };
  }
  return { entity: null, entityId: source ? `${source}:${externalId}` : rawId, resolvedFrom: 'unresolved' };
}

export function isTrustedCatalogEntity(entity: SonicEntity): boolean {
  // Legacy bootstrap fabricated sonic/track-backed "Official MV" records. Keep
  // the rows for rollback, but do not present them as verified playable videos.
  return entity.type !== 'mv' || Boolean(normalizeCatalogProvider(entity.source) && referenceId(entity.sourceId));
}

/** Called only with a provider-verified track from the server catalog. */
export function upsertTrackMvEntities(store: RecommendStore, track: CanonicalTrack): number {
  if (!store.upsertEntity || !store.upsertEntityRelation) return 0;
  let count = 0;
  for (const [source, externalId] of Object.entries(track.mvSourceIds || {})) {
    if (!normalizeCatalogProvider(source) || !referenceId(externalId) || externalId === '0') continue;
    const id = computeMvEntityId(source, externalId);
    if (!store.getEntity?.(id)) {
      store.upsertEntity({
        id, type: 'mv', title: `${track.title} MV`, subtitle: `${track.canonicalArtist} · MV`,
        artistName: track.canonicalArtist, coverUrl: track.coverUrl, source, sourceId: externalId,
        tags: [...track.genres, 'mv'], language: track.language,
        externalPopularity: track.externalPopularity, createdAt: track.firstSeenAt, updatedAt: track.updatedAt,
        payload: { mvId: externalId, provider: source, relatedTrackId: track.canonicalTrackId, artist: track.canonicalArtist },
      });
      count++;
    }
    store.upsertEntityRelation({
      parentId: id, parentType: 'mv', childId: track.canonicalTrackId, childType: 'track',
      relationType: 'video_of', weight: 1, createdAt: track.updatedAt,
    });
  }
  return count;
}

function providerCatalogId(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)) return undefined;
  const id = String(value).trim();
  if (!id || id === '0' || /^(?:trk|alb|pl|mv)_/.test(id)) return undefined;
  return (source === 'netease' ? /^[1-9]\d{0,19}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).test(id) ? id : undefined;
}

function catalogText(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function catalogCover(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return '';
  const text = catalogText(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    // Stored URLs are not fetched here. Still reject local/IP-literal destinations
    // rather than publishing a provider-supplied link to a browser's local network.
    if (!url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)) return undefined;
    url.protocol = 'https:';
    return url.toString();
  } catch { return undefined; }
}

/**
 * SERVER-ONLY catalog boundary. Call with an array from a successful provider
 * list/detail response (wrap detail in [data]), never request/event JSON. Shape
 * validation is not provider authentication; the route must establish provenance.
 * No network access. Returns the number of valid unique records upserted, max 100.
 * NetEase `duration` is ms; other providers use seconds. Explicit durationMs or
 * durationSeconds overrides that convention. Missing optional cover/duration is OK.
 * Relations require a provider songId/songid/trackId/providerTrackId that already
 * resolves in the trusted track catalog; titles, MV IDs and claimed canonical IDs
 * are never used to invent audio records or video_of edges.
 */
export function ingestVerifiedMvCatalog(items: unknown, store: RecommendStore, source = 'netease'): number {
  const provider = normalizeCatalogProvider(source);
  if (!provider || !Array.isArray(items) || !store.upsertEntity) return 0;
  const now = Date.now();
  const seen = new Set<string>();
  let upserted = 0;
  for (const raw of items.slice(0, 100)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if ([raw.source, raw.provider, raw.platform].some((s) => s !== undefined && normalizeCatalogProvider(s) !== provider)) continue;
    const sourceId = providerCatalogId(raw.id ?? raw.mvId ?? raw.mvid ?? raw.vid, provider);
    const title = catalogText(raw.title ?? raw.name);
    const artists = Array.isArray(raw.artists) ? raw.artists.slice(0, 10).map((a: unknown) =>
      catalogText(typeof a === 'string' ? a : a && typeof a === 'object' ? (a as { name?: unknown }).name : undefined, 128)) : [];
    const artistName = catalogText(raw.artistName ?? raw.artist ?? (artists.length && artists.every(Boolean) ? artists.join(' / ') : undefined));
    const coverUrl = catalogCover(raw.coverUrl ?? raw.cover ?? raw.coverImg ?? raw.picUrl);
    const rawDuration = raw.durationSeconds ?? raw.durationMs ?? raw.duration;
    let duration: number | undefined;
    if (rawDuration !== undefined && rawDuration !== null) {
      if (typeof rawDuration !== 'number' && !(typeof rawDuration === 'string' && /^\d{1,12}(?:\.\d{1,3})?$/.test(rawDuration))) continue;
      const milliseconds = raw.durationSeconds === undefined && (raw.durationMs !== undefined || provider === 'netease');
      const seconds = Number(rawDuration) / (milliseconds ? 1000 : 1);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) continue;
      duration = Math.round(seconds);
    }
    if (!sourceId || !title || !artistName || coverUrl === undefined || seen.has(sourceId)) continue;
    seen.add(sourceId);
    const id = computeMvEntityId(provider, sourceId);
    const existing = store.getEntity?.(id);
    // Never overwrite a conflicting entity if an existing store was externally edited.
    if (existing && (existing.type !== 'mv' || existing.source !== provider || existing.sourceId !== sourceId)) continue;
    const songId = providerCatalogId(raw.songId ?? raw.songid ?? raw.trackId ?? raw.providerTrackId, provider);
    const track = songId ? store.getTrack(`${provider}:${songId}`) : null;
    const artistId = providerCatalogId(raw.artistId ?? raw.artists?.[0]?.id, provider);
    store.upsertEntity({
      id, type: 'mv', title, subtitle: `${artistName} · MV`, artistId, artistName,
      coverUrl: coverUrl || existing?.coverUrl || '', source: provider, sourceId,
      tags: existing?.tags || [...(track?.genres || []), 'mv'], language: track?.language || existing?.language,
      duration: duration ?? existing?.duration ?? 0,
      externalPopularity: existing?.externalPopularity ?? track?.externalPopularity ?? 0,
      createdAt: existing?.createdAt ?? now, updatedAt: now,
      payload: {
        mvId: sourceId, provider, artist: artistName,
        ...(track ? { relatedTrackId: track.canonicalTrackId } :
          existing?.payload?.relatedTrackId ? { relatedTrackId: existing.payload.relatedTrackId } : {}),
      },
    });
    if (track && store.upsertEntityRelation) {
      store.upsertEntityRelation({
        parentId: id, parentType: 'mv', childId: track.canonicalTrackId, childType: 'track',
        relationType: 'video_of', weight: 1, createdAt: now,
      });
    }
    upserted++;
  }
  return upserted;
}

/** Draft entry point retained; use the production bootstrap and its existing IDs. */
export async function ensureMultiEntityCatalog(store: RecommendStore, env?: AppEnv): Promise<void> {
  const { ensureMultiEntityCatalogSeeded } = await import('./multi-entity');
  ensureMultiEntityCatalogSeeded(store, env);
}

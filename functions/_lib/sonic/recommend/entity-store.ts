// Sonic Multi-Entity Recommendation — Entity Identity, Event-Entity Resolution & Catalog Bootstrap
// Derives album / playlist / mv entities from the existing track catalog (no upstream entity API),
// resolves incoming behavior events onto deterministic entity ids, and maintains the
// bidirectional soft propagation graph (album/playlist/mv <-> track).

import type { AppEnv } from '../../types';
import type {
  CanonicalTrack,
  EntityRecord,
  EntityRelation,
  RecommendStore,
  SonicBehaviorEventInput,
  SonicEntityType,
} from './types';
import { compactNormalize } from './text-norm';
import { deterministicHash16 } from './track-canonical';

// ── Configurable bidirectional soft propagation coefficients ──
export interface MultiEntityPropagationConfig {
  albumToTrack: number; // favorite(album) -> each contained track
  playlistToTrack: number;
  mvToTrack: number;
  trackToEntity: number; // played/liked track -> albums / playlists / mvs containing it
}

export function getMultiEntityPropagationConfig(env?: AppEnv): MultiEntityPropagationConfig {
  const num = (raw: unknown, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };
  return {
    albumToTrack: num(env?.SONIC_ENTITY_PROP_ALBUM_TO_TRACK, 0.6),
    playlistToTrack: num(env?.SONIC_ENTITY_PROP_PLAYLIST_TO_TRACK, 0.45),
    mvToTrack: num(env?.SONIC_ENTITY_PROP_MV_TO_TRACK, 0.7),
    trackToEntity: num(env?.SONIC_ENTITY_PROP_TRACK_TO_ENTITY, 0.5),
  };
}

export function computeEntityId(entityType: SonicEntityType, naturalKey: string): string {
  const prefix =
    entityType === 'album' ? 'alb' : entityType === 'playlist' ? 'pl' : entityType === 'mv' ? 'mv' : 'trk';
  return `${prefix}_${deterministicHash16(`${entityType}:${naturalKey}`)}`;
}

/** Deterministic catalog entity id for an album (must match ensureMultiEntityCatalog seeding). */
export function computeAlbumEntityId(cleanAlbum: string, canonicalArtist: string): string {
  return computeEntityId('album', `${compactNormalize(cleanAlbum)}:::${compactNormalize(canonicalArtist)}`);
}

/** Deterministic catalog entity id for the auto-derived MV of a canonical track. */
export function computeMvEntityId(canonicalTrackId: string): string {
  return computeEntityId('mv', canonicalTrackId);
}

/** Deterministic catalog entity id for a genre-derived playlist. */
export function computePlaylistEntityId(genre: string): string {
  return computeEntityId('playlist', `genre:${compactNormalize(genre)}`);
}

const PLAYLIST_GENRE_LABELS: Record<string, string> = {
  mandopop: '华语流行精选',
  cantopop: '粤语金曲馆',
  rock: '摇滚能量站',
  'pop-rock': '流行摇滚精选',
  pop: '流行热歌榜',
  'r&b': '节奏布鲁斯典藏',
  ballad: '深夜抒情慢歌',
  folk: '民谣地图',
  'indie-rock': '独立摇滚现场',
  'indie-pop': '独立流行精选',
  electronic: '电子脉冲',
  'synth-pop': '合成器浪潮',
  'j-pop': '日音大赏',
  'k-pop': 'K-POP 热浪',
  instrumental: '纯音乐空间',
  soul: '灵魂乐放送',
  'hip-hop': '嘻哈潮流',
  ost: '影视原声精选',
};

function ensureEntityTrackRelations(
  store: RecommendStore,
  entity: EntityRecord,
  canonicalTrack: CanonicalTrack | null,
  nowMs: number,
): void {
  if (!canonicalTrack || entity.entityType === 'track') return;
  const relations: EntityRelation[] = [];
  if (entity.entityType === 'album') {
    relations.push({
      fromType: 'album',
      fromId: entity.entityId,
      toType: 'track',
      toId: canonicalTrack.canonicalTrackId,
      relation: 'contains',
      weight: 1.0,
      updatedAt: nowMs,
    });
    relations.push({
      fromType: 'track',
      fromId: canonicalTrack.canonicalTrackId,
      toType: 'album',
      toId: entity.entityId,
      relation: 'belongs_to',
      weight: 1.0,
      updatedAt: nowMs,
    });
  } else if (entity.entityType === 'mv') {
    relations.push({
      fromType: 'mv',
      fromId: entity.entityId,
      toType: 'track',
      toId: canonicalTrack.canonicalTrackId,
      relation: 'derives_from',
      weight: 0.9,
      updatedAt: nowMs,
    });
    relations.push({
      fromType: 'track',
      fromId: canonicalTrack.canonicalTrackId,
      toType: 'mv',
      toId: entity.entityId,
      relation: 'references',
      weight: 0.9,
      updatedAt: nowMs,
    });
  } else if (entity.entityType === 'playlist') {
    relations.push({
      fromType: 'playlist',
      fromId: entity.entityId,
      toType: 'track',
      toId: canonicalTrack.canonicalTrackId,
      relation: 'contains',
      weight: 0.85,
      updatedAt: nowMs,
    });
    relations.push({
      fromType: 'track',
      fromId: canonicalTrack.canonicalTrackId,
      toType: 'playlist',
      toId: entity.entityId,
      relation: 'belongs_to',
      weight: 0.85,
      updatedAt: nowMs,
    });
  }
  if (relations.length > 0) store.upsertEntityRelations(relations);
}

function entityTitleFromTrack(entityType: SonicEntityType, track: CanonicalTrack | null): string {
  if (!track) return '';
  if (entityType === 'album') return track.cleanAlbum || track.album || '';
  if (entityType === 'mv') return `${track.title} MV`;
  return '';
}

/**
 * Resolve an incoming event's entity reference onto a stored entity.
 * Order: exact entityId -> deterministic natural-key id (from entityTitle or the embedded
 * track's album/title metadata) -> create a derived entity. This keeps gray-era payloads
 * (client-invented ids like `alb_yehuimei_jay`) working as long as they carry enough
 * metadata, while never silently dropping the entity semantics.
 */
export function resolveEventEntity(
  store: RecommendStore,
  rawEv: SonicBehaviorEventInput,
  canonicalTrack: CanonicalTrack | null,
  nowMs: number,
): { entity: EntityRecord; resolvedFrom: 'exact-id' | 'natural-key' | 'created' } {
  const entityType = rawEv.entityType as SonicEntityType;
  const rawId = String(rawEv.entityId || '').trim();

  if (entityType === 'track') {
    const trackId = canonicalTrack?.canonicalTrackId || rawId;
    return {
      entity: {
        entityId: trackId,
        entityType: 'track',
        title: canonicalTrack?.title || rawId,
        subtitle: canonicalTrack?.canonicalArtist,
        artistKey: canonicalTrack ? compactNormalize(canonicalTrack.canonicalArtist) : undefined,
        genres: canonicalTrack?.genres,
        language: canonicalTrack?.language,
        coverUrl: canonicalTrack?.coverUrl,
        externalPopularity: canonicalTrack?.externalPopularity,
        derived: true,
        createdAt: canonicalTrack?.firstSeenAt || nowMs,
        updatedAt: nowMs,
      },
      resolvedFrom: 'exact-id',
    };
  }

  const exact = rawId ? store.getEntity(entityType, rawId) : null;
  if (exact) {
    ensureEntityTrackRelations(store, exact, canonicalTrack, nowMs);
    return { entity: exact, resolvedFrom: 'exact-id' };
  }

  const titleSource =
    (typeof rawEv.entityTitle === 'string' && rawEv.entityTitle.trim()) ||
    entityTitleFromTrack(entityType, canonicalTrack) ||
    rawId;
  const artistSource =
    canonicalTrack?.canonicalArtist ||
    (typeof rawEv.track?.artist === 'string' ? rawEv.track.artist : '') ||
    '';
  const naturalKey = `${compactNormalize(titleSource)}:::${compactNormalize(artistSource)}`;
  const derivedId = computeEntityId(entityType, naturalKey);
  const naturalMatch = store.getEntity(entityType, derivedId);
  if (naturalMatch) {
    ensureEntityTrackRelations(store, naturalMatch, canonicalTrack, nowMs);
    return { entity: naturalMatch, resolvedFrom: 'natural-key' };
  }

  const entity: EntityRecord = {
    entityId: derivedId,
    entityType,
    title: titleSource,
    subtitle: artistSource || undefined,
    artistKey: artistSource ? compactNormalize(artistSource) : undefined,
    genres: canonicalTrack?.genres,
    language: canonicalTrack?.language,
    coverUrl: canonicalTrack?.coverUrl,
    externalPopularity: canonicalTrack?.externalPopularity,
    derived: true,
    meta: rawId && rawId !== derivedId ? { requestedId: rawId, derivedFrom: 'event' } : { derivedFrom: 'event' },
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  store.upsertEntity(entity);
  ensureEntityTrackRelations(store, entity, canonicalTrack, nowMs);
  return { entity, resolvedFrom: 'created' };
}

// ── Catalog bootstrap: derive album / playlist / mv entities from the track catalog ──

const multiEntitySeededStores = new WeakSet<RecommendStore>();

export function ensureMultiEntityCatalog(store: RecommendStore, env?: AppEnv): number {
  if (multiEntitySeededStores.has(store)) return 0;
  multiEntitySeededStores.add(store);
  try {
    const tracks = store.listTracks(1200);
    if (tracks.length === 0) return 0;
    const counts = store.countEntities();
    const now = Date.now();
    let created = 0;

    // Albums: group tracks by (cleanAlbum, canonicalArtist)
    if (counts.album < 1 || counts.album < Math.min(60, new Set(tracks.map((t) => `${t.cleanAlbum}:::${compactNormalize(t.canonicalArtist)}`)).size)) {
      const albumGroups = new Map<string, CanonicalTrack[]>();
      for (const t of tracks) {
        if (!t.cleanAlbum) continue;
        const key = `${t.cleanAlbum}:::${compactNormalize(t.canonicalArtist)}`;
        const list = albumGroups.get(key);
        if (list) list.push(t);
        else albumGroups.set(key, [t]);
      }
      if (albumGroups.size > counts.album) {
        const albums: EntityRecord[] = [];
        const relations: EntityRelation[] = [];
        for (const [key, group] of albumGroups) {
          const [cleanAlbum, artistNorm] = key.split(':::');
          const primary = group[0];
          const albumId = computeAlbumEntityId(cleanAlbum, artistNorm || compactNormalize(primary.canonicalArtist));
          albums.push({
            entityId: albumId,
            entityType: 'album',
            title: cleanAlbum,
            subtitle: primary.canonicalArtist,
            artistKey: artistNorm || compactNormalize(primary.canonicalArtist),
            genres: Array.from(new Set(group.flatMap((t) => t.genres))).slice(0, 6),
            language: primary.language,
            coverUrl: primary.coverUrl,
            externalPopularity: Math.max(...group.map((t) => t.externalPopularity || 0)),
            derived: true,
            meta: { trackCount: group.length, releaseYear: primary.releaseDate?.slice(0, 4) },
            createdAt: now,
            updatedAt: now,
          });
          for (const t of group) {
            relations.push({
              fromType: 'album',
              fromId: albumId,
              toType: 'track',
              toId: t.canonicalTrackId,
              relation: 'contains',
              weight: 1.0,
              updatedAt: now,
            });
            relations.push({
              fromType: 'track',
              fromId: t.canonicalTrackId,
              toType: 'album',
              toId: albumId,
              relation: 'belongs_to',
              weight: 1.0,
              updatedAt: now,
            });
          }
        }
        store.upsertEntities(albums);
        store.upsertEntityRelations(relations);
        created += albums.length;
      }
    }

    // MVs: one auto-derived MV entity per playable track (upsert is idempotent per PK)
    if (counts.mv < tracks.length) {
      const mvs: EntityRecord[] = [];
      const relations: EntityRelation[] = [];
      for (const t of tracks) {
        const mvId = computeMvEntityId(t.canonicalTrackId);
        mvs.push({
          entityId: mvId,
          entityType: 'mv',
          title: `${t.title} MV`,
          subtitle: t.canonicalArtist,
          artistKey: compactNormalize(t.canonicalArtist),
          genres: t.genres,
          language: t.language,
          coverUrl: t.coverUrl,
          externalPopularity: t.externalPopularity,
          derived: true,
          meta: { sourceTrackId: t.canonicalTrackId, duration: t.duration },
          createdAt: now,
          updatedAt: now,
        });
        relations.push({
          fromType: 'mv',
          fromId: mvId,
          toType: 'track',
          toId: t.canonicalTrackId,
          relation: 'derives_from',
          weight: 0.9,
          updatedAt: now,
        });
        relations.push({
          fromType: 'track',
          fromId: t.canonicalTrackId,
          toType: 'mv',
          toId: mvId,
          relation: 'references',
          weight: 0.9,
          updatedAt: now,
        });
      }
      if (mvs.length > 0) {
        store.upsertEntities(mvs);
        store.upsertEntityRelations(relations);
        created += mvs.length;
      }
    }

    // Genre playlists: only genres with >= 4 tracks, capped at 8 playlists / 20 tracks each
    if (counts.playlist < 1) {
      const genreGroups = new Map<string, CanonicalTrack[]>();
      for (const t of tracks) {
        for (const g of t.genres) {
          if (!PLAYLIST_GENRE_LABELS[g]) continue;
          const list = genreGroups.get(g);
          if (list) list.push(t);
          else genreGroups.set(g, [t]);
        }
      }
      const eligible = Array.from(genreGroups.entries())
        .filter(([, group]) => group.length >= 4)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
      if (eligible.length > 0) {
        const playlists: EntityRecord[] = [];
        const relations: EntityRelation[] = [];
        for (const [genre, group] of eligible) {
          const playlistId = computePlaylistEntityId(genre);
          const members = group.slice(0, 20);
          playlists.push({
            entityId: playlistId,
            entityType: 'playlist',
            title: PLAYLIST_GENRE_LABELS[genre],
            subtitle: 'Sonic 编辑精选',
            genres: [genre],
            externalPopularity: Math.max(...members.map((t) => t.externalPopularity || 0)),
            derived: true,
            meta: { trackCount: members.length, sourceGenre: genre },
            createdAt: now,
            updatedAt: now,
          });
          members.forEach((t, idx) => {
            relations.push({
              fromType: 'playlist',
              fromId: playlistId,
              toType: 'track',
              toId: t.canonicalTrackId,
              relation: 'contains',
              weight: Math.max(0.5, 0.85 - idx * 0.02),
              updatedAt: now,
            });
            relations.push({
              fromType: 'track',
              fromId: t.canonicalTrackId,
              toType: 'playlist',
              toId: playlistId,
              relation: 'belongs_to',
              weight: Math.max(0.5, 0.85 - idx * 0.02),
              updatedAt: now,
            });
          });
        }
        store.upsertEntities(playlists);
        store.upsertEntityRelations(relations);
        created += playlists.length;
      }
    }

    return created;
  } catch {
    // Entity catalog is an enhancement layer: never break the track pipeline on derivation failure
    return 0;
  }
}

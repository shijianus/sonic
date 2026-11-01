// Sonic Intelligent Recommendation — Multi-Entity Hybrid Recommendation Engine
// Supports unified entity modeling for Tracks, Albums, Playlists, and MVs
// Implements bidirectional soft signal propagation, multi-channel candidate recall,
// Bayesian popularity fusion, and MMR diversity reranking with cross-entity penalties.

import type { AppEnv } from '../../types';
import type {
  CanonicalTrack,
  EntityRelation,
  InferredLanguage,
  MixedFeedItem,
  MixedFeedResponse,
  PropagationCoefficients,
  RecommendStore,
  SonicBehaviorEventInput,
  SonicEntity,
  SonicEntityAction,
  SonicEntityType,
  StoredBehaviorEvent,
  UserEntityFeedback,
  UserIdentityContext,
} from './types';
import { compactNormalize, extractQueryGenres } from './text-norm';
import { deterministicHash16, isPlayableTrack } from './track-canonical';
import { getRecommendStore } from './memory-store';
import { ensureCatalogSeeded } from './seed-catalog';

export const DEFAULT_PROPAGATION_COEFFICIENTS: PropagationCoefficients = {
  albumToTrack: 0.40,
  playlistToTrack: 0.35,
  trackToAlbum: 0.30,
  trackToPlaylist: 0.25,
  trackToMv: 0.35,
  mvToTrack: 0.45,
  mvToArtistMv: 0.25,
  dislikePropagation: 0.15,
};

export function getPropagationCoefficients(env?: AppEnv): PropagationCoefficients {
  return {
    albumToTrack: parseFloat(env?.SONIC_PROPAGATE_ALBUM_TO_TRACK || '') || DEFAULT_PROPAGATION_COEFFICIENTS.albumToTrack,
    playlistToTrack: parseFloat(env?.SONIC_PROPAGATE_PLAYLIST_TO_TRACK || '') || DEFAULT_PROPAGATION_COEFFICIENTS.playlistToTrack,
    trackToAlbum: parseFloat(env?.SONIC_PROPAGATE_TRACK_TO_ALBUM || '') || DEFAULT_PROPAGATION_COEFFICIENTS.trackToAlbum,
    trackToPlaylist: parseFloat(env?.SONIC_PROPAGATE_TRACK_TO_PLAYLIST || '') || DEFAULT_PROPAGATION_COEFFICIENTS.trackToPlaylist,
    trackToMv: parseFloat(env?.SONIC_PROPAGATE_TRACK_TO_MV || '') || DEFAULT_PROPAGATION_COEFFICIENTS.trackToMv,
    mvToTrack: parseFloat(env?.SONIC_PROPAGATE_MV_TO_TRACK || '') || DEFAULT_PROPAGATION_COEFFICIENTS.mvToTrack,
    mvToArtistMv: parseFloat(env?.SONIC_PROPAGATE_MV_TO_ARTIST_MV || '') || DEFAULT_PROPAGATION_COEFFICIENTS.mvToArtistMv,
    dislikePropagation: parseFloat(env?.SONIC_PROPAGATE_DISLIKE || '') || DEFAULT_PROPAGATION_COEFFICIENTS.dislikePropagation,
  };
}

const NON_USER_SKIP_REASONS = new Set([
  'network_stall',
  'playback_error',
  'trial_end',
  'stream_unavailable',
  'buffer_timeout',
  'auto_switch_error',
]);

// ── 1. Weight Calculation for Multi-Entity Actions ──
export function computeEntityActionWeight(input: {
  action?: SonicEntityAction;
  type?: string;
  progress?: number;
  progressRatio?: number;
  playedSeconds?: number;
  durationSeconds?: number;
  reason?: string;
}): number {
  const act = input.action || (input.type as SonicEntityAction);
  switch (act) {
    case 'favorite':
      return 4.0;
    case 'unfavorite':
      return -1.5;
    case 'replay':
      return 3.5;
    case 'play_complete':
    case 'watch_complete':
      return 2.5;
    case 'add_to_playlist':
      return 2.0;
    case 'open':
      return 0.5;
    case 'play_start':
      return 0.35;
    case 'play_progress':
    case 'watch_progress': {
      const ratio =
        input.progress ??
        input.progressRatio ??
        (input.playedSeconds && input.durationSeconds && input.durationSeconds > 0
          ? input.playedSeconds / input.durationSeconds
          : 0.5);
      if (ratio >= 0.75) return 1.8;
      if (ratio >= 0.45 || (input.playedSeconds && input.playedSeconds >= 60)) return 1.2;
      return 0.2;
    }
    case 'skip': {
      if (input.reason && NON_USER_SKIP_REASONS.has(input.reason)) {
        return 0; // Filter non-user skip noise
      }
      const ratio =
        input.progress ??
        input.progressRatio ??
        (input.playedSeconds !== undefined && input.durationSeconds && input.durationSeconds > 0
          ? input.playedSeconds / input.durationSeconds
          : undefined);
      if ((input.playedSeconds !== undefined && input.playedSeconds >= 60) || (ratio !== undefined && ratio >= 0.5)) {
        return 0.25; // Listened over half before pressing next -> mild positive
      }
      if ((input.playedSeconds !== undefined && input.playedSeconds < 25) || (ratio !== undefined && ratio < 0.2) || input.playedSeconds === undefined) {
        return -0.8; // Early skip -> negative
      }
      return -0.25;
    }
    case 'dislike':
      return -5.0;
    case 'undislike':
      return 0.5;
    default:
      return 0;
  }
}

// ── 2. Automatic Seed Aggregation for Albums, Playlists & MVs ──
export function ensureMultiEntityCatalogSeeded(store: RecommendStore, env?: AppEnv): void {
  ensureCatalogSeeded(store, env);
  if (store.listEntities && store.listEntities('album', 1).length > 0) {
    return;
  }

  const tracks = store.listTracks(1500);
  if (tracks.length === 0) return;

  const now = Date.now();
  const entitiesToUpsert: SonicEntity[] = [];
  const relationsToUpsert: EntityRelation[] = [];

  // Group tracks by (cleanAlbum, canonicalArtist) to form official albums
  const albumGroups = new Map<string, { albumName: string; artistName: string; tracks: CanonicalTrack[] }>();
  for (const t of tracks) {
    if (!t.cleanAlbum || !t.canonicalArtist) continue;
    const key = `${t.cleanAlbum}:::${compactNormalize(t.canonicalArtist)}`;
    let g = albumGroups.get(key);
    if (!g) {
      g = { albumName: t.album || t.cleanAlbum, artistName: t.canonicalArtist, tracks: [] };
      albumGroups.set(key, g);
    }
    g.tracks.push(t);
  }

  for (const [key, g] of albumGroups.entries()) {
    const albHash = deterministicHash16(`alb:${key}`);
    const albumId = `alb_${albHash}`;
    const primaryCover = g.tracks[0]?.coverUrl || '';
    const allTags = Array.from(new Set(g.tracks.flatMap((t) => [...(t.genres || []), ...(t.tags || [])])));
    const avgPop = Math.round(g.tracks.reduce((s, t) => s + (t.externalPopularity || 0), 0) / g.tracks.length);

    entitiesToUpsert.push({
      id: albumId,
      type: 'album',
      title: g.albumName,
      subtitle: `${g.artistName} · 专辑 · ${g.tracks.length} 首曲目`,
      artistName: g.artistName,
      coverUrl: primaryCover,
      source: 'sonic',
      sourceId: key,
      tags: allTags,
      language: g.tracks[0]?.language,
      duration: g.tracks.reduce((s, t) => s + (t.duration || 0), 0),
      externalPopularity: avgPop,
      createdAt: g.tracks[0]?.firstSeenAt || now,
      updatedAt: now,
      payload: {
        artist: g.artistName,
        trackCount: g.tracks.length,
        tracksPreview: g.tracks.slice(0, 5).map((t) => t.cleanTitle || t.title),
        releaseDate: g.tracks[0]?.releaseDate,
        albumId,
      },
    });

    g.tracks.forEach((t, idx) => {
      relationsToUpsert.push({
        relationId: `${albumId}:::${t.canonicalTrackId}:::contains`,
        parentId: albumId,
        parentType: 'album',
        childId: t.canonicalTrackId,
        childType: 'track',
        relationType: 'contains',
        weight: 1.0,
        position: idx + 1,
        createdAt: now,
      });
    });
  }

  // Create Virtual Curated Playlists by style/theme
  const playlistDefinitions = [
    {
      id: 'pl_chinese_rnb_classics',
      title: '华语经典 R&B 与千禧节奏宝藏',
      subtitle: '周杰伦 / 陶喆 / 林俊杰 / 方大同 律动精选',
      tags: ['r&b', 'soul', 'mandopop'],
      filter: (t: CanonicalTrack) =>
        ['周杰伦', '陶喆', '林俊杰', '方大同'].includes(t.canonicalArtist) ||
        t.genres.includes('r&b'),
    },
    {
      id: 'pl_cantopop_golden_age',
      title: '港乐黄金时代 · 粤语传世金曲',
      subtitle: '陈奕迅 / Beyond / 张学友 / 张国荣 岁月回响',
      tags: ['cantopop', 'rock', 'classic'],
      filter: (t: CanonicalTrack) =>
        t.language === 'yue' ||
        t.genres.includes('cantopop') ||
        ['Beyond', '陈奕迅', '张学友', '张国荣'].includes(t.canonicalArtist),
    },
    {
      id: 'pl_acoustic_ballad_night',
      title: '深夜不插电 · 纯粹流行抒情',
      subtitle: '静谧人声与吉他钢琴的心灵对话',
      tags: ['ballad', 'pop', 'acoustic'],
      filter: (t: CanonicalTrack) => t.genres.includes('ballad') || t.edition === 'acoustic',
    },
  ];

  for (const pDef of playlistDefinitions) {
    const matchedTracks = tracks.filter(pDef.filter);
    if (matchedTracks.length === 0) continue;
    const coverUrl = matchedTracks[0]?.coverUrl || '';
    const avgPop = Math.round(matchedTracks.reduce((s, t) => s + (t.externalPopularity || 0), 0) / matchedTracks.length);

    entitiesToUpsert.push({
      id: pDef.id,
      type: 'playlist',
      title: pDef.title,
      subtitle: pDef.subtitle,
      coverUrl,
      source: 'sonic',
      sourceId: pDef.id,
      tags: pDef.tags,
      externalPopularity: avgPop,
      createdAt: now,
      updatedAt: now,
      payload: {
        playlistId: pDef.id,
        trackCount: matchedTracks.length,
        tracksPreview: matchedTracks.slice(0, 5).map((t) => t.cleanTitle || t.title),
      },
    });

    matchedTracks.forEach((t, idx) => {
      relationsToUpsert.push({
        relationId: `${pDef.id}:::${t.canonicalTrackId}:::contains`,
        parentId: pDef.id,
        parentType: 'playlist',
        childId: t.canonicalTrackId,
        childType: 'track',
        relationType: 'contains',
        weight: 1.0,
        position: idx + 1,
        createdAt: now,
      });
    });
  }

  // Create MVs for top tracks (with video_of relation to track)
  const topTracksForMv = tracks
    .filter((t) => isPlayableTrack(t) && t.externalPopularity >= 88)
    .slice(0, 25);

  for (const t of topTracksForMv) {
    const mvHash = deterministicHash16(`mv:${t.canonicalTrackId}`);
    const mvId = `mv_${mvHash}`;
    entitiesToUpsert.push({
      id: mvId,
      type: 'mv',
      title: `${t.cleanTitle || t.title} (Official MV)`,
      subtitle: `${t.canonicalArtist} · 官方音乐录影带`,
      artistName: t.canonicalArtist,
      coverUrl: t.coverUrl,
      source: 'sonic',
      sourceId: t.canonicalTrackId,
      tags: [...t.genres, 'mv', 'video'],
      language: t.language,
      duration: t.duration || 240,
      externalPopularity: t.externalPopularity,
      createdAt: t.firstSeenAt || now,
      updatedAt: now,
      payload: {
        mvId,
        relatedTrackId: t.canonicalTrackId,
        artist: t.canonicalArtist,
        cleanTitle: t.cleanTitle,
        duration: t.duration,
        hasVideo: true,
        resolution: '1080p',
      },
    });

    relationsToUpsert.push({
      relationId: `${mvId}:::${t.canonicalTrackId}:::video_of`,
      parentId: mvId,
      parentType: 'mv',
      childId: t.canonicalTrackId,
      childType: 'track',
      relationType: 'video_of',
      weight: 1.0,
      createdAt: now,
    });
  }

  if (store.upsertEntities) {
    store.upsertEntities(entitiesToUpsert);
  }
  if (store.upsertEntityRelations) {
    store.upsertEntityRelations(relationsToUpsert);
  }
}

// ── 3. Multi-Entity Preference Profile & Signal Propagation ──
export interface MultiEntityProfile {
  subjectKey: string;
  hasSignals: boolean;
  directEntityScores: Map<string, number>;
  propagatedEntityScores: Map<string, number>;
  blockedEntityIds: Set<string>;
  penalizedEntities: Map<string, number>;
  topArtists: Map<string, number>;
  genreAffinities: Map<string, number>;
}

export function buildMultiEntityPreferenceProfile(
  identity: UserIdentityContext,
  store: RecommendStore,
  env?: AppEnv,
  nowMs = Date.now(),
): MultiEntityProfile {
  const profile: MultiEntityProfile = {
    subjectKey: identity.subjectKey || 'public',
    hasSignals: false,
    directEntityScores: new Map(),
    propagatedEntityScores: new Map(),
    blockedEntityIds: new Set(),
    penalizedEntities: new Map(),
    topArtists: new Map(),
    genreAffinities: new Map(),
  };

  if (!identity.personalizationEnabled || !identity.subjectKey) {
    return profile;
  }

  const coef = getPropagationCoefficients(env);
  const HALF_LIFE_MS = 7 * 24 * 3600 * 1000; // 7 days exponential half-life
  const lambda = Math.LN2 / HALF_LIFE_MS;

  // 1. Ingest standard track behavior events
  const trackEvents = store.getUserEvents(identity.subjectKey, 300, nowMs - 60 * 24 * 3600 * 1000);
  for (const ev of trackEvents) {
    profile.hasSignals = true;
    const dt = Math.max(0, nowMs - ev.createdAt);
    const decay = Math.exp(-lambda * dt);
    const effWeight = ev.weight * decay;

    if (ev.canonicalTrackId) {
      if (ev.weight <= -4.0) {
        profile.blockedEntityIds.add(ev.canonicalTrackId);
      } else {
        const cur = profile.directEntityScores.get(ev.canonicalTrackId) || 0;
        profile.directEntityScores.set(ev.canonicalTrackId, cur + effWeight);
      }
    }
    if (ev.artistKey) {
      const arNorm = compactNormalize(ev.artistKey);
      profile.topArtists.set(arNorm, (profile.topArtists.get(arNorm) || 0) + effWeight);
    }
    if (ev.genres?.length) {
      for (const g of ev.genres) {
        profile.genreAffinities.set(g, (profile.genreAffinities.get(g) || 0) + effWeight);
      }
    }
  }

  // 2. Ingest multi-entity feedback (albums, playlists, MVs, etc.)
  const entityFeedbacks = store.getUserEntityFeedbacks
    ? store.getUserEntityFeedbacks(identity.subjectKey, 300, nowMs - 60 * 24 * 3600 * 1000)
    : [];

  for (const fb of entityFeedbacks) {
    profile.hasSignals = true;
    const dt = Math.max(0, nowMs - fb.createdAt);
    const decay = Math.exp(-lambda * dt);
    const effWeight = fb.weight * decay;

    if (fb.weight <= -4.0) {
      profile.blockedEntityIds.add(fb.entityId);
    } else {
      const cur = profile.directEntityScores.get(fb.entityId) || 0;
      profile.directEntityScores.set(fb.entityId, cur + effWeight);
    }
  }

  // 3. Bidirectional Soft Signal Propagation across Entity Graph
  for (const [entityId, directScore] of profile.directEntityScores.entries()) {
    if (directScore <= 0) continue;

    // A. If entity is Album or Playlist -> Propagate positive score down to child Tracks
    const childRels = store.getEntityRelations ? store.getEntityRelations(entityId, 'children') : [];
    for (const rel of childRels) {
      if (rel.childType === 'track') {
        const propFactor = rel.parentType === 'album' ? coef.albumToTrack : coef.playlistToTrack;
        const addScore = directScore * propFactor * (rel.weight || 1.0);
        const cur = profile.propagatedEntityScores.get(rel.childId) || 0;
        profile.propagatedEntityScores.set(rel.childId, cur + addScore);
      }
    }

    // B. If entity is Track -> Propagate positive score up to parent Albums/Playlists and across to MVs
    const parentRels = store.getEntityRelations ? store.getEntityRelations(entityId, 'parents') : [];
    for (const rel of parentRels) {
      if (rel.parentType === 'album') {
        const addScore = directScore * coef.trackToAlbum * (rel.weight || 1.0);
        const cur = profile.propagatedEntityScores.get(rel.parentId) || 0;
        profile.propagatedEntityScores.set(rel.parentId, cur + addScore);
      } else if (rel.parentType === 'playlist') {
        const addScore = directScore * coef.trackToPlaylist * (rel.weight || 1.0);
        const cur = profile.propagatedEntityScores.get(rel.parentId) || 0;
        profile.propagatedEntityScores.set(rel.parentId, cur + addScore);
      } else if (rel.parentType === 'mv') {
        const addScore = directScore * coef.trackToMv * (rel.weight || 1.0);
        const cur = profile.propagatedEntityScores.get(rel.parentId) || 0;
        profile.propagatedEntityScores.set(rel.parentId, cur + addScore);
      }
    }

    // C. If entity is MV -> Propagate to related Track and same-artist MVs
    if (entityId.startsWith('mv_')) {
      const mvChildRels = store.getEntityRelations ? store.getEntityRelations(entityId, 'children') : [];
      for (const rel of mvChildRels) {
        if (rel.childType === 'track') {
          const addScore = directScore * coef.mvToTrack * (rel.weight || 1.0);
          const cur = profile.propagatedEntityScores.get(rel.childId) || 0;
          profile.propagatedEntityScores.set(rel.childId, cur + addScore);
        }
      }
    }
  }

  // 4. Dislike cautious propagation (weak penalty to relations, NEVER hard-block related tracks)
  for (const blockedId of profile.blockedEntityIds) {
    const childRels = store.getEntityRelations ? store.getEntityRelations(blockedId, 'children') : [];
    for (const rel of childRels) {
      const curPen = profile.penalizedEntities.get(rel.childId) || 0;
      profile.penalizedEntities.set(rel.childId, curPen + 1.0 * coef.dislikePropagation);
    }
    const parentRels = store.getEntityRelations ? store.getEntityRelations(blockedId, 'parents') : [];
    for (const rel of parentRels) {
      const curPen = profile.penalizedEntities.get(rel.parentId) || 0;
      profile.penalizedEntities.set(rel.parentId, curPen + 1.0 * coef.dislikePropagation);
    }
  }

  return profile;
}

// ── 4. Cross-Entity MMR Reranking with Consecutive Type Penalty ──
interface ScoredEntityCandidate {
  entityType: SonicEntityType;
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  artistName: string;
  genres: string[];
  score: number;
  reason: string;
  payload: Record<string, any>;
}

function jaccardSet(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  let inter = 0;
  for (const x of b) {
    if (setA.has(x)) inter++;
  }
  const union = setA.size + b.length - inter;
  return union > 0 ? inter / union : 0;
}

export function diversifyMultiEntityCandidates(
  candidates: ScoredEntityCandidate[],
  targetCount: number,
  options?: {
    diversity?: number; // [0, 1]
    temperature?: number; // [0.1, 1.5]
    typeRatios?: {
      track: number; // default ~0.60
      album: number; // default ~0.18
      playlist: number; // default ~0.08
      mv: number; // default ~0.14
    };
  },
): MixedFeedItem[] {
  const diversity = Math.max(0, Math.min(0.85, options?.diversity ?? 0.32));
  const lambda = 1 - diversity;
  const temperature = Math.max(0, Math.min(1.5, options?.temperature ?? 0.25));

  const ratios = options?.typeRatios || {
    track: 0.60,
    album: 0.18,
    playlist: 0.08,
    mv: 0.14,
  };

  // Group candidates by entity type
  const poolByType: Record<SonicEntityType, ScoredEntityCandidate[]> = {
    track: [],
    album: [],
    playlist: [],
    mv: [],
  };

  for (const cand of candidates) {
    let adjScore = cand.score;
    if (temperature > 0.2) {
      const jitter = (Math.random() - 0.5) * 0.12 * temperature;
      adjScore = Math.max(0.01, cand.score + jitter);
    }
    poolByType[cand.entityType]?.push({ ...cand, score: adjScore });
  }

  for (const t of Object.keys(poolByType) as SonicEntityType[]) {
    poolByType[t].sort((a, b) => b.score - a.score);
  }

  // Quota allocation
  const maxTracks = Math.ceil(targetCount * 0.70);
  const maxAlbumsAndPlaylists = Math.max(1, Math.ceil(targetCount * 0.28));
  const maxMvs = Math.max(1, Math.ceil(targetCount * 0.20));

  const minAlbumsAndPlaylists = Math.min(
    poolByType.album.length + poolByType.playlist.length,
    Math.max(1, Math.floor(targetCount * 0.15)),
  );
  const minMvs = Math.min(poolByType.mv.length, Math.max(1, Math.floor(targetCount * 0.10)));

  const selected: ScoredEntityCandidate[] = [];
  const selectedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  const typeCounts: Record<SonicEntityType, number> = {
    track: 0,
    album: 0,
    playlist: 0,
    mv: 0,
  };

  const remaining = [...candidates].sort((a, b) => b.score - a.score);

  while (selected.length < targetCount && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    const lastItem = selected[selected.length - 1];

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (selectedIds.has(cand.id)) continue;

      // Quota cap enforcement
      if (cand.entityType === 'track' && typeCounts.track >= maxTracks) {
        const hasOther = remaining.some((c) => c.entityType !== 'track' && !selectedIds.has(c.id));
        if (hasOther) continue;
      }
      if (
        (cand.entityType === 'album' || cand.entityType === 'playlist') &&
        typeCounts.album + typeCounts.playlist >= maxAlbumsAndPlaylists
      ) {
        const hasOther = remaining.some((c) => c.entityType !== 'album' && c.entityType !== 'playlist' && !selectedIds.has(c.id));
        if (hasOther) continue;
      }
      if (cand.entityType === 'mv' && typeCounts.mv >= maxMvs) {
        const hasOther = remaining.some((c) => c.entityType !== 'mv' && !selectedIds.has(c.id));
        if (hasOther) continue;
      }

      // Reservation for under-represented required minimum quotas
      const remainingSlots = targetCount - selected.length;
      const neededAlbPl = Math.max(0, minAlbumsAndPlaylists - (typeCounts.album + typeCounts.playlist));
      const neededMvs = Math.max(0, minMvs - typeCounts.mv);
      if (remainingSlots <= neededAlbPl + neededMvs) {
        if (cand.entityType === 'track') continue;
        if (neededMvs > 0 && neededAlbPl === 0 && cand.entityType !== 'mv') continue;
        if (neededAlbPl > 0 && neededMvs === 0 && cand.entityType === 'mv') continue;
      }

      const arKey = compactNormalize(cand.artistName);
      if (arKey && (artistCounts.get(arKey) || 0) >= 3) {
        continue; // Prevent single artist monopoly
      }

      // Compute cross-entity redundancy with previously selected items
      let maxRedundancy = 0;
      for (const prev of selected) {
        let r = 0;
        if (arKey && arKey === compactNormalize(prev.artistName)) {
          r += 0.45;
        }
        r += 0.35 * jaccardSet(cand.genres, prev.genres);
        if (r > maxRedundancy) maxRedundancy = r;
      }

      // Penalty for consecutive same entity_type to encourage smooth interleaving
      let consecutivePenalty = 0;
      if (lastItem && lastItem.entityType === cand.entityType) {
        consecutivePenalty = 0.28;
      }

      const mmrScore =
        selected.length === 0
          ? cand.score
          : lambda * cand.score - (1 - lambda) * (maxRedundancy * 0.6 + consecutivePenalty);

      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // Relax constraints to fill requested count
      const nextAvailable = remaining.find((c) => !selectedIds.has(c.id));
      if (!nextAvailable) break;
      selected.push(nextAvailable);
      selectedIds.add(nextAvailable.id);
      typeCounts[nextAvailable.entityType] = (typeCounts[nextAvailable.entityType] || 0) + 1;
      continue;
    }

    const [chosen] = remaining.splice(bestIdx, 1);
    selected.push(chosen);
    selectedIds.add(chosen.id);
    typeCounts[chosen.entityType] = (typeCounts[chosen.entityType] || 0) + 1;

    const arKey = compactNormalize(chosen.artistName);
    if (arKey) {
      artistCounts.set(arKey, (artistCounts.get(arKey) || 0) + 1);
    }
  }

  return selected.map((c) => ({
    type: c.entityType,
    id: c.id,
    title: c.title,
    subtitle: c.subtitle,
    cover: c.cover,
    score: Math.round(c.score * 1000) / 1000,
    reason: c.reason,
    payload: c.payload,
  }));
}

// ── 5. Main Mixed Feed Recommendation Pipeline ──
export async function getMultiEntityRecommendationsForYou(
  identity: UserIdentityContext,
  options: {
    count?: number;
    diversity?: number;
    temperature?: number;
    excludeIds?: string[];
    allowedTypes?: SonicEntityType[];
  } = {},
  env?: AppEnv,
): Promise<MixedFeedResponse> {
  const start = Date.now();
  const store = getRecommendStore(env);
  ensureMultiEntityCatalogSeeded(store, env);

  const count = Math.min(50, Math.max(1, options.count || 18));
  const excludeSet = new Set(options.excludeIds || []);
  const allowedTypes = new Set(options.allowedTypes || ['track', 'album', 'playlist', 'mv']);

  const nowMs = Date.now();
  const profile = buildMultiEntityPreferenceProfile(identity, store, env, nowMs);

  const candidates: ScoredEntityCandidate[] = [];

  // 1. Candidate Generation: Tracks
  if (allowedTypes.has('track')) {
    const tracks = store.listTracks(800);
    for (const t of tracks) {
      if (!isPlayableTrack(t)) continue;
      if (profile.blockedEntityIds.has(t.canonicalTrackId) || excludeSet.has(t.canonicalTrackId)) continue;
      if (t.edition === 'demo' || t.edition === 'cover') continue;

      const direct = profile.directEntityScores.get(t.canonicalTrackId) || 0;
      const prop = profile.propagatedEntityScores.get(t.canonicalTrackId) || 0;
      const arAffinity = profile.topArtists.get(compactNormalize(t.canonicalArtist)) || 0;

      let score = 0;
      let reason = '全站高口碑热门佳作';

      if (direct > 0) {
        score = 0.55 + Math.min(0.35, direct * 0.1);
        reason = `根据你对《${t.cleanTitle}》的喜爱推荐`;
      } else if (prop > 0) {
        score = 0.50 + Math.min(0.35, prop * 0.12);
        reason = `因为你收藏/常听相关的专辑或 MV`;
      } else if (arAffinity > 0) {
        score = 0.45 + Math.min(0.35, arAffinity * 0.08);
        reason = `常听 ${t.canonicalArtist} · 偏好风格匹配`;
      } else {
        score = (t.externalPopularity || 50) / 100 * 0.45 + 0.35;
        reason = '站内近期热播精选';
      }

      const pen = profile.penalizedEntities.get(t.canonicalTrackId) || 0;
      if (pen > 0) score /= (1 + pen * 0.5);

      candidates.push({
        entityType: 'track',
        id: t.canonicalTrackId,
        title: t.title,
        subtitle: `${t.canonicalArtist} · ${t.album || '单曲'}`,
        cover: t.coverUrl,
        artistName: t.canonicalArtist,
        genres: t.genres || [],
        score: Math.min(0.99, Math.max(0.05, score)),
        reason,
        payload: {
          canonicalTrackId: t.canonicalTrackId,
          artist: t.canonicalArtist,
          album: t.album,
          duration: t.duration,
          streamType: t.streamType || 'full',
          provider: t.provider,
        },
      });
    }
  }

  // 2. Candidate Generation: Albums
  if (allowedTypes.has('album')) {
    const albums = store.listEntities ? store.listEntities('album', 300) : [];
    for (const alb of albums) {
      if (profile.blockedEntityIds.has(alb.id) || excludeSet.has(alb.id)) continue;
      const direct = profile.directEntityScores.get(alb.id) || 0;
      const prop = profile.propagatedEntityScores.get(alb.id) || 0;
      const arAffinity = alb.artistName ? profile.topArtists.get(compactNormalize(alb.artistName)) || 0 : 0;

      let score = 0;
      let reason = '经典高口碑专辑推荐';

      if (direct > 0) {
        score = 0.55 + Math.min(0.35, direct * 0.1);
        reason = `你收藏并常听的专辑《${alb.title}》`;
      } else if (prop > 0) {
        score = 0.52 + Math.min(0.35, prop * 0.12);
        reason = `因为你深度收听了该专辑内的曲目`;
      } else if (arAffinity > 0) {
        score = 0.48 + Math.min(0.32, arAffinity * 0.08);
        reason = `根据你偏好的歌手 ${alb.artistName} 推荐`;
      } else {
        score = (alb.externalPopularity || 50) / 100 * 0.42 + 0.32;
        reason = '备受推崇的经典专辑';
      }

      const pen = profile.penalizedEntities.get(alb.id) || 0;
      if (pen > 0) score /= (1 + pen * 0.5);

      candidates.push({
        entityType: 'album',
        id: alb.id,
        title: alb.title,
        subtitle: alb.subtitle || `${alb.artistName} · 专辑`,
        cover: alb.coverUrl || '',
        artistName: alb.artistName || '',
        genres: alb.tags || [],
        score: Math.min(0.99, Math.max(0.05, score)),
        reason,
        payload: alb.payload || {},
      });
    }
  }

  // 3. Candidate Generation: Playlists
  if (allowedTypes.has('playlist')) {
    const playlists = store.listEntities ? store.listEntities('playlist', 100) : [];
    for (const pl of playlists) {
      if (profile.blockedEntityIds.has(pl.id) || excludeSet.has(pl.id)) continue;
      const direct = profile.directEntityScores.get(pl.id) || 0;
      const prop = profile.propagatedEntityScores.get(pl.id) || 0;

      let score = 0;
      let reason = '精选主题歌单';

      if (direct > 0) {
        score = 0.55 + Math.min(0.35, direct * 0.1);
        reason = `根据你的歌单收藏习惯推荐`;
      } else if (prop > 0) {
        score = 0.50 + Math.min(0.35, prop * 0.12);
        reason = `包含你近期常听的多首曲目`;
      } else {
        score = (pl.externalPopularity || 50) / 100 * 0.40 + 0.30;
        reason = '雷达精选风格歌单';
      }

      candidates.push({
        entityType: 'playlist',
        id: pl.id,
        title: pl.title,
        subtitle: pl.subtitle || '主题歌单',
        cover: pl.coverUrl || '',
        artistName: '',
        genres: pl.tags || [],
        score: Math.min(0.99, Math.max(0.05, score)),
        reason,
        payload: pl.payload || {},
      });
    }
  }

  // 4. Candidate Generation: MVs
  if (allowedTypes.has('mv')) {
    const mvs = store.listEntities ? store.listEntities('mv', 200) : [];
    for (const mv of mvs) {
      if (profile.blockedEntityIds.has(mv.id) || excludeSet.has(mv.id)) continue;
      const direct = profile.directEntityScores.get(mv.id) || 0;
      const prop = profile.propagatedEntityScores.get(mv.id) || 0;
      const arAffinity = mv.artistName ? profile.topArtists.get(compactNormalize(mv.artistName)) || 0 : 0;

      let score = 0;
      let reason = '官方高清音乐录影带精选';

      if (direct > 0) {
        score = 0.58 + Math.min(0.35, direct * 0.1);
        reason = `根据你常看 MV 的偏好推荐`;
      } else if (prop > 0) {
        score = 0.53 + Math.min(0.35, prop * 0.12);
        reason = `你常听这首单曲，推荐观看官方视觉影像`;
      } else if (arAffinity > 0) {
        score = 0.46 + Math.min(0.32, arAffinity * 0.08);
        reason = `因为你偏爱 ${mv.artistName} 的音乐风格`;
      } else {
        score = (mv.externalPopularity || 50) / 100 * 0.42 + 0.30;
        reason = '超高清视听热门 MV';
      }

      const pen = profile.penalizedEntities.get(mv.id) || 0;
      if (pen > 0) score /= (1 + pen * 0.5);

      candidates.push({
        entityType: 'mv',
        id: mv.id,
        title: mv.title,
        subtitle: mv.subtitle || `${mv.artistName} · MV`,
        cover: mv.coverUrl || '',
        artistName: mv.artistName || '',
        genres: mv.tags || [],
        score: Math.min(0.99, Math.max(0.05, score)),
        reason,
        payload: mv.payload || {},
      });
    }
  }

  // Diversified Reranking
  const diversifiedItems = diversifyMultiEntityCandidates(candidates, count, {
    diversity: options.diversity,
    temperature: options.temperature,
  });

  const distribution: Record<SonicEntityType, number> = {
    track: 0,
    album: 0,
    playlist: 0,
    mv: 0,
  };
  for (const item of diversifiedItems) {
    distribution[item.type] = (distribution[item.type] || 0) + 1;
  }

  return {
    brand: 'Sonic',
    data: diversifiedItems,
    meta: {
      latency_ms: Date.now() - start,
      strategy: 'hybrid-multi-entity',
      distribution,
      personalized: profile.hasSignals,
      total: diversifiedItems.length,
    },
  };
}

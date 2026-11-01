// Sonic Multi-Entity Recommendation — Mixed Feed Recall, Bidirectional Propagation & Type-Diverse Rerank
// GET /api/sonic/recommend/for-you?feed=mixed
//
// Pipeline (all local-SQLite, no network, deterministic — no Math.random):
//   1. ensureMultiEntityCatalog: derive album/playlist/mv entities + relations from the track catalog
//   2. Entity recall: direct entity feedback affinity + track->entity propagation + popularity cold fill
//   3. Track recall: artist/genre affinity + entity->track propagation (album/playlist/mv boosts) + popularity
//   4. diversifyMixedList: type quotas + MMR-style redundancy + adjacency constraints (no track next
//      to its own album/MV), then order by score with a no-3-consecutive-same-type guarantee.

import type { AppEnv } from '../../types';
import type {
  EntityRecord,
  ExplanationSignal,
  MixedDistribution,
  MixedFeedOptions,
  MixedFeedResult,
  MixedRecommendationItem,
  RecommendedTrack,
  SonicEntityType,
  UserIdentityContext,
} from './types';
import { compactNormalize } from './text-norm';
import { canonicalToRecommendedTrack, isPlayableTrack } from './track-canonical';
import { getRecommendStore } from './memory-store';
import { computeCatalogPopularity, exponentialTimeDecay } from './popularity';
import { ensureCatalogSeeded } from './seed-catalog';
import { buildUserPreferenceProfile } from './engine';
import {
  computeAlbumEntityId,
  computeMvEntityId,
  ensureMultiEntityCatalog,
  getMultiEntityPropagationConfig,
} from './entity-store';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ENTITY_TYPE_LABELS: Record<SonicEntityType, string> = {
  track: '歌曲',
  album: '专辑',
  playlist: '歌单',
  mv: 'MV',
};

const ENTITY_ACTION_LABELS: Record<string, string> = {
  favorite: '收藏的',
  play_complete: '听完的',
  watch_complete: '看完的',
  replay: '反复听的',
  play_progress: '听过的',
  watch_progress: '看过的',
  open: '浏览过的',
  play_start: '播放过的',
  search_click: '点过',
  skip: '跳过的',
  dislike: '不喜欢的',
};

interface EntityCandidate {
  entity: EntityRecord;
  score: number;
  reasonCode: 'entity_affinity' | 'entity_propagation' | 'entity_popular';
  signals: ExplanationSignal[];
}

interface MixedCandidate {
  item: MixedRecommendationItem;
  adjacencyKeys: Set<string>; // Entity ids that should not sit right next to this item
}

function quotaPlan(count: number, allowedTypes: SonicEntityType[]): Array<{ type: SonicEntityType; quota: number }> {
  const shares: Record<SonicEntityType, number> = { track: 0.55, album: 0.2, mv: 0.15, playlist: 0.1 };
  const active = (['track', 'album', 'mv', 'playlist'] as SonicEntityType[]).filter((t) => allowedTypes.includes(t));
  const shareSum = active.reduce((s, t) => s + shares[t], 0) || 1;
  const raw = active.map((t) => ({ type: t, quota: (count * shares[t]) / shareSum }));
  // Largest-remainder rounding so quotas always sum exactly to `count`
  const floored = raw.map((r) => ({ ...r, base: Math.floor(r.quota), frac: r.quota - Math.floor(r.quota) }));
  let remaining = count - floored.reduce((s, r) => s + r.base, 0);
  floored.sort((a, b) => b.frac - a.frac);
  for (const r of floored) {
    if (remaining <= 0) break;
    r.base += 1;
    remaining -= 1;
  }
  return floored.map((r) => ({ type: r.type, quota: r.base }));
}

function buildEntityItem(
  cand: EntityCandidate,
  trackIds: string[],
): { item: MixedRecommendationItem; adjacencyKeys: Set<string> } {
  const { entity } = cand;
  const meta = (entity.meta || {}) as { trackCount?: number; releaseYear?: string; sourceTrackId?: string };
  const item: MixedRecommendationItem = {
    type: entity.entityType,
    id: entity.entityId,
    title: entity.title,
    subtitle: entity.subtitle || undefined,
    cover: entity.coverUrl || undefined,
    score: Math.round(cand.score * 1000) / 1000,
    reason: cand.signals[0]?.label || '为你挑选的热门内容',
    reasonCode: cand.reasonCode,
    scoreSource: cand.reasonCode === 'entity_popular' ? 'cold-start-curated' : 'personalized-interest',
    signals: cand.signals.slice(0, 3),
    entityId: entity.entityId,
    trackIds: trackIds.length > 0 ? trackIds : undefined,
    meta: {
      derived: entity.derived !== false,
      ...(meta.trackCount ? { trackCount: meta.trackCount } : {}),
      ...(meta.releaseYear ? { releaseYear: meta.releaseYear } : {}),
      ...(entity.entityType === 'mv' && meta.sourceTrackId ? { sourceTrackId: meta.sourceTrackId } : {}),
    },
  };
  return { item, adjacencyKeys: new Set(trackIds) };
}

function buildTrackItem(
  track: any,
  score: number,
  scoreSource: any,
  explanation: any,
): { item: MixedRecommendationItem; adjacencyKeys: Set<string> } {
  const rec: RecommendedTrack = canonicalToRecommendedTrack(track, score, scoreSource, explanation);
  const adjacencyKeys = new Set<string>();
  if (track.cleanAlbum) adjacencyKeys.add(computeAlbumEntityId(track.cleanAlbum, track.canonicalArtist));
  adjacencyKeys.add(computeMvEntityId(track.canonicalTrackId));
  const item: MixedRecommendationItem = {
    type: 'track',
    id: track.canonicalTrackId,
    title: track.title,
    subtitle: track.canonicalArtist,
    cover: track.coverUrl || undefined,
    score: Math.round(score * 1000) / 1000,
    reason: explanation.primaryReason,
    reasonCode: explanation.reasonCode,
    scoreSource,
    signals: explanation.signals.slice(0, 3),
    track: rec,
  };
  return { item, adjacencyKeys };
}

/**
 * Type-diverse MMR-style selection:
 *  - per-type quotas (track 55% / album 20% / mv 15% / playlist 10% by default)
 *  - same-type metadata redundancy + cross-type adjacency penalty (track vs its own album/MV)
 *  - final ordering by score with at most 2 consecutive items of the same type
 */
export function diversifyMixedList(
  trackCandidates: MixedCandidate[],
  entityCandidates: MixedCandidate[],
  count: number,
  allowedTypes: SonicEntityType[],
): MixedRecommendationItem[] {
  const byType = new Map<SonicEntityType, MixedCandidate[]>();
  for (const cand of trackCandidates) {
    const list = byType.get('track') || [];
    list.push(cand);
    byType.set('track', list);
  }
  for (const cand of entityCandidates) {
    const list = byType.get(cand.item.type) || [];
    list.push(cand);
    byType.set(cand.item.type, list);
  }
  for (const list of byType.values()) {
    list.sort((a, b) => b.item.score - a.item.score);
  }

  const quotas = quotaPlan(count, allowedTypes);
  const selected: MixedCandidate[] = [];

  // Pass 1: fill per-type quotas with redundancy guards within the same type
  for (const { type, quota } of quotas) {
    if (quota <= 0) continue;
    const pool = byType.get(type) || [];
    const artistCounts = new Map<string, number>();
    let picked = 0;
    for (const cand of pool) {
      if (picked >= quota) break;
      if (selected.includes(cand)) continue;
      const artistKey = compactNormalize(cand.item.subtitle || '');
      if (type !== 'playlist' && (artistCounts.get(artistKey) || 0) >= 2) continue;
      // Cross-type adjacency guard: never select a track whose own album/MV was already selected
      // (or vice versa) unless the quota cannot be met otherwise.
      if (cand.adjacencyKeys.size > 0 && selected.some((s) => cand.adjacencyKeys.has(s.item.id))) continue;
      selected.push(cand);
      artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
      picked += 1;
    }
    // Relax adjacency guard if quota unfilled
    if (picked < quota) {
      for (const cand of pool) {
        if (picked >= quota) break;
        if (selected.includes(cand)) continue;
        const artistKey = compactNormalize(cand.item.subtitle || '');
        if (type !== 'playlist' && (artistCounts.get(artistKey) || 0) >= 2) continue;
        selected.push(cand);
        artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
        picked += 1;
      }
    }
  }

  // Pass 2: fill remaining slots from the merged leftovers by score
  if (selected.length < count) {
    const leftovers = [...trackCandidates, ...entityCandidates]
      .filter((c) => !selected.includes(c) && allowedTypes.includes(c.item.type))
      .sort((a, b) => b.item.score - a.item.score);
    for (const cand of leftovers) {
      if (selected.length >= count) break;
      selected.push(cand);
    }
  }

  // Pass 3: order by score; enforce <=2 consecutive same type; avoid track adjacent to own album/MV
  const ordered: MixedCandidate[] = [];
  const pool = selected.filter((c) => allowedTypes.includes(c.item.type));
  pool.sort((a, b) => b.item.score - a.item.score);
  const consecutiveType = (type: SonicEntityType): number => {
    let n = 0;
    for (let i = ordered.length - 1; i >= 0 && ordered[i].item.type === type; i--) n += 1;
    return n;
  };
  while (ordered.length < pool.length) {
    const lastType = ordered.length > 0 ? ordered[ordered.length - 1].item.type : null;
    const run = lastType ? consecutiveType(lastType) : 0;
    const otherTypeAvailable =
      lastType !== null && run >= 2 && pool.some((c) => !ordered.includes(c) && c.item.type !== lastType);
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      if (ordered.includes(cand)) continue;
      // Hard constraint: never place a 3rd consecutive item of the same type while any other
      // type is still unselected (falls back to same-type only when nothing else remains).
      if (otherTypeAvailable && cand.item.type === lastType) continue;
      const adjacentConflict = ordered.some(
        (s) => s.adjacencyKeys.has(cand.item.id) || cand.adjacencyKeys.has(s.item.id),
      );
      const eff = cand.item.score - (adjacentConflict ? 0.05 : 0);
      if (eff > bestScore) {
        bestScore = eff;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    ordered.push(pool[bestIdx]);
  }

  return ordered.map((c) => c.item);
}

export function getMultiEntityRecommendations(
  identity: UserIdentityContext,
  options: MixedFeedOptions = {},
  env?: AppEnv,
): MixedFeedResult {
  const store = getRecommendStore(env);
  ensureCatalogSeeded(store, env);
  ensureMultiEntityCatalog(store, env);

  const count = Math.min(50, Math.max(1, options.count || 18));
  const nowMs = Date.now();
  const propCfg = getMultiEntityPropagationConfig(env);
  const profile = buildUserPreferenceProfile(identity, store, nowMs);
  const hasUserSignals =
    profile.hasPlayHistory || profile.hasSearchHistory || profile.likedTrackIds.size > 0;
  const entityStats =
    identity.personalizationEnabled && identity.subjectKey
      ? store.getEntityAffinityStats(identity.subjectKey, nowMs - 90 * DAY_MS)
      : [];

  const allowedTypes: SonicEntityType[] =
    Array.isArray(options.types) && options.types.length > 0
      ? (['track', 'album', 'playlist', 'mv'] as SonicEntityType[]).filter((t) => options.types!.includes(t))
      : ['track', 'album', 'playlist', 'mv'];
  const effectiveTypes = allowedTypes.length > 0 ? allowedTypes : (['track', 'album', 'playlist', 'mv'] as SonicEntityType[]);

  const excludeSet = new Set<string>(options.excludeIds || []);
  for (const recentId of profile.recentTrackIds.slice(0, 2)) excludeSet.add(recentId);

  // ── Entity recall ──
  const entityCands = new Map<string, EntityCandidate>();
  const pushEntity = (cand: EntityCandidate) => {
    if (!effectiveTypes.includes(cand.entity.entityType)) return;
    if (excludeSet.has(cand.entity.entityId)) return;
    const key = `${cand.entity.entityType}:${cand.entity.entityId}`;
    const prev = entityCands.get(key);
    if (!prev || cand.score > prev.score) entityCands.set(key, cand);
  };

  // (a) Direct entity feedback affinity (recency-decayed, dislike-penalized)
  for (const stat of entityStats) {
    if (stat.entityType === 'track') continue; // track-level signals are handled by the track recall
    const entity = store.getEntity(stat.entityType, stat.entityId);
    if (!entity) continue;
    if (stat.positiveWeight <= 0) continue; // negative-only entities are dropped entirely
    const decay = exponentialTimeDecay(Math.max(0, nowMs - stat.lastInteractionAt), 14 * DAY_MS);
    let score = Math.min(1, stat.positiveWeight / 6) * (0.55 + 0.45 * decay);
    if (stat.negativeWeight > 0) score *= 1 / (1 + 0.8 * stat.negativeWeight);
    const topAction = store.getUserEntityFeedback(identity.subjectKey!, 30, nowMs - 90 * DAY_MS).find(
      (fb) => fb.entityType === stat.entityType && fb.entityId === stat.entityId && fb.weight > 0,
    );
    const actionLabel = ENTITY_ACTION_LABELS[topAction?.action || ''] || '互动过的';
    pushEntity({
      entity,
      score,
      reasonCode: 'entity_affinity',
      signals: [
        {
          type: 'entity_affinity',
          label: `你${actionLabel}${ENTITY_TYPE_LABELS[stat.entityType]}《${entity.title}》`,
          weight: Math.round(score * 100) / 100,
        },
      ],
    });
  }

  // (b) Track -> entity propagation (played/liked tracks lift their albums, playlists, MVs)
  const anchorIds = Array.from(new Set([...profile.recentTrackIds.slice(0, 6), ...Array.from(profile.likedTrackIds).slice(0, 6)]));
  for (const anchorId of anchorIds) {
    const anchorTrack = store.getTrack(anchorId);
    if (!anchorTrack) continue;
    const affinity = profile.likedTrackIds.has(anchorId) ? 1.0 : 0.6;
    for (const rel of store.getEntityRelations('track', anchorId, { direction: 'out', limit: 14 })) {
      if (rel.toType === 'track') continue;
      const entity = store.getEntity(rel.toType, rel.toId);
      if (!entity) continue;
      const score = affinity * rel.weight * propCfg.trackToEntity;
      if (score <= 0.04) continue;
      pushEntity({
        entity,
        score,
        reasonCode: 'entity_propagation',
        signals: [
          {
            type: 'entity_propagation',
            label: `包含你常听的《${anchorTrack.title}》`,
            weight: Math.round(score * 100) / 100,
          },
        ],
      });
    }
  }

  // (c) Popularity cold fill: keeps the mixed feed populated for cold users and thin pools
  const popularEntities = store
    .listEntities(undefined, 220)
    .filter((e) => e.entityType !== 'track' && effectiveTypes.includes(e.entityType))
    .sort((a, b) => (b.externalPopularity || 0) - (a.externalPopularity || 0));
  for (const entity of popularEntities.slice(0, count * 2)) {
    const popNorm = Math.max(0, Math.min(1, (entity.externalPopularity || 0) / 100));
    pushEntity({
      entity,
      score: 0.12 + 0.3 * popNorm,
      reasonCode: 'entity_popular',
      signals: [
        {
          type: 'external_chart',
          label: `全站高口碑${ENTITY_TYPE_LABELS[entity.entityType]}`,
          weight: Math.round(popNorm * 100) / 100,
        },
      ],
    });
  }

  // ── Track recall with entity->track propagation boosts ──
  const trackBoosts = new Map<string, { boost: number; label: string }>();
  for (const cand of entityCands.values()) {
    if (cand.score <= 0.05) continue;
    const coef =
      cand.entity.entityType === 'album'
        ? propCfg.albumToTrack
        : cand.entity.entityType === 'playlist'
          ? propCfg.playlistToTrack
          : propCfg.mvToTrack;
    if (coef <= 0) continue;
    for (const rel of store.getEntityRelations(cand.entity.entityType, cand.entity.entityId, {
      direction: 'out',
      toType: 'track',
      limit: 25,
    })) {
      const boost = cand.score * rel.weight * coef;
      const prev = trackBoosts.get(rel.toId);
      if (!prev || boost > prev.boost) {
        trackBoosts.set(rel.toId, { boost, label: `收录于${ENTITY_TYPE_LABELS[cand.entity.entityType]}《${cand.entity.title}》` });
      }
    }
  }

  const allTracks = store.listTracks(1200);
  const recentEvents = store.getAllRecentEvents(nowMs - 30 * DAY_MS, 8000);
  const popMap = computeCatalogPopularity(allTracks, recentEvents, { window: '7d', nowMs });

  const combinedArtists = new Map<string, number>();
  for (const [ar, w] of Object.entries(profile.longTermArtists)) {
    combinedArtists.set(ar, (combinedArtists.get(ar) || 0) + w * 0.65);
  }
  for (const [ar, w] of Object.entries(profile.shortTermArtists)) {
    combinedArtists.set(ar, (combinedArtists.get(ar) || 0) + w * 0.85);
  }
  const maxArtistAffinity = Math.max(1, ...Array.from(combinedArtists.values()));
  const maxGenreAffinity = Math.max(1, ...Object.values(profile.genreAffinities));

  const trackCandidates: MixedCandidate[] = [];
  for (const track of allTracks) {
    if (!isPlayableTrack(track)) continue;
    if (profile.blockedTrackIds.has(track.canonicalTrackId)) continue;
    if (excludeSet.has(track.canonicalTrackId) || excludeSet.has(track.providerTrackId)) continue;
    if (track.edition === 'demo' || track.edition === 'cover') continue;

    const pop = popMap.get(track.canonicalTrackId);
    const signals: ExplanationSignal[] = [];

    let behaviorScore = 0;
    if (hasUserSignals) {
      const arAffinity = (combinedArtists.get(track.canonicalArtist) || 0) / maxArtistAffinity;
      if (arAffinity > 0.1) {
        behaviorScore += 0.52 * Math.min(1, arAffinity);
        signals.push({
          type: 'behavior_artist',
          label: `常听 ${track.canonicalArtist}`,
          weight: Math.round(0.52 * Math.min(1, arAffinity) * 100) / 100,
        });
      }
      let gMatch = 0;
      let matchedGenreName = '';
      for (const g of track.genres) {
        const gw = (profile.genreAffinities[g] || 0) / maxGenreAffinity;
        if (gw > gMatch) {
          gMatch = gw;
          matchedGenreName = g;
        }
      }
      if (gMatch > 0.1) {
        behaviorScore += 0.28 * Math.min(1, gMatch);
        signals.push({
          type: 'search_intent',
          label: `符合你偏好的 ${matchedGenreName.toUpperCase()} 风格`,
          weight: Math.round(0.28 * Math.min(1, gMatch) * 100) / 100,
        });
      }
      const penalty = profile.penalizedArtists[track.canonicalArtist] || 0;
      if (penalty > 0) behaviorScore -= Math.min(0.65, penalty * 0.22);
      behaviorScore = Math.max(-0.4, Math.min(1, behaviorScore));
    }

    const entityBoostInfo = trackBoosts.get(track.canonicalTrackId);
    const entityBoost = entityBoostInfo ? Math.min(0.4, entityBoostInfo.boost) : 0;
    if (entityBoostInfo && entityBoost > 0.03) {
      signals.push({
        type: 'entity_propagation',
        label: entityBoostInfo.label,
        weight: Math.round(entityBoost * 100) / 100,
      });
    }

    const internalPop = pop?.internalScore || 0;
    const conf = pop?.confidence || 0;
    const extPop = pop?.externalChartScore ?? track.externalPopularity / 100;
    const blendedPopularity = conf * internalPop + (1 - conf * 0.75) * extPop * 0.75;

    const alreadyPlayed = profile.recentTrackIds.includes(track.canonicalTrackId);
    const freshnessScore = alreadyPlayed ? 0.25 : 0.85;
    const contextScore = (track.streamType === 'trial' ? 0.45 : 1.0) * (track.edition === 'studio' ? 1.0 : 0.78);

    let finalScore: number;
    if (hasUserSignals) {
      finalScore =
        0.4 * Math.max(0, behaviorScore) +
        0.26 * blendedPopularity +
        0.14 * freshnessScore +
        0.1 * contextScore +
        entityBoost;
    } else {
      finalScore = 0.58 * blendedPopularity + 0.24 * freshnessScore + 0.18 * contextScore;
    }
    finalScore = Math.max(0, Math.min(1, finalScore));

    const arPenalty = profile.penalizedArtists[track.canonicalArtist] || 0;
    if (arPenalty > 0) finalScore *= 1 / (1 + 0.45 * arPenalty);

    const scoreSource = hasUserSignals
      ? entityBoost > 0.05
        ? ('hybrid-personalized' as const)
        : ('personalized-interest' as const)
      : (pop?.primarySource === 'cfsolara-internal' ? 'cfsolara-internal' : 'cold-start-curated');

    const primaryReason = entityBoostInfo && entityBoost > 0.05
      ? entityBoostInfo.label
      : signals[0]?.label || (hasUserSignals ? '根据你的听歌偏好推荐' : '全站高口碑热门佳作');

    trackCandidates.push(
      buildTrackItem(track, finalScore, scoreSource, {
        primaryReason,
        reasonCode: signals[0]?.type || (hasUserSignals ? 'personalized_interest' : 'cold_start_curated'),
        scoreSource,
        similarityBasis: 'metadata-only',
        signals,
        scoreBreakdown: {
          content: 0,
          behavior: Math.round(behaviorScore * 1000) / 1000,
          popularity: Math.round(blendedPopularity * 1000) / 1000,
          freshness: Math.round(freshnessScore * 1000) / 1000,
          context: Math.round(contextScore * 1000) / 1000,
          finalScore: Math.round(finalScore * 1000) / 1000,
        },
      }),
    );
  }

  // ── Entity items ──
  const entityItems: MixedCandidate[] = [];
  for (const cand of entityCands.values()) {
    const trackIds = store
      .getEntityRelations(cand.entity.entityType, cand.entity.entityId, { direction: 'out', toType: 'track', limit: 12 })
      .map((rel) => rel.toId);
    entityItems.push(buildEntityItem(cand, trackIds));
  }

  const items = diversifyMixedList(trackCandidates, entityItems, count, effectiveTypes);

  const distribution: MixedDistribution = { track: 0, album: 0, playlist: 0, mv: 0 };
  for (const item of items) distribution[item.type] += 1;

  const topEntities = entityStats
    .filter((s) => s.entityType !== 'track' && s.positiveWeight > 0)
    .sort((a, b) => b.positiveWeight - a.positiveWeight)
    .slice(0, 3)
    .map((s) => ({
      type: s.entityType,
      id: s.entityId,
      title: store.getEntity(s.entityType, s.entityId)?.title || s.entityId,
      weight: Math.round(s.positiveWeight * 100) / 100,
    }));

  return {
    feed: 'mixed',
    mode: options.mode || 'for-you',
    personalized: Boolean(identity.personalizationEnabled && (hasUserSignals || entityStats.length > 0)),
    privacyMode: identity.mode,
    storageKind: store.kind,
    items,
    distribution,
    profileSummary: {
      hasHistory: hasUserSignals || entityStats.length > 0,
      topArtists: Array.from(combinedArtists.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ar]) => ar),
      topGenres: Object.entries(profile.genreAffinities)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([g]) => g),
      topEntities,
    },
  };
}

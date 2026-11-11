// Sonic Intelligent Recommendation & Smart Search — Station Popularity, Time Decay, Bayesian Smoothing & Anti-Gaming
// Strictly separates:
//   (1) CFSolara internal real listening popularity (`internalScore`, `cfsolara-internal`)
//   (2) Third-party / upstream chart reference (`externalChartScore`, `external-chart`)
//   (3) Personalized predicted interest (computed separately in `engine.ts`)

import type {
  CanonicalTrack,
  ComputedPopularity,
  RecommendStore,
  StoredBehaviorEvent,
  TrendingWindow,
} from './types';
import { comparePopularityEventOrder, foldPreferenceSignals } from './event-state';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface PopularityComputeOptions {
  window?: TrendingWindow;
  nowMs?: number;
  confidencePriorK?: number; // Default k = 5 unique listeners
}

// Wilson score lower bound for binomial proportion (prevents 1/1 = 100% small-sample inflation)
export function wilsonLowerBound(positive: number, total: number, z = 1.645): number {
  if (total <= 0 || positive <= 0) return 0;
  const p = Math.min(1, positive / total);
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, Math.min(1, (center - margin) / denom));
}

export function exponentialTimeDecay(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  if (halfLifeMs <= 0) return 0;
  return Math.pow(2, -ageMs / halfLifeMs);
}

// Per-(user, track) logarithmic cap: 1 play -> 1.0, 10 plays -> 2.15, 100 plays -> 3.30
export function compressUserRepeatPlays(rawWeightedPlays: number): number {
  if (rawWeightedPlays <= 0) return 0;
  if (rawWeightedPlays <= 1) return rawWeightedPlays;
  return 1 + 0.5 * Math.log(rawWeightedPlays);
}

interface TrackTotals {
  effectivePlays: number;
  effective24h: number;
  effective7d: number;
  uniqueListeners: number;
  playStarts: number;
  playCompletes: number;
  favorites: number;
  dislikes: number;
}

interface ListenerTotals {
  decayedPlays: number;
  plays24h: number;
  plays7d: number;
  listened: boolean;
  state: 'favorite' | 'dislike' | null;
}

function windowCutoff(window: TrendingWindow, nowMs: number): number {
  switch (window) {
    case '24h': return nowMs - DAY_MS;
    case '7d':
    case 'surging': return nowMs - 7 * DAY_MS;
    case 'new': return nowMs - 14 * DAY_MS;
    default: return 0; // All retained events.
  }
}

export function computeStorePopularity(
  store: RecommendStore,
  tracks: CanonicalTrack[],
  options?: PopularityComputeOptions,
): Map<string, ComputedPopularity> {
  const window = options?.window ?? '7d';
  const nowMs = options?.nowMs ?? Date.now();
  // The 24h chart still uses the preceding six days to compute velocity.
  const sinceMs = Math.min(windowCutoff(window, nowMs), nowMs - 7 * DAY_MS);
  return scoreOrderedPopularity(
    tracks,
    store.iteratePopularityEvents(tracks.map((track) => track.canonicalTrackId), sinceMs, nowMs),
    { ...options, window, nowMs },
  );
}

export function computeCatalogPopularity(
  tracks: CanonicalTrack[],
  events: StoredBehaviorEvent[],
  options?: PopularityComputeOptions,
): Map<string, ComputedPopularity> {
  const trackIds = new Set(tracks.map((track) => track.canonicalTrackId));
  const ordered = foldPreferenceSignals(events.map((event) => ({
    ...event, entityType: 'track', entityId: event.canonicalTrackId || event.trackRef,
  }))).filter((event) => trackIds.has(event.canonicalTrackId || '')).sort(comparePopularityEventOrder);
  return scoreOrderedPopularity(tracks, ordered, options);
}

function scoreOrderedPopularity(
  tracks: CanonicalTrack[],
  events: Iterable<StoredBehaviorEvent>,
  options?: PopularityComputeOptions,
): Map<string, ComputedPopularity> {
  const window = options?.window ?? '7d';
  const nowMs = options?.nowMs ?? Date.now();
  const kPrior = options?.confidencePriorK ?? 5;
  const halfLifeMs = window === '24h' || window === 'surging' ? 12 * HOUR_MS
    : window === 'all' ? 30 * DAY_MS : 72 * HOUR_MS;
  const cutoff = windowCutoff(window, nowMs);
  const cutoff24h = nowMs - DAY_MS;
  const cutoff7d = nowMs - 7 * DAY_MS;

  const totalsByTrack = new Map<string, TrackTotals>();
  let trackId: string | undefined;
  let subjectKey: string | undefined;
  let totals: TrackTotals | undefined;
  let listener: ListenerTotals | undefined;
  const finishListener = () => {
    if (!totals || !listener) return;
    totals.effectivePlays += compressUserRepeatPlays(listener.decayedPlays);
    totals.effective24h += compressUserRepeatPlays(listener.plays24h);
    totals.effective7d += compressUserRepeatPlays(listener.plays7d);
    if (listener.listened) totals.uniqueListeners++;
    if (listener.state === 'favorite') totals.favorites++;
    if (listener.state === 'dislike') totals.dislikes++;
  };

  // SQLite supplies grouped rows through its partial index, so this keeps
  // only one account's running totals rather than materializing all events.
  for (const event of events) {
    if (!event.canonicalTrackId || !event.subjectKey || event.createdAt > nowMs) continue;
    if (event.canonicalTrackId !== trackId || event.subjectKey !== subjectKey) {
      finishListener();
      if (event.canonicalTrackId !== trackId) {
        trackId = event.canonicalTrackId;
        totals = {
          effectivePlays: 0, effective24h: 0, effective7d: 0, uniqueListeners: 0,
          playStarts: 0, playCompletes: 0, favorites: 0, dislikes: 0,
        };
        totalsByTrack.set(trackId, totals);
      }
      subjectKey = event.subjectKey;
      listener = { decayedPlays: 0, plays24h: 0, plays7d: 0, listened: false, state: null };
    }
    if (!totals || !listener) continue;

    const inWindow = event.createdAt >= cutoff;
    const ageMs = nowMs - event.createdAt;
    switch (event.type) {
      case 'play_start':
        if (inWindow) {
          totals.playStarts++;
          listener.decayedPlays += 0.25 * exponentialTimeDecay(ageMs, halfLifeMs);
        }
        break;
      case 'play_progress':
      case 'play_complete':
      case 'replay': {
        if (event.type === 'play_progress' && (event.progressRatio ?? 0.5) < 0.45) break;
        const weight = event.type === 'replay' ? 1.25 : event.type === 'play_complete' ? 1 : 0.55;
        if (inWindow) {
          if (event.type !== 'play_progress') totals.playCompletes++;
          listener.listened = true;
          listener.decayedPlays += weight * exponentialTimeDecay(ageMs, halfLifeMs);
        }
        if (event.createdAt >= cutoff24h) listener.plays24h += weight;
        if (event.createdAt >= cutoff7d) listener.plays7d += weight;
        break;
      }
      case 'favorite':
      case 'dislike':
        if (inWindow) listener.state = event.type;
        break;
      case 'unfavorite':
        if (inWindow && listener.state === 'favorite') listener.state = null;
        break;
      case 'undislike':
        if (inWindow && listener.state === 'dislike') listener.state = null;
        break;
    }
  }
  finishListener();

  const intermediate = new Map<string, {
    effectivePlays: number;
    uniqueListeners: number;
    completionRateSmoothed: number;
    favoriteRateSmoothed: number;
    velocityScore: number;
    netDislikes: number;
  }>();
  let maxEffectivePlays = 1;
  let maxUniqueListeners = 1;
  for (const [tid, track] of totalsByTrack) {
    const { effectivePlays, effective24h, effective7d, uniqueListeners } = track;
    const starts = Math.max(track.playStarts, track.playCompletes);
    const completionRateSmoothed = starts > 0 ? (track.playCompletes + 4 * 0.62) / (starts + 4) : 0.62;
    const listenerDenom = Math.max(uniqueListeners, track.favorites, 1);
    const wilsonFav = wilsonLowerBound(track.favorites, listenerDenom);
    const bayesFav = (track.favorites + 5 * 0.12) / (listenerDenom + 5);
    const favoriteRateSmoothed = uniqueListeners > 0 || track.favorites > 0 ? 0.6 * wilsonFav + 0.4 * bayesFav : 0;
    const prev6dDailyAvg = Math.max(0, effective7d - effective24h) / 6;
    const rawVelocityRatio = (effective24h + 1.2) / (prev6dDailyAvg + 1.2);
    const velocityScore = effective24h > 0
      ? Math.max(0, Math.min(1, 1 - Math.exp(-0.55 * Math.max(0, rawVelocityRatio - 0.85))))
      : 0;

    maxEffectivePlays = Math.max(maxEffectivePlays, effectivePlays);
    maxUniqueListeners = Math.max(maxUniqueListeners, uniqueListeners);
    intermediate.set(tid, { effectivePlays, uniqueListeners, completionRateSmoothed,
      favoriteRateSmoothed, velocityScore, netDislikes: track.dislikes });
  }

  // Second pass: assemble final ComputedPopularity for all requested tracks
  const out = new Map<string, ComputedPopularity>();
  const logMaxPlays = Math.log(1 + Math.max(2, maxEffectivePlays));
  const logMaxListeners = Math.log(1 + Math.max(2, maxUniqueListeners));

  for (const track of tracks) {
    const tid = track.canonicalTrackId;
    const st = intermediate.get(tid);
    const externalChartScore = Math.max(0, Math.min(1, (track.externalPopularity || 0) / 100));

    if (!st || (st.effectivePlays <= 0 && st.uniqueListeners === 0)) {
      out.set(tid, {
        canonicalTrackId: tid,
        internalScore: 0,
        externalChartScore,
        velocityScore: 0,
        completionRateSmoothed: 0,
        favoriteRateSmoothed: 0,
        confidence: 0,
        uniqueListeners: 0,
        effectivePlays: 0,
        primarySource: 'external-chart',
      });
      continue;
    }

    const playNorm = Math.min(1, Math.log(1 + st.effectivePlays) / logMaxPlays);
    const listenerNorm = Math.min(1, Math.log(1 + st.uniqueListeners) / logMaxListeners);
    // Favorite rate scaled to [0, 1] where >= 0.45 smoothed rate reaches ~1.0
    const favNorm = Math.min(1, st.favoriteRateSmoothed / 0.45);

    // Candidate weighted combination:
    //   35% recent effective plays + 25% unique listeners + 20% completion + 15% favorites + 5% velocity
    //   (For `surging` window, boost velocity weight to 40% to surface genuinely rising tracks)
    const rawWeighted =
      window === 'surging'
        ? 0.25 * playNorm +
          0.2 * listenerNorm +
          0.1 * st.completionRateSmoothed +
          0.05 * favNorm +
          0.4 * st.velocityScore
        : 0.35 * playNorm +
          0.25 * listenerNorm +
          0.2 * st.completionRateSmoothed +
          0.15 * favNorm +
          0.05 * st.velocityScore;

    // Low-sample Bayesian confidence shrinkage: U / (U + k)
    const confidence = st.uniqueListeners / (st.uniqueListeners + kPrior);

    // Anti-dislike dampening & anti-monopoly freshness modulation
    const dislikePenalty = 1 / (1 + 0.35 * st.netDislikes);
    const catalogAgeDays = Math.max(0, (nowMs - (track.firstSeenAt || nowMs)) / DAY_MS);
    const antiMonopolyFactor = window === 'new'
      ? Math.pow(2, -catalogAgeDays / 14)
      : 0.88 + 0.12 * Math.pow(2, -catalogAgeDays / 45);

    const internalScore = Math.max(
      0,
      Math.min(1, rawWeighted * (0.25 + 0.75 * confidence) * dislikePenalty * antiMonopolyFactor),
    );

    out.set(tid, {
      canonicalTrackId: tid,
      internalScore,
      externalChartScore,
      velocityScore: st.velocityScore,
      completionRateSmoothed: st.completionRateSmoothed,
      favoriteRateSmoothed: st.favoriteRateSmoothed,
      confidence,
      uniqueListeners: st.uniqueListeners,
      effectivePlays: st.effectivePlays,
      primarySource: st.uniqueListeners >= 1 && internalScore > 0.05 ? 'cfsolara-internal' : 'external-chart',
    });
  }

  return out;
}

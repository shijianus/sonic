// Sonic Intelligent Recommendation & Smart Search — Unified Type Contracts
// 100% Web Standard / Edge Isolate & Node.js 22 Isomorphic

import type { SonicSearchSource, SonicQualityOption, SonicSearchTrack } from '../types';

export type TrackEdition =
  | 'studio'
  | 'live'
  | 'remix'
  | 'cover'
  | 'instrumental'
  | 'acoustic'
  | 'demo';

export type InferredLanguage = 'zh' | 'yue' | 'en' | 'ja' | 'ko' | 'inst' | 'other' | 'unknown';

export type ScoreSourceKind =
  | 'cfsolara-internal'
  | 'external-chart'
  | 'personalized-interest'
  | 'content-similarity'
  | 'hybrid-personalized'
  | 'cold-start-curated';

export interface CanonicalTrack {
  canonicalTrackId: string; // Deterministic cross-platform ID: trk_<16hex>
  provider: string; // Best primary source platform ('netease' | 'qq' | 'kugou' | 'kuwo' | 'sonic')
  providerTrackId: string;
  title: string;
  cleanTitle: string;
  simpTitle: string;
  pinyinFull: string;
  pinyinInitials: string;
  artists: string[];
  primaryArtist: string;
  canonicalArtist: string; // Normalized alias-resolved primary artist
  album: string;
  cleanAlbum: string;
  duration: number; // Seconds
  edition: TrackEdition;
  language: InferredLanguage;
  genres: string[];
  tags: string[];
  releaseDate?: string;
  coverUrl: string;
  artistPic?: string;
  qualityBadge?: string;
  qualities?: SonicQualityOption[];
  streamType?: 'full' | 'trial' | 'unavailable';
  sourceIds: Record<string, string>; // { netease: "186016", qq: "003aAPGv1I6t8A", ... }
  availableSources: SonicSearchSource[];
  externalPopularity: number; // [0, 100] from upstream rank/chart — NEVER conflated with internal plays
  featureVersion: number;
  firstSeenAt: number; // Unix ms
  updatedAt: number; // Unix ms
}

export type SonicEntityType = 'track' | 'album' | 'playlist' | 'mv';

export type SonicEntityAction =
  | 'favorite'
  | 'unfavorite'
  | 'play_start'
  | 'play_progress'
  | 'play_complete'
  | 'replay'
  | 'skip'
  | 'dislike'
  | 'undislike'
  | 'open'
  | 'add_to_playlist'
  | 'watch_progress'
  | 'watch_complete';

export type SonicEventType =
  | 'search'
  | 'search_click'
  | 'play_start'
  | 'play_progress'
  | 'play_complete'
  | 'skip'
  | 'replay'
  | 'favorite'
  | 'unfavorite'
  | 'dislike'
  | 'undislike'
  | 'open'
  | 'add_to_playlist'
  | 'watch_progress'
  | 'watch_complete';

export interface SonicBehaviorEventInput {
  eventId?: string;
  type?: SonicEventType;
  action?: SonicEntityAction;
  entity_type?: SonicEntityType;
  entityType?: SonicEntityType;
  entity_id?: string;
  entityId?: string;
  timestamp?: number; // Unix ms
  track?: Partial<SonicSearchTrack> & {
    id?: string | number;
    canonicalTrackId?: string;
    title?: string;
    name?: string;
    artist?: string;
    album?: string;
    duration?: number;
    platform?: string;
    source?: string;
    cover?: string;
    coverUrl?: string;
    genres?: string[];
    streamType?: 'full' | 'trial' | 'unavailable';
    sources?: SonicSearchSource[];
  };
  query?: string;
  position?: number;
  playedSeconds?: number;
  durationSeconds?: number;
  progress?: number;
  progressRatio?: number;
  session_id?: string;
  sessionId?: string;
  context?: {
    from?: string;
    [key: string]: any;
  };
  reason?: string; // e.g., 'user_skip', 'network_stall', 'playback_error', 'trial_end'
}

export interface StoredBehaviorEvent {
  eventId: string;
  subjectKey: string; // 'usr:<hash>' or 'anon:<id>'
  type: SonicEventType;
  canonicalTrackId?: string;
  artistKey?: string;
  genres?: string[];
  language?: InferredLanguage;
  query?: string;
  weight: number;
  progressRatio?: number;
  createdAt: number;
}

export type PrivacyMode = 'authenticated' | 'anonymous-opt-in' | 'public';

export interface UserIdentityContext {
  mode: PrivacyMode;
  subjectKey: string | null; // null when mode === 'public' (zero tracking)
  personalizationEnabled: boolean;
  isAuthenticated: boolean;
  userId?: string;
  clientHints?: ClientContextHints;
}

export interface ClientContextHints {
  recentArtists?: string[];
  likedTrackIds?: string[];
  likedArtists?: string[];
  recentQueries?: string[];
  dislikedTrackIds?: string[];
  dislikedArtists?: string[];
}

export interface UserPreferenceProfile {
  subjectKey: string;
  totalEvents: number;
  hasPlayHistory: boolean;
  hasSearchHistory: boolean;
  longTermArtists: Record<string, number>;
  shortTermArtists: Record<string, number>;
  genreAffinities: Record<string, number>;
  languageAffinities: Record<string, number>;
  recentTrackIds: string[];
  likedTrackIds: Set<string>;
  blockedTrackIds: Set<string>;
  penalizedArtists: Record<string, number>;
  recentQueries: string[];
  updatedAt: number;
}

export type TrendingWindow = '24h' | '7d' | 'all' | 'surging' | 'new';

export interface TrackPopularityStats {
  canonicalTrackId: string;
  effectivePlays24h: number;
  effectivePlays7d: number;
  effectivePlaysAll: number;
  uniqueListeners24h: number;
  uniqueListeners7d: number;
  uniqueListenersAll: number;
  playStartsAll: number;
  playCompletesAll: number;
  favoritesAll: number;
  dislikesAll: number;
  lastPlayedAt: number;
}

export interface ComputedPopularity {
  canonicalTrackId: string;
  internalScore: number; // [0, 1] CFSolara real station listening score
  externalChartScore: number; // [0, 1] Third-party chart reference score
  velocityScore: number; // [0, 1] 24h vs 7d growth trend
  completionRateSmoothed: number;
  favoriteRateSmoothed: number;
  confidence: number; // [0, 1] Low-sample confidence factor U / (U + k)
  uniqueListeners: number;
  effectivePlays: number;
  primarySource: 'cfsolara-internal' | 'external-chart';
}

export interface ExplanationSignal {
  type:
    | 'behavior_artist'
    | 'behavior_favorite'
    | 'behavior_recent'
    | 'search_intent'
    | 'content_artist'
    | 'content_genre'
    | 'content_language'
    | 'cooccurrence'
    | 'station_popularity'
    | 'external_chart'
    | 'fresh_discovery'
    | 'collaborative_gorse';
  label: string;
  weight: number;
}

export interface RecommendationExplanation {
  primaryReason: string;
  reasonCode: string;
  scoreSource: ScoreSourceKind;
  similarityBasis?: 'metadata-and-cooccurrence' | 'metadata-only' | 'collaborative';
  signals: ExplanationSignal[];
  scoreBreakdown: {
    content: number;
    behavior: number;
    popularity: number;
    freshness: number;
    context: number;
    finalScore: number;
  };
}

export interface RecommendedTrack extends SonicSearchTrack {
  canonicalTrackId: string;
  edition: TrackEdition;
  language: InferredLanguage;
  genres: string[];
  recommendScore: number;
  scoreSource: ScoreSourceKind;
  explanation: RecommendationExplanation;
  popularity?: {
    internalScore: number;
    externalChartScore: number;
    uniqueListeners: number;
    effectivePlays: number;
    velocityScore: number;
    confidence: number;
  };
}

export interface ForYouOptions {
  mode?: 'for-you' | 'recent' | 'favorites' | 'next' | 'radio';
  count?: number;
  seedTrackId?: string;
  seedTitle?: string;
  seedArtist?: string;
  excludeIds?: string[];
  diversity?: number; // [0, 1], default 0.28 (i.e. MMR lambda = 0.72)
  temperature?: number; // [0.1, 1.5], default 0.35
}

export interface TrendingOptions {
  window?: TrendingWindow;
  genre?: string;
  count?: number;
  personalized?: boolean;
}

export interface SimilarOptions {
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  count?: number;
  includeSameArtist?: boolean;
}

export interface DiscoverOptions {
  genre?: string;
  language?: string;
  mood?: string;
  temperature?: number;
  count?: number;
}

export interface SmartSearchSuggestion {
  text: string;
  type: 'song' | 'artist' | 'query' | 'genre';
  subLabel?: string;
  score: number;
}

export interface SmartSearchResultData {
  query: string;
  normalizedQuery: string;
  expandedTerms: string[];
  page: number;
  count: number;
  total: number;
  personalizedApplied: boolean;
  tracks: Array<
    SonicSearchTrack & {
      canonicalTrackId?: string;
      edition?: TrackEdition;
      language?: InferredLanguage;
      genres?: string[];
      matchScore?: number;
      matchReasons?: string[];
    }
  >;
  suggestions?: SmartSearchSuggestion[];
  fallbackUsed?: boolean;
  fallbackQuery?: string;
  fallbackTracks?: SonicSearchTrack[];
}

export interface SonicEntity {
  id: string; // trk_<hash> | alb_<hash> | pl_<hash> | mv_<hash>
  type: SonicEntityType;
  title: string;
  subtitle?: string;
  artistId?: string;
  artistName?: string;
  coverUrl?: string;
  source: string; // 'netease' | 'qq' | 'sonic' | ...
  sourceId?: string;
  tags: string[];
  language?: InferredLanguage;
  duration?: number;
  externalPopularity: number; // 0..100
  createdAt: number;
  updatedAt: number;
  payload: Record<string, any>;
}

export type EntityRelationType = 'contains' | 'video_of' | 'associated';

export interface EntityRelation {
  relationId?: string;
  parentId: string;
  parentType: SonicEntityType;
  childId: string;
  childType: SonicEntityType;
  relationType: EntityRelationType;
  weight: number; // default 1.0
  position?: number;
  createdAt?: number;
}

export interface UserEntityFeedback {
  feedbackId: string;
  subjectKey: string;
  entityType: SonicEntityType;
  entityId: string;
  action: SonicEntityAction;
  weight: number;
  progress?: number;
  context?: Record<string, any>;
  createdAt: number;
}

export interface EntityStats {
  entityId: string;
  entityType: SonicEntityType;
  playCount: number;
  completeCount: number;
  favoriteCount: number;
  openCount: number;
  uniqueUsers: number;
  score: number;
  updatedAt: number;
}

export interface PropagationCoefficients {
  albumToTrack: number; // default 0.40
  playlistToTrack: number; // default 0.35
  trackToAlbum: number; // default 0.30
  trackToPlaylist: number; // default 0.25
  trackToMv: number; // default 0.35
  mvToTrack: number; // default 0.45
  mvToArtistMv: number; // default 0.25
  dislikePropagation: number; // default 0.15
}

export interface MixedFeedItem {
  type: SonicEntityType;
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  score: number;
  reason: string;
  payload: Record<string, any>;
}

export interface MixedFeedResponse {
  brand: 'Sonic';
  data: MixedFeedItem[];
  meta: {
    latency_ms: number;
    strategy: string;
    distribution?: Record<string, number>;
    personalized?: boolean;
    total?: number;
    [key: string]: any;
  };
}

export interface RecommendStore {
  readonly kind: 'sqlite' | 'memory';
  upsertTrack(track: CanonicalTrack): void;
  upsertTracks(tracks: CanonicalTrack[]): void;
  getTrack(idOrPlatformId: string): CanonicalTrack | null;
  findTrackByTitleArtist(cleanTitle: string, canonicalArtist: string, edition?: TrackEdition): CanonicalTrack | null;
  listTracks(limit?: number): CanonicalTrack[];
  searchLocalTracks(query: string, limit?: number): CanonicalTrack[];
  recordEvent(event: StoredBehaviorEvent): { inserted: boolean; deduplicated: boolean };
  getUserEvents(subjectKey: string, limit?: number, sinceMs?: number): StoredBehaviorEvent[];
  clearUserEvents(subjectKey: string): number;
  getAllRecentEvents(sinceMs: number, limit?: number): StoredBehaviorEvent[];
  incrementCooccurrence(trackA: string, trackB: string, delta: number): void;
  getCooccurringTracks(trackId: string, limit?: number): Array<{ canonicalTrackId: string; weight: number }>;
  recordSearchQuery(normQuery: string, displayQuery: string, clicked?: boolean): void;
  getTopSearchQueries(prefix: string, limit?: number): Array<{ query: string; count: number }>;
  getStats(): { trackCount: number; eventCount: number; cooccurrencePairs: number; storageKind: string };

  // Multi-entity extensions
  upsertEntity?(entity: SonicEntity): void;
  upsertEntities?(entities: SonicEntity[]): void;
  getEntity?(id: string): SonicEntity | null;
  listEntities?(type?: SonicEntityType, limit?: number): SonicEntity[];
  upsertEntityRelation?(rel: EntityRelation): void;
  upsertEntityRelations?(rels: EntityRelation[]): void;
  getEntityRelations?(entityId: string, direction?: 'children' | 'parents'): EntityRelation[];
  recordEntityFeedback?(feedback: UserEntityFeedback): { inserted: boolean; deduplicated: boolean };
  getUserEntityFeedbacks?(subjectKey: string, limit?: number, sinceMs?: number): UserEntityFeedback[];
  clearUserEntityFeedbacks?(subjectKey: string): number;
}

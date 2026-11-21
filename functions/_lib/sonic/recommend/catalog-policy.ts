import type { AppEnv } from '../../types';
import { evaluateContentFlags, getAllowedMediaDomains, normalizeSourceId } from '../licensing';
import type { CanonicalTrack, RecommendStore, SonicEntity } from './types';

// Stored catalog rows may outlive the operator's current set of approved sources.
export function readableCatalog(store: RecommendStore, env?: AppEnv) {
  const allowed = new Set(evaluateContentFlags(env).allowedSources);
  const coverDomains = getAllowedMediaDomains(env, 'cover');
  function cover(value?: string): string {
    if (!value) return '';
    try {
      const url = new URL(value, 'https://sonic.invalid');
      if (url.origin === 'https://sonic.invalid' && url.pathname === '/api/music/cover') {
        const source = url.searchParams.get('source');
        return (!source || allowed.has(normalizeSourceId(source))) ? value : '';
      }
      return url.protocol === 'https:' && coverDomains.some(domain =>
        url.hostname === domain || url.hostname.endsWith('.' + domain)) ? value : '';
    } catch { return ''; }
  }
  function track(item: CanonicalTrack | null): CanonicalTrack | null {
    if (!item) return null;
    const availableSources = (item.availableSources || []).filter(s => allowed.has(normalizeSourceId(s.platform)));
    const sourceIds = Object.fromEntries(Object.entries(item.sourceIds || {}).filter(([p]) => allowed.has(normalizeSourceId(p))));
    const mvSourceIds = Object.fromEntries(Object.entries(item.mvSourceIds || {}).filter(([p]) => allowed.has(normalizeSourceId(p))));
    const fallbackId = Object.keys(sourceIds)[0];
    const primary = allowed.has(normalizeSourceId(item.provider)) && item.providerTrackId
      ? { platform: item.provider, platformId: item.providerTrackId }
      : availableSources[0] || (fallbackId && { platform: fallbackId, platformId: sourceIds[fallbackId] });
    if (!primary) return null;
    const qualities = item.qualities?.filter(q => {
      try {
        const url = new URL(q.streamUrl, 'https://sonic.invalid');
        return url.origin === 'https://sonic.invalid' && url.pathname === '/api/music/stream' &&
          allowed.has(normalizeSourceId(url.searchParams.get('source') || 'netease'));
      } catch { return false; }
    });
    return { ...item, provider: primary.platform, providerTrackId: primary.platformId, availableSources, sourceIds,
      mvSourceIds, qualities,
      mediaMetadataVerified: primary.platform === item.provider && primary.platformId === item.providerTrackId && item.mediaMetadataVerified,
      qualityBadge: primary.platform === item.provider && primary.platformId === item.providerTrackId && item.mediaMetadataVerified ? item.qualityBadge : undefined,
      streamType: primary.platform === item.provider && primary.platformId === item.providerTrackId && (item.mediaMetadataVerified || item.streamType !== 'full')
        ? item.streamType : undefined,
      coverUrl: cover(item.coverUrl), artistPic: cover(item.artistPic) };
  }
  const tracks = (items: CanonicalTrack[]) => items.map(track).filter((item): item is CanonicalTrack => item !== null);
  const visibleById = new Map<string, CanonicalTrack | null>();
  function entities(items: SonicEntity[]): SonicEntity[] {
    return items.flatMap(item => {
      if (item.source !== 'sonic') return allowed.has(normalizeSourceId(item.source)) ? [{ ...item, coverUrl: cover(item.coverUrl) }] : [];
      // Older virtual albums/playlists do not record provenance. Rebuild their
      // public summary from linked, currently visible tracks.
      const relations = store.getEntityRelations?.(item.id, 'children') || [];
      const members: CanonicalTrack[] = [];
      for (const rel of relations) {
        if (rel.childType !== 'track') continue;
        if (!visibleById.has(rel.childId)) visibleById.set(rel.childId, track(store.getTrack(rel.childId)));
        const member = visibleById.get(rel.childId);
        if (member) members.push(member);
      }
      if (!members.length) return [];
      const first = members[0];
      return [{ ...item, coverUrl: first.coverUrl, duration: members.reduce((sum, t) => sum + t.duration, 0),
        subtitle: item.type === 'album' ? `${first.primaryArtist} · 专辑 · ${members.length} 首曲目` : undefined,
        payload: { ...item.payload, trackCount: members.length, tracksPreview: members.slice(0, 5).map(t => t.cleanTitle || t.title) } }];
    });
  }
  return { track, tracks, entities };
}

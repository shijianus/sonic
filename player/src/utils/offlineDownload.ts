import type { Song } from '@/stores/interface'
import { decodeEcs, encodeEcs, isEcsFile } from './ecs'
import type { ParsedAudioMeta } from './blobMetadataParser'
import i18n from '@/languages'
import { downloadSourcePair, type DownloadedSong } from './indexedDB'

export const ecsQualityTier = (level: string): 1 | 2 | 3 =>
  level === 'lossless' ? 1 : level === 'exhigh' ? 2 : 3

export async function playbackAudio(file: Blob): Promise<Blob> {
  return await isEcsFile(file) ? (await decodeEcs(file)).audio : file
}

export function offlineSong(item: DownloadedSong): Song {
  return {
    id: item.id, downloadKey: item.downloadKey, isLocal: true,
    source: item.source, platform: item.platform, platformId: item.platformId,
    resolvedSource: item.resolvedSource, resolvedPlatformId: item.resolvedPlatformId,
    name: item.name, artist: item.artist, album: item.album,
    duration: item.duration * 1000, cover: item.cover,
    actualAudioLabel: item.audioMeta?.displayTag,
    qualityBadge: item.ecsTier ? `ECS${item.ecsTier}` : item.qualityBadge,
  }
}

export async function inspectDownloadAudio(file: Blob) {
  const { parseBlob } = await import('music-metadata')
  const { format } = await parseBlob(file, { duration: true, skipCovers: true })
  const duration = format.duration && Number.isFinite(format.duration) ? format.duration : 0
  const measuredRate = format.bitrate || (duration ? file.size * 8 / duration : 0)
  const bitrate = Number.isFinite(measuredRate) && measuredRate > 0 ? Math.round(measuredRate / 1000) : undefined
  const codec = format.codec || format.container || ''
  const resolvedTier = format.lossless === true ? 'lossless' : bitrate && bitrate >= 300 ? 'exhigh' : 'standard'
  const displayTag = [codec, bitrate ? `${bitrate} kbps` : ''].filter(Boolean).join(' · ') || '—'
  const audioMeta: ParsedAudioMeta = {
    container: format.container, codec: format.codec, sampleRate: format.sampleRate, bitsPerSample: format.bitsPerSample,
    bitrate, resolvedTier, isLossless: format.lossless === true, displayTag,
    detailText: [format.sampleRate && `${format.sampleRate} Hz`, format.bitsPerSample && `${format.bitsPerSample} bit`].filter(Boolean).join(' · '),
    mismatchWarning: null,
  }
  return { duration, audioMeta }
}

export async function packDownload(
  item: Pick<DownloadedSong, 'id' | 'source' | 'platformId' | 'resolvedSource' | 'resolvedPlatformId' |
    'name' | 'artist' | 'album' | 'duration' | 'qualityLevel' | 'file'>,
  signal?: AbortSignal,
  requireFullDuration = false,
) {
  // A legacy numeric ID can identify a local record, but does not establish export rights.
  const namespacedId = /^[a-z][a-z0-9_-]*:.+/i.test(String(item.id)) ? item.id : ''
  const pair = downloadSourcePair({ ...item, id: namespacedId })
  if (!pair) throw new Error(i18n.global.t('download.unverifiedSource'))
  const { duration, audioMeta } = await inspectDownloadAudio(item.file)
  if (requireFullDuration && item.duration > 0 &&
      (!duration || Math.abs(duration - item.duration) > Math.max(4, item.duration * 0.06))) {
    throw new Error(i18n.global.t('download.incompleteAudio'))
  }
  const requested = ecsQualityTier(item.qualityLevel)
  const sourceTier = ecsQualityTier(audioMeta.resolvedTier)
  const tier = requested > sourceTier ? requested : sourceTier
  const file = await encodeEcs(item.file, {
    title: item.name, artist: item.artist, album: item.album, tier,
    source: pair.platform, trackId: pair.platformId,
  }, signal)
  return { file, tier, audioMeta, duration }
}

export interface EcsExportFile {
  file: Blob
  name: string
  artist: string
  ecsTier: 1 | 2 | 3
}

export async function ecsDownload(item: DownloadedSong | EcsExportFile): Promise<{ file: Blob; tier: 1 | 2 | 3 }> {
  if (await isEcsFile(item.file)) {
    const tier = item.ecsTier ?? (await decodeEcs(item.file)).meta.tier
    return { file: item.file, tier }
  }
  if (!('downloadKey' in item)) throw new Error('INVALID_ECS_FILE')
  return packDownload(item)
}

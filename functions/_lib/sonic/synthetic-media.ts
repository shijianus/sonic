// Sonic First-Party Authorized Synthetic Test Media (CC0 / Mathematical Sine-Wave PCM WAV)
// Used for Controlled Beta & Staging E2E verification (Search -> Resolve -> Range 206 -> Seek -> 416 -> Lyrics -> Cover)
// without touching any unapproved commercial audio/lyrics/cover copyright material.

import type { SonicSearchTrack } from './types';

export interface SyntheticTrackSpec {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  frequenciesHz: number[];
  genres: string[];
  lrc: string;
}

export const SYNTHETIC_SAMPLE_RATE = 8000;
export const SYNTHETIC_BITS_PER_SAMPLE = 16;
export const SYNTHETIC_CHANNELS = 1;
export const WAV_HEADER_BYTES = 44;

export const SYNTHETIC_TRACK_CATALOG: SyntheticTrackSpec[] = [
  {
    id: 'syn-440hz',
    title: 'Sonic 基准测试音 A4 (440Hz)',
    artist: 'Sonic Acoustic Lab',
    album: 'Sonic Controlled Beta Test Suite',
    durationSec: 12,
    frequenciesHz: [440],
    genres: ['instrumental', 'electronic'],
    lrc: [
      '[00:00.00]Sonic 受控内测基准音频 (440Hz 纯正弦波)',
      '[00:03.00]用于验证 Cloudflare 边缘网关 HTTP 206 分段传输',
      '[00:06.00]用于验证拖动进度条 Seek 字节连续性与无损拼接',
      '[00:09.00]零第三方版权依赖 · Sonic First-Party CC0 Test Media',
    ].join('\n'),
  },
  {
    id: 'syn-528hz',
    title: 'Sonic 基准测试音 C5 (528Hz)',
    artist: 'Sonic Acoustic Lab',
    album: 'Sonic Controlled Beta Test Suite',
    durationSec: 10,
    frequenciesHz: [528],
    genres: ['instrumental', 'electronic'],
    lrc: [
      '[00:00.00]Sonic 受控内测双曲切歌竞态验证音轨 (528Hz)',
      '[00:04.00]验证快速切歌与跨源回退不串流、不泄漏连接',
      '[00:07.50]Sonic Edge & Linux Engine 端到端联调通过',
    ].join('\n'),
  },
  {
    id: 'syn-chord',
    title: 'Sonic 和弦连续性测试曲 (A-Major)',
    artist: 'Sonic Acoustic Lab',
    album: 'Sonic Controlled Beta Test Suite',
    durationSec: 15,
    frequenciesHz: [440, 554.37, 659.25],
    genres: ['instrumental', 'classical'],
    lrc: [
      '[00:00.00]Sonic A 大调三和弦合成测试音轨',
      '[00:05.00]支持 HTTP 200 全量、206 Range 切片与 416 越界校验',
      '[00:10.00]数学确定性 PCM 采样，任意字节偏移可逐字节核验',
    ].join('\n'),
  },
];

export function getSyntheticTrackSpec(id?: string): SyntheticTrackSpec | null {
  const clean = (id || '').replace(/^synthetic:/i, '').trim().toLowerCase();
  if (!clean) return SYNTHETIC_TRACK_CATALOG[0];
  return SYNTHETIC_TRACK_CATALOG.find((t) => t.id === clean) || null;
}

export function getSyntheticWavTotalBytes(spec: SyntheticTrackSpec): number {
  const totalSamples = spec.durationSec * SYNTHETIC_SAMPLE_RATE;
  return WAV_HEADER_BYTES + totalSamples * SYNTHETIC_CHANNELS * (SYNTHETIC_BITS_PER_SAMPLE / 8);
}

function buildWavHeader(dataBytes: number): Uint8Array {
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(buf);
  const byteRate = SYNTHETIC_SAMPLE_RATE * SYNTHETIC_CHANNELS * (SYNTHETIC_BITS_PER_SAMPLE / 8);
  const blockAlign = SYNTHETIC_CHANNELS * (SYNTHETIC_BITS_PER_SAMPLE / 8);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, SYNTHETIC_CHANNELS, true);
  view.setUint32(24, SYNTHETIC_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, SYNTHETIC_BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

function computePcmSampleInt16(sampleIndex: number, totalSamples: number, freqs: number[]): number {
  const t = sampleIndex / SYNTHETIC_SAMPLE_RATE;
  // Gentle 25ms fade-in/out envelope to avoid click artifacts while keeping interior samples pure
  const fadeSamples = Math.min(200, Math.floor(totalSamples / 10));
  let env = 1.0;
  if (sampleIndex < fadeSamples) env = sampleIndex / fadeSamples;
  else if (sampleIndex > totalSamples - fadeSamples) env = (totalSamples - sampleIndex) / fadeSamples;

  let sum = 0;
  for (let i = 0; i < freqs.length; i++) {
    sum += Math.sin(2 * Math.PI * freqs[i] * t);
  }
  const normalized = (sum / Math.max(1, freqs.length)) * 0.45 * env;
  return Math.max(-32768, Math.min(32767, Math.round(normalized * 32767)));
}

/**
 * Generates an exact byte slice [startByte, endByte] (inclusive) of the deterministic WAV file.
 * Byte-for-byte identical whether read via full 200 or arbitrary HTTP Range 206 chunks.
 */
export function generateSyntheticWavRange(
  spec: SyntheticTrackSpec,
  startByte: number,
  endByte: number,
): Uint8Array {
  const totalSamples = spec.durationSec * SYNTHETIC_SAMPLE_RATE;
  const dataBytes = totalSamples * 2;
  const totalBytes = WAV_HEADER_BYTES + dataBytes;

  const s = Math.max(0, Math.min(totalBytes - 1, Math.floor(startByte)));
  const e = Math.max(s, Math.min(totalBytes - 1, Math.floor(endByte)));
  const length = e - s + 1;
  const out = new Uint8Array(length);
  const header = buildWavHeader(dataBytes);

  for (let idx = 0; idx < length; idx++) {
    const pos = s + idx;
    if (pos < WAV_HEADER_BYTES) {
      out[idx] = header[pos];
    } else {
      const pcmOffset = pos - WAV_HEADER_BYTES;
      const sampleIndex = Math.floor(pcmOffset / 2);
      const sample = computePcmSampleInt16(sampleIndex, totalSamples, spec.frequenciesHz);
      const unsigned = sample < 0 ? sample + 65536 : sample;
      out[idx] = (pcmOffset & 1) === 0 ? unsigned & 0xff : (unsigned >>> 8) & 0xff;
    }
  }
  return out;
}

export function parseHttpByteRange(
  rangeHeader: string | null,
  totalBytes: number,
):
  | { kind: 'none' }
  | { kind: 'valid'; start: number; end: number }
  | { kind: 'unsatisfiable' } {
  if (!rangeHeader || !rangeHeader.trim()) return { kind: 'none' };
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) return { kind: 'none' };
  const spec = trimmed.slice(6).trim();
  // Multi-part ranges are rejected cleanly as 416 or unsupported single-range check
  if (spec.includes(',')) return { kind: 'unsatisfiable' };

  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) return { kind: 'unsatisfiable' };
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return { kind: 'unsatisfiable' };

  if (!startStr) {
    // Suffix byte-range-spec: bytes=-N
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, totalBytes - suffixLen);
    return { kind: 'valid', start, end: totalBytes - 1 };
  }

  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalBytes) {
    return { kind: 'unsatisfiable' };
  }
  if (!endStr) {
    return { kind: 'valid', start, end: totalBytes - 1 };
  }
  const rawEnd = parseInt(endStr, 10);
  if (!Number.isFinite(rawEnd) || rawEnd < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'valid', start, end: Math.min(totalBytes - 1, rawEnd) };
}

export function searchSyntheticCatalog(query: string, count = 20): SonicSearchTrack[] {
  const q = (query || '').toLowerCase().trim();
  const matched = SYNTHETIC_TRACK_CATALOG.filter((item) => {
    if (!q || q === 'sonic' || q === 'test' || q === '测试') return true;
    return (
      item.id.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.artist.toLowerCase().includes(q) ||
      item.album.toLowerCase().includes(q) ||
      item.genres.some((g) => g.toLowerCase().includes(q))
    );
  });
  const list = matched.length > 0 ? matched : q.length <= 2 ? SYNTHETIC_TRACK_CATALOG : [];
  return list.slice(0, count).map((spec) => ({
    id: spec.id,
    title: spec.title,
    name: spec.title,
    artist: spec.artist,
    album: spec.album,
    duration: spec.durationSec,
    cover: `/api/music/cover?id=${encodeURIComponent(spec.id)}&source=synthetic`,
    coverUrl: `/api/music/cover?id=${encodeURIComponent(spec.id)}&source=synthetic`,
    platform: 'synthetic',
    platformId: spec.id,
    streamUrl: `/api/music/stream?id=${encodeURIComponent(spec.id)}&source=synthetic`,
    sources: [{ platform: 'synthetic', platformId: spec.id, duration: spec.durationSec }],
    picId: spec.id,
    lyricId: spec.id,
    urlId: spec.id,
    source: 'synthetic',
    qualityBadge: 'SQ',
  }));
}

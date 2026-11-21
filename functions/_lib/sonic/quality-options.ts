import type { SonicQualityOption } from './types';

const targets = {
  lossless: { label: '请求无损', br: 'lossless' },
  exhigh: { label: '请求高音质', br: '320' },
  standard: { label: '请求标准音质', br: '128' },
} as const;

// A selectable stream URL states what to request. Only media metadata can
// establish the codec, bit depth or bitrate of the response.
export function requestOption(level: SonicQualityOption['level'], streamUrl?: string): SonicQualityOption {
  return { level, label: targets[level].label, bitrate: '', streamUrl };
}

export function requestOptions(provider: string, query: string): SonicQualityOption[] {
  const levels: SonicQualityOption['level'][] = ['exhigh', 'standard'];
  if (['netease', 'qq', 'kugou'].includes(provider)) levels.unshift('lossless');
  return levels.map(level => requestOption(level, `/api/music/stream?${query}&br=${targets[level].br}`));
}

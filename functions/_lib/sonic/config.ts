// Sonic Gateway — Configuration & Environment Parser
// Prefix: SONIC_

import type { AppEnv } from '../types';

export const SONIC_UA = 'Sonic/2.2.0 (Sonic-Gateway; CF Pages Functions)';

export interface SonicConfig {
  runtime: 'cf-pages' | 'linux-engine';
  localEngineUrl?: string;
  engineSecret?: string;
  ncmApiUrl?: string;
  realIp: string;
  upstreamLyriva: string;
  upstreamGdstudio: string;
  upstreamAmll: string;
  upstreamLrclib: string;
  upstreamMeting?: string;
  enableLocalEngine: boolean;
  enableUnblock: boolean;
  enableFreeCrossMatch: boolean;
  enableLyriva: boolean;
  enableNetease: boolean;
  enableQq: boolean;
  enableKugou: boolean;
  enableKuwo: boolean;
  enableAmll: boolean;
  enableLrclib: boolean;
  enableGdstudio: boolean;
  enableApple: boolean;
  enableYtmusic: boolean;
  timeoutMs: number;
  engineTimeoutMs: number;
  crossMatchDurationToleranceSec: number;
  crossMatchArtistSimilarity: number;
  crossMatchMaxConcurrency: number;
  crossMatchBudgetMs: number;
}

export function isEnvEnabled(val: unknown, defaultValue = true): boolean {
  if (val === undefined || val === null || val === '') return defaultValue;
  const str = String(val).trim().toLowerCase();
  return str === '1' || str === 'true' || str === 'yes' || str === 'on';
}

// Accepts the pre-2.2 name for cross-source matching while the canonical name is deployed
// everywhere. The canonical value wins whenever it is non-empty.
function envWithLegacyAlias(primary: unknown, legacy: unknown): unknown {
  const hasValue = primary !== undefined && primary !== null && String(primary).trim() !== '';
  return hasValue ? primary : legacy;
}

function normalizeUpstream(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return fallback;
    if (parsed.protocol !== 'https:') return fallback;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function normalizeServiceUrl(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return undefined;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function isPlainHttpLocalhost(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function getSonicConfig(env?: AppEnv): SonicConfig {
  const e = (env || {}) as Record<string, any>;
  const runtime = e.SONIC_RUNTIME === 'linux-engine' ? 'linux-engine' : 'cf-pages';
  const rawLocalEngineUrl = normalizeServiceUrl(e.SONIC_LOCAL_ENGINE_URL);
  // The service key must never travel over cleartext to a remote engine.
  const localEngineUrl =
    rawLocalEngineUrl &&
    (rawLocalEngineUrl.startsWith('https:') || isPlainHttpLocalhost(rawLocalEngineUrl))
      ? rawLocalEngineUrl
      : undefined;
  const ncmApiUrl = normalizeServiceUrl(e.SONIC_NCM_API_URL);

  return {
    runtime,
    localEngineUrl,
    engineSecret: e.SONIC_ENGINE_SECRET ? String(e.SONIC_ENGINE_SECRET) : undefined,
    ncmApiUrl,
    realIp: e.SONIC_REAL_IP ? String(e.SONIC_REAL_IP).trim() : '203.0.113.10',
    upstreamLyriva: normalizeUpstream(e.SONIC_UPSTREAM_LYRIVA, 'https://api.lyriva.xyz'),
    upstreamGdstudio: normalizeUpstream(
      e.SONIC_UPSTREAM_GDSTUDIO || e.MUSIC_API_BASE,
      'https://music-api.gdstudio.xyz/api.php',
    ),
    upstreamAmll: normalizeUpstream(e.SONIC_UPSTREAM_AMLL, 'https://api.amll.dev'),
    upstreamLrclib: normalizeUpstream(e.SONIC_UPSTREAM_LRCLIB, 'https://lrclib.net'),
    upstreamMeting: normalizeServiceUrl(e.SONIC_UPSTREAM_METING),
    enableLocalEngine: Boolean(localEngineUrl && runtime !== 'linux-engine' && isEnvEnabled(e.SONIC_ENABLE_LOCAL_ENGINE, true)),
    // Per compliance & architecture requirements: VIP unblock & third-party free aggregation APIs are OFF by default
    enableUnblock: isEnvEnabled(e.SONIC_ENABLE_UNBLOCK, false),
    enableFreeCrossMatch: isEnvEnabled(
      envWithLegacyAlias(e.SONIC_ENABLE_FREE_CROSS_MATCH, e.SONIC_ENABLE_FREE_MATCH),
      true,
    ),
    enableLyriva: isEnvEnabled(e.SONIC_ENABLE_LYRIVA, false),
    enableNetease: isEnvEnabled(e.SONIC_ENABLE_NETEASE, true),
    enableQq: isEnvEnabled(e.SONIC_ENABLE_QQ, true),
    enableKugou: isEnvEnabled(e.SONIC_ENABLE_KUGOU, true),
    enableKuwo: isEnvEnabled(e.SONIC_ENABLE_KUWO, true),
    enableAmll: isEnvEnabled(e.SONIC_ENABLE_AMLL, true),
    enableLrclib: isEnvEnabled(e.SONIC_ENABLE_LRCLIB, true),
    enableGdstudio: isEnvEnabled(e.SONIC_ENABLE_GDSTUDIO, false),
    enableApple: isEnvEnabled(e.SONIC_ENABLE_APPLE, false),
    enableYtmusic: isEnvEnabled(e.SONIC_ENABLE_YTMUSIC, false),
    timeoutMs: Math.min(60_000, Math.max(500, parseInt(String(e.SONIC_TIMEOUT_MS || '8000'), 10) || 8000)),
    engineTimeoutMs: Math.min(
      30_000,
      Math.max(100, parseInt(String(e.SONIC_ENGINE_TIMEOUT_MS || '4500'), 10) || 4500),
    ),
    crossMatchDurationToleranceSec: Math.max(1, parseInt(String(e.SONIC_CROSS_DURATION_TOLERANCE_SEC || '6'), 10) || 6),
    crossMatchArtistSimilarity: Math.max(0.5, Math.min(1.0, parseFloat(String(e.SONIC_CROSS_ARTIST_SIMILARITY || '0.85')) || 0.85)),
    crossMatchMaxConcurrency: Math.max(1, parseInt(String(e.SONIC_CROSS_CONCURRENCY || '2'), 10) || 2),
    crossMatchBudgetMs: Math.max(500, parseInt(String(e.SONIC_CROSS_BUDGET_MS || '3000'), 10) || 3000),
  };
}

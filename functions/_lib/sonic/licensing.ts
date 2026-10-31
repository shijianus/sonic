// Sonic Gateway — Content Source Licensing Registry & Auditable Allowlist Policy (SONIC-P0-07)
// Enforces legal & compliance boundaries across audio streams, lyrics, covers, and catalog feeds.
// Legal status transitions to APPROVED require explicit sign-off by the Project / Licensing Owner;
// AI and runtime code must never treat third-party Terms of Service as implicit authorization.

import type { AppEnv } from '../types';

export type ContentAuthorizationStatus =
  | 'APPROVED'              // 已确认可使用
  | 'CONDITIONAL'           // 仅在指定条件下可使用
  | 'PENDING_CONFIRMATION'  // 待确认
  | 'PROHIBITED';           // 禁止使用

export type ContentCapability = 'audio' | 'lyrics' | 'cover' | 'catalog';

export interface ContentSourcePolicyEntry {
  id: string;
  displayName: string;
  capabilities: ContentCapability[];
  authorizationStatus: ContentAuthorizationStatus;
  statusLabelZh: string;
  defaultEnabledInStandardMode: boolean;
  allowedDomains: string[];
  envSwitch: string;
  conditionsOrBlockers: string;
}

export const CONTENT_SOURCE_LICENSING_REGISTRY: Record<string, ContentSourcePolicyEntry> = {
  synthetic: {
    id: 'synthetic',
    displayName: 'Sonic First-Party Synthetic PCM/WAV Test Media',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'APPROVED',
    statusLabelZh: '已确认可使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_SYNTHETIC_TEST_SOURCE',
    conditionsOrBlockers:
      'Sonic 自研纯数学正弦波 PCM/WAV 实时生成音频、内联 SVG 封面与原创测试 LRC 歌词，零第三方版权材料，专用于受控内测与 Staging 全链路验证。',
  },
  netease: {
    id: 'netease',
    displayName: 'NetEase Cloud Music (music.163.com / 126.net)',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['music.126.net', '163.com', 'music.163.com'],
    envSwitch: 'SONIC_ENABLE_NETEASE',
    conditionsOrBlockers:
      '商业音乐平台音源/歌词/封面/榜单；缺少项目负责人书面确认的商业 API 或内容授权协议，受控内测 strict-allowlist 模式下默认禁用。',
  },
  qq: {
    id: 'qq',
    displayName: 'QQ Music (y.qq.com / gtimg.cn / qpic.cn)',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['qq.com', 'y.qq.com', 'gtimg.cn', 'qpic.cn'],
    envSwitch: 'SONIC_ENABLE_QQ',
    conditionsOrBlockers:
      '商业音乐平台音源/QRC 歌词/专辑与歌手封面；缺少项目负责人书面确认的授权依据，受控内测 strict-allowlist 模式下默认禁用。',
  },
  kugou: {
    id: 'kugou',
    displayName: 'Kugou Music (kugou.com)',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['kugou.com'],
    envSwitch: 'SONIC_ENABLE_KUGOU',
    conditionsOrBlockers:
      '商业音乐平台音源/KRC 逐字歌词/封面；缺少项目负责人书面确认的授权依据，受控内测 strict-allowlist 模式下默认禁用。',
  },
  kuwo: {
    id: 'kuwo',
    displayName: 'Kuwo Music (kuwo.cn)',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['kuwo.cn'],
    envSwitch: 'SONIC_ENABLE_KUWO',
    conditionsOrBlockers:
      '商业音乐平台音源/歌词/封面；缺少项目负责人书面确认的授权依据，受控内测 strict-allowlist 模式下默认禁用。',
  },
  amll: {
    id: 'amll',
    displayName: 'AMLL TTML Database (api.amll.dev)',
    capabilities: ['lyrics'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['amll.dev'],
    envSwitch: 'SONIC_ENABLE_AMLL',
    conditionsOrBlockers:
      '社区贡献 TTML 逐字歌词库；歌词文本本身受词曲著作权保护，需项目负责人确认内测/生产使用边界后方可对外部开放。',
  },
  lrclib: {
    id: 'lrclib',
    displayName: 'LRCLIB Community Lyrics (lrclib.net)',
    capabilities: ['lyrics'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: ['lrclib.net'],
    envSwitch: 'SONIC_ENABLE_LRCLIB',
    conditionsOrBlockers:
      '社区公开 LRC 接口；虽无鉴权门槛，但歌词著作权与公开分发合规性需项目负责人确认，strict-allowlist 模式下默认禁用。',
  },
  musixmatch: {
    id: 'musixmatch',
    displayName: 'Musixmatch Desktop Rich-Sync Lyrics (apic-desktop.musixmatch.com)',
    capabilities: ['lyrics'],
    authorizationStatus: 'PENDING_CONFIRMATION',
    statusLabelZh: '待确认',
    defaultEnabledInStandardMode: true,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_LRCLIB',
    conditionsOrBlockers:
      '第三方桌面端歌词接口，缺少正式商业 API 授权协议；strict-allowlist 模式下默认禁用。',
  },
  apple: {
    id: 'apple',
    displayName: 'Apple Music Official Catalog / Lyrics API',
    capabilities: ['lyrics', 'catalog'],
    authorizationStatus: 'CONDITIONAL',
    statusLabelZh: '仅在指定条件下可使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_APPLE',
    conditionsOrBlockers:
      '仅在配置合法 Apple Developer MusicKit Token (SONIC_APPLE_MUSIC_TOKEN) 且经项目负责人确认符合 Apple Music API 服务条款时可启用；默认关闭。',
  },
  ytmusic: {
    id: 'ytmusic',
    displayName: 'YouTube Data API v3',
    capabilities: ['catalog'],
    authorizationStatus: 'CONDITIONAL',
    statusLabelZh: '仅在指定条件下可使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_YTMUSIC',
    conditionsOrBlockers:
      '仅在配置合法 Google Cloud YouTube Data API Key (SONIC_YOUTUBE_API_KEY) 且遵守配额与展示条款时可启用；默认关闭。',
  },
  listenbrainz: {
    id: 'listenbrainz',
    displayName: 'ListenBrainz Public Artist Similarity API',
    capabilities: ['catalog'],
    authorizationStatus: 'CONDITIONAL',
    statusLabelZh: '仅在指定条件下可使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_LISTENBRAINZ',
    conditionsOrBlockers:
      'MetaBrainz 开放元数据接口；需遵守 <= 1 req/s 限速与署名/非商业或商业许可条款，默认关闭 (SONIC_ENABLE_LISTENBRAINZ=0)。',
  },
  gdstudio: {
    id: 'gdstudio',
    displayName: 'GDStudio External Music Source (music-api.gdstudio.xyz)',
    capabilities: ['audio', 'lyrics', 'cover', 'catalog'],
    authorizationStatus: 'APPROVED',
    statusLabelZh: '已确认可使用（外部源回退支持）',
    defaultEnabledInStandardMode: true,
    allowedDomains: [
      'gdstudio.xyz',
      'music-api.gdstudio.xyz',
      'music.126.net',
      '126.net',
      '163.com',
      'music.163.com',
      'qq.com',
      'y.qq.com',
      'gtimg.cn',
      'qpic.cn',
      'kugou.com',
      'kuwo.cn',
    ],
    envSwitch: 'SONIC_ENABLE_GDSTUDIO',
    conditionsOrBlockers:
      '外部聚合音源接口，用于本地 VPS 爬虫离线或边缘独立部署时的全量音频、歌词、封面与检索回退。',
  },
  lyriva: {
    id: 'lyriva',
    displayName: 'Lyriva Third-Party Lyrics Aggregator (api.lyriva.xyz)',
    capabilities: ['lyrics'],
    authorizationStatus: 'PROHIBITED',
    statusLabelZh: '禁止使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: ['lyriva.xyz'],
    envSwitch: 'SONIC_ENABLE_LYRIVA',
    conditionsOrBlockers:
      '未经授权的第三方歌词聚合接口；默认关闭，且在 strict-allowlist 模式下强制锁定禁用。',
  },
  unblock: {
    id: 'unblock',
    displayName: 'VIP / Grey-Market Audio Unblock (ENABLE_UNBLOCK)',
    capabilities: ['audio'],
    authorizationStatus: 'PROHIBITED',
    statusLabelZh: '禁止使用',
    defaultEnabledInStandardMode: false,
    allowedDomains: [],
    envSwitch: 'SONIC_ENABLE_UNBLOCK',
    conditionsOrBlockers:
      '涉及绕过付费/VIP 权限或灰产音源替换，严禁在任何内测、Staging 或生产环境启用。',
  },
};

export type ContentPolicyMode = 'default' | 'strict-allowlist';

function parseBoolFlag(val: unknown, fallback: boolean): boolean {
  if (val === undefined || val === null || val === '') return fallback;
  const s = String(val).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function normalizeSourceId(raw: string): string {
  const s = (raw || '').toLowerCase().trim();
  if (s === 'ncm') return 'netease';
  if (s === 'tencent') return 'qq';
  if (s === 'joox') return 'gdstudio';
  if (s === 'syn' || s === 'test') return 'synthetic';
  return s;
}

export function getContentPolicyMode(env?: AppEnv): ContentPolicyMode {
  const raw = String(env?.SONIC_CONTENT_POLICY || '').trim().toLowerCase();
  if (raw === 'strict' || raw === 'strict-allowlist' || raw === 'allowlist' || raw === 'controlled-beta') {
    return 'strict-allowlist';
  }
  return 'default';
}

export function getExplicitAllowedSources(env?: AppEnv): Set<string> {
  const raw = String(env?.SONIC_ALLOWED_SOURCES || '').trim();
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const norm = normalizeSourceId(part);
    if (norm) out.add(norm);
  }
  return out;
}

export interface EffectiveContentFlags {
  policyMode: ContentPolicyMode;
  enableSynthetic: boolean;
  enableNetease: boolean;
  enableQq: boolean;
  enableKugou: boolean;
  enableKuwo: boolean;
  enableAmll: boolean;
  enableLrclib: boolean;
  enableApple: boolean;
  enableYtmusic: boolean;
  enableListenbrainz: boolean;
  enableGdstudio: boolean;
  enableLyriva: boolean;
  enableUnblock: boolean;
  allowedSources: string[];
}

export function evaluateContentFlags(env?: AppEnv): EffectiveContentFlags {
  const e = (env || {}) as Record<string, any>;
  const policyMode = getContentPolicyMode(env);
  const allowSet = getExplicitAllowedSources(env);

  if (policyMode === 'strict-allowlist') {
    // Under strict-allowlist:
    // 1. PROHIBITED sources (gdstudio, lyriva, unblock) can NEVER be enabled even if listed.
    // 2. Any other source is enabled ONLY if explicitly listed in SONIC_ALLOWED_SOURCES
    //    (or SONIC_ENABLE_SYNTHETIC_TEST_SOURCE=1 for first-party synthetic media) AND not explicitly set to 0.
    const checkStrict = (id: string, envVal: unknown, extraAllow = false): boolean => {
      const entry = CONTENT_SOURCE_LICENSING_REGISTRY[id];
      if (!entry || entry.authorizationStatus === 'PROHIBITED') return false;
      const inList = allowSet.has(id) || extraAllow;
      if (!inList) return false;
      return parseBoolFlag(envVal, true);
    };

    const syntheticExplicit = parseBoolFlag(e.SONIC_ENABLE_SYNTHETIC_TEST_SOURCE, false);
    const flags = {
      policyMode,
      enableSynthetic: checkStrict('synthetic', e.SONIC_ENABLE_SYNTHETIC_TEST_SOURCE, syntheticExplicit),
      enableNetease: checkStrict('netease', e.SONIC_ENABLE_NETEASE),
      enableQq: checkStrict('qq', e.SONIC_ENABLE_QQ),
      enableKugou: checkStrict('kugou', e.SONIC_ENABLE_KUGOU),
      enableKuwo: checkStrict('kuwo', e.SONIC_ENABLE_KUWO),
      enableAmll: checkStrict('amll', e.SONIC_ENABLE_AMLL),
      enableLrclib: checkStrict('lrclib', e.SONIC_ENABLE_LRCLIB),
      enableApple: checkStrict('apple', e.SONIC_ENABLE_APPLE) && Boolean(e.SONIC_APPLE_MUSIC_TOKEN),
      enableYtmusic: checkStrict('ytmusic', e.SONIC_ENABLE_YTMUSIC) && Boolean(e.SONIC_YOUTUBE_API_KEY),
      enableListenbrainz: checkStrict('listenbrainz', e.SONIC_ENABLE_LISTENBRAINZ),
      enableGdstudio: checkStrict('gdstudio', e.SONIC_ENABLE_GDSTUDIO, true),
      enableLyriva: false,
      enableUnblock: false,
      allowedSources: [] as string[],
    };
    flags.allowedSources = collectEnabledSourceIds(flags);
    return flags;
  }

  // Standard mode: respects individual SONIC_ENABLE_* switches (and optional SONIC_ALLOWED_SOURCES filter if set).
  const filterByOptionalAllowSet = (id: string, enabled: boolean): boolean => {
    if (!enabled) return false;
    if (allowSet.size === 0) return true;
    return allowSet.has(id);
  };

  const flags: EffectiveContentFlags = {
    policyMode,
    enableSynthetic:
      parseBoolFlag(e.SONIC_ENABLE_SYNTHETIC_TEST_SOURCE, false) || allowSet.has('synthetic'),
    enableNetease: filterByOptionalAllowSet('netease', parseBoolFlag(e.SONIC_ENABLE_NETEASE, true)),
    enableQq: filterByOptionalAllowSet('qq', parseBoolFlag(e.SONIC_ENABLE_QQ, true)),
    enableKugou: filterByOptionalAllowSet('kugou', parseBoolFlag(e.SONIC_ENABLE_KUGOU, true)),
    enableKuwo: filterByOptionalAllowSet('kuwo', parseBoolFlag(e.SONIC_ENABLE_KUWO, true)),
    enableAmll: filterByOptionalAllowSet('amll', parseBoolFlag(e.SONIC_ENABLE_AMLL, true)),
    enableLrclib: filterByOptionalAllowSet('lrclib', parseBoolFlag(e.SONIC_ENABLE_LRCLIB, true)),
    enableApple:
      filterByOptionalAllowSet('apple', parseBoolFlag(e.SONIC_ENABLE_APPLE, false)) &&
      Boolean(e.SONIC_APPLE_MUSIC_TOKEN),
    enableYtmusic:
      filterByOptionalAllowSet('ytmusic', parseBoolFlag(e.SONIC_ENABLE_YTMUSIC, false)) &&
      Boolean(e.SONIC_YOUTUBE_API_KEY),
    enableListenbrainz: filterByOptionalAllowSet(
      'listenbrainz',
      parseBoolFlag(e.SONIC_ENABLE_LISTENBRAINZ, false),
    ),
    enableGdstudio: filterByOptionalAllowSet('gdstudio', parseBoolFlag(e.SONIC_ENABLE_GDSTUDIO, true)),
    enableLyriva: filterByOptionalAllowSet('lyriva', parseBoolFlag(e.SONIC_ENABLE_LYRIVA, false)),
    enableUnblock: filterByOptionalAllowSet('unblock', parseBoolFlag(e.SONIC_ENABLE_UNBLOCK, false)),
    allowedSources: [],
  };
  flags.allowedSources = collectEnabledSourceIds(flags);
  return flags;
}

function collectEnabledSourceIds(f: EffectiveContentFlags): string[] {
  const list: string[] = [];
  if (f.enableSynthetic) list.push('synthetic');
  if (f.enableNetease) list.push('netease');
  if (f.enableQq) list.push('qq');
  if (f.enableKugou) list.push('kugou');
  if (f.enableKuwo) list.push('kuwo');
  if (f.enableAmll) list.push('amll');
  if (f.enableLrclib) list.push('lrclib');
  if (f.enableApple) list.push('apple');
  if (f.enableYtmusic) list.push('ytmusic');
  if (f.enableListenbrainz) list.push('listenbrainz');
  if (f.enableGdstudio) list.push('gdstudio');
  if (f.enableLyriva) list.push('lyriva');
  return list;
}

export function isSourceEnabledByPolicy(source: string, env?: AppEnv): boolean {
  const norm = normalizeSourceId(source);
  const f = evaluateContentFlags(env);
  if (norm === 'sonic') {
    // 'sonic' is the aggregated canonical alias; allowed if at least one audio/catalog source is enabled
    return (
      f.enableSynthetic ||
      f.enableNetease ||
      f.enableQq ||
      f.enableKugou ||
      f.enableKuwo
    );
  }
  switch (norm) {
    case 'synthetic':
      return f.enableSynthetic;
    case 'netease':
      return f.enableNetease;
    case 'qq':
      return f.enableQq;
    case 'kugou':
      return f.enableKugou;
    case 'kuwo':
      return f.enableKuwo;
    case 'amll':
      return f.enableAmll;
    case 'lrclib':
      return f.enableLrclib;
    case 'apple':
      return f.enableApple;
    case 'ytmusic':
      return f.enableYtmusic;
    case 'listenbrainz':
      return f.enableListenbrainz;
    case 'gdstudio':
      return f.enableGdstudio;
    case 'lyriva':
      return f.enableLyriva;
    case 'unblock':
      return f.enableUnblock;
    default:
      return false;
  }
}

export function getAllowedMediaDomains(env?: AppEnv): string[] {
  const f = evaluateContentFlags(env);
  const domains = new Set<string>();

  if (f.enableNetease) {
    CONTENT_SOURCE_LICENSING_REGISTRY.netease.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableQq) {
    CONTENT_SOURCE_LICENSING_REGISTRY.qq.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableKugou) {
    CONTENT_SOURCE_LICENSING_REGISTRY.kugou.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableKuwo) {
    CONTENT_SOURCE_LICENSING_REGISTRY.kuwo.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableAmll) {
    CONTENT_SOURCE_LICENSING_REGISTRY.amll.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableLrclib) {
    CONTENT_SOURCE_LICENSING_REGISTRY.lrclib.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableGdstudio) {
    CONTENT_SOURCE_LICENSING_REGISTRY.gdstudio.allowedDomains.forEach((d) => domains.add(d));
  }
  if (f.enableLyriva) {
    CONTENT_SOURCE_LICENSING_REGISTRY.lyriva.allowedDomains.forEach((d) => domains.add(d));
  }

  // Optional operator-approved test CDN domains (HTTPS public hostnames only; SSRF validator still runs)
  const extraRaw = String(env?.SONIC_AUTHORIZED_TEST_DOMAINS || '').trim();
  if (extraRaw) {
    for (const item of extraRaw.split(',')) {
      const clean = item.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
      if (clean && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean) && !clean.startsWith('engine-sonic.')) {
        domains.add(clean);
      }
    }
  }

  return Array.from(domains);
}

export function getLicensingAuditSummary(env?: AppEnv) {
  const flags = evaluateContentFlags(env);
  return {
    policyMode: flags.policyMode,
    allowedSources: flags.allowedSources,
    allowedMediaDomains: getAllowedMediaDomains(env),
    sources: Object.values(CONTENT_SOURCE_LICENSING_REGISTRY).map((entry) => ({
      id: entry.id,
      authorizationStatus: entry.authorizationStatus,
      statusLabelZh: entry.statusLabelZh,
      capabilities: entry.capabilities,
      enabledNow: isSourceEnabledByPolicy(entry.id, env),
      envSwitch: entry.envSwitch,
    })),
  };
}

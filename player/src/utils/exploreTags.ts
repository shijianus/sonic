// 风格探索与搜索推荐标签维度定义与多维度色彩体系
export type ExploreTagGroup = 'region' | 'genre' | 'mood' | 'scene' | 'theme'

export interface ExploreTagItem {
  name: string
  group: ExploreTagGroup
}

// 内置充足的多角度音乐风格、情绪与场景标签
// 预设排斥规则：同一相斥组（同一 group）内单选互斥，后选替换先选；不同维度角度间可自由组合
export const exploreTags: ExploreTagItem[] = [
  // ── 1. 地域 / 语种 (相斥组) - Sky 天蓝 ──
  { name: '华语流行', group: 'region' },
  { name: '欧美流行', group: 'region' },
  { name: '粤语金曲', group: 'region' },
  { name: '日韩流行', group: 'region' },

  // ── 2. 曲风流派 (相斥组) - Violet 紫罗兰 ──
  { name: '摇滚', group: 'genre' },
  { name: '民谣', group: 'genre' },
  { name: '电子音乐', group: 'genre' },
  { name: '说唱', group: 'genre' },
  { name: 'R&B', group: 'genre' },
  { name: '纯音乐', group: 'genre' },
  { name: '古典', group: 'genre' },
  { name: '爵士', group: 'genre' },
  { name: '古风', group: 'genre' },
  { name: '轻音乐', group: 'genre' },
  { name: '朋克', group: 'genre' },
  { name: '金属', group: 'genre' },
  { name: '蓝调', group: 'genre' },
  { name: '乡村音乐', group: 'genre' },
  { name: '舞曲', group: 'genre' },

  // ── 3. 情绪与氛围 (相斥组) - Rose 玫瑰粉 ──
  { name: '治愈系', group: 'mood' },
  { name: '浪漫抒情', group: 'mood' },
  { name: '安静舒缓', group: 'mood' },
  { name: '燃炸热血', group: 'mood' },
  { name: '伤感回忆', group: 'mood' },

  // ── 4. 场景与功能 (相斥组) - Emerald 翡翠绿 ──
  { name: '学习工作', group: 'scene' },
  { name: '运动健身', group: 'scene' },
  { name: '晚安助眠', group: 'scene' },
  { name: '通勤随行', group: 'scene' },
  { name: '自驾旅行', group: 'scene' },

  // ── 5. 主题特色 (相斥组) - Amber 琥珀橙 ──
  { name: '经典老歌', group: 'theme' },
  { name: '影视原声', group: 'theme' },
  { name: 'ACG二次元', group: 'theme' },
  { name: '独立音乐', group: 'theme' },
]

export const groupOrder: Record<ExploreTagGroup, number> = {
  region: 1,
  genre: 2,
  mood: 3,
  scene: 4,
  theme: 5,
}

// 维度分组颜色映射配置表
// 满足用户要求：相同组别的(互斥)tag颜色一样，不同组别的tag颜色不同，严格区分 # 前缀与胶囊状态色彩
export interface GroupColorConfig {
  name: string
  hashInactive: string
  hashActive: string
  chipInactive: string
  chipActive: string
  radarBadge: string
}

export const groupColorConfigs: Record<ExploreTagGroup, GroupColorConfig> = {
  region: {
    name: '地域语种',
    hashInactive: 'text-sky-400/80',
    hashActive: 'text-sky-300 font-bold',
    chipInactive: 'border-sky-500/20 bg-sky-500/5 text-primary/75 hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-200',
    chipActive: 'border-sky-500/60 bg-sky-500/20 text-sky-200 shadow-[0_0_12px_rgba(56,189,248,0.25)]',
    radarBadge: 'border-sky-500/40 bg-sky-500/15 text-sky-400',
  },
  genre: {
    name: '曲风流派',
    hashInactive: 'text-violet-400/80',
    hashActive: 'text-violet-300 font-bold',
    chipInactive: 'border-violet-500/20 bg-violet-500/5 text-primary/75 hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-200',
    chipActive: 'border-violet-500/60 bg-violet-500/20 text-violet-200 shadow-[0_0_12px_rgba(167,139,250,0.25)]',
    radarBadge: 'border-violet-500/40 bg-violet-500/15 text-violet-400',
  },
  mood: {
    name: '情绪氛围',
    hashInactive: 'text-rose-400/80',
    hashActive: 'text-rose-300 font-bold',
    chipInactive: 'border-rose-500/20 bg-rose-500/5 text-primary/75 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-200',
    chipActive: 'border-rose-500/60 bg-rose-500/20 text-rose-200 shadow-[0_0_12px_rgba(251,113,133,0.25)]',
    radarBadge: 'border-rose-500/40 bg-rose-500/15 text-rose-400',
  },
  scene: {
    name: '场景功能',
    hashInactive: 'text-emerald-400/80',
    hashActive: 'text-emerald-300 font-bold',
    chipInactive: 'border-emerald-500/20 bg-emerald-500/5 text-primary/75 hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-200',
    chipActive: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 shadow-[0_0_12px_rgba(52,211,153,0.25)]',
    radarBadge: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
  },
  theme: {
    name: '主题特色',
    hashInactive: 'text-amber-400/80',
    hashActive: 'text-amber-300 font-bold',
    chipInactive: 'border-amber-500/20 bg-amber-500/5 text-primary/75 hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-200',
    chipActive: 'border-amber-500/60 bg-amber-500/20 text-amber-200 shadow-[0_0_12px_rgba(251,191,36,0.25)]',
    radarBadge: 'border-amber-500/40 bg-amber-500/15 text-amber-400',
  },
}

const tagMap = new Map<string, ExploreTagItem>(exploreTags.map(t => [t.name, t]))

export function getTagItem(name: string): ExploreTagItem | undefined {
  return tagMap.get(name)
}

export function getTagGroup(name: string): ExploreTagGroup {
  return tagMap.get(name)?.group || 'genre'
}

export function getGroupConfig(group: ExploreTagGroup): GroupColorConfig {
  return groupColorConfigs[group] || groupColorConfigs.genre
}

export function getRadarBadgeClass(name: string): string {
  const group = getTagGroup(name)
  return groupColorConfigs[group]?.radarBadge || groupColorConfigs.genre.radarBadge
}

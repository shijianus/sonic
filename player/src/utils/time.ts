/**
 * 时间与数字格式化工具
 * 提供歌曲时长、播放次数、日期等格式化方法
 * 所有面向界面的数字与日期均通过 Intl 格式化，并跟随当前界面语言
 */
import i18n from '@/languages'

/** 读取当前 vue-i18n locale，兼容 composition / legacy 两种模式 */
const getLocale = (): string => {
  const locale = i18n.global.locale as unknown
  if (locale && typeof locale === 'object' && 'value' in locale) {
    return String((locale as { value: string }).value)
  }
  return String(locale || 'zh')
}

/**
 * 格式化歌曲时长（毫秒 → m:ss）
 * @param ms - 毫秒数
 * @returns 格式化后的时间字符串，如 "3:05"
 */
export const formatDuration = (ms: number) => {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * 格式化歌曲时长（毫秒 → m:ss），时长缺失时返回占位符 "--:--"
 */
export const formatDurationOrDash = (ms?: number) => {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return '--:--'
  return formatDuration(ms)
}

/**
 * 使用 Intl.NumberFormat 格式化普通数字（千分位等，跟随当前语言）
 */
export const formatNumber = (value: number | string) => {
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return String(value)
  return new Intl.NumberFormat(getLocale()).format(num)
}

/**
 * 格式化播放次数等大数字（Intl compact notation，自动使用 万/亿、K/M 等）
 * @param count - 数字或字符串
 * @returns 格式化后的字符串，如 "3.2万"、"1.5M"
 */
export const formatCount = (count: number | string) => {
  const num = typeof count === 'string' ? Number(count) : count
  if (!Number.isFinite(num)) return String(count)
  if (Math.abs(num) < 1000) return new Intl.NumberFormat(getLocale()).format(num)
  return new Intl.NumberFormat(getLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(num)
}

/**
 * 格式化时间戳：1 小时内使用相对时间，超过 24 小时使用本地化日期
 * @param time 时间戳（毫秒）
 * @returns 格式化后的时间字符串
 */
export const formatDate = (time: number) => {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''

  const locale = getLocale()
  const diff = Date.now() - date.getTime()

  if (diff < 60000) {
    return i18n.global.t('common.justNow')
  }

  if (diff < 3600000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(
      -Math.floor(diff / 60000),
      'minute'
    )
  }

  if (diff < 86400000) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }).format(
      -Math.floor(diff / 3600000),
      'hour'
    )
  }

  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(
    locale,
    sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }
  ).format(date)
}

/**
 * 本地化长日期（用于评论、发行日期等需要完整年份的场景）
 */
export const formatDateLong = (value: number | string | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * 本地化日期 + 时间
 */
export const formatDateTime = (value: number | string | Date) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * 学习 YouTube 相对时间展示规则（考虑当前用户本地时区）：
 * - 1天以内的，以最小单位为准（秒、分钟、小时，均不超过3位数）；
 * - 1天以上的，不到半个月[14天即2周，但是15天依然展示15天]的，展示天数；
 * - 2周以上[不含2周]，不超过1.5个月的，展示周数；
 * - 1.5个月以上不超过1年的，展示月数；
 * - 1年以上不超过60年的展示年数；
 * - 60年以上，不超过360年的，展示纪数[1纪=12年]；
 * - 再往上用"世纪"[1世纪=100年]兜底。
 *
 * @param time - 时间戳、日期字符串或 Date 对象
 * @param customNow - 自定义参考当前时间戳（用于测试或指定时间基准）
 */
export const formatRelativeTimeYT = (
  time: number | string | Date | undefined | null,
  customNow?: number
): string => {
  if (!time) return ''
  const date = time instanceof Date ? time : new Date(time)
  const timestamp = date.getTime()
  if (Number.isNaN(timestamp)) return ''

  const now = typeof customNow === 'number' ? customNow : Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const diffSec = Math.floor(diffMs / 1000)

  // 1天以内的，以最小单位为准——例如秒、分钟、小时，均不超过3位数
  if (diffSec < 60) {
    const s = Math.min(diffSec, 999)
    return `${s}秒前`
  }
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) {
    const m = Math.min(diffMin, 999)
    return `${m}分钟前`
  }
  const diffHours = Math.floor(diffSec / 3600)
  if (diffHours < 24) {
    const h = Math.min(diffHours, 999)
    return `${h}小时前`
  }

  // 1天以上的
  const diffDays = Math.floor(diffSec / 86400)

  // 不到半个月[14天即2周，但是15天依然展示15天]的，展示天数
  if (diffDays <= 15) {
    return `${diffDays}天前`
  }

  // 2周以上[不含2周]，不超过1.5个月的，展示周数（1.5个月按45天计）
  if (diffDays <= 45) {
    const weeks = Math.floor(diffDays / 7)
    return `${weeks}周前`
  }

  // 1.5个月以上不超过1年的，展示月数
  if (diffDays < 365) {
    const months = Math.max(1, Math.floor(diffDays / 30))
    return `${months}个月前`
  }

  // 1年以上不超过60年的展示年数
  const diffYears = Math.floor(diffDays / 365)
  if (diffYears <= 60) {
    return `${diffYears}年前`
  }

  // 60年以上，不超过360年的，展示纪数[1纪=12年]
  if (diffYears <= 360) {
    const ji = Math.floor(diffYears / 12)
    return `${ji}纪前`
  }

  // 再往上用"世纪"[1世纪=100年]兜底
  const century = Math.floor(diffYears / 100)
  return `${century}世纪前`
}

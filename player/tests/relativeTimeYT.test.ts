import { describe, it, expect } from 'vitest'
import { formatRelativeTimeYT } from '../src/utils/time'

describe('formatRelativeTimeYT - YouTube-style relative time formatting', () => {
  const baseNow = new Date('2026-10-31T16:00:00Z').getTime()

  it('handles invalid or empty inputs gracefully', () => {
    expect(formatRelativeTimeYT(undefined)).toBe('')
    expect(formatRelativeTimeYT(null)).toBe('')
    expect(formatRelativeTimeYT('')).toBe('')
    expect(formatRelativeTimeYT('invalid-date')).toBe('')
  })

  it('formats < 1 minute in seconds (<= 3 digits)', () => {
    expect(formatRelativeTimeYT(baseNow - 5 * 1000, baseNow)).toBe('5秒前')
    expect(formatRelativeTimeYT(baseNow - 59 * 1000, baseNow)).toBe('59秒前')
  })

  it('formats < 1 hour in minutes (<= 3 digits)', () => {
    expect(formatRelativeTimeYT(baseNow - 60 * 1000, baseNow)).toBe('1分钟前')
    expect(formatRelativeTimeYT(baseNow - 45 * 60 * 1000, baseNow)).toBe('45分钟前')
    expect(formatRelativeTimeYT(baseNow - 59 * 60 * 1000, baseNow)).toBe('59分钟前')
  })

  it('formats < 24 hours in hours (<= 3 digits)', () => {
    expect(formatRelativeTimeYT(baseNow - 3600 * 1000, baseNow)).toBe('1小时前')
    expect(formatRelativeTimeYT(baseNow - 12 * 3600 * 1000, baseNow)).toBe('12小时前')
    expect(formatRelativeTimeYT(baseNow - 23 * 3600 * 1000, baseNow)).toBe('23小时前')
  })

  it('formats 1 day to 15 days in days (14 days = 2 weeks, but 15 days shows 15 days)', () => {
    expect(formatRelativeTimeYT(baseNow - 1 * 86400 * 1000, baseNow)).toBe('1天前')
    expect(formatRelativeTimeYT(baseNow - 7 * 86400 * 1000, baseNow)).toBe('7天前')
    expect(formatRelativeTimeYT(baseNow - 14 * 86400 * 1000, baseNow)).toBe('14天前')
    expect(formatRelativeTimeYT(baseNow - 15 * 86400 * 1000, baseNow)).toBe('15天前')
  })

  it('formats > 15 days up to 1.5 months (45 days) in weeks', () => {
    expect(formatRelativeTimeYT(baseNow - 16 * 86400 * 1000, baseNow)).toBe('2周前')
    expect(formatRelativeTimeYT(baseNow - 21 * 86400 * 1000, baseNow)).toBe('3周前')
    expect(formatRelativeTimeYT(baseNow - 28 * 86400 * 1000, baseNow)).toBe('4周前')
    expect(formatRelativeTimeYT(baseNow - 35 * 86400 * 1000, baseNow)).toBe('5周前')
    expect(formatRelativeTimeYT(baseNow - 45 * 86400 * 1000, baseNow)).toBe('6周前')
  })

  it('formats > 1.5 months up to 1 year in months', () => {
    expect(formatRelativeTimeYT(baseNow - 46 * 86400 * 1000, baseNow)).toBe('1个月前')
    expect(formatRelativeTimeYT(baseNow - 90 * 86400 * 1000, baseNow)).toBe('3个月前')
    expect(formatRelativeTimeYT(baseNow - 180 * 86400 * 1000, baseNow)).toBe('6个月前')
    expect(formatRelativeTimeYT(baseNow - 330 * 86400 * 1000, baseNow)).toBe('11个月前')
  })

  it('formats 1 year to 60 years in years', () => {
    expect(formatRelativeTimeYT(baseNow - 365 * 86400 * 1000, baseNow)).toBe('1年前')
    expect(formatRelativeTimeYT(baseNow - 3 * 365 * 86400 * 1000, baseNow)).toBe('3年前')
    expect(formatRelativeTimeYT(baseNow - 10 * 365 * 86400 * 1000, baseNow)).toBe('10年前')
    expect(formatRelativeTimeYT(baseNow - 60 * 365 * 86400 * 1000, baseNow)).toBe('60年前')
  })

  it('formats 60 years to 360 years in "纪" (1纪=12年)', () => {
    expect(formatRelativeTimeYT(baseNow - 61 * 365 * 86400 * 1000, baseNow)).toBe('5纪前')
    expect(formatRelativeTimeYT(baseNow - 72 * 365 * 86400 * 1000, baseNow)).toBe('6纪前')
    expect(formatRelativeTimeYT(baseNow - 120 * 365 * 86400 * 1000, baseNow)).toBe('10纪前')
    expect(formatRelativeTimeYT(baseNow - 360 * 365 * 86400 * 1000, baseNow)).toBe('30纪前')
  })

  it('formats > 360 years in "世纪" (1世纪=100年)', () => {
    expect(formatRelativeTimeYT(baseNow - 400 * 365 * 86400 * 1000, baseNow)).toBe('4世纪前')
    expect(formatRelativeTimeYT(baseNow - 1000 * 365 * 86400 * 1000, baseNow)).toBe('10世纪前')
  })

  it('parses ISO date strings according to user timezone', () => {
    const formatted = formatRelativeTimeYT('2019-07-26', baseNow)
    expect(formatted).toMatch(/年前/)
  })
})

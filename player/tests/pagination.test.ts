import { describe, expect, it } from 'vitest'
import { clampPage, getTotalPages, normalizePaginationTotal } from '@/utils/pagination'

describe('pagination normalization', () => {
  it('rejects malformed and negative totals without producing invalid pages', () => {
    expect(normalizePaginationTotal(undefined)).toBe(0)
    expect(normalizePaginationTotal('not-a-number', 7)).toBe(7)
    expect(normalizePaginationTotal(-10, 4)).toBe(4)
    expect(getTotalPages('not-a-number', 20)).toBe(1)
  })

  it('clamps a stale page when the total shrinks', () => {
    expect(getTotalPages(101, 20)).toBe(6)
    expect(clampPage(6, 21, 20)).toBe(2)
    expect(clampPage(0, 21, 20)).toBe(1)
    expect(clampPage('bad', 21, 20)).toBe(1)
  })
})

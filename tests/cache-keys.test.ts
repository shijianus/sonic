import { describe, expect, it } from 'vitest'
import { buildSonicCacheKey } from '../functions/_lib/sonic/cache'

describe('cache key isolation', () => {
  it('does not alias whitespace with an underscore', () => {
    expect(buildSonicCacheKey('search', 'a b')).not.toBe(buildSonicCacheKey('search', 'a_b'))
  })

  it('does not alias field separators inside user input', () => {
    expect(buildSonicCacheKey('search', 'q=a:b')).not.toBe(buildSonicCacheKey('search', 'q=a_b'))
  })

  it('is stable for the same semantic identifier', () => {
    expect(buildSonicCacheKey('search', '  q=sonic  ')).toBe(buildSonicCacheKey('search', 'q=sonic'))
  })
})

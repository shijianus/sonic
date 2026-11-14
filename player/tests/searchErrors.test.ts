import { describe, expect, it } from 'vitest'
import { checkSearchPayload } from '@/utils/searchErrors'

describe('search response contract', () => {
  it('rejects a string result as an upstream format error', () => {
    expect(() => checkSearchPayload({ code: 200, result: 'deadbeef' }, 'songs')).toThrowError(
      expect.objectContaining({
        status: 502,
        code: 'UPSTREAM_INVALID_RESPONSE',
      })
    )
  })

  it('rejects a successful response missing the requested result collection', () => {
    expect(() => checkSearchPayload({ code: 200, result: {} }, 'mvs')).toThrowError(
      expect.objectContaining({ code: 'UPSTREAM_INVALID_RESPONSE' })
    )
  })

  it('accepts a structurally valid empty result', () => {
    expect(() => checkSearchPayload({ code: 200, result: { playlists: [], playlistCount: 0 } }, 'playlists')).not.toThrow()
  })
})

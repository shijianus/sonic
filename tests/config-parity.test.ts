import { describe, it, expect } from 'vitest'
import { getSonicConfig, SONIC_UA } from '../functions/_lib/sonic/config'
import type { AppEnv } from '../functions/_lib/types'

describe('Sonic configuration parity', () => {
  it('keeps the canonical cross-match switch authoritative', () => {
    const off = getSonicConfig({
      SONIC_ENABLE_FREE_CROSS_MATCH: '0',
      SONIC_ENABLE_FREE_MATCH: '1',
    } as AppEnv)
    expect(off.enableFreeCrossMatch).toBe(false)

    const on = getSonicConfig({
      SONIC_ENABLE_FREE_CROSS_MATCH: '1',
      SONIC_ENABLE_FREE_MATCH: '0',
    } as AppEnv)
    expect(on.enableFreeCrossMatch).toBe(true)
  })

  it('reads the legacy alias when the canonical name is absent or empty', () => {
    expect(getSonicConfig({ SONIC_ENABLE_FREE_MATCH: '0' } as AppEnv).enableFreeCrossMatch).toBe(false)
    expect(
      getSonicConfig({ SONIC_ENABLE_FREE_CROSS_MATCH: '', SONIC_ENABLE_FREE_MATCH: '0' } as AppEnv)
        .enableFreeCrossMatch,
    ).toBe(false)
  })

  it('keeps cross-source matching enabled by default', () => {
    expect(getSonicConfig({} as AppEnv).enableFreeCrossMatch).toBe(true)
  })

  it('reports a single 2.2.0 gateway user agent', () => {
    expect(SONIC_UA.startsWith('Sonic/2.2.0 ')).toBe(true)
  })
})

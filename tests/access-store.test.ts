import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SqliteAccessStore } from '../server/access-store'
import { getAccessStoreKeyForTest } from '../functions/_lib/sonic/access'

describe('invite access SQLite store', () => {
  it('redeems a seeded invite once and validates session expiry/revocation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-access-'))
    const dbPath = path.join(dir, 'access.sqlite')
    const store = new SqliteAccessStore(dbPath, 'PUBLIC-BETA-ONE-2026')
    try {
      const key = getAccessStoreKeyForTest('invite', 'PUBLIC-BETA-ONE-2026')
      expect(key).toMatch(/^sonic:access:invite:/)
      const redemption = store.redeemInvite(key!, 1_000)
      expect(redemption?.inviteId).toMatch(/^seed_/)
      expect(store.redeemInvite(key!, 1_001)).toBeNull()

      const session = {
        sessionHash: 'sonic:access:session:test',
        createdAt: 1_000,
        expiresAt: 2_000,
      }
      store.createSession(session)
      expect(store.getSession(session.sessionHash, 1_999)).toMatchObject(session)
      expect(store.getSession(session.sessionHash, 2_000)).toBeNull()
      store.revokeSession(session.sessionHash, 1_500)
      expect(store.getSession(session.sessionHash, 1_600)).toMatchObject({ revokedAt: 1_500 })
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('revokes a seeded invite so a removed code can no longer be redeemed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-access-'))
    const dbPath = path.join(dir, 'access.sqlite')
    const code = 'REVOKE-ME-2026-BETA'
    const store = new SqliteAccessStore(dbPath, code)
    try {
      const key = getAccessStoreKeyForTest('invite', code)
      expect(store.revokeInvite(key!, 1_000)).toBe(true)
      expect(store.revokeInvite(key!, 1_001)).toBe(false)
      expect(store.redeemInvite(key!, 1_002)).toBeNull()
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

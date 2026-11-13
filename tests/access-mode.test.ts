import { describe, expect, it } from 'vitest'
import { createAccessSession, getAccessReadiness, redeemAccessInvite, requireAccess } from '../functions/_lib/sonic/access'

const req = (path: string) => new Request(`https://sonic.example.com${path}`)
const production = (extra: Record<string, unknown> = {}) => ({
  SONIC_ENV: 'production',
  SONIC_ACCESS_SECRET: 'x'.repeat(48),
  ...extra,
}) as any

describe('access-mode production fail-closed policy', () => {
  it('rejects a production edge without an explicit access mode', async () => {
    const response = await requireAccess(req('/api/sonic/events'), production())
    expect(response?.status).toBe(503)
    expect((await response!.json())?.error?.code).toBe('ACCESS_MODE_MISCONFIGURED')
  })

  it('allows an explicit open production policy', async () => {
    expect(await requireAccess(req('/api/sonic/events'), production({ SONIC_ACCESS_MODE: 'open' }))).toBeNull()
  })

  it('requires an invite session on production invite routes', async () => {
    const response = await requireAccess(req('/api/sonic/events'), production({ SONIC_ACCESS_MODE: 'invite' }))
    expect(response?.status).toBe(401)
    expect((await response!.json())?.error?.code).toBe('ACCESS_REQUIRED')
  })

  it('requires durable storage for production Pages even without the opt-in flag', async () => {
    const code = 'production-fixture-invite';
    const env = production({ SONIC_ACCESS_MODE: 'invite', CF_PAGES: '1', SONIC_INVITE_CODES: code });
    expect(await redeemAccessInvite(env, code)).toEqual({ ok: false, code: 'store_unavailable' });
    expect(await getAccessReadiness(env)).toMatchObject({ ok: false, durableRequired: true, storeUsable: false });
  })

  it('does not open Staging when durable invitations are required but the mode is missing', async () => {
    const env = { SONIC_ENV: 'staging', SONIC_REQUIRE_DURABLE_INVITES: '1' };
    const response = await requireAccess(req('/api/sonic/events'), env);
    expect(response?.status).toBe(503);
  })

  it('keeps the access lifecycle endpoints reachable in invite mode', async () => {
    expect(await requireAccess(req('/api/access/session'), production({ SONIC_ACCESS_MODE: 'invite' }))).toBeNull()
    expect(await requireAccess(req('/api/access/invite'), production({ SONIC_ACCESS_MODE: 'invite' }))).toBeNull()
  })

  it('gates the API index itself in invite mode', async () => {
    const response = await requireAccess(req('/api'), production({ SONIC_ACCESS_MODE: 'invite' }))
    expect(response?.status).toBe(401)
  })

  it('does not turn a production engine into a browser-access gate', async () => {
    expect(await requireAccess(req('/api/sonic/events'), production({ SONIC_RUNTIME: 'linux-engine' }))).toBeNull()
  })

  it('fails closed on any Pages deployment without an explicit environment', async () => {
    const response = await requireAccess(req('/api/sonic/events'), {
      CF_PAGES_BRANCH: 'release-2026',
      SONIC_ACCESS_SECRET: 'x'.repeat(48),
    } as any)
    expect(response?.status).toBe(503)
    expect((await response!.json())?.error?.code).toBe('ACCESS_MODE_MISCONFIGURED')
  })

  it('allows a Pages deployment with an explicit open policy', async () => {
    expect(await requireAccess(req('/api/sonic/events'), {
      CF_PAGES_BRANCH: 'release-2026',
      SONIC_ACCESS_MODE: 'open',
      SONIC_ACCESS_SECRET: 'x'.repeat(48),
    } as any)).toBeNull()
  })

  it('fails closed when SONIC_ENV is set to an unknown value', async () => {
    const response = await requireAccess(req('/api/sonic/events'), {
      SONIC_ENV: 'prod',
      SONIC_ACCESS_SECRET: 'x'.repeat(48),
    } as any)
    expect(response?.status).toBe(503)
    expect((await response!.json())?.error?.code).toBe('ACCESS_MODE_MISCONFIGURED')
  })

  it('honors an explicitly declared staging environment', async () => {
    expect(await requireAccess(req('/api/sonic/events'), {
      SONIC_ENV: 'staging',
      SONIC_ACCESS_SECRET: 'x'.repeat(48),
    } as any)).toBeNull()
  })

  it('rejects an unknown access mode in staging and preview instead of falling back to open', async () => {
    for (const env of [
      { SONIC_ENV: 'staging', SONIC_ACCESS_MODE: 'invte', SONIC_ACCESS_SECRET: 'x'.repeat(48) },
      { SONIC_ENV: 'preview', SONIC_ACCESS_MODE: 'public', SONIC_ACCESS_SECRET: 'x'.repeat(48) },
    ]) {
      const response = await requireAccess(req('/api/sonic/events'), env as any)
      expect(response?.status).toBe(503)
      expect((await response!.json())?.error?.code).toBe('ACCESS_MODE_INVALID')
    }
  })

  it('bounds created session TTL in seconds instead of treating it as milliseconds', async () => {
    const created = await createAccessSession(production(), 1_000, 120)
    expect(created?.record.createdAt).toBe(1_000)
    expect(created?.record.expiresAt).toBe(1_000 + 120_000)

    const clamped = await createAccessSession(production(), 1_000, 99_999_999)
    expect(clamped?.record.expiresAt).toBe(1_000 + 30 * 24 * 60 * 60 * 1000)
  })
})

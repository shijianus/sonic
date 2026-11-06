import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const httpGet = vi.fn()
const httpPost = vi.fn()

vi.mock('@/utils/http', () => ({
  httpGet: (...args: unknown[]) => httpGet(...args),
  httpPost: (...args: unknown[]) => httpPost(...args),
}))

import { useAccessStore } from '@/stores/modules/access'

describe('invite access status machine', () => {
  beforeEach(() => {
    httpGet.mockReset()
    httpPost.mockReset()
    setActivePinia(createPinia())
  })

  it('treats a 401 status probe as invite-required, not a server error', async () => {
    httpGet.mockRejectedValueOnce({
      response: { status: 401, data: { ok: false, access: false, mode: 'invite' } },
    })
    const store = useAccessStore()
    await store.checkStatus(true)
    expect(store.status).toBe('required')
    expect(store.mode).toBe('invite')
    expect(store.requiresInvite).toBe(true)
    expect(store.errorKind).toBeNull()
  })

  it('keeps an unavailable access store as a retryable error', async () => {
    httpGet.mockRejectedValueOnce({ response: { status: 503 } })
    const store = useAccessStore()
    await store.checkStatus(true)
    expect(store.status).toBe('error')
    expect(store.requiresInvite).toBe(false)
  })

  it('does not turn a legacy staging 401 into an unreachable invite form', async () => {
    httpGet.mockRejectedValueOnce({
      response: { status: 401, data: { ok: false, error: { code: 'STAGING_ACCESS_REQUIRED' } } },
    })
    const store = useAccessStore()
    await store.checkStatus(true)
    expect(store.status).toBe('error')
    expect(store.requiresInvite).toBe(false)
  })

  it('shows the invite form again after an invalid code', async () => {
    httpPost.mockRejectedValueOnce({ response: { status: 401 } })
    const store = useAccessStore()
    store.mode = 'invite'
    store.status = 'required'
    const ok = await store.redeem('WRONG-CODE')
    expect(ok).toBe(false)
    expect(store.status).toBe('required')
    expect(store.errorKind).toBe('invalid')
  })

  it('keeps transport failures on the error state during redemption', async () => {
    httpPost.mockRejectedValueOnce({ response: { status: 503 } })
    const store = useAccessStore()
    store.mode = 'invite'
    store.status = 'required'
    const ok = await store.redeem('CODE')
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
  })
})

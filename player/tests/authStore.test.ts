import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/modules/auth'

const mock = vi.hoisted(() => ({
  httpGet: vi.fn(), httpPost: vi.fn(), activateAccount: vi.fn(), deactivateAccount: vi.fn(),
}))
vi.mock('@/utils/http', () => ({ httpGet: mock.httpGet, httpPost: mock.httpPost }))
vi.mock('@/stores/modules/library', () => ({ useLibraryStore: () => mock }))

const user = { id: 'account-a', email: 'a@example.test', name: 'A' }

function delayedVerification() {
  let finish!: (response: unknown) => void
  const promise = new Promise(resolve => { finish = resolve })
  return { promise, finish }
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
})

it('ignores an earlier account response during and after confirmed logout', async () => {
  const earlier = delayedVerification()
  const signOut = delayedVerification()
  mock.httpGet.mockReturnValueOnce(earlier.promise)
  mock.httpPost.mockReturnValueOnce(signOut.promise)
  const auth = useAuthStore()
  const checking = auth.checkAuth(true)
  const logout = auth.logout()
  expect(await auth.checkAuth(true)).toBeNull()
  expect(mock.httpGet).toHaveBeenCalledTimes(1)
  signOut.finish({ ok: true })
  expect(await logout).toBe(true)
  earlier.finish({ ok: true, user })
  expect(await checking).toBeNull()
  expect(auth.user).toBeNull()
  expect(auth.verifiedAccountId).toBeUndefined()
  expect(auth.isLoading).toBe(false)
  expect(mock.activateAccount).not.toHaveBeenCalled()
})

it.each(['network error', 'unconfirmed response'])('keeps the verified account after a failed logout (%s)', async (failure) => {
  mock.httpGet.mockResolvedValueOnce({ ok: true, user })
  if (failure === 'network error') mock.httpPost.mockRejectedValueOnce(new Error('unavailable'))
  else mock.httpPost.mockResolvedValueOnce({ ok: false })
  const auth = useAuthStore()
  expect(await auth.checkAuth()).toMatchObject(user)
  const revision = auth.sessionRevision
  expect(await auth.logout()).toBe(false)
  expect(auth.verifiedAccountId).toBe(user.id)
  expect(auth.sessionRevision).toBe(revision)
  expect(auth.isLoading).toBe(false)
  expect(mock.deactivateAccount).not.toHaveBeenCalled()
})

it('keeps the newer verified account when overlapping checks finish out of order', async () => {
  const earlier = delayedVerification()
  const nextUser = { id: 'account-b', email: 'b@example.test', name: 'B' }
  mock.httpGet.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce({ ok: true, user: nextUser })
  const auth = useAuthStore()
  const checking = auth.checkAuth(true)
  expect(await auth.checkAuth(true)).toMatchObject(nextUser)
  earlier.finish({ ok: true, user })
  expect(await checking).toBeNull()
  expect(auth.verifiedAccountId).toBe(nextUser.id)
  expect(mock.activateAccount).toHaveBeenCalledExactlyOnceWith(nextUser.id, true)
})

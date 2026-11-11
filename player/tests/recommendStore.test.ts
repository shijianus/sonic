import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { useRecommendStore } from '@/stores/modules/recommend'
import { useLibraryStore } from '@/stores/modules/library'
import { useAuthStore } from '@/stores/modules/auth'

const erasedEventEpoch = 'a'.repeat(32)
const consentKey = 'sonic:personalization-consent'
const deviceKey = 'sonic:recommendation-device-id'
const accountEpochKey = 'sonic:account-event-epoch'

function verifiedAccount(id: string) {
  const auth = useAuthStore()
  auth.user = { id, email: `${id}@example.test`, name: id }
  auth.isAuthenticated = true
  auth.lastSyncTime = Date.now()
  auth.sessionRevision++
  return auth
}

function accountEpoch(accountId: string, eventEpoch: string | null) {
  return Response.json({ brand: 'Sonic', data: { eventTarget: `account:${accountId}`, eventEpoch } })
}

function optedInStore() {
  const store = useRecommendStore()
  store.setPersonalizationEnabled(true)
  return store
}

function erasedProfile(privacyMode = 'anonymous-opt-in') {
  return Response.json({
    brand: 'Sonic',
    data: { privacyMode, cleared: true, storageKind: 'sqlite', removedEvents: 1, eventEpoch: erasedEventEpoch },
  })
}

function epochMismatch(eventEpoch: unknown, privacyMode = 'anonymous-opt-in') {
  return Response.json({
    brand: 'Sonic',
    error: { code: 'EVENT_EPOCH_MISMATCH' },
    data: { eventEpoch, privacyMode },
  }, { status: 409 })
}

function delayedResponse() {
  let finish!: (value: Response) => void
  const promise = new Promise<Response>((resolve) => { finish = resolve })
  return { promise, finish }
}

describe('recommend store: 隐私控制、不感兴趣负反馈与事件队列', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({ render: () => null }).use(pinia)
    setActivePinia(pinia)
    vi.restoreAllMocks()
  })

  it('开启个性化时自动生成合法的 anonId 并注入 X-Sonic-Anon-Id 与 X-Sonic-Context', () => {
    const rec = optedInStore()
    const lib = useLibraryStore()
    lib.toggleLikeSong({ id: 186016, name: '晴天', artist: '周杰伦', duration: 269000 })

    expect(rec.personalizationEnabled).toBe(true)
    const headers = rec.buildRequestHeaders(true)
    expect(headers['X-Sonic-Anon-Id']).toMatch(/^anon_[0-9a-f]{24}$/)
    expect(headers['X-Sonic-Context']).toBeTruthy()
    expect(headers['X-Sonic-Personalization']).toBeUndefined()
  })

  it('关闭个性化后立即返回 X-Sonic-Personalization: off 且不再附带 anonId 或上下文', () => {
    const rec = optedInStore()
    rec.setPersonalizationEnabled(false)

    const headers = rec.buildRequestHeaders(true)
    expect(headers).toEqual({ 'X-Sonic-Personalization': 'off' })
    expect(headers['X-Sonic-Anon-Id']).toBeUndefined()
    expect(headers['X-Sonic-Context']).toBeUndefined()
  })

  it('旧版自动开启不等于明确同意，保留旧匿名 ID 供画像删除', async () => {
    const legacyId = 'anon_previous_release_id'
    localStorage.setItem('recommend', JSON.stringify({ personalizationEnabled: true, anonId: legacyId }))
    const rec = useRecommendStore()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(erasedProfile())

    expect(rec.personalizationEnabled).toBe(false)
    expect(rec.buildRequestHeaders()).toEqual({ 'X-Sonic-Personalization': 'off' })
    expect(localStorage.getItem(deviceKey)).toBe(legacyId)
    rec.recordEvent({ type: 'search', query: 'private legacy query' }, true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await rec.clearAllRecommendationProfile()).toBe(true)
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith('/api/sonic/events', {
      method: 'DELETE',
      headers: { 'X-Sonic-Anon-Id': legacyId, 'X-Sonic-Erasure-Target': 'anonymous-opt-in' },
    })
    expect(localStorage.getItem(deviceKey)).toBe('')
  })

  it('另一标签页关闭时，即使 storage 事件未送达，pagehide 也会丢弃待发队列', () => {
    const rec = optedInStore()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    rec.recordEvent({ type: 'search', query: 'queued before opt-out' })

    localStorage.removeItem(consentKey)
    window.dispatchEvent(new Event('pagehide'))
    expect(rec.personalizationEnabled).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('跨标签关闭后立即重新开启不会恢复旧队列或失败中的旧请求', async () => {
    const rec = optedInStore()
    const prior = delayedResponse()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(prior.promise)
      .mockResolvedValueOnce(Response.json({}))
    rec.recordEvent({ type: 'search', query: 'old in-flight' })
    const writing = rec.flushEvents()
    rec.recordEvent({ type: 'search', query: 'old queued' })

    localStorage.removeItem(consentKey)
    localStorage.setItem(consentKey, 'f'.repeat(24))
    prior.finish(new Response(null, { status: 503 }))
    await writing

    rec.recordEvent({ type: 'search', query: 'new after opt-in' })
    await rec.flushEvents()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).events).toMatchObject([
      { type: 'search', query: 'new after opt-in' },
    ])
  })

  it('不感兴趣曲目支持标记、查询与撤销，并持久化在列表中', () => {
    const rec = useRecommendStore()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

    expect(rec.isSongDisliked(108914)).toBe(false)
    rec.dislikeSong({
      id: 108914,
      canonicalTrackId: 'trk_1234567890abcdef',
      name: '测试歌曲',
      artist: '测试歌手',
      duration: 210000,
    })

    expect(rec.isSongDisliked(108914)).toBe(true)
    expect(rec.isSongDisliked('trk_1234567890abcdef')).toBe(true)
    expect(rec.dislikedCount).toBe(1)

    rec.undislikeSong(108914)
    expect(rec.isSongDisliked(108914)).toBe(false)
    expect(rec.dislikedCount).toBe(0)
  })

  it('重置推荐画像会清空 dislikedTracks 并向服务端发送 DELETE /api/sonic/events', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => init?.method === 'DELETE' ? erasedProfile() : Response.json({}))

    const rec = optedInStore()
    rec.dislikeSong({ id: 999, name: '不喜欢', artist: '某歌手' })
    expect(rec.dislikedCount).toBe(1)

    const ok = await rec.clearAllRecommendationProfile()
    expect(ok).toBe(true)
    expect(rec.dislikedCount).toBe(0)
    expect(
      fetchSpy.mock.calls.some(
        (call) => String(call[0]).includes('/api/sonic/events') && (call[1] as any)?.method === 'DELETE'
      )
    ).toBe(true)
  })

  it('推荐画像删除失败时保留本地画像和匿名身份以便重试', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }))

    const rec = optedInStore()
    const previousAnonId = rec.anonId
    rec.dislikeSong({ id: 1000, name: '保留', artist: '测试' })

    const ok = await rec.clearAllRecommendationProfile()

    expect(ok).toBe(false)
    expect(rec.anonId).toBe(previousAnonId)
    expect(rec.dislikedCount).toBe(1)
  })

  it('清除等待在途上报，丢弃失败的旧批次与卸载时的待发事件', async () => {
    const previousPost = delayedResponse()
    const deletion = delayedResponse()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'DELETE') return deletion.promise
      const { events } = JSON.parse(String(init?.body))
      return events[0].track.id === 1 ? previousPost.promise : Response.json({})
    })
    const rec = optedInStore()
    const originalId = rec.ensureAnonId()
    rec.recordEvent({ type: 'favorite', track: { id: 1 } }, true)
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })

    const clearing = rec.clearAllRecommendationProfile()
    const duplicate = rec.clearAllRecommendationProfile()
    rec.recordEvent({ type: 'favorite', track: { id: 3 } }, true)
    window.dispatchEvent(new Event('pagehide'))
    expect(rec.buildRequestHeaders()).toEqual({ 'X-Sonic-Personalization': 'off' })
    expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['POST'])

    previousPost.finish(new Response(null, { status: 503 }))
    await vi.waitFor(() => expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']))
    expect(fetchSpy.mock.calls[1][1]?.headers).toMatchObject({
      'X-Sonic-Anon-Id': originalId,
      'X-Sonic-Erasure-Target': 'anonymous-opt-in',
    })
    deletion.finish(erasedProfile())
    expect(await clearing).toBe(true)
    expect(await duplicate).toBe(true)

    rec.recordEvent({ type: 'favorite', track: { id: 4 } })
    window.dispatchEvent(new Event('pagehide'))
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const post = fetchSpy.mock.calls[2][1]
    expect(post?.headers).toMatchObject({
      'X-Sonic-Anon-Id': rec.anonId,
      'X-Sonic-Event-Target': 'anonymous-opt-in',
    })
    expect(rec.anonId).not.toBe(originalId)
    expect(JSON.parse(String(post?.body))).not.toHaveProperty('eventEpoch')
    expect(JSON.parse(String(post?.body)).events.map((event: { track: { id: number } }) => event.track.id)).toEqual([4])
  })

  it('匿名或账号身份变化后不发送旧队列', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    const rec = optedInStore()
    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    localStorage.setItem(deviceKey, 'anon_replacement000001')
    await rec.flushEvents()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rec.anonId).toBe('anon_replacement000001')

    const auth = verifiedAccount('user-A')
    localStorage.setItem(accountEpochKey, JSON.stringify({ accountId: 'user-A', value: erasedEventEpoch }))
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    auth.user = null
    auth.isAuthenticated = false
    await rec.flushEvents()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('在途写入长时间无响应时不提交删除，可在写入完成后重试', async () => {
    vi.useFakeTimers()
    try {
      const pendingPost = delayedResponse()
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
        init?.method === 'DELETE' ? erasedProfile() : pendingPost.promise
      )
      const rec = optedInStore()
      const originalId = rec.ensureAnonId()
      rec.recordEvent({ type: 'favorite', track: { id: 1 } }, true)
      const first = rec.clearAllRecommendationProfile()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await first).toBe(false)
      expect(rec.anonId).toBe(originalId)
      expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['POST'])

      pendingPost.finish(Response.json({}))
      expect(await rec.clearAllRecommendationProfile()).toBe(true)
      expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('已有账号在关闭个性化后仍可清除服务端画像', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(erasedProfile('authenticated'))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(accountEpoch('user-B', null))
      .mockResolvedValue(Response.json({}))
    const rec = useRecommendStore()
    verifiedAccount('user-A')
    rec.setPersonalizationEnabled(false)
    expect(rec.anonId).toBe('')

    expect(await rec.clearAllRecommendationProfile()).toBe(true)
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ 'X-Sonic-Erasure-Target': 'account:user-A' })
    rec.setPersonalizationEnabled(true)
    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    await rec.flushEvents()
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({ eventEpoch: erasedEventEpoch })

    verifiedAccount('user-B')
    await rec.prepareAccountEventEpoch()
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    await rec.flushEvents()
    expect(JSON.parse(String(fetchSpy.mock.calls[3][1]?.body))).not.toHaveProperty('eventEpoch')
  })

  it('清除账号画像时不发送访客 ID，保留独立的访客画像标识', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(erasedProfile('authenticated'))
    const rec = optedInStore()
    const guestId = rec.ensureAnonId()
    verifiedAccount('user-A')

    expect(await rec.clearAllRecommendationProfile()).toBe(true)
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ 'X-Sonic-Erasure-Target': 'account:user-A' })
    expect(rec.anonId).toBe(guestId)
  })

  it('匿名画像清除需要服务端确认，普通 200 响应不能清除本地身份', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      brand: 'Sonic', data: { cleared: false, storageKind: 'memory', privacyMode: 'public', removedEvents: 0 },
    }))
    const rec = optedInStore()
    const originalId = rec.ensureAnonId()

    expect(await rec.clearAllRecommendationProfile()).toBe(false)
    expect(rec.anonId).toBe(originalId)
  })

  it('账号画像的成功响应不能确认访客画像删除', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(erasedProfile('authenticated'))
    const rec = optedInStore()
    const originalId = rec.ensureAnonId()
    rec.dislikeSong({ id: 1000, name: '保留', artist: '测试' })

    expect(await rec.clearAllRecommendationProfile()).toBe(false)
    expect(rec.anonId).toBe(originalId)
    expect(rec.dislikedCount).toBe(1)
  })

  it.each([502, 409])('事件发送遇到可重试的 HTTP %s 时整批回到队首', async (status) => {
    vi.useFakeTimers()
    try {
      const rec = optedInStore()

      const postCalls: Array<{ url: string; body?: string }> = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
        if (String(url).includes('/api/sonic/events') && init?.method !== 'DELETE') {
          postCalls.push({ url: String(url), body: init?.body })
          // 网关错误或非身份冲突失败，随后重试。
          return postCalls.length === 1
            ? Response.json({ brand: 'Sonic', error: { code: 'OTHER_ERROR' } }, { status })
            : new Response('{}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      })

      rec.recordEvent({ type: 'play_start', track: { id: 1, title: '晴天', artist: '周杰伦' } })
      await vi.advanceTimersByTimeAsync(1300)
      expect(postCalls.length).toBe(1)

      // 首次失败后新事件入队应触发重试,且批次包含上一轮失败的事件
      rec.recordEvent({ type: 'favorite', track: { id: 2, title: '夜曲', artist: '周杰伦' } })
      await vi.advanceTimersByTimeAsync(1300)
      expect(postCalls.length).toBe(2)

      const retryBody = JSON.parse(postCalls[1].body || '{}')
      const retriedTypes = (retryBody.events || []).map((e: any) => e.type)
      expect(retriedTypes).toContain('play_start')
      expect(retriedTypes).toContain('favorite')
    } finally {
      vi.useRealTimers()
    }
  })

  it('发送账户目标并丢弃服务端判定身份冲突的旧批次', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        brand: 'Sonic', error: { code: 'EVENT_INGEST_IDENTITY_MISMATCH' },
      }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ brand: 'Sonic', data: { accepted: 1 } }))
    const rec = optedInStore()
    verifiedAccount('user-A')
    localStorage.setItem(accountEpochKey, JSON.stringify({ accountId: 'user-A', value: erasedEventEpoch }))

    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    await rec.flushEvents()
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    await rec.flushEvents()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init).toMatchObject({ keepalive: true, headers: { 'X-Sonic-Event-Target': 'account:user-A' } })
    }
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).events.map((event: { track: { id: number } }) => event.track.id))
      .toEqual([2])
  })

  it('retains a confirmed clear marker across reload, and cached account display cannot authorize a lookup or send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(erasedProfile('authenticated'))
      .mockResolvedValueOnce(Response.json({}))
    const original = optedInStore()
    const account = verifiedAccount('user-A')
    expect(await original.clearAllRecommendationProfile()).toBe(true)

    setActivePinia(createPinia())
    const reload = useRecommendStore()
    const cached = useAuthStore()
    cached.user = account.user
    cached.isAuthenticated = true
    await reload.prepareAccountEventEpoch()
    reload.recordEvent({ type: 'favorite', track: { id: 1 } })
    await reload.flushEvents()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    verifiedAccount('user-A')
    reload.recordEvent({ type: 'favorite', track: { id: 2 } })
    await reload.flushEvents()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      eventEpoch: erasedEventEpoch, events: [{ track: { id: 2 } }],
    })
  })

  it('drops events captured before the verified marker, including a lookup that finishes after an account switch', async () => {
    const earlier = delayedResponse()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce(accountEpoch('user-B', erasedEventEpoch))
      .mockResolvedValueOnce(Response.json({}))
    const rec = optedInStore()
    verifiedAccount('user-A')
    const preparingA = rec.prepareAccountEventEpoch()
    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    verifiedAccount('user-B')
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    await rec.prepareAccountEventEpoch()
    earlier.finish(accountEpoch('user-A', 'b'.repeat(32)))
    await preparingA
    rec.recordEvent({ type: 'favorite', track: { id: 3 } })
    await rec.flushEvents()

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    for (const [index, id] of [[0, 'user-A'], [1, 'user-B']] as const) {
      expect(fetchSpy.mock.calls[index]).toEqual(['/api/sonic/events?view=event-epoch', {
        cache: 'no-store', headers: { 'X-Sonic-Event-Target': `account:${id}` },
      }])
    }
    expect(JSON.parse(String(fetchSpy.mock.calls[2][1]?.body))).toMatchObject({
      eventEpoch: erasedEventEpoch, events: [{ track: { id: 3 } }],
    })
  })

  it('画像已清除时丢弃待发与失败的旧上报，仅为新上报采用新代次', async () => {
    const conflict = delayedResponse()
    const previousPost = delayedResponse()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(conflict.promise)
      .mockReturnValueOnce(previousPost.promise)
      .mockResolvedValueOnce(Response.json({}))
    const rec = optedInStore()

    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    const first = rec.flushEvents()
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    const second = rec.flushEvents()
    rec.recordEvent({ type: 'favorite', track: { id: 3 } })

    conflict.finish(epochMismatch(erasedEventEpoch))
    await first
    rec.recordEvent({ type: 'favorite', track: { id: 4 } })
    previousPost.finish(new Response(null, { status: 503 }))
    await second
    await rec.flushEvents()

    const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).not.toHaveProperty('eventEpoch')
    expect(bodies[1]).not.toHaveProperty('eventEpoch')
    expect(bodies[2]).toMatchObject({
      eventEpoch: erasedEventEpoch,
      events: [{ type: 'favorite', track: { id: 4 } }],
    })
  })

  it.each([
    [erasedEventEpoch, 'authenticated'],
    ['invalid-marker', 'anonymous-opt-in'],
  ])('拒绝采用其他身份或无效的画像代次', async (eventEpoch, mode) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(epochMismatch(eventEpoch, mode))
      .mockResolvedValueOnce(Response.json({}))
    const rec = optedInStore()

    rec.recordEvent({ type: 'favorite', track: { id: 1 } })
    await rec.flushEvents()
    rec.recordEvent({ type: 'favorite', track: { id: 2 } })
    await rec.flushEvents()

    const body = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))
    expect(body).not.toHaveProperty('eventEpoch')
    expect(body.events).toMatchObject([{ type: 'favorite', track: { id: 2 } }])
  })

  it('关闭个性化后 recordEvent 完全不产生网络上报', async () => {
    vi.useFakeTimers()
    try {
      const rec = useRecommendStore()
      expect(rec.personalizationEnabled).toBe(false)
      const fetchMock = vi.spyOn(globalThis, 'fetch')

      rec.recordEvent({ type: 'favorite', track: { id: 3, title: '演员', artist: '薛之谦' } })
      await vi.advanceTimersByTimeAsync(2000)

      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/sonic/events'))
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

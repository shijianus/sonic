import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { classifyPlaybackError } from '@/stores/modules/audio'
import type { Song } from '@/stores/interface'

vi.mock('@/utils/gatewayHealth', () => ({
  inspectGatewayHeaders: vi.fn(),
  markStreamFailure: vi.fn(),
  gatewayHealth: { degraded: false, statusKind: 'normal', message: '' },
}))

const mediaError = (code: number) => ({ code }) as MediaError

describe('播放错误分类', () => {
  it('网络错误归为 network', () => {
    expect(classifyPlaybackError(mediaError(2))).toBe('network')
    expect(classifyPlaybackError(new Error('network timeout'))).toBe('network')
  })

  it('解码/媒体源解析失败归为 source', () => {
    expect(classifyPlaybackError(mediaError(3))).toBe('source')
  })

  it('源不支持或 403/404 归为版权受限', () => {
    expect(classifyPlaybackError(mediaError(4))).toBe('copyright')
    expect(classifyPlaybackError(new Error('HTTP 403'))).toBe('copyright')
    expect(classifyPlaybackError(new Error('copyright restricted'))).toBe('copyright')
  })
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('播放错误 HTTP 诊断', () => {
  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const setup = async () => {
    const { useAudioStore } = await import('@/stores/modules/audio')
    const gateway = await import('@/utils/gatewayHealth')
    const { default: i18n } = await import('@/languages')
    i18n.global.locale.value = 'en'
    vi.mocked(gateway.markStreamFailure).mockClear()
    vi.mocked(gateway.inspectGatewayHeaders).mockClear()
    const store = useAudioStore()
    const audio = document.createElement('audio')
    audio.src = '/api/music/stream?id=diagnostic'
    Object.defineProperty(audio, 'error', { configurable: true, value: { code: 4 } })
    const listeners = vi.spyOn(audio, 'addEventListener')
    store.audio.audio = audio
    // A local fixture bypasses failover, exercising the exact exhausted-source diagnosis path.
    store.audio.currentSong = { id: 'diagnostic', name: 'Diagnostic', artist: 'Fixture', isLocal: true, url: audio.src } as Song
    store.setupAudioEvents()
    const listener = listeners.mock.calls.find(([event]) => event === 'error')![1] as (event: Event) => Promise<void>
    const report = vi.spyOn(store, '_reportPlaybackError').mockImplementation(() => {})
    vi.spyOn(audio, 'pause').mockImplementation(() => {})
    vi.spyOn(audio, 'load').mockImplementation(() => {})
    return { store, audio, report, gateway, i18n, diagnose: () => listener(new Event('error')) }
  }

  const response = (status: number) => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    return { cancel, value: { status, headers: new Headers(), body: { cancel } } as unknown as Response }
  }

  it('503 报降级、404 保持曲目不可用，并在每条状态分支释放响应体', async () => {
    const { diagnose, report, gateway } = await setup()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const [status, message, kind] of [
      [503, 'The music service is degraded. Please retry later.', 'stream-degraded-fail'],
      [404, '当前曲目暂无可用音源或受版权限制', 'track-fail'],
      [429, 'The music service is busy (rate limited). Please retry in a moment.', null],
      [403, 'This track is unavailable due to copyright restrictions.', null],
    ] as const) {
      const res = response(status)
      fetchMock.mockResolvedValueOnce(res.value)
      await diagnose()
      expect(report).toHaveBeenLastCalledWith(expect.any(Event), message)
      expect(res.cancel).toHaveBeenCalledOnce()
      if (kind) expect(gateway.markStreamFailure).toHaveBeenLastCalledWith(kind, message)
    }
  })

  it.each([
    ['zh', '服务暂时降级，请稍后重试'],
    ['en', 'The music service is degraded. Please retry later.'],
    ['ja', '音楽サービスが一時的に制限されています。しばらくしてから再試行してください。'],
  ] as const)('503 在 %s 显示实际翻译而非原始key', async (locale, message) => {
    const { i18n, diagnose, report } = await setup()
    i18n.global.locale.value = locale
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503).value))
    await diagnose()
    expect(report).toHaveBeenLastCalledWith(expect.any(Event), message)
    expect(message).not.toContain('player.playbackError')
  })

  it('同曲停止后迟到的503不覆盖状态，同时取消旧响应体', async () => {
    const { store, diagnose, report, gateway } = await setup()
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    const diagnosis = diagnose()
    store.stop() // Keeps the same song ID but invalidates its playback generation.
    const res = response(503)
    pending.resolve(res.value)
    await diagnosis
    expect(report).not.toHaveBeenCalled()
    expect(gateway.inspectGatewayHeaders).not.toHaveBeenCalled()
    expect(gateway.markStreamFailure).not.toHaveBeenCalled()
    expect(res.cancel).toHaveBeenCalledOnce()
  })

  it('诊断挂起在5秒内取消并给出网络错误', async () => {
    const { diagnose, report } = await setup()
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms)
      return controller.signal
    })
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })))
    const diagnosis = diagnose()
    await vi.advanceTimersByTimeAsync(5000)
    await diagnosis
    expect(controller.signal.aborted).toBe(true)
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'network fetch failed' }))
  })

  it('停止后的旧诊断网络异常不污染新代次', async () => {
    const { store, diagnose, report } = await setup()
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise))
    const diagnosis = diagnose()
    store.stop()
    pending.reject(new TypeError('Failed to fetch'))
    await diagnosis
    expect(report).not.toHaveBeenCalled()
  })
})

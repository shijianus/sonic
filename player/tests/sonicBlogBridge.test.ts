import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('sonic blog bridge origin allowlist', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.VITE_SONIC_BRIDGE_ORIGINS = 'https://blog.example.com'
  })

  afterEach(() => {
    delete process.env.VITE_SONIC_BRIDGE_ORIGINS
    vi.restoreAllMocks()
    Object.defineProperty(window, 'opener', { configurable: true, value: null })
  })

  it('rejects unauthorized origins and never broadcasts with a wildcard target', async () => {
    const { sonicBlogBridge } = await import('../src/utils/sonicBlogBridge')
    const handler = vi.fn()
    const off = sonicBlogBridge.onCommand(handler)
    sonicBlogBridge.init()

    window.dispatchEvent(new MessageEvent('message', {
      data: { source: 'shijianus-music-pocket', action: 'PAUSE', timestamp: 1 },
      origin: 'https://evil.example',
    }))
    expect(handler).not.toHaveBeenCalled()

    window.dispatchEvent(new MessageEvent('message', {
      data: { source: 'shijianus-music-pocket', action: 'PAUSE', timestamp: 2 },
      origin: 'https://blog.example.com',
    }))
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAUSE' }))

    const opener = { postMessage: vi.fn() }
    Object.defineProperty(window, 'opener', { configurable: true, value: opener })
    sonicBlogBridge.broadcastPlayback({ isPlaying: true, currentTime: 1, duration: 10 })

    expect(opener.postMessage).toHaveBeenCalled()
    const targets = opener.postMessage.mock.calls.map((call) => call[1])
    expect(targets).toContain('https://blog.example.com')
    expect(targets).not.toContain('*')
    off()
  })
})

import { describe, expect, it } from 'vitest'
import { sanitizeHref, sanitizeImageSrc, sanitizeMediaSrc } from '@/utils/urlSafety'

describe('URL attribute sanitization', () => {
  it('keeps root-relative application paths', () => {
    expect(sanitizeHref('/song/123?x=1')).toBe('/song/123?x=1')
    expect(sanitizeImageSrc('/api/music/cover?id=1')).toBe('/api/music/cover?id=1')
    expect(sanitizeMediaSrc('/api/music/stream?id=1')).toBe('/api/music/stream?id=1')
  })

  it('allows http(s), blob and image data URLs for media sinks', () => {
    expect(sanitizeImageSrc('https://p1.music.126.net/a.jpg')).toBe('https://p1.music.126.net/a.jpg')
    expect(sanitizeMediaSrc('https://cdn.example.com/a.mp3')).toBe('https://cdn.example.com/a.mp3')
    expect(sanitizeImageSrc('blob:https://sonic.example/123')).toBe('blob:https://sonic.example/123')
    expect(sanitizeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('rejects script, HTML and protocol-relative URLs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBe('/')
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBe('/')
    expect(sanitizeHref('//evil.example/path')).toBe('/')
    expect(sanitizeImageSrc('javascript:alert(1)')).toBe('')
    expect(sanitizeImageSrc('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(sanitizeImageSrc('//evil.example/x.png')).toBe('')
    expect(sanitizeMediaSrc('javascript:alert(1)')).toBe('')
    expect(sanitizeMediaSrc('data:text/html,<script>alert(1)</script>')).toBe('')
  })

  it('strips control characters before deciding', () => {
    expect(sanitizeHref('java\nscript:alert(1)')).toBe('/')
    expect(sanitizeImageSrc(' https://p1.music.126.net/a.jpg ')).toBe('https://p1.music.126.net/a.jpg')
  })
})

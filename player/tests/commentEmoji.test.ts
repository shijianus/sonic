import { describe, it, expect } from 'vitest'
import { parseCommentEmoji, extractExpressionUrl } from '../src/utils/commentEmoji'

describe('Comment Emoji Parser', () => {
  it('converts bracket emojis into Unicode emoji characters', () => {
    expect(parseCommentEmoji('[憨笑]')).toBe('😄')
    expect(parseCommentEmoji('太好听了[爱心][点赞]')).toBe('太好听了❤️👍')
    expect(parseCommentEmoji('不好意思还有草东的 丑  鬼 在 等[奸笑]')).toBe(
      '不好意思还有草东的 丑  鬼 在 等😈'
    )
    expect(parseCommentEmoji('[流泪][心碎] 听哭了')).toBe('😭💔 听哭了')
    expect(parseCommentEmoji('[狗头] 妙啊 [妙啊]')).toBe('🐶 妙啊 ✨')
    expect(parseCommentEmoji('[捂脸][笑哭][破防]')).toBe('🤦😂💔')
  })

  it('intelligently handles unmapped emoji codes and avoids raw square brackets', () => {
    // 带有情绪关键词的复合未收录表情码
    expect(parseCommentEmoji('[暴风哭泣]')).toBe('😭')
    expect(parseCommentEmoji('[狂笑不止]')).toBe('😄')
    expect(parseCommentEmoji('[心动动]')).toBe('❤️')
    expect(parseCommentEmoji('[超绝点赞]')).toBe('👍')
    expect(parseCommentEmoji('[未知表情测试]')).toBe('✨')
    // 确保没有残留方括号
    expect(parseCommentEmoji('[某种未知表情]')).not.toContain('[')
    expect(parseCommentEmoji('[某种未知表情]')).not.toContain(']')
    expect(parseCommentEmoji('')).toBe('')
    expect(parseCommentEmoji(undefined)).toBe('')
  })

  it('extracts expressionUrl correctly', () => {
    expect(extractExpressionUrl({ expressionUrl: 'https://example.com/sticker.png' })).toBe(
      'https://example.com/sticker.png'
    )
    expect(
      extractExpressionUrl({
        contentResource: { expressionUrl: 'https://example.com/res.png' },
      })
    ).toBe('https://example.com/res.png')
    expect(extractExpressionUrl({})).toBeNull()
    expect(extractExpressionUrl(null)).toBeNull()
  })
})

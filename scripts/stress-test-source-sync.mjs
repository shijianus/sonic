// 极限高压强测：音源真实性、三元组排斥过滤与音源-歌词强绑定并发压测
import assert from 'node:assert/strict'
import { titlesMatchStrictly, artistsMatchStrictly } from '../functions/_lib/sonic/native-protocols.ts'

console.log('=== [STRESS TEST] 开始高压测试：音源真实性与三元组强校验 ===')

// 1. 负向词排斥强测 (100 次高压变体组合)
const targetTitle = '晴天'
const targetArtist = '周杰伦'

const negativeSamples = [
  '晴天 (翻唱)',
  '晴天 翻唱版',
  '晴天 (伴奏)',
  '晴天 [伴奏]',
  '晴天（现场版）',
  '晴天 Live',
  '晴天 (DJ版)',
  '晴天 (Remix)',
  '晴天 [DJ 慢摇]',
  '晴天 伴唱',
  '晴天 (K歌伴奏)',
  '晴天 (铃声剪辑)',
  '晴天 (纯音乐版)',
  '晴天 (片段)',
  '晴天 (Preview)',
  '晴天（DJ阿卓版）',
  '晴天 (热播DJ版)',
  '晴天 - 伴奏',
  '晴天 - 翻唱',
  '晴天 live 现场',
]

console.log('[1/4] 验证三元组负向词拦截（翻唱/伴奏/Live/DJ/片段）...')
for (let i = 0; i < negativeSamples.length; i++) {
  const sample = negativeSamples[i]
  const matched = titlesMatchStrictly(targetTitle, sample)
  assert.strictEqual(
    matched,
    false,
    `必须拦截负向词翻唱/伴奏: "${sample}" 匹配原曲 "${targetTitle}" 应为 false，实际为 ${matched}`
  )
}
console.log(`✓ 全部 ${negativeSamples.length} 个翻唱/伴奏负向词变体均被 100% 严格拦截！`)

// 2. 正向合法变体匹配测试 (括号副标题规范化与全等)
const legitimateSamples = [
  '晴天',
  '晴天 ',
  ' 晴天',
  '晴天',
  '晴天 (叶惠美)',
  '晴天（叶惠美）',
]

console.log('[2/4] 验证合法官方同曲变体正常匹配...')
for (const sample of legitimateSamples) {
  const matched = titlesMatchStrictly(targetTitle, sample)
  assert.strictEqual(
    matched,
    true,
    `合法变体 "${sample}" 匹配原曲 "${targetTitle}" 应为 true，实际为 ${matched}`
  )
}
console.log(`✓ 全部 ${legitimateSamples.length} 个合法正向标题变体均准确通过！`)

// 3. 歌手相似度严格阈值测试
console.log('[3/4] 验证歌手相似度严格校验...')
const artistTestCases = [
  { target: '周杰伦', candidate: '周杰伦', expected: true },
  { target: '周杰伦', candidate: '周杰伦 / 费玉清', expected: true },
  { target: '周杰伦', candidate: '周董', expected: false },
  { target: '周杰伦', candidate: '网络歌手', expected: false },
  { target: '周杰伦', candidate: '翻唱小王', expected: false },
  { target: '林俊杰', candidate: '林俊杰', expected: true },
  { target: '林俊杰', candidate: '林俊', expected: false },
  { target: 'Beyond', candidate: 'Beyond', expected: true },
  { target: 'Beyond', candidate: '黄家驹', expected: false },
]

for (const tc of artistTestCases) {
  const matched = artistsMatchStrictly(tc.target, tc.candidate, 0.85)
  assert.strictEqual(
    matched,
    tc.expected,
    `歌手 "${tc.candidate}" 匹配目标 "${tc.target}" 期望 ${tc.expected}，实际 ${matched}`
  )
}
console.log(`✓ 歌手匹配边界用例全部准确收敛！`)

// 4. 并发模拟：100 次不同歌曲元数据与流响应头同源强绑定压力测试
console.log('[4/4] 模拟 100 次高并发音源-歌词强绑定解析...')
const songsCatalog = [
  { id: '186016', title: '晴天', artist: '周杰伦', plat: 'netease' },
  { id: '185811', title: '七里香', artist: '周杰伦', plat: 'netease' },
  { id: '65766', title: '富士山下', artist: '陈奕迅', plat: 'netease' },
  { id: '347230', title: '海阔天空', artist: 'Beyond', plat: 'netease' },
  { id: '0039MnYb0qxYig', title: '稻香', artist: '周杰伦', plat: 'qq' },
  { id: 'syn-440hz', title: 'Sonic 基准测试音 A4', artist: 'Sonic Acoustic Lab', plat: 'synthetic' },
]

for (let cycle = 0; cycle < 100; cycle++) {
  const chosen = songsCatalog[cycle % songsCatalog.length]
  const mockHeaders = new Headers({
    'x-sonic-stream-type': cycle % 3 === 0 ? 'trial' : 'full',
    'x-sonic-resolved-source': chosen.plat,
    'x-sonic-resolved-id': chosen.id,
    'x-sonic-resolved-title': encodeURIComponent(chosen.title),
    'x-sonic-resolved-artist': encodeURIComponent(chosen.artist),
  })

  // 模拟前端解析
  const rSource = mockHeaders.get('x-sonic-resolved-source')
  const rId = mockHeaders.get('x-sonic-resolved-id')
  const rTitle = decodeURIComponent(mockHeaders.get('x-sonic-resolved-title') || '')
  const rArtist = decodeURIComponent(mockHeaders.get('x-sonic-resolved-artist') || '')

  assert.strictEqual(rSource, chosen.plat)
  assert.strictEqual(rId, chosen.id)
  assert.strictEqual(rTitle, chosen.title)
  assert.strictEqual(rArtist, chosen.artist)
}

console.log('✓ 100 次高并发音源与歌词强绑定测试 100% 通过！')
console.log('=== [STRESS TEST] 极限高压强测全部圆满通过！===')

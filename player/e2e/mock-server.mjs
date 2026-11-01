/**
 * Sonic 前端 E2E 专用本地服务器。
 *
 * 作用：
 *  1. 静态托管 `player/dist`（hash 路由，无需 SPA fallback）；
 *  2. 以确定性 Mock 实现 `/api/**`，让浏览器测试可复现；
 *  3. 提供真实可解码的 20 秒 WAV 音频，用于播放/暂停/切歌/Seek 的真实媒体元素验证。
 *
 * 明确边界：这里模拟的是前端与网关之间的 HTTP 契约，**不是**真实 CDN、真实 OAuth、
 * 真实上游音源或生产流代理。真实链路验收必须在 Staging 另行执行。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, '../dist')
const PORT = Number(process.env.E2E_PORT || 4173)
const HOST = '127.0.0.1'

// ── 音频夹具：20s / 8kHz / 8-bit mono PCM WAV，正弦波 ───────────────────────
const WAV_SECONDS = 20
const SAMPLE_RATE = 8000
const WAV_DATA_SIZE = WAV_SECONDS * SAMPLE_RATE
const wav = Buffer.alloc(44 + WAV_DATA_SIZE)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + WAV_DATA_SIZE, 4)
wav.write('WAVE', 8)
wav.write('fmt ', 12)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20) // PCM
wav.writeUInt16LE(1, 22) // mono
wav.writeUInt32LE(SAMPLE_RATE, 24)
wav.writeUInt32LE(SAMPLE_RATE, 28)
wav.writeUInt16LE(1, 32)
wav.writeUInt16LE(8, 34)
wav.write('data', 36)
wav.writeUInt32LE(WAV_DATA_SIZE, 40)
for (let i = 0; i < WAV_DATA_SIZE; i++) {
  const v = Math.round(128 + 32 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE))
  wav[44 + i] = Math.max(0, Math.min(255, v))
}

// ── 曲目夹具 ───────────────────────────────────────────────────────────────
const SONG_META = {
  9001: { name: 'Test Song One', artist: 'Tester A' },
  9002: { name: 'Test Song Two', artist: 'Tester B' },
  9003: { name: 'Test Song Three', artist: 'Tester C' },
  9004: { name: 'Test Song Four', artist: 'Tester D' },
  9200: { name: 'Instrumental Track', artist: 'Tester E' },
  9201: { name: 'No Lyric Track', artist: 'Tester F' },
  9303: { name: 'Forbidden Track', artist: 'Tester G' },
  9304: { name: 'Rate Limited Track', artist: 'Tester H' },
  9305: { name: 'Network Drop Track', artist: 'Tester I' },
  9306: { name: 'Hanging Stream Track', artist: 'Tester J' },
  9307: { name: 'Missing Stream Track', artist: 'Tester K' },
  9308: { name: 'Degraded Stream Track', artist: 'Tester L' },
}

const track = id => ({
  platformId: String(id),
  title: SONG_META[id]?.name || `Track ${id}`,
  artist: SONG_META[id]?.artist || 'Tester',
  album: 'E2E Album',
  duration: WAV_SECONDS * 1000,
  cover: '',
  streamUrl: `/api/music/stream?id=${id}`,
})

const neteaseSong = id => ({
  id: Number(id),
  name: SONG_META[id]?.name || `Track ${id}`,
  ar: [{ id: 1, name: SONG_META[id]?.artist || 'Tester' }],
  al: { id: 1, name: 'E2E Album', picUrl: '' },
  dt: WAV_SECONDS * 1000,
})

const SEARCH_FIXTURES = {
  sonic: [9001, 9002, 9003, 9004],
  restricted: [9303, 9304, 9305],
  errors: [9306, 9307, 9308],
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 响应工具 ───────────────────────────────────────────────────────────────
const sendJson = (res, body, status = 200, extraHeaders = {}) => {
  if (res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

const sendAudio = (req, res) => {
  const range = req.headers.range
  const headers = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Sonic-Stream-Type': 'full',
  }
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    let start = m && m[1] ? Number(m[1]) : 0
    let end = m && m[2] ? Number(m[2]) : wav.length - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${wav.length}` })
      res.end()
      return
    }
    end = Math.min(end, wav.length - 1)
    const chunk = wav.subarray(start, end + 1)
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${wav.length}`,
      'Content-Length': chunk.length,
    })
    res.end(req.method === 'HEAD' ? undefined : chunk)
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': wav.length })
  res.end(req.method === 'HEAD' ? undefined : wav)
}

// ── API 路由 ───────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const p = url.pathname
  const q = url.searchParams

  if (p === '/api/sonic/engine/health') return sendJson(res, { ok: true, storageKind: 'memory' })

  if (p === '/api/sonic/search/smart') {
    if (q.get('mode') === 'suggest') return sendJson(res, { data: { suggestions: [] } })
    const term = (q.get('q') || '').trim()
    if (term === 'ratelimited') {
      return sendJson(res, { error: { code: 'RATE_LIMITED' } }, 429, { 'Retry-After': '2' })
    }
    if (term === 'forbidden') return sendJson(res, { error: { code: 'FORBIDDEN' } }, 403)
    if (term === 'offline') {
      res.destroy()
      return
    }
    if (term === 'malformed') {
      return sendJson(res, { data: { tracks: 'not-an-array', total: 'NaN' }, meta: null })
    }
    // slow 用于验证“旧搜索请求晚到不覆盖新结果”
    if (term === 'slow') await sleep(1200)
    const ids = SEARCH_FIXTURES[term] || (term === 'empty' ? [] : [9001, 9002, 9003, 9004])
    return sendJson(res, {
      data: {
        query: term,
        total: ids.length,
        tracks: ids.map(track),
        suggestions: [],
        personalizedApplied: false,
      },
    })
  }

  if (p === '/api/sonic/search/nexus') {
    return sendJson(res, { data: { tracks: [], total: 0 } })
  }

  if (p === '/api/cloudsearch' || p === '/api/search') {
    const term = (q.get('keywords') || q.get('q') || '').trim()
    if (term === 'forbidden') return sendJson(res, { error: { code: 'FORBIDDEN' } }, 403)
    if (term === 'ratelimited') return sendJson(res, { error: { code: 'RATE_LIMITED' } }, 429)
    if (term === 'offline') {
      res.destroy()
      return
    }
    const ids =
      term === 'empty' || term === 'malformed'
        ? []
        : SEARCH_FIXTURES[term] || [9001, 9002, 9003, 9004]
    return sendJson(res, {
      result: { songs: ids.map(neteaseSong), songCount: ids.length },
      code: 200,
    })
  }

  if (p === '/api/song/url/v1' || p === '/api/song/url') {
    const id = q.get('id') || ''
    // 9001 故意慢返回：用于“取流中暂停”和“快速切歌”竞态验证
    if (id === '9001') await sleep(900)
    if (id === '9304') {
      return sendJson(res, { error: { code: 'RATE_LIMITED' } }, 429, { 'Retry-After': '2' })
    }
    return sendJson(res, { data: [{ url: `/api/music/stream?id=${id}` }] })
  }

  if (p === '/api/music/stream') {
    const id = q.get('id') || ''
    if (process.env.E2E_DEBUG) console.log('[mock] stream', id, req.headers.range || '-')
    if (id === '9303') return sendJson(res, { error: { code: 'COPYRIGHT' } }, 403)
    if (id === '9304') {
      return sendJson(res, { error: { code: 'RATE_LIMITED' } }, 429, { 'Retry-After': '2' })
    }
    if (id === '9305') {
      res.destroy()
      return
    }
    // 9306：返回合法响应头后永不发送音频数据，模拟上游“挂起不响应”。
    if (id === '9306') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      })
      return
    }
    if (id === '9307') {
      return sendJson(res, { error: { code: 'TRACK_NOT_FOUND' } }, 404)
    }
    if (id === '9308') {
      return sendJson(res, { error: { code: 'STREAM_UNAVAILABLE_DEGRADED' }, degraded: true }, 503, {
        'X-Sonic-Degraded': '1',
      })
    }
    if (id === '9001') await sleep(600)
    return sendAudio(req, res)
  }

  if (p === '/api/sonic/lyrics/nexus') {
    const platformId = q.get('platformId') || ''
    const title = q.get('title') || 'Track'
    if (platformId === '9200') return sendJson(res, { brand: 'Sonic', data: { instrumental: true } })
    if (platformId === '9201') return sendJson(res, { brand: 'Sonic', data: {} })
    return sendJson(res, {
      brand: 'Sonic',
      data: {
        syncedLyrics: [0, 3, 6, 9, 12, 15].map((startMs, i) => ({
          startMs,
          text: `${title} line ${i + 1}`,
        })),
      },
    })
  }

  if (p === '/api/music/lyric') {
    if ((q.get('id') || '') === '9201') return sendJson(res, { error: 'lyrics unavailable' }, 500)
    return sendJson(res, { lines: [] })
  }

  if (p === '/api/lyric') {
    return sendJson(res, { lrc: { lyric: '' } })
  }

  if (p === '/api/playlist/detail') {
    return sendJson(res, {
      playlist: {
        id: Number(q.get('id') || 123),
        name: 'E2E Playlist',
        description: 'Deterministic playlist fixture',
        creator: { nickname: 'E2E Tester', avatarUrl: '' },
        trackCount: 6,
        playCount: 1234,
        coverImgUrl: '',
        tags: ['e2e'],
      },
    })
  }

  if (p === '/api/playlist/track/all') {
    const ids = [9001, 9002, 9003, 9004, 9200, 9201]
    return sendJson(res, { songs: ids.map(neteaseSong), songCount: ids.length })
  }

  if (p === '/api/sonic/events') {
    return sendJson(res, { accepted: 1, stored: 1 })
  }

  if (p === '/api/sonic/recommend/for-you' || p === '/api/sonic/recommend/trending' ||
      p === '/api/sonic/recommend/discover' || p === '/api/sonic/recommend/similar') {
    return sendJson(res, {
      data: {
        tracks: [],
        personalized: false,
        privacyMode: 'public',
        window: '7d',
        stationStats: { activeTracksWithPlays: 0, totalCatalogTracks: 0 },
        availableGenres: [],
      },
      meta: {},
    })
  }

  if (p === '/api/album') {
    const id = Number(q.get('id') || 1)
    const ids = [9001, 9002, 9003, 9004]
    const songs = ids.map(neteaseSong)
    return sendJson(res, {
      code: 200,
      album: {
        id,
        name: 'E2E Test Album',
        picUrl: '',
        publishTime: 1672531199000,
        size: songs.length,
        description: 'Deterministic album fixture',
        artist: { id: 1, name: 'Tester A' },
      },
      songs,
    })
  }

  if (p === '/api/album/new') {
    return sendJson(res, {
      code: 200,
      albums: [
        {
          id: 406521987,
          name: 'New Album Fixture',
          picUrl: '',
          publishTime: 1672531199000,
          artist: { id: 1, name: 'Tester A' },
          size: 4,
        },
      ],
    })
  }

  if (p === '/api/banner') return sendJson(res, { banners: [] })
  if (p === '/api/top/playlist') return sendJson(res, { playlists: [] })
  if (p === '/api/top/song') return sendJson(res, { data: [] })
  if (p === '/api/top/artists') return sendJson(res, { artists: [] })
  if (p === '/api/personalized/mv') return sendJson(res, { result: [] })
  if (p === '/api/mv/all') {
    const type = url.searchParams.get('type') || ''
    const allMVs = [
      {
        id: 10880673,
        name: '起风了 (电视剧《加油你是最棒的》主题曲)',
        artistName: '吴青峰',
        duration: 303000,
        playCount: 7692718,
        cover: '/static/covers/cover-1.jpg',
        tag: '精选',
        publishTime: '2019-07-26',
        desc: '2019年度热单吴青峰《起风了》正式版MV，“纵使疾风起，人生不言弃”。',
        briefDesc: '吴青峰热单《起风了》MV公开！',
      },
      {
        id: 5308076,
        name: '关键词 (实验专辑《和自己对话》第三波主打)',
        artistName: '林俊杰',
        duration: 257090,
        playCount: 18350842,
        cover: '/static/covers/cover-2.jpg',
        tag: '官方版',
        publishTime: '2015-12-25',
        desc: '林俊杰2015年实验专辑《和自己对话》第三波温情主打，用琴键与声线描绘心底最深处的感动。',
        briefDesc: '林俊杰经典治愈系单曲。',
      },
      {
        id: 5581237,
        name: '清白之年 (跨界歌王 现场版)',
        artistName: '王珞丹 / 朴树',
        duration: 265900,
        playCount: 4187058,
        cover: '/static/covers/cover-3.jpg',
        tag: '现场版',
        publishTime: '2017-07-01',
        desc: '《清白之年》现场合作版，历尽千帆，归来仍是少年。',
        briefDesc: '历尽千帆，归来仍是少年。',
      },
      {
        id: 10989376,
        name: '超级面对面 第230期 辣目洋子',
        artistName: '辣目洋子',
        duration: 890000,
        playCount: 1598844,
        cover: '/static/covers/cover-4.jpg',
        tag: 'Sonic 甄选',
        publishTime: '2020-12-11',
        desc: '辣目洋子：我为什么要撕掉网红标签？做最真实的自己。',
        briefDesc: '深度人物专访与音乐故事。',
      },
      {
        id: 14689667,
        name: '早发白帝城 (诗画中国 第2季)',
        artistName: '许嵩',
        duration: 240000,
        playCount: 2765012,
        cover: '/static/covers/cover-5.jpg',
        tag: '最新',
        publishTime: '2024-01-14',
        desc: '许嵩倾情献唱央视《诗画中国》，以古韵悠长的歌声重现李白轻舟已过万重山的豪迈诗意。',
        briefDesc: '轻舟已过万重山。',
      },
    ]

    let filtered = allMVs
    if (type === '现场版' || type === '现场') {
      filtered = [
        allMVs[2],
        {
          id: 14292978,
          name: 'Elemma (现场版 - 乌鲁木齐音乐节)',
          artistName: 'Mustafa Abdulla',
          duration: 310000,
          playCount: 520410,
          cover: '/static/covers/cover-1.jpg',
          tag: '现场版',
          publishTime: '2021-03-15',
          desc: '丝路音乐节热力震撼现场，民族旋律与现代编曲交织。',
          briefDesc: '震撼现场Live呈现。',
        },
        {
          id: 14506286,
          name: '成都小酒馆25周年现场 - 声音玩具《虎口脱险》',
          artistName: '成都小酒馆LittleBar',
          duration: 285000,
          playCount: 891200,
          cover: '/static/covers/cover-2.jpg',
          tag: '现场版',
          publishTime: '2022-04-18',
          desc: '成都小酒馆25周年特别纪念现场，声音玩具乐队深情演绎经典。',
          briefDesc: '小酒馆纪念专场。',
        },
      ]
    } else if (type === '官方版' || type === '官方') {
      filtered = [
        allMVs[1],
        {
          id: 218008,
          name: '倔强 (鸟巢官方版 现场巡演)',
          artistName: '五月天',
          duration: 274000,
          playCount: 12450000,
          cover: '/static/covers/cover-3.jpg',
          tag: '官方版',
          publishTime: '2014-01-03',
          desc: '五月天代表作《倔强》鸟巢官方MV，万人大合唱感动全场。',
          briefDesc: '五月天热血青春之歌。',
        },
        {
          id: 5567192,
          name: "There's Nothing Holdin' Me Back (Official MV)",
          artistName: 'Shawn Mendes',
          duration: 220000,
          playCount: 38200000,
          cover: '/static/covers/cover-4.jpg',
          tag: '官方版',
          publishTime: '2017-06-21',
          desc: '萌德全球大热单曲官方MV，高能节奏与浪漫视觉。',
          briefDesc: 'Shawn Mendes 热门官方录像带。',
        },
      ]
    } else if (type === '网易出品' || type === 'netease') {
      filtered = [
        allMVs[3],
        {
          id: 10973136,
          name: '超级面对面 第229期 陈奕迅：我是树上一只懒懒的豹',
          artistName: '陈奕迅',
          duration: 940000,
          playCount: 2410000,
          cover: '/static/covers/cover-5.jpg',
          tag: 'Sonic 甄选',
          publishTime: '2020-11-26',
          desc: '歌神陈奕迅独家深度对话，聊音乐、聊生活与当下感悟。',
          briefDesc: 'Sonic 独家面对面。',
        },
        {
          id: 10968259,
          name: '音乐好朋友3 EP06 沈以诚 & 刘瑞琦: “深夜食堂”限时营业',
          artistName: '沈以诚 / 刘瑞琦',
          duration: 720000,
          playCount: 1880000,
          cover: '/static/covers/cover-1.jpg',
          tag: 'Sonic 甄选',
          publishTime: '2020-10-15',
          desc: '两位唱作人相遇合作，温暖声线治愈每个孤独灵魂。',
          briefDesc: '音乐好朋友特别企划。',
        },
      ]
    } else if (type === '最新') {
      filtered = [
        allMVs[4],
        {
          id: 14690387,
          name: '你走你的路 (全新录音室版)',
          artistName: '汪峰',
          duration: 260000,
          playCount: 1450000,
          cover: '/static/covers/cover-2.jpg',
          tag: '最新',
          publishTime: '2024-01-12',
          desc: '汪峰2024年度最新单曲MV，以坚毅从容的态度面对岁月沧桑。',
          briefDesc: '汪峰全新单曲发布。',
        },
        {
          id: 14690391,
          name: 'Dusk Till Dawn (Cover Version)',
          artistName: '刘逸云 Amber Liu',
          duration: 235000,
          playCount: 980000,
          cover: '/static/covers/cover-3.jpg',
          tag: '最新',
          publishTime: '2024-01-15',
          desc: 'Amber Liu 最新倾心翻唱巨作，充满力量感的声音叙事。',
          briefDesc: 'Amber 全新力作。',
        },
      ]
    }

    return sendJson(res, {
      code: 200,
      brand: 'Sonic',
      data: filtered,
      hasMore: false,
      count: filtered.length,
    })
  }
  if (p === '/api/mv/detail') {
    const id = url.searchParams.get('mvid') || url.searchParams.get('id') || '10880673'
    return sendJson(res, {
      code: 200,
      brand: 'Sonic',
      data: {
        id: Number(id),
        name: '起风了',
        artistName: '吴青峰',
        publishTime: '2019-07-26',
        playCount: 7692718,
        duration: 303000,
        desc: '2019年度热单吴青峰《起风了》正式版MV，“纵使疾风起，人生不言弃”。',
        briefDesc: '吴青峰热单《起风了》MV公开！',
      },
    })
  }
  if (p === '/api/search/hot/detail') return sendJson(res, { data: [{ searchWord: 'sonic', score: 100 }] })
  if (p === '/api/search/default') return sendJson(res, { data: { showKeyword: 'sonic' } })
  if (p === '/api/login/status') return sendJson(res, { data: { code: 200, account: null } })
  if (p === '/api/user/playlist') return sendJson(res, { playlist: [] })

  // 未显式实现的 GET 一律返回可安全消费的空结构，避免无关启动请求中断页面
  return sendJson(res, {
    code: 200,
    data: { tracks: [] },
    result: [],
    playlists: [],
    artists: [],
    banners: [],
    songs: [],
    playlist: [],
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.gz': 'application/gzip',
  '.map': 'application/json',
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const resolved = path.resolve(DIST_DIR, '.' + pathname)
  const inside = resolved === DIST_DIR || resolved.startsWith(DIST_DIR + path.sep)
  if (!inside) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  let file = resolved
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // hash 路由只需要 index.html；其余缺失资源返回 404，便于定位构建问题
    if (path.extname(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    file = path.join(DIST_DIR, 'index.html')
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const body = fs.readFileSync(file)
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    serveStatic(req, res, url)
  } catch (err) {
    console.error('[e2e mock] unhandled error', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'mock server error' }))
    } else {
      res.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[e2e mock] serving ${DIST_DIR} at http://${HOST}:${PORT}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

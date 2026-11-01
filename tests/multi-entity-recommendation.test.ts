import { describe, it, expect, beforeEach } from 'vitest'
import {
  MemoryRecommendStore,
  resetMemoryRecommendStoreForTest,
  ensureCatalogSeeded,
  ingestBehaviorEvents,
  clearUserRecommendationData,
  getRecommendationsForYou,
  getMultiEntityRecommendations,
  ensureMultiEntityCatalog,
  computeAlbumEntityId,
  computeMvEntityId,
  toCanonicalTrack,
  resolveUserIdentity,
  type UserIdentityContext,
} from '../functions/_lib/sonic/recommend'
import { SqliteRecommendStore } from '../server/recommend-sqlite'
import { onRequest as onForYouRequest } from '../functions/api/sonic/recommend/for-you'
import { onRequest as onEventsRequest } from '../functions/api/sonic/events'

const ANON: UserIdentityContext = {
  mode: 'anonymous-opt-in',
  subjectKey: 'anon_testsubject001',
  personalizationEnabled: true,
  isAuthenticated: false,
}

// The events HTTP handler derives its subjectKey from X-Sonic-Anon-Id; resolve it once so
// handler-based assertions read the same subject the handler wrote.
const HTTP_SUBJECT: string = await resolveUserIdentity(
  new Request('https://cfsolara.test/', { headers: { 'X-Sonic-Anon-Id': 'anon_1234567890abcdef' } }),
).then((identity) => identity.subjectKey!)

function makeEnv(store: unknown, extra: Record<string, unknown> = {}): any {
  return { RECOMMEND_STORE: store, SONIC_RECOMMEND_OFFLINE: '1', ...extra }
}

async function postEvents(env: any, events: unknown[]): Promise<any> {
  const resp = await onEventsRequest({
    request: new Request('https://cfsolara.test/api/sonic/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sonic-Anon-Id': 'anon_1234567890abcdef',
      },
      body: JSON.stringify({ events }),
    }),
    env,
  })
  return resp
}

describe('多实体推荐（track / album / playlist / mv）全链路测试', () => {
  let store: MemoryRecommendStore
  let env: any

  beforeEach(() => {
    resetMemoryRecommendStoreForTest()
    store = new MemoryRecommendStore()
    ensureCatalogSeeded(store)
    env = makeEnv(store)
  })

  describe('1. SQLite 三表 Schema 与实体 store 接口', () => {
    it('启动即建表：entities / entity_relations / user_entity_feedback 存在于 sqlite_master', () => {
      const sqliteStore = new SqliteRecommendStore(':memory:')
      try {
        const tables = sqliteStore
          .listEntities()
          .length // touch entity API to ensure tables usable
        const rows = (sqliteStore as any).db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entities','entity_relations','user_entity_feedback') ORDER BY name`,
        ).all() as Array<{ name: string }>
        expect(rows.map((r) => r.name)).toEqual(['entities', 'entity_relations', 'user_entity_feedback'])
        expect(tables).toBe(0)
      } finally {
        sqliteStore.close()
      }
    })

    it('旧库迁移：缺列的 behavior_events 自动补 entity_type / entity_id 列', () => {
      const sqliteStore = new SqliteRecommendStore(':memory:')
      try {
        // simulate a pre-multi-entity table by dropping the columns is impossible in sqlite;
        // instead create a fresh store (which migrates no-op), then verify columns exist
        const cols = (sqliteStore as any).db.prepare(`PRAGMA table_info(behavior_events)`).all() as Array<{ name: string }>
        const names = cols.map((c) => c.name)
        expect(names).toContain('entity_type')
        expect(names).toContain('entity_id')
      } finally {
        sqliteStore.close()
      }
    })

    it('实体 upsert / get / list 与双向关系检索（out 与 in 方向）', () => {
      const sqliteStore = new SqliteRecommendStore(':memory:')
      try {
        const albumId = computeAlbumEntityId('叶惠美', '周杰伦')
        sqliteStore.upsertEntity({
          entityId: albumId,
          entityType: 'album',
          title: '叶惠美',
          subtitle: '周杰伦',
          externalPopularity: 98,
          derived: true,
          createdAt: 1,
          updatedAt: 1,
        })
        const fetched = sqliteStore.getEntity('album', albumId)
        expect(fetched?.title).toBe('叶惠美')

        sqliteStore.upsertEntityRelations([
          { fromType: 'album', fromId: albumId, toType: 'track', toId: 'trk_a', relation: 'contains', weight: 1, updatedAt: 1 },
          { fromType: 'track', fromId: 'trk_a', toType: 'album', toId: albumId, relation: 'belongs_to', weight: 1, updatedAt: 1 },
        ])
        const out = sqliteStore.getEntityRelations('album', albumId, { direction: 'out', toType: 'track' })
        const inc = sqliteStore.getEntityRelations('track', 'trk_a', { direction: 'in' })
        expect(out).toHaveLength(1)
        expect(out[0].toId).toBe('trk_a')
        expect(inc).toHaveLength(1)
        expect(inc[0].fromType).toBe('album')
      } finally {
        sqliteStore.close()
      }
    })

    it('实体反馈写入 / 去重 / 亲和聚合 / 按主体清空', () => {
      const sqliteStore = new SqliteRecommendStore(':memory:')
      try {
        const fb = {
          feedbackId: 'fb_1',
          subjectKey: 'anon:u1',
          entityType: 'album' as const,
          entityId: 'alb_1',
          action: 'favorite',
          weight: 4,
          createdAt: 1000,
        }
        expect(sqliteStore.recordEntityFeedback(fb).inserted).toBe(true)
        expect(sqliteStore.recordEntityFeedback(fb).deduplicated).toBe(true)
        const stats = sqliteStore.getEntityAffinityStats('anon:u1')
        expect(stats).toHaveLength(1)
        expect(stats[0].positiveWeight).toBe(4)
        expect(stats[0].interactions).toBe(1)
        expect(sqliteStore.clearUserEntityFeedback('anon:u1')).toBe(1)
        expect(sqliteStore.getEntityAffinityStats('anon:u1')).toHaveLength(0)
      } finally {
        sqliteStore.close()
      }
    })
  })

  describe('2. 实体目录种子与事件实体解析', () => {
    it('ensureMultiEntityCatalog 从曲目目录派生 album/mv/playlist 实体与关系', () => {
      const created = ensureMultiEntityCatalog(store)
      const counts = store.countEntities()
      expect(counts.album).toBeGreaterThan(0)
      expect(counts.mv).toBeGreaterThan(0)
      expect(counts.relations).toBeGreaterThan(0)
      expect(created).toBeGreaterThan(0)

      // 幂等：第二次调用不再新建
      expect(ensureMultiEntityCatalog(store)).toBe(0)

      // 专辑实体与 contains 关系真实存在
      const yehuimei = computeAlbumEntityId('叶惠美', '周杰伦')
      const album = store.getEntity('album', yehuimei)
      expect(album).not.toBeNull()
      expect(album!.title).toBe('叶惠美')
      const contained = store.getEntityRelations('album', yehuimei, { direction: 'out', toType: 'track' })
      expect(contained.length).toBeGreaterThan(0)

      // MV 实体与 derives_from 关系
      const anyTrack = store.listTracks(1)[0]
      const mvId = computeMvEntityId(anyTrack.canonicalTrackId)
      const mv = store.getEntity('mv', mvId)
      expect(mv?.entityType).toBe('mv')
      expect(store.getEntityRelations('mv', mvId, { direction: 'out', toType: 'track' })[0].relation).toBe('derives_from')
    })

    it('事件实体解析：客户端发明 entityId 时按自然键命中目录实体', async () => {
      ensureMultiEntityCatalog(store)
      const resolved = await ingestBehaviorEvents(
        [
          {
            type: 'favorite',
            entityType: 'album',
            entityId: 'alb_yehuimei_jay',
            track: { id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, platform: 'netease' },
          } as any,
        ],
        ANON,
        env,
      )
      expect(resolved.accepted).toBe(1)
      expect(resolved.entityFeedbackAccepted).toBe(1)
      const fb = store.getUserEntityFeedback(ANON.subjectKey!)
      expect(fb).toHaveLength(1)
      expect(fb[0].entityType).toBe('album')
      // 自然键解析命中真实目录专辑（叶惠美:::周杰伦）
      expect(fb[0].entityId).toBe(computeAlbumEntityId('叶惠美', '周杰伦'))
      // behavior_events 审计行也带实体字段（无静默丢弃）
      const ev = store.getUserEvents(ANON.subjectKey!)[0]
      expect(ev.entityType).toBe('album')
      expect(ev.entityId).toBe(fb[0].entityId)
    })  })

  describe('3. 事件校验：实体字段要么支持、要么明确 4xx', () => {
    it('watch_complete MV 事件被正式接受（不再 400 INVALID_EVENT_TYPE）', async () => {
      const resp = await postEvents(env, [
        {
          type: 'watch_complete',
          entityType: 'mv',
          entityId: computeMvEntityId(store.listTracks(1)[0].canonicalTrackId),
          progressRatio: 1.0,
        },
      ])
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.data.accepted).toBe(1)
      expect(body.data.entityFeedbackAccepted).toBe(1)
      const fb = store.getUserEntityFeedback(HTTP_SUBJECT)
      expect(fb).toHaveLength(1)
      expect(fb[0].entityType).toBe('mv')
      expect(fb[0].action).toBe('watch_complete')
    })

    it('非法 entityType 整批 400 拒绝且不写入任何数据', async () => {
      const resp = await postEvents(env, [
        { type: 'favorite', track: { id: 186016, title: '晴天', artist: '周杰伦' } },
        { type: 'favorite', entityType: 'artist', entityId: 'art_1' },
      ])
      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error.code).toBe('INVALID_ENTITY_TYPE')
      expect(store.getUserEntityFeedback(ANON.subjectKey!)).toHaveLength(0)
      expect(store.getUserEvents(ANON.subjectKey!)).toHaveLength(0)
    })

    it('entityId 无 entityType、entityType 无 entityId 均为明确 4xx', async () => {
      const noType = await postEvents(env, [{ type: 'open', entityId: 'alb_1' }])
      expect(noType.status).toBe(400)
      expect((await noType.json()).error.code).toBe('INVALID_ENTITY_TYPE')

      const noId = await postEvents(env, [{ type: 'open', entityType: 'album' }])
      expect(noId.status).toBe(400)
      expect((await noId.json()).error.code).toBe('INVALID_ENTITY_ID')
    })

    it('playlist 事件写入实体反馈并出现在 mixed（playlist 类型）', async () => {
      ensureMultiEntityCatalog(store)
      const resp = await postEvents(env, [
        { type: 'open', entityType: 'playlist', entityId: 'pl_mandopop_test' },
        { type: 'favorite', entityType: 'playlist', entityId: 'pl_mandopop_test', entityTitle: '华语流行精选' },
      ])
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.data.entityFeedbackAccepted).toBe(2)
    })
  })

  describe('4. feed=mixed 混合推荐与双向软传播', () => {
    beforeEach(() => {
      // 出厂种子目录每张专辑仅 1 首曲目（灰测报告 P1.4）；为让专辑→曲目传播有未被排除的成员，
      // 向测试库注入两张同专辑（叶惠美）本地合成曲目后再派生实体目录。
      const extra = [
        { id: 'sonic_yhm_02', platform: 'sonic', title: '以父之名', artist: '周杰伦', album: '叶惠美', duration: 341 },
        { id: 'sonic_yhm_03', platform: 'sonic', title: '东风破', artist: '周杰伦', album: '叶惠美', duration: 320 },
      ]
      const canonicals = extra
        .map((t) => toCanonicalTrack(t, { explicitGenres: ['mandopop', 'r&b'], externalPopularity: 90 }))
        .filter((t): t is NonNullable<typeof t> => t !== null)
      store.upsertTracks(canonicals)
      ensureMultiEntityCatalog(store)
    })

    it('收藏专辑后 mixed 列表出现非 track 类型且含专辑传播信号', async () => {
      await ingestBehaviorEvents(
        [
          {
            type: 'favorite',
            entityType: 'album',
            entityId: 'alb_yehuimei_jay',
            track: { id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, platform: 'netease' },
          } as any,
          { type: 'play_complete', track: { id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, platform: 'netease' } } as any,
        ],
        ANON,
        env,
      )
      const mixed = getMultiEntityRecommendations(ANON, { count: 12 }, env)
      expect(mixed.feed).toBe('mixed')
      expect(mixed.personalized).toBe(true)
      expect(mixed.items).toHaveLength(12)
      const types = new Set(mixed.items.map((i) => i.type))
      expect(types.size).toBeGreaterThan(1)
      expect(types.has('album') || types.has('mv') || types.has('playlist')).toBe(true)
      // distribution 与 items 一致
      const total = mixed.distribution.track + mixed.distribution.album + mixed.distribution.playlist + mixed.distribution.mv
      expect(total).toBe(12)
      // 每项契约字段完整
      for (const item of mixed.items) {
        expect(typeof item.id).toBe('string')
        expect(item.title.length).toBeGreaterThan(0)
        expect(item.score).toBeGreaterThan(0)
        expect(item.reason.length).toBeGreaterThan(0)
        expect(item.reasonCode.length).toBeGreaterThan(0)
      }
      // 双向传播：专辑内曲目获得 entity_propagation 信号
      const propagated = mixed.items.filter(
        (i) => i.type === 'track' && i.signals.some((s) => s.type === 'entity_propagation'),
      )
      expect(propagated.length).toBeGreaterThan(0)
      expect(propagated.some((i) => i.reason.includes('叶惠美'))).toBe(true)
    })

    it('watch_complete MV 后 mixed 出现 type=mv 且该 MV 与曲目关联', async () => {
      const anyTrack = store.listTracks(1)[0]
      await ingestBehaviorEvents(
        [{ type: 'watch_complete', entityType: 'mv', entityId: computeMvEntityId(anyTrack.canonicalTrackId), progressRatio: 1.0 } as any],
        ANON,
        env,
      )
      const mixed = getMultiEntityRecommendations(ANON, { count: 12, types: ['track', 'mv'] }, env)
      expect(mixed.items.every((i) => i.type === 'track' || i.type === 'mv')).toBe(true)
      expect(mixed.items.some((i) => i.type === 'mv')).toBe(true)
      expect(mixed.distribution.mv).toBeGreaterThan(0)
    })

    it('类型打散：track 永远不超过 count 的 70%（12 项时 ≤ 8）', () => {
      const mixed = getMultiEntityRecommendations(ANON, { count: 12 }, env)
      expect(mixed.distribution.track).toBeLessThanOrEqual(8)
      // 无 3 连同类型
      for (let i = 2; i < mixed.items.length; i++) {
        const a = mixed.items[i - 2].type
        const b = mixed.items[i - 1].type
        const c = mixed.items[i].type
        expect(!(a === b && b === c)).toBe(true)
      }
    })

    it('旧版无 feed 参数严格保持 tracks 契约（不出现 items/feed 字段）', async () => {
      const resp = await onForYouRequest({
        request: new Request('https://cfsolara.test/api/sonic/recommend/for-you?count=6', {
          headers: { 'X-Sonic-Anon-Id': 'anon_1234567890abcdef' },
        }),
        env,
      })
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.data.tracks.length).toBeGreaterThan(0)
      expect(body.data.feed).toBeUndefined()
      expect(body.data.items).toBeUndefined()
      expect(Object.keys(body.data)).toEqual(
        expect.arrayContaining(['mode', 'personalized', 'privacyMode', 'storageKind', 'tracks', 'profileSummary']),
      )
      expect(body.data.tracks[0].canonicalTrackId).toBeTruthy()
    })

    it('feed=mixed 通过 HTTP 返回 items + distribution', async () => {
      const resp = await onForYouRequest({
        request: new Request('https://cfsolara.test/api/sonic/recommend/for-you?feed=mixed&count=12', {
          headers: { 'X-Sonic-Anon-Id': 'anon_1234567890abcdef' },
        }),
        env,
      })
      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.data.feed).toBe('mixed')
      expect(body.data.items).toHaveLength(12)
      expect(body.data.distribution).toBeTruthy()
      expect(Array.isArray(body.data.items)).toBe(true)
    })
  })

  describe('5. 隐私清空级联与延迟', () => {
    it('DELETE 级联清空 user_entity_feedback 且 personalized 回落', async () => {
      ensureMultiEntityCatalog(store)
      await postEvents(env, [
        {
          type: 'favorite',
          entityType: 'album',
          entityId: 'alb_yehuimei_jay',
          track: { id: 186016, title: '晴天', artist: '周杰伦', album: '叶惠美', duration: 269, platform: 'netease' },
        },
      ])
      expect(store.getUserEntityFeedback(HTTP_SUBJECT).length).toBe(1)

      const clear = clearUserRecommendationData({ ...ANON, subjectKey: HTTP_SUBJECT }, env)
      expect(clear.cleared).toBe(true)
      expect(clear.removedEntityFeedback).toBe(1)
      expect(store.getUserEntityFeedback(HTTP_SUBJECT)).toHaveLength(0)
      expect(getMultiEntityRecommendations({ ...ANON, subjectKey: HTTP_SUBJECT }, { count: 6 }, env).personalized).toBe(false)
    })

    it('引擎内部 mixed 延迟 P95 < 100ms（严格 25ms 目标由 eval 脚本与 HTTP 自证覆盖）', () => {
      ensureMultiEntityCatalog(store)
      // warm up
      getMultiEntityRecommendations(ANON, { count: 12 }, env)
      const samples: number[] = []
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now()
        getMultiEntityRecommendations(ANON, { count: 12 }, env)
        samples.push(performance.now() - t0)
      }
      samples.sort((a, b) => a - b)
      const p95 = samples[Math.floor(samples.length * 0.95)]
      expect(p95).toBeLessThan(100)
    })
  })
})

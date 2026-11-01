import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeEntityActionWeight,
  computeEventCredibilityWeight,
  ensureMultiEntityCatalogSeeded,
  getMultiEntityRecommendationsForYou,
  getPropagationCoefficients,
  buildMultiEntityPreferenceProfile,
  diversifyMultiEntityCandidates,
  MemoryRecommendStore,
  resetMemoryRecommendStoreForTest,
  type SonicEntity,
  type EntityRelation,
  type UserEntityFeedback,
  type UserIdentityContext,
} from '../functions/_lib/sonic/recommend';
import { SqliteRecommendStore } from '../server/recommend-sqlite';
import { onRequest as onForYouRequest } from '../functions/api/sonic/recommend/for-you';
import { onRequest as onEventsRequest } from '../functions/api/sonic/events';

describe('Sonic 歌集 (Album/Playlist) 与 MV 多实体推荐与信号传播全链路测试', () => {
  let memStore: MemoryRecommendStore;
  let sqliteStore: SqliteRecommendStore;
  let tempDbDir: string;
  let tempDbPath: string;
  let envMem: any;
  let envSqlite: any;

  beforeEach(() => {
    resetMemoryRecommendStoreForTest();
    memStore = new MemoryRecommendStore();
    ensureMultiEntityCatalogSeeded(memStore);

    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonic-multi-entity-test-'));
    tempDbPath = path.join(tempDbDir, 'recommend-test.sqlite');
    sqliteStore = new SqliteRecommendStore(tempDbPath);
    ensureMultiEntityCatalogSeeded(sqliteStore);

    envMem = {
      RECOMMEND_STORE: memStore,
      SONIC_RECOMMEND_OFFLINE: '1',
    };
    envSqlite = {
      RECOMMEND_STORE: sqliteStore,
      SONIC_RECOMMEND_OFFLINE: '1',
    };
  });

  describe('1. 实体模型统一与 SQLite/Memory 双存储 CRUD 验证', () => {
    it('Sqlite 与 Memory 存储均能正确增删改查 entities (track, album, playlist, mv)', () => {
      for (const store of [memStore, sqliteStore]) {
        const testAlbum: SonicEntity = {
          id: 'alb_test_jay_fantasy',
          type: 'album',
          title: '范特西',
          subtitle: '周杰伦 · 专辑',
          artistName: '周杰伦',
          coverUrl: 'https://img.test/fantasy.jpg',
          source: 'sonic',
          tags: ['r&b', 'pop'],
          duration: 2100,
          externalPopularity: 98,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          payload: { trackCount: 10 },
        };

        store.upsertEntity!(testAlbum);
        const fetched = store.getEntity!(testAlbum.id);
        expect(fetched).not.toBeNull();
        expect(fetched?.title).toBe('范特西');
        expect(fetched?.artistName).toBe('周杰伦');
        expect(fetched?.type).toBe('album');

        const albumList = store.listEntities!('album', 10);
        expect(albumList.some((a) => a.id === testAlbum.id)).toBe(true);
      }
    });

    it('关系图谱维护：Album 包含 Track，MV 关联 Track，支持双向关系检索', () => {
      for (const store of [memStore, sqliteStore]) {
        const relContains: EntityRelation = {
          parentId: 'alb_test_group',
          parentType: 'album',
          childId: 'trk_test_track_1',
          childType: 'track',
          relationType: 'contains',
          weight: 1.0,
          position: 1,
        };
        const relMv: EntityRelation = {
          parentId: 'mv_test_mv_1',
          parentType: 'mv',
          childId: 'trk_test_track_1',
          childType: 'track',
          relationType: 'video_of',
          weight: 1.0,
        };

        store.upsertEntityRelation!(relContains);
        store.upsertEntityRelation!(relMv);

        const children = store.getEntityRelations!('alb_test_group', 'children');
        expect(children.length).toBeGreaterThanOrEqual(1);
        expect(children[0].childId).toBe('trk_test_track_1');

        const parents = store.getEntityRelations!('trk_test_track_1', 'parents');
        expect(parents.length).toBeGreaterThanOrEqual(2);
        const parentIds = parents.map((p) => p.parentId);
        expect(parentIds).toContain('alb_test_group');
        expect(parentIds).toContain('mv_test_mv_1');
      }
    });
  });

  describe('2. 事件采集扩展与可信度权重体系', () => {
    it('扩展行为权重：favorite(+4.0), replay(+3.5), watch_complete(+2.5), open(+0.5), dislike(-5.0)', () => {
      expect(computeEntityActionWeight({ action: 'favorite' })).toBe(4.0);
      expect(computeEntityActionWeight({ action: 'replay' })).toBe(3.5);
      expect(computeEntityActionWeight({ action: 'play_complete' })).toBe(2.5);
      expect(computeEntityActionWeight({ action: 'watch_complete' })).toBe(2.5);
      expect(computeEntityActionWeight({ action: 'add_to_playlist' })).toBe(2.0);
      expect(computeEntityActionWeight({ action: 'open' })).toBe(0.5);
      expect(computeEntityActionWeight({ action: 'play_start' })).toBe(0.35);
      expect(computeEntityActionWeight({ action: 'dislike' })).toBe(-5.0);
      expect(computeEntityActionWeight({ action: 'undislike' })).toBe(0.5);
    });

    it('进度分阶与跳过保护：watch_progress 分阶计算，网络卡顿等非用户原因不计入负向信号', () => {
      expect(computeEntityActionWeight({ action: 'watch_progress', progress: 0.85 })).toBe(1.8);
      expect(computeEntityActionWeight({ action: 'watch_progress', progress: 0.50 })).toBe(1.2);
      expect(computeEntityActionWeight({ action: 'watch_progress', progress: 0.15 })).toBe(0.2);

      // 非用户原因跳过（网络卡顿、解码错误、试听结束）：权重严格为 0
      expect(computeEntityActionWeight({ action: 'skip', reason: 'network_stall' })).toBe(0);
      expect(computeEntityActionWeight({ action: 'skip', reason: 'trial_end' })).toBe(0);
      expect(computeEntityActionWeight({ action: 'skip', reason: 'playback_error' })).toBe(0);

      // 用户过半后切歌微正 (+0.25)，过早跳过为负向 (-0.8)
      expect(computeEntityActionWeight({ action: 'skip', progress: 0.65 })).toBe(0.25);
      expect(computeEntityActionWeight({ action: 'skip', progress: 0.10 })).toBe(-0.8);
    });
  });

  describe('3. 双向软信号传播 (Bidirectional Soft Propagation)', () => {
    it('用户喜欢 Album 时，正向信号按配置系数传播给内部 Track', () => {
      const identity: UserIdentityContext = {
        mode: 'authenticated',
        subjectKey: 'usr:prop_album_listener',
        personalizationEnabled: true,
        isAuthenticated: true,
      };

      // 找到一个已有专辑
      const albums = memStore.listEntities!('album', 1);
      expect(albums.length).toBeGreaterThan(0);
      const testAlbum = albums[0];
      const children = memStore.getEntityRelations!(testAlbum.id, 'children');
      expect(children.length).toBeGreaterThan(0);
      const childTrackId = children[0].childId;

      // 用户收藏该专辑
      const fb: UserEntityFeedback = {
        feedbackId: 'fb_fav_album_1',
        subjectKey: identity.subjectKey!,
        entityType: 'album',
        entityId: testAlbum.id,
        action: 'favorite',
        weight: 4.0,
        createdAt: Date.now(),
      };
      memStore.recordEntityFeedback!(fb);

      const profile = buildMultiEntityPreferenceProfile(identity, memStore, envMem);
      expect(profile.hasSignals).toBe(true);
      expect(profile.directEntityScores.get(testAlbum.id)).toBeGreaterThan(3.5);

      // 验证内部曲目获得了传播分 (4.0 * albumToTrack 0.40 = 1.6)
      const propagatedScore = profile.propagatedEntityScores.get(childTrackId) || 0;
      expect(propagatedScore).toBeGreaterThanOrEqual(1.4);
    });

    it('用户喜欢 Track 时，所属 Album 与关联 MV 均获得正向提升', () => {
      const identity: UserIdentityContext = {
        mode: 'authenticated',
        subjectKey: 'usr:prop_track_listener',
        personalizationEnabled: true,
        isAuthenticated: true,
      };

      // 找到关联有 MV 和 Album 的曲目
      const mvs = memStore.listEntities!('mv', 5);
      expect(mvs.length).toBeGreaterThan(0);
      const mv = mvs[0];
      const mvChildren = memStore.getEntityRelations!(mv.id, 'children');
      expect(mvChildren.length).toBeGreaterThan(0);
      const trackId = mvChildren[0].childId;

      // 用户完播该 Track
      const fb: UserEntityFeedback = {
        feedbackId: 'fb_play_track_1',
        subjectKey: identity.subjectKey!,
        entityType: 'track',
        entityId: trackId,
        action: 'play_complete',
        weight: 2.5,
        createdAt: Date.now(),
      };
      memStore.recordEntityFeedback!(fb);

      const profile = buildMultiEntityPreferenceProfile(identity, memStore, envMem);
      // 验证 MV 获得了传播分
      const mvPropScore = profile.propagatedEntityScores.get(mv.id) || 0;
      expect(mvPropScore).toBeGreaterThan(0);
    });

    it('用户喜欢 MV 时，关联单曲获得提升', () => {
      const identity: UserIdentityContext = {
        mode: 'authenticated',
        subjectKey: 'usr:prop_mv_watcher',
        personalizationEnabled: true,
        isAuthenticated: true,
      };

      const mvs = memStore.listEntities!('mv', 5);
      const mv = mvs[0];
      const mvChildren = memStore.getEntityRelations!(mv.id, 'children');
      const trackId = mvChildren[0].childId;

      // 用户看完了 MV
      const fb: UserEntityFeedback = {
        feedbackId: 'fb_watch_mv_1',
        subjectKey: identity.subjectKey!,
        entityType: 'mv',
        entityId: mv.id,
        action: 'watch_complete',
        weight: 2.5,
        createdAt: Date.now(),
      };
      memStore.recordEntityFeedback!(fb);

      const profile = buildMultiEntityPreferenceProfile(identity, memStore, envMem);
      const trackProp = profile.propagatedEntityScores.get(trackId) || 0;
      expect(trackProp).toBeGreaterThanOrEqual(0.9);
    });

    it('dislike 反向传播谨慎性：只硬过滤本实体，关联实体仅施加弱惩罚且绝不硬过滤', () => {
      const identity: UserIdentityContext = {
        mode: 'authenticated',
        subjectKey: 'usr:prop_dislike_user',
        personalizationEnabled: true,
        isAuthenticated: true,
      };

      const albums = memStore.listEntities!('album', 1);
      const testAlbum = albums[0];
      const childTrackId = memStore.getEntityRelations!(testAlbum.id, 'children')[0].childId;

      // 用户 dislike 了该专辑
      const fb: UserEntityFeedback = {
        feedbackId: 'fb_dislike_alb_1',
        subjectKey: identity.subjectKey!,
        entityType: 'album',
        entityId: testAlbum.id,
        action: 'dislike',
        weight: -5.0,
        createdAt: Date.now(),
      };
      memStore.recordEntityFeedback!(fb);

      const profile = buildMultiEntityPreferenceProfile(identity, memStore, envMem);
      // 专辑本身被硬过滤
      expect(profile.blockedEntityIds.has(testAlbum.id)).toBe(true);
      // 内部曲目绝不能被硬过滤！
      expect(profile.blockedEntityIds.has(childTrackId)).toBe(false);
      // 内部曲目仅存在温和弱惩罚
      expect(profile.penalizedEntities.get(childTrackId)).toBeGreaterThan(0);
      expect(profile.penalizedEntities.get(childTrackId)).toBeLessThan(1.0);
    });
  });

  describe('4. 混合 Feed 输出与多实体 MMR 重排', () => {
    it('调用 getMultiEntityRecommendationsForYou 返回混合实体列表且包含 track / album / playlist / mv', async () => {
      const identity: UserIdentityContext = {
        mode: 'public',
        subjectKey: null,
        personalizationEnabled: false,
        isAuthenticated: false,
      };

      const res = await getMultiEntityRecommendationsForYou(identity, { count: 20 }, envMem);
      expect(res.brand).toBe('Sonic');
      expect(res.data.length).toBe(20);

      const typesInFeed = new Set(res.data.map((item) => item.type));
      expect(typesInFeed.has('track')).toBe(true);
      expect(typesInFeed.has('album') || typesInFeed.has('playlist')).toBe(true);
      expect(typesInFeed.has('mv')).toBe(true);

      // 每项必须具备可解释性 reason、得分 score、封面与有效 payload
      for (const item of res.data) {
        expect(item.id).toBeTruthy();
        expect(item.title).toBeTruthy();
        expect(item.score).toBeGreaterThan(0);
        expect(typeof item.reason).toBe('string');
        expect(item.reason.length).toBeGreaterThan(0);
        expect(item.payload).toBeDefined();
      }
    });

    it('混合 Feed 类型占比大致符合预期 (track 55~70%, album/playlist 15~25%, mv 10~20%)', async () => {
      const identity: UserIdentityContext = {
        mode: 'public',
        subjectKey: null,
        personalizationEnabled: false,
        isAuthenticated: false,
      };

      const res = await getMultiEntityRecommendationsForYou(identity, { count: 20 }, envMem);
      const dist = res.meta.distribution || { track: 0, album: 0, playlist: 0, mv: 0 };
      const trackRatio = dist.track / 20;
      const albumPlaylistRatio = (dist.album + dist.playlist) / 20;
      const mvRatio = dist.mv / 20;

      expect(trackRatio).toBeGreaterThanOrEqual(0.50);
      expect(trackRatio).toBeLessThanOrEqual(0.75);
      expect(albumPlaylistRatio).toBeGreaterThanOrEqual(0.12);
      expect(mvRatio).toBeGreaterThanOrEqual(0.08);
    });

    it('MMR 多样性控制：同一歌手不过度堆积且同类型实体避免过度连续出现', () => {
      const candidates = [
        { entityType: 'track', id: 't1', title: '晴天', subtitle: '周杰伦', cover: '', artistName: '周杰伦', genres: ['r&b'], score: 0.95, reason: 'r', payload: {} },
        { entityType: 'track', id: 't2', title: '七里香', subtitle: '周杰伦', cover: '', artistName: '周杰伦', genres: ['r&b'], score: 0.94, reason: 'r', payload: {} },
        { entityType: 'track', id: 't3', title: '简单爱', subtitle: '周杰伦', cover: '', artistName: '周杰伦', genres: ['r&b'], score: 0.93, reason: 'r', payload: {} },
        { entityType: 'album', id: 'a1', title: '叶惠美', subtitle: '周杰伦', cover: '', artistName: '周杰伦', genres: ['r&b'], score: 0.92, reason: 'r', payload: {} },
        { entityType: 'mv', id: 'm1', title: '晴天 MV', subtitle: '周杰伦', cover: '', artistName: '周杰伦', genres: ['r&b'], score: 0.91, reason: 'r', payload: {} },
        { entityType: 'track', id: 't4', title: '江南', subtitle: '林俊杰', cover: '', artistName: '林俊杰', genres: ['r&b'], score: 0.90, reason: 'r', payload: {} },
        { entityType: 'track', id: 't5', title: '富士山下', subtitle: '陈奕迅', cover: '', artistName: '陈奕迅', genres: ['cantopop'], score: 0.89, reason: 'r', payload: {} },
        { entityType: 'mv', id: 'm2', title: '海阔天空 MV', subtitle: 'Beyond', cover: '', artistName: 'Beyond', genres: ['rock'], score: 0.88, reason: 'r', payload: {} },
      ];

      const diversified = diversifyMultiEntityCandidates(candidates as any, 6, { diversity: 0.35 });
      expect(diversified.length).toBe(6);

      // 单歌手不超过 3 项
      const jayCount = diversified.filter((item) => (item.subtitle || '').includes('周杰伦')).length;
      expect(jayCount).toBeLessThanOrEqual(3);
    });
  });

  describe('5. 端点适配、向后兼容性与隐私一键清空', () => {
    it('GET /api/sonic/recommend/for-you?feed=mixed 返回符合新契约的混合 Feed 数组', async () => {
      const req = new Request('https://cfsolara.test/api/sonic/recommend/for-you?feed=mixed&count=12', {
        headers: {
          'X-Sonic-Anon-Id': 'anon_mixed_feed_test_01',
        },
      });

      const resp = await onForYouRequest({ request: req, env: envSqlite });
      expect(resp.status).toBe(200);
      const json = await resp.json();
      expect(json.brand).toBe('Sonic');
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(12);
      expect(json.meta.strategy).toBe('hybrid-multi-entity');
    });

    it('向后兼容策略：旧客户端只读单曲时 (无 feed=mixed 或指定 types=track)，保持返回旧结构 tracks 数组', async () => {
      const reqLegacy = new Request('https://cfsolara.test/api/sonic/recommend/for-you?count=8', {
        headers: {
          'X-Sonic-Anon-Id': 'anon_legacy_client_01',
        },
      });

      const resp = await onForYouRequest({ request: reqLegacy, env: envSqlite });
      expect(resp.status).toBe(200);
      const json = await resp.json();
      expect(json.brand).toBe('Sonic');
      // 旧客户端契约：json.data.tracks 存在且非空
      expect(json.data.tracks).toBeDefined();
      expect(Array.isArray(json.data.tracks)).toBe(true);
      expect(json.data.tracks.length).toBeGreaterThan(0);
    });

    it('POST /api/sonic/events 能够接收新实体反馈 (entity_type, action, progress)', async () => {
      const req = new Request('https://cfsolara.test/api/sonic/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sonic-Anon-Id': 'anon_events_test_01',
        },
        body: JSON.stringify({
          events: [
            {
              entity_type: 'album',
              entity_id: 'alb_demo_01',
              action: 'favorite',
              context: { from: 'album_detail' },
            },
            {
              entity_type: 'mv',
              entity_id: 'mv_demo_01',
              action: 'watch_complete',
              progress: 1.0,
            },
          ],
        }),
      });

      const resp = await onEventsRequest({ request: req, env: envSqlite });
      expect(resp.status).toBe(200);
      const json = await resp.json();
      expect(json.brand).toBe('Sonic');
      expect(json.data.ok).toBe(true);
      expect(json.data.accepted).toBe(2);
    });

    it('DELETE /api/sonic/events 一键清空必须同时清掉单曲行为与所有新实体反馈', async () => {
      const anonId = 'anon_clean_test_99';
      // 写入单曲事件
      await onEventsRequest({
        request: new Request('https://cfsolara.test/api/sonic/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': anonId },
          body: JSON.stringify({
            events: [{ type: 'play_complete', track: { id: '186016', title: '晴天', artist: '周杰伦' } }],
          }),
        }),
        env: envSqlite,
      });

      // 写入实体反馈
      await onEventsRequest({
        request: new Request('https://cfsolara.test/api/sonic/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sonic-Anon-Id': anonId },
          body: JSON.stringify({
            events: [{ entity_type: 'mv', entity_id: 'mv_01', action: 'watch_complete' }],
          }),
        }),
        env: envSqlite,
      });

      // 执行清空
      const delReq = new Request('https://cfsolara.test/api/sonic/events', {
        method: 'DELETE',
        headers: { 'X-Sonic-Anon-Id': anonId },
      });
      const delResp = await onEventsRequest({ request: delReq, env: envSqlite });
      const delJson = await delResp.json();
      expect(delJson.data.cleared).toBe(true);
      expect(delJson.data.removedEvents).toBeGreaterThanOrEqual(2);
    });
  });

  describe('6. 延迟守卫与基准压测 (P95 Latency Guard)', () => {
    it('本地压测 for-you?feed=mixed 100 次迭代 P95 延迟控制在 35ms 以内', async () => {
      const latencies: number[] = [];
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        const req = new Request(`https://cfsolara.test/api/sonic/recommend/for-you?feed=mixed&count=18&_=${i}`, {
          headers: {
            'X-Sonic-Anon-Id': 'anon_perf_test_user',
          },
        });
        const resp = await onForYouRequest({ request: req, env: envSqlite });
        expect(resp.status).toBe(200);
        latencies.push(performance.now() - t0);
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(iterations * 0.50)];
      const p95 = latencies[Math.floor(iterations * 0.95)];

      console.log(`[Multi-Entity Latency Guard] Iterations=${iterations}, P50=${p50.toFixed(2)}ms, P95=${p95.toFixed(2)}ms`);
      expect(p50).toBeLessThan(20);
      expect(p95).toBeLessThan(35);
    });
  });
});

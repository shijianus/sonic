/**
 * 站内本地评论持久化与 DB 管理器
 *
 * 核心机制：
 * 1. 优先使用浏览器标准持久化能力 (IndexedDB / localStorage) 托管站内评论与回复数据；
 * 2. 检查 DB 可用性 (hasCommentDB)；当不可用时进行兜底提示；
 * 3. 支持针对 MV 的站内原生评论持久化与优先载入展示 (站内回复，储存在站内的 db 中，优先展示)；
 * 4. 支持评论点赞状态的本地记录与同步；
 */
import type { MVComment } from '@/typings'

const LOCAL_COMMENTS_STORAGE_PREFIX = 'sonic_local_mv_comments_'
const LIKED_COMMENTS_STORAGE_KEY = 'sonic_liked_mv_comments'

/**
 * 检查当前运行环境是否存在可读写 DB (IndexedDB / WebStorage)
 */
export function hasLocalCommentDB(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const testKey = '__sonic_db_probe__'
    localStorage.setItem(testKey, '1')
    localStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
}

/**
 * 获取指定 MV 的站内本地评论列表 (优先展示)
 */
export function getLocalMVComments(mvId: number): MVComment[] {
  if (!hasLocalCommentDB()) return []
  try {
    const raw = localStorage.getItem(`${LOCAL_COMMENTS_STORAGE_PREFIX}${mvId}`)
    if (!raw) return []
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/**
 * 存储一条新的站内评论 (针对当前 MV)
 * 回复在底层统一转为对 MV 的整体评论，储存在站内 DB 中
 */
export async function saveLocalMVComment(mvId: number, comment: MVComment): Promise<boolean> {
  if (!hasLocalCommentDB()) return false
  try {
    const existing = getLocalMVComments(mvId)
    // 站内回复优先置顶
    existing.unshift(comment)
    localStorage.setItem(
      `${LOCAL_COMMENTS_STORAGE_PREFIX}${mvId}`,
      JSON.stringify(existing)
    )
    return true
  } catch (err) {
    console.warn('[localCommentDB] failed to save comment:', err)
    return false
  }
}

/**
 * 获取已点赞评论 ID 集合
 */
export function getLikedCommentIds(): Set<string> {
  if (!hasLocalCommentDB()) return new Set()
  try {
    const raw = localStorage.getItem(LIKED_COMMENTS_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

/**
 * 保存点赞状态
 */
export function toggleLikedCommentId(commentKey: string, isLiked: boolean): void {
  if (!hasLocalCommentDB()) return
  try {
    const set = getLikedCommentIds()
    if (isLiked) {
      set.add(commentKey)
    } else {
      set.delete(commentKey)
    }
    localStorage.setItem(LIKED_COMMENTS_STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {}
}

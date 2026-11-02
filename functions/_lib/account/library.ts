import type { AppEnv } from '../types';

export const ACCOUNT_COLLECTIONS = ['likedSongs', 'collectedPlaylists', 'followedArtists', 'likedMvs', 'collectedAlbums', 'userPlaylists'] as const;
export type AccountCollection = typeof ACCOUNT_COLLECTIONS[number];
export const ACCOUNT_LIMITS = { bodyBytes: 262144, operations: 100, items: 5000, records: 10000, bytes: 2097152, playlists: 100, songs: 500, receipts: 2048 };
export interface AccountItem { id: string; name: string; songs?: AccountItem[]; [key: string]: unknown }
export type AccountOperation = { type: 'upsert' | 'delete'; collection: AccountCollection; id: string; value?: AccountItem };
export interface AccountMutation { operationId: string; baseVersion: number; operations: AccountOperation[] }
export interface AccountMutationResult { operationId: string; version: number; updatedAt: number; replayed: boolean }
export interface AccountPersistenceMeta { storageKind: 'sqlite'; persistenceConfirmed: true }
export type AccountSnapshot = Record<AccountCollection, AccountItem[]> & {
  schemaVersion: 1; version: number; updatedAt: number | null;
  tombstones: Array<{ collection: AccountCollection; id: string; version: number; deletedAt: number }>;
};
export interface AccountStore {
  readonly kind: 'sqlite';
  readonly schemaVersion: 1;
  getLibrary(subject: string): AccountSnapshot | Promise<AccountSnapshot>;
  applyLibraryMutation(subject: string, mutation: AccountMutation): AccountMutationResult | Promise<AccountMutationResult>;
}
export class AccountError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly currentVersion?: number) { super(message); }
}
function invalid(): never { throw new AccountError('INVALID_ACCOUNT_PAYLOAD', 'Invalid account operation or metadata'); }
function object(value: any): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function id(value: any): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) invalid();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(String(value))) invalid();
  return String(value);
}
export function publicCover(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return '';
    if (!/^(?:p[1-9]\.music\.126\.net|y\.gtimg\.cn|y\.qq\.com|imge?ssl\.kugou\.com)$/.test(u.hostname)) return '';
    return /\.(?:jpg|jpeg|png|webp)$/i.test(u.pathname) ? u.href : '';
  } catch { return ''; }
}
function item(raw: unknown, key: string, playlist = false): AccountItem {
  const value = object(raw);
  if (value.id !== undefined && id(value.id) !== key) invalid();
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) invalid();
  const result: AccountItem = { id: key, name: value.name.trim() };
  for (const field of ['artist', 'album', 'creator', 'provider']) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string' || value[field].length > 200) invalid();
    result[field] = value[field];
  }
  for (const field of ['cover', 'coverImgUrl', 'picUrl']) if (value[field] !== undefined) result[field] = publicCover(value[field]);
  for (const field of ['mvId', 'artistId']) if (value[field] !== undefined) result[field] = id(value[field]);
  for (const field of ['duration', 'trackCount', 'playCount', 'likedAt', 'followedAt', 'collectedAt', 'createdAt']) {
    if (value[field] === undefined) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) invalid();
    result[field] = value[field];
  }
  if (playlist) {
    if (!Array.isArray(value.songs) || value.songs.length > ACCOUNT_LIMITS.songs) invalid();
    const seen = new Set<string>();
    result.songs = value.songs.map((song: unknown) => {
      const songObject = object(song);
      const songId = id(songObject.id);
      if (seen.has(songId)) invalid();
      seen.add(songId);
      return item(song, songId);
    });
  }
  // No playback URL, blob, arbitrary provider payload or client subject is persisted.
  return result;
}
export function normalizeAccountMutation(raw: unknown): AccountMutation {
  const value = object(raw);
  if (typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.operationId)) invalid();
  if (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0) invalid();
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > ACCOUNT_LIMITS.operations) invalid();
  const seen = new Set<string>();
  const operations = value.operations.map((rawOperation: unknown): AccountOperation => {
    const op = object(rawOperation);
    if (!ACCOUNT_COLLECTIONS.includes(op.collection) || !['upsert', 'delete'].includes(op.type)) invalid();
    const key = id(op.id);
    if (seen.has(`${op.collection}:${key}`)) invalid();
    seen.add(`${op.collection}:${key}`);
    return { type: op.type, collection: op.collection, id: key, ...(op.type === 'upsert' ? { value: item(op.value, key, op.collection === 'userPlaylists') } : {}) };
  });
  const result = { operationId: value.operationId, baseVersion: value.baseVersion, operations };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > ACCOUNT_LIMITS.bodyBytes) throw new AccountError('PAYLOAD_TOO_LARGE', 'Account payload exceeds limit', 413);
  return result;
}
export function emptyAccountSnapshot(): AccountSnapshot {
  return { schemaVersion: 1, version: 0, updatedAt: null, tombstones: [], likedSongs: [], collectedPlaylists: [], followedArtists: [], likedMvs: [], collectedAlbums: [], userPlaylists: [] };
}
export function getAccountStore(env: AppEnv): AccountStore {
  const store = env.ACCOUNT_STORE as AccountStore;
  if (!store || store.kind !== 'sqlite' || store.schemaVersion !== 1 || typeof store.getLibrary !== 'function' || typeof store.applyLibraryMutation !== 'function') throw new AccountError('ACCOUNT_STORAGE_UNAVAILABLE', 'Persistent account storage unavailable', 503);
  return store;
}

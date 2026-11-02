import { httpGet, httpPost } from '@/utils/http'

export const ACCOUNT_COLLECTIONS = [
  'likedSongs',
  'collectedPlaylists',
  'followedArtists',
  'likedMvs',
  'collectedAlbums',
  'userPlaylists',
] as const

export type AccountCollection = (typeof ACCOUNT_COLLECTIONS)[number]

export type AccountRecord = Record<string, unknown> & { id: string | number; name: string }

export interface AccountSnapshot {
  schemaVersion: 1
  version: number
  updatedAt: number | null
  likedSongs: AccountRecord[]
  collectedPlaylists: AccountRecord[]
  followedArtists: AccountRecord[]
  likedMvs: AccountRecord[]
  collectedAlbums: AccountRecord[]
  userPlaylists: AccountRecord[]
  tombstones: Array<{
    collection: AccountCollection
    id: string
    version: number
    deletedAt: number
  }>
}

export interface AccountOperation {
  type: 'upsert' | 'delete'
  collection: AccountCollection
  id: string
  value?: unknown
}

export interface AccountPersistenceMeta {
  storageKind: 'sqlite'
  persistenceConfirmed: true
}

export interface AccountMutationResult {
  operationId: string
  version: number
  updatedAt: number
  replayed: boolean
}

export class AccountApiError extends Error {
  readonly code: string
  readonly status: number
  readonly currentVersion?: number
  readonly retryable: boolean

  constructor(
    code: string,
    message: string,
    status = 503,
    currentVersion?: number,
    retryable = status >= 500,
  ) {
    super(message)
    this.name = 'AccountApiError'
    this.code = code
    this.status = status
    this.currentVersion = currentVersion
    this.retryable = retryable
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalidResponse(message: string): never {
  throw new AccountApiError('INVALID_ACCOUNT_RESPONSE', message, 502, undefined, false)
}

function assertPersistenceMeta(value: unknown): asserts value is AccountPersistenceMeta {
  if (!isRecord(value) || value.storageKind !== 'sqlite' || value.persistenceConfirmed !== true) {
    invalidResponse('Account persistence was not confirmed by the server')
  }
}

function assertSnapshot(value: unknown): asserts value is AccountSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) invalidResponse('Invalid account snapshot schema')
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 0) {
    invalidResponse('Invalid account snapshot version')
  }
  if (
    value.updatedAt !== null &&
    (typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)
  ) {
    invalidResponse('Invalid account snapshot timestamp')
  }
  for (const collection of ACCOUNT_COLLECTIONS) {
    if (!Array.isArray(value[collection])) invalidResponse(`Invalid account collection: ${collection}`)
  }
  if (!Array.isArray(value.tombstones)) invalidResponse('Invalid account tombstones')
}

function errorFromResponse(error: any): AccountApiError {
  if (error instanceof AccountApiError) return error
  const status = Number(error?.response?.status) || 503
  const body = error?.response?.data
  const detail = isRecord(body?.error) ? body.error : undefined
  const code = typeof detail?.code === 'string' ? detail.code : status === 409 ? 'VERSION_CONFLICT' : 'ACCOUNT_REQUEST_FAILED'
  const message =
    code === 'VERSION_CONFLICT'
      ? 'Account changed elsewhere; the latest version will be fetched before retrying'
      : status === 401
        ? 'A verified account session is required'
        : status >= 500
          ? 'Account storage is temporarily unavailable'
          : 'Account request was rejected'
  const currentVersion = Number.isSafeInteger(body?.currentVersion) ? Number(body.currentVersion) : undefined
  return new AccountApiError(code, message, status, currentVersion, status >= 500 || code === 'VERSION_CONFLICT')
}

export function isAccountVersionConflict(error: unknown): error is AccountApiError {
  return error instanceof AccountApiError && error.code === 'VERSION_CONFLICT'
}

export async function fetchAccountLibrary(signal?: AbortSignal): Promise<AccountSnapshot> {
  try {
    const response = await httpGet<{
      brand?: string
      data?: AccountSnapshot
      meta?: AccountPersistenceMeta
    }>('/account/library', undefined, signal ? { signal } : undefined)
    if (!response?.data) invalidResponse('Missing account snapshot')
    assertPersistenceMeta(response.meta)
    assertSnapshot(response.data)
    return response.data
  } catch (error) {
    throw errorFromResponse(error)
  }
}

export async function applyAccountLibraryMutation(input: {
  operationId: string
  baseVersion: number
  operations: AccountOperation[]
}): Promise<AccountMutationResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) {
    throw new AccountApiError('INVALID_ACCOUNT_PAYLOAD', 'Invalid account operation id', 400, undefined, false)
  }
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0 || !input.operations.length) {
    throw new AccountApiError('INVALID_ACCOUNT_PAYLOAD', 'Invalid account mutation metadata', 400, undefined, false)
  }

  try {
    const response = await httpPost<{
      data?: AccountMutationResult
      meta?: AccountPersistenceMeta
    }>('/account/library', input, {
      headers: {
        'Idempotency-Key': input.operationId,
      },
    })
    assertPersistenceMeta(response?.meta)
    const result = response?.data
    if (
      !result ||
      result.operationId !== input.operationId ||
      !Number.isSafeInteger(result.version) ||
      result.version < 0 ||
      !Number.isSafeInteger(result.updatedAt) ||
      result.updatedAt < 0 ||
      typeof result.replayed !== 'boolean'
    ) {
      invalidResponse('Invalid account mutation response')
    }
    return result
  } catch (error) {
    throw errorFromResponse(error)
  }
}

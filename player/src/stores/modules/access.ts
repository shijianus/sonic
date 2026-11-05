import { defineStore } from 'pinia'
import { httpGet, httpPost } from '@/utils/http'

export type AccessMode = 'open' | 'invite'
export type AccessStatusKind = 'loading' | 'open' | 'granted' | 'required' | 'error'
export type AccessErrorKind = 'network' | 'invalid' | 'rateLimited' | 'server' | null

export interface AccessStatusResponse {
  ok?: boolean
  mode?: unknown
  accessMode?: unknown
  required?: unknown
  inviteRequired?: unknown
  accessRequired?: unknown
  granted?: unknown
  authorized?: unknown
  allowed?: unknown
  accessGranted?: unknown
  hasAccess?: unknown
  isAllowed?: unknown
  status?: unknown
  state?: unknown
  access?: Record<string, unknown>
  error?: { code?: unknown; message?: unknown } | string
  message?: unknown
}

export interface AccessState {
  mode: AccessMode | null
  granted: boolean
  status: AccessStatusKind
  isLoading: boolean
  isRedeeming: boolean
  errorKind: AccessErrorKind
  errorMessage: string
  lastCheckedAt: number
}

export const ACCESS_API_PATHS = {
  status: '/access/session',
  redeem: '/access/invite',
  logout: '/access/logout',
} as const

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const sourceOf = (payload: AccessStatusResponse): Record<string, unknown> => {
  const nested = asRecord(payload.access)
  return Object.keys(nested).length ? { ...payload, ...nested } : (payload as Record<string, unknown>)
}

const booleanValue = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true
      if (value.toLowerCase() === 'false') return false
    }
  }
  return undefined
}

const stringValue = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
  }
  return ''
}

const statusOf = (payload: AccessStatusResponse): { mode: AccessMode; granted: boolean } => {
  const source = sourceOf(payload)
  const modeValue = stringValue(source.mode, source.accessMode, source.policy)
  const stateValue = stringValue(source.status, source.state)
  const required = booleanValue(source.required, source.inviteRequired, source.accessRequired, source.requiresInvite)
  const granted = booleanValue(
    source.granted,
    source.authorized,
    source.allowed,
    source.access,
    source.accessGranted,
    source.hasAccess,
    source.isAllowed,
  )

  const mode: AccessMode =
    required === true || ['invite', 'invitation', 'restricted', 'gated'].includes(modeValue) ? 'invite' : 'open'

  if (granted !== undefined) return { mode, granted }
  if (['granted', 'authorized', 'allowed', 'open', 'public'].includes(stateValue)) {
    return { mode, granted: true }
  }
  if (['required', 'unauthorized', 'denied', 'invite'].includes(stateValue)) {
    return { mode: 'invite', granted: false }
  }
  return { mode, granted: mode === 'open' }
}

const httpStatus = (error: unknown): number | undefined => {
  const candidate = error as { response?: { status?: unknown }; status?: unknown } | null
  const value = candidate?.response?.status ?? candidate?.status
  return typeof value === 'number' ? value : undefined
}

const errorPayload = (error: unknown): AccessStatusResponse | undefined => {
  const candidate = error as { response?: { data?: unknown } } | null
  const data = candidate?.response?.data
  return data && typeof data === 'object' ? (data as AccessStatusResponse) : undefined
}

const errorCodeOf = (error: unknown): string => {
  const value = errorPayload(error)?.error
  if (typeof value === 'string') return value
  return value && typeof value === 'object' && typeof value.code === 'string' ? value.code : ''
}

const isNetworkError = (error: unknown): boolean => {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown } | null
  const text = `${candidate?.code || ''} ${candidate?.message || ''} ${candidate?.name || ''}`
  return /network|fetch|timeout|offline|econn|enotfound/i.test(text)
}

const errorKindOf = (error: unknown, redeem = false): AccessErrorKind => {
  const status = httpStatus(error)
  if (isNetworkError(error)) return 'network'
  if (redeem && (status === 400 || status === 401 || status === 403 || status === 404)) return 'invalid'
  if (status === 429) return 'rateLimited'
  return 'server'
}

export const useAccessStore = defineStore('access', {
  state: (): AccessState => ({
    mode: null,
    granted: false,
    status: 'loading',
    isLoading: false,
    isRedeeming: false,
    errorKind: null,
    errorMessage: '',
    lastCheckedAt: 0,
  }),

  getters: {
    canAccess: state => state.status === 'open' || state.status === 'granted',
    requiresInvite: state => state.status === 'required' || (state.mode === 'invite' && !state.granted),
  },

  actions: {
    async checkStatus(force = false): Promise<boolean> {
      if (this.isLoading) return this.canAccess
      if (!force && this.lastCheckedAt && Date.now() - this.lastCheckedAt < 5000) return this.canAccess

      this.isLoading = true
      this.errorKind = null
      this.errorMessage = ''
      try {
        const response = await httpGet<AccessStatusResponse>(ACCESS_API_PATHS.status)
        if (response?.ok === false) throw new Error(String(response.message || 'Access status rejected'))
        const result = statusOf(response || {})
        this.mode = result.mode
        this.granted = result.granted
        this.status = result.granted ? (result.mode === 'open' ? 'open' : 'granted') : 'required'
        this.lastCheckedAt = Date.now()
        return this.canAccess
      } catch (error) {
        // An invite-gated deployment rejects the status probe with HTTP 401 and
        // `mode: invite`. That is the normal "not yet admitted" state, not a
        // service failure: keep the invite form reachable. Legacy staging uses a
        // different 401 and has no invite endpoint, so surface it as an error.
        if (httpStatus(error) === 401 && errorCodeOf(error) !== 'STAGING_ACCESS_REQUIRED') {
          const result = statusOf(errorPayload(error) || {})
          this.mode = result.mode === 'open' ? 'invite' : result.mode
          this.granted = false
          this.status = 'required'
          this.errorKind = null
          this.errorMessage = ''
          this.lastCheckedAt = Date.now()
          return false
        }
        this.errorKind = errorKindOf(error)
        this.errorMessage = error instanceof Error ? error.message : ''
        this.status = 'error'
        this.lastCheckedAt = Date.now()
        return false
      } finally {
        this.isLoading = false
      }
    },

    async redeem(code: string): Promise<boolean> {
      const value = code.trim()
      if (!value || this.isRedeeming) return false

      this.isRedeeming = true
      this.errorKind = null
      this.errorMessage = ''
      try {
        const response = await httpPost<AccessStatusResponse>(ACCESS_API_PATHS.redeem, { code: value })
        if (response?.ok === false) throw new Error(String(response.message || 'Invite rejected'))
        this.mode = 'invite'
        // A successful redeem response is the grant; the follow-up status may omit a boolean flag.
        this.granted = true
        this.status = 'granted'
        this.lastCheckedAt = Date.now()
        return this.granted
      } catch (error) {
        const status = httpStatus(error)
        this.errorKind = errorKindOf(error, true)
        this.errorMessage = error instanceof Error ? error.message : ''
        // Invalid/expired/rate-limited codes keep the user on the invite form so
        // they can retry. Transport or storage failures are a real error state.
        if (status === 400 || status === 401 || status === 403 || status === 404 || status === 429) {
          this.mode = 'invite'
          this.granted = false
          this.status = 'required'
        } else {
          this.status = 'error'
        }
        return false
      } finally {
        this.isRedeeming = false
      }
    },

    async logout(): Promise<boolean> {
      this.isLoading = true
      try {
        const response = await httpPost<AccessStatusResponse>(ACCESS_API_PATHS.logout)
        if (response?.ok === false) throw new Error(String(response.message || 'Access logout rejected'))
        if (this.mode === 'invite') {
          this.granted = false
          this.status = 'required'
        } else {
          this.granted = true
          this.status = 'open'
        }
        this.errorKind = null
        this.errorMessage = ''
        this.lastCheckedAt = Date.now()
        return true
      } catch (error) {
        this.errorKind = errorKindOf(error)
        this.errorMessage = error instanceof Error ? error.message : ''
        return false
      } finally {
        this.isLoading = false
      }
    },
  },
})

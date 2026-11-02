/**
 * EpoCanvas Sonic - EpoMail OAuth account state.
 * Access invites are intentionally independent from this store.
 */
import { defineStore } from 'pinia'
import { httpGet, httpPost } from '@/utils/http'
import piniaPersistConfig from '../persist'
import { useLibraryStore } from './library'

export interface UserInfo {
  id: string
  email: string
  name: string
  avatar?: string
  role?: string
  createdAt?: string
  expiresAt?: string
}

export interface AuthState {
  user: UserInfo | null
  isAuthenticated: boolean
  isLoading: boolean
  lastSyncTime: number
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    lastSyncTime: 0,
  }),

  getters: {
    userName: state => state.user?.name || state.user?.email?.split('@')[0] || 'Guest',
    userEmail: state => state.user?.email || '',
    userAvatar: state => state.user?.avatar || '',
    userInitial: state => (state.user?.name || state.user?.email || 'U').charAt(0).toUpperCase(),
    userRole: state => state.user?.role || 'user',
  },

  actions: {
    async activateLibraryForUser(userId: string, force = false): Promise<boolean> {
      try {
        return await useLibraryStore().activateAccount(userId, force)
      } catch {
        return false
      }
    },

    deactivateLibrary(): void {
      try {
        useLibraryStore().deactivateAccount()
      } catch {}
    },

    getEpomailBaseUrl(): string {
      if (typeof window === 'undefined') return 'https://mail.epocanvas.com'
      const local = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      if (local && (window.location.port === '5089' || window.location.port === '5173')) {
        return `http://${window.location.hostname}:3001`
      }
      return 'https://mail.epocanvas.com'
    },

    getEpomailProfileUrl(): string {
      return `${this.getEpomailBaseUrl()}/#/settings/profile`
    },

    getEpomailInboxUrl(): string {
      return `${this.getEpomailBaseUrl()}/#/inbox`
    },

    /** Server verification is authoritative; cached profile data never grants account access. */
    async checkAuth(force = false): Promise<UserInfo | null> {
      const now = Date.now()
      if (!force && this.isAuthenticated && this.user && now - this.lastSyncTime < 5000) return this.user
      this.isLoading = true
      try {
        const response = await httpGet<{ ok: boolean; user?: UserInfo }>('/auth/user')
        if (response?.ok && response.user) {
          this.user = response.user
          this.isAuthenticated = true
          this.lastSyncTime = now
          this.isLoading = false
          void this.activateLibraryForUser(response.user.id, force)
          return response.user
        }
      } catch {
        // A network/API failure must not turn stale local profile data into a verified user.
      }
      this.user = null
      this.isAuthenticated = false
      this.lastSyncTime = now
      this.isLoading = false
      this.deactivateLibrary()
      return null
    },

    login(): void {
      if (typeof window !== 'undefined') window.location.href = '/api/auth/login'
    },

    async logout(): Promise<void> {
      this.isLoading = true
      try {
        await httpPost('/auth/logout')
      } catch {}
      this.user = null
      this.isAuthenticated = false
      this.lastSyncTime = 0
      this.deactivateLibrary()
      this.isLoading = false
    },

    openProfile(): void {
      if (typeof window !== 'undefined') window.open(this.getEpomailProfileUrl(), '_blank', 'noopener,noreferrer')
    },

    openInbox(): void {
      if (typeof window !== 'undefined') window.open(this.getEpomailInboxUrl(), '_blank', 'noopener,noreferrer')
    },
  },

  persist: piniaPersistConfig('auth', ['user', 'isAuthenticated']),
})

/**
 * EpoCanvas Sonic - 统一认证与账户管理 Store
 *
 * 全权委托 epocanvas-mail (EpoMail) 进行身份认证、多账号与个人资料管理。
 * 支持 /api/auth/user 校验、OAuth 统一跳转、本地会话同步与跨标签页状态协同。
 */
import { defineStore } from 'pinia'
import { httpGet, httpPost } from '@/utils/http'
import piniaPersistConfig from '../persist'

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
    userName: (state): string => {
      if (state.user?.name) return state.user.name
      if (state.user?.email) return state.user.email.split('@')[0]
      return 'Guest'
    },
    userEmail: (state): string => state.user?.email || '',
    userAvatar: (state): string => state.user?.avatar || '',
    userInitial: (state): string => {
      const name = state.user?.name || state.user?.email || 'U'
      return name.charAt(0).toUpperCase()
    },
    userRole: (state): string => state.user?.role || 'user',
  },

  actions: {
    /** 获取 EpoMail 宿主基址 (自适应本地开发 3001 端口与同源生产环境) */
    getEpomailBaseUrl(): string {
      if (typeof window === 'undefined') return ''
      const isLocalDev =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
      if (isLocalDev && (window.location.port === '5089' || window.location.port === '5173')) {
        return `http://${window.location.hostname}:3001`
      }
      return window.location.origin
    },

    /** 获取 EpoMail 个人中心与账号设置 URL */
    getEpomailProfileUrl(): string {
      const base = this.getEpomailBaseUrl()
      return `${base}/mail/#/settings/profile`
    },

    /** 获取 EpoMail 邮箱收件箱 URL */
    getEpomailInboxUrl(): string {
      const base = this.getEpomailBaseUrl()
      return `${base}/mail/`
    },

    /** 检查当前登录状态，从 /api/auth/user 或 EpoMail 本地会话同步 */
    async checkAuth(force = false): Promise<UserInfo | null> {
      // 避免短时间内过于频繁的无谓请求 (5 秒限频，除非强制刷新)
      const now = Date.now()
      if (!force && this.isAuthenticated && this.user && now - this.lastSyncTime < 5000) {
        return this.user
      }

      this.isLoading = true
      try {
        const res = await httpGet<{ ok: boolean; user?: UserInfo }>('/auth/user')
        if (res && res.ok && res.user) {
          this.user = res.user
          this.isAuthenticated = true
          this.lastSyncTime = now
          this.isLoading = false
          return this.user
        }
      } catch (_) {
        // 后端 401 或请求失败，尝试从共享的 EpoMail 本地凭证感知会话
      }

      // 联动检测：检查当前域的 localStorage 中是否存在 epocanvas-mail 凭证
      try {
        if (typeof window !== 'undefined') {
          const loginEmail = localStorage.getItem('loginEmail')
          const token = localStorage.getItem('token')
          const sessionsRaw = localStorage.getItem('epo_sessions')

          if (loginEmail && token) {
            let nickName = loginEmail.split('@')[0]
            let role = 'user'
            if (sessionsRaw) {
              try {
                const sessions = JSON.parse(sessionsRaw)
                if (Array.isArray(sessions) && sessions.length > 0) {
                  const match = sessions.find(
                    (s: any) => (s.email || '').toLowerCase() === loginEmail.toLowerCase()
                  ) || sessions[0]
                  if (match?.name) nickName = match.name
                  if (match?.roleName) role = match.roleName
                }
              } catch (_) {}
            }

            // 合成本地 EpoMail 会话展示状态
            this.user = {
              id: loginEmail,
              email: loginEmail,
              name: nickName,
              role,
            }
            this.isAuthenticated = true
            this.lastSyncTime = now
            this.isLoading = false
            return this.user
          }
        }
      } catch (_) {}

      this.user = null
      this.isAuthenticated = false
      this.lastSyncTime = now
      this.isLoading = false
      return null
    },

    /** 发起 EpoMail OAuth 统一登录 */
    login() {
      if (typeof window === 'undefined') return
      // 直接跳转至服务端 OAuth 入口，由服务端签发 PKCE 重定向至 epocanvas-mail
      window.location.href = '/api/auth/login'
    },

    /** 退出登录并清除会话 */
    async logout(): Promise<void> {
      this.isLoading = true
      try {
        await httpPost('/auth/logout')
      } catch (_) {}

      // 清理本地状态
      this.user = null
      this.isAuthenticated = false
      this.lastSyncTime = 0
      this.isLoading = false
    },

    /** 打开 EpoMail 个人中心页面 */
    openProfile() {
      if (typeof window === 'undefined') return
      window.open(this.getEpomailProfileUrl(), '_blank', 'noopener,noreferrer')
    },

    /** 打开 EpoMail Webmail 邮箱页面 */
    openInbox() {
      if (typeof window === 'undefined') return
      window.open(this.getEpomailInboxUrl(), '_blank', 'noopener,noreferrer')
    },
  },

  persist: piniaPersistConfig('auth', ['user', 'isAuthenticated']),
})

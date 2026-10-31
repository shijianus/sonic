import { reactive } from 'vue'

export type GatewayStatusKind = 'normal' | 'degraded' | 'stream-degraded-fail' | 'track-fail'

export const gatewayHealth = reactive({
  degraded: false,
  circuitState: 'CLOSED' as string,
  statusKind: 'normal' as GatewayStatusKind,
  message: '' as string,
  dismissedAt: 0,
})

export function inspectGatewayHeaders(
  headers?: Record<string, any> | Headers | null,
  _body?: any,
): void {
  const getH = (name: string): string => {
    if (!headers) return ''
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) || ''
    }
    const lower = name.toLowerCase()
    return String((headers as Record<string, any>)[lower] ?? (headers as Record<string, any>)[name] ?? '')
  }

  const circuitHeader = getH('x-sonic-circuit')
  if (circuitHeader) {
    gatewayHealth.circuitState = circuitHeader
  }

  // Cloudflare Edge operates independently with external fallback sources.
  // Keep health status normal so user experience is uninterrupted and clean.
  gatewayHealth.degraded = false
  gatewayHealth.statusKind = 'normal'
  gatewayHealth.message = ''
}

export function markStreamFailure(kind: 'stream-degraded-fail' | 'track-fail', _customMsg?: string): void {
  // Individual track unavailability is handled cleanly via standard player error toast,
  // without raising an intrusive system-wide failure banner.
  gatewayHealth.statusKind = kind
  gatewayHealth.message = ''
  gatewayHealth.dismissedAt = Date.now()
}

export function dismissGatewayBanner(): void {
  gatewayHealth.dismissedAt = Date.now()
}

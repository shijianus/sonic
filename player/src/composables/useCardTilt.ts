import { gsap } from 'gsap'
import { onUnmounted, type Ref } from 'vue'
import { readPrefersReducedMotion, useAmbientMotion } from './useAmbientMotion'

interface UseCardTiltOptions {
  enabled?: () => boolean
  maxDeg?: number
  scale?: number
  hoverY?: number
}

export const useCardTilt = (cardRef: Ref<HTMLElement | null>, options: UseCardTiltOptions = {}) => {
  const { isPerfMode } = useAmbientMotion()
  const maxDeg = options.maxDeg ?? 4.5
  const scale = options.scale ?? 1.015
  const hoverY = options.hoverY ?? -2

  let rect: DOMRect | null = null
  let rafId = 0
  let pendingEvent: { x: number; y: number } | null = null

  const isDisabled = () => isPerfMode.value || readPrefersReducedMotion()
  const isTiltEnabled = () => (options.enabled ? options.enabled() : true) && !isDisabled()

  const onMouseEnter = () => {
    const el = cardRef.value
    if (!el || isDisabled()) return
    rect = el.getBoundingClientRect()
    if (!isTiltEnabled()) {
      gsap.killTweensOf(el)
      gsap.to(el, { scale, y: hoverY, duration: 0.16, ease: 'power2.out' })
    }
  }

  const onMouseMove = (e: MouseEvent) => {
    const el = cardRef.value
    if (!el || !isTiltEnabled()) return
    if (!rect) rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    pendingEvent = { x: e.clientX, y: e.clientY }
    if (rafId) return

    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (!pendingEvent || !rect || !cardRef.value) return
      const mx = Math.max(-1, Math.min(1, (pendingEvent.x - (rect.left + rect.width / 2)) / (rect.width / 2)))
      const my = Math.max(-1, Math.min(1, (pendingEvent.y - (rect.top + rect.height / 2)) / (rect.height / 2)))
      gsap.to(cardRef.value, {
        rotateX: -my * maxDeg,
        rotateY: mx * maxDeg,
        scale,
        duration: 0.12,
        ease: 'power2.out',
        transformPerspective: 900,
        overwrite: 'auto',
      })
    })
  }

  const onMouseLeave = () => {
    rect = null
    pendingEvent = null
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    const el = cardRef.value
    if (!el) return
    gsap.killTweensOf(el)
    if (isDisabled()) {
      gsap.set(el, { clearProps: 'transform' })
      return
    }
    gsap.to(el, {
      rotateX: 0,
      rotateY: 0,
      scale: 1,
      y: 0,
      duration: 0.18,
      ease: 'power2.out',
      transformPerspective: 900,
      clearProps: 'transform',
    })
  }

  onUnmounted(() => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  })

  return {
    onMouseEnter,
    onMouseMove,
    onMouseLeave,
  }
}

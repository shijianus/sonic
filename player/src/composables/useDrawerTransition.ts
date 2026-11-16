/**
 * 抽屉过渡动画组合式函数
 * 管理全屏播放器的共享元素过渡（封面飞入/飞出动画）
 * 包含降级方案：无法获取 footer 元素时使用滑入/滑出动画
 */
import { gsap } from 'gsap'
import type VinylDisc from '@/components/Player/VinylDisc.vue'
import { formatCoverUrl } from '@/utils/imageUrl'
import { readPrefersReducedMotion, useAmbientMotion } from './useAmbientMotion'

export interface DrawerTransitionOptions {
  /** 抽屉容器元素 */
  drawerRef: Ref<HTMLElement | null>
  /** VinylDisc 组件实例 */
  vinylDiscRef: Ref<InstanceType<typeof VinylDisc> | null>
  /** 当前歌曲 */
  currentSong: Ref<{ cover?: string } | null | undefined>
  /** 是否正在播放 */
  isPlaying: Ref<boolean>
}

export function useDrawerTransition(options: DrawerTransitionOptions) {
  const { drawerRef, vinylDiscRef, currentSong, isPlaying } = options

  /** 是否已渲染抽屉（控制 v-if） */
  const isRendered = ref(false)

  // ── 封面克隆工具 ──

  /** 生成封面背景图 CSS 值 */
  const coverBgImage = () =>
    currentSong.value?.cover
      ? `url("${formatCoverUrl(currentSong.value.cover, { size: 320, artist: (currentSong.value as any)?.artist })}")`
      : 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)'

  /** 创建封面克隆 DOM 元素（固定定位，用于飞行动画） */
  const createClone = (rect: DOMRect, borderRadius: string) => {
    const el = document.createElement('div')
    el.className = 'hero-clone-cover'
    el.style.cssText = `
      position: fixed; z-index: 9999;
      width: ${rect.width}px; height: ${rect.height}px;
      left: ${rect.left}px; top: ${rect.top}px;
      border-radius: ${borderRadius};
      background-image: ${coverBgImage()};
      background-size: cover; background-position: center;
      pointer-events: none;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    `
    document.body.appendChild(el)
    return el
  }

  /** 清理所有遗留的封面克隆元素 */
  const cleanupClones = () => {
    document.querySelectorAll('.hero-clone-cover').forEach(el => el.remove())
  }

  // ── 查询共享元素 ──

  /** 获取共享过渡所需的 DOM 元素 */
  const getTransitionElements = () => {
    const footer = document.getElementById('footer-cover')
    const cover = drawerRef.value?.querySelector('.album-cover') as HTMLElement | null
    const label = cover?.querySelector('.vinyl-label') as HTMLElement | null
    const songInfo = drawerRef.value?.querySelector('.song-info') as HTMLElement | null
    return { footer, cover, label, songInfo }
  }

  // ── 打开动画 ──

  /** 打开抽屉：纯 transform 合成器共享元素过渡或快速滑入 */
  const open = async () => {
    if (!drawerRef.value) return

    gsap.killTweensOf(drawerRef.value)
    gsap.set(drawerRef.value, { display: 'flex', opacity: 1, y: 0 })
    await nextTick()

    const { footer, cover, label, songInfo } = getTransitionElements()
    const { isPerfMode } = useAmbientMotion()

    if (readPrefersReducedMotion() || isPerfMode.value) {
      if (label) gsap.set(label, { opacity: 1 })
      if (songInfo) gsap.set(songInfo, { opacity: 1, y: 0 })
      if (isPlaying.value) vinylDiscRef.value?.startAlbumRotation()
      return
    }

    if (footer && cover && label) {
      const footerRect = footer.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const clone = createClone(footerRect, '14px')

      const dx = labelRect.left + labelRect.width / 2 - (footerRect.left + footerRect.width / 2)
      const dy = labelRect.top + labelRect.height / 2 - (footerRect.top + footerRect.height / 2)
      const sx = footerRect.width > 0 ? labelRect.width / footerRect.width : 1
      const sy = footerRect.height > 0 ? labelRect.height / footerRect.height : 1

      gsap.set(label, { opacity: 0 })
      if (songInfo) gsap.set(songInfo, { opacity: 0, y: 10 })

      gsap.fromTo(
        drawerRef.value,
        { opacity: 0 },
        { opacity: 1, duration: 0.18, ease: 'power2.out' }
      )

      const tl = gsap.timeline({
        onComplete: () => {
          gsap.set(label, { opacity: 1 })
          clone.remove()
          if (isPlaying.value) vinylDiscRef.value?.startAlbumRotation()
        },
      })

      tl.to(clone, {
        x: dx,
        y: dy,
        scaleX: sx,
        scaleY: sy,
        borderRadius: '50%',
        duration: 0.24,
        ease: 'power3.out',
      })

      if (songInfo) {
        tl.to(songInfo, { y: 0, opacity: 1, duration: 0.18, ease: 'power2.out' }, '-=0.14')
      }
    } else {
      const tl = gsap.timeline({
        onComplete: () => {
          if (isPlaying.value) vinylDiscRef.value?.startAlbumRotation()
        },
      })
      tl.fromTo(
        drawerRef.value,
        { y: 18, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.2, ease: 'power3.out', clearProps: 'transform' }
      )
      if (songInfo) {
        tl.fromTo(songInfo, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.16, ease: 'power2.out' }, '-=0.12')
      }
    }
  }

  // ── 关闭动画 ──

  /** 关闭抽屉：纯 transform 合成器飞回或快速淡出 */
  const close = () => {
    if (!drawerRef.value) {
      isRendered.value = false
      return
    }

    vinylDiscRef.value?.stopAlbumRotation()
    cleanupClones()

    const { isPerfMode } = useAmbientMotion()
    if (readPrefersReducedMotion() || isPerfMode.value) {
      gsap.set(drawerRef.value, { display: 'none', opacity: 0 })
      isRendered.value = false
      return
    }

    const { footer, cover, label } = getTransitionElements()

    if (footer && cover && label) {
      const footerRect = footer.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const clone = createClone(labelRect, '50%')

      const dx = footerRect.left + footerRect.width / 2 - (labelRect.left + labelRect.width / 2)
      const dy = footerRect.top + footerRect.height / 2 - (labelRect.top + labelRect.height / 2)
      const sx = labelRect.width > 0 ? footerRect.width / labelRect.width : 1
      const sy = labelRect.height > 0 ? footerRect.height / labelRect.height : 1

      gsap.set(label, { opacity: 0 })
      gsap.to(drawerRef.value, { opacity: 0, duration: 0.16, ease: 'power2.in' })
      gsap.to(clone, {
        x: dx,
        y: dy,
        scaleX: sx,
        scaleY: sy,
        borderRadius: '14px',
        duration: 0.2,
        ease: 'power2.inOut',
        onComplete: () => {
          clone.remove()
          isRendered.value = false
        },
      })
    } else {
      gsap.to(drawerRef.value, {
        y: 16,
        opacity: 0,
        duration: 0.16,
        ease: 'power2.in',
        onComplete: () => {
          isRendered.value = false
        },
      })
    }
  }

  return { isRendered, open, close }
}

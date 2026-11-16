<script setup lang="ts">
const hexToRgbTriplet = (hex: string): string => {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `${r}, ${g}, ${b}`
}

const toRgbCss = (hex: string): string => {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgb(${r}, ${g}, ${b})`
}

interface UltimateProps {
  bg1?: string
  bg2?: string
  color1?: string
  color2?: string
  color3?: string
  color4?: string
  color5?: string
  interactiveColor?: string
  circleSize?: string
  blending?: string
}

const props = withDefaults(defineProps<UltimateProps>(), {
  bg1: '#1E40AF',
  bg2: '#001152',
  color1: '#2563EB',
  color2: '#3B82F6',
  color3: '#64DCFF',
  color4: '#C83232',
  color5: '#B4B432',
  interactiveColor: '#2563EB',
  circleSize: '80%',
  blending: 'hard-light',
})

const cssVars = computed(() => {
  return {
    '--color-bg1': toRgbCss(props.bg1),
    '--color-bg2': toRgbCss(props.bg2),
    '--color1': hexToRgbTriplet(props.color1),
    '--color2': hexToRgbTriplet(props.color2),
    '--color3': hexToRgbTriplet(props.color3),
    '--color4': hexToRgbTriplet(props.color4),
    '--color5': hexToRgbTriplet(props.color5),
    '--color-interactive': hexToRgbTriplet(props.interactiveColor),
    '--circle-size': props.circleSize,
    '--blending': props.blending,
  } as Record<string, string>
})
</script>
<template>
  <div class="gradient-bg" :style="cssVars">
    <div class="gradients-container" aria-hidden="true">
      <div class="orb g1"></div>
      <div class="orb g2"></div>
      <div class="orb g3"></div>
      <div class="orb g4"></div>
    </div>
  </div>
</template>
<style lang="scss" scoped>
.gradient-bg {
  --color-bg1: rgb(30, 64, 175);
  --color-bg2: rgb(0, 17, 82);
  --color1: 37, 99, 235;
  --color2: 59, 130, 246;
  --color3: 100, 220, 255;
  --color4: 200, 50, 50;
  --color5: 180, 180, 50;
  --color-interactive: 37, 99, 235;
  --circle-size: 80%;

  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  /* 静态多维羽化光场网格：避免背景每帧重绘导致外层 backdrop-filter 缓存失效 */
  background:
    radial-gradient(120% 90% at 15% 15%, rgba(var(--color3), 0.16) 0%, transparent 55%),
    radial-gradient(100% 80% at 85% 85%, rgba(var(--color2), 0.18) 0%, transparent 60%),
    linear-gradient(135deg, var(--color-bg1), var(--color-bg2));

  .gradients-container {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .orb {
    position: absolute;
    border-radius: 9999px;
    pointer-events: none;
  }

  .g1 {
    width: var(--circle-size);
    height: var(--circle-size);
    top: -18%;
    left: -12%;
    background: radial-gradient(
      circle at center,
      rgba(var(--color1), 0.42) 0%,
      rgba(var(--color1), 0.16) 38%,
      rgba(var(--color1), 0) 72%
    );
  }

  .g2 {
    width: var(--circle-size);
    height: var(--circle-size);
    bottom: -22%;
    right: -14%;
    background: radial-gradient(
      circle at center,
      rgba(var(--color2), 0.36) 0%,
      rgba(var(--color2), 0.14) 40%,
      rgba(var(--color2), 0) 72%
    );
  }

  .g3 {
    width: calc(var(--circle-size) * 0.72);
    height: calc(var(--circle-size) * 0.72);
    top: 18%;
    right: 14%;
    background: radial-gradient(
      circle at center,
      rgba(var(--color3), 0.24) 0%,
      rgba(var(--color3), 0.08) 42%,
      rgba(var(--color3), 0) 72%
    );
    opacity: 0.85;
  }

  .g4 {
    width: calc(var(--circle-size) * 0.65);
    height: calc(var(--circle-size) * 0.65);
    bottom: 10%;
    left: 22%;
    background: radial-gradient(
      circle at center,
      rgba(var(--color4), 0.14) 0%,
      rgba(var(--color5), 0.05) 42%,
      rgba(var(--color4), 0) 72%
    );
    opacity: 0.6;
  }
}
</style>
// Sonic browser bootstrap. Kept as an external file so the static CSP can use
// script-src 'self' instead of allowing arbitrary inline scripts.

// 清理本域名下遗留的 Service Worker，避免旧缓存返回过期 index.html
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then(function (regs) {
      regs.forEach(function (reg) {
        reg.unregister()
      })
    })
    .catch(function () {})
}

// 路由过渡卡死看门狗（惰性安装）：内嵌 WebView 后台冻结等场景下 requestAnimationFrame
// 停摆，Vue 过渡永远停在 enter-from（opacity:0），页面呈空白。
// 平时不轮询：仅监听全局过渡事件，过渡启动后安排一次性检测；
// 只有过渡超过 1.5s（正常过渡仅 0.3s）仍未结束且 rAF 确认停摆时，
// 才注入 CSS 把所有过渡/动画时长归零强制内容可见（仅此一次，之后移除监听）。
;(function () {
  var applied = false
  var pendingTimer = 0
  var activeTransitions = 0
  function applyOverride() {
    if (applied) return
    applied = true
    clearTimeout(pendingTimer)
    document.documentElement.setAttribute('data-no-raf', '1')
    var style = document.createElement('style')
    style.textContent =
      'html[data-no-raf] *,html[data-no-raf] *::before,html[data-no-raf] *::after{transition-duration:0s!important;animation-duration:0s!important}'
    document.head.appendChild(style)
    document.removeEventListener('transitionstart', onTransitionStart, true)
    document.removeEventListener('transitionend', onTransitionEnd, true)
    document.removeEventListener('transitioncancel', onTransitionEnd, true)
  }
  function rafDead() {
    return new Promise(function (resolve) {
      var done = false
      requestAnimationFrame(function () {
        done = true
        resolve(false)
      })
      setTimeout(function () {
        if (!done) resolve(true)
      }, 400)
    })
  }
  function onTransitionStart() {
    if (applied) return
    activeTransitions++
    if (!pendingTimer) {
      pendingTimer = setTimeout(checkStall, 1500)
    }
  }
  function onTransitionEnd() {
    if (applied || activeTransitions === 0) return
    activeTransitions--
    if (activeTransitions === 0 && pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = 0
    }
  }
  function checkStall() {
    pendingTimer = 0
    if (applied || activeTransitions <= 0) return
    rafDead().then(function (dead) {
      if (applied) return
      if (dead) {
        applyOverride()
      } else {
        // rAF 正常但过渡仍未结束：重置计数，等下一批过渡事件再检测
        activeTransitions = 0
      }
    })
  }
  document.addEventListener('transitionstart', onTransitionStart, true)
  document.addEventListener('transitionend', onTransitionEnd, true)
  document.addEventListener('transitioncancel', onTransitionEnd, true)
})()

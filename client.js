/**
 * dsh-usage-hud —— 浏览器半侧
 *
 * 1) sidebar.footer.action —— 侧栏底部那块：今日 tokens/花费、余额、峰谷倒计时 + 进度条
 * 2) shell.overlay —— 右下角浮层小卡「本会话消耗估算 ¥x」，点击穿透
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  ★★★ 平时要改的东西，都在 ~/.dsh/usage-hud.json，不在这个文件里 ★★★    │
 * │                                                                          │
 * │   白光款式      "wave": "A" | "B" | "C"                                  │
 * │   卡片高度      "cardBottom": 96   数字越大越往上                        │
 * │   卡片右边距    "cardRight": 18                                          │
 * │   单价/高峰时段/节假日  见该文件里的分段说明                             │
 * │                                                                          │
 * │   改完不用重启：20 秒内自动生效，或在侧栏那块上右键一下立刻生效。        │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │  只有想改「光柱本身长什么样」（粗细/亮度/颜色/速度）才需要动这个文件：   │
 * │    → 下面 WAVE_CSS 里 A / B / C 三组，都有 ★ 标着                       │
 * │  改完这个文件必须两件事都做，否则看不到效果：                            │
 * │    1) 覆盖到 %USERPROFILE%\.dsh\profiles\desktop\node_modules\           │
 * │       dsh-usage-hud\client.js                                            │
 * │    2) 重启 DSH（客户端 bundle 是宿主启动时装配的）                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 数据来自 Host 的 GET /usage-hud/api/state 与 GET /usage-hud/api/session
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-hud',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const ACCENT = '#4d6bfe'
    const PEAK = '#ff8b3d'
    const POLL_MS = 20000
    const SESSION_POLL_MS = 15000

    /* ── 共享轮询：两个组件共用一份 state，最后一个卸载时停表 ── */
    const store = { data: null, error: null, listeners: new Set(), timer: null, busy: false }

    /* 会话卡自刷新总线：右键余额卡片时，会话卡也一起拉一次 */
    const sessionBus = { listeners: new Set(), bump() { for (const fn of sessionBus.listeners) fn() } }

    async function pull(fresh) {
      if (store.busy) return
      store.busy = true
      try {
        const res = await fetch('/usage-hud/api/state' + (fresh ? '?fresh=1' : ''), { cache: 'no-store' })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        store.data = await res.json()
        store.error = null
      } catch (error) {
        store.error = error && error.message ? error.message : String(error)
      } finally {
        store.busy = false
        for (const fn of store.listeners) fn()
      }
    }

    function subscribe(fn) {
      store.listeners.add(fn)
      if (store.timer === null) {
        pull(false)
        store.timer = setInterval(() => pull(false), POLL_MS)
      }
      return () => {
        store.listeners.delete(fn)
        if (store.listeners.size === 0 && store.timer !== null) {
          clearInterval(store.timer)
          store.timer = null
        }
      }
    }

    function useHud() {
      const [, force] = useState(0)
      useEffect(() => subscribe(() => force((n) => n + 1)), [])
      return store
    }

    /* ── 当前窗口的会话 id ──
       主视图保留（retainedBy.mainView > 0）的那个会话就是「这个窗口正在看的会话」。
       会话切换 / 窗口切换后立刻换口径，不再靠宿主猜「最近被写的会话」。 */
    function useCurrentSessionId(sessions) {
      const [id, setId] = useState(null)
      const ref = useRef(null)
      useEffect(() => {
        if (!sessions || typeof sessions.list?.getSnapshot !== 'function') {
          ref.current = null
          setId(null)
          return undefined
        }
        let offRetain = null
        const find = () => {
          try {
            const snap = sessions.list.getSnapshot()
            const byId = (snap && snap.byId) || {}
            const ids = (snap && Array.isArray(snap.ids)) ? snap.ids : Object.keys(byId)
            for (const sid of ids) {
              const row = byId[sid]
              const retained = row && row.retainedBy ? (Number(row.retainedBy.mainView) || 0) : 0
              if (retained > 0) return sid
            }
          } catch { /* 拿不到就回退到无 id（宿主猜最近会话） */ }
          return null
        }
        const refresh = () => {
          const next = find()
          if (next === ref.current) return
          ref.current = next
          if (offRetain) {
            try { offRetain() } catch { /* 已注销 */ }
            offRetain = null
          }
          if (next !== null) {
            try { offRetain = sessions.retainInfo(next).subscribe(refresh) } catch { /* 没有 retainInfo 也无妨，15 秒轮询兜底 */ }
          }
          setId(next)
        }
        const offList = sessions.list.subscribe(refresh)
        refresh()
        return () => {
          try { offList() } catch { /* 已注销 */ }
          if (offRetain) {
            try { offRetain() } catch { /* 已注销 */ }
          }
        }
      }, [sessions])
      return id
    }

    /* ── 格式化 ── */
    function fmtTokens(n) {
      const v = Number(n) || 0
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
      return String(Math.round(v))
    }

    function fmtYuan(n, digits) {
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      return '¥' + v.toFixed(digits)
    }

    function fmtDuration(seconds) {
      const s = Math.max(0, Math.round(Number(seconds) || 0))
      const d = Math.floor(s / 86400)
      const hh = Math.floor((s % 86400) / 3600)
      const mm = Math.floor((s % 3600) / 60)
      if (d > 0) return `${d}天${hh}时${mm}分`
      if (hh > 0) return `${hh}时${mm}分`
      return `${mm}分`
    }

    const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    function beijing(tsMs) {
      const d = new Date(Number(tsMs) + 8 * 3600 * 1000)
      return { dow: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() }
    }

    function fmtSwitch(tsMs) {
      if (!tsMs) return ''
      const t = beijing(tsMs)
      return `${WEEK[t.dow]} ${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}`
    }

    /* ── 右键刷新的白光 ──
     * 曲线照 balance-dsh 的 balance-wipe-head（.58s 从左到右、5% 淡入 82% 后淡出）。
     *
     * ★ 切款式（A/B/C）不用动这里，改 ~/.dsh/usage-hud.json 的 "wave" 即可。
     *   下面这段只在你想改「光柱本身长什么样」时才需要动，改完必须覆盖到
     *   ~/.dsh/profiles/desktop/node_modules/dsh-usage-hud/client.js 并重启 DSH。
     */
    const WAVE_CSS = `
/* ── 公共：扫过动画 + 纵向渐隐（中间亮、上下淡这套是所有款式共用的） ── */
@keyframes usage-hud-wipe-head{0%{left:0;opacity:0}5%{opacity:1}82%{opacity:1}100%{left:100%;opacity:0}}
.usage-hud-wave{position:absolute;left:0;right:0;top:0;bottom:0;overflow:hidden;border-radius:10px;pointer-events:none;z-index:2;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 24%,#000 76%,transparent 100%);
  mask-image:linear-gradient(to bottom,transparent 0,#000 24%,#000 76%,transparent 100%)}
.usage-hud-wave>i,.usage-hud-wave>b{position:absolute;top:0;bottom:0;left:0;
  animation:usage-hud-wipe-head .58s cubic-bezier(.34,.7,.26,1) forwards;will-change:left}

/* ★★★ 款式 A · 柔光柱：2px 细芯 + 26px 很散的横向柔光 ★★★
   >i 是细芯：width 改粗细，background 的 .72 改亮度，两个 box-shadow 改外发光大小
   >b 是柔光：width 26px 改光晕宽度，filter:blur(9px) 改柔和程度，.18 改浓度 */
.usage-hud-wave[data-v=A]>i{width:2px;margin-left:-1px;border-radius:999px;background:rgba(255,255,255,.72);filter:blur(.6px);
  box-shadow:0 0 12px 5px rgba(255,255,255,.22),0 0 26px 14px rgba(255,255,255,.11)}
.usage-hud-wave[data-v=A]>b{width:26px;margin-left:-13px;border-radius:999px;
  background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.18) 45%,rgba(255,255,255,.18) 55%,rgba(255,255,255,0));filter:blur(9px)}

/* ★★★ 款式 B · 钢丝：1px 硬芯 + 紧凑同心晕，没有大片光雾 ★★★ */
.usage-hud-wave[data-v=B]>i{width:1px;margin-left:-.5px;border-radius:999px;background:#fff;
  box-shadow:0 0 3px 1px rgba(255,255,255,.9),0 0 9px 3px rgba(255,255,255,.4),0 0 18px 7px rgba(255,255,255,.12)}
.usage-hud-wave[data-v=B]>b{display:none}

/* ★★★ 款式 C · 双束扫描：两条软光带错相追着走（>b 的 animation-delay 是第二条的滞后） ★★★ */
.usage-hud-wave[data-v=C]>i,.usage-hud-wave[data-v=C]>b{width:11px;border-radius:999px;
  background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.42) 50%,rgba(255,255,255,0));filter:blur(2.5px)}
.usage-hud-wave[data-v=C]>i{margin-left:-5px}
.usage-hud-wave[data-v=C]>b{margin-left:-17px;opacity:.7;animation-delay:.11s}

/* 系统开了「减少动效」时干脆不画 */
@media (prefers-reduced-motion:reduce){.usage-hud-wave{display:none}.usage-hud-sheet{display:none}}

/* ══════════ 玻璃片抽离（定稿 A）══════════
   透明玻璃片从左向右抽走：左棱 3px 白、上棱 1px 白.77(50%淡出)、
   前沿白→白→品红色散带、上下 12px→0 楔形粉光、外层三层柔光。
   玻璃覆盖的区域由 warp 副本承接（挂位移滤镜），原件用 clip-path 让开。 */
.usage-hud-sheet.pulling{animation:usage-hud-sweep .8s cubic-bezier(.3,.6,.3,1) forwards}
@keyframes usage-hud-sweep{0%{left:-6%;opacity:0}6%{opacity:1}84%{opacity:1}100%{left:100%;opacity:0}}

.usage-hud-sheet{
  position:absolute;top:0;bottom:0;left:0;width:100%;border-radius:inherit;z-index:3;pointer-events:none;
  background:transparent;will-change:left;
  box-shadow:
    inset 3px 0 1px -1.2px rgba(255,255,255,.95),   /* 左棱 3px 白 .95 */
    0 0 10px rgba(150,220,255,.55),                 /* 柔光 青 */
    0 0 22px rgba(255,110,210,.32),                 /* 柔光 品红 */
    0 0 40px rgba(120,170,255,.16);                 /* 柔光 蓝 */
}
/* 上棱：1px 白 .77，0→50% 渐变到 0，压在最上层不被粉色盖住 */
.usage-hud-sheet .topline{
  position:absolute;left:0;top:0;width:100%;height:1px;z-index:3;pointer-events:none;filter:blur(1px);
  background:linear-gradient(90deg,rgba(255,255,255,.77) 0,rgba(255,255,255,0) 50%);
}
/* 前沿色散带：白 → 白 → 品红（贴圆角裁切） */
.usage-hud-sheet .glow{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none}
.usage-hud-sheet .glow::after{
  content:"";position:absolute;left:-2px;top:0;bottom:0;width:10px;
  background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.68) 18%,rgba(255,255,255,.58) 46%,rgba(255,60,190,.48) 74%,rgba(255,60,190,0));
  filter:blur(2px);mix-blend-mode:screen;
}
/* 上/下楔形粉光：12px→0 厚、长 7%、纯粉 .27、blur 5px、离棱 1px */
.usage-hud-sheet .taper{position:absolute;left:0;width:7%;filter:blur(5px);pointer-events:none}
.usage-hud-sheet .taper.t{top:1px;bottom:0}
.usage-hud-sheet .taper.b{top:0;bottom:1px}
.usage-hud-sheet .taper>s{
  position:absolute;left:0;width:100%;height:12px;display:block;mix-blend-mode:screen;
  background:rgba(255,60,190,.27);
}
.usage-hud-sheet .taper.t>s{top:0;clip-path:polygon(0 0,100% 0,0 100%)}
.usage-hud-sheet .taper.b>s{bottom:0;clip-path:polygon(0 100%,100% 100%,0 0)}

/* ── 三层同框：原件 base 在流内撑高，副本 warp 绝对定位同框，
      两者盒子完全一致，所以 clip 边界零误差：不缝也不重影 ── */
.usage-hud-base{position:relative;z-index:1}
.usage-hud-base.pulling{animation:usage-hud-base-clip .8s cubic-bezier(.3,.6,.3,1) forwards}
@keyframes usage-hud-base-clip{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}

.usage-hud-warp{position:absolute;inset:0;z-index:2;pointer-events:none;filter:url(#usage-hud-liquid)}
.usage-hud-warp.pulling{animation:usage-hud-warp-clip .8s cubic-bezier(.3,.6,.3,1) forwards}
@keyframes usage-hud-warp-clip{from{clip-path:inset(0 0 0 0%)}to{clip-path:inset(0 0 0 100%)}}
`

    /* ── 侧栏底部那块 ── */
    function SidebarBlock(props) {
      const hud = useHud()
      const [waveToken, setWaveToken] = useState(0)
      const [pulling, setPulling] = useState(false)

      const data = hud.data
      const wide = props && props.wide !== false

      /* 右键：整块任意位置都能刷。
         - 玻璃片款：pulling 打开 → 玻璃片抽走 → 0.6s 后关掉，盒子回到素面
         - A/B/C 款：换 key 让白光重播 */
      const refresh = (event) => {
        if (event) event.preventDefault()
        setWaveToken((n) => n + 1)
        setPulling(true)
        if (typeof document !== 'undefined') {
          for (const id of ['usage-hud-disp-anim', 'usage-hud-turb-anim']) {
            const anim = document.getElementById(id)
            if (anim && typeof anim.beginElement === 'function') anim.beginElement()
          }
        }
        pull(true)
        sessionBus.bump()
        setTimeout(() => setPulling(false), 900)
      }

      if (data === null) {
        return h('div', { style: { padding: '6px 10px', fontSize: 11, opacity: 0.45 } },
          hud.error ? '用量读取失败' : '用量读取中…')
      }

      const w = data.window || {}
      const t = (data.usage && data.usage.totals) || {}
      const b = data.balance || {}
      const ui = data.ui || {}
      const waveVariant = ui.wave || 'pull'
      const isPeak = w.mode === 'peak'
      const balance = b.total
      const shortBalance = balance === null || balance === undefined ? '—' : fmtYuan(balance, 3)

      const shell = (children) => h('div', {
        className: 'usage-hud-shell',
        onContextMenu: refresh,
        title: '右键立即刷新',
        style: {
          position: 'relative', isolation: 'isolate', overflow: 'hidden',
          borderRadius: 10,
          background: 'rgba(128,128,128,.10)',
          border: '1px solid rgba(128,128,128,.14)',
          cursor: 'default',
          userSelect: 'none',
        },
      },
        h('style', null, WAVE_CSS),
        /* 位移滤镜：常驻但 scale 为 0，只有抽离时才动画 */
        waveVariant === 'pull' ? h('svg', { width: 0, height: 0, style: { position: 'absolute' } },
          h('filter', { id: 'usage-hud-liquid', x: '-20%', y: '-20%', width: '140%', height: '140%' },
            h('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.012 0.02', numOctaves: 2, seed: 7, result: 'noise' },
              h('animate', { attributeName: 'baseFrequency', values: '0.008 0.014;0.02 0.03;0.008 0.014', dur: '0.8s', begin: 'indefinite', id: 'usage-hud-turb-anim' })),
            h('feDisplacementMap', { in: 'SourceGraphic', in2: 'noise', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', id: 'usage-hud-disp' },
              h('animate', { attributeName: 'scale', values: '0;17;8;0', dur: '0.8s', begin: 'indefinite', id: 'usage-hud-disp-anim' }),
              h('feGaussianBlur', { stdDeviation: '0.2' })))) : null,

        /* 第三层：原件，留在流内负责撑高；抽离时按玻璃位置裁掉 */
        h('div', { className: pulling ? 'usage-hud-base pulling' : 'usage-hud-base' }, children),

        waveVariant === 'pull'
          ? (pulling ? [
            /* 第二层：被鼓起扭曲的副本，只显示玻璃覆盖的那一段 */
            h('span', { className: 'usage-hud-warp pulling', key: 'warp' + waveToken }, children),
            /* 第一层：玻璃片，光影/棱/色散/楔形，不挂滤镜 */
            h('span', { className: 'usage-hud-sheet pulling', key: 'sheet' + waveToken },
              h('b', { className: 'glow' },
                h('i', { className: 'topline' }),
                h('i', { className: 'taper t' }, h('s')),
                h('i', { className: 'taper b' }, h('s')))),
          ] : null)
          : h('span', { className: 'usage-hud-wave', 'data-v': waveVariant, key: 'w' + waveVariant + waveToken }, h('b'), h('i')))

      if (!wide) {
        return shell(h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '5px 0', fontSize: 11, fontWeight: 600, color: ACCENT,
            fontVariantNumeric: 'tabular-nums',
          },
        }, shortBalance))
      }

      const labelStyle = { opacity: 0.55, fontSize: 11 }
      const valueStyle = { fontSize: 11.5, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }

      return shell(h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px 9px', fontSize: 11 },
      },
        /* 今日 tokens / 花费 */
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
            h('span', { style: labelStyle }, '今日'),
            h('span', { style: { ...valueStyle, opacity: 0.8, fontWeight: 500 } }, `${fmtTokens(t.total)} tokens`)),
          h('span', { style: { ...valueStyle, color: ACCENT } }, fmtYuan(t.cost, 4))),

        /* 余额（整块右键即可刷新，这一行不再挂小图标） */
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('span', { style: labelStyle }, '余额'),
          h('span', { style: { ...valueStyle, opacity: b.error ? 0.5 : 1 } }, shortBalance)),

        /* 峰谷 + 倒计时 */
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 } },
            h('span', {
              style: {
                width: 6, height: 6, borderRadius: 3, background: isPeak ? PEAK : ACCENT,
                display: 'inline-block', transform: 'translateY(-1px)',
              },
            }),
            h('span', { style: { ...labelStyle, opacity: 0.75, color: isPeak ? PEAK : undefined } },
              w.reason || (isPeak ? '高峰' : '峰谷')),
            h('span', { style: { ...labelStyle, opacity: 0.45 } }, `剩余 ${fmtDuration(w.secondsToChange)}`)),
          h('span', { style: { ...labelStyle, opacity: 0.4, whiteSpace: 'nowrap' } },
            `${fmtSwitch(w.nextChange)} 转${w.nextIsPeak ? '峰' : '谷'}时`)),

        /* 进度条 */
        h('div', {
          style: { height: 2, borderRadius: 1, background: 'rgba(128,128,128,.22)', overflow: 'hidden', marginTop: 1 },
        }, h('div', {
          style: {
            width: `${Math.round((Number(w.progress) || 0) * 100)}%`, height: '100%',
            background: ACCENT, transition: 'width .6s ease',
          },
        }))))
    }

    /* ── 右下角那张卡：本会话消耗估算（位置读 config 的 cardBottom / cardRight） ── */
    function SessionCard({ sessions }) {
      const hud = useHud()
      const sessionId = useCurrentSessionId(sessions)
      const [value, setValue] = useState(null)
      const ui = (hud.data && hud.data.ui) || {}
      const cardBottom = Number.isFinite(ui.cardBottom) ? ui.cardBottom : 96
      const cardRight = Number.isFinite(ui.cardRight) ? ui.cardRight : 18

      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            /* 带上本窗口会话 id：每个窗口各显示各的；id 拿不到才让宿主猜 */
            const url = sessionId
              ? '/usage-hud/api/session?id=' + encodeURIComponent(sessionId)
              : '/usage-hud/api/session'
            const res = await fetch(url, { cache: 'no-store' })
            const json = await res.json()
            if (alive) setValue(json)
          } catch {
            /* 读不到就不显示 */
          }
        }
        load()
        sessionBus.listeners.add(load)
        const timer = setInterval(load, SESSION_POLL_MS)
        return () => {
          alive = false
          sessionBus.listeners.delete(load)
          clearInterval(timer)
        }
      }, [sessionId])

      if (!value || !value.found || !(Number(value.tokens) > 0)) return null

      const cost = Number(value.cost) || 0
      const subN = Number(value.subSessions) || 0
      const selfCost = Number(value.selfCost) || 0
      const subCost = cost - selfCost
      const title = `未命中输入 ${value.cacheMiss || 0} · 缓存命中 ${value.cacheHit || 0} · 输出 ${value.output || 0}`
        + (subN > 0
          ? `\n本会话 ¥${selfCost.toFixed(3)}（${fmtTokens(value.selfTokens || 0)} tok）＋ ${subN} 个子会话 ¥${subCost.toFixed(3)}`
          : '')
        + '\n（按每条消息发生时的峰谷价估算）'
      return h('div', {
        style: {
          position: 'fixed',
          right: cardRight,
          bottom: cardBottom,
          zIndex: 40,
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '7px 11px 8px',
          borderRadius: 10,
          border: '1px solid rgba(128,128,128,.28)',
          background: 'rgba(128,128,128,.12)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          boxShadow: '0 2px 10px rgba(0,0,0,.10)',
          color: 'inherit',
          userSelect: 'none',
        },
        title,
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.62, lineHeight: 1.3, whiteSpace: 'nowrap' },
        },
          h('span', null, '本会话消耗估算'),
          subN > 0
            ? h('span', {
                style: {
                  fontSize: 9.5, opacity: 0.8, padding: '0 4px', borderRadius: 4,
                  background: 'rgba(77,107,254,.20)', color: ACCENT, fontWeight: 600,
                },
              }, `含${subN}个子会话`)
            : null),
        h('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 6, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25 },
        },
          h('span', { style: { fontSize: 15, fontWeight: 600 } }, fmtYuan(cost, 3)),
          h('span', { style: { fontSize: 10.5, opacity: 0.5 } }, `${fmtTokens(value.tokens)} tok`)))
    }

    return {
      name: 'dsh-usage-hud',
      inject: ['slots', 'sessions'],
      apply(ctx) {
        const sessions = ctx.sessions
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'usage-hud',
          order: 10,
        }, SidebarBlock))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'usage-hud-session',
          order: 90,
        }, function SessionCardBound(props) {
          return h(SessionCard, { ...props, sessions })
        }))
      },
    }
  },
})

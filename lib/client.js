/**
 * dsh-money —— 浏览器半（client half）
 *
 * 这个文件是**手写的客户端 bundle**，不是打包产物：DSH 的 client-modules 只要求
 * 一个「用 __ModuleLoader__.load 注册自己」的普通脚本（文件缺 sourcemap 也没关系），
 * 所以这里省掉了 tsdown/TS 构建链 —— 改完本文件直接刷新页面即可生效。
 *
 * 契约（照抄官方 @deepseek-ai/dsh-client-modules 的 closure 形式）：
 *   - 包一层 window.__ModuleLoader__.load({ id, factory })，id 必须等于 package.json 的 name；
 *   - factory 收到的是宿主 module table 的 require()，只能 require 平台基线：
 *     react / react-dom / @deepseek-ai/cordis / @deepseek-ai/dsh-client-ui-slots 等；
 *   - 返回 module.exports，且里面必须是**命名导出形态**（apply / inject），
 *     不要写成 `module.exports = function`（Loader 取的是 exports 上的成员）。
 *
 * 渲染位置：slot 'sidebar.footer.action' —— 侧栏底部的可选动作区，
 * 由 @deepseek-ai/dsh-client-ui-sidebar 的 SidebarRoot 渲染在 footArea 里、
 * **设置按钮（sidebar.settings）正上方**。侧栏折叠成 56px 轨道时，owner 会传
 * wide=false，此时只显示紧凑金额。
 */
window.__ModuleLoader__.load({
  id: 'dsh-money',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** 宿主半注册的已鉴权路由（见 lib/index.js）。 */
    const ENDPOINT = '/api/dsh-money'
    /** 设置命名空间 —— 必须与 lib/index.js 的 NAMESPACE 完全一致。 */
    const NAMESPACE = 'dsh-money'
    /** 自动刷新间隔兜底值（真实值来自设置 refreshSeconds）。 */
    const REFRESH_MS = 60000
    /** 手动刷新的冷却时间：连点不会重复打接口（配合 in-flight 锁）。 */
    const MANUAL_COOLDOWN_MS = 700

    /**
     * settings 命名空间快照到达**之前**用的本地默认值 —— 必须与
     * `lib/index.js` 里 `buildSettingsSchema()` 的 `.default()` 逐字段一致，
     * 否则首帧会跳一下（schema 默认值随 describe 下发，到达后立刻覆盖这里）。
     */
    const DEFAULT_SETTINGS = { refreshSeconds: 60, showLabel: true, decimals: 2, clickRefresh: true }

    /** 设置卡片的可选项（用 select 而不是输入框：避免"边打字边写盘"互相打架）。 */
    const REFRESH_CHOICES = [10, 30, 60, 120, 300, 600]
    const DECIMAL_CHOICES = [0, 1, 2, 3, 4]

    /**
     * 设置镜像 store：把 settingsScope 的快照摊平成组件可订阅的普通对象。
     *
     * 为什么自己做一层：scope 在 apply 阶段（插件激活时）绑定，而组件是之后才渲染的；
     * 且「余额行」和「设置卡片」是两个不同的 slot 根，必须通过模块级 store 同步，
     * 否则改了设置余额行不会跟着变。
     */
    function createSettingsStore() {
      let scope = null
      let current = Object.assign({}, DEFAULT_SETTINGS)
      const listeners = new Set()
      const emit = () => {
        for (const fn of Array.from(listeners)) { try { fn() } catch (err) {} }
      }
      const adopt = () => {
        let value = null
        try {
          const snap = scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null
          if (snap && snap.value && typeof snap.value === 'object') value = snap.value
        } catch (err) { value = null }
        current = value ? Object.assign({}, DEFAULT_SETTINGS, value) : Object.assign({}, DEFAULT_SETTINGS)
        emit()
      }
      return {
        /** @returns 当前生效设置（永远是一个完整对象）。 */
        get: () => current,
        /** @param {() => void} fn - 订阅者。@returns 取消订阅函数。 */
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        /** 绑定 scope 并开始跟随。@returns 解绑逆操作。 */
        bind(next) {
          scope = next
          let off = null
          try { off = next && typeof next.subscribe === 'function' ? next.subscribe(adopt) : null } catch (err) { off = null }
          adopt()
          return () => {
            try { if (typeof off === 'function') off() } catch (err) {}
            if (scope === next) scope = null
          }
        },
        /** 写一个字段；失败只记 console，不打断 UI（宿主会拒绝并重发快照）。 */
        set(field, value) {
          try {
            if (scope && typeof scope.set === 'function') {
              Promise.resolve(scope.set(field, value)).catch((err) => {
                try { console.warn('[dsh-money] 设置写入失败: ' + field, err) } catch (innerErr) {}
              })
            }
          } catch (err) {
            try { console.warn('[dsh-money] 设置写入异常: ' + field, err) } catch (innerErr) {}
          }
        },
      }
    }

    const settingsStore = createSettingsStore()

    /** 订阅设置：任何字段变化都会让用到它的组件重渲染。 */
    function useSettings() {
      const [value, setValue] = React.useState(settingsStore.get())
      React.useEffect(() => settingsStore.subscribe(() => setValue(settingsStore.get())), [])
      return value
    }

    /**
     * 注入的样式（一次性 <style>，插件卸载时随之移除）。
     *
     * 一、`flex-wrap: wrap` —— 让余额和壁纸各占一行（壁纸那边一行代码都不用改）。
     *
     * 实测踩坑记录（靠自检报告定位）：slot 渲染器给每个占位者套了一层
     * **`display: contents`** 的包装 div（错误边界），所以
     * `:has(> [data-testid="dsh-money"])` 命中的是那层**不生成盒子**的包装层，
     * 打在它上面的 `flex-wrap` 完全无效 —— 真正的 flex 容器是再上一层的
     * `_<hash>_footerActions`，它仍是 nowrap：壁纸（width: calc(100% + 4px) = 260px）
     * 占满整行，我的按钮被排到 x=268（正好在侧栏 12…268 之外）→ 一个像素都看不见。
     * 所以这里同时写三条：类名后缀命中真正的行（主），两层 :has() 作为类名变动时的兜底
     * （`:has(> …)` 命中包装层是无害的空操作，`:has(> * > …)` 才命中真正的行）。
     *
     * 二、转圈动画：手动刷新时「获取余额中」旁边的 spinner。
     */
    const CSS_TEXT = [
      '[class*="footerActions"]{flex-wrap:wrap}',
      ':has(> [data-testid="dsh-money"]),:has(> * > [data-testid="dsh-money"]){flex-wrap:wrap}',
      '@keyframes dsh-money-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
      '[data-testid="dsh-money"] .dsh-money-spinner{animation:dsh-money-spin .7s linear infinite}',
      '@media (prefers-reduced-motion: reduce){[data-testid="dsh-money"] .dsh-money-spinner{animation-duration:2.4s}}',
    ].join('\n')

    /** 装样式；返回移除它的逆操作（交给 ctx.effect 收尾）。 */
    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-money')
        style.textContent = CSS_TEXT
        document.head.appendChild(style)
        return () => { try { style.remove() } catch (err) {} }
      } catch (err) {
        return () => {}
      }
    }

    /**
     * 布局自检开关（排障用，默认关闭）：开启后挂载 / 切宽窄 / 窗口变化时，把这一行的
     * 实测布局回传宿主（`?diag=` → 落到 `$DSH_HOME/.dsh-money-diag.json`）。
     *
     * 为什么留这么个东西：浏览器半的视觉问题（被挤成一个字、位置被顶出侧栏、
     * 根本没渲染）光看代码判断不了，而它又跑在没有开发工具的页面上。打开这个开关，
     * 报告里会带上「自己与最近 4 层祖先的尺寸/display/flex-wrap/overflow」以及
     * 「同容器里其它兄弟按钮的 flex 与宽度」，一眼就能看出是谁吃掉了宽度。
     * 本项目第一版就是靠它定位到「占位者外面套了一层 display: contents 包装层，
     * 换行规则打偏了」的。
     */
    const DIAG = false

    const SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }

    /** 把设置里的小数位收敛到合法区间（0..4；非法值回落到默认 2）。 */
    function decimalsOf(settings) {
      const n = Number(settings && settings.decimals)
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.decimals
      return Math.max(0, Math.min(4, Math.round(n)))
    }

    /** 完整金额文本：¥1,234.56（小数位来自设置；币种不认识时退化成「CODE 1,234.56」）。 */
    function moneyText(value, currency, decimals) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '--'
      const digits = Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(4, Math.round(Number(decimals)))) : 2
      const prefix = SYMBOL[currency] !== undefined ? SYMBOL[currency] : (currency ? currency + ' ' : '')
      return prefix + n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    }

    /** 轨道态（56px）用的紧凑金额：¥12.3 / ¥1.2k。 */
    function compactText(value, currency) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '--'
      const prefix = SYMBOL[currency] !== undefined ? SYMBOL[currency] : ''
      const abs = Math.abs(n)
      if (abs >= 1000) return prefix + (n / 1000).toFixed(1) + 'k'
      return prefix + (abs >= 100 ? n.toFixed(0) : n.toFixed(1))
    }

    function clockText(iso) {
      const at = iso ? new Date(iso) : new Date()
      if (!Number.isFinite(at.getTime())) return ''
      return at.toLocaleTimeString('zh-CN', { hour12: false })
    }

    /**
     * 量一次这一行的真实布局：自己 + 最近 4 层祖先的尺寸/display/overflow，
     * 以及同容器里其它兄弟（比如别的插件在同一行的按钮）各自的 flex/宽度。
     * 返回纯 JSON，交给宿主落盘。
     */
    function layoutReport(node) {
      try {
        const rect = (el) => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return null
          const r = el.getBoundingClientRect()
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
        const describe = (el) => {
          const cs = window.getComputedStyle(el)
          return {
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 60),
            rect: rect(el),
            display: cs.display,
            flexDirection: cs.flexDirection,
            flexWrap: cs.flexWrap,
            justifyContent: cs.justifyContent,
            flex: cs.flex,
            width: cs.width,
            overflow: cs.overflow,
            siblings: el.parentElement ? el.parentElement.children.length : 0,
          }
        }
        const chain = []
        let cur = node
        for (let i = 0; i < 4 && cur; i++) {
          const row = describe(cur)
          // 同一行的其它占位者：谁把宽度吃掉了，一看就知道
          row.kids = cur.children
            ? Array.prototype.slice.call(cur.children, 0, 6).map((kid) => ({
              tag: kid.tagName,
              tid: kid.getAttribute ? kid.getAttribute('data-testid') : null,
              text: String(kid.textContent || '').slice(0, 24),
              rect: rect(kid),
              flex: window.getComputedStyle(kid).flex,
              width: window.getComputedStyle(kid).width,
            }))
            : []
          chain.push(row)
          cur = cur.parentElement
        }
        return {
          at: new Date().toISOString(),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          text: String(node.textContent || ''),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          chain,
        }
      } catch (err) {
        return { at: new Date().toISOString(), error: String((err && err.message) || err) }
      }
    }

    /**
     * 拉余额：挂载时一次，之后按设置里的间隔（默认 60 秒）自动刷新；
     * 点一下按钮 = 手动强制刷新（可在设置里关掉）。
     *
     * 两个节流点：
     *   ① inFlight：请求在飞时一律不重复发（连点只会有一个请求）；
     *   ② 手动刷新 700ms 冷却：避免手抖连点把宿主和上游打爆。
     * 手动刷新期间 busy=true，按钮显示「获取余额中」+ 转圈；拿到结果（成功或失败）立刻消失。
     * 失败时**保留上一次的金额**（只把 title 换成错误原因），避免数字闪成 --。
     *
     * @param {number} intervalMs - 自动刷新间隔（设置改动会重新起表）。
     */
    function useBalance(intervalMs) {
      const [snap, setSnap] = React.useState({
        balance: null, currency: 'CNY', updatedAt: '', error: '', stale: false, busy: false,
      })
      const alive = React.useRef(true)
      const inFlight = React.useRef(false)
      const lastManualAt = React.useRef(0)

      const load = React.useCallback((manual) => {
        if (inFlight.current) return Promise.resolve(false)
        inFlight.current = true
        if (manual) setSnap((prev) => ({ ...prev, busy: true }))
        return fetch(ENDPOINT + (manual ? '?refresh=1' : ''), { cache: 'no-store' })
          .then((res) => res.json())
          .then((data) => {
            if (!alive.current || !data) return
            if (data.ok) {
              setSnap({
                balance: Number(data.balance),
                currency: String(data.currency || 'CNY'),
                updatedAt: String(data.updatedAt || ''),
                error: String(data.error || ''),
                stale: data.stale === true,
                busy: false,
              })
              return
            }
            setSnap((prev) => ({
              ...prev, error: String(data.error || data.code || '读取失败'), stale: false, busy: false,
            }))
          })
          .catch((err) => {
            if (!alive.current) return
            setSnap((prev) => ({
              ...prev, error: '请求失败: ' + String((err && err.message) || err), stale: false, busy: false,
            }))
          })
          .finally(() => { inFlight.current = false })
      }, [])

      /** 点按钮：防抖（在飞 + 冷却）后强制刷新。 */
      const refreshNow = React.useCallback(() => {
        const now = Date.now()
        if (inFlight.current) return
        if (now - lastManualAt.current < MANUAL_COOLDOWN_MS) return
        lastManualAt.current = now
        load(true)
      }, [load])

      const period = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 10000
        ? Number(intervalMs)
        : REFRESH_MS

      React.useEffect(() => {
        alive.current = true
        load(false)
        const timer = setInterval(() => { load(false) }, period)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load, period])

      return [snap, refreshNow]
    }

    /** 侧栏底部那一行「余额：¥xxx」。owner 只传 wide（侧栏是否展开）。 */
    function BalanceBadge(props) {
      const wide = props.wide === true
      const settings = useSettings()
      // 设置里的间隔（秒）→ 毫秒；非法值回落到 DEFAULT_SETTINGS。
      const periodMs = Math.max(10, Number(settings.refreshSeconds) || DEFAULT_SETTINGS.refreshSeconds) * 1000
      const [snap, refreshNow] = useBalance(periodMs)
      const [hover, setHover] = React.useState(false)
      const btnRef = React.useRef(null)

      // 布局自检（DIAG=false 时整段不生效）：挂载后、切宽窄后、窗口变化后各报一次。
      React.useEffect(() => {
        if (!DIAG) return undefined
        let timer = null
        const send = () => {
          try {
            if (!btnRef.current) return
            const report = layoutReport(btnRef.current)
            fetch(ENDPOINT + '?diag=' + encodeURIComponent(JSON.stringify(report)), { cache: 'no-store' }).catch(() => {})
          } catch (err) {}
        }
        const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(send, 600) }
        schedule()
        window.addEventListener('resize', schedule)
        return () => { if (timer) clearTimeout(timer); window.removeEventListener('resize', schedule) }
      }, [wide])

      const known = snap.balance !== null && Number.isFinite(snap.balance)
      const busy = snap.busy === true
      const full = moneyText(snap.balance, snap.currency, decimalsOf(settings))
      const label = settings.showLabel === false ? '' : '余额：'
      const clickable = settings.clickRefresh !== false
      const hint = busy
        ? '正在从 DeepSeek 获取余额…'
        : snap.error
          ? (label || '余额：') + full + '（' + snap.error + '）' + (clickable ? ' · 点击重试' : '')
          : known
            ? 'DeepSeek 余额 ' + full + (snap.stale ? ' · 余额未刷新（沿用上次结果）' : '') +
              (snap.updatedAt ? ' · 更新于 ' + clockText(snap.updatedAt) : '') +
              (clickable ? ' · 点击刷新' : ' · 在「设置 → 插件 → 可配置」里可调')
            : '正在读取 DeepSeek 余额…'

      // 布局要点（两处踩坑，最终方案）：
      //   ① 这条行是**共用**的横向 flex row（壁纸按钮也在里面）。DSH 官方占用者与
      //      dsh-bg-new 都用 width: calc(100% + 4px) 占满整行，谁在后面谁被顶出侧栏；
      //   ② 而 slot 渲染器给每个占位者套了一层 display: contents 的包装 div，
      //      所以「父层换行」的规则必须打在真正的行容器上（见 CSS_TEXT 的注释）。
      // 换行生效后余额独享一整行，这里就跟官方几何对齐：整行宽 + 左对齐 + 同一套悬浮底色。
      const rowStyle = {
        boxSizing: 'border-box',
        cursor: busy ? 'progress' : (clickable ? 'pointer' : 'default'),
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: '6px',
        width: wide ? 'calc(100% + 4px)' : '36px',
        minWidth: 0,
        height: wide ? '42px' : '36px',
        flex: '0 0 auto',
        margin: wide ? '4px -2px' : '0 auto',
        padding: wide ? '0 10px 0 8px' : '0',
        borderRadius: wide ? '12px' : '50%',
        border: 'none',
        outline: 'none',
        // 刷新中给一层底色，和「正在取数」的语义对上
        background: busy || hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-primary, #111)',
        fontFamily: 'inherit',
        fontSize: wide ? '14px' : '11px',
        fontWeight: wide ? '500' : '600',
        lineHeight: wide ? '22px' : '14px',
        textAlign: 'left',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }

      /** 转圈：CSS 动画在注入的 <style> 里（dsh-money-spinner）。 */
      const spinner = h('span', {
        key: 'spinner',
        className: 'dsh-money-spinner',
        'aria-hidden': true,
        style: {
          display: 'inline-block',
          flex: 'none',
          width: wide ? '12px' : '11px',
          height: wide ? '12px' : '11px',
          borderRadius: '50%',
          border: '2px solid currentColor',
          borderRightColor: 'transparent',
          opacity: '0.9',
        },
      })

      const children = busy
        ? (wide
            ? [spinner, h('span', { key: 'fetching', style: { flex: 'none' } }, '获取余额中')]
            : [spinner])
        : (wide
            ? [
                label
                  ? h('span', { key: 'label', style: { color: 'var(--dsw-alias-label-secondary, #6b6b6b)', flex: 'none' } }, label)
                  : null,
                h('span', {
                  key: 'amount',
                  style: {
                    color: snap.error ? 'var(--dsw-alias-label-secondary, #6b6b6b)' : 'inherit',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: '600',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                }, known ? full : '…'),
              ].filter(Boolean)
            : [h('span', { key: 'compact', style: { fontVariantNumeric: 'tabular-nums' } }, known ? compactText(snap.balance, snap.currency) : '…')])

      return h('button', {
        type: 'button',
        ref: btnRef,
        'data-testid': 'dsh-money',
        'data-busy': busy ? '' : undefined,
        'aria-busy': busy,
        'aria-label': busy ? '正在获取 DeepSeek 余额' : 'DeepSeek ' + (known ? '余额 ' + full : '余额'),
        title: hint,
        // 关掉「点击强制刷新」后按钮纯只读（保留 hover 反馈，不响应点击）
        onClick: clickable ? () => { refreshNow() } : undefined,
        onMouseEnter: () => { setHover(true) },
        onMouseLeave: () => { setHover(false) },
        onFocus: () => { setHover(true) },
        onBlur: () => { setHover(false) },
        style: rowStyle,
      }, children)
    }

    // ---- 设置卡片（「设置 → 插件 → 可配置」里那一张）----

    /** 一行「标签 + 控件」。 */
    function settingsRow(label, control, hint) {
      return h('label', {
        key: label,
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          minHeight: '28px',
        },
      }, [
        h('span', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 } }, [
          h('span', { key: 't', style: { fontSize: '13px', lineHeight: '18px' } }, label),
          hint ? h('span', { key: 'h', style: { fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, hint) : null,
        ].filter(Boolean)),
        control,
      ])
    }

    /** 下拉（刷新间隔 / 小数位）：用 select 避免「边打字边写盘」互相打架。 */
    function settingsSelect(field, value, choices, suffix) {
      const options = choices.slice()
      const n = Number(value)
      if (Number.isFinite(n) && options.indexOf(n) === -1) options.push(n)
      options.sort((a, b) => a - b)
      return h('select', {
        key: field,
        value: String(value),
        onChange: (event) => {
          const next = Number(event && event.target ? event.target.value : NaN)
          if (Number.isFinite(next)) settingsStore.set(field, next)
        },
        style: {
          flex: 'none',
          height: '28px',
          padding: '0 8px',
          borderRadius: '7px',
          border: '0.5px solid var(--dsw-alias-border-l3, #d9d9d9)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #444)',
          font: 'inherit',
          fontSize: '12px',
          cursor: 'pointer',
        },
      }, options.map((v) => h('option', { key: String(v), value: String(v) }, String(v) + (suffix || ''))))
    }

    /** 勾选框。 */
    function settingsToggle(field, checked) {
      return h('input', {
        key: field,
        type: 'checkbox',
        checked: checked === true,
        onChange: (event) => {
          settingsStore.set(field, !!(event && event.target && event.target.checked))
        },
        style: { flex: 'none', width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' },
      })
    }

    /**
     * 插件配置卡片。注册在 keyed slot `settings.plugin.item` 的 key=NAMESPACE 上，
     * 「可配置」页签按 settingsScope.describe() 的命名空间列表把它渲染出来 ——
     * 这也是插件出现在那个页签里的机制（卡片完全由插件自己提供，宿主不知道它长什么样）。
     */
    function BalanceSettingsCard() {
      const settings = useSettings()
      const box = {
        border: '0.5px solid var(--dsw-alias-border-l3, #e0e0e0)',
        borderRadius: '12px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      }
      return h('section', { style: box, 'data-testid': 'dsh-money-settings' }, [
        h('div', { key: 'title', style: { fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-primary, #111)' } }, '余额挂件'),
        h('div', { key: 'desc', style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #888)', marginBottom: '2px' } },
          '在侧栏底部显示 DeepSeek 余额。改动立即生效，无需重启。'),
        settingsRow('自动刷新间隔', settingsSelect('refreshSeconds', settings.refreshSeconds, REFRESH_CHOICES, ' 秒')),
        settingsRow('小数位数', settingsSelect('decimals', settings.decimals, DECIMAL_CHOICES, ' 位')),
        settingsRow('显示「余额：」前缀', settingsToggle('showLabel', settings.showLabel)),
        settingsRow('允许点击强制刷新', settingsToggle('clickRefresh', settings.clickRefresh), '关掉后余额行只读，不再响应点击'),
      ])
    }

    // ---- 插件入口（命名导出：apply / inject，绝不写 module.exports = fn）----

    exports.inject = ['slots', 'settingsScope']

    exports.apply = function (ctx) {
      // 注入样式（给这条共用的行加 flex-wrap: wrap + 转圈动画），卸载时自动移除。
      ctx.effect(() => installStyles(), 'dsh-money: styles')

      // 绑定宿主注册的 settings 命名空间：快照到达后 store 会通知余额行与卡片重渲染。
      // bind 失败（命名空间尚未注册 / 服务不可用）不致命 —— store 保持本地默认值。
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === 'function') {
          const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
          if (scope) ctx.effect(() => settingsStore.bind(scope), 'dsh-money: settings mirror')
        }
      } catch (err) {
        try { console.warn('[dsh-money] settings 绑定失败:', err) } catch (innerErr) {}
      }

      // 配置卡片：keyed slot，key 必须是 settings 命名空间本身。
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NAMESPACE,
      }, BalanceSettingsCard))

      // sidebar.footer.action 由 ui-sidebar 声明；用 slots.inject 等它出现
      // （声明之前 register 会抛 "slot ... is not declared"）。
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-money',
        // order 排在「壁纸」这类占满整行的占用者**之后**：让它留在自己那一行，
        // 余额落在它的下一行 —— 也就是紧贴「设置」正上方，且两边都不被挤。
        order: 20,
        label: '余额',
      }, BalanceBadge))
    }

    return module.exports
  },
})

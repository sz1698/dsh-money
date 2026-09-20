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
    /** 自动刷新间隔；点一下这个余额行会立刻强制刷新（跳过宿主 25 秒缓存）。 */
    const REFRESH_MS = 60000
    /** 手动刷新的冷却时间：连点不会重复打接口（配合 in-flight 锁）。 */
    const MANUAL_COOLDOWN_MS = 700

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

    /** 完整金额文本：¥1,234.56（币种不认识时退化成「CODE 1,234.56」）。 */
    function moneyText(value, currency) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '--'
      const prefix = SYMBOL[currency] !== undefined ? SYMBOL[currency] : (currency ? currency + ' ' : '')
      return prefix + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
     * 拉余额：挂载时一次，之后每 60 秒一次；点一下按钮 = 手动强制刷新。
     *
     * 两个节流点：
     *   ① inFlight：请求在飞时一律不重复发（连点只会有一个请求）；
     *   ② 手动刷新 700ms 冷却：避免手抖连点把宿主和上游打爆。
     * 手动刷新期间 busy=true，按钮显示「获取余额中」+ 转圈；拿到结果（成功或失败）立刻消失。
     * 失败时**保留上一次的金额**（只把 title 换成错误原因），避免数字闪成 --。
     */
    function useBalance() {
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

      React.useEffect(() => {
        alive.current = true
        load(false)
        const timer = setInterval(() => { load(false) }, REFRESH_MS)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load])

      return [snap, refreshNow]
    }

    /** 侧栏底部那一行「余额：¥xxx」。owner 只传 wide（侧栏是否展开）。 */
    function BalanceBadge(props) {
      const wide = props.wide === true
      const [snap, refreshNow] = useBalance()
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
      const full = moneyText(snap.balance, snap.currency)
      const hint = busy
        ? '正在从 DeepSeek 获取余额…'
        : snap.error
          ? '余额：' + full + '（' + snap.error + '）· 点击重试'
          : known
            ? 'DeepSeek 余额 ' + full + (snap.stale ? ' · 余额未刷新（沿用上次结果）' : '') +
              (snap.updatedAt ? ' · 更新于 ' + clockText(snap.updatedAt) : '') + ' · 点击刷新'
            : '正在读取 DeepSeek 余额…'

      // 布局要点（两处踩坑，最终方案）：
      //   ① 这条行是**共用**的横向 flex row（壁纸按钮也在里面）。DSH 官方占用者与
      //      dsh-bg-new 都用 width: calc(100% + 4px) 占满整行，谁在后面谁被顶出侧栏；
      //   ② 而 slot 渲染器给每个占位者套了一层 display: contents 的包装 div，
      //      所以「父层换行」的规则必须打在真正的行容器上（见 CSS_TEXT 的注释）。
      // 换行生效后余额独享一整行，这里就跟官方几何对齐：整行宽 + 左对齐 + 同一套悬浮底色。
      const rowStyle = {
        boxSizing: 'border-box',
        cursor: busy ? 'progress' : 'pointer',
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
                h('span', { key: 'label', style: { color: 'var(--dsw-alias-label-secondary, #6b6b6b)', flex: 'none' } }, '余额：'),
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
              ]
            : [h('span', { key: 'compact', style: { fontVariantNumeric: 'tabular-nums' } }, known ? compactText(snap.balance, snap.currency) : '…')])

      return h('button', {
        type: 'button',
        ref: btnRef,
        'data-testid': 'dsh-money',
        'data-busy': busy ? '' : undefined,
        'aria-busy': busy,
        'aria-label': busy ? '正在获取 DeepSeek 余额' : 'DeepSeek ' + (known ? '余额 ' + full : '余额'),
        title: hint,
        onClick: () => { refreshNow() },
        onMouseEnter: () => { setHover(true) },
        onMouseLeave: () => { setHover(false) },
        onFocus: () => { setHover(true) },
        onBlur: () => { setHover(false) },
        style: rowStyle,
      }, children)
    }

    // ---- 插件入口（命名导出：apply / inject，绝不写 module.exports = fn）----

    exports.inject = ['slots']

    exports.apply = function (ctx) {
      // 注入样式（给这条共用的行加 flex-wrap: wrap + 转圈动画），卸载时自动移除。
      ctx.effect(() => installStyles(), 'dsh-money: styles')
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

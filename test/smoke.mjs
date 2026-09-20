/**
 * dsh-money —— 浏览器半的冒烟测试（无任何依赖，node test/smoke.mjs 即可跑）
 *
 * 为什么要有这个文件：浏览器半不是普通模块，它必须满足 DSH client-modules 的
 * closure 契约（`window.__ModuleLoader__.load({id, factory})` → 返回命名导出的
 * exports），而这条契约只有在浏览器里才会被真正校验。这里用一个极简 React 桩 +
 * 假 __ModuleLoader__ / 假 settingsScope 把它按契约加载一遍，把「契约写错了」
 * 这类错误在刷新页面前就暴露出来：
 *   1) 模块 id / 命名导出 / inject 声明
 *   2) 两个 slot 的注册参数（席位、order / key）
 *   3) 换行所依赖的注入 CSS（flex-wrap: wrap）与转圈动画
 *   4) 三套渲染：展开态「余额：xxx」、轨道态紧凑金额、刷新中「获取余额中」
 *   5) 设置真的驱动显示（前缀 / 小数位 / 点击开关）与卡片的写入
 *   6) 点击刷新的防抖（连点只发一个请求）
 *
 * 注意：它**不**代替真机验证 —— 视觉与席位位置仍需在页面上看。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name
const SOURCE = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')

/** 注入样式的落地处（假 document）。 */
const injectedStyles = []
const fakeDocument = {
  head: { appendChild: (el) => { injectedStyles.push(el) } },
  createElement: () => ({
    attrs: {},
    textContent: '',
    setAttribute(name, value) { this.attrs[name] = value },
    remove() { const at = injectedStyles.indexOf(this); if (at !== -1) injectedStyles.splice(at, 1) },
  }),
}

/** fetch 计数桩：每次调用 +1，返回一份可用的余额载荷。 */
const fetchState = { count: 0, urls: [] }
const fakeFetch = (url) => {
  fetchState.count += 1
  fetchState.urls.push(String(url))
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: 101.76, currency: 'CNY', updatedAt: '2026-09-20T03:01:04.821Z' }) })
}

/** 默认的 settings 快照（真机上由宿主 schema 的 default 下发）。 */
const DEFAULT_SCOPE = { refreshSeconds: 60, showLabel: true, decimals: 2, clickRefresh: true }

/**
 * 造一个 React 桩。
 * `snapshot`='busy' 时把余额快照的 busy 置真（真机上是请求在飞的状态）；
 * `snapshot`='known' 时注入一个已知余额，用来验证金额格式化（否则初次渲染只有 '…'）。
 */
function makeReact({ snapshot = null } = {}) {
  return {
    // 与 React.createElement 一致：单个子节点就原样放 children（不是数组）
    createElement: (type, props, ...children) => ({
      type,
      props,
      children: children.length <= 1 ? children[0] : children,
    }),
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      if (value && typeof value === 'object' && 'balance' in value) {
        if (snapshot === 'busy') return [{ ...value, busy: true, balance: 101.76, currency: 'CNY' }, () => {}]
        if (snapshot === 'known') return [{ ...value, busy: false, balance: 101.76, currency: 'CNY', updatedAt: '2026-09-20T03:01:04.821Z' }, () => {}]
      }
      return [value, () => {}]
    },
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
}

/** 在干净的一轮里加载 bundle，返回 exports 与这一轮记录到的注册/写入。 */
function loadBundle({ snapshot = null, scopeValue = DEFAULT_SCOPE } = {}) {
  let registration = null
  const sandboxWindow = {
    __ModuleLoader__: { load: (value) => { registration = value } },
  }
  const context = vm.createContext({
    window: sandboxWindow,
    document: fakeDocument,
    console,
    require: (specifier) => {
      assert.equal(specifier, 'react', `客户端 bundle 只允许 require 平台基线模块，收到 "${specifier}"`)
      return makeReact({ snapshot })
    },
    fetch: fakeFetch,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  vm.runInContext(SOURCE, context, { filename: 'lib/client.js' })
  assert.ok(registration, 'bundle 没有调用 window.__ModuleLoader__.load —— 浏览器不会认领这个模块')
  assert.equal(registration.id, PACKAGE_NAME, '__ModuleLoader__.load 的 id 必须等于包名（package.json 的 name）')

  const slots = {}
  const writes = []
  const effects = []
  const scope = {
    getSnapshot: () => ({ status: 'ready', value: scopeValue, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    set: (field, value) => { writes.push([field, value]); return Promise.resolve() },
    unset: () => Promise.resolve(),
  }
  const ctx = {
    effect: (callback) => { effects.push(callback()); return () => {} },
    settingsScope: { bind: (options) => { ctx.boundNamespace = options.namespace; return scope } },
    slots: {
      inject: (key, callback) => { callback(); return () => {} },
      register: (options, component) => { slots[options.name] = { options, component }; return () => {} },
    },
  }
  const exportsObject = registration.factory(context.require)
  exportsObject.apply(ctx)
  return { exportsObject, slots, writes, effects, ctx, scope }
}

// ---- 契约：模块形状 ----
const base = loadBundle()
assert.equal(typeof base.exportsObject.apply, 'function', '客户端半必须导出 apply')
// 注意：bundle 在 vm 里执行，它的数组是另一个 realm 的 Array —— deepStrictEqual 会比较
// 原型而不相等，所以先拷到本 realm 再比。
assert.deepEqual([...base.exportsObject.inject], ['slots', 'settingsScope'],
  '客户端半必须声明 inject: [slots, settingsScope]（后者用于配置卡片与设置跟随）')
assert.equal(typeof base.exportsObject.default, 'undefined', '不要有默认导出（Loader 取 exports.default ?? exports）')

// ---- 两个 slot 的注册 ----
const badgeSlot = base.slots['sidebar.footer.action']
const cardSlot = base.slots['settings.plugin.item']
assert.ok(badgeSlot, '没有注册 sidebar.footer.action（余额行）')
assert.equal(badgeSlot.options.id, PACKAGE_NAME, 'list 席位的 id 用包名，便于排查重复注册')
assert.equal(typeof badgeSlot.options.order, 'number', 'list 席位需要 order 决定与其它入口的先后')
assert.ok(cardSlot, '没有注册 settings.plugin.item（配置卡片）—— 插件就不会出现在「可配置」页签里')
assert.equal(cardSlot.options.key, PACKAGE_NAME, 'keyed 席位的 key 必须是 settings 命名空间（= 包名）')
assert.equal(base.ctx.boundNamespace, PACKAGE_NAME, '必须绑定同名 settings 命名空间')

// ---- 注入的样式：换行规则 + 转圈动画 ----
assert.equal(injectedStyles.length, 1, 'apply 必须注入一份样式（换行规则 + 转圈动画）')
const css = injectedStyles[0].textContent
assert.equal(injectedStyles[0].attrs['data-plugin'], PACKAGE_NAME, '样式标签要能看出是谁注入的')
assert.match(css, /\[class\*="footerActions"\]\{flex-wrap:wrap\}/,
  '必须给真正的行容器（footerActions）加 flex-wrap: wrap —— 余额独占一行、不动壁纸，全靠它')
assert.match(css, /:has\(> \* > \[data-testid="dsh-money"\]\)\{flex-wrap:wrap\}/,
  '兜底规则：占位者外面套了一层 display:contents 包装层，必须再隔一层才命中真正的行')
assert.match(css, /@keyframes dsh-money-spin/, '转圈动画要有 keyframes')
assert.match(css, /\.dsh-money-spinner\{animation:dsh-money-spin/, 'spinner 要真的挂上动画')

// ---- 渲染：展开态是「余额：xxx」的一整行 ----
const wide = badgeSlot.component({ wide: true })
assert.equal(wide.type, 'button')
assert.equal(wide.props['data-testid'], PACKAGE_NAME)
const wideKids = wide.children.flat()
assert.equal(wideKids[0].children, '余额：', '展开态第一段必须是「余额：」，与需求一致')
assert.equal(typeof wide.props.title, 'string')
assert.equal(typeof wide.props.onClick, 'function', '默认允许点击刷新')

// ---- 渲染：轨道态（56px）只留紧凑金额 ----
const rail = badgeSlot.component({ wide: false })
assert.equal(rail.children.flat().length, 1, '轨道态只渲染一段紧凑金额')

// ---- 渲染：刷新中显示「获取余额中」+ 转圈，且 aria-busy 为真 ----
const busy = loadBundle({ snapshot: 'busy' })
const busyWide = busy.slots['sidebar.footer.action'].component({ wide: true })
const busyKids = busyWide.children.flat()
assert.equal(busyWide.props['data-busy'], '', '刷新中要有 data-busy 标记')
assert.equal(busyWide.props['aria-busy'], true, '刷新中 aria-busy 必须是 true')
assert.equal(busyKids[0].props.className, 'dsh-money-spinner', '刷新中第一个子节点是转圈')
assert.equal(busyKids[1].children, '获取余额中', '刷新中必须显示「获取余额中」')
const busyRail = busy.slots['sidebar.footer.action'].component({ wide: false })
assert.equal(busyRail.children.flat()[0].props.className, 'dsh-money-spinner', '轨道态刷新中只显示转圈')

// ---- 设置真的驱动显示（前缀关掉 / 0 位小数 / 禁止点击）----
const custom = loadBundle({ snapshot: 'known', scopeValue: { refreshSeconds: 30, showLabel: false, decimals: 0, clickRefresh: false } })
const customBadge = custom.slots['sidebar.footer.action'].component({ wide: true })
const customKids = customBadge.children.flat()
assert.equal(customKids.length, 1, '关掉「余额：」前缀后只该剩金额一段')
assert.equal(customKids[0].children, '¥102', '小数位设置为 0 时金额不带小数点')
assert.equal(customBadge.props.onClick, undefined, '关掉点击刷新后按钮不响应点击')

// ---- 配置卡片：四个字段 + 写入走 settingsStore.set ----
const card = cardSlot.component({})
assert.equal(card.props['data-testid'], 'dsh-money-settings')
assert.equal(card.children[0].children, '余额挂件', '卡片标题')
const rows = card.children.filter((child) => child && child.type === 'label')
assert.equal(rows.length, 4, '卡片应有四个设置项：刷新间隔 / 小数位 / 前缀 / 点击刷新')
const refreshSelect = rows[0].children[1]
assert.equal(refreshSelect.type, 'select')
refreshSelect.props.onChange({ target: { value: '300' } })
assert.deepEqual(base.writes.at(-1), ['refreshSeconds', 300], '改刷新间隔必须写进 settings')
const prefixToggle = rows[2].children[1]
assert.equal(prefixToggle.type, 'input', '前缀开关是个 input')
assert.equal(prefixToggle.props.type, 'checkbox', '前缀开关是勾选框')
prefixToggle.props.onChange({ target: { checked: false } })
assert.deepEqual(base.writes.at(-1), ['showLabel', false], '取消勾选必须写进 settings')

// ---- 行为：点击刷新的防抖（在飞 / 冷却期内不重复发请求）----
fetchState.count = 0
fetchState.urls = []
const behavior = loadBundle({ snapshot: 'known' })
const behaviorBadge = behavior.slots['sidebar.footer.action'].component({ wide: true })
behaviorBadge.props.onClick()
behaviorBadge.props.onClick() // 第二次点击：请求还在飞 → 必须被丢弃
assert.equal(fetchState.count, 1, '连点两次只能发出一个请求（in-flight 锁）')
assert.match(fetchState.urls[0], /\?refresh=1$/, '手动刷新要带 refresh=1 绕开宿主缓存')
await Promise.resolve()
await Promise.resolve()

console.log('[smoke] ok —— 契约 / 两个席位 / 换行样式 / 三套渲染 / 设置驱动 / 点击防抖 均符合预期')

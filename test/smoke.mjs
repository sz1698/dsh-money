/**
 * dsh-money —— 浏览器半的冒烟测试（无任何依赖，node test/smoke.mjs 即可跑）
 *
 * 为什么要有这个文件：浏览器半不是普通模块，它必须满足 DSH client-modules 的
 * closure 契约（`window.__ModuleLoader__.load({id, factory})` → 返回命名导出的
 * exports），而这条契约只有在浏览器里才会被真正校验。这里用一个极简 React 桩 +
 * 假 __ModuleLoader__ 把它按契约加载一遍，把「契约写错了」这类错误在刷新页面前
 * 就暴露出来：
 *   1) 模块 id / 命名导出 / slot 注册参数（席位、order）
 *   2) 换行所依赖的那条注入 CSS（flex-wrap: wrap）与转圈动画
 *   3) 展开态「余额：xxx」、轨道态紧凑金额、刷新中「获取余额中」三套渲染
 *   4) 点击刷新的防抖（连点只发一个请求）
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
let fetchCount = 0
let fetchUrls = []
const fakeFetch = (url) => {
  fetchCount += 1
  fetchUrls.push(String(url))
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, balance: 101.76, currency: 'CNY', updatedAt: '2026-09-20T03:01:04.821Z' }) })
}

/**
 * 造一个 React 桩。`busySnapshot` = true 时让 useState 的初值里 busy 为真，
 * 用来渲染「获取余额中」那一套（真机上那是请求在飞时的状态）。
 */
function makeReact({ busySnapshot = false } = {}) {
  return {
    // 与 React.createElement 一致：单个子节点就原样放 children（不是数组）
    createElement: (type, props, ...children) => ({
      type,
      props,
      children: children.length <= 1 ? children[0] : children,
    }),
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      if (busySnapshot && value && typeof value === 'object' && 'busy' in value) {
        return [{ ...value, busy: true, balance: 101.76 }, () => {}]
      }
      return [value, () => {}]
    },
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useEffect: () => {},
  }
}

/** 在干净的一轮里加载 bundle，返回它的 exports。 */
function loadBundle({ busySnapshot = false } = {}) {
  let registration = null
  const sandboxWindow = {
    __ModuleLoader__: { load: (value) => { registration = value } },
  }
  const context = vm.createContext({
    window: sandboxWindow,
    document: fakeDocument,
    console,
    // 浏览器半只允许 require 平台基线里的 react
    require: (specifier) => {
      assert.equal(specifier, 'react', `客户端 bundle 只允许 require 平台基线模块，收到 "${specifier}"`)
      return makeReact({ busySnapshot })
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
  return registration.factory(context.require)
}

// ---- 契约：模块形状 ----
const clientExports = loadBundle()
assert.equal(typeof clientExports.apply, 'function', '客户端半必须导出 apply')
// 注意：bundle 在 vm 里执行，它的数组是另一个 realm 的 Array —— deepStrictEqual 会比较
// 原型而不相等，所以先拷到本 realm 再比。
assert.deepEqual([...clientExports.inject], ['slots'], '客户端半必须声明 inject: [slots]')
assert.equal(typeof clientExports.default, 'undefined', '不要有 default 导出（Loader 取 exports.default ?? exports）')

// ---- apply(): 注入样式 + 注册到「设置上方」那个席位 ----
let injectedKey = null
let slotEntry = null
const effects = []
const fakeCtx = {
  effect: (callback) => { effects.push(callback()); return () => {} },
  slots: {
    inject: (key, callback) => { injectedKey = key; callback(); return () => {} },
    register: (options, component) => { slotEntry = { options, component }; return () => {} },
  },
}
clientExports.apply(fakeCtx)

assert.equal(injectedKey, 'sidebar.footer.action', '必须挂在 sidebar.footer.action（侧栏底部、设置上方的动作席位）')
assert.ok(slotEntry, '没有调用 ctx.slots.register')
assert.equal(slotEntry.options.name, 'sidebar.footer.action')
assert.equal(slotEntry.options.id, PACKAGE_NAME, 'list 席位的 id 用包名，便于排查重复注册')
assert.equal(typeof slotEntry.options.order, 'number', 'list 席位需要 order 决定与其它入口的先后')
assert.equal(typeof slotEntry.component, 'function')

// 样式：换行靠这条规则，别被后来的人删掉
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
const wide = slotEntry.component({ wide: true })
assert.equal(wide.type, 'button')
assert.equal(wide.props['data-testid'], PACKAGE_NAME)
// h('button', props, [子节点数组])：数组是「带 key 的列表」，这里拉平后按顺序断言
const wideKids = wide.children.flat()
assert.equal(wideKids[0].children, '余额：', '展开态第一段必须是「余额：」，与需求一致')
assert.equal(typeof wide.props.title, 'string')

// ---- 渲染：轨道态（56px）只留紧凑金额 ----
const rail = slotEntry.component({ wide: false })
assert.equal(rail.children.flat().length, 1, '轨道态只渲染一段紧凑金额')

// ---- 渲染：刷新中显示「获取余额中」+ 转圈，且 aria-busy 为真 ----
const busyEntry = loadBundle({ busySnapshot: true })
let busySlot = null
busyEntry.apply({
  effect: () => () => {},
  slots: {
    inject: (_key, callback) => callback(),
    register: (_options, component) => { busySlot = component; return () => {} },
  },
})
const busyWide = busySlot({ wide: true })
const busyKids = busyWide.children.flat()
assert.equal(busyWide.props['data-busy'], '', '刷新中要有 data-busy 标记')
assert.equal(busyWide.props['aria-busy'], true, '刷新中 aria-busy 必须是 true')
assert.equal(busyKids[0].props.className, 'dsh-money-spinner', '刷新中第一个子节点是转圈')
assert.equal(busyKids[1].children, '获取余额中', '刷新中必须显示「获取余额中」')
const busyRail = busySlot({ wide: false })
assert.equal(busyRail.children.flat().length, 1, '轨道态刷新中只显示转圈')
assert.equal(busyRail.children.flat()[0].props.className, 'dsh-money-spinner')

// ---- 行为：点击刷新的防抖（在飞 / 冷却期内不重复发请求）----
fetchCount = 0
fetchUrls = []
const behaviorEntry = loadBundle()
let behaviorSlot = null
behaviorEntry.apply({
  effect: () => () => {},
  slots: {
    inject: (_key, callback) => callback(),
    register: (_options, component) => { behaviorSlot = component; return () => {} },
  },
})
const rendered = behaviorSlot({ wide: true })
rendered.props.onClick()
rendered.props.onClick() // 第二次点击：请求还在飞 → 必须被丢弃
assert.equal(fetchCount, 1, '连点两次只能发出一个请求（in-flight 锁）')
assert.match(fetchUrls[0], /\?refresh=1$/, '手动刷新要带 refresh=1 绕开宿主缓存')
await Promise.resolve()
await Promise.resolve()

console.log('[smoke] ok —— 契约 / 换行样式 / 三套渲染 / 点击防抖 均符合预期')

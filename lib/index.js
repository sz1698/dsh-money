/**
 * dsh-money —— 宿主半（host half）
 *
 * 职责只有一件事：用 DSH 凭据服务里配置的 DEEPSEEK_API_KEY 去 DeepSeek
 * 官方余额接口取一次余额，然后经**已鉴权的 /api 通道**交给浏览器半。
 *
 * 为什么走 ctx.connection.fetch.register 而不是自己 ctx.webServer.register：
 * DSH 的 /api 前缀路由已经内建两道栅栏（Host/Origin 校验 + 浏览器会话鉴权，
 * 见 @deepseek-ai/dsh-client-connection 的 requestRejection）。自己注册裸路由
 * 必须手工复刻这两道栅栏，漏掉就等于把接口暴露给任意网页。用 /api 通道，
 * 路径只需满足「/api/<单段>」，鉴权与错误语义都由宿主负责。
 *
 * 注意：本文件**只允许命名导出**，绝不能出现 `export default` ——
 * Loader 的 unwrapExports 是 `exports.default ?? exports`，一旦有默认导出，
 * inject/name 会被整体丢弃，插件会在没注入任何服务的环境里运行。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-money'

/** connection：提供已鉴权的 /api 通道；credentials：读 API key。 */
export const inject = ['connection', 'credentials']

/**
 * 设置命名空间。这是插件出现在「设置 → 插件 → 可配置」页签的**唯一条件**：
 * 那个页签按 settingsScope.describe() 的命名空间列表渲染，每张卡片由插件自己在
 * 浏览器半按**同一个 key** 注册到 `settings.plugin.item`，宿主不需要知道卡片长什么样。
 * 命名空间必须是 /^[a-z][a-z0-9-]*$/ 且全局唯一（重复注册会抛错）。
 */
const NAMESPACE = 'dsh-money'

/**
 * 设置项 schema。`.default()` 就是"没配过的人"看到的行为，会随 describe 下发到浏览器半。
 *
 * ⚠️ 改默认值时必须同步改 `lib/client.js` 顶部的 `DEFAULT_SETTINGS`：浏览器半在拿到
 * namespace 快照**之前**先用那份本地默认值渲染，两边不一致会导致首帧跳变。
 */
function buildSettingsSchema() {
  return z.object({
    /** 自动刷新间隔（秒）。10 秒下限避免把上游打爆；600 秒上限够"只想偶尔看一眼"的人用。 */
    refreshSeconds: z.number().min(10).max(600).default(60),
    /** 是否显示「余额：」前缀（关掉就只有一个金额）。 */
    showLabel: z.boolean().default(true),
    /** 金额保留小数位（上游返回的是精确值，这里只影响显示）。 */
    decimals: z.number().min(0).max(4).default(2),
    /** 是否允许点击余额行强制刷新（关掉后点击不动作，纯粹只读）。 */
    clickRefresh: z.boolean().default(true),
  })
}


/** 浏览器半的自检报告落在这里（临时排障用，见 README「布局自检」）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DIAG_FILE = path.join(DSH_HOME, '.dsh-money-diag.json')

/** DeepSeek 官方余额接口（只返回余额快照，不提供流水）。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 密钥只存在 DSH 凭据服务里，配置文件中只出现这个「凭据名」。 */
const KEY_REF = 'DEEPSEEK_API_KEY'

/** 浏览器半轮询这个已鉴权路径。 */
const ROUTE_PATH = '/api/dsh-money'

/** 余额 25 秒内不重复请求（浏览器半本身 60 秒一轮，点击才强制刷新）。 */
const CACHE_MS = 25000

/** 单次上游请求超时：明显小于浏览器半的 25 秒，保证「失败也能及时给出 error」。 */
const TIMEOUT_MS = 8000

export function apply(ctx) {
  /** { at, payload } —— 最近一次成功结果。 */
  let cache = null
  /** 在途请求：并发调用复用同一个 Promise，避免同时打多个上游请求。 */
  let inFlight = null

  /**
   * 余额接口的 balance_infos 是数组（CNY / USD 各一条）。
   * 选择顺序：CNY 且为正 → 任意为正 → CNY → 第一条。
   * @param {unknown} infos - 接口返回的 balance_infos。
   * @returns {{ total_balance: unknown, currency?: unknown } | null}
   */
  function pickBalanceInfo(infos) {
    if (!Array.isArray(infos) || infos.length === 0) return null
    const amount = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
    return (
      infos.find((x) => x && x.currency === 'CNY' && amount(x) > 0) ||
      infos.find((x) => amount(x) > 0) ||
      infos.find((x) => x && x.currency === 'CNY') ||
      infos[0]
    )
  }

  /**
   * 真正去上游取一次余额。
   * 所有失败都化成 { ok:false, code, error } —— 绝不抛出，让浏览器半永远拿得到响应。
   * @returns {Promise<object>} 余额载荷
   */
  async function fetchBalance() {
    let cred = null
    try {
      cred = await ctx.credentials.resolve(KEY_REF)
    } catch (err) {
      // 凭据服务本身出错（与「确实没配」不同），报原文便于排查
      return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
    }
    if (!cred || !cred.value) {
      return { ok: false, code: 'NO_KEY', error: '未配置 ' + KEY_REF }
    }

    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      return { ok: false, code: 'HTTP', transient: true, error: '余额接口请求失败: ' + String((err && err.message) || err).slice(0, 200) }
    }
    if (!res.ok) {
      return { ok: false, code: 'HTTP', transient: res.status >= 500, error: '余额接口返回 HTTP ' + res.status }
    }

    let data
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }

    const info = pickBalanceInfo(data && data.balance_infos)
    const amount = info ? Number(info.total_balance) : NaN
    if (!info || !Number.isFinite(amount)) {
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    return {
      ok: true,
      balance: amount,
      currency: String(info.currency || 'CNY'),
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * 带缓存与去重的读取入口。
   * @param {boolean} force - true 时跳过缓存（浏览器半点一下「余额」就传 true）。
   * @returns {Promise<object>} 余额载荷
   */
  function readBalance(force) {
    const now = Date.now()
    if (!force && cache && now - cache.at < CACHE_MS) return Promise.resolve(cache.payload)
    if (inFlight) return inFlight
    inFlight = fetchBalance()
      .then((payload) => {
        if (payload.ok) cache = { at: Date.now(), payload }
        else if (payload.transient && cache) {
          // 瞬时网络抖动：沿用最近一次成功值，前端只标「未刷新」而不是翻成错误
          return { ...cache.payload, stale: true, error: payload.error }
        }
        return payload
      })
      .catch((err) => ({ ok: false, code: 'ERROR', error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200) }))
      .finally(() => { inFlight = null })
    return inFlight
  }

  // register 返回的 disposer 挂在调用方 fiber 上（服务代理把 this.ctx 绑到调用方），
  // 插件卸载/热重载时自动撤销，不需要手工 ctx.effect 包一层。
  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      let force = false
      // 自检报告：浏览器半把侧栏那一行的实测布局塞在 ?diag= 里，这里原样落盘，
      // 好让「看不到 / 被挤扁」这类纯视觉问题不依赖截图也能定位。
      const diag = url.searchParams.get('diag')
      if (diag) {
        try {
          fs.writeFileSync(DIAG_FILE, JSON.stringify({ at: new Date().toISOString(), report: JSON.parse(diag) }, null, 2), 'utf8')
        } catch (err) {
          try { ctx.logger?.warn?.('[dsh-money] diag 写入失败: ' + String((err && err.message) || err)) } catch (innerErr) {}
        }
      }
      try {
        force = url.searchParams.get('refresh') === '1'
      } catch (err) {}
      const payload = await readBalance(force)
      return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } })
    },
  })

  // —— 设置命名空间注册 ——
  // 用 ctx.inject(['settings'], …) 而不是把它写进本插件的 inject：settings 缺失时
  // 这段保持未激活，插件照常取余额（只是不出现在「可配置」页签里），也不会把整个
  // 插件拖成 INACTIVE。注册 API 见 @deepseek-ai/dsh-settings 的 register(ns, schema)。
  ctx.effect(() => ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.register(NAMESPACE, buildSettingsSchema())
      try { settingsCtx.logger?.info?.('[dsh-money] settings namespace registered: ' + NAMESPACE) } catch (err) {}
    } catch (err) {
      try { settingsCtx.logger?.warn?.('[dsh-money] settings 命名空间注册失败: ' + String((err && err.message) || err)) } catch (innerErr) {}
    }
  }), 'dsh-money: settings namespace')

  ctx.effect(() => {
    try { ctx.logger?.info?.('[dsh-money] ready: ' + ROUTE_PATH + ' (namespace ' + NAMESPACE + ')') } catch (err) {}
    return () => { cache = null; inFlight = null }
  }, 'dsh-money: balance cache')
}

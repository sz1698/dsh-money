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

export const name = 'dsh-money'

/** connection：提供已鉴权的 /api 通道；credentials：读 API key。 */
export const inject = ['connection', 'credentials']

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

  ctx.effect(() => {
    try { ctx.logger?.info?.('[dsh-money] ready: ' + ROUTE_PATH) } catch (err) {}
    return () => { cache = null; inFlight = null }
  }, 'dsh-money: balance cache')
}

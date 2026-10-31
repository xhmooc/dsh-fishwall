/**
 * lib/host.js —— dsh-fishwall 宿主半边
 *
 * 职责：
 *   1. 启动监控（lib/guard.mjs）：
 *        - 确保 Windows 文件审计就位（auditpol + SACL）
 *        - 每 intervalMs 拉一次 4663，算滑动窗口里的删除速率
 *        - 超阈值 → taskkill 正在删的进程 + 落事故记录
 *   2. 给设置页开四条路由（网页半边只读写这些，不碰逻辑）
 *
 * 配置：~/.dsh/fishwall.json
 * 日志：~/.dsh/fishwall.log
 * 事故：~/.dsh/fishwall-incidents/*.json
 * 暂停：~/.dsh/fishwall.pause（存在即只记录不动手）
 */

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { startGuard, loadConfig, DEFAULTS, log, readBreaker, resetBreaker, tripBreaker } from './guard.mjs'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = process.env.DSH_FISHWALL_CONFIG || join(HOME, 'fishwall.json')
const PAUSE_PATH = join(HOME, 'fishwall.pause')
const INCIDENT_DIR = join(HOME, 'fishwall-incidents')
const LOG_PATH = join(HOME, 'fishwall.log')

const PREFIX = '/dsh-fishwall'

/** 只接受认识的键，数值做范围钳制 —— 设置页写坏了也不至于把防护搞瘫 */
const NUM_RANGE = {
  intervalMs: [500, 60000],
  windowSec: [5, 600],
  threshold: [10, 100000],
  dshThreshold: [10, 100000],
  cooldownSec: [0, 86400],
}

function readRawConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    log(`fishwall.json 解析失败，按空配置处理: ${e?.message ?? e}`)
  }
  return {}
}

function saveConfig(patch = {}) {
  const next = { ...readRawConfig() }
  for (const [k, v] of Object.entries(patch)) {
    if (k in NUM_RANGE) {
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      next[k] = Math.min(NUM_RANGE[k][1], Math.max(NUM_RANGE[k][0], Math.round(n)))
    } else if (k === 'kill' || k === 'killDsh' || k === 'enabled' || k === 'autoAudit') {
      next[k] = Boolean(v)
    } else if (k === 'allow' && Array.isArray(v)) {
      next.allow = v.map(String).filter(Boolean).slice(0, 50)
    } else if (k === 'roots' && Array.isArray(v)) {
      next.roots = v.map(String).filter(Boolean).slice(0, 30)
    }
  }
  try { mkdirSync(dirname(CONFIG_PATH), { recursive: true }) } catch { /* 已有 */ }
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function readPaused() {
  return existsSync(PAUSE_PATH)
}

function setPaused(on) {
  try {
    if (on) writeFileSync(PAUSE_PATH, new Date().toISOString() + '\n', 'utf8')
    else if (existsSync(PAUSE_PATH)) rmSync(PAUSE_PATH, { force: true })
    return readPaused()
  } catch (e) {
    log(`切换暂停失败: ${e?.message ?? e}`)
    return readPaused()
  }
}

function recentIncidents(limit = 5) {
  try {
    if (!existsSync(INCIDENT_DIR)) return []
    return readdirSync(INCIDENT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, at: statSync(join(INCIDENT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map(({ file }) => {
        try {
          const j = JSON.parse(readFileSync(join(INCIDENT_DIR, file), 'utf8'))
          return {
            file,
            at: j.at,
            why: j.why,
            total: j.totalEvents,
            killed: (j.killed ?? []).map((k) => `${k.process}#${k.pid}`),
          }
        } catch {
          return { file, at: null, why: '(读不出来)', total: 0, killed: [] }
        }
      })
  } catch {
    return []
  }
}

function logTail(n = 12) {
  try {
    if (!existsSync(LOG_PATH)) return []
    return readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-n)
  } catch {
    return []
  }
}

const readBody = async (req) => {
  let body = ''
  for await (const chunk of req) body += chunk
  try { return JSON.parse(body || '{}') } catch { return {} }
}

const reply = (res, obj) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

export const name = 'dsh-fishwall'
// ⚠️ webServer 必须在 inject 里，否则 apply 时 ctx.webServer 是 undefined，
//    路由注册会抛错 → 整个 apply 挂掉 → 连带监控也起不来，
//    设置页就会永远停在「正在读取配置…」。
export const inject = ['webServer']

export function apply(ctx) {
  const say = (m) => {
    try { ctx?.logger?.info?.(m) } catch { /* logger 形状不保证 */ }
    if (process.env.DSH_FISHWALL_VERBOSE) console.log(m)
  }

  // 即使 webServer 没拿到也别让 apply 崩：监控比界面重要。
  const route = (path, handler) => {
    const server = ctx?.webServer
    if (!server || typeof server.register !== 'function') {
      say('[fishwall] 没有 webServer —— 设置页读不到配置，但监控照跑')
      return
    }
    try {
      ctx.effect(() =>
        server.register({
          kind: 'exact',
          path: PREFIX + path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (e) {
              reply(res, { ok: false, error: String(e?.message ?? e) })
            }
          },
        }),
      )
    } catch (e) {
      say(`[fishwall] 注册 ${path} 失败: ${e?.message ?? e}`)
    }
  }

  route('/config', async (req, res) => {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const saved = saveConfig(body)
      log(`设置已更新: threshold=${saved.threshold} dshThreshold=${saved.dshThreshold} kill=${saved.kill} killDsh=${saved.killDsh}`)
      return reply(res, { ok: true, config: { ...DEFAULTS, ...saved }, defaults: DEFAULTS })
    }
    reply(res, { ok: true, config: { ...DEFAULTS, ...readRawConfig() }, defaults: DEFAULTS, path: CONFIG_PATH })
  })

  route('/status', async (req, res) => {
    reply(res, {
      ok: true,
      paused: readPaused(),
      breaker: readBreaker(),
      configPath: CONFIG_PATH,
      logPath: LOG_PATH,
      incidents: recentIncidents(5),
      log: logTail(12),
    })
  })

  route('/pause', async (req, res) => {
    const body = await readBody(req)
    const on = body.on === undefined ? !readPaused() : Boolean(body.on)
    reply(res, { ok: true, paused: setPaused(on) })
  })

  // 熔断：复位 / 主动熔断
  route('/breaker', async (req, res) => {
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (body.reset) { resetBreaker(); return reply(res, { ok: true, breaker: null }) }
      if (body.trip) { tripBreaker(String(body.reason || '手动熔断')); return reply(res, { ok: true, breaker: readBreaker() }) }
    }
    reply(res, { ok: true, breaker: readBreaker() })
  })

  /**
   * 复核：拉闸之后问 DSH「这次是不是误报」。
   * 有子代理就用子代理问一句；没有就退回规则判断（至少不会因为判定器缺失而把监控搞挂）。
   * 返回 { verdict: 'allow'|'block'|'unknown', reason, allow: [...] }
   */
  const judgeIncident = async ({ why, offenders, total }) => {
    const names = [...new Set(offenders.map((o) => o.process))].join(', ')
    const sample = offenders.flatMap((o) => o.sample || []).slice(0, 8).join('\n')

    const subagents = (() => { try { return ctx.get?.('subagents') } catch { return null } })()
    if (subagents?.startActivation) {
      const prompt = [
        '你是一个文件删除告警的复核员，只回答一行。',
        '',
        `告警：${why}`,
        `删除进程：${names}`,
        `涉及文件数：${total}`,
        '被删路径样例：',
        sample,
        '',
        '判断：这次删除是「合法的系统维护/正常清理」还是「异常批量删除、应当阻止」？',
        '如果认为可以放行，就输出：ALLOW: 进程名1, 进程名2',
        '如果应当阻止，就输出：BLOCK: 一句话理由',
        '不要输出别的。',
      ].join('\n')
      try {
        const run = await subagents.startActivation({
          provider: 'spawn',
          label: 'fishwall 复核',
          request: { prompt: [{ type: 'text', text: prompt }] },
          signal: new AbortController().signal,
          delivery: 'caller',
        })
        const result = await run.result
        const out = (result?.output || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
        try { await run.dispose() } catch { /* 无所谓 */ }
        if (/^ALLOW/i.test(out)) {
          const allow = out.replace(/^ALLOW\s*:?\s*/i, '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)
          return { verdict: 'allow', reason: out.slice(0, 200), allow, by: 'dsh' }
        }
        if (/^BLOCK/i.test(out)) {
          return { verdict: 'block', reason: out.replace(/^BLOCK\s*:?\s*/i, '').slice(0, 200), by: 'dsh' }
        }
        return { verdict: 'unknown', reason: out.slice(0, 200) || '(子代理没有给出结论)', by: 'dsh' }
      } catch (e) {
        say(`[fishwall] 复核子代理没起来（改用规则判断）: ${e?.message ?? e}`)
      }
    }

    // 规则兜底：只看「删的是什么地方」——临时目录/构建产物/缓存 视为可放行
    const disposable = /[\\/](Temp|temp|tmp|\.tmp|node_modules|\.venv|uv-cache|Cache|cache|__pycache__|dist|build|\.next)[\\/]/
    const allDisposable = offenders.every((o) => (o.sample || []).every((p) => disposable.test(String(p))))
    if (allDisposable) return { verdict: 'allow', reason: '删的都是临时/缓存/构建产物（规则判断）', allow: [...new Set(offenders.map((o) => o.process))], by: 'rule' }
    return { verdict: 'unknown', reason: '没有可用的复核器（没有子代理），且路径不像临时目录', by: 'rule' }
  }

  try {
    const stop = startGuard({ log: say, judgeFn: judgeIncident })
    return () => {
      try { stop() } catch { /* 停不下来也不能抛 */ }
    }
  } catch (e) {
    say(`[fishwall] 启动失败: ${e?.message ?? e}`)
    return () => {}
  }
}

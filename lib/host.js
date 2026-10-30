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
import { startGuard, loadConfig, DEFAULTS, log } from './guard.mjs'

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
export const inject = []

export function apply(ctx) {
  const say = (m) => {
    try { ctx?.logger?.info?.(m) } catch { /* logger 形状不保证 */ }
    if (process.env.DSH_FISHWALL_VERBOSE) console.log(m)
  }

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
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

  try {
    const stop = startGuard({ log: say })
    return () => {
      try { stop() } catch { /* 停不下来也不能抛 */ }
    }
  } catch (e) {
    say(`[fishwall] 启动失败: ${e?.message ?? e}`)
    return () => {}
  }
}

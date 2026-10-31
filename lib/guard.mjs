/**
 * lib/guard.mjs —— 大量删除检测 + 拉闸
 *
 * 三件事：
 *   1. ensureAudit()  打开 Windows 文件审计（auditpol + SACL），幂等，结果缓存
 *   2. tick()         每 intervalMs 拉一次 4663 事件，算滑动窗口里的删除速率
 *   3. brake()        超过阈值就 taskkill 掉正在删的那个进程，并落一份事故记录
 *
 * 设计原则（照抄上次灾难的教训）：
 *   - 只信 4663（带 PID/进程名/路径），不靠猜；
 *   - 每次都先写事故记录，再动手，绝不"先杀后查"；
 *   - 系统关键进程永不杀；
 *   - 对 DSH 自己用更高的阈值（它写文件会产生临时文件删除，属正常）；
 *   - 冷却期内不重复触发，避免连环杀。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = process.env.DSH_FISHWALL_CONFIG || join(HOME, 'fishwall.json')
const LOG_PATH = join(HOME, 'fishwall.log')
const INCIDENT_DIR = join(HOME, 'fishwall-incidents')
const AUDIT_MARK = join(HOME, 'fishwall-audit.ok')
/** 维护模式：这个文件存在时，只记录不动手（装插件 / 重装 node_modules 前先建它） */
const PAUSE_PATH = join(HOME, 'fishwall.pause')

const isPaused = (cfg) => {
  try {
    if (existsSync(PAUSE_PATH)) return true
    if (cfg.pauseUntil && Date.now() < Number(cfg.pauseUntil)) return true
  } catch { /* 读不到就当没暂停 */ }
  return false
}

const FILE_SYSTEM_GUID = '{0CCE921D-69AE-11D9-BED3-505054503030}'

export const DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 3000,
  windowSec: 30,
  // 外部进程（pwsh / node / python / 随便什么）超过这个就拉闸
  threshold: 300,
  // DSH 自身（插件在进程内跑）阈值更高：它写文件会产生临时文件删除
  dshThreshold: 1500,
  cooldownSec: 300,
  kill: true,
  killDsh: true,
  allow: ['explorer.exe'],
  // 默认盯这几个：DSH 的家 + 三个用户目录。
  // 都从 homedir() 算，绝不写死某台机器的路径。
  roots: [
    HOME,
    join(homedir(), 'Desktop'),
    join(homedir(), 'Documents'),
    join(homedir(), 'Downloads'),
  ],
  autoAudit: true,
})

export function loadConfig() {
  let file = {}
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    log(`配置读不了（用默认值）: ${e?.message ?? e}`)
  }
  return { ...DEFAULTS, ...file, merged: true }
}

export function log(line) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* 日志写不进去也不能把插件搞崩 */
  }
}

/* ------------------------------------------------------------------ 审计 */

/**
 * 幂等：已经确认过就直接跳过；否则跑 auditpol + 挂 SACL。
 * 需要管理员；没有权限就只记一条日志，监控仍然可以工作（前提是别人已经开过审计）。
 */
export async function ensureAudit(cfg = DEFAULTS, { force = false } = {}) {
  if (!cfg.autoAudit) return { ok: false, skipped: true }
  if (!force && existsSync(AUDIT_MARK)) {
    const age = Date.now() - Number(readFileSync(AUDIT_MARK, 'utf8').trim() || 0)
    if (Number.isFinite(age) && age < 24 * 3600 * 1000) return { ok: true, cached: true }
  }

  const results = []
  try {
    await run('auditpol', ['/set', `/subcategory:${FILE_SYSTEM_GUID}`, '/success:enable', '/failure:enable'], { timeout: 20000 })
    results.push('auditpol ok')
  } catch (e) {
    results.push(`auditpol 失败: ${e?.message ?? e}`)
  }

  const script = `
$ErrorActionPreference='SilentlyContinue'
$rights  = [System.Security.AccessControl.FileSystemRights]'Delete, DeleteSubdirectoriesAndFiles'
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$flags   = [System.Security.AccessControl.AuditFlags]'Success, Failure'
foreach ($p in @(${cfg.roots.map((r) => `'${String(r).replace(/'/g, "''")}'`).join(',')})) {
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $acl = Get-Acl -LiteralPath $p -Audit
  $exists = @($acl.Audit) | Where-Object { $_.IdentityReference -eq 'Everyone' -and $_.FileSystemRights -match 'Delete' }
  if (-not $exists) {
    $rule = New-Object System.Security.AccessControl.FileSystemAuditRule('Everyone', $rights, $inherit, 'None', $flags)
    $acl.AddAuditRule($rule)
    Set-Acl -LiteralPath $p -AclObject $acl
  }
}
`
  try {
    await run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    results.push('SACL ok')
  } catch (e) {
    results.push(`SACL 失败: ${e?.message ?? e}`)
  }

  const allOk = results.every((r) => r.endsWith('ok'))
  if (allOk) {
    try { writeFileSync(AUDIT_MARK, String(Date.now()), 'utf8') } catch { /* 无所谓 */ }
  }
  log(`审计初始化: ${results.join(' / ')}`)
  return { ok: allOk, results }
}

/* ------------------------------------------------------------------ 读事件 */

const RE_EVENT = /<Event\b[\s\S]*?<\/Event>/g
const field = (xml, name) => {
  // wevtutil 输出的是单引号属性（<Data Name='ProcessId'>），别只认双引号
  const m = xml.match(new RegExp(`<Data Name=['"]${name}['"]>([\\s\\S]*?)</Data>`))
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''
}
const timeOf = (xml) => {
  const m = xml.match(/<TimeCreated SystemTime=['"]([^'"]+)['"]/)
  return m ? Date.parse(m[1]) : 0
}
const recordOf = (xml) => {
  const m = xml.match(/<EventRecordID>(\d+)<\/EventRecordID>/)
  return m ? Number(m[1]) : 0
}

/** 拉最近的一批 4663，返回结构化事件（按时间升序） */
export async function readDeletes(limit = 400) {
  const { stdout } = await run('wevtutil', ['qe', 'Security', '/q:*[System[EventID=4663]]', '/rd:true', `/c:${limit}`, '/f:xml'], {
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  return (stdout.match(RE_EVENT) ?? [])
    .map((xml) => ({
      at: timeOf(xml),
      id: recordOf(xml),
      pid: Number(field(xml, 'ProcessId')) || 0,
      process: field(xml, 'ProcessName').split(/[\\/]/).pop() ?? '',
      user: field(xml, 'SubjectUserName'),
      object: field(xml, 'ObjectName'),
    }))
    .filter((e) => e.at > 0 && e.id > 0 && e.pid !== 0)
    .sort((a, b) => a.at - b.at)
}

/* ------------------------------------------------------------------ 拉闸 */

const NEVER_KILL = new Set([
  // 系统关键进程
  'system', 'idle', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe',
  'smss.exe', 'winlogon.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe',
  // ⚠️ Windows 自己的维护进程：它们「正常工作时」就是几十秒删几百上千个文件。
  //    2026-10-30 实测：Windows 更新清理触发过一次 400 删除/30s，
  //    把 TiWorker 杀了 —— 会打断一次 Windows Update。这些一律不碰。
  'tiworker.exe',        // Windows 更新组件安装器
  'trustedinstaller.exe',// Windows Modules Installer（更新/组件维护的服务宿主）
  'msiexec.exe',         // 安装程序卸载
  'dism.exe',            // 组件库清理
  'cleanmgr.exe',        // 磁盘清理
  'msmpeng.exe',         // Defender 扫描/隔离
  'mpcmdrun.exe',        // Defender 命令行
  'searchindexer.exe',   // 搜索索引重建
  'defrag.exe',          // 碎片整理/TRIM
  'winsat.exe',          // 系统评估
])

const DSH_PROCESS = 'DeepSeek Harness.exe'

export function pickOffenders(events, cfg, selfPid = process.pid) {
  const allow = new Set((cfg.allow ?? []).map((s) => String(s).toLowerCase()))
  const byPid = new Map()
  for (const e of events) {
    if (e.pid === selfPid) continue
    const proc = e.process.toLowerCase()
    if (NEVER_KILL.has(proc)) continue
    if (allow.has(proc)) continue
    const cur = byPid.get(e.pid) ?? { pid: e.pid, process: e.process, count: 0, sample: [] }
    cur.count++
    if (cur.sample.length < 5) cur.sample.push(e.object)
    byPid.set(e.pid, cur)
  }
  return [...byPid.values()].sort((a, b) => b.count - a.count)
}

export async function brake({ cfg, offenders, events, why }) {
  try { mkdirSync(INCIDENT_DIR, { recursive: true }) } catch { /* 已存在 */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(INCIDENT_DIR, `${stamp}.json`)

  const plan = offenders
    .filter((o) => o.process !== DSH_PROCESS || cfg.killDsh)
    .map((o) => ({ pid: o.pid, process: o.process, count: o.count, sample: o.sample }))

  const report = {
    at: new Date().toISOString(),
    why,
    windowSec: cfg.windowSec,
    totalEvents: events.length,
    offenders: offenders.map((o) => ({ pid: o.pid, process: o.process, count: o.count, sample: o.sample })),
    killed: [],
    dryRun: !cfg.kill,
  }

  if (cfg.kill) {
    for (const o of plan) {
      try {
        await run('taskkill', ['/PID', String(o.pid), '/T', '/F'], { timeout: 8000 })
        report.killed.push({ pid: o.pid, process: o.process })
      } catch (e) {
        report.killed.push({ pid: o.pid, process: o.process, error: String(e?.message ?? e).slice(0, 120) })
      }
    }
  }

  try { writeFileSync(file, JSON.stringify(report, null, 2), 'utf8') } catch { /* 写不了也继续 */ }
  log(`拉闸: ${why} | 事件 ${events.length} 条 | 目标 ${offenders.map((o) => `${o.process}#${o.pid}(${o.count})`).join(', ') || '无'} | 杀掉 ${report.killed.length} 个${cfg.kill ? '' : '（dryRun）'}`)
  return { file, report }
}

/* ------------------------------------------------------------------ 主循环 */

export function startGuard({ log: logFn } = {}) {
  const cfg = loadConfig()
  const say = logFn ?? log
  let stopped = false
  let lastId = 0
  let lastFire = 0

  if (!cfg.enabled) {
    say('[guard] 配置里 enabled=false，监控不启动')
    return () => {}
  }

  ensureAudit(cfg).catch((e) => say(`[guard] 审计初始化异常: ${e?.message ?? e}`))

  const timer = setInterval(async () => {
    if (stopped) return
    try {
      const all = await readDeletes(400)
      if (all.length === 0) return
      if (lastId === 0) {
        // 第一次跑：只记游标，不对历史事件开火
        lastId = all[all.length - 1].id
        log(`监控已就绪，游标 = ${lastId}，窗口 ${cfg.windowSec}s，阈值 ${cfg.threshold}（DSH ${cfg.dshThreshold}）`)
        return
      }
      const fresh = all.filter((e) => e.id > lastId)
      if (fresh.length === 0) return
      lastId = fresh[fresh.length - 1].id

      const since = Date.now() - cfg.windowSec * 1000
      const inWindow = fresh.filter((e) => e.at >= since)
      if (inWindow.length === 0) return

      const dshCount = inWindow.filter((e) => e.process === DSH_PROCESS).length
      const otherCount = inWindow.length - dshCount
      const breached = otherCount >= cfg.threshold || (cfg.killDsh && dshCount >= cfg.dshThreshold)
      if (!breached) return

      const now = Date.now()
      if (now - lastFire < cfg.cooldownSec * 1000) return
      lastFire = now

      const offenders = pickOffenders(inWindow, cfg)
      const why = otherCount >= cfg.threshold
        ? `${cfg.windowSec}s 内 ${otherCount} 次删除（阈值 ${cfg.threshold}）`
        : `${cfg.windowSec}s 内 DSH 自身 ${dshCount} 次删除（阈值 ${cfg.dshThreshold}）`

      if (isPaused(cfg)) {
        log(`暂停中，只记录不动手: ${why} | ${offenders.slice(0, 3).map((o) => `${o.process}#${o.pid}(${o.count})`).join(', ')}`)
        return
      }

      await brake({ cfg, offenders, events: inWindow, why })
    } catch (e) {
      log(`监控异常（继续）: ${e?.message ?? e}`)
    }
  }, cfg.intervalMs)

  timer.unref?.()
  log(`dsh-fishwall 启动：interval=${cfg.intervalMs}ms window=${cfg.windowSec}s kill=${cfg.kill} killDsh=${cfg.killDsh}`)

  return () => {
    stopped = true
    clearInterval(timer)
    log('dsh-fishwall 已停止')
  }
}

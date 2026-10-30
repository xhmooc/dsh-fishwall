// dsh-fishwall · 网页半边
//
// 只做一件事：在 DSH 设置的左侧栏加一项「删除防护」，
// 把阈值 / 冷却 / 拉闸开关摆出来，外加“暂停”和最近事故。
//
// 这里**不碰任何文件**，只是往宿主那几条 /dsh-fishwall/* 路由上读写。
// 真正的判断和拉闸都在宿主半边（lib/host.js → lib/guard.mjs），只有一份逻辑。

window.__ModuleLoader__.load({
  id: 'dsh-fishwall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    const B = '/dsh-fishwall'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    // 极简样式：尽量用继承色，深浅色主题下都不难看
    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.6 },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' },
      label: { minWidth: 150, opacity: 0.85 },
      input: { width: 110, padding: '3px 6px', border: '1px solid rgba(128,128,128,.35)', borderRadius: 5, background: 'transparent', color: 'inherit' },
      hint: { fontSize: 12, opacity: 0.6, marginTop: 4 },
      btn: (primary) => ({
        padding: '5px 14px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.4)',
        background: primary ? 'rgba(64,132,255,.16)' : 'transparent',
        color: 'inherit', fontWeight: primary ? 600 : 400,
      }),
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      badge: (ok) => ({
        display: 'inline-block', padding: '1px 8px', borderRadius: 10, fontSize: 12,
        background: ok ? 'rgba(46,160,67,.18)' : 'rgba(210,153,34,.20)',
        border: '1px solid rgba(128,128,128,.25)',
      }),
    }

    const Num = ({ label, hint, value, onChange }) =>
      h('div', { style: S.row },
        h('span', { style: S.label }, label),
        h('input', {
          style: S.input,
          type: 'number',
          value: value ?? '',
          onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
        }),
        hint ? h('span', { style: S.hint }, hint) : null,
      )

    const Check = ({ label, hint, checked, onChange }) =>
      h('div', { style: S.row },
        h('span', { style: S.label }, label),
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (e) => onChange(e.target.checked) }),
        hint ? h('span', { style: S.hint }, hint) : null,
      )

    function Section() {
      const [cfg, setCfg] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')

      const loadAll = async () => {
        const [c, s] = await Promise.all([get('/config'), get('/status')])
        if (c && c.config) { setCfg(c.config); setErr('') }
        else setErr('读不到配置：/dsh-fishwall/config 没有响应。多半是宿主那半边没起来（inject 少了 webServer，或插件没重启）。')
        if (s) setStatus(s)
      }

      React.useEffect(() => { loadAll() }, [])

      const set = (k) => (v) => setCfg((prev) => ({ ...prev, [k]: v }))

      const save = async () => {
        setBusy(true)
        const r = await post('/config', cfg)
        setBusy(false)
        if (r && r.ok) { setCfg(r.config); setMsg('已保存，下一轮监控就按新值走'); loadAll() }
        else setMsg('保存失败：' + (r && r.error ? r.error : '未知错误'))
      }

      const togglePause = async () => {
        setBusy(true)
        const r = await post('/pause', {})
        setBusy(false)
        if (r) { setStatus((s) => ({ ...s, paused: r.paused })); setMsg(r.paused ? '已暂停：只记录，不动手' : '已恢复：超阈值会拉闸') }
      }

      if (!cfg) {
        return h('div', { style: S.wrap },
          err
            ? h('div', { style: S.card },
                h('div', { style: { fontWeight: 600, marginBottom: 6, color: '#d9534f' } }, '读取失败'),
                h('div', { style: S.hint }, err),
                h('div', { style: { ...S.row, marginTop: 8 } },
                  h('button', { style: S.btn(true), onClick: loadAll }, '重试'),
                ),
              )
            : '正在读取配置…',
        )
      }

      const paused = Boolean(status && status.paused)
      const incidents = (status && status.incidents) || []

      return h('div', { style: S.wrap },

        // ---- 状态 ----
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.badge(!paused) }, paused ? '已暂停（只记录）' : '监控中'),
            h('span', { style: { opacity: 0.7 } }, paused ? '不会杀任何进程' : `外部 ${cfg.threshold} 个 / ${cfg.windowSec}s，DSH 自身 ${cfg.dshThreshold} 个 / ${cfg.windowSec}s`),
          ),
          h('div', { style: S.hint }, '原理：打开 Windows 文件审计（4663），每轮读一次事件，算删除速率。超阈值就 taskkill 掉正在删的进程，并落一份事故记录。'),
        ),

        // ---- 阈值 ----
        h('div', { style: S.card },
          h(Num, { label: '检测窗口（秒）', value: cfg.windowSec, onChange: set('windowSec') }),
          h(Num, { label: '外部进程阈值', hint: '窗口内删这么多就拉闸', value: cfg.threshold, onChange: set('threshold') }),
          h(Num, { label: 'DSH 自身阈值', hint: '插件在进程内跑，给它更高阈值', value: cfg.dshThreshold, onChange: set('dshThreshold') }),
          h(Num, { label: '冷却（秒）', hint: '拉闸后多久内不再开火', value: cfg.cooldownSec, onChange: set('cooldownSec') }),
          h(Num, { label: '轮询间隔（毫秒）', value: cfg.intervalMs, onChange: set('intervalMs') }),
        ),

        // ---- 开关 ----
        h('div', { style: S.card },
          h(Check, { label: '启用监控', checked: cfg.enabled, onChange: set('enabled') }),
          h(Check, { label: '真的动手（kill）', hint: '关掉就只记录不杀', checked: cfg.kill, onChange: set('kill') }),
          h(Check, { label: '连 DSH 一起杀', hint: '插件在 DSH 进程内跑，只有它能拦住；代价是当前会话没了', checked: cfg.killDsh, onChange: set('killDsh') }),
          h(Check, { label: '启动时自动确认审计', hint: 'auditpol + SACL，幂等', checked: cfg.autoAudit, onChange: set('autoAudit') }),
        ),

        // ---- 按钮 ----
        h('div', { style: { ...S.row, marginTop: 4 } },
          h('button', { style: S.btn(true), disabled: busy, onClick: save }, '保存设置'),
          h('button', { style: S.btn(false), disabled: busy, onClick: togglePause }, paused ? '恢复监控' : '暂停（维护用）'),
          msg ? h('span', { style: { ...S.hint, marginLeft: 8 } }, msg) : null,
        ),
        h('div', { style: S.hint }, '装插件 / 重装依赖前先点「暂停」，否则 pnpm 删 node_modules 会被当成大规模删除打掉。'),

        // ---- 最近事故 ----
        h('div', { style: { ...S.card, marginTop: 12 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, `最近事故（${incidents.length}）`),
          incidents.length === 0
            ? h('div', { style: S.hint }, '还没有触发过。')
            : incidents.map((it, i) =>
                h('div', { key: i, style: { ...S.mono, marginBottom: 6 } },
                  `${it.at ? String(it.at).replace('T', ' ').slice(0, 19) : it.file}  ·  ${it.why ?? ''}  ·  杀 ${it.killed.length}`,
                  it.killed.length ? `\n${it.killed.join(', ')}` : '',
                ),
              ),
          (status && status.log && status.log.length)
            ? h('details', { style: { marginTop: 8 } },
                h('summary', { style: { cursor: 'pointer', opacity: 0.7 } }, '查看日志尾部'),
                h('div', { style: S.mono }, status.log.join('\n')),
              )
            : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'fishwall', order: 54, label: () => '删除防护' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

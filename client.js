/**
 * dsh-doubao-work — 浏览器半身（设置页）
 *
 * 在「设置 → 模型接入」里增加一页「豆包工作」，读取同源 /doubao/status 展示账号池与用量，
 * 并提供健康检查 / 停用 / 删除操作。
 *
 * 手写 ModuleLoader bundle：无构建步骤，除 shell 自带的 react 外无依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-doubao-work',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const inject = ['slots']

    const api = {
      status: () => fetch('/doubao/status', { cache: 'no-store' }).then(r => r.json()),
      check: () => fetch('/doubao/check', { method: 'POST' }).then(r => r.json()),
      enable: (id, enabled) => fetch('/doubao/account/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }),
      }).then(r => r.json()),
      remove: id => fetch('/doubao/account/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }).then(r => r.json()),
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      cards: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      card: {
        flex: '1 1 120px', minWidth: 110, padding: '12px 14px', borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)', background: 'var(--dsw-alias-bg-l1, transparent)',
      },
      cardK: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
      cardV: { fontSize: 22, fontWeight: 600, marginTop: 4 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        font: 'inherit', fontSize: 12, padding: '5px 10px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, #d0d5dc)', background: 'transparent',
        color: 'inherit', cursor: 'pointer',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2, #e3e6ea)', fontWeight: 600 },
      td: { padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2, #eef0f3)' },
      mute: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
      pre: { margin: 0, padding: 10, borderRadius: 8, background: 'rgba(127,127,127,.12)', fontSize: 12, maxHeight: 220, overflow: 'auto' },
    }

    function statusColor(s) {
      if (s === '可用') return '#0a7d34'
      if (String(s).includes('失效')) return '#c0392b'
      return '#b25e00'
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')

      const load = useCallback(async () => {
        try {
          setData(await api.status())
          setErr('')
        } catch (e) { setErr(String(e && e.message || e)) }
      }, [])

      useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])

      const onCheck = async () => {
        setBusy('check'); setLog('检查中…')
        try { setLog(JSON.stringify((await api.check()).results, null, 2)) }
        catch (e) { setLog('失败: ' + (e.message || e)) }
        setBusy(''); load()
      }
      const onToggle = async a => { setBusy(a.id); try { await api.enable(a.id, a.status === '已停用') } catch (e) {} setBusy(''); load() }
      const onRemove = async a => {
        if (typeof confirm === 'function' && !confirm('确定删除账号 ' + a.id + ' ？')) return
        setBusy(a.id); try { await api.remove(a.id) } catch (e) {} setBusy(''); load()
      }

      if (err) return h('div', { style: S.wrap }, h('div', { style: { color: '#c0392b' } }, '读取失败：' + err),
        h('div', { style: S.mute }, '请确认插件已重启（状态接口 /doubao/status 由宿主进程提供）。'))

      if (!data) return h('div', { style: S.wrap }, h('div', { style: S.mute }, '加载中…'))

      const s = data.summary || {}
      const accounts = data.accounts || []

      return h('div', { style: S.wrap },
        h('div', { style: S.mute },
          '模型：' + (data.models || []).join('、') +
          ' ｜ 多轮上下文：' + (data.contextReuse ? '开' : '关') +
          ' ｜ 活跃会话：' + (data.conversations || 0)),

        h('div', { style: S.cards },
          [['账号', s.accounts], ['可用', s.usable], ['今日请求', s.todayReq], ['预估剩余', s.quotaLeftEst]]
            .map(([k, v]) => h('div', { key: k, style: S.card },
              h('div', { style: S.cardK }, k), h('div', { style: S.cardV }, String(v ?? 0))))),

        h('div', { style: S.row },
          h('button', { style: S.btn, onClick: load, disabled: !!busy }, '刷新'),
          h('button', { style: S.btn, onClick: onCheck, disabled: !!busy }, busy === 'check' ? '检查中…' : '全部健康检查')),

        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            ['账号', '状态', '今日请求', '预估剩余', '累计字数', '最近错误', '操作']
              .map(c => h('th', { key: c, style: S.th }, c)))),
          h('tbody', null, accounts.length === 0
            ? h('tr', null, h('td', { style: S.td, colSpan: 7 }, h('span', { style: S.mute }, '还没有账号：在插件目录的 accounts.json 里加一条，或用 tools/accounts.mjs 添加。')))
            : accounts.map(a => h('tr', { key: a.id },
              h('td', { style: S.td }, a.remark || a.id),
              h('td', { style: { ...S.td, color: statusColor(a.status) } }, String(a.status)),
              h('td', { style: S.td }, String(a.todayReq ?? 0)),
              h('td', { style: S.td }, String(a.quotaLeftEst ?? 0)),
              h('td', { style: S.td }, String(a.totalChars ?? 0)),
              h('td', { style: { ...S.td, ...S.mute } }, a.lastError || '—'),
              h('td', { style: S.td },
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onToggle(a) }, '停用/启用'),
                h('span', { style: { display: 'inline-block', width: 6 } }),
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onRemove(a) }, '删除')))))),

        h('div', { style: S.mute }, '「预估剩余」按 200 次/天（周一翻倍）自记账推算，平台不提供余量接口。'),
        log ? h('pre', { style: S.pre }, log) : null)
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-doubao-work',
        order: 36,
        label: () => '豆包工作',
      }, () => h(Panel)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-doubao-work'
    return module.exports
  },
})

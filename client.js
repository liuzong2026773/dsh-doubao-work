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

    async function req(url, opt) {
      const r = await fetch(url, opt)
      const text = await r.text()
      if (!r.ok) throw new Error('HTTP ' + r.status + (text ? '：' + text.slice(0, 120) : '（接口未注册，插件可能未重启）'))
      if (!text) throw new Error('接口返回空响应（HTTP ' + r.status + '）')
      return JSON.parse(text)
    }

    const api = {
      status: () => req('/api/doubao/status', { cache: 'no-store' }),
      check: () => req('/api/doubao/check', { method: 'POST' }),
      enable: (id, enabled) => req('/api/doubao/account/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }),
      }),
      remove: id => req('/api/doubao/account/remove', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }),
      add: (account) => req('/api/doubao/account/add', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
      }),
      update: (account) => req('/api/doubao/account/update', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
      }),
      browserLaunch: (opt) => req('/api/doubao/browser/launch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opt || {}),
      }),
      browserGrab: (opt) => req('/api/doubao/browser/grab', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opt || {}),
      }),
      browserClose: (opt) => req('/api/doubao/browser/close', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opt || {}),
      }),
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
      if (s === '已停用') return '#888'
      if (String(s).includes('失效')) return '#c0392b'
      return '#b25e00'
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [showAdd, setShowAdd] = useState(false)
      const [formMode, setFormMode] = useState('add') // 'add' | 'update'
      const [form, setForm] = useState({ id: '', remark: '', cookie: '' })
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')
      const [browser, setBrowser] = useState(null) // 从浏览器导入：{port, browser:{name}, hint}

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
      const onToggle = async a => { setBusy(a.id); try { await api.enable(a.id, !a.enabled) } catch (e) {} setBusy(''); load() }
      const openAdd = () => { setFormMode('add'); setForm({ id: '', remark: '', cookie: '' }); setShowAdd(true) }
      const openUpdate = a => {
        setFormMode('update')
        setForm({ id: a.id, remark: a.remark || '', cookie: '' })
        setShowAdd(true)
      }
      const onSave = async () => {
        setBusy('add')
        try {
          const r = formMode === 'update' ? await api.update(form) : await api.add(form)
          const p = r && r.parse
          const head = (formMode === 'update' ? '已更新账号 ' : '已添加账号 ') + r.id
          const detail = p ? '｜' + p.describe : ''
          const warn = p && p.warnings && p.warnings.length ? '\n注意：\n- ' + p.warnings.join('\n- ') : ''
          setLog(head + detail + warn)
          setForm({ id: '', remark: '', cookie: '' })
          setShowAdd(false)
        } catch (e) { setLog('保存失败：' + e.message) }
        setBusy(''); load()
      }
      const onRemove = async a => {
        if (typeof confirm === 'function' && !confirm('确定删除账号 ' + a.id + ' ？')) return
        setBusy(a.id); try { await api.remove(a.id) } catch (e) {} setBusy(''); load()
      }

      // ---- 从浏览器导入（CDP）：不需要用户自己去 F12 里复制 Cookie ----
      const onBrowserLaunch = async () => {
        setBusy('browser'); setLog('正在打开一个独立的浏览器窗口…')
        try {
          const r = await api.browserLaunch({})
          setBrowser(r)
          setLog(r.hint || ('已打开 ' + ((r.browser && r.browser.name) || '浏览器') + '，调试端口 ' + r.port))
        } catch (e) { setLog('打开浏览器失败：' + (e.message || e)) }
        setBusy('')
      }
      const onBrowserGrab = async () => {
        setBusy('grab'); setLog('正在从浏览器读取豆包 Cookie…')
        try {
          const r = await api.browserGrab({ port: browser && browser.port })
          if (!r.ok) {
            setLog(r.reason || '还没拿到登录态：请先在打开的窗口里登录豆包，再点一次「抓取 Cookie」')
          } else {
            setLog('已导入：' + r.describe + '｜豆包 Cookie ' + r.doubaoCookies + ' 个（其中 HttpOnly ' + r.httpOnly + ' 个）'
              + (r.id ? '｜账号 ' + r.id : '')
              + (r.warnings && r.warnings.length ? '\n注意：\n- ' + r.warnings.join('\n- ') : ''))
          }
        } catch (e) { setLog('抓取失败：' + (e.message || e)) }
        setBusy(''); load()
      }
      const onBrowserClose = async () => {
        try { await api.browserClose({ port: browser && browser.port }) } catch (e) {}
        setBrowser(null); setLog('已关闭导入用的浏览器窗口（临时配置已清理）')
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
          h('button', { style: S.btn, onClick: onCheck, disabled: !!busy }, busy === 'check' ? '检查中…' : '全部健康检查'),
          h('button', { style: S.btn, onClick: () => (showAdd ? setShowAdd(false) : openAdd()) }, showAdd ? '收起' : '添加账号'),
          h('button', { style: S.btn, onClick: onBrowserLaunch, disabled: !!busy }, busy === 'browser' ? '打开中…' : '从浏览器导入')),

        browser ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)' } },
          h('div', { style: S.mute },
            '导入窗口已打开：' + ((browser.browser && browser.browser.name) || '浏览器') + '，调试端口 127.0.0.1:' + browser.port
            + '。这是插件专用的临时配置（不碰你日常的浏览器数据），请在里面登录豆包，然后点「抓取 Cookie」。'),
          h('div', { style: S.row },
            h('button', { style: S.btn, onClick: onBrowserGrab, disabled: !!busy }, busy === 'grab' ? '抓取中…' : '抓取 Cookie（并入库）'),
            h('button', { style: S.btn, onClick: onBrowserClose, disabled: !!busy }, '关闭窗口'))) : null,

        showAdd ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)' } },
          h('div', { style: S.mute }, formMode === 'update'
            ? '粘贴该账号新的 Cookie（换号过期时用这个换，不用删了再加）：整段 Cookie、`Cookie:` 请求头、Copy as cURL 都能直接贴，保存后立即生效。'
            : '把豆包网页版的登录态粘进来：整段 Cookie、`Cookie:` 请求头、浏览器「Copy as cURL」、扩展导出的 JSON / cookies.txt 都能自动识别，保存后立即生效，无需重启。'),
          h('div', { style: S.row },
            h('input', {
              placeholder: 'ID（可空，如 acc-2）', value: form.id, disabled: formMode === 'update',
              style: { flex: '0 1 160px', padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit' },
              onChange: e => setForm({ ...form, id: e.target.value }),
            }),
            h('input', { placeholder: '备注（如：小号）', value: form.remark, style: { flex: '1 1 160px', padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit' },
              onChange: e => setForm({ ...form, remark: e.target.value }) })),
          h('textarea', { placeholder: '粘贴 Cookie，或 Cookie: 请求头 / Copy as cURL / 扩展导出的 JSON', rows: 3, value: form.cookie,
            style: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12 },
            onChange: e => setForm({ ...form, cookie: e.target.value }) }),
          h('div', { style: S.row },
            h('button', { style: S.btn, disabled: !!busy, onClick: onSave }, formMode === 'update' ? '更新 Cookie' : '保存'),
            h('button', { style: S.btn, onClick: () => setShowAdd(false) }, '取消'))) : null,

        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            ['账号', '状态', '今日请求', '预估剩余', '累计字数', '最近错误', '操作']
              .map(c => h('th', { key: c, style: S.th }, c)))),
          h('tbody', null, accounts.length === 0
            ? h('tr', null, h('td', { style: S.td, colSpan: 7 }, h('span', { style: S.mute },
              '还没有账号：点「从浏览器导入」自动抓取（插件会开一个临时浏览器窗口，你在里面登录豆包即可，不碰你日常浏览器的数据），'
              + '或点「添加账号」粘贴 Cookie（整段 Cookie、`Cookie:` 请求头、Copy as cURL、扩展导出的 JSON 都能识别）。'
              + (data.accountsPath ? ' 也可直接编辑账号文件 ' + data.accountsPath + '（改完保存即生效，不用重启）。' : ''))))
            : accounts.map(a => h('tr', { key: a.id },
              h('td', { style: S.td }, a.remark || a.id),
              h('td', { style: { ...S.td, color: statusColor(a.status) } }, String(a.status)),
              h('td', { style: S.td }, String(a.todayReq ?? 0)),
              h('td', { style: S.td }, String(a.quotaLeftEst ?? 0)),
              h('td', { style: S.td }, String(a.totalChars ?? 0)),
              h('td', { style: { ...S.td, ...S.mute } }, a.lastError || '—'),
              h('td', { style: S.td },
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onToggle(a) }, a.enabled === false ? '启用' : '停用'),
                h('span', { style: { display: 'inline-block', width: 6 } }),
                h('button', { style: S.btn, disabled: !!busy, onClick: () => openUpdate(a) }, '换 Cookie'),
                h('span', { style: { display: 'inline-block', width: 6 } }),
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onRemove(a) }, '删除')))))),

        h('div', { style: S.mute }, '「预估剩余」按 200 次/天（周一翻倍）自记账推算，平台不提供余量接口。'
          + (data.accountsPath ? '｜账号文件：' + data.accountsPath : '')),
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

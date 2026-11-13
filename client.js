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
      checkinOpen: (body) => req('/api/doubao/checkin/open', { method: 'POST', body }),
      generate: (body) => req('/api/doubao/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      mstoken: (body) => req('/api/doubao/mstoken', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      }),
      checkin: (body) => req('/api/doubao/checkin', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      }),
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
      browserLogin: (opt) => req('/api/doubao/browser/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opt || {}),
      }),
      browserWait: () => req('/api/doubao/browser/wait', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }),
      exportAccounts: () => req('/api/doubao/accounts/export', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }),
      importAccounts: (opt) => req('/api/doubao/accounts/import', {
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
      const [genPrompt, setGenPrompt] = useState('')
      const [genKind, setGenKind] = useState('image')
      const [genOut, setGenOut] = useState(null)
      const [msInfo, setMsInfo] = useState(null)
      const [browser, setBrowser] = useState(null) // 从浏览器导入：{port, browser:{name}, hint}
      const [phone, setPhone] = useState('')       // 登录助手：手机号
      const [code, setCode] = useState('')         // 登录助手：短信验证码
      const [loginStep, setLoginStep] = useState(null) // 上一步登录助手的结果 {ok, stage, steps, form}
      const [watch, setWatch] = useState(null)     // 自动导入状态 {state, account, reason, imported}
      const [syncMode, setSyncMode] = useState(null) // 'export' | 'import' | null
      const [syncText, setSyncText] = useState('')

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
      // 生成：面板里点一下就能出图/出片/出文件，结果直接显示（图片渲染、文件给链接）
      const onGenerate = async () => {
        const prompt = genPrompt.trim()
        if (!prompt) { setLog('先写一句要生成什么'); return }
        setBusy('gen'); setGenOut(null)
        setLog((genKind === 'video' ? '正在生成视频（豆包要几分钟，别关页面）…' : genKind === 'file' ? '正在生成文件（PPT/Word 通常要 2-3 分钟）…' : '正在生图…'))
        try {
          const r = await api.generate({ kind: genKind, prompt })
          setGenOut(r)
          setLog(r.hint || (r.media && r.media.length ? '好了：拿到 ' + r.media.length + ' 个产出' : '上游只回了文字'))
        } catch (e) { setLog('生成失败：' + (e.message || e)) }
        finally { setBusy(null) }
      }

      // msToken：客户端身份凭证。摘到之后请求走 aid=582478，风控明显更松
      const onMsToken = async (action) => {
        setBusy('ms')
        try {
          const r = await api.mstoken({ action })
          if (action === 'status') { setMsInfo(r); return }
          setLog(r.ok ? (action === 'harvest' ? '已摘到 msToken，现在用客户端身份' : 'msToken 已设置') : ('失败：' + (r.error || '')))
          setMsInfo(await api.mstoken({ action: 'status' }))
        } catch (e) { setLog('msToken 操作失败：' + (e.message || e)) }
        finally { setBusy(null) }
      }

      // 一键签到：不带 id = 全部账号；带 id = 单号。服务端按天幂等，重复点不会重复领
      const onCheckin = async (id) => {
        setBusy(id ? 'checkin-' + id : 'checkin')
        setLog(id ? '正在给 ' + id + ' 签到…' : '正在给全部账号签到…')
        try {
          const list = (await api.checkin(id ? { id } : {})).results || []
          const okN = list.filter(x => x.result === 'ok').length
          const alreadyN = list.filter(x => x.result === 'already').length
          const bad = list.filter(x => x.result === 'failed' || x.result === 'error')
          setLog('签到完成：新签 ' + okN + '｜今天已签过 ' + alreadyN + '｜失败 ' + bad.length
            + (bad.length ? '\n' + bad.map(x => '- ' + x.id + '：' + (x.error || '失败')).join('\n') : ''))
        } catch (e) { setLog('签到失败：' + (e.message || e)) }
        setBusy(''); load()
      }
      // 打开签到页：普通窗口里伪装成豆包客户端（UA 带 SamanthaDoubao），页面才给签到按钮
      const onOpenCheckin = async () => {
        setBusy('open-checkin')
        setLog('正在用豆包客户端身份打开签到页…')
        try {
          const r = await api.checkinOpen({})
          setLog(r.hint || (r.ok ? '已打开签到页' : '打开失败'))
        } catch (e) { setLog('打开签到页失败：' + (e.message || e)) }
        setBusy('')
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
        setBrowser(null); setLoginStep(null); setWatch(null)
        setLog('已关闭导入用的浏览器窗口（临时配置已清理）')
      }

      // ---- 登录助手：手机号 / 验证码 在面板里填，动作送进我们打开的那个窗口 ----
      const runLogin = async (action, label) => {
        setBusy(action); setLog(label + '…')
        try {
          const r = await api.browserLogin({ port: browser && browser.port, action, phone, code })
          setLoginStep(r)
          const head = r.ok
            ? (r.stage === 'sent' ? '验证码已发出，收到后填到下面点「登录」'
              : r.stage === 'form' ? '登录弹窗已打开，可以填手机号了'
              : r.stage === 'submitted' ? '已提交登录，正在等结果…'
              : '已完成')
            : '没走通（stage=' + r.stage + '）'
          setLog(head + '\n' + (r.steps || []).join('\n')
            + (r.ok ? '' : '\n\n可以直接在那个浏览器窗口里手动登录，插件检测到登录态会自动导入。'))
        } catch (e) {
          setLog('登录助手失败：' + (e.message || e))
        }
        setBusy('')
      }
      const onOpenLoginForm = () => runLogin('open', '正在点开登录弹窗')
      const onSendCode = () => runLogin('phone', '正在填入手机号并点「发送验证码」')
      const onSubmitCode = () => runLogin('code', '正在填入验证码并点「登录」')

      // 登录完自动导入：轮询后台状态，导入成功就收起窗口并刷新账号
      useEffect(() => {
        if (!browser) return undefined
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const r = await api.browserWait()
            if (!alive) return
            setWatch(r)
            if (r.imported && r.account) {
              setLog('登录成功，已自动导入账号 ' + r.account + '（导入窗口已关闭，不用再点抓取）')
              setBrowser(null); setWatch(null); setLoginStep(null)
              setPhone(''); setCode('')
              load()
              return
            }
          } catch (e) { /* 接口还没就绪就等下一轮 */ }
          if (alive) timer = setTimeout(tick, 2500)
        }
        timer = setTimeout(tick, 1500)
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [browser, load])

      // ---- 账号包导出 / 导入：手机同步、备份、多机迁移 ----
      const onExport = async () => {
        setBusy('export')
        try {
          const r = await api.exportAccounts()
          if (!r.count) { setLog('没有账号可导出'); setBusy(''); return }
          setSyncMode('export'); setSyncText(r.json)
          setLog('已生成账号包（' + r.count + ' 个账号，含 Cookie）。复制下面的文本，粘到另一台 DSH / 手机的「导入账号包」即可')
        } catch (e) { setLog('导出失败：' + (e.message || e)) }
        setBusy('')
      }
      const onImport = async () => {
        const text = String(syncText || '').trim()
        if (!text) { setLog('先把账号包（或一段 Cookie）粘进上面的框'); return }
        setBusy('import')
        try {
          const r = await api.importAccounts({ text })
          setLog('导入完成：新增 ' + r.added + '、更新 ' + r.updated + '、跳过 ' + r.skipped + '，当前共 ' + r.total + ' 个账号')
          setSyncMode(null); setSyncText('')
        } catch (e) { setLog('导入失败：' + (e.message || e)) }
        setBusy(''); load()
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
          h('button', { style: S.btn, onClick: () => onCheckin(), disabled: !!busy }, busy === 'checkin' ? '签到中…' : '一键签到'),
          h('button', { style: { ...S.btn, marginLeft: 6 }, disabled: !!busy, onClick: () => onOpenCheckin() }, '打开签到页'),
          h('button', { style: S.btn, onClick: () => (showAdd ? setShowAdd(false) : openAdd()) }, showAdd ? '收起' : '添加账号'),
          h('button', { style: S.btn, onClick: onBrowserLaunch, disabled: !!busy }, busy === 'browser' ? '打开中…' : '从浏览器导入'),
          h('button', { style: S.btn, onClick: () => (syncMode ? (setSyncMode(null), setSyncText('')) : onExport()), disabled: !!busy }, syncMode ? '收起账号包' : '导出/导入账号')),

        browser ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)' } },
          h('div', { style: S.mute },
            '导入窗口已打开：' + ((browser.browser && browser.browser.name) || '浏览器') + '，调试端口 127.0.0.1:' + browser.port
            + '。这是插件专用的临时配置（不碰你日常的浏览器数据），请在里面登录豆包，然后点「抓取 Cookie」。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            h('input', {
              placeholder: '手机号', value: phone, inputMode: 'numeric',
              style: { flex: '0 1 140px', padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit' },
              onChange: e => setPhone(e.target.value),
            }),
            h('button', { style: S.btn, onClick: onOpenLoginForm, disabled: !!busy }, busy === 'open' ? '打开中…' : '打开登录框'),
            h('button', { style: S.btn, onClick: onSendCode, disabled: !!busy }, busy === 'phone' ? '发送中…' : '发送验证码'),
            h('input', {
              placeholder: '短信验证码', value: code, inputMode: 'numeric',
              style: { flex: '0 1 120px', padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit' },
              onChange: e => setCode(e.target.value),
            }),
            h('button', { style: S.btn, onClick: onSubmitCode, disabled: !!busy }, busy === 'code' ? '登录中…' : '登录')),
          h('div', { style: S.mute },
            '手机号全程只发给豆包登录页（跟我们打开的那个窗口里手动输一模一样），插件不保存号码。'
            + '登录成功会自动导入账号并关闭窗口；如果这几个按钮没反应，直接在窗口里登录也一样会自动导入。'),
          watch ? h('div', { style: S.mute },
            '自动导入：' + (watch.imported ? '✓ 已导入账号 ' + watch.account
              : watch.state === 'watching' ? '等待登录完成…（已检查 ' + (watch.attempts || 0) + ' 次）' + (watch.reason ? '｜' + watch.reason : '')
              : watch.state === 'timeout' ? '超时了：' + (watch.reason || '请在窗口里登录后点「抓取 Cookie（并入库）」')
              : (watch.reason || watch.state || ''))) : null,
          loginStep && loginStep.steps && loginStep.steps.length ? h('div', {
            style: { fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-text-l3, #666)' },
          }, loginStep.steps.join('\n')) : null,
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

        syncMode ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)' } },
          h('div', { style: S.mute }, syncMode === 'export'
            ? '账号包含 Cookie（等同于密码），别贴到公开地方。复制下面整段，到另一台 DSH / 手机的「导出/导入账号」里切到导入、粘贴即可。'
            : '把账号包 JSON 粘到下面（也接受一段 Cookie / `Cookie:` 头 / cURL / 扩展导出的 JSON）。默认按 id 合并，不会删掉本机已有账号。'),
          h('textarea', {
            rows: 6, value: syncText, readOnly: syncMode === 'export',
            placeholder: syncMode === 'import' ? '{"accounts":[{"id":"acc-1","cookie":"…"}]}  或直接粘一段 Cookie' : '',
            style: { width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit', fontFamily: 'monospace', fontSize: 12 },
            onChange: e => setSyncText(e.target.value),
            onFocus: e => { if (syncMode === 'export') e.target.select() },
          }),
          h('div', { style: S.row },
            syncMode === 'export'
              ? h('button', { style: S.btn, onClick: () => { setSyncMode('import'); setSyncText('') } }, '切到导入')
              : h('button', { style: S.btn, onClick: onImport, disabled: !!busy }, busy === 'import' ? '导入中…' : '导入账号包'),
            h('button', { style: S.btn, onClick: () => { setSyncMode(null); setSyncText('') } }, '关闭'))) : null,

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
              h('td', { style: { ...S.td, color: statusColor(a.status) } }, String(a.status),
                a.checkinToday ? h('span', { style: { ...S.mute, color: a.checkinToday === 'failed' ? '#c0392b' : 'inherit' } },
                  a.checkinToday === 'failed' ? '｜签到失败'
                    : a.checkinToday === 'unavailable' ? '｜活动暂不可用'
                    : a.checkinToday === 'ok' ? '｜今日已签'
                    : '') : null),
              h('td', { style: S.td }, String(a.todayReq ?? 0)),
              h('td', { style: S.td }, String(a.quotaLeftEst ?? 0)),
              h('td', { style: S.td }, String(a.totalChars ?? 0)),
              h('td', { style: { ...S.td, ...S.mute } }, a.lastError || '—'),
              h('td', { style: S.td },
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onToggle(a) }, a.enabled === false ? '启用' : '停用'),
                h('span', { style: { display: 'inline-block', width: 6 } }),
                h('button', { style: S.btn, disabled: !!busy, onClick: () => openUpdate(a) }, '换 Cookie'),
                h('span', { style: { display: 'inline-block', width: 6 } }),
                h('button', { style: S.btn, disabled: !!busy, onClick: () => onRemove(a) }, '删除'),
                h('button', { style: { ...S.btn, marginLeft: 6 }, disabled: !!busy, onClick: () => onCheckin(a.id) }, busy === 'checkin-' + a.id ? '签到中…' : '签到')))))),

        h('div', { style: S.mute }, '「预估剩余」按 200 次/天（周一翻倍）自记账推算，平台不提供余量接口。'
          + (data.checkinSchedule
            ? '｜自动签到：每天 ' + data.checkinSchedule + (data.checkinNextAt ? '（下次 ' + new Date(data.checkinNextAt).toLocaleString('zh-CN') + '）' : '')
            : '｜自动签到未开启（配置 checkinSchedule: "09:30" 即可）')
          + (data.accountsPath ? '｜账号文件：' + data.accountsPath : '')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2, #e3e6ea)' } },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, '创作（生图 / 生视频 / 出文件）'),
          h('div', { style: S.mute },
            '跟豆包普通对话同一条通道：生图走 Seedream，出片走 Seedance，文件是 PPT/Word/PDF/表格。',
            '视频和文件比较慢（1-3 分钟），点完可以放着不管。DSH 会话里直接说"画个…"也会自动走到这里。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', { style: S.btn, value: genKind, onChange: e => setGenKind(e.target.value) },
              h('option', { value: 'image' }, '生图'),
              h('option', { value: 'video' }, '生视频'),
              h('option', { value: 'file' }, '出文件'),
              h('option', { value: 'any' }, '自动')),
            h('input', {
              placeholder: '例如：画一只戴墨镜的柴犬，扁平插画 ｜ 做一份 3 页 PPT：2026 计划',
              value: genPrompt,
              style: { flex: '1 1 320px', padding: 6, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,#d0d5dc)', background: 'transparent', color: 'inherit' },
              onChange: e => setGenPrompt(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter' && !busy) onGenerate() },
            }),
            h('button', { style: S.btn, disabled: !!busy, onClick: () => onGenerate() }, busy === 'gen' ? '生成中…' : '生成')),
          genOut && genOut.media && genOut.media.length
            ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              genOut.media.map((m, i) => {
                if (m.kind === 'image') return h('img', { key: i, src: m.url, alt: '', style: { maxWidth: 220, maxHeight: 220, borderRadius: 8, border: '1px solid #d0d5dc' } })
                if (m.kind === 'video') return h('video', { key: i, src: m.url, controls: true, style: { maxWidth: 320, borderRadius: 8 } })
                return h('a', { key: i, href: m.url, target: '_blank', rel: 'noreferrer', style: { fontSize: 13 } }, '📄 ' + (m.name || '文件'))
              }))
            : (genOut ? h('div', { style: S.mute }, '这次没拿到产出：' + (genOut.hint || '上游只回了文字')) : null)),

        h('div', { style: S.row },
          h('button', { style: S.btn, disabled: !!busy, onClick: () => onMsToken('harvest') }, busy === 'ms' ? '摘取中…' : '抓取 msToken'),
          h('button', { style: { ...S.btn, marginLeft: 6 }, disabled: !!busy, onClick: () => onMsToken('status') }, '看身份'),
          msInfo
            ? h('span', { style: S.mute },
              '当前身份：' + (msInfo.transport === 'client' ? '客户端（aid=582478，风控松）' : '网页（aid=497858，容易被要求人机验证）'),
              msInfo.cached
                ? '｜token 已缓存 ' + msInfo.cached.ageMinutes + ' 分钟（来源 ' + (msInfo.cached.source || '?') + '）'
                : '｜没缓存：抓一次才能用客户端身份（要在豆包 PC 客户端带调试端口启动）')
            : null),

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

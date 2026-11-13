#!/usr/bin/env node
/**
 * 豆包工作 · 本地面板（独立进程，不依赖 DSH 重启）
 *
 *   node tools/panel.mjs          # 打开 http://127.0.0.1:3041
 *   node tools/panel.mjs --port 3042
 *
 * 只监听 127.0.0.1，仅本机可访问。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DoubaoClient } from '../doubao.js';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const accountsPath = path.join(dir, 'accounts.json');
const statePath = path.join(dir, 'gateway-state.json');
const argPort = process.argv.indexOf('--port');
const port = argPort > 0 ? Number(process.argv[argPort + 1]) : 3041;

function readAccounts() {
  try {
    const d = JSON.parse(fs.readFileSync(accountsPath, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(d) ? d : (d.accounts || []);
  } catch (e) { return []; }
}

function writeAccounts(list) {
  const tmp = accountsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, accountsPath);
}

function makeClient() {
  const accounts = readAccounts();
  return new DoubaoClient({ accounts }, { accountsPath, statePath, log: () => {} });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>豆包工作 · 面板</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:24px;background:#f4f5f7;color:#1f2328}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e6e6}.card{background:#171a21!important;border-color:#262b35!important}th{background:#1d222b!important}td,th{border-color:#262b35!important}}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#888;font-size:13px;margin-bottom:18px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:14px 18px;min-width:120px}
.card b{display:block;font-size:22px;margin-top:4px}
.card span{font-size:12px;color:#888}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #eef0f3}
th{background:#eef1f5;font-weight:600}
tr:last-child td{border-bottom:0}
.ok{color:#0a7d34}.warn{color:#b25e00}.err{color:#c0392b}
button{font:inherit;font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid #d0d5dc;background:#fff;cursor:pointer;margin-right:6px}
button:hover{background:#f0f2f5}
.bar{margin:16px 0}
pre{background:#111;color:#ddd;padding:12px;border-radius:8px;overflow:auto;max-height:280px;font-size:12px}
</style></head><body>
<h1>豆包工作 · 面板</h1>
<div class="sub" id="sub">加载中…</div>
<div class="cards" id="cards"></div>
<div class="bar">
  <button onclick="load()">刷新</button>
  <button onclick="check()">健康检查</button><button onclick="checkin()">一键签到</button>
</div>
<table><thead><tr><th>账号</th><th>状态</th><th>今日请求</th><th>预估剩余</th><th>累计字数</th><th>最近错误</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<pre id="log">就绪</pre>
<script>
const el=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// 把任意值安全地嵌进内联 onclick：先转成 JS 字符串字面量（会带引号并转义内部字符），
// 再做 HTML 属性转义。直接拼 esc(a.id) 不行 —— esc 把 ' 转成 &#39;，浏览器解析属性时
// 又还原成 '，照样能跳出 JS 字符串。
const jsLit=s=>esc(JSON.stringify(String(s??'')));
async function load(){
  try{
    const d=await (await fetch('/api/status')).json();
    el('sub').textContent='模型：'+d.models.join('、')+' ｜ 上下文复用：'+(d.contextReuse?'开':'关')+' ｜ 会话数：'+d.conversations;
    el('cards').innerHTML=[
      ['账号',d.summary.accounts],['可用',d.summary.usable],
      ['今日请求',d.summary.todayReq],['预估剩余',d.summary.quotaLeftEst]
    ].map(([k,v])=>'<div class="card"><span>'+k+'</span><b>'+v+'</b></div>').join('');
    el('rows').innerHTML=d.accounts.map(a=>'<tr><td>'+esc(a.remark||a.id)+'</td><td class="'+(a.status==='可用'?'ok':(a.status.includes('失效')?'err':'warn'))+'">'+esc(a.status)+'</td><td>'+a.todayReq+'</td><td>'+a.quotaLeftEst+'</td><td>'+a.totalChars+'</td><td>'+esc(a.lastError||'-')+'</td><td><button onclick="toggle('+jsLit(a.id)+','+(a.status!=='已停用')+')">'+(a.enabled?'停用':'启用')+'</button><button onclick="del('+jsLit(a.id)+')">删除</button></td></tr>').join('');
  }catch(e){el('log').textContent='加载失败: '+e.message}
}
async function check(){
  el('log').textContent='检查中…';
  const d=await (await fetch('/api/check',{method:'POST'})).json();
  el('log').textContent=JSON.stringify(d.results,null,2);
  load();
}
async function checkin(){
  el('log').textContent='签到中…';
  try{
    const d=await (await fetch('/api/checkin',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
    el('log').textContent=JSON.stringify(d,null,2);
  }catch(e){el('log').textContent='签到失败: '+e.message}
  load();
}
async function toggle(id,on){
  await fetch('/api/account/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,enabled:!on})});
  load();
}
async function del(id){
  if(!confirm('确定删除账号 '+id+' ?'))return;
  await fetch('/api/account/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
  load();
}
load();setInterval(load,15000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  // 面板能增删账号、改上游状态，写接口必须挡跨源：
  // 此前写接口没有任何同源校验，任意网页都能对本机 3041 端口发 POST，等于把账号池交给任意站点。
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    const remote = String(req.socket?.remoteAddress || '');
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    let ok = loopback;
    if (origin) {
      try { ok = new URL(origin).host === String(req.headers.host || ''); } catch (e) { ok = false; }
    }
    if (!ok) return json(res, 403, { error: '已拒绝：跨源或非本机请求' });
  }
  try {
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (p === '/api/status') {
      const c = makeClient();
      const snap = c.snapshot();
      return json(res, 200, {
        models: c.models().map(m => m.id),
        accounts: snap,
        conversations: c.convMap.size,
        contextReuse: c.cfg.contextReuse !== false,
        summary: {
          accounts: snap.length,
          usable: snap.filter(a => a.status === '可用').length,
          todayReq: snap.reduce((s, a) => s + a.todayReq, 0),
          quotaLeftEst: snap.reduce((s, a) => s + a.quotaLeftEst, 0),
        },
      });
    }
    if (p === '/api/checkin' && req.method === 'POST') {
      const c = makeClient();
      let id = '';
      try {
        id = String((JSON.parse((await readBody(req)) || '{}') || {}).id || '');
      } catch (e) { id = ''; }
      try {
        const results = await c.checkinAll({ id });
        if (typeof c.flushState === 'function') c.flushState();
        return json(res, 200, {
          summary: {
            total: results.length,
            ok: results.filter(r => r.result === 'ok').length,
            already: results.filter(r => r.result === 'already').length,
            skipped: results.filter(r => r.result === 'skipped').length,
            failed: results.filter(r => r.result === 'failed' || r.result === 'error').length,
          },
          results,
        });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }
    if (p === '/api/check' && req.method === 'POST') {
      const c = makeClient();
      const results = await c.checkAll();
      c.flushState();
      return json(res, 200, { results });
    }
    if (p === '/api/account/enable' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = readAccounts();
      const a = list.find(x => x.id === body.id);
      if (!a) return json(res, 404, { error: 'not found' });
      a.enabled = !!body.enabled;
      writeAccounts(list);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/account/remove' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const list = readAccounts().filter(x => x.id !== body.id);
      writeAccounts(list);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });
}

server.listen(port, '127.0.0.1', () => {
  console.log('豆包工作面板: http://127.0.0.1:' + port);
});

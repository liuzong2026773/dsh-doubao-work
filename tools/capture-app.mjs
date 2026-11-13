#!/usr/bin/env node
/**
 * 监听「电脑版豆包」的网络请求（CDP 只读观察，不改页面、不注入脚本）
 *
 *   先带调试端口启动豆包：
 *     "E:\豆包\Doubao\app\Doubao.exe" --remote-debugging-port=9222
 *   然后：
 *     node tools/capture-app.mjs --seconds 600
 *
 * 只打印业务接口（/alice /biz /samantha /ug/ /campaign /activity …）的请求体与响应片段，
 * 不打印 Cookie。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const seconds = Number(opt('seconds', 600)) || 600;
const port = Number(opt('port', 9222)) || 9222;
const filter = new RegExp(String(opt('filter', '/(alice|biz|samantha|ug|campaign|activity|checkin|passport|api)/')));
const outFile = path.join(os.homedir(), '.dsh', 'doubao-work', 'app-capture.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [];
const emit = (s) => { lines.push(s); console.log(s); };

async function targets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

const list = await targets();
emit(`[app-capture] 页面 target ${list.length} 个：`);
for (const t of list) emit(`  - ${t.title || '(无标题)'}  ${t.url.slice(0, 90)}`);

const sockets = [];
for (const t of list) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pending = new Map(); let seq = 0;
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
  const seen = new Map();
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request || {};
      let u; try { u = new URL(r.url); } catch { return; }
      if (!filter.test(u.pathname + u.search)) return;
      seen.set(m.params.requestId, u.pathname);
      const qs = Object.fromEntries(u.searchParams);
      for (const k of ['a_bogus', 'msToken', 'X-Bogus', 'sign', 'qs', 'device_id', 'web_id', 'tea_uuid', 'iid', 'device_type']) delete qs[k];
      emit(`\n[req] ${r.method} ${u.host}${u.pathname}\n      query: ${JSON.stringify(qs).slice(0, 400)}`);
      if (r.postData) emit(`      body: ${String(r.postData).slice(0, 900)}`);
    } else if (m.method === 'Network.responseReceived' && seen.has(m.params.requestId)) {
      emit(`  [res] ${seen.get(m.params.requestId)} → ${m.params.response.status}`);
    } else if (m.method === 'Network.loadingFinished' && seen.has(m.params.requestId)) {
      send('Network.getResponseBody', { requestId: m.params.requestId })
        .then(br => {
          const b = String(br.body || '');
          if (!b || b.length > 300000) return;
          if (!/^[\[{ ]/.test(b.trim())) return;
          emit(`  [body] ${seen.get(m.params.requestId)} → ${b.slice(0, 700).replace(/\s+/g, ' ')}`);
        }).catch(() => {});
    }
  });
  await new Promise((res, rej) => {
    const t2 = setTimeout(() => rej(new Error('cdp 超时')), 6000);
    ws.addEventListener('open', () => { clearTimeout(t2); res(); });
    ws.addEventListener('error', () => { clearTimeout(t2); rej(new Error('cdp 拒绝')); });
  });
  await send('Network.enable', { maxPostDataSize: 65536 });
  sockets.push(ws);
}

emit(`\n[app-capture] 开始监听 ${seconds}s —— 现在去点「立即签到」`);
await sleep(seconds * 1000);
for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
try { fs.writeFileSync(outFile, lines.join('\n')); emit(`\n[app-capture] 已存 ${outFile}`); } catch { /* ignore */ }
emit('[app-capture] 结束');

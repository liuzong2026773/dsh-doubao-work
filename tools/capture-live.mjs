#!/usr/bin/env node
/**
 * 实时抓包（CDP 观察模式）：把窗口里发生的接口调用原样打出来，不注入脚本、不改页面。
 *
 *   node tools/capture-live.mjs --seconds 600        # 抓 10 分钟，期间你在窗口里操作
 *   node tools/capture-live.mjs --id acc-2 --filter "/alice|/biz"
 *
 * 用途：① 在豆包里切模型 → 看真正决定模型的字段；② 点「立即签到」→ 看签到打哪个接口、要什么参数。
 * 输出不含 Cookie 本体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, closeBrowser, createWebSocket } from '../browser.js';
import { dataPaths, ACCOUNTS_FILE } from '../paths.js';

const argv = process.argv.slice(2);
const opt = (n, d = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const seconds = Number(opt('seconds', 600)) || 600;
const id = opt('id');
const filter = new RegExp(String(opt('filter', '^/(alice|biz|samantha|lm|api|passport)/')));

const paths = dataPaths({});
const all = JSON.parse(fs.readFileSync(path.join(paths.dir, ACCOUNTS_FILE), 'utf8')).accounts || [];
const acc = all.find(a => a.id === id) || all.find(a => a.enabled !== false) || all[0];
if (!acc) { console.error('没有可用账号'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastPath = new Map();
const lastReqId = new Map();
const handle = await launchBrowser({ startUrl: 'https://www.doubao.com/chat/' });
console.log(`[capture] 浏览器 pid=${handle.pid} port=${handle.port}`);
console.log(`[capture] 用账号 ${acc.id} 注入登录态；接下来 ${seconds}s 内你在窗口里的操作都会被记录`);

let cdp;
for (let i = 0; i < 40 && !cdp; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${handle.port}/json/list`)).json();
    const page = (list || []).find(t => t.type === 'page' && /doubao/.test(t.url || ''));
    if (!page?.webSocketDebuggerUrl) continue;
    const ws = createWebSocket(page.webSocketDebuggerUrl);
    const pending = new Map(); let seq = 0;
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        return;
      }
      if (m.method === 'Network.requestWillBeSent') {
        const r = m.params.request || {};
        let u; try { u = new URL(r.url); } catch { return; }
        if (!/doubao\.com$/.test(u.hostname) || !filter.test(u.pathname)) return;
        const qs = Object.fromEntries(u.searchParams);
        for (const k of ['a_bogus', 'msToken', 'X-Bogus', 'sign', 'qs', 'p_no']) delete qs[k];
        let line = `\n[req] ${r.method} ${u.pathname}${Object.keys(qs).length ? '?' + JSON.stringify(qs).slice(0, 260) : ''}`;
        if (r.postData) line += `\n      body: ${String(r.postData).slice(0, 700)}`;
        console.log(line);
        lastPath.set(m.params.requestId, u.pathname);
      } else if (m.method === 'Network.responseReceived') {
        const p = lastPath.get(m.params.requestId);
        if (p) console.log(`  [res] ${p} → ${m.params.response.status}`);
        lastReqId.set(m.params.response.url + '|' + m.params.requestId, m.params.requestId);
      } else if (m.method === 'Network.loadingFinished') {
        const rid = m.params.requestId;
        const p = lastPath.get(rid);
        if (!p) return;
        // 只取 JSON 响应体的一部分，静态资源跳过
        cdp.send('Network.getResponseBody', { requestId: rid }).then(br => {
          const b = String(br.body || '');
          if (!b || b.length > 200000) return;
          if (!/^[{[ ]/.test(b.trim())) return;
          console.log(`  [body] ${p} → ${b.slice(0, 600).replace(/\s+/g, ' ')}`);
        }).catch(() => {});
      }
    });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('cdp refused')); }); });
    const send = (method, params = {}) => new Promise((res, rej) => { const i2 = ++seq; pending.set(i2, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i2, method, params })); });
    cdp = { send, close: () => ws.close() };
  } catch { /* 未就绪 */ }
}
if (!cdp) { console.error('CDP 连不上'); process.exit(1); }

let injected = 0;
for (const pair of String(acc.cookie || '').split(';')) {
  const i = pair.indexOf('=');
  if (i < 1) continue;
  try {
    await cdp.send('Network.setCookie', { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.doubao.com', path: '/', url: 'https://www.doubao.com/', secure: true });
    injected++;
  } catch { /* ignore */ }
}
console.log(`[capture] 注入 cookie ${injected} 条，开始监听`);
await cdp.send('Network.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: 'https://www.doubao.com/chat/' });

await sleep(seconds * 1000);
cdp.close();
await closeBrowser(handle);
console.log('\n[capture] 结束，窗口已关闭');

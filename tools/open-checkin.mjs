#!/usr/bin/env node
/**
 * 用普通浏览器「假装成电脑版豆包」打开签到页
 *
 *   node tools/open-checkin.mjs              # 打开并停留 300 秒，期间你可以点「立即签到」
 *   node tools/open-checkin.mjs --keep 600
 *   node tools/open-checkin.mjs --id acc-2
 *
 * 原理：这一页只在豆包客户端里才给出签到按钮（页面读 UA 里的 SamanthaDoubao/<版本>）。
 * 这里用 CDP 改掉 UA、注入账号 Cookie，等价于"内置浏览器打开"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, closeBrowser, createWebSocket } from '../browser.js';
import { dataPaths, ACCOUNTS_FILE } from '../paths.js';

const CHECKIN_URL = 'https://www.doubao.com/pc/agent-explore?enter_method=fixed_entry';
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.35.12';

const argv = process.argv.slice(2);
const opt = (n, d = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const id = opt('id');
const keep = Number(opt('keep', 300)) || 300;

const paths = dataPaths({});
const all = JSON.parse(fs.readFileSync(path.join(paths.dir, ACCOUNTS_FILE), 'utf8')).accounts || [];
const acc = all.find(a => a.id === id) || all.find(a => a.enabled !== false) || all[0];
if (!acc) { console.error('accounts.json 里没有账号'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const handle = await launchBrowser({ startUrl: 'about:blank' });
let cdp;
for (let i = 0; i < 40 && !cdp; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${handle.port}/json/list`)).json();
    const page = (list || []).find(t => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) continue;
    const ws = createWebSocket(page.webSocketDebuggerUrl);
    const pending = new Map(); let seq = 0;
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('cdp refused')); }); });
    const send = (method, params = {}) => new Promise((res, rej) => { const i2 = ++seq; pending.set(i2, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i2, method, params })); });
    cdp = { send, close: () => ws.close() };
  } catch { /* 未就绪 */ }
}
if (!cdp) { console.error('CDP 连不上'); process.exit(1); }

for (const pair of String(acc.cookie || '').split(';')) {
  const i = pair.indexOf('=');
  if (i < 1) continue;
  await cdp.send('Network.setCookie', { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.doubao.com', path: '/', url: 'https://www.doubao.com/', secure: true }).catch(() => {});
}
// 关键一步：把 UA 换成带 SamanthaDoubao 的，页面才认为"在客户端里"
await cdp.send('Network.setUserAgentOverride', { userAgent: APP_UA, platform: 'Win32' });
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: CHECKIN_URL });
await sleep(9000);

const r = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean);
    return { ua: navigator.userAgent.slice(-40), buttons: btns.slice(0, 8), head: (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 240) };
  })()`,
  returnByValue: true,
});
const v = r.result?.value || {};
console.log('UA 尾部:', v.ua);
console.log('按钮:', JSON.stringify(v.buttons));
console.log('页面:', String(v.head).slice(0, 240));
console.log(`\n窗口保持 ${keep}s，你可以直接点「立即签到」。`);
await sleep(keep * 1000);
cdp.close();
await closeBrowser(handle);

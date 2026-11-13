#!/usr/bin/env node
/**
 * 抓「立即签到」的真实请求（CDP 观察，不改页面、不读隐私库）
 *
 *   node tools/capture-checkin.mjs                # 用 accounts.json 第 1 个号的 Cookie 注入登录态
 *   node tools/capture-checkin.mjs --id acc-2
 *   node tools/capture-checkin.mjs --keep 60      # 抓完留窗口 60 秒，方便自己看一眼
 *
 * 做三件事：注入 Cookie → 打开豆包 → 找到并点击「立即签到」→ 打印它发出的请求（CSRF/签名参数一并暴露）
 * 输出里不会打印 Cookie 本体。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, closeBrowser, createWebSocket } from '../browser.js';
import { dataPaths, ACCOUNTS_FILE } from '../paths.js';

const argv = process.argv.slice(2);
const opt = (n, d2 = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d2 : (argv[i + 1] ?? true); };
const id = opt('id');
const keep = Number(opt('keep', 0)) || 0;

const paths = dataPaths({});
const file = path.join(paths.dir, ACCOUNTS_FILE);
const all = JSON.parse(fs.readFileSync(file, 'utf8')).accounts || [];
const acc = all.find(a => a.id === id) || all.find(a => a.enabled !== false) || all[0];
if (!acc) { console.error('accounts.json 里没有账号'); process.exit(1); }
console.log(`用账号 ${acc.id} 的 Cookie 注入登录态（cookielen=${(acc.cookie || '').length}）`);

const handle = await launchBrowser({ startUrl: 'https://www.doubao.com/chat/' });
console.log('浏览器已拉起 pid=', handle.pid, 'port=', handle.port);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let cdp;
for (let i = 0; i < 40 && !cdp; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${handle.port}/json/list`)).json();
    const page = (list || []).find(t => t.type === 'page' && /doubao\.com/.test(t.url || '')) || (list || []).find(t => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) continue;
    const ws = createWebSocket(page.webSocketDebuggerUrl);
    const pending = new Map(); let seq = 0; const events = [];
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
      else if (m.method) events.push(m);
    });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('CDP 超时')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP 拒绝')); }); });
    const send = (method, params = {}) => new Promise((res, rej) => { const i2 = ++seq; pending.set(i2, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i2, method, params })); });
    cdp = { send, events, close: () => ws.close() };
  } catch (e) { /* 还没起来 */ }
}
if (!cdp) { console.error('连不上 CDP'); process.exit(1); }

// 注入 Cookie（HttpOnly 也能设，因为走 CDP 而不是 document.cookie）
let injected = 0;
for (const pair of String(acc.cookie || '').split(';')) {
  const idx = pair.indexOf('=');
  if (idx < 1) continue;
  const name = pair.slice(0, idx).trim();
  const value = pair.slice(idx + 1).trim();
  if (!name || !value) continue;
  try {
    await cdp.send('Network.setCookie', { name, value, domain: '.doubao.com', path: '/', url: 'https://www.doubao.com/', secure: true, httpOnly: false });
    injected++;
  } catch { /* 单条失败不影响其它 */ }
}
console.log('已注入 Cookie 条数:', injected);

await cdp.send('Network.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: 'https://www.doubao.com/chat/' });
await sleep(7000);

// 找「立即签到」按钮：先在可见文本里搜，取它所在元素的坐标
const FIND_JS = `(() => {
  const out = [];
  const kw = ['立即签到', '签到', '打卡', '领取'];
  const walk = document.querySelectorAll('div,span,button,a');
  for (const el of walk) {
    const t = (el.textContent || '').trim();
    if (!t || t.length > 12) continue;
    if (!kw.some(k => t === k || t.includes(k))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.top < 0 || r.left < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    out.push({ text: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  }
  return { url: location.href, found: out.slice(0, 8), title: document.title };
})()`;

let probe = await cdp.send('Runtime.evaluate', { expression: FIND_JS, returnByValue: true });
console.log('页面:', JSON.stringify(probe.result?.value?.url), '标题:', probe.result?.value?.title);
console.log('找到的候选按钮:', JSON.stringify(probe.result?.value?.found));

const targets = probe.result?.value?.found || [];
if (!targets.length) {
  console.log('页面上没找到签到按钮（可能要先打开额度/活动弹层）。窗口留着，你可以自己点；我继续监听 30 秒。');
} else {
  const b = targets[0];
  console.log('点击:', b.text, b.x, b.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(4000);
}

// 打印跟签到相关的请求
const interesting = cdp.events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params.request).filter(r => /campaign|checkin|sign|task|reward|quota|activity/i.test(r.url || ''));
console.log(`\n=== 命中请求 ${interesting.length} 条 ===`);
for (const r of interesting) {
  console.log(`\n${r.method} ${r.url}`);
  if (r.headers && Object.keys(r.headers).length) console.log('  headers:', JSON.stringify(Object.fromEntries(Object.entries(r.headers).filter(([k]) => !/cookie|token|authorization/i.test(k)))));
  if (r.postData) console.log('  body:', String(r.postData).slice(0, 800));
}

if (keep) await sleep(keep * 1000);
cdp.close();
await closeBrowser(handle);
console.log('\n窗口已关闭');

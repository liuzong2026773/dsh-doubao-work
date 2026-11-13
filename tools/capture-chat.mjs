#!/usr/bin/env node
/**
 * 抓网页自己发出的 /chat/completion 请求体（用于对齐 model_item_key / item_id / mode 等字段）
 *
 *   node tools/capture-chat.mjs                     # 打开页面，自动发一句 "1+1=?"，抓请求体
 *   node tools/capture-chat.mjs --say "你好"         # 自定义要说的话
 *   node tools/capture-chat.mjs --id acc-2
 *
 * 页面自己发请求，所以签名/风控都成立；我们只观察，不改页面逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, closeBrowser, createWebSocket } from '../browser.js';
import { dataPaths, ACCOUNTS_FILE } from '../paths.js';

const argv = process.argv.slice(2);
const opt = (n, d = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const say = String(opt('say', '1+1 等于几？只回答数字'));
const manual = argv.includes('--manual');
const waitSec = Number(opt('wait', 600)) || 600;
const id = opt('id');

const paths = dataPaths({});
const all = JSON.parse(fs.readFileSync(path.join(paths.dir, ACCOUNTS_FILE), 'utf8')).accounts || [];
const acc = all.find(a => a.id === id) || all.find(a => a.enabled !== false) || all[0];
if (!acc) { console.error('没有可用账号'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const handle = await launchBrowser({ startUrl: 'https://www.doubao.com/chat/' });
console.log(`[capture] pid=${handle.pid} port=${handle.port} 账号=${acc.id}`);

let cdp;
for (let i = 0; i < 40 && !cdp; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${handle.port}/json/list`)).json();
    const page = (list || []).find(t => t.type === 'page' && /doubao/.test(t.url || ''));
    if (!page?.webSocketDebuggerUrl) continue;
    const ws = createWebSocket(page.webSocketDebuggerUrl);
    const pending = new Map(); let seq = 0;
    const bodies = [];
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
      if (m.method === 'Network.requestWillBeSent' && /chat\/completion/.test(m.params.request.url || '')) {
        const b = m.params.request.postData || '';
        bodies.push(b);
        console.log(`\n[抓到 chat/completion] 长度=${b.length}`);
        try { printModelFields(JSON.parse(b), paths); } catch { console.log('  (解析失败)'); }
      }
    });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp timeout')), 8000); ws.addEventListener('open', () => { clearTimeout(t); res(); }); ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('cdp refused')); }); });
    const send = (method, params = {}) => new Promise((res, rej) => { const i2 = ++seq; pending.set(i2, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i2, method, params })); });
    cdp = { send, bodies, close: () => ws.close() };
  } catch { /* 未就绪 */ }
}
if (!cdp) { console.error('CDP 连不上'); process.exit(1); }

for (const pair of String(acc.cookie || '').split(';')) {
  const i = pair.indexOf('=');
  if (i < 1) continue;
  await cdp.send('Network.setCookie', { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.doubao.com', path: '/', url: 'https://www.doubao.com/', secure: true }).catch(() => {});
}
await cdp.send('Network.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: 'https://www.doubao.com/chat/' });
await sleep(8000);

// 在输入框里打字并回车（走 Input 域，页面按真实输入处理）
if (manual) {
  console.log(`\n[手动模式] 窗口已打开（已登录）。请在窗口里：`);
  console.log('  ① 切到「豆包工作」 ② 选好要用的模型 ③ 随便发一句话');
  console.log(`我会把每次 /chat/completion 的模型字段打出来，${waitSec}s 后自动收工。`);
  await sleep(waitSec * 1000);
  cdp.close();
  await closeBrowser(handle);
  console.log('\n[capture] 结束');
  process.exit(0);
}

const FIND = `(() => {
  const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
const f = (await cdp.send('Runtime.evaluate', { expression: FIND, returnByValue: true })).result?.value || {};
if (!f.ok) { console.log('没找到输入框'); cdp.close(); await closeBrowser(handle); process.exit(1); }

await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: f.x, y: f.y, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: f.x, y: f.y, button: 'left', clickCount: 1 });
await cdp.send('Input.insertText', { text: say });
await sleep(500);
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
console.log(`已发送：「${say}」，等待上游请求…`);
await sleep(12000);

if (!cdp.bodies.length) console.log('\n没抓到 chat/completion（可能页面还没准备好，或先弹了活动窗）');
for (const b of cdp.bodies.slice(-1)) {
  try { printModelFields(JSON.parse(b), paths); } catch { console.log('请求体不是 JSON'); }
}
cdp.close();
await closeBrowser(handle);

/** 把一个 /chat/completion 请求体里的模型相关字段打出来，并存档 */
function printModelFields(j, paths2) {
  const o = j.option || {};
  console.log('  conversation_init_ext:', JSON.stringify(o.conversation_init_ext));
  console.log('  model_config:', JSON.stringify(o.model_config));
  console.log('  agent_mode:', o.agent_mode, ' conversation_mode:', JSON.stringify(o.conversation_mode), ' need_deep_think:', o.need_deep_think);
  console.log('  bot_id:', j.client_meta?.bot_id, ' option 键数:', Object.keys(o).length);
  try { fs.writeFileSync(path.join(paths2.dir, 'captured-chat.json'), JSON.stringify(j, null, 2)); } catch { /* 存不下也无所谓 */ }
}


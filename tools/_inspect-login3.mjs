/**
 * 一次性排查（不提交）：直接打开登录页，看手机号表单在不在同源页面里。
 * 只读结构，不发短信、不提交任何东西。
 */
import { launchBrowser, closeBrowser } from '../browser.js';

const URLS = [
  'https://www.doubao.com/login',
  'https://www.doubao.com/chat/?login=1',
];

const handle = await launchBrowser({ startUrl: URLS[0] });
await new Promise(r => setTimeout(r, 7000));

const list = async () => (await (await fetch(`http://127.0.0.1:${handle.port}/json/list`)).json());

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

const DUMP = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const d = (el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', ph: el.getAttribute('placeholder') || '', name: el.getAttribute('name') || '', aria: el.getAttribute('aria-label') || '', id: el.id || '', text: (el.innerText || '').trim().slice(0, 24), visible: vis(el) });
  return {
    url: location.href,
    inputs: [...document.querySelectorAll('input')].map(d),
    buttons: [...document.querySelectorAll('button')].map(d).filter(x => x.text || x.visible).slice(0, 15),
    iframes: [...document.querySelectorAll('iframe')].map(f => ({ src: f.src.slice(0, 140), visible: vis(f) })),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
  };
})()`;

const page = (await list()).find(t => t.type === 'page' && /doubao/.test(t.url));
const c = client(page.webSocketDebuggerUrl);
await c.ready;

for (const u of URLS) {
  await c.send('Page.navigate', { url: u });
  await new Promise(r => setTimeout(r, 6000));
  const r = await c.send('Runtime.evaluate', { expression: DUMP, returnByValue: true });
  console.log('\n=== ' + u + ' ===');
  console.log(JSON.stringify(r.result?.value, null, 1));
}
c.ws.close();
await closeBrowser(handle);

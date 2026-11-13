/**
 * msToken：豆包客户端请求里那个"人机凭证"。
 *
 * 为什么需要它：网页身份（aid=497858）的请求一旦被判定可疑，就一律 710022004（要求人机验证）；
 * 而客户端身份（aid=582478 + msToken + SamanthaDoubao UA）的请求能正常出结果。
 * msToken 由豆包客户端/网页的 webmssdk 现算，自己编一个会返回 710022002（校验不过），
 * 所以只能"借"：从本机正在运行的豆包客户端（--remote-debugging-port=9222）的网络请求里摘一个，
 * 缓存起来复用（实测同一个 token 可重复使用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWebSocket } from './browser.js';

export const TOKEN_FILE = 'mstoken.json';

/** 读缓存的 token（过期也给出来，由调用方决定用不用） */
export function readMsToken(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8'));
    return { token: String(j.token || ''), at: Number(j.at) || 0, source: String(j.source || '') };
  } catch {
    return { token: '', at: 0, source: '' };
  }
}

/** 缓存 token（写入时间戳，便于判断新旧） */
export function writeMsToken(dataDir, token, source = 'harvest') {
  const rec = { token: String(token || ''), at: Date.now(), source };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, TOKEN_FILE), JSON.stringify(rec, null, 2));
  return rec;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 连一个 target，等它发出带 msToken 的请求（只读观察，不改页面） */
async function watchTarget(target, waitMs) {
  const ws = createWebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  let token = '';
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent' && !token) {
      const hit = /[?&]msToken=([A-Za-z0-9_%.-]+)/.exec(m.params.request.url || '');
      if (hit) token = decodeURIComponent(hit[1]);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp 连接超时')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp 连接被拒')); });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Network.enable', { maxPostDataSize: 200000 });
    // 轻轻戳一下页面：客户端会顺手发几个 /alice 请求（不改内容、不发送消息）
    await send('Runtime.evaluate', {
      expression: `(() => {
        const els = [...document.querySelectorAll('[class*=item],[class*=tab],[class*=composer],[contenteditable=true],input')].slice(0, 6);
        for (const el of els) { try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } catch (e) {} }
        return els.length;
      })()`,
      returnByValue: true,
    }).catch(() => {});
    const deadline = Date.now() + waitMs;
    while (!token && Date.now() < deadline) await sleep(300);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
  return token;
}

/**
 * 从本机豆包客户端摘一个 msToken。
 * @param {object} opts { port=9222, waitMs=20000 }
 * @returns {Promise<{token: string, source: string}>}
 */
export async function harvestMsToken(opts = {}) {
  const port = Number(opts.port) || 9222;
  const waitMs = Number(opts.waitMs) || 20000;
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    targets = (await res.json()).filter(t => t.webSocketDebuggerUrl && /doubao/.test(t.url || ''));
  } catch (e) {
    return { token: '', source: '', reason: `连不上 http://127.0.0.1:${port}（豆包没带调试端口启动？）：${e.message}` };
  }
  if (!targets.length) return { token: '', source: '', reason: '调试端口在，但没有豆包页面' };
  // 优先挂 https 页面（客户端内嵌的网页才会带 msToken 参数）
  targets.sort((a, b) => (/^https:/.test(b.url) ? 1 : 0) - (/^https:/.test(a.url) ? 1 : 0));
  for (const t of targets) {
    const token = await watchTarget(t, Math.min(waitMs, 8000)).catch(() => '');
    if (token) return { token, source: `harvest:${(t.url || '').slice(0, 40)}` };
  }
  return { token: '', source: '', reason: `看了 ${targets.length} 个页面，${waitMs}ms 内没有带 msToken 的请求（在豆包里点一下任意对话再试）` };
}

#!/usr/bin/env node
/**
 * 监听「电脑版豆包」的网络请求（CDP 只读观察，不改页面、不注入脚本、不走代理）
 *
 *   1) 用 tools/start-doubao-debug.cmd 启动豆包（带 --remote-debugging-port=9222）
 *   2) node tools/capture-app.mjs --seconds 900
 *
 * 特性：先等端口出现（豆包可能还没起），再自动挂上**之后才打开的**页面
 *（签到页是点进「免费用豆包工作」时才创建的 webview，必须动态挂）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWebSocket } from '../browser.js';

const argv = process.argv.slice(2);
const opt = (n, d = undefined) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? true); };
const seconds = Number(opt('seconds', 900)) || 900;
const port = Number(opt('port', 9222)) || 9222;
const filter = new RegExp(String(opt('filter', '/(alice|biz|samantha|ug|campaign|activity|checkin|passport)/')));
const outFile = opt('out') ? String(opt('out')) : path.join(os.homedir(), '.dsh', 'doubao-work', 'app-capture.log');

const lines = [];
const emit = (s) => { lines.push(s); console.log(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const attached = new Map();
let announcedPort = false;

emit(`[app-capture] 等 127.0.0.1:${port} …（用 tools/start-doubao-debug.cmd 启动豆包）`);

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  return (await r.json()).filter(t => t.webSocketDebuggerUrl && /^(page|webview|iframe|other)$/.test(t.type));
}

async function attach(t) {
  const ws = createWebSocket(t.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const seen = new Map();
  const label = `${t.type}:${(t.title || t.url || '').slice(0, 40)}`;
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request || {};
      let u; try { u = new URL(r.url); } catch { return; }
      if (!filter.test(u.pathname + u.search)) return;
      seen.set(m.params.requestId, u.pathname);
      const qs = Object.fromEntries(u.searchParams);
      for (const k of ['a_bogus', 'msToken', 'X-Bogus', 'sign', 'qs', 'tea_uuid', 'web_id', 'device_id', 'iid']) delete qs[k];
      emit(`\n[req@${label}] ${r.method} ${u.pathname}\n      query: ${JSON.stringify(qs).slice(0, 300)}`);
      if (r.postData) emit(`      body: ${String(r.postData).slice(0, 600)}`);
    } else if (m.method === 'Network.loadingFinished' && seen.has(m.params.requestId)) {
      send('Network.getResponseBody', { requestId: m.params.requestId }).then(br => {
        const b = String(br.body || '');
        if (!b || b.length > 200000) return;
        emit(`  [body] ${seen.get(m.params.requestId)} → ${b.replace(/\s+/g, ' ').slice(0, 500)}`);
      }).catch(() => {});
    }
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('cdp 超时')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('cdp 拒绝')); });
  });
  await send('Network.enable', { maxPostDataSize: 65536 });
  attached.set(t.id, ws);
  emit(`[app-capture] 已挂上 ${label}  ${(t.url || '').slice(0, 80)}`);
  return ws;
}

const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  try {
    const targets = await listTargets();
    if (!announcedPort) { emit(`[app-capture] 端口通了，target ${targets.length} 个`); announcedPort = true; }
    for (const t of targets) {
      if (attached.has(t.id)) continue;
      await attach(t).catch(() => {});
    }
  } catch {
    if (announcedPort) { emit('[app-capture] 端口断了（豆包重启？），继续等…'); announcedPort = false; }
    for (const ws of attached.values()) { try { ws.close(); } catch { /* ignore */ } }
    attached.clear();
  }
  await sleep(2000);
}

for (const ws of attached.values()) { try { ws.close(); } catch { /* ignore */ } }
try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, lines.join('\n')); emit(`[app-capture] 已存 ${outFile}`); } catch { /* ignore */ }

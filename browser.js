/**
 * CDP（Chrome DevTools 协议）抓取豆包 Cookie
 *
 * 为什么是 CDP 而不是读浏览器 Cookie 库：
 *   - Chrome/Edge 127+ 在 Windows 上对 Cookie 的 AES key 加了 App-Bound Encryption，
 *     第三方进程解不开（社区工具大面积失效，且随版本变化）；macOS 要 Keychain 授权，
 *     Linux 要 Secret Service，国产内核（360/夸克/千问）路径与加密各不相同。
 *   - CDP 走浏览器自己开的管理端口，不受上面所有限制，且能拿到 HttpOnly 的
 *     sessionid / sid_guard（网页里跑 JS 读 document.cookie 注定拿不到）。
 *
 * 用法（面板/路由）：
 *   launch → 打开一个带调试端口、临时 user-data-dir 的浏览器窗口，引导用户登录豆包
 *   grab   → 连 127.0.0.1:<port> 的 browser 端 WebSocket，Storage.getCookies，
 *            过滤 .doubao.com 域，拼成规范 Cookie 串（喂给 cookie-input.js 入库）
 *   close  → 结束拉起的浏览器进程并清掉临时 profile
 *
 * 安全边界（写死，不做成配置）：
 *   - 只连 127.0.0.1 的调试端口，绝不连局域网/公网地址
 *   - 只发 Storage.getCookies 这一条只读指令，不发任何会改变页面状态的指令
 *   - 只取 doubao.com 域的 Cookie；日志与返回值不携带 Cookie 值本身
 *
 * 依赖全部可注入（fetch / WebSocket / spawn / existsSync / findFreePort），
 * 离线测试用假 CDP 服务即可跑通全流程。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

/** 需要拿到的登录态字段：缺了说明还没登录，grab 要继续等 */
export const AUTH_MARKERS = ['sessionid', 'sid_guard'];
/** 只取豆包域（含子域） */
const DOUBAO_DOMAINS = ['doubao.com'];

// ---------------- 依赖注入 ----------------

/** @typedef {{fetchImpl?: Function, createSocket?: Function, spawnImpl?: Function, existsSync?: Function, findFreePort?: Function, homedir?: string}} Deps */
/**
 * 测试注入点：`node tests/*` 里把假实现塞进这里，就能在没有浏览器、没有 WebSocket
 * （普通 node 20 连全局 WebSocket 都没有）的环境里把整条链路跑通。
 * 优先级：函数入参 > 这里的全局注入 > 真实实现。
 */
export const injectable = { fetchImpl: null, createSocket: null, spawnImpl: null, existsSync: null, findFreePort: null, killImpl: null };

function makeDeps(deps = {}) {
  const pick = (k, fallback) => deps[k] ?? injectable[k] ?? fallback;
  return {
    fetchImpl: pick('fetchImpl', (url, opt) => fetch(url, opt)),
    createSocket: pick('createSocket', (url) => createWebSocket(url)),
    spawnImpl: pick('spawnImpl', nodeSpawn),
    existsSync: pick('existsSync', (p) => fs.existsSync(p)),
    findFreePort: pick('findFreePort', defaultFindFreePort),
    killImpl: pick('killImpl', defaultKill),
    homedir: deps.homedir || os.homedir(),
  };
}

/**
 * 优先用运行时的全局 WebSocket（Electron 44 / Node 22+ 都有）；普通 Node 20 没有，
 * 而仓库声明是 `engines: node>=20`，所以带一个零依赖的最小客户端（只够 CDP 用）：
 * 只处理文本帧、16/64 位长度、close/ping，不做压缩与分片重组。
 */
export function createWebSocket(url) {
  if (typeof globalThis.WebSocket === 'function') return new globalThis.WebSocket(url);
  return nodeWebSocket(String(url));
}

function nodeWebSocket(url) {
  const u = new URL(url);
  if (u.protocol !== 'ws:') throw new Error('最小 WebSocket 只支持 ws://（本机调试端口不需要 wss）');
  const listeners = { open: [], message: [], error: [], close: [] };
  const fire = (type, ev = {}) => { for (const fn of listeners[type] || []) fn({ type, ...ev }); };
  const key = crypto.randomBytes(16).toString('base64');
  let socket = null;
  let buffer = Buffer.alloc(0);
  let closed = false;

  const connect = () => {
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, sock, head) => {
      if (res.statusCode !== 101) { fire('error', { message: 'WebSocket 握手失败：HTTP ' + res.statusCode }); sock.destroy(); return; }
      socket = sock;
      socket.setNoDelay(true);
      if (head && head.length) buffer = Buffer.concat([buffer, head]);
      fire('open');
      socket.on('data', d => { buffer = Buffer.concat([buffer, d]); drain(); });
      socket.on('error', e => fire('error', { message: e.message }));
      socket.on('close', () => { closed = true; fire('close'); });
      drain();
    });
    req.on('error', e => fire('error', { message: e.message }));
    req.end();
  };

  const drain = () => {
    while (buffer.length >= 2) {
      const b1 = buffer[0];
      const b2 = buffer[1];
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f;
      let off = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < off + maskLen + len) return;
      let payload = buffer.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buffer.subarray(off, off + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
      }
      buffer = buffer.subarray(off + maskLen + len);
      if (opcode === 0x1) fire('message', { data: payload.toString('utf8') });
      else if (opcode === 0x8) { finish(); fire('close'); }
      else if (opcode === 0x9) sendFrame(0xa, payload); // ping → pong
    }
  };

  const sendFrame = (opcode, payload) => {
    if (!socket || closed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | data.length; }
    else if (data.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
    try { socket.write(Buffer.concat([header, mask, masked])); } catch (e) { fire('error', { message: e.message }); }
  };

  const finish = () => { if (socket) { try { socket.end(); } catch { /* ignore */ } } };

  connect();
  return {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    send: (raw) => sendFrame(0x1, raw),
    close: () => { if (closed) return; closed = true; sendFrame(0x8, Buffer.alloc(0)); finish(); },
  };
}

/** 结束浏览器进程：Windows 上 spawn 的是 detached 进程，得连子进程一起 taskkill */
async function defaultKill(pid) {
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    await new Promise(res => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => res()));
  } else {
    try { process.kill(Number(pid)); } catch { /* 已退出 */ }
  }
}

function defaultFindFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------- 浏览器发现 ----------------

/**
 * 各平台常见的 Chromium 内核浏览器路径。找到哪个用哪个，顺序即优先级：
 * Edge 在前（国内 Windows 几乎必装），Chrome 其次，再到 Chromium 本体。
 * Edge 的 EdgeCore\<版本>\msedge.exe 布局（本机实测）也覆盖。
 */
export function candidateBrowsers(deps = {}) {
  const d = makeDeps(deps);
  const home = d.homedir;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
  const list = [
    { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', paths: [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]},
    { id: 'chrome', name: 'Google Chrome', kind: 'chromium', paths: [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]},
    { id: 'chromium', name: 'Chromium', kind: 'chromium', paths: [
      path.join(local, 'Chromium', 'Application', 'chrome.exe'),
      path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
    ]},
  ];
  if (process.platform === 'darwin') {
    list.unshift(
      { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { id: 'chrome', name: 'Google Chrome', kind: 'chromium', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
    );
  } else if (process.platform === 'linux') {
    list.unshift(
      { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
      { id: 'chrome', name: 'Google Chrome', kind: 'chromium', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'] },
    );
  }
  const found = [];
  for (const c of list) {
    for (const p of c.paths) {
      if (d.existsSync(p)) { found.push({ ...c, path: p }); break; }
    }
  }
  // Windows 上 Edge 可能只有 EdgeCore\<版本>\msedge.exe（无 Application 包装层）
  if (process.platform === 'win32' && !found.some(b => b.id === 'edge')) {
    for (const root of [pf86, pf]) {
      const coreRoot = path.join(root, 'Microsoft', 'EdgeCore');
      try {
        const vers = fs.readdirSync(coreRoot)
          .filter(v => /^\d+\./.test(v))
          .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]));
        for (const v of vers) {
          const p = path.join(coreRoot, v, 'msedge.exe');
          if (d.existsSync(p)) { found.unshift({ id: 'edge', name: 'Microsoft Edge (EdgeCore)', kind: 'chromium', path: p }); break; }
        }
        if (found.some(b => b.id === 'edge')) break;
      } catch { /* 目录不存在 */ }
    }
  }
  return found;
}

// ---------------- 调试端口 ----------------

/** 探测 127.0.0.1:<port> 上有没有 DevTools 端点（Chrome 136+ 只对非默认 user-data-dir 开放） */
export async function probeDebugPort(port, deps = {}, timeoutMs = 1500) {
  const d = makeDeps(deps);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await d.fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const j = JSON.parse(await r.text());
    return { ok: true, port, browser: j.Browser || '', wsUrl: j.webSocketDebuggerUrl || '' };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '超时' : String(e.message || e) };
  } finally { clearTimeout(timer); }
}

/**
 * 清掉很久以前的临时导入窗口留下的 profile（只认自家前缀，且跳过 6 小时内的，
 * 免得删掉用户还开着的窗口）。返回传入目录，方便直接拼新目录名。
 */
export function sweepStaleProfiles(dir, maxAgeMs = 6 * 3600 * 1000) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('dsh-doubao-cdp-')) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs < maxAgeMs) continue;
        fs.rmSync(p, { recursive: true, force: true });
      } catch { /* 还在被占用/没权限，下次再说 */ }
    }
  } catch { /* 临时目录都读不了就不管了 */ }
  return dir;
}

/**
 * 拉起一个带调试端口的浏览器窗口。
 * 关键：必须用**独立的临时 user-data-dir**——Chrome 136 起，默认配置目录上的
 * --remote-debugging-port 会被静默忽略（安全加固），很多老教程因此失效；
 * 独立目录同时也保证不碰用户日常浏览器的数据。
 */
export async function launchBrowser(opts = {}, deps = {}) {
  const d = makeDeps(deps);
  const browsers = candidateBrowsers(deps);
  if (opts.browserPath) browsers.unshift({ id: 'custom', name: '自定义', kind: 'chromium', path: opts.browserPath });
  const browser = browsers.find(b => b.id === opts.browserId) || browsers[0];
  if (!browser) throw new Error('没有找到可用的 Chromium 内核浏览器（Edge/Chrome/Chromium），可在配置里填 browserPath');

  const port = opts.port || await d.findFreePort();
  const profileDir = opts.profileDir || path.join(sweepStaleProfiles(os.tmpdir()), `dsh-doubao-cdp-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    opts.startUrl || 'https://www.doubao.com/',
  ];
  const child = d.spawnImpl(browser.path, args, { detached: true, stdio: 'ignore' });
  child.unref?.();
  return { ok: true, pid: child.pid, port, profileDir, browser: { id: browser.id, name: browser.name, path: browser.path }, startUrl: args.at(-1) };
}

/** 结束拉起的进程并清掉临时 profile（找不到进程时只清理目录） */
export async function closeBrowser(handle = {}, deps = {}) {
  const d = makeDeps(deps);
  let killed = false;
  if (handle.pid && Number.isFinite(Number(handle.pid))) {
    try { await d.killImpl(handle.pid); killed = true; } catch { killed = false; }
  }
  let cleaned = false;
  if (handle.profileDir && String(handle.profileDir).includes('dsh-doubao-cdp-')) {
    try { fs.rmSync(handle.profileDir, { recursive: true, force: true }); cleaned = true; } catch { /* 浏览器还没退干净，下次再清 */ }
  }
  return { ok: true, killed, cleaned };
}

// ---------------- Cookie 抓取 ----------------

/** CDP Cookie 对象 → Cookie 头串：按路径长度降序（贴近浏览器语义），同名只留一次 */
export function cookiesToHeader(cookies, domains = DOUBAO_DOMAINS) {
  const inDomain = c => domains.some(d0 => c.domain === d0 || (c.domain || '').endsWith('.' + d0) || (c.domain || '').endsWith(d0));
  const seen = new Map();
  for (const c of (cookies || []).filter(inDomain)) seen.set(c.name, c); // 后写覆盖前写
  const sorted = [...seen.values()].sort((a, b) => (b.path || '').length - (a.path || '').length);
  return {
    cookie: sorted.map(c => `${c.name}=${c.value}`).join('; '),
    keys: sorted.map(c => c.name),
    httpOnly: sorted.filter(c => c.httpOnly).map(c => c.name),
  };
}

/**
 * 连 browser 端 WebSocket 抓全部 Cookie，过滤豆包域。
 * 只发 Storage.getCookies 一条只读指令；createSocket 可注入以便离线测试。
 */
export async function grabAllCookies(wsUrl, deps = {}, timeoutMs = 8000) {
  const d = makeDeps(deps);
  if (!/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(wsUrl)) {
    throw new Error(`拒绝连接非本机调试端口：${wsUrl.replace(/\/\/[^/]+\//, '//<redacted>/')}`);
  }
  return await new Promise((resolve, reject) => {
    let ws;
    const timer = setTimeout(() => { try { ws && ws.close(); } catch {} reject(new Error('CDP 连接/应答超时')); }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    try { ws = d.createSocket(wsUrl); } catch (e) { cleanup(); return reject(e); }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== 1) return;
        cleanup();
        if (msg.error) { try { ws.close(); } catch {} return reject(new Error('CDP 错误：' + (msg.error.message || JSON.stringify(msg.error)))); }
        const cookies = msg.result?.cookies || [];
        try { ws.close(); } catch {}
        resolve(cookies);
      } catch (e) { cleanup(); reject(e); }
    });
    ws.addEventListener('error', (ev) => { cleanup(); reject(new Error('WebSocket 失败：' + (ev?.message || ev?.error?.message || '连接被拒（端口没开或浏览器已退出）'))); });
  });
}

/**
 * 一步到位：探测端口 → 抓 Cookie → 过滤豆包域 → 判断是否已登录。 * notLoggedIn 时调用方让用户登录后再点一次。
 */
export async function grabDoubao(opts = {}, deps = {}) {
  const d = makeDeps(deps);
  const port = opts.port;
  const probe = await probeDebugPort(port, deps, opts.probeTimeoutMs ?? 1500);
  if (!probe.ok) return { ok: false, stage: 'probe', reason: `127.0.0.1:${port} 没有响应（${probe.reason}）。浏览器窗口被关了，或没带 --remote-debugging-port 启动` };
  if (!probe.wsUrl) return { ok: false, stage: 'probe', reason: '调试端口在，但没给出 browser WebSocket 地址' };
  const all = await grabAllCookies(probe.wsUrl, deps, opts.wsTimeoutMs ?? 8000);
  const { cookie, keys, httpOnly } = cookiesToHeader(all);
  const hasAuth = AUTH_MARKERS.every(m => keys.includes(m)) || keys.includes('sessionid');
  return {
    ok: hasAuth,
    stage: hasAuth ? 'done' : 'login',
    cookie, keys, httpOnly,
    doubaoCookies: keys.length,
    totalCookies: all.length,
    browser: probe.browser,
    reason: hasAuth ? '' : `端口通、拿到了 ${keys.length} 个豆包 Cookie，但里面还没有 ${AUTH_MARKERS.join('/')}——请在打开的窗口里登录豆包后再点一次「抓取」`,
  };
}

/**
 * 从 CDP 抓到的全部 Cookie 里，提取「其他域名」的字典（只给 model_item_key 探测工具用）：
 * 豆包的模型列表实际由前端从 gateway 拉取，key 在响应里；这里不猜接口，只把
 * 浏览器实际存过的 doubao 域 Cookie 按域分组回出去，排障时能看清登录态覆盖了哪些子域。
 */
export function groupCookiesByDomain(cookies, domains = DOUBAO_DOMAINS) {  const ours = [];
  const others = new Map();
  for (const c of cookies || []) {
    const dom = String(c.domain || '').replace(/^\./, '');
    if (!dom) continue;
    if (domains.some(d0 => dom === d0 || dom.endsWith('.' + d0) || dom.endsWith(d0))) ours.push(c);
    else if (!others.has(dom)) others.set(dom, []);
  }
  return { doubao: ours, otherDomains: [...others.keys()].sort() };
}

// ---------------- model_item_key 抓取（给「补齐 8 个模型」用） ----------------

/**
 * 从一次 chat/completion 的请求体里抽出 model_item_key。
 * 纯函数：抓包里 model_item_key 同时出现在 conversation_init_ext 与 model_config，
 * 两处取任意一处即可；格式不对返回 null（不猜）。
 */
export function extractModelItemKey(postData) {
  if (typeof postData !== 'string' || !postData) return null;
  let body;
  try { body = JSON.parse(postData); } catch { return null; }
  const opt = body?.option || body;
  const key = opt?.conversation_init_ext?.model_item_key
    ?? opt?.model_config?.model_item_key
    ?? null;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

/**
 * 连已登录的豆包页面，监听网络请求，把用户手选的模型对应的 model_item_key 抓出来。
 * 只用 Network 域（只读观察），不注入脚本、不改页面。
 */
export async function captureModelKeys(opts = {}, deps = {}) {
  const d = makeDeps(deps);
  const port = Number(opts.port) || 9222;
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const onKey = typeof opts.onKey === 'function' ? opts.onKey : () => {};
  const seen = [];
  const probe = await probeDebugPort(port, deps, 1500);
  if (!probe.ok) throw new Error(`127.0.0.1:${port} 没有响应（${probe.reason}）`);

  // 页面级 target 才有 Network 域
  const listRes = await d.fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await listRes.json();
  const page = (targets || []).find(t => t.type === 'page' && /doubao\.com/.test(t.url || ''))
    || (targets || []).find(t => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) throw new Error('没找到豆包页面标签页（先在窗口里打开 www.doubao.com 并登录）');

  return await new Promise((resolve, reject) => {
    let ws;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(seen);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try { ws = d.createSocket(page.webSocketDebuggerUrl); } catch (e) { clearTimeout(timer); return reject(e); }
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));
      if (opts.onOpen) opts.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      if (done) return; // 已结束（超时/达到 stopAfter）之后到的事件一律忽略
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id === 1 && msg.error) { clearTimeout(timer); return finish(new Error('Network.enable 失败：' + (msg.error.message || '未知'))); }
      if (msg.method !== 'Network.requestWillBeSent') return;
      const req = msg.params?.request || {};
      if (!/chat\/completion/.test(req.url || '')) return;
      const key = extractModelItemKey(req.postData);
      if (!key) return;
      const item = { key, url: req.url, at: Date.now() };
      seen.push(item);
      onKey(item);
      if (opts.stopAfter && seen.length >= opts.stopAfter) { clearTimeout(timer); finish(null); }
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      finish(new Error('WebSocket 失败：' + (e?.message || '连接被拒')));
    });
  });
}

/**
 * 图片上传：把本地图片变成豆包能引用的 uri（`tos-cn-i-<service>/<hex>.<ext>`）。
 *
 * 为什么借客户端：豆包上传走火山引擎 veImageX（prepare_upload 发 STS 凭证 → 签名 PUT → Commit），
 * 自己实现要搬一套 V4 签名；而客户端里本来就有一个 file input，塞文件它就替你传完了，
 * 传完的 uri 会出现在 /alice/message/pre_handle_v2_without_conv 的 uplink_entity 里。
 * 所以我们用 CDP 塞文件、再从网络请求里把 uri 捞出来——零签名，稳定。
 *
 * 依赖：豆包 PC 客户端带 --remote-debugging-port=9222 启动（tools/start-doubao-debug.cmd）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWebSocket } from './browser.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 找一个可挂的豆包页面：优先聊天页 */
async function pickTarget(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  const list = await res.json();
  return list.find(t => t.webSocketDebuggerUrl && /doubao-chat\/chat/.test(t.url || ''))
    || list.find(t => t.webSocketDebuggerUrl && /www\.doubao\.com/.test(t.url || ''))
    || null;
}

/**
 * 塞文件 → 等客户端上传 → 捞出 uri。
 * @returns {Promise<{uri: string, identifier: string, width: number, height: number, name: string}>}
 */
export async function uploadImageViaApp(filePath, opts = {}) {
  const port = Number(opts.port) || 9222;
  const waitMs = Number(opts.waitMs) || 45000;
  if (!fs.existsSync(filePath)) throw new Error('图片不存在：' + filePath);
  const target = await pickTarget(port).catch((e) => { throw new Error(`连不上豆包调试端口 ${port}：${e.message}`); });
  if (!target) throw new Error('没找到豆包聊天页（先在豆包里切到随便一个对话）');

  const ws = createWebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  let found = null;
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method !== 'Network.requestWillBeSent') return;
    const url = m.params.request.url || '';
    const body = m.params.request.postData || '';
    if (!/pre_handle|chat\/completion/.test(url) || !body.includes('uplink_entity')) return;
    // uplink_entity.entity_content.image.key 就是 upload 后的 uri
    const key = /"image"\s*:\s*\{\s*"key"\s*:\s*"([^"]+)"/.exec(body);
    if (key) {
      const ident = /"identifier"\s*:\s*"([^"]+)"/.exec(body);
      found = { uri: key[1], identifier: ident ? ident[1] : '' };
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
    await send('Network.enable', { maxPostDataSize: 800000 });
    await send('Page.enable');
    await send('DOM.enable');
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const inputs = [];
    const walk = (n) => {
      if (!n) return;
      const arr = n.attributes || [];
      const get = (k) => { const i = arr.indexOf(k); return i >= 0 ? arr[i + 1] : ''; };
      if (n.nodeName === 'INPUT' && get('type') === 'file') inputs.push({ nodeId: n.nodeId, accept: get('accept') });
      for (const c of n.children || []) walk(c);
      for (const c of n.shadowRoots || []) walk(c);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(doc.root);
    if (!inputs.length) throw new Error('豆包聊天页没有 file input（客户端版本可能变了）');
    await send('DOM.setFileInputFiles', { files: [path.resolve(filePath)], nodeId: inputs[0].nodeId });

    const deadline = Date.now() + waitMs;
    while (!found && Date.now() < deadline) await sleep(400);
    if (!found) throw new Error(`上传超时（${Math.round(waitMs / 1000)}s）：客户端没发出带 uri 的请求，可能图片太大或未登录`);
    if (opts.cleanup !== false) {
      // 图还挂在客户端输入框里：刷一下页面清掉，免得用户接着发消息时带上这张图
      await send('Page.reload', { ignoreCache: false }).catch(() => { /* 刷新失败就算了，不影响本次上传 */ });
    }
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }

  let width = 0;
  let height = 0;
  let name = path.basename(filePath);
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.slice(1, 4).toString('ascii') === 'PNG') {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    }
  } catch { /* 尺寸拿不到不影响上传 */ }
  return { uri: found.uri, identifier: found.identifier, width, height, name };
}

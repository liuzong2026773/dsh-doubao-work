/**
 * 真浏览器联调（不是离线测试）：用本地假「豆包登录页」验证登录助手真的能在页面里
 * 点开弹窗、填手机号、点发送验证码、填验证码、点登录。
 *
 *   node tests/browser-live.mjs            # 需要本机有 Edge/Chrome
 *   node tests/browser-live.mjs --keep     # 结束后不关窗口
 *
 * 普通 Node 20 没有全局 WebSocket 时自动跳过（用 Electron 的 node 模式跑即可）：
 *   ELECTRON_RUN_AS_NODE=1 "<安装目录>/DeepSeek Harness.exe" tests/browser-live.mjs
 */
import http from 'node:http';
import assert from 'node:assert';
import { launchBrowser, closeBrowser, loginAssist, probeDebugPort } from '../browser.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

if (typeof globalThis.WebSocket !== 'function') {
  console.log('跳过：当前 Node 没有全局 WebSocket（用 Electron 的 node 模式跑，或 Node 22+）');
  process.exit(0);
}

// ---------------- 假登录页 ----------------
const actions = [];
const PAGE = `<!doctype html><meta charset="utf-8"><title>假豆包</title>
<style>body{font-family:system-ui;margin:40px}#modal{display:none;position:fixed;inset:0;background:#0006;align-items:center;justify-content:center}
#card{background:#fff;padding:24px;border-radius:12px;width:320px}input{display:block;width:100%;margin:8px 0;padding:10px;box-sizing:border-box}
button{margin-top:8px;padding:8px 14px}</style>
<h1>假豆包</h1><button id="login">登录</button>
<div id="modal"><div id="card">
  <input id="phone" type="tel" placeholder="请输入手机号" maxlength="11">
  <button id="send">发送验证码</button>
  <input id="code" placeholder="请输入验证码" maxlength="6">
  <button id="submit">登录</button>
</div></div>
<script>
const log = (m) => fetch('/log?m=' + encodeURIComponent(m));
document.getElementById('login').onclick = () => {
  document.getElementById('modal').style.display = 'flex';
  log('open');
};
document.getElementById('send').onclick = () => log('send:' + document.getElementById('phone').value);
document.getElementById('submit').onclick = () => {
  log('submit:' + document.getElementById('code').value);
  document.getElementById('modal').style.display = 'none';
};
</script>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/log')) {
    actions.push(decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('m') || ''));
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const handle = await launchBrowser({ startUrl: pageUrl });
let up = { ok: false, reason: '还没探测' };
for (let i = 0; i < 20 && !up.ok; i++) {
  up = await probeDebugPort(handle.port, {}, 900);
  if (!up.ok) await new Promise(r => setTimeout(r, 700));
}
if (!up.ok) {
  console.error('浏览器没起来：' + up.reason);
  await closeBrowser(handle);
  server.close();
  process.exit(1);
}
console.log('登录助手（真浏览器 + 本地假登录页）');

try {
  await ok('probe：还没打开弹窗时认得页面状态', async () => {
    const r = await loginAssist({ port: handle.port, action: 'probe' });
    assert.equal(r.stage, 'idle');
    assert.equal(r.form.inputs.length, 0);
    assert.ok(r.form.loginBtn, '应找到页面上的「登录」按钮');
  });

  await ok('open：点「登录」后等到输入框出现', async () => {
    const r = await loginAssist({ port: handle.port, action: 'open' });
    assert.equal(r.stage, 'form', JSON.stringify(r.steps));
    assert.ok(r.form.inputs.length >= 2, '手机号 + 验证码两个框');
  });

  await ok('phone：填手机号并点「发送验证码」', async () => {
    const r = await loginAssist({ port: handle.port, action: 'phone', phone: '138 0013 8000' });
    assert.equal(r.stage, 'sent', JSON.stringify(r.steps));
    await new Promise(res => setTimeout(res, 300));
    assert.ok(actions.includes('send:13800138000'), '页面应当收到格式化后的号码：' + JSON.stringify(actions));
  });

  await ok('code：填验证码并点「登录」', async () => {
    const r = await loginAssist({ port: handle.port, action: 'code', code: '123456' });
    assert.equal(r.stage, 'submitted', JSON.stringify(r.steps));
    await new Promise(res => setTimeout(res, 300));
    assert.ok(actions.includes('submit:123456'), '页面应当收到验证码：' + JSON.stringify(actions));
  });

  await ok('手机号格式不对时直接拒绝（不点发送）', async () => {
    const r = await loginAssist({ port: handle.port, action: 'phone', phone: '12' });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'bad-phone');
  });

  await ok('连不上调试端口时给出可读错误', async () => {
    await assert.rejects(() => loginAssist({ port: 1, action: 'probe' }), /没有找到页面标签页|fetch|ECONNREFUSED|超时/i);
  });
} finally {
  if (!process.argv.includes('--keep')) await closeBrowser(handle);
  server.close();
}

console.log('\n全部通过：' + passed + ' 项');

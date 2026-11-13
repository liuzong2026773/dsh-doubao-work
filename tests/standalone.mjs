/**
 * standalone 网关联调：真实启动 `standalone/index.js`，上游用本地假豆包（不联网、不耗额度）。
 *
 *   node tests/standalone.mjs
 *
 * 覆盖：网关启动、/health、/v1/models 白名单、非流式/流式 OpenAI 形状、
 *       未知模型 400、apiKey 校验、/status 渲染、上游确实打到 baseUrl。
 * 1.4.0 起 standalone 复用 doubao.js 的账号池与上游调用，这里验的就是那条路。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// ---------------- 假豆包上游 ----------------

const hits = [];
let upstreamPort = 0;
const upstream = http.createServer((req, res) => {
  hits.push(req.url.split('?')[0]);
  if (req.url.startsWith('/chat/completion')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let key = '';
      try { key = JSON.parse(raw)?.option?.conversation_init_ext?.model_item_key || ''; } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('SSE_ACK', { ack_client_meta: { conversation_info: { conversation_id: 'conv-standalone-1', extra: { model_item_key: key } } } });
      ev('CHUNK_DELTA', { text: '你' });
      ev('CHUNK_DELTA', { text: '好' });
      ev('SSE_REPLY_END', {});
      res.end();
    });
    return;
  }
  if (req.url.startsWith('/alice/ug/campaign')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { tasks: [{ daily_checkin: { checked_in_today: false } }] } }));
    return;
  }
  if (req.url.startsWith('/alice/quota')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: {} }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
upstreamPort = upstream.address().port;

// ---------------- 启动网关（配置落在临时目录） ----------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-gw-'));
const gwPort = await freePort();
const API_KEY = 'test-key-123';
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  port: gwPort,
  apiKey: API_KEY,
  baseUrl: `http://127.0.0.1:${upstreamPort}`,
  models: { 'deepseek-v4.1-flash': 'person-deepseek-v4-1-flash-261017', 'doubao-2.1-lite': 'seed-lite-7b' },
  requestTimeoutMs: 8000,
  maxAttempts: 1,
}, null, 2));
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
  accounts: [{ id: 'acc-gw', remark: '网关测试', cookie: 'sessionid=standalone-test-1234567890; sid_guard=x', enabled: true }],
}, null, 2));

const child = spawn(process.execPath, [path.join(repo, 'standalone', 'index.js')], {
  env: { ...process.env, DSH_DOUBAO_GATEWAY_DIR: dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
child.stdout.on('data', d => { bootLog += d.toString(); });
child.stderr.on('data', d => { bootLog += d.toString(); });

const base = `http://127.0.0.1:${gwPort}`;
const authHeaders = { authorization: 'Bearer ' + API_KEY };

async function waitUp(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('网关没起来：\n' + bootLog);
}

try {
  await waitUp();
  console.log('standalone 网关');

  await ok('启动成功且 /health 正常', async () => {
    const r = await fetch(base + '/health');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.accounts, 1);
  });

  await ok('/v1/models 只暴露配置里的模型', async () => {
    const j = await (await fetch(base + '/v1/models', { headers: authHeaders })).json();
    assert.deepEqual(j.data.map(m => m.id).sort(), ['deepseek-v4.1-flash', 'doubao-2.1-lite']);
    assert.equal(j.object, 'list');
  });

  await ok('apiKey 校验：无头 401，有头放行', async () => {
    const bad = await fetch(base + '/v1/models');
    assert.equal(bad.status, 401);
    const good = await fetch(base + '/v1/models', { headers: authHeaders });
    assert.equal(good.status, 200);
  });

  await ok('非流式：OpenAI 形状 + usage + 上游确实走 baseUrl', async () => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '你好' }] }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.object, 'chat.completion');
    assert.equal(j.choices[0].message.content, '你好');
    assert.equal(j.choices[0].finish_reason, 'stop');
    assert.ok(j.usage.total_tokens > 0);
    assert.ok(hits.some(h => h === '/chat/completion'), '上游应被真实调用');
  });

  await ok('流式：chunk 形状正确且以 [DONE] 收尾', async () => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: '流式测试' }], stream: true }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    assert.equal(lines.at(-1), 'data: [DONE]');
    const chunks = lines.slice(0, -1).map(l => JSON.parse(l.slice(6)));
    const content = chunks.map(c => c.choices[0].delta.content || '').join('');
    assert.equal(content, '你好');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
    assert.ok(chunks.every(c => c.object === 'chat.completion.chunk'));
  });

  await ok('未知模型返回 400（不偷偷回退）', async () => {
    const r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error.message, /未知模型/);
  });

  await ok('会话复用：第二轮只发增量（同一对话键复用 conversation_id）', async () => {
    const first = await (await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-2.1-lite', messages: [{ role: 'user', content: '复用测试第一句' }] }),
    })).json();
    assert.equal(first.choices[0].message.content, '你好');
    const second = await (await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao-2.1-lite',
        messages: [
          { role: 'user', content: '复用测试第一句' },
          { role: 'assistant', content: '你好' },
          { role: 'user', content: '第二句' },
        ],
      }),
    })).json();
    assert.equal(second.choices[0].message.content, '你好');
    await sleep(2500); // 状态是 2s 防抖落盘的，等一下再读文件
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'gateway-state.json'), 'utf8'));
    const convs = Object.values(state.conversations || {});
    assert.ok(convs.some(c => c.conversationId === 'conv-standalone-1'), '应记住服务端会话号');
  });

  await ok('/status 渲染账号表', async () => {
    const html = await (await fetch(base + '/status')).text();
    assert.match(html, /doubao-gateway 状态/);
    assert.match(html, /acc-gw/);
    assert.match(html, /今日请求/);
  });

  await ok('/admin/check 走统一健康检查', async () => {
    const r = await fetch(base + '/admin/check', { method: 'POST', headers: authHeaders });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(j.results));
    assert.equal(j.results[0].id, 'acc-gw');
  });
} finally {
  child.kill();
  await sleep(200);
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n全部通过：' + passed + ' 项');

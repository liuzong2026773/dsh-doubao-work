/**
 * 上游联调测试：用本地假豆包服务器验证真实调用路径（不联网、不耗额度）。
 *
 *   node tests/upstream.mjs
 *
 * 覆盖：SSE 解析、多账号换号、429 冷却、额度用尽冷却到零点、空响应、
 *       流中断不重复输出、调用方取消、会话复用回传 conversation_id。
 */
import http from 'node:http';
import assert from 'node:assert';
import { DoubaoClient, DoubaoError } from '../doubao.js';

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

// ---------------- 假上游 ----------------

const upstream = {
  /** cookie → 行为；未命中时用 defaultBehavior */
  byCookie: {},
  defaultBehavior: 'ok',
  bodies: [],
  hits: [],
};

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const SSE_OK_TEXT = ['你', '好', '！'];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  upstream.hits.push(url.pathname);

  if (url.pathname === '/alice/commerce/sale/subscription/quota/summary/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: {} }));
    return;
  }
  if (url.pathname !== '/chat/completion') {
    res.writeHead(404).end();
    return;
  }

  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try { upstream.bodies.push(JSON.parse(raw)); } catch (e) { upstream.bodies.push(null); }
    const mode = upstream.byCookie[String(req.headers.cookie || '')] || upstream.defaultBehavior;

    if (mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    if (mode === 'quota') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'quota exceeded, 余额不足' }));
      return;
    }
    if (mode === '500') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html>login</html>');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, 'SSE_HEARTBEAT', {});
    sse(res, 'SSE_ACK', { ack_client_meta: { conversation_info: { conversation_id: 'conv-test-1' } } });

    if (mode === 'empty') { sse(res, 'SSE_REPLY_END', {}); res.end(); return; }

    if (mode === 'midfail') {
      // 先吐两段再掐断连接：模拟流中途失败
      for (const t of SSE_OK_TEXT.slice(0, 2)) {
        sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: t } } }] } }] });
      }
      setTimeout(() => res.destroy(), 30);
      return;
    }

    if (mode === 'hang') {
      // 一直不结束：给取消测试用
      sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: '半' } } }] } }] });
      return;
    }

    for (const t of SSE_OK_TEXT) {
      sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: t } } }] } }] });
    }
    sse(res, 'SSE_REPLY_END', {});
    res.end();
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const COOKIE_A = 'sessionid=aaa111; sid_guard=aaa; uid_tt=1';
const COOKIE_B = 'sessionid=bbb222; sid_guard=bbb; uid_tt=2';

function makeClient(accounts, extra = {}) {
  return new DoubaoClient({
    baseUrl,
    accounts,
    rpmPerAccount: 100,
    maxAttempts: 2,
    shortCoolSeconds: 300,
    coolSeconds: 86400,
    reasoningEffort: 0,
    ...extra,
  }, { log: () => {} });
}

/** 消费 chat() 生成器，返回 { deltas, result } */
async function run(client, model, text, opts = {}) {
  const deltas = [];
  const gen = client.chat(model, text, opts.signal, { conversationId: opts.conversationId || '' });
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { deltas, result: value };
    deltas.push(value);
  }
}

const acc = (id, cookie) => ({ id, cookie, remark: id, enabled: true });

console.log('上游调用');
await ok('正常流式：增量拼接与会话号', async () => {
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const { deltas, result } = await run(c, 'doubao-2.1-lite', '你好');
  assert.deepEqual(deltas, ['你', '好', '！']);
  assert.equal(result.text, '你好！');
  assert.equal(result.conversationId, 'conv-test-1');
});

await ok('429 换号：首个账号冷却、第二个账号接手', async () => {
  upstream.defaultBehavior = 'ok';
  upstream.byCookie = { [COOKIE_A]: '429' };
  const c = makeClient([acc('a1', COOKIE_A), acc('a2', COOKIE_B)]);
  const { result } = await run(c, 'doubao-2.1-lite', 'hi');
  assert.equal(result.text, '你好！');
  const st = c.accountState('a1');
  assert.ok(st.coolUntil > Date.now() + 30_000, 'a1 应按 Retry-After 冷却');
  assert.ok(String(st.lastError).includes('429'));
});

await ok('额度用尽：cooldown 到次日零点', async () => {
  upstream.byCookie = { [COOKIE_A]: 'quota', [COOKIE_B]: 'quota' };
  const c = makeClient([acc('a1', COOKIE_A), acc('a2', COOKIE_B)]);
  await assert.rejects(run(c, 'doubao-2.1-lite', 'hi'), (e) => {
    assert.ok(e instanceof DoubaoError);
    assert.equal(e.kind, 'quota');
    return true;
  });
  const st = c.accountState('a1');
  const left = st.coolUntil - Date.now();
  assert.ok(left > 0 && left <= 24 * 3600 * 1000, '冷却应落在 24h 内');
});

await ok('空响应：判为 empty 并短冷却', async () => {
  upstream.byCookie = { [COOKIE_A]: 'empty' };
  const c = makeClient([acc('a1', COOKIE_A)]);
  await assert.rejects(run(c, 'doubao-2.1-lite', 'hi'), (e) => e.kind === 'empty');
  const left = c.accountState('a1').coolUntil - Date.now();
  assert.ok(left > 0 && left <= 300_000 + 1000, '应短冷却（默认 300s）');
});

await ok('流中断：已输出的内容保留，不换号重发', async () => {
  upstream.byCookie = { [COOKIE_A]: 'midfail' };
  const c = makeClient([acc('a1', COOKIE_A), acc('a2', COOKIE_B)]);
  const hitsBefore = upstream.hits.length;
  const { deltas, result } = await run(c, 'doubao-2.1-lite', 'hi');
  assert.deepEqual(deltas, ['你', '好']);
  assert.equal(result.text, '你好');
  assert.equal(result.truncated, true);
  // 关键：只打了第一个账号，没有拿第二个账号从头再发一遍
  const chatHits = upstream.hits.slice(hitsBefore).filter(p => p === '/chat/completion');
  assert.equal(chatHits.length, 1, '不应换号重发（否则用户会看到重复文本）');
});

await ok('调用方取消：判为 aborted', async () => {
  upstream.byCookie = { [COOKIE_A]: 'hang' };
  const c = makeClient([acc('a1', COOKIE_A)]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 120);
  await assert.rejects(run(c, 'doubao-2.1-lite', 'hi', { signal: ac.signal }), (e) => e.kind === 'aborted');
});

await ok('会话复用：第二轮带回 conversation_id 且不新建会话', async () => {
  upstream.byCookie = {};
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const first = await run(c, 'doubao-2.1-lite', '第一句');
  assert.equal(first.result.conversationId, 'conv-test-1');

  upstream.bodies.length = 0;
  const second = await run(c, 'doubao-2.1-lite', '第二句', { conversationId: first.result.conversationId });
  assert.equal(second.result.text, '你好！');
  const body = upstream.bodies[0];
  assert.equal(body.client_meta.conversation_id, 'conv-test-1');
  assert.equal(body.option.need_create_conversation, false);
  assert.equal(body.messages.length, 1, '复用会话时只发本轮新消息');
});

await ok('非 SSE（HTML 登录页）判为 auth', async () => {
  upstream.byCookie = { [COOKIE_A]: 'html' };
  const c = makeClient([acc('a1', COOKIE_A)]);
  await assert.rejects(run(c, 'doubao-2.1-lite', 'hi'), (e) => e.kind === 'auth');
  assert.equal(c.accountState('a1').authError, true);
});

console.log('账号池');
await ok('停用账号出现在快照里、状态为已停用', async () => {
  const c = makeClient([acc('a1', COOKIE_A), { id: 'a2', cookie: COOKIE_B, enabled: false }]);
  const snap = c.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap.find(a => a.id === 'a2').status, '已停用');
  assert.equal(snap.find(a => a.id === 'a1').status, '可用');
});

await ok('停用账号不参与调度', async () => {
  const c = makeClient([{ id: 'a1', cookie: COOKIE_A, enabled: false }]);
  await assert.rejects(run(c, 'doubao-2.1-lite', 'hi'), (e) => e.kind === 'noaccount');
});

await ok('健康检查走 quota/summary 且 code:0 判活', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const results = await c.checkAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

server.close();
console.log('\n全部通过：' + passed + ' 项');

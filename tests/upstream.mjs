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
  /** probeModelKey 用：非空时假装服务端把 key 换成了这个值 */
  ackKeyOverride: '',
  // 活动/签到接口可控项
  campaign: { checkedIn: false, detailCode: 0, detailHttp: 200, checkinCode: 0 },
};

/** 重置签到可控项 */
function resetCampaign(over = {}) {
  upstream.campaign = { checkedIn: false, detailCode: 0, detailHttp: 200, checkinCode: 0, ...over };
}
const campaignHits = () => upstream.hits.filter(p => p.startsWith('/alice/ug/campaign'));

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
  if (url.pathname === '/alice/ug/campaign/v3/detail/') {
    const c = upstream.campaign;
    res.writeHead(c.detailHttp, { 'content-type': 'application/json' });
    res.end(JSON.stringify(c.detailCode === 0
      ? { code: 0, data: { tasks: [{ daily_checkin: { checked_in_today: c.checkedIn, reward: '200 额度' } }] } }
      : { code: c.detailCode, message: 'detail 异常' }));
    return;
  }
  if (url.pathname === '/alice/ug/campaign/landing/checkin') {
    const c = upstream.campaign;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(c.checkinCode === 0
      ? { code: 0, data: { complete_page_info: { title: '签到成功' }, toast: { text: '+200 额度' } } }
      : { code: c.checkinCode, message: '不满足签到条件' }));
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
    // 真实豆包在 SSE_ACK 里回写实际生效的 model_item_key，probeModelKey 靠它判定成败，
    // 所以假上游也要回写（ackKeyOverride 可模拟「传 A 实际生效 B」）
    let echoKey = '';
    try { echoKey = JSON.parse(raw)?.option?.conversation_init_ext?.model_item_key || ''; } catch (e) { /* ignore */ }
    sse(res, 'SSE_ACK', {
      ack_client_meta: {
        conversation_info: {
          conversation_id: 'conv-test-1',
          extra: { model_item_key: upstream.ackKeyOverride || echoKey },
        },
      },
    });

    if (mode === 'streamerror') {
      // 真实豆包的风控拒绝：HTTP 200，但流里先给 STREAM_ERROR
      sse(res, 'STREAM_ERROR', {
        error_code: 710022004, error_msg: 'rate limited',
        extra: { decision: JSON.stringify({ code: '10000', type: 'verify', subtype: 'semantic_reasoning', verify_scene: 'doubao_message_web' }) },
      });
      sse(res, 'SSE_REPLY_END', { end_type: 3 });
      res.end();
      return;
    }

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

console.log('每日签到');
await ok('未签状态：先查状态再签到，返回 ok 与奖励', async () => {
  upstream.byCookie = {};
  resetCampaign({ checkedIn: false });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = upstream.hits.length;
  const r = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(r.result, 'ok');
  assert.equal(r.reward, '200 额度');
  const hits = upstream.hits.slice(before);
  assert.deepEqual(hits, ['/alice/ug/campaign/v3/detail/', '/alice/ug/campaign/landing/checkin']);
});

await ok('当日已签：判 already 且不打 checkin 接口', async () => {
  resetCampaign({ checkedIn: true });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = campaignHits().length;
  const r = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(r.result, 'already');
  assert.deepEqual(campaignHits().slice(before), ['/alice/ug/campaign/v3/detail/'], '已签不应再打签到接口');
});

await ok('服务端硬拒：记 failed，同日不再重打', async () => {
  resetCampaign({ checkedIn: false, checkinCode: 710010702 });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = campaignHits().length;
  const first = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(first.result, 'failed');
  assert.equal(first.code, 710010702);
  assert.equal(campaignHits().slice(before).filter(p => p.endsWith('/landing/checkin')).length, 1);
  const again = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(again.result, 'skipped');
  assert.equal(campaignHits().slice(before).filter(p => p.endsWith('/landing/checkin')).length, 1, '今日已失败，不应再打');
});

await ok('状态接口异常：checkin 抛出 upstream 错误', async () => {
  resetCampaign({ detailCode: 710010202 });
  const c = makeClient([acc('a1', COOKIE_A)]);
  await assert.rejects(c.checkin(acc('a1', COOKIE_A)), (e) => e instanceof DoubaoError && e.kind === 'upstream');
});

await ok('登录态失效：标 authError 并在汇总里记 error', async () => {
  resetCampaign({ detailHttp: 401, detailCode: 401 });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const results = await c.checkinAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'error');
  assert.equal(c.accountState('a1').authError, true);
});

await ok('多账号汇总：单号失败不影响其他号', async () => {
  resetCampaign();
  upstream.byCookie = {};
  const c = makeClient([acc('a1', COOKIE_A), acc('a2', COOKIE_B)]);
  const spy = c.checkin.bind(c);
  c.checkin = async (a) => (a.id === 'a1' ? Promise.reject(new DoubaoError('network', '模拟网络故障')) : spy(a));
  const results = await c.checkinAll();
  assert.deepEqual(results.map(r => r.result).sort(), ['error', 'ok']);
});

// ---------------- 1.4.0：model_item_key 验证（以服务端回写为准） ----------------
await ok('probeModelKey：回写等于传入才算生效', async () => {
  upstream.ackKeyOverride = '';
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.probeModelKey(acc('a1', COOKIE_A), 'seed-lite-7b');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.echoed, 'seed-lite-7b');
});

await ok('probeModelKey：平台把 key 换成别的时如实报未生效', async () => {
  upstream.ackKeyOverride = 'auto-assigned-other';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.probeModelKey(acc('a1', COOKIE_A), 'person-deepseek-v4-1-flash-261017');
  assert.equal(r.ok, false);
  assert.equal(r.echoed, 'auto-assigned-other');
  upstream.ackKeyOverride = '';
});

await ok('probeModelKey：上游报错不炸，返回 ok:false 带原因', async () => {
  upstream.defaultBehavior = '429';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.probeModelKey(acc('a1', COOKIE_A), 'seed-lite-7b');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /限流|429|风控/);
  upstream.defaultBehavior = 'ok';
});

// ---------------- 1.5.1：上游流内报错要如实归类，不能只剩「空响应」 ----------------
await ok('STREAM_ERROR 710022004 判为限流而不是空响应', async () => {
  upstream.defaultBehavior = 'streamerror';
  const c = makeClient([acc('a1', COOKIE_A)]);
  let err;
  try {
    for await (const _ of c.chat('deepseek-v4.1-flash', '你好', new AbortController().signal, {})) { /* drain */ }
  } catch (e) { err = e; }
  upstream.defaultBehavior = 'ok';
  assert.ok(err, '应该抛错');
  assert.equal(err.kind, 'ratelimit');
  assert.match(err.message, /710022004/);
  assert.match(err.message, /人机验证|限流/);
});

// ---------------- 1.5.1：模型选择必须体现在 need_deep_think 上 ----------------
await ok('上游收到的请求带 need_deep_think=10001（模型才真的切过去）', async () => {
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = upstream.bodies.length;
  for await (const _ of c.chat('deepseek-v4.1-flash', '你好', new AbortController().signal, {})) { /* drain */ }
  const sent = upstream.bodies.slice(before).find(b => b && b.option);
  assert.ok(sent, '应该发出请求');
  assert.equal(sent.option.need_deep_think, 10001);
  assert.equal(sent.option.conversation_init_ext.model_item_key, 'person-deepseek-v4-1-flash-261017');
  assert.equal(sent.option.model_config.model_extra_params.memory_profile, '300k_230');
});

server.close();
console.log('\n全部通过：' + passed + ' 项');

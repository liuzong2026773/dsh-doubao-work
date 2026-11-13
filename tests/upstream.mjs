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
  /** 图片登记（pre_handle_v2_without_conv）收到的请求体 */
  preHandles: [],
  /** probeModelKey 用：非空时假装服务端把 key 换成了这个值 */
  ackKeyOverride: '',
  // 活动/签到接口可控项
  campaign: { checkedIn: false, detailCode: 0, detailHttp: 200, checkinCode: 0, detailMsg: 'detail 异常' },
};

/** 重置签到可控项 */
function resetCampaign(over = {}) {
  upstream.campaign = { checkedIn: false, detailCode: 0, detailHttp: 200, checkinCode: 0, detailMsg: 'detail 异常', ...over };
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
      : { code: c.detailCode, message: c.detailMsg }));
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
  if (url.pathname === '/alice/conversation/latest_messagelist') {
    const videoMsg = {
      message_id: 'm-video-1',
      index: 9,
      content: JSON.stringify([{
        block_type: 2074,
        content: { creation_block: { creations: [{
          type: 2, id: 'cr-video-1', gen_detail: { task_type: 6 },
          video: {
            vid: 'v0269test', download_url: 'https://x.test/video.mp4?sig=1\\u0026x=2',
            duration: 5.057, width: 384, height: 216, video_type: 'mp4', status: 3,
            cover: { image_thumb: { url: 'https://x.test/cover.png' } },
          },
        }] } },
      }]),
    };
    upstream.hits.push(url.pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, msg: '', data: { message_map: { 'conv-test-1': [videoMsg] } } }));
    return;
  }

  // 图片登记：registerImages 会调它（自己收 body，因为要赶在下面的 404 卫兵之前返回）
  if (url.pathname === '/alice/message/pre_handle_v2_without_conv') {
    let regRaw = '';
    req.on('data', (c) => { regRaw += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(regRaw); } catch { /* 空 body 就算了 */ }
      upstream.preHandles.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: '', data: { pre_generate_id: 'pg-test-1' } }));
    });
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

    if (mode === 'artifact') {
      // 真实产物卡片：只有 resource_id + conversation_id，没有直链；status 会从"制作中"变"完成"
      const card = (title, status) => ({ patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10030, content: { artifact_block: { resource_id: 'res-1', conversation_id: 'conv-9', title, status, resource_content_type: 'type/sxsd', brief_image: { image_thumb: { url: 'https://x.test/prev.png?a=1\\u0026b=2' } } } } }] } }] });
      sse(res, 'STREAM_CHUNK', card('季度计划（制作中）', 2));
      sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: 'PPT 已做好。' } } }] } }] });
      sse(res, 'STREAM_CHUNK', card('季度计划', 3));
      sse(res, 'SSE_REPLY_END', { end_type: 3 });
      res.end();
      return;
    }

    if (mode === 'fileblock') {
      // 文件直链块（10020）：Word/PDF 这类在 SSE 里就能拿到，不必等会话消息
      sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10020, content: { file_block: {
        type: 'docx', name: '周报.docx', uri: 'tos-cn-i-x/z.docx', url: 'https://x.test/z.docx?sig=1', size: '40267',
      } } } ] } } ] } );
      for (const t of ['已', '生', '成', '。']) {
        sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: t } } }] } }] });
      }
      sse(res, 'SSE_REPLY_END', { end_type: 3 });
      res.end();
      return;
    }

    if (mode === 'media') {
      // 真实生图下发顺序：占位创作块（没有 URL）→ 文本 → 同一个 id 补上 image_ori URL
      const blk = (creations) => ({ patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 2074, content: { creation_block: { creations } } }] } }] });
      sse(res, 'STREAM_CHUNK', blk([{ type: 1, id: 'cr-1', image: { status: 2, placeholder: true } }]));
      sse(res, 'STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_value: { content_block: [{ block_type: 10000, content: { text_block: { text: '已生成。' } } }] } }] });
      sse(res, 'STREAM_CHUNK', blk([{ type: 1, id: 'cr-1', image: { status: 3, image_ori: { url: 'https://x.test/a.jpeg\\u0026sig=1' }, image_thumb: { url: 'https://x.test/a-thumb.png' } } }]));
      // 同一张图再重复下发一次：去重要起作用
      sse(res, 'STREAM_CHUNK', blk([{ type: 1, id: 'cr-1', image: { status: 3, image_ori: { url: 'https://x.test/a.jpeg\\u0026sig=1' } } }]));
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

await ok('服务端硬拒 710010702：记 unavailable（不是 failed），同日不再重打', async () => {
  resetCampaign({ checkedIn: false, checkinCode: 710010702 });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = campaignHits().length;
  const first = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(first.result, 'unavailable');
  assert.match(first.error, /710010702/);
  assert.equal(first.code, 710010702);
  assert.equal(campaignHits().slice(before).filter(p => p.endsWith('/landing/checkin')).length, 1);
  const again = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(again.result, 'skipped');
  assert.equal(campaignHits().slice(before).filter(p => p.endsWith('/landing/checkin')).length, 1, '今日已失败，不应再打');
});

await ok('活动配置在服务端没了（detail code=1）：判 unavailable，且不发 checkin', async () => {
  resetCampaign({ detailCode: 1 });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = campaignHits().length;
  const r = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(r.result, 'unavailable');
  assert.match(r.error, /暂不可用/);
  assert.equal(campaignHits().slice(before).filter(p => p.endsWith('/landing/checkin')).length, 0, '活动不可用时不该再打签到接口');
});

await ok('活动已下线（campaign not found）：判 unavailable 且提示"未开放"', async () => {
  resetCampaign({ detailCode: 2, detailMsg: 'campaign not found' });
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.checkin(acc('a1', COOKIE_A));
  assert.equal(r.result, 'unavailable');
  assert.match(r.error, /未开放|campaign/i);
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

await ok('generate()：普通对话模式（agent_mode=2 / mode_id=1 / 不带 conversation_mode）', async () => {
  upstream.defaultBehavior = 'media';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = upstream.bodies.length;
  const r = await c.generate('画一只猫', { id: 'a1' });
  const sent = upstream.bodies.slice(before).find(b => b && b.option);
  assert.equal(sent.option.agent_mode, 2, '生图应走普通对话的 agent_mode');
  assert.equal(sent.option.conversation_init_ext.mode_id, '1');
  assert.equal(sent.option.conversation_init_ext.model_item_key, '0');
  assert.equal(sent.option.need_deep_think, 0);
  assert.ok(!('conversation_mode' in sent.option), '普通对话不该带 conversation_mode=2');
  assert.equal(r.text.includes('已生成。'), true);
});

await ok('generate()：图片占位块先无 URL、后有 URL，仍能取到且只取一次', async () => {
  upstream.defaultBehavior = 'media';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.generate('画一只猫', { id: 'a1' });
  assert.equal(r.media.length, 1, '重复下发不应产生第二条：' + JSON.stringify(r.media));
  assert.equal(r.media[0].kind, 'image');
  assert.equal(r.media[0].url, 'https://x.test/a.jpeg&sig=1', '应取 image_ori 且把 \\u0026 还原成 &');
  assert.ok(r.text.includes('![](https://x.test/a.jpeg&sig=1)'), '文本里应插入 markdown 图片：' + r.text);
});

await ok('msToken：有 token 就走客户端身份（aid=582478 + msToken + 客户端 UA）', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  assert.equal(c.clientTransport, false, '没 token 时应为网页身份');
  const webUrl = c._buildUrl();
  assert.ok(webUrl.includes('aid=497858'), '网页身份 aid 不变');
  assert.equal(c.setMsToken('tok-123'), true);
  const url = c._buildUrl();
  assert.ok(url.includes('aid=582478'), '客户端身份 aid=582478');
  assert.ok(url.includes('msToken=tok-123'), 'URL 要带 msToken');
  assert.ok(url.includes('doubao_device_platform=desktop') && url.includes('client_platform=pc_client'));
  assert.equal(c.clientTransport, true);
  // 强制网页身份
  const c2 = makeClient([acc('a1', COOKIE_A)], { transport: 'web' });
  c2.setMsToken('tok-123');
  assert.equal(c2.clientTransport, false, 'transport=web 应忽略 msToken');
});

await ok('generate()：产物卡片（10030）解析成文件条目，带打开链接与预览图', async () => {
  upstream.defaultBehavior = 'artifact';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.generate('做一份 PPT', { id: 'a1' });
  const files = r.media.filter(m => m.kind === 'file');
  assert.ok(files.length >= 1, '应解析出文件条目：' + JSON.stringify(r.media));
  const last = files[files.length - 1];
  assert.equal(last.resourceId, 'res-1');
  assert.equal(last.name, '季度计划', '最终标题应覆盖「制作中」');
  assert.equal(last.url, 'https://www.doubao.com/chat/conv-9', '下载入口 = 打开这条对话');
  assert.equal(last.previewUrl, 'https://x.test/prev.png?a=1&b=2', '预览图 URL 应还原 &');
  assert.ok(r.text.includes('季度计划'), '文本里应有文件标题：' + r.text);
  assert.ok(r.text.includes('https://www.doubao.com/chat/conv-9'), '文本里应有打开链接：' + r.text);
});

await ok('parseMessageBlocks：消息的 content(JSON 字符串) 能还原成块', async () => {
  const { parseMessageBlocks } = await import('../doubao.js');
  const msg = { content: JSON.stringify([{ content_v2: JSON.stringify({ text_block: { text: 'hi' } }), block_type: 10000 }]) };
  const blocks = parseMessageBlocks(msg);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].block_type, 10000);
  assert.equal(blocks[0].content.text_block.text, 'hi');
});

await ok('latestMedia：从会话消息里回收视频直链（download_url）', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const media = await c.latestMedia({ id: 'a1', cookie: COOKIE_A }, 'conv-test-1');
  const v = media.find(m => m.kind === 'video');
  assert.ok(v, '应解析出视频：' + JSON.stringify(media));
  assert.equal(v.url, 'https://x.test/video.mp4?sig=1&x=2', '应还原 & 并用 download_url');
  assert.equal(v.duration, 5.057);
  assert.equal(v.cover, 'https://x.test/cover.png');
});

await ok('generateVideo：提需求 → 确认 → 轮询会话拿到 mp4', async () => {
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.generateVideo('生成一段 5 秒视频：海边日落', { id: 'a1', pollMs: 50, maxWaitMs: 4000, forceConfirm: true });
  const v = (r.media || []).find(m => m.kind === 'video');
  assert.ok(v, '最终应拿到视频：' + JSON.stringify(r));
  assert.equal(r.pending, false, '拿到就不该标 pending');
  assert.ok(r.polls >= 1, '应该轮询过会话');
  assert.equal(r.conversationId, 'conv-test-1');
});

await ok('带图提问：消息体里先 attachment_block(10052) 再 text_block(10000)', async () => {
  upstream.defaultBehavior = 'ok';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = upstream.bodies.length;
  for await (const _ of c.chat('doubao-2.1-lite', '这图里有什么', new AbortController().signal, {
    images: [{ uri: 'tos-cn-i-a9rns2rl98/abc.png', name: 'abc.png', width: 240, height: 160 }],
  })) { /* drain */ }
  const sent = upstream.bodies.slice(before).find(b => b && b.messages);
  const blocks = sent.messages[0].content_block;
  assert.equal(blocks[0].block_type, 10052, '第一块应是附件块：' + JSON.stringify(blocks.map(b => b.block_type)));
  const at = blocks[0].content.attachment_block.attachments[0];
  assert.equal(at.type, 1);
  assert.equal(at.image.uri, 'tos-cn-i-a9rns2rl98/abc.png');
  assert.equal(at.image.image_ori.width, 240);
  assert.equal(at.upload_status, 1, 'upload_status=1 表示已传完');
  assert.equal(blocks[1].content.text_block.text, '这图里有什么');
});

await ok('generate() 也支持带图（生图改图同一条通道）', async () => {
  upstream.defaultBehavior = 'media';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const before = upstream.bodies.length;
  await c.generate('把这张图改成夜景', { id: 'a1', images: [{ uri: 'tos-cn-i-a9rns2rl98/x.png' }] });
  const sent = upstream.bodies.slice(before).find(b => b && b.messages);
  assert.equal(sent.messages[0].content_block[0].block_type, 10052);
});

await ok('registerImages：补 pre_handle 登记（带 local_message_id），拿回 pre_generate_id', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const reg = await c.registerImages([{ uri: 'tos-cn-i-a9rns2rl98/x.png', name: 'x.png' }]);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].preGenerateId, 'pg-test-1');
  assert.ok(reg[0].identifier, '登记时应生成 identifier');
  const sent = upstream.preHandles[upstream.preHandles.length - 1];
  assert.equal(sent.uplink_entity.entity_type, 2);
  assert.equal(sent.uplink_entity.entity_content.image.key, 'tos-cn-i-a9rns2rl98/x.png');
  assert.ok(sent.local_message_id, '少了这个上游会 400 missing required parameter');
  assert.equal(sent.uplink_entity.identifier, reg[0].identifier, 'identifier 要和消息体里的一致');
});

await ok('collectMedia：轮询会话直到出现想要的产出（视频）', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.collectMedia({ id: 'a1', cookie: COOKIE_A }, 'conv-test-1', { kind: 'video', everyMs: 100, maxMs: 3000 });
  assert.equal(r.pending, false, 'mock 会话里有视频，不该 pending');
  assert.ok(r.media.some(m => m.kind === 'video'), JSON.stringify(r.media).slice(0, 120));
  assert.ok(r.polls >= 1, '应至少轮询一次');
});

await ok('collectMedia：要的类型没有就如实 pending（别把视频当文件返回）', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.collectMedia({ id: 'a1', cookie: COOKIE_A }, 'conv-test-1', { kind: 'file', everyMs: 100, maxMs: 400 });
  assert.equal(r.pending, true);
  assert.equal(r.media.filter(m => m.kind === 'file').length, 0);
});

await ok('collectMedia：没有会话号时不空转', async () => {
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.collectMedia({ id: 'a1', cookie: COOKIE_A }, '', { maxMs: 5000 });
  assert.equal(r.polls, 0);
  assert.equal(r.media.length, 0);
});

await ok('10020 file_block：Word/PDF 这类文件解析成带直链的可下载条目', async () => {
  const { pickBlocksMedia } = await import('../doubao.js');
  const media = pickBlocksMedia([{
    block_type: 10020,
    content: { file_block: {
      type: 'docx', name: '项目周报.docx',
      uri: 'tos-cn-i-x/y.docx',
      url: 'https://x.test/y.docx?sig=1\\u0026e=2',
      size: '40267',
    } },
  }], new Set());
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, 'file');
  assert.equal(media[0].url, 'https://x.test/y.docx?sig=1&e=2', '应还原 & 转义');
  assert.equal(media[0].direct, true, '带 url 的应标成可直下');
  assert.equal(media[0].name, '项目周报.docx');
  assert.equal(media[0].size, 40267);
});

await ok('generate()：文件在 SSE 里以 10020 到达时直接产出可下载条目', async () => {
  upstream.defaultBehavior = 'fileblock';
  const c = makeClient([acc('a1', COOKIE_A)]);
  const r = await c.generate('做个 Word 周报', { id: 'a1' });
  const f = r.media.find(m => m.kind === 'file');
  assert.ok(f, '应解析出文件：' + JSON.stringify(r.media));
  assert.equal(f.direct, true);
  assert.ok(/\.docx/.test(f.url), f.url);
});

server.close();
console.log('\n全部通过：' + passed + ' 项');

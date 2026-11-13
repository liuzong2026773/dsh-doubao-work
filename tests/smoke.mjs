/**
 * 离线冒烟测试：不需要重启 DSH，也不消耗豆包额度。
 *
 *   node tests/smoke.mjs
 *
 * 覆盖：插件导出契约、路由注册、/doubao/status 返回、会话复用闸门、额度估算格式。
 */
import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const mod = await import('../index.js');

console.log('插件契约');
ok('导出 name/apply/inject', () => {
  assert.equal(typeof mod.name, 'string');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组（对象写法会让 cordis 等 required/optional）');
  assert.ok(mod.inject.includes('llm'));
  assert.ok(!mod.inject.includes('webServer'), 'webServer 必须按可选获取，硬依赖会让插件一直 pending');
});

const routes = {};
let adapterProviders = null;
const webServer = { register: (r) => { routes[r.path] = r; return () => {}; } };
const ctx = {
  llm: { registerAdapter: (p) => { adapterProviders = p; } },
  get: (name) => (name === 'webServer' ? webServer : undefined),
  // 模拟 cordis：服务已就绪时立即回调，并直接执行 effect 体
  inject: (deps, cb) => cb({ webServer, effect: (fn) => { const d = fn(); return d; } }),
};

console.log('加载与注册');
ok('apply 不抛异常', () => mod.apply(ctx, { providerId: 'doubao-work', providerName: '测试', accounts: [] }));
ok('注册了 provider', () => assert.deepEqual(adapterProviders, ['doubao-work']));
ok('注册了 7 条路由（6 精确 + 1 /api 前缀）', () => assert.equal(Object.keys(routes).length, 7));
ok('拿不到 webServer 时降级不崩', () => {
  const noop = { llm: { registerAdapter() {} }, get: () => undefined };
  mod.apply(noop, { providerId: 'doubao-work', accounts: [] });
});

function call(path, body, opts = {}) {
  return new Promise((resolve) => {
    const res = {
      code: 0, buf: '',
      writeHead(c) { this.code = c; },
      end(b) { this.buf += String(b ?? ''); resolve({ code: this.code, body: this.buf }); },
    };
    const req = new EventEmitter();
    req.url = path;
    req.headers = { host: '127.0.0.1:56854', ...(opts.headers || {}) };
    const p = routes[path].handler(req, res);
    if (body !== undefined) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('end');
    if (p && p.catch) p.catch(e => resolve({ code: 500, body: 'ERR ' + e.message }));
  });
}

console.log('接口');
const st = await call('/doubao/status');
ok('/doubao/status 返回 200', () => assert.equal(st.code, 200));
const stJson = JSON.parse(st.body);
ok('status 含 models/summary/accounts', () => {
  assert.ok(Array.isArray(stJson.models));
  assert.ok(stJson.summary && typeof stJson.summary.accounts === 'number');
  assert.ok(Array.isArray(stJson.accounts));
});
ok('账号行含额度估算字段', () => {
  for (const a of stJson.accounts) {
    assert.equal(typeof a.todayReq, 'number');
    assert.equal(typeof a.quotaLeftEst, 'number');
  }
});

const viaApi = await call('/api/doubao', undefined);
ok('/api/doubao 前缀转发到 status', () => {
  assert.equal(viaApi.code, 200);
  assert.ok(JSON.parse(viaApi.body).models);
});

const addBad = await call('/doubao/account/add', { cookie: 'short' });
ok('短 Cookie 被拒绝（400）', () => assert.equal(addBad.code, 400));

const gating = await import('../doubao.js');
console.log('会话复用闸门');
ok('严格追加才复用', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 3, '上一轮回复');
  assert.equal(c.reusableConversation('k', 4, '上一轮回复'), 'cid');
  assert.equal(c.reusableConversation('k', 3, '上一轮回复'), null);
  assert.equal(c.reusableConversation('k', 5, '上一轮回复'), null);
  assert.equal(c.reusableConversation('unknown', 1, ''), null);
  assert.equal(c.reusableConversation('k', 4, '上一轮回复'), 'cid', '重复查询应保持不变');
});
ok('回复内容不一致则不复用（防串会话）', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 3, '上一轮回复');
  assert.equal(c.reusableConversation('k', 4, '被改写过的历史'), null);
});
ok('contextReuse=false 时永不复用', () => {
  const c = new gating.DoubaoClient({ accounts: [], contextReuse: false }, {});
  c.rememberConversation('k', 'cid', 1);
  assert.equal(c.reusableConversation('k', 2), null);
});

console.log('账号管理接口');
const COOKIE = 'sessionid=test1234567890abcdef; sid_guard=x; uid_tt=y';
const ACCOUNTS_JSON = fileURLToPath(new URL('../accounts.json', import.meta.url));
try { fs.unlinkSync(ACCOUNTS_JSON); } catch (e) { /* 不存在即可 */ }

const addOk = await call('/doubao/account/add', { id: 'acc-9', remark: '测试号', cookie: COOKIE });
ok('添加账号返回 id', () => {
  assert.equal(addOk.code, 200);
  assert.equal(JSON.parse(addOk.body).id, 'acc-9');
});
const addDup = await call('/doubao/account/add', { id: 'acc-9', cookie: COOKIE });
ok('重复 id 返回 409', () => assert.equal(addDup.code, 409));
const addBadId = await call('/doubao/account/add', { id: 'a/b', cookie: COOKIE });
ok('非法 id 返回 400', () => assert.equal(addBadId.code, 400));
const addBadJson = await call('/doubao/account/add', '{not json');
ok('非法 JSON 返回 400（不再 500）', () => assert.equal(addBadJson.code, 400));

const st2 = JSON.parse((await call('/doubao/status')).body);
ok('新账号出现在状态里且可用', () => {
  const a = st2.accounts.find(x => x.id === 'acc-9');
  assert.ok(a, 'acc-9 应出现在账号列表');
  assert.equal(a.status, '可用');
});

const upd = await call('/doubao/account/update', { id: 'acc-9', cookie: COOKIE.replace('test', 'live') });
ok('换 Cookie 成功', () => assert.equal(upd.code, 200));
const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts.find(a => a.id === 'acc-9');
ok('accounts.json 里 Cookie 已更新', () => assert.ok(stored.cookie.includes('live1234567890abcdef')));

const disable = await call('/doubao/account/enable', { id: 'acc-9', enabled: false });
ok('停用账号', () => assert.equal(disable.code, 200));
const st3 = JSON.parse((await call('/doubao/status')).body);
ok('停用账号仍在列表里、状态为已停用（否则面板点不回来）', () => {
  const a = st3.accounts.find(x => x.id === 'acc-9');
  assert.ok(a, '停用后必须仍可见');
  assert.equal(a.status, '已停用');
  assert.equal(a.enabled, false);
});

const crossOrigin = await call('/doubao/account/remove', { id: 'acc-9' }, { headers: { origin: 'http://evil.example' } });
ok('跨源请求被拒（403）', () => assert.equal(crossOrigin.code, 403));
const sameOrigin = await call('/doubao/account/remove', { id: 'acc-9' }, { headers: { origin: 'http://127.0.0.1:56854' } });
ok('同源请求放行', () => assert.equal(sameOrigin.code, 200));

console.log('配置面板账号的启停');
const ctx2 = {
  llm: { registerAdapter() {} },
  get: () => webServer,
  inject: (deps, cb) => cb({ webServer, effect: (fn) => fn() }),
};
mod.apply(ctx2, { providerId: 'doubao-work', accounts: [{ id: 'cfg-1', cookie: COOKIE, remark: '面板号' }] });
const cfgDisable = await call('/doubao/account/enable', { id: 'cfg-1', enabled: false });
ok('配置面板账号也能停用（写入覆盖记录）', () => assert.equal(cfgDisable.code, 200));
const cfgFile = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts.find(a => a.id === 'cfg-1');
ok('覆盖记录保留了原文 Cookie', () => {
  assert.equal(cfgFile.enabled, false);
  assert.equal(cfgFile.cookie, COOKIE);
});
const stCfg = JSON.parse((await call('/doubao/status')).body);
ok('面板账号停用后状态为已停用', () => {
  assert.equal(stCfg.accounts.find(a => a.id === 'cfg-1').status, '已停用');
});
try { fs.unlinkSync(ACCOUNTS_JSON); } catch (e) { /* ignore */ }

console.log('适配器错误码与流协议');
const { DoubaoLlmAdapter, ERROR_CODES } = mod;
const makeAdapter = (client, config = {}) => new DoubaoLlmAdapter({ client, config: { providerName: 'T', ...config }, log: () => {} });
const drain = async (gen) => { const out = []; for await (const c of gen) out.push(c); return out; };
const oneUser = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];

const expected = { auth: 'AUTH', ratelimit: 'RATE_LIMIT', quota: 'QUOTA', noaccount: 'NO_ADAPTER', network: 'TRANSPORT', timeout: 'TIMEOUT', empty: 'EMPTY_RESPONSE', aborted: 'ABORTED', upstream: 'SERVER' };
ok('DoubaoError.kind 全覆盖且映射到宿主错误码', () => {
  assert.deepEqual(ERROR_CODES, expected);
});

for (const kind of Object.keys(expected)) {
  const adapter = makeAdapter({
    models: () => [{ id: 'm1', name: 'M1', modelItemKey: 'k' }],
    reusableConversation: () => null,
    rememberConversation: () => {},
    async *chat() { const { DoubaoError } = gating; throw new DoubaoError(kind, 'x'); },
  });
  try {
    await drain(adapter.stream({ model: 'm1', messages: oneUser }));
    ok(`kind=${kind} 应抛错`, () => { throw new Error('未抛错'); });
  } catch (e) {
    ok(`kind=${kind} → ${expected[kind]}`, () => assert.equal(e.code, expected[kind]));
  }
}

ok('流式：block-start/delta/block-end/usage/finish 顺序与字段', async () => {
  const adapter = makeAdapter({
    models: () => [{ id: 'm1', name: 'M1', modelItemKey: 'k' }],
    reusableConversation: () => null,
    rememberConversation: () => {},
    async *chat() { yield '你'; yield '好'; return { text: '你好', conversationId: 'c1' }; },
  });
  const out = await drain(adapter.stream({ model: 'm1', messages: oneUser }));
  assert.deepEqual(out.map(c => c.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
  const usage = out.find(c => c.type === 'usage').usage;
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  assert.ok(usage.outputTokens >= 2, '中文应按宽字符估算，不能 2 字算 1 token');
  assert.deepEqual(out.at(-1).reason, { kind: 'stop' });
});

ok('流中断：finish 为 max-tokens 而不是 stop', async () => {
  const adapter = makeAdapter({
    models: () => [{ id: 'm1', name: 'M1', modelItemKey: 'k' }],
    reusableConversation: () => null,
    rememberConversation: () => {},
    async *chat() { yield '半'; return { text: '半', conversationId: 'c1', truncated: true }; },
  });
  const out = await drain(adapter.stream({ model: 'm1', messages: oneUser }));
  assert.deepEqual(out.at(-1).reason, { kind: 'max-tokens' });
});

ok('providerRetryPolicy 结构可被宿主接受', () => {
  const p = makeAdapter({}).providerRetryPolicy('doubao-work');
  assert.equal(p.mode, 'normal');
  assert.ok(Number.isInteger(p.maxRetries) && p.maxRetries >= 0);
  assert.ok(Array.isArray(p.retryableCodes) && !p.retryableCodes.includes('RATE_LIMIT'), 'RATE_LIMIT 不该让宿主立刻重试');
  assert.ok(p.backoff.initialDelayMs > 0 && p.backoff.maxDelayMs >= p.backoff.initialDelayMs);
});

console.log('\n全部通过：' + passed + ' 项');

/**
 * 离线冒烟测试：不需要重启 DSH，也不消耗豆包额度。
 *
 *   node tests/smoke.mjs
 *
 * 覆盖：插件导出契约、路由注册、/doubao/status 返回、会话复用闸门、额度估算格式。
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const mod = await import('../index.js');
// 1.2.5 起 Cookie 与用量状态写在数据目录（默认 <dshHome>/doubao-work）；
// 测试用临时目录，既不污染真实安装，也证明状态不再落在插件目录里。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-test-'));

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
ok('apply 不抛异常', () => mod.apply(ctx, { providerId: 'doubao-work', providerName: '测试', accounts: [], dataDir: DATA_DIR }));
ok('注册了 provider', () => assert.deepEqual(adapterProviders, ['doubao-work']));
ok('注册了预期路由集合（8 精确 + 1 /api 前缀）', () => {
  assert.deepEqual(Object.keys(routes).sort(), [
    '/api/doubao',
    '/doubao/account/add',
    '/doubao/account/enable',
    '/doubao/account/remove',
    '/doubao/account/update',
    '/doubao/check',
    '/doubao/checkin',
    '/doubao/checkin/status',
    '/doubao/status',
  ].sort());
});
ok('拿不到 webServer 时降级不崩', () => {
  const noop = { llm: { registerAdapter() {} }, get: () => undefined };
  mod.apply(noop, { providerId: 'doubao-work', accounts: [], dataDir: DATA_DIR });
});

/** 与宿主一致的派发：精确优先，否则取最长前缀 */
function findRoute(path) {
  const exact = routes[path];
  if (exact && exact.kind === 'exact') return exact;
  let best;
  for (const r of Object.values(routes)) {
    if (r.kind !== 'prefix') continue;
    if ((path === r.path || path.startsWith(r.path + '/')) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best || exact;
}

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
    // 1.2.2 起管理接口要求「同源或本机回环」，mock 必须带上 socket，否则一律 403
    req.socket = { remoteAddress: opts.remoteAddress || '127.0.0.1' };
    const route = findRoute(path);
    if (!route) return resolve({ code: 404, body: 'NO ROUTE ' + path });
    const p = route.handler(req, res);
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

console.log('会话复用规划 planReuse（1.2.3 的 P1：宿主重排消息后仍要复用）');
const mkMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const textOf = (m) => (m.content || []).map(b => b.text).join('');
ok('没记录过会话 → 不复用', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  assert.equal(c.planReuse('k', [mkMsg('user', '一')], ''), null);
});
ok('只补发上一轮回复之后的新消息（不把自己的回复当用户输入重发）', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 3, '回复2'); // 上一轮输入 3 条，回复是「回复2」
  const msgs = [mkMsg('user', '一'), mkMsg('assistant', '回复1'), mkMsg('user', '二'), mkMsg('assistant', '回复2'), mkMsg('user', '三')];
  const plan = c.planReuse('k', msgs, '回复2');
  assert.ok(plan, '条数增加应复用');
  assert.equal(plan.conversationId, 'cid');
  assert.deepEqual(msgs.slice(plan.fromIndex).map(x => x.role), ['user'], '尾部应只剩新那条 user');
  assert.equal(textOf(msgs[plan.fromIndex]), '三');
});
ok('宿主在头部重注入上下文块（下标漂移）时，仍只发最新一条', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  // 上一轮输入是 [system, u1, r1, u2] 共 4 条，回复「r2」
  c.rememberConversation('k', 'cid', 4, 'r2');
  // 本轮宿主又在最前面插了 system 与上下文块，整体下标右移
  const msgs = [mkMsg('system', 'S'), mkMsg('user', 'ctx'), mkMsg('user', 'u1'), mkMsg('assistant', 'r1'),
    mkMsg('user', 'u2'), mkMsg('assistant', 'r2'), mkMsg('user', 'u3')];
  const plan = c.planReuse('k', msgs, 'r2');
  assert.ok(plan, '回复哈希一致，应复用');
  assert.deepEqual(msgs.slice(plan.fromIndex).map(m => textOf(m)), ['u3'],
    '不能把 u2 / r2 再发一遍（上游会话里已经有了）');
});
ok('本轮新增多条消息时，从上一条回复之后整体补发', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 1, 'r1');
  const msgs = [mkMsg('user', 'u1'), mkMsg('assistant', 'r1'), mkMsg('user', 'u2'), mkMsg('user', 'u3')];
  const plan = c.planReuse('k', msgs, ''); // 倒数第二条不是 assistant，取不到上一轮回复
  assert.ok(plan);
  assert.deepEqual(msgs.slice(plan.fromIndex).map(m => textOf(m)), ['u2', 'u3'], 'r1 不应被重发');
});
ok('宿主重排导致条数跳变（+2 / +5）依然复用', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  for (const extra of [2, 5]) {
    c.rememberConversation('k', 'cid', 2, '回复1');
    const msgs = [mkMsg('user', '一'), mkMsg('assistant', '回复1')];
    for (let i = 0; i < extra; i++) msgs.push(mkMsg('user', '补' + i));
    const plan = c.planReuse('k', msgs, '回复1');
    assert.ok(plan, `条数跳变到 ${msgs.length} 时应复用`);
    assert.equal(msgs.slice(plan.fromIndex).length, 1, '只发最后一条新消息');
  }
});
ok('历史被压缩（条数回退）→ 不复用', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 6, '回复');
  assert.equal(c.planReuse('k', [mkMsg('user', '一')], '回复'), null);
});
ok('上一轮回复被改写 → 不复用（防串会话）', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 2, '原回复');
  const msgs = [mkMsg('user', '一'), mkMsg('assistant', '被改写过'), mkMsg('user', '二')];
  assert.equal(c.planReuse('k', msgs, '被改写过'), null);
});
ok('超过 conversationTtlSec → 不复用并回收条目', () => {
  const c = new gating.DoubaoClient({ accounts: [], conversationTtlSec: 60 }, {});
  c.convMap.set('k', { conversationId: 'cid', msgCount: 1, ts: Date.now() - 3600_000, replyHash: '' });
  assert.equal(c.planReuse('k', [mkMsg('user', '一'), mkMsg('user', '二')], ''), null);
  assert.equal(c.convMap.has('k'), false, '过期条目应被回收');
});
ok('contextReuse=false → planReuse 永不复用', () => {
  const c = new gating.DoubaoClient({ accounts: [], contextReuse: false }, {});
  c.rememberConversation('k', 'cid', 1, '回复');
  assert.equal(c.planReuse('k', [mkMsg('user', '一'), mkMsg('user', '二')], '回复'), null);
});

console.log('签到接口');
const ciAll = await call('/doubao/checkin', {});
ok('无账号时签到返回空汇总（200）', () => {
  assert.equal(ciAll.code, 200);
  const j = JSON.parse(ciAll.body);
  assert.deepEqual(j.summary, { total: 0, ok: 0, already: 0, skipped: 0, failed: 0 });
  assert.ok(Array.isArray(j.results));
});
const ciBadId = await call('/doubao/checkin', { id: 'a b' });
ok('签到非法 id → 400', () => assert.equal(ciBadId.code, 400));
const ciUnknown = await call('/doubao/checkin', { id: 'acc-none' });
ok('签到未知账号 → 404', () => assert.equal(ciUnknown.code, 404));
const ciNoBody = await call('/doubao/checkin', '{oops');
ok('签到非法 JSON → 400（不 500）', () => assert.equal(ciNoBody.code, 400));
const csNoId = await call('/doubao/checkin/status', {});
ok('签到状态缺 id → 400', () => assert.equal(csNoId.code, 400));
const csUnknown = await call('/doubao/checkin/status', { id: 'acc-none' });
ok('签到状态未知账号 → 404', () => assert.equal(csUnknown.code, 404));
const csCross = await call('/doubao/checkin/status', { id: 'acc-none' }, { headers: { origin: 'http://evil.example' } });
ok('签到状态跨源 → 403', () => assert.equal(csCross.code, 403));
const ciViaPrefix = await call('/api/doubao/checkin', {});
ok('/api/doubao/checkin 前缀可达', () => assert.equal(ciViaPrefix.code, 200));

console.log('账号管理接口');
const COOKIE = 'sessionid=test1234567890abcdef; sid_guard=x; uid_tt=y';
const ACCOUNTS_JSON = path.join(DATA_DIR, 'accounts.json');


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
mod.apply(ctx2, { providerId: 'doubao-work', accounts: [{ id: 'cfg-1', cookie: COOKIE, remark: '面板号' }], dataDir: DATA_DIR });
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
console.log('数据目录与宿主包解析');
const paths = await import('../paths.js');
const host = await import('../host.js');
ok('显式 dataDir 优先于 dshHome', () => {
  assert.equal(paths.resolveDataDir({ explicit: DATA_DIR, dshHome: '/tmp/whatever' }), DATA_DIR);
});
ok('没有显式目录时落在 <dshHome>/doubao-work', () => {
  const fakeHome = path.join(DATA_DIR, 'fake-home');
  assert.equal(paths.resolveDataDir({ dshHome: fakeHome }), path.join(fakeHome, 'doubao-work'));
});
ok('旧位置（插件目录）的 Cookie 文件会被复制过去，且保留原件', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-legacy-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-target-'));
  fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', cookie: 'old-cookie-value' }] }));
  const msgs = [];
  const r = paths.dataPaths({ explicit: target, legacyDir: legacy, onMigrate: m => msgs.push(m) });
  assert.equal(JSON.parse(fs.readFileSync(r.accountsPath, 'utf8')).accounts[0].cookie, 'old-cookie-value');
  assert.ok(fs.existsSync(path.join(legacy, 'accounts.json')), '迁移应保留原文件');
  assert.equal(msgs.length, 1);
  // 目标已有文件时不能被旧数据盖回去（升级后再迁移不能回滚 Cookie）
  fs.writeFileSync(r.accountsPath, JSON.stringify({ accounts: [{ id: 'a1', cookie: 'newer-cookie' }] }));
  paths.dataPaths({ explicit: target, legacyDir: legacy });
  assert.equal(JSON.parse(fs.readFileSync(r.accountsPath, 'utf8')).accounts[0].cookie, 'newer-cookie');
  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});
ok('Cookie 落在数据目录，不再写进插件目录', () => {
  assert.equal(fs.existsSync(fileURLToPath(new URL('../accounts.json', import.meta.url))), false,
    '插件目录里不该再有 accounts.json');
  assert.ok(fs.existsSync(ACCOUNTS_JSON), '面板写入应落在数据目录');
});
ok('兜底错误类把 code/failure 都写成自身数据属性（宿主按快照取码）', () => {
  const e = new host.LocalLlmError('上游限流', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 60000 });
  assert.equal(e.name, 'LlmError');
  assert.equal(e.code, 'RATE_LIMIT');
  assert.ok('value' in Object.getOwnPropertyDescriptor(e, 'code'), 'ownErrorCode 只认自身数据属性');
  assert.ok('value' in Object.getOwnPropertyDescriptor(e, 'failure'), 'ownFailureSnapshot 只认自身数据属性');
  // 宿主 normalizeLlmFailure 的条件是 carried.code === ownErrorCode(error)
  assert.equal(e.failure.code, e.code);
  assert.equal(e.failure.providerRetryAfterMs, 60000);
});
ok('宿主包解析来源可见', () => {
  assert.ok(['bare', 'install:', 'missing'].some(k => host.resolvedFrom['dsh-llm'].startsWith(k)), host.resolvedFrom['dsh-llm']);
  assert.ok(host.LlmError, '应有 LlmError（宿主那份或本地兜底）');
});
const rt = JSON.parse((await call('/doubao/status')).body);
ok('status 暴露解析来源与版本，便于线上排障', () => {
  assert.ok(rt.runtime && rt.runtime.host['dsh-llm'], '缺少 runtime 诊断字段');
  assert.match(rt.runtime.version, /^\d+\.\d+\.\d+$/);
});
ok('DEFAULTS 与 Config 默认值一致（防两处漂移）', () => {
  if (!mod.Config) return; // 解析不到 schemastery 时只有 DEFAULTS 生效
  const filled = mod.Config({});
  for (const [k, v] of Object.entries(mod.DEFAULTS)) {
    if (k === 'upstream') { assert.deepEqual(filled.upstream, v, 'upstream 默认值不一致'); continue; }
    assert.deepEqual(filled[k], v, `${k} 默认值不一致`);
  }
});

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
    planReuse: () => null,
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
    planReuse: () => null,
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
    planReuse: () => null,
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

ok('VERSION 与 package.json 一致', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(mod.VERSION, pkg.version);
});

console.log('\n全部通过：' + passed + ' 项');

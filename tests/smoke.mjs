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
ok('注册了预期路由集合（18 精确 + 1 /api 前缀）', () => {
  assert.deepEqual(Object.keys(routes).sort(), [
    '/api/doubao',
    '/doubao/account/add',
    '/doubao/account/enable',
    '/doubao/account/remove',
    '/doubao/account/update',
    '/doubao/accounts/export',
    '/doubao/accounts/import',
    '/doubao/browser/browsers',
    '/doubao/browser/close',
    '/doubao/browser/grab',
    '/doubao/browser/launch',
    '/doubao/check',
    '/doubao/checkin',
    '/doubao/checkin/open',
    '/doubao/checkin/status',
    '/doubao/generate',
    '/doubao/image/upload',
    '/doubao/mstoken',
    '/doubao/models/probe',
    '/doubao/browser/login',
    '/doubao/browser/wait',
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

// ---------------- 1.2.6：粘贴内容智能解析 ----------------
console.log('Cookie 粘贴解析');
const { parseCookieInput, describeParse } = await import('../cookie-input.js');
const RAW_COOKIE = 'sessionid=abcdefghijklmnop; sid_guard=qrstuvwxyz0123; uid_tt=456789';

ok('整段 Cookie 原样规范化', () => {
  const r = parseCookieInput(RAW_COOKIE);
  assert.equal(r.format, 'raw');
  assert.equal(r.cookie, RAW_COOKIE);
  assert.equal(r.pairs, 3);
  assert.deepEqual(r.warnings, []);
});

ok('带 Cookie: 头名的一行能剥掉头名', () => {
  const r = parseCookieInput('Cookie: ' + RAW_COOKIE);
  assert.equal(r.format, 'cookie-header');
  assert.equal(r.cookie, RAW_COOKIE);
});

ok('整页请求头里只取 cookie 头', () => {
  const r = parseCookieInput([
    'accept: */*',
    'cookie: ' + RAW_COOKIE,
    'user-agent: Mozilla/5.0',
    'content-type: application/json',
  ].join('\n'));
  assert.equal(r.format, 'headers');
  assert.equal(r.cookie, RAW_COOKIE);
});

ok('Copy as cURL：-H cookie 与续行都认', () => {
  const curl = [
    "curl 'https://www.doubao.com/api/v1/chat/completions' \\",
    "  -H 'accept: */*' \\",
    "  -H 'cookie: " + RAW_COOKIE + "' \\",
    "  --data-raw '{\"a\":1}'",
  ].join('\n');
  const r = parseCookieInput(curl);
  assert.equal(r.format, 'curl');
  assert.equal(r.cookie, RAW_COOKIE);
});

ok('Copy as cURL：双引号 -b 形式', () => {
  const r = parseCookieInput('curl https://www.doubao.com -b "' + RAW_COOKIE + '"');
  assert.equal(r.format, 'curl');
  assert.equal(r.cookie, RAW_COOKIE);
});

ok('cURL 里没有 cookie 头时给出可执行的提示', () => {
  const r = parseCookieInput("curl 'https://www.doubao.com' -H 'accept: */*'");
  assert.equal(r.pairs, 0);
  assert.ok(r.warnings.some(w => w.startsWith('curl_no_cookie')), r.warnings.join('|'));
});

ok('浏览器扩展导出的 JSON 数组', () => {
  const r = parseCookieInput(JSON.stringify([
    { name: 'sessionid', value: 'abcdefghijklmnop', domain: '.doubao.com' },
    { name: 'sid_guard', value: 'qrstuvwxyz0123' },
  ]));
  assert.equal(r.format, 'json');
  assert.equal(r.cookie, 'sessionid=abcdefghijklmnop; sid_guard=qrstuvwxyz0123');
});

ok('Netscape cookies.txt', () => {
  const r = parseCookieInput([
    '# Netscape HTTP Cookie File',
    '.doubao.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\tabcdefghijklmnop',
    '.doubao.com\tTRUE\t/\tTRUE\t1800000000\tsid_guard\tqrstuvwxyz0123',
  ].join('\n'));
  assert.equal(r.format, 'netscape');
  assert.equal(r.cookie, 'sessionid=abcdefghijklmnop; sid_guard=qrstuvwxyz0123');
});

ok('同名 Cookie 取最后一次', () => {
  const r = parseCookieInput('sessionid=old_value_a; sid_guard=qrstuvwxyz0123; sessionid=new_value_b');
  assert.match(r.cookie, /sessionid=new_value_b/);
  assert.ok(!/sessionid=old_value_a/.test(r.cookie));
  assert.ok(r.warnings.some(w => w.startsWith('dup_keys')));
});

ok('没有登录态字段时提示（不当成有效 Cookie）', () => {
  const r = parseCookieInput('ttwid=abc123def456ghi789; web_id=123');
  assert.ok(r.warnings.some(w => w.startsWith('not_logged_in')), r.warnings.join('|'));
});

ok('非 Cookie 文本不会当成 Cookie', () => {
  const r = parseCookieInput('这是一段随便粘进来的中文说明文字');
  assert.equal(r.pairs, 0);
  assert.ok(r.warnings.some(w => w.startsWith('no_pair')));
});

ok('describeParse 用人话概括识别结果', () => {
  assert.match(describeParse(parseCookieInput('curl x -H "cookie: sessionid=aaaaaaaaaaaa; sid_guard=bbbbbbbbbbbb"')), /cURL 命令.*2 个字段/);
});

console.log('Cookie 解析接入管理接口');
const CURL_PASTE = [
  "curl 'https://www.doubao.com/alice/get_chat' \\",
  "  -H 'accept: */*' \\",
  "  -H 'cookie: " + RAW_COOKIE + "'",
].join('\n');
const addCurl = await call('/doubao/account/add', { id: 'acc-curl', remark: 'cURL 粘的', cookie: CURL_PASTE });
ok('粘 cURL 也能添加成功并回报解析结果', () => {
  assert.equal(addCurl.code, 200);
  const b = JSON.parse(addCurl.body);
  assert.equal(b.parse.format, 'curl');
  assert.equal(b.parse.pairs, 3);
});
const curlStored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts.find(a => a.id === 'acc-curl');
ok('入库的是规范化后的 Cookie', () => assert.equal(curlStored.cookie, RAW_COOKIE));

const addJunk = await call('/doubao/account/add', { id: 'acc-junk', cookie: '随便粘的一句话' });
ok('粘错内容返回 400 并带原因', () => {
  assert.equal(addJunk.code, 400);
  assert.ok(JSON.parse(addJunk.body).warnings.length > 0);
});

const updCurl = await call('/doubao/account/update', {
  id: 'acc-curl',
  cookie: "curl x -H 'cookie: sessionid=zzzzzzzzzzzzzzz; sid_guard=yyyyyyyyyyyyyyyy'",
});
ok('换 Cookie 也走同一套解析', () => {
  assert.equal(updCurl.code, 200);
  assert.equal(JSON.parse(updCurl.body).parse.format, 'curl');
});
const updStored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts.find(a => a.id === 'acc-curl');
ok('换后的 Cookie 已规范化入库', () => assert.equal(updStored.cookie, 'sessionid=zzzzzzzzzzzzzzz; sid_guard=yyyyyyyyyyyyyyyy'));

await call('/doubao/account/remove', { id: 'acc-curl' });

const stPath = JSON.parse((await call('/doubao/status')).body);
ok('status 暴露数据目录与账号文件路径（面板空态要用）', () => {
  assert.equal(path.resolve(stPath.dataDir), path.resolve(DATA_DIR));
  assert.ok(String(stPath.accountsPath).endsWith('accounts.json'), stPath.accountsPath);
});

// ---------------- 1.4.0：每日自动签到（时刻计算） ----------------
console.log('每日自动签到');
ok('parseClock 只认 HH:MM', () => {
  assert.deepEqual(mod.parseClock('09:30'), { h: 9, m: 30 });
  assert.deepEqual(mod.parseClock(' 23:05 '), { h: 23, m: 5 });
  assert.equal(mod.parseClock('24:00'), null, '小时超界');
  assert.equal(mod.parseClock('9:70'), null, '分钟超界');
  assert.equal(mod.parseClock('9点'), null);
  assert.equal(mod.parseClock(''), null);
});

ok('msUntilNextClock：当天未到算今天，已过算明天', () => {
  const at = (h, m) => { const d = new Date(2026, 10, 13, h, m, 0, 0); return d.getTime(); };
  assert.equal(mod.msUntilNextClock('09:30', at(9, 0)), 30 * 60 * 1000);
  assert.equal(mod.msUntilNextClock('09:30', at(10, 0)), 23.5 * 3600 * 1000);
  assert.equal(mod.msUntilNextClock('09:30', at(9, 30)), 24 * 3600 * 1000, '正好到点算明天，避免刚跑完又跑');
  assert.equal(mod.msUntilNextClock('乱写'), null);
});

ok('clockPassedToday：冷启动补跑判定', () => {
  const at = (h, m) => new Date(2026, 10, 13, h, m, 0, 0).getTime();
  assert.equal(mod.clockPassedToday('09:30', at(9, 29)), false);
  assert.equal(mod.clockPassedToday('09:30', at(9, 30)), true);
  assert.equal(mod.clockPassedToday('09:30', at(23, 59)), true);
  assert.equal(mod.clockPassedToday('', at(12, 0)), false);
});

const stBody = JSON.parse((await call('/doubao/status', {})).body);
ok('status 暴露签到排定状态（未配置时为空）', () => {
  assert.equal(stBody.checkinSchedule, '', '测试配置没开自动签到');
  assert.equal(stBody.checkinNextAt, 0);
});

// ---------------- 1.4.0：账号包导出 / 导入（手机同步） ----------------
console.log('账号包导出 / 导入');
await call('/doubao/account/add', { id: 'acc-pack', remark: '账号包用', cookie: COOKIE });
const exp = await call('/doubao/accounts/export', {});
const expJson = JSON.parse(exp.body);
ok('export 给出计数与可直接落包的账号包文本', () => {
  assert.equal(exp.code, 200);
  assert.ok(expJson.count >= 1);
  const parsed = JSON.parse(expJson.json);
  assert.ok(Array.isArray(parsed.accounts), 'json 字段要能直接写进 accounts.json');
  const a = parsed.accounts.find(x => x.id === 'acc-pack');
  assert.ok(a && /sessionid=/.test(a.cookie));
  assert.equal(a.remark, '账号包用');
});

await call('/doubao/account/remove', { id: 'acc-pack' });
const PACK = JSON.stringify({ accounts: [{ id: 'acc-pack', remark: '账号包用', cookie: COOKIE, enabled: true }] });
const imp = await call('/doubao/accounts/import', { text: PACK });
ok('import 账号包：按 id 合并回来', () => {
  const b = JSON.parse(imp.body);
  assert.equal(imp.code, 200);
  assert.equal(b.added, 1, imp.body);
  assert.equal(b.updated, 0, imp.body);
  const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts;
  assert.ok(stored.some(a => a.id === 'acc-pack' && /sessionid=test/.test(a.cookie)));
});

const impAgain = await call('/doubao/accounts/import', { text: PACK });
ok('重复导入幂等（更新，不重复建号）', () => {
  const b = JSON.parse(impAgain.body);
  assert.equal(b.added, 0, impAgain.body);
  assert.equal(b.updated, 1, impAgain.body);
  const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts;
  assert.equal(stored.filter(a => a.id === 'acc-pack').length, 1);
});

const impPaste = await call('/doubao/accounts/import', { text: 'Cookie: sessionid=ccccddddeeee1234; sid_guard=z' });
ok('也接受直接粘一段 Cookie（自动分配 id）', () => {
  const b = JSON.parse(impPaste.body);
  assert.equal(b.added, 1);
  const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts;
  const nu = stored.find(a => /sessionid=ccccddddeeee1234/.test(a.cookie));
  assert.ok(nu && nu.id, '应自动分配 id');
});

const impJunk = await call('/doubao/accounts/import', { text: '这是一段中文说明，没有 Cookie' });
ok('垃圾文本返回 400 并说明原因', () => {
  assert.equal(impJunk.code, 400);
  assert.match(JSON.parse(impJunk.body).error, /账号包|Cookie/);
});

const impEmpty = await call('/doubao/accounts/import', { text: '' });
ok('空 text 返回 400', () => assert.equal(impEmpty.code, 400));

const impReplace = await call('/doubao/accounts/import', { text: PACK, mode: 'replace' });
ok('mode=replace 整表替换（迁移时清掉旧账号）', () => {
  const b = JSON.parse(impReplace.body);
  assert.equal(b.mode, 'replace');
  assert.equal(b.total, 1, impReplace.body);
  const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts;
  assert.equal(stored.some(a => /sessionid=ccccddddeeee1234/.test(a.cookie)), false, 'replace 后本机粘的账号应被清掉');
});

await call('/doubao/account/remove', { id: 'acc-pack' });

// ---------------- 1.3.0：从浏览器导入（CDP） ----------------
console.log('从浏览器导入（CDP）');
const browserMod = await import('../browser.js');
const http = await import('node:http');

// 假 CDP 服务：只实现 /json/version（探测端口用），WebSocket 用注入的假 socket
let fakeCookies = [];
let wsSendSeen = [];
const cdp = http.createServer((req, res) => {
  if (req.url.startsWith('/json/version')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'FakeEdge/999', webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.address().port}/devtools/browser/fake` }));
    return;
  }
  if (req.url.startsWith('/json/list')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', url: 'https://www.doubao.com/chat/', webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.address().port}/devtools/page/fake` }]));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise(r => cdp.listen(0, '127.0.0.1', r));
const cdpPort = cdp.address().port;

function fakeSocket() {
  const listeners = {};
  return {
    addEventListener: (t, fn) => {
      (listeners[t] = listeners[t] || []).push(fn);
      // 真实 WebSocket 连上后才派发 open；假实现必须补这一拍，否则调用方永远不发指令
      if (t === 'open') queueMicrotask(() => fn());
    },
    send: (raw) => {
      const msg = JSON.parse(raw);
      wsSendSeen.push(msg);
      // 下一拍回消息，模拟真实 CDP 的异步应答
      queueMicrotask(() => (listeners.message || []).forEach(fn => fn({ data: JSON.stringify({ id: msg.id, result: { cookies: fakeCookies } }) })));
    },
    close: () => {},
  };
}

const fakeSpawnCalls = [];
browserMod.injectable.existsSync = (p) => /msedge\.exe$/.test(p);
browserMod.injectable.findFreePort = async () => cdpPort;
browserMod.injectable.spawnImpl = (cmd, args) => { fakeSpawnCalls.push({ cmd, args }); return { pid: 999999, unref() {} }; };
browserMod.injectable.killImpl = async (pid) => { fakeSpawnCalls.push({ killed: pid }); };
browserMod.injectable.createSocket = () => fakeSocket();

const dupCookies = [
  { name: 'sessionid', value: 'aaaabbbbccccdddd', domain: '.doubao.com', path: '/', httpOnly: true },
  { name: 'sid_guard', value: 'eeeeffff00001111', domain: '.doubao.com', path: '/', httpOnly: true },
  { name: 'ttwid', value: 'shared', domain: '.doubao.com', path: '/', httpOnly: false },
  { name: 'ttwid', value: 'path-specific', domain: '.doubao.com', path: '/alice', httpOnly: false },
  { name: 's_v_web_id', value: 'notours', domain: '.example.com', path: '/', httpOnly: false },
];
const header = browserMod.cookiesToHeader(dupCookies);
ok('cookiesToHeader：只留豆包域、同名去重、按 path 长度排序', () => {
  assert.equal(header.keys.includes('s_v_web_id'), false, '别的域不该进来');
  assert.equal(header.keys.filter(k => k === 'ttwid').length, 1, '同名只留一个');
  assert.match(header.cookie, /ttwid=path-specific/, 'path 更具体的应胜出');
  assert.deepEqual(header.httpOnly.sort(), ['sessionid', 'sid_guard']);
});

const browsers = await call('/doubao/browser/browsers', {});
ok('browser/browsers 探测到可用浏览器', () => {
  assert.equal(browsers.code, 200);
  const b = JSON.parse(browsers.body);
  assert.equal(b.browsers.length, 1);
  assert.equal(b.browsers[0].id, 'edge');
});

const launch = await call('/doubao/browser/launch', {});
const launchJson = JSON.parse(launch.body);
ok('browser/launch 用独立临时 profile + 调试端口（不碰日常浏览器）', () => {
  assert.equal(launch.code, 200);
  assert.equal(launchJson.port, cdpPort);
  const args = fakeSpawnCalls[0].args.join(' ');
  assert.match(args, new RegExp(`--remote-debugging-port=${cdpPort}`));
  assert.match(args, /--user-data-dir=/);
  assert.match(args, /dsh-doubao-cdp-/, '必须是独立 user-data-dir（Chrome 136+ 才对默认目录禁用调试端口）');
  assert.match(args, /doubao\.com/);
});

fakeCookies = dupCookies;
const grab = await call('/doubao/browser/grab', { port: cdpPort });
const grabJson = JSON.parse(grab.body);
ok('browser/grab 抓到登录态并入库', () => {
  assert.equal(grab.code, 200, grab.body);
  assert.equal(grabJson.ok, true);
  assert.equal(grabJson.httpOnly, 2, 'HttpOnly 的 sessionid/sid_guard 必须抓到');
  assert.ok(grabJson.id, '应自动创建账号');
  const stored = JSON.parse(fs.readFileSync(ACCOUNTS_JSON, 'utf8')).accounts.find(a => a.id === grabJson.id);
  assert.match(stored.cookie, /sessionid=aaaabbbbccccdddd/);
  assert.ok(!/s_v_web_id/.test(stored.cookie), '别的域不能入库');
  assert.deepEqual(wsSendSeen.map(m => m.method), ['Storage.getCookies'], '只发只读指令');
});

const grabAgain = await call('/doubao/browser/grab', { port: cdpPort });
ok('同一 Cookie 再抓一次不会重复建号', () => {
  const b = JSON.parse(grabAgain.body);
  assert.equal(b.ok, true);
  assert.equal(b.id, grabJson.id);
  assert.equal(b.existing, true);
});

fakeCookies = [{ name: 'ttwid', value: 'x', domain: '.doubao.com', path: '/' }];
const grabNoLogin = await call('/doubao/browser/grab', { port: cdpPort });
ok('没登录时明确告诉用户去登录，而不是塞个坏账号', () => {
  const b = JSON.parse(grabNoLogin.body);
  assert.equal(b.ok, false);
  assert.equal(b.stage, 'login');
  assert.match(b.reason, /sessionid/);
});

const grabNoPort = await call('/doubao/browser/grab', { port: 1 });
ok('端口没开时说明原因（而不是 500 堆栈）', () => {
  const b = JSON.parse(grabNoPort.body);
  assert.equal(b.ok, false);
  assert.equal(b.stage, 'probe');
});

await assert.rejects(
  () => browserMod.grabAllCookies('ws://10.0.0.5:9222/devtools/browser/x', { createSocket: () => fakeSocket() }),
  /拒绝连接非本机/,
);
ok('拒绝连接非本机调试端口（防止把 Cookie 发到局域网/公网）', () => {});

const launched = JSON.parse(launch.body);
fs.mkdirSync(launched.profileDir, { recursive: true });
const closed = await call('/doubao/browser/close', {});
ok('browser/close 关进程并清理临时 profile', () => {
  const b = JSON.parse(closed.body);
  assert.equal(b.ok, true);
  assert.equal(fs.existsSync(launched.profileDir), false, '临时 profile 应被删除');
  assert.ok(fakeSpawnCalls.some(c => c.killed === 999999), '应结束拉起的进程');
});

const osMod = await import('node:os');
const staleDir = path.join(osMod.tmpdir(), 'dsh-doubao-cdp-sweeptest');
const freshDir = path.join(osMod.tmpdir(), 'dsh-doubao-cdp-sweeptest-fresh');
fs.mkdirSync(staleDir, { recursive: true });
fs.mkdirSync(freshDir, { recursive: true });
const past = new Date(Date.now() - 7 * 3600 * 1000);
fs.utimesSync(staleDir, past, past);
browserMod.sweepStaleProfiles(osMod.tmpdir());
ok('launch 前清掉 6 小时前的残留临时 profile（不动新开的）', () => {
  assert.equal(fs.existsSync(staleDir), false, '过期目录应清掉');
  assert.equal(fs.existsSync(freshDir), true, '新目录不能动');
});
fs.rmSync(freshDir, { recursive: true, force: true });

// ---------------- 1.4.0：model_item_key 抓取（补齐模型用） ----------------
console.log('model_item_key 抓取');
ok('extractModelItemKey 从两种位置取值，格式不对返回 null', () => {
  const a = JSON.stringify({ option: { conversation_init_ext: { model_item_key: 'k-from-init' } } });
  const b = JSON.stringify({ option: { model_config: { model_item_key: 'k-from-config' } } });
  assert.equal(browserMod.extractModelItemKey(a), 'k-from-init');
  assert.equal(browserMod.extractModelItemKey(b), 'k-from-config');
  assert.equal(browserMod.extractModelItemKey('{"option":{}}'), null);
  assert.equal(browserMod.extractModelItemKey('不是 JSON'), null);
  assert.equal(browserMod.extractModelItemKey(''), null);
});

const captureSeen = [];
const captureSent = [];
let captureResult = null;
{
  const recv = [];
  const emit = (obj) => { for (const f of recv) f({ data: JSON.stringify(obj) }); };
  const reqOf = (key) => ({
    method: 'Network.requestWillBeSent',
    params: { request: { url: 'https://www.doubao.com/chat/completion?aid=497858', postData: JSON.stringify({ option: { model_config: { model_item_key: key } } }) } },
  });
  const netSocket = {
    addEventListener: (type, fn) => {
      if (type === 'message') recv.push(fn);
      if (type === 'open') queueMicrotask(() => fn()); // 连上就派发 open，和真 WebSocket 一致
    },
    send: (raw) => { const msg = JSON.parse(raw); captureSent.push(msg.method); if (msg.method === 'Network.enable') queueMicrotask(() => emit({ id: msg.id, result: {} })); },
    close: () => {},
  };
  captureResult = await browserMod.captureModelKeys(
    {
      port: cdpPort,
      timeoutMs: 3000,
      stopAfter: 2,
      onOpen: () => {
        emit(reqOf('K1'));
        emit({ method: 'Network.requestWillBeSent', params: { request: { url: 'https://www.doubao.com/other', postData: '{}' } } });
        emit({ method: 'Network.requestWillBeSent', params: { request: { url: 'https://www.doubao.com/chat/completion', postData: '坏 JSON' } } });
        emit(reqOf('K2'));
        emit(reqOf('K3')); // stopAfter=2 之后不该再收
      },
      onKey: (item) => captureSeen.push(item.key),
    },
    { createSocket: () => netSocket },
  );
}
ok('captureModelKeys 只认 chat/completion 里的 model_item_key，够了就停', () => {
  assert.ok(captureResult, '应当返回结果');
  assert.deepEqual(captureSeen, ['K1', 'K2'], '非 completion 路径与坏 JSON 不该进来，stopAfter 后不该继续');
  assert.deepEqual([...new Set(captureSent)], ['Network.enable'], '只开网络观察域，不发别的指令');
});

ok('groupCookiesByDomain 区分豆包域与其他域（排障用）', () => {
  const r = browserMod.groupCookiesByDomain([
    { name: 'sessionid', value: 'x', domain: '.doubao.com' },
    { name: 'ttwid', value: 'y', domain: 'doubao.com' },
    { name: 'SID', value: 'z', domain: '.google.com' },
  ]);
  assert.equal(r.doubao.length, 2);
  assert.deepEqual(r.otherDomains, ['google.com']);
});

// ---------------- 登录助手 + 自动导入 ----------------
console.log('登录助手');
{
  const origCreate = browserMod.injectable.createSocket;
  const form = {
    url: 'https://www.doubao.com/chat/',
    inputs: [{ type: 'tel', ph: '请输入手机号', val: '13800138000', maxlength: 11, x: 10, y: 10 }],
    loginBtn: { x: 1, y: 2, text: '登录' },
    sendBtn: { x: 3, y: 4, text: '发送验证码' },
    submitBtn: { x: 5, y: 6, text: '登录' },
    text: '请输入手机号 发送验证码 登录',
  };
  const sent = [];
  browserMod.injectable.createSocket = () => {
    const listeners = {};
    return {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); if (t === 'open') queueMicrotask(() => fn()); },
      send: (raw) => {
        const msg = JSON.parse(raw);
        sent.push(msg.method);
        let result = {};
        if (msg.method === 'Runtime.evaluate') result = { result: { value: form } };
        else if (msg.method === 'Storage.getCookies') result = { cookies: [] }; // 还没登录：空 Cookie
        queueMicrotask(() => (listeners.message || []).forEach(fn => fn({ data: JSON.stringify({ id: msg.id, result }) })));
      },
      close: () => {},
    };
  };

  const probeRes = await call('/doubao/browser/login', { action: 'probe', port: cdpPort });
  const probeBody = JSON.parse(probeRes.body);
  ok('browser/login probe：回表单形状、不回填进去的手机号', () => {
    assert.equal(probeRes.code, 200);
    assert.equal(probeBody.stage, 'form');
    assert.equal(probeBody.form.inputs, 1);
    assert.equal(probeBody.form.hasSendButton, true);
    assert.equal(JSON.stringify(probeBody).includes('13800138000'), false, '手机号不能回传前端');
  });

  const phoneRes = await call('/doubao/browser/login', { action: 'phone', phone: '13800138000', port: cdpPort });
  const phoneBody = JSON.parse(phoneRes.body);
  ok('browser/login phone：填入手机号并点「发送验证码」', () => {
    assert.equal(phoneBody.stage, 'sent', JSON.stringify(phoneBody));
    assert.ok(phoneBody.steps.some(t => /已点击「发送验证码」/.test(t)), '步骤里要有发送动作');
    assert.ok(sent.includes('Input.insertText'), '要用 Input.insertText 填字');
    assert.ok(sent.includes('Input.dispatchMouseEvent'), '要用真实鼠标事件点击');
  });

  const waitRes = await call('/doubao/browser/wait', {});
  const waitBody = JSON.parse(waitRes.body);
  ok('browser/wait：发码后进入自动导入等待（还没登录就不算导入）', () => {
    assert.equal(waitBody.state, 'watching');
    assert.equal(waitBody.imported, false);
    assert.equal(waitBody.account, '');
  });

  const badRes = await call('/doubao/browser/login', { action: 'code', code: '12', port: cdpPort });
  ok('browser/login code：验证码太短直接拒绝', () => {
    assert.equal(JSON.parse(badRes.body).stage, 'bad-code');
  });

  const closeRes = await call('/doubao/browser/close', {});
  ok('browser/close：关窗口时停掉自动导入轮询', () => {
    assert.equal(closeRes.code, 200);
  });
  const after = JSON.parse((await call('/doubao/browser/wait', {})).body);
  ok('关闭后自动导入状态不再是 watching', () => assert.notEqual(after.state, 'watching'));

  // 登录成功后自动导入：把假 CDP 的 Cookie 换成带登录态的，等轮询把账号收进来
  browserMod.injectable.createSocket = () => {
    const listeners = {};
    return {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); if (t === 'open') queueMicrotask(() => fn()); },
      send: (raw) => {
        const msg = JSON.parse(raw);
        let result = {};
        if (msg.method === 'Runtime.evaluate') result = { result: { value: form } };
        else if (msg.method === 'Storage.getCookies') {
          result = { cookies: [
            { name: 'sessionid', value: 'logged-in-session', domain: '.doubao.com', path: '/', httpOnly: true },
            { name: 'sid_guard', value: 'guard-value', domain: '.doubao.com', path: '/', httpOnly: true },
            { name: 'ttwid', value: 'tt', domain: '.doubao.com', path: '/', httpOnly: false },
          ] };
        }
        queueMicrotask(() => (listeners.message || []).forEach(fn => fn({ data: JSON.stringify({ id: msg.id, result }) })));
      },
      close: () => {},
    };
  };
  await call('/doubao/browser/login', { action: 'phone', phone: '13900139000', port: cdpPort });
  await new Promise(r => setTimeout(r, 2600)); // 自动导入每 2.5s 检查一次
  const imported = JSON.parse((await call('/doubao/browser/wait', {})).body);
  ok('登录检测到登录态后自动导入账号（不用再点抓取）', () => {
    assert.equal(imported.state, 'done', JSON.stringify(imported));
    assert.equal(imported.imported, true);
    assert.ok(imported.account, '应回报导入的账号 id');
    assert.match(imported.reason, /已导入账号/);
  });
  const stAfter = JSON.parse((await call('/doubao/status')).body);
  ok('自动导入的账号真的进了账号池', () => {
    assert.ok(stAfter.accounts.some(a => a.id === imported.account), JSON.stringify(stAfter.accounts.map(a => a.id)));
  });

  browserMod.injectable.createSocket = origCreate;
}

cdp.close();
for (const k of Object.keys(browserMod.injectable)) browserMod.injectable[k] = null;

ok('系统提示词默认不透传（豆包看不到本地工具说明）', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
  const t = mod.messagesToText({ system: 'You are an AI agent powered by deepseek-v4.1-flash\n工具说明……', messages: msgs });
  assert.equal(t, '你好');
  const t2 = mod.messagesToText({ system: 'SYS-MARK', sendSystemPrompt: true, messages: msgs });
  assert.ok(t2.includes('SYS-MARK'), '显式开启时应透传');
});
ok('多轮时 system 也不会混进对话记录', () => {
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'SYS-MARK' }] },
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    { role: 'user', content: [{ type: 'text', text: '第二句' }] },
  ];
  const t = mod.messagesToText({ messages: msgs });
  assert.ok(!t.includes('SYS-MARK'), t);
  assert.match(t, /第一句/);
});

await ok('模型选择三件套：need_deep_think / model_extra_params / agent_task_param', async () => {
  const { DoubaoClient } = await import('../doubao.js');
  const client = new DoubaoClient({ accounts: [] }, {});
  const spec = client.resolveModelSpec('deepseek-v4.1-flash');
  assert.equal(spec.itemId, 10001, ' 4.1 flash 的 item_id 必须是 10001（网页版 need_deep_think）');
  const body = client._buildBody('hi', spec, '');
  const o = body.option;
  assert.equal(o.need_deep_think, 10001, '模型靠 need_deep_think 切换，漏了就落回默认模型');
  assert.equal(o.conversation_mode, 2);
  assert.equal(o.agent_mode, 1);
  assert.equal(o.conversation_init_ext.mode_id, '3');
  assert.equal(o.conversation_init_ext.model_item_key, 'person-deepseek-v4-1-flash-261017');
  const atp = JSON.parse(o.conversation_init_ext.agent_task_param);
  assert.equal(atp.runtime_type, 1, '工作模式必须带 agent_task_param');
  assert.equal(o.model_config.model_extra_params.memory_profile, '300k_230');
  assert.equal(client.resolveModelSpec('doubao-2.1-lite').itemId, 0);
});

ok('extractImageParts：认得 base64 / url / image_url 三种写法', async () => {
  const parts = mod.extractImageParts([
    { type: 'text', text: '看这张' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image', url: 'https://x.test/a.jpg' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
  ]);
  assert.equal(parts.length, 3, JSON.stringify(parts));
  assert.equal(parts[0].data, 'AAAA');
  assert.equal(parts[1].url, 'https://x.test/a.jpg');
  assert.equal(parts[2].url, 'data:image/png;base64,BBBB');
});

ok('uploadImagesForRequest：imageInput=off 时明确告知没发图，而不是假装发了', async () => {
  const r = await mod.uploadImagesForRequest([{ data: 'AA' }], {
    config: { imageInput: 'off' }, log: () => {}, dataDir: DATA_DIR,
  });
  assert.equal(r.images.length, 0);
  assert.ok(/没发给豆包/.test(r.note), r.note);
});

ok('uploadImagesForRequest：客户端不在调试端口时给出原因 + 提醒 note', async () => {
  const r = await mod.uploadImagesForRequest([{ url: 'C:/tmp/不存在.png' }], {
    config: { imageInput: 'auto', debugPort: 1, imageUploadWaitMs: 1000 }, log: () => {}, dataDir: DATA_DIR,
  });
  assert.equal(r.images.length, 0);
  assert.ok(/没能传给豆包/.test(r.note), '应有提示：' + r.note);
});
ok('pickBlocksMedia：直链文件（10020）与产物卡片（10030）两类都认', async () => {
  const { pickBlocksMedia } = await import('../doubao.js');
  const seen = new Set();
  const a = pickBlocksMedia([{ block_type: 10020, content: { file_block: {
    name: 'a.docx', url: 'https://x.test/a.docx', type: 'docx', size: '1',
  } } }], seen);
  const b = pickBlocksMedia([{ block_type: 10030, content: { artifact_block: {
    resource_id: 'r1', conversation_id: 'c1', title: 'PPT', status: 2,
  } } }], seen);
  assert.equal(a[0].direct, true, '10020 有 url，应 direct');
  assert.ok(b[0].url.includes('/chat/c1'), '10030 没有直链，给打开对话的入口');
});

console.log('\n全部通过：' + passed + ' 项');

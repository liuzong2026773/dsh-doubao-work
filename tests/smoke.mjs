/**
 * 离线冒烟测试：不需要重启 DSH，也不消耗豆包额度。
 *
 *   node tests/smoke.mjs
 *
 * 覆盖：插件导出契约、路由注册、/doubao/status 返回、会话复用闸门、额度估算格式。
 */
import { EventEmitter } from 'node:events';
import assert from 'node:assert';

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
};

console.log('加载与注册');
ok('apply 不抛异常', () => mod.apply(ctx, { providerId: 'doubao-work', providerName: '测试', accounts: [] }));
ok('注册了 provider', () => assert.deepEqual(adapterProviders, ['doubao-work']));
ok('注册了 5 条路由', () => assert.equal(Object.keys(routes).length, 5));
ok('拿不到 webServer 时降级不崩', () => {
  const noop = { llm: { registerAdapter() {} }, get: () => undefined };
  mod.apply(noop, { providerId: 'doubao-work', accounts: [] });
});

function call(path, body) {
  return new Promise((resolve) => {
    const res = {
      code: 0, buf: '',
      writeHead(c) { this.code = c; },
      end(b) { this.buf += String(b ?? ''); resolve({ code: this.code, body: this.buf }); },
    };
    const req = new EventEmitter();
    const p = routes[path].handler(req, res);
    if (body !== undefined) req.emit('data', JSON.stringify(body));
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

const addBad = await call('/doubao/account/add', { cookie: 'short' });
ok('短 Cookie 被拒绝（400）', () => assert.equal(addBad.code, 400));

const gating = await import('../doubao.js');
console.log('会话复用闸门');
ok('严格追加才复用', () => {
  const c = new gating.DoubaoClient({ accounts: [] }, {});
  c.rememberConversation('k', 'cid', 3);
  assert.equal(c.reusableConversation('k', 4), 'cid');
  assert.equal(c.reusableConversation('k', 3), null);
  assert.equal(c.reusableConversation('k', 5), null);
  assert.equal(c.reusableConversation('unknown', 1), null);
  assert.equal(c.reusableConversation('k', 4), 'cid', '重复查询应保持不变');
});
ok('contextReuse=false 时永不复用', () => {
  const c = new gating.DoubaoClient({ accounts: [], contextReuse: false }, {});
  c.rememberConversation('k', 'cid', 1);
  assert.equal(c.reusableConversation('k', 2), null);
});

console.log('\n全部通过：' + passed + ' 项');

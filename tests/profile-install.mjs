/**
 * 安装形态自测：模拟「插件装在 profile 的 node_modules 里」——那种目录旁边没有
 * `@deepseek-ai/*`，插件内部裸导入必须能自己回到宿主安装目录取包。
 *
 * 这不是普通 `node` 能跑的：宿主包在 `app.asar` 里，只有 Electron 的 fs 补丁能读。
 * 所以用 Electron 的 node 模式运行：
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *   DSH_HOST_MODULES="E:/deepseek/resources/app.asar/dsh/node_modules" \
 *   "E:/deepseek/DeepSeek Harness.exe" tests/profile-install.mjs
 *
 * 只装了普通 node 的环境会打印跳过说明并返回 0。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

let failed = 0;
const ok = (title, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('用 await ok() 跑异步断言');
    console.log(`  ✓ ${title}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✗ ${title}\n     ${e.message.split('\n').slice(0, 3).join('\n     ')}`);
  }
};
const okAsync = async (title, fn) => {
  try { await fn(); console.log(`  ✓ ${title}`); }
  catch (e) { failed += 1; console.log(`  ✗ ${title}\n     ${e.message.split('\n').slice(0, 3).join('\n     ')}`); }
};

if (!process.versions.electron) {
  console.log('\n跳过：需要 Electron 的 node 模式（宿主包在 app.asar 内，普通 node 读不到）。');
  console.log('  ELECTRON_RUN_AS_NODE=1 DSH_HOST_MODULES="<安装目录>/app.asar/dsh/node_modules" \\');
  console.log('  "<安装目录>/DeepSeek Harness.exe" tests/profile-install.mjs\n');
  process.exit(0);
}

const hostModules = String(process.env.DSH_HOST_MODULES || '').trim();
if (!hostModules) {
  console.log('\n跳过：未设置 DSH_HOST_MODULES（宿主包所在 node_modules 目录）。\n');
  process.exit(0);
}

// 1) 复制成「profile 安装」形态：独立目录，且不带 node_modules
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doubao-install-'));
const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(f => f && !f.startsWith('tests/') && f !== '.gitignore');
for (const f of files) {
  const dst = path.join(tmp, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, f), dst);
}
assert.equal(fs.existsSync(path.join(tmp, 'node_modules')), false);

console.log('\n模拟 profile 安装（无 node_modules）');
const mod = await import(pathToFileURL(path.join(tmp, 'index.js')).href);
const host = await import(pathToFileURL(path.join(tmp, 'host.js')).href);

await okAsync('从安装目录解析到宿主包（不是 ERR_MODULE_NOT_FOUND）', () => {
  assert.match(host.resolvedFrom['dsh-llm'], /^install:/, `实际：${host.resolvedFrom['dsh-llm']}`);
  assert.match(host.resolvedFrom.schemastery, /^install:/, `实际：${host.resolvedFrom.schemastery}`);
});
await okAsync('拿到的是宿主同一份 LlmError 实例（错误码才不会退化成 UNKNOWN）', async () => {
  const real = await import(pathToFileURL(path.join(hostModules, '@deepseek-ai/dsh-llm/lib/index.js')).href);
  assert.equal(host.LlmError, real.LlmError, 'LlmError 不是宿主同一个类');
});
ok('导出契约完整（name/inject/Config/apply）', () => {
  assert.equal(mod.name, 'dsh-doubao-work');
  assert.deepEqual(mod.inject, ['llm']);
  assert.equal(typeof mod.apply, 'function');
  assert.ok(mod.Config, 'Config 应能在宿主环境下导出');
});
ok('Config 的默认值与 DEFAULTS 一致（防止两处漂移）', () => {
  const filled = mod.Config({});
  for (const [k, v] of Object.entries(mod.DEFAULTS)) {
    if (k === 'upstream') { assert.deepEqual(filled.upstream, v, 'upstream 默认值不一致'); continue; }
    assert.deepEqual(filled[k], v, `${k} 默认值不一致`);
  }
});
await okAsync('apply 能注册 provider 并挂上状态接口', async () => {
  const routes = {};
  const ctx = {
    llm: { registerAdapter: (p) => { registerAdapterArgs = p; } },
    get: (n) => (n === 'webServer' ? { register: (r) => { routes[r.path] = r; return () => {}; } } : undefined),
    inject: (d, cb) => cb({ webServer: { register: (r) => { routes[r.path] = r; return () => {}; } }, effect: (fn) => fn() }),
    logger: { info() {}, warn() {}, error() {} },
  };
  let registerAdapterArgs = null;
  mod.apply(ctx, { accounts: [] });
  assert.deepEqual(registerAdapterArgs, ['doubao-work']);
  assert.ok(routes['/doubao/status'], '状态接口未注册');
});
ok('兜底错误类的 failure 快照带 code（宿主 normalizeLlmFailure 会采用）', () => {
  const e = new host.LocalLlmError('boom', 'RATE_LIMIT', { status: 429 });
  assert.equal(e.code, 'RATE_LIMIT');
  assert.equal(e.failure.code, 'RATE_LIMIT');
  assert.equal(e.failure.status, 429);
  const d = Object.getOwnPropertyDescriptor(e, 'code');
  assert.ok(d && 'value' in d, 'code 必须是自身数据属性');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

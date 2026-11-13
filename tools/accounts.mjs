#!/usr/bin/env node
/**
 * accounts.json 管理（替代手改文件）
 *
 *   node tools/accounts.mjs list
 *   node tools/accounts.mjs add --id acc-2 --remark 小号 --cookie-file /tmp/cookie.txt
 *   node tools/accounts.mjs add --id acc-2 --remark 小号            # 从 stdin 读 Cookie
 *   node tools/accounts.mjs enable  --id acc-2
 *   node tools/accounts.mjs disable --id acc-2
 *   node tools/accounts.mjs remove  --id acc-2
 *   node tools/accounts.mjs export --out /tmp/accounts-backup.json
 *   node tools/accounts.mjs import --in  /tmp/accounts-backup.json
 *
 * 插件对 accounts.json 是热加载的，改完立即生效，无需重启 DSH。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(dir, 'accounts.json');

function load() {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const d = JSON.parse(raw);
    return { accounts: Array.isArray(d) ? d : (d.accounts || []) };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { accounts: [] };
  }
}

function save(data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};

const data = load();

if (cmd === 'list') {
  if (!data.accounts.length) { console.log('（空）' + file); process.exit(0); }
  for (const a of data.accounts) {
    const cookie = typeof a.cookie === 'string' ? a.cookie.length : 0;
    console.log([a.id, a.enabled === false ? '停用' : '启用', (a.remark || '').padEnd(10), 'cookie ' + cookie + ' 字符'].join('  '));
  }
} else if (cmd === 'add') {
  const id = opt('id', 'acc-' + (data.accounts.length + 1));
  if (data.accounts.some(a => a.id === id)) { console.error('id 已存在: ' + id); process.exit(1); }
  let cookie = '';
  const cf = opt('cookie-file');
  if (cf) cookie = fs.readFileSync(cf, 'utf8').trim();
  else cookie = fs.readFileSync(0, 'utf8').trim();
  if (cookie.length < 20) { console.error('Cookie 太短，疑似无效'); process.exit(1); }
  data.accounts.push({ id, remark: opt('remark', ''), cookie, enabled: true });
  save(data);
  console.log('已添加 ' + id + '（cookie ' + cookie.length + ' 字符）');
} else if (cmd === 'enable' || cmd === 'disable' || cmd === 'remove') {
  const id = opt('id');
  const i = data.accounts.findIndex(a => a.id === id);
  if (i < 0) { console.error('找不到 id: ' + id); process.exit(1); }
  if (cmd === 'remove') data.accounts.splice(i, 1);
  else data.accounts[i].enabled = cmd === 'enable';
  save(data);
  console.log('已' + ({ enable: '启用', disable: '停用', remove: '删除' }[cmd]) + ' ' + id);
} else if (cmd === 'export') {
  const out = opt('out', path.join(dir, 'accounts-backup.json'));
  fs.writeFileSync(out, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log('已导出到 ' + out + '（含 Cookie，注意保管）');
} else if (cmd === 'import') {
  const src = opt('in');
  if (!src) { console.error('用法: import --in <文件>'); process.exit(1); }
  const incoming = JSON.parse(fs.readFileSync(src, 'utf8'));
  const list = Array.isArray(incoming) ? incoming : (incoming.accounts || []);
  let added = 0, replaced = 0;
  for (const a of list) {
    if (!a || typeof a.cookie !== 'string') continue;
    const i = data.accounts.findIndex(x => x.id === a.id);
    if (i >= 0) { data.accounts[i] = { ...data.accounts[i], ...a }; replaced++; }
    else { data.accounts.push(a); added++; }
  }
  save(data);
  console.log('导入完成：新增 ' + added + '，覆盖 ' + replaced);
} else {
  console.error('未知命令: ' + cmd);
  process.exit(1);
}

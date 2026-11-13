#!/usr/bin/env node
/**
 * 账号状态小工具（无需启动 DSH，也不需要面板）
 *
 *   node tools/status.mjs            # 账号池状态（冷却/累计用量/最近错误）
 *   node tools/status.mjs --check    # 额外校验每个账号 Cookie 是否还有效
 *   node tools/status.mjs --quota    # 额外查询每个账号的订阅额度
 *
 * 数据来源：插件目录下的 accounts.json（与插件热加载同一个文件）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DoubaoClient } from '../doubao.js';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const accountsPath = path.join(dir, 'accounts.json');

let accounts = [];
try {
  const raw = fs.readFileSync(accountsPath, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  accounts = (Array.isArray(data) ? data : data.accounts || []).filter(a => a && a.cookie);
} catch (e) {
  if (e.code !== 'ENOENT') console.error('accounts.json 解析失败: ' + e.message);
}

const client = new DoubaoClient({ accounts }, {
  statePath: path.join(dir, 'gateway-state.json'),
  accountsPath,
  log: () => {},
});

const args = new Set(process.argv.slice(2));

function table(rows) {
  const cols = Object.keys(rows[0] || {});
  if (!cols.length) return '(空)';
  const width = c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length));
  const line = c => String(c).padEnd(width(c));
  return [cols.map(line).join('  '), cols.map(c => '-'.repeat(width(c))).join('  ')]
    .concat(rows.map(r => cols.map(c => line(r[c])).join('  ')))
    .join('\n');
}

if (accounts.length === 0) {
  console.log('没有账号：' + accountsPath + ' 不存在或没有可用 cookie。');
  process.exit(0);
}

console.log('账号池（' + accounts.length + ' 个）\n');
console.log(table(client.snapshot()));

if (args.has('--check')) {
  console.log('\nCookie 健康检查中…');
  const res = await client.checkAll();
  console.log(table(res.map(r => ({ id: r.id, 备注: r.remark, 有效: r.ok ? '是' : '否', HTTP: r.http ?? '-', 错误: r.error ?? '' }))));
}

if (args.has('--quota')) {
  console.log('\n订阅额度查询中…');
  const rows = [];
  for (const a of client._accounts()) {
    try {
      const q = await client.getQuota(a);
      const txt = JSON.stringify(q).slice(0, 160);
      rows.push({ id: a.id, 返回: txt });
    } catch (e) {
      rows.push({ id: a.id, 返回: '失败: ' + e.message });
    }
  }
  console.log(table(rows));
}

client.flushState();

#!/usr/bin/env node
/**
 * 账号联调探针（读 accounts.json，不需要启动 DSH）
 *
 *   node tools/probe.mjs          # 只做只读检查：Cookie 健康 + 额度
 *   node tools/probe.mjs --chat   # 额外发 1 条测试消息（消耗少量额度）
 *
 * 输出里不会打印 Cookie 本体。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DoubaoClient } from '../doubao.js';
import { dataPaths } from '../paths.js';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const paths = dataPaths({ legacyDir: dir });
const accountsPath = paths.accountsPath;
const args = new Set(process.argv.slice(2));

function loadAccounts() {
  try {
    const raw = fs.readFileSync(accountsPath, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return (Array.isArray(data) ? data : data.accounts || []).filter(a => a && a.cookie);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

const accounts = loadAccounts();
if (!accounts.length) {
  console.log('accounts.json 里没有可用账号：' + accountsPath);
  process.exit(1);
}

const client = new DoubaoClient({ accounts }, { statePath: paths.statePath, log: () => {} });
const acc = accounts[0];
console.log('账号: ' + acc.id + ' (' + (acc.remark || '无备注') + ')  cookie 长度=' + acc.cookie.trim().length);

// 1) Cookie 健康
const health = await client.checkAll();
console.log('健康检查: ' + JSON.stringify(health[0]));

// 2) 额度快照
try {
  const q = await client.getQuota(acc);
  console.log('额度快照: ' + JSON.stringify(q).slice(0, 600));
} catch (e) {
  console.log('额度查询失败: ' + e.message);
}

// 3) 可选：发一条测试消息，重点看有没有重复文本
if (args.has('--chat')) {
  for (const model of ['deepseek-v4.1-flash', 'doubao-2.1-lite']) {
    let out = '';
    const t0 = Date.now();
    try {
      for await (const d of client.chat(model, '请只回复四个字：测试通过', undefined)) out += d;
      const ms = Date.now() - t0;
      // 重复检测：把输出按句读切段，看是否出现连续重复段
      const segs = out.split(/(?<=[。！？!?\n])/).filter(Boolean);
      let dup = false;
      for (let i = 1; i < segs.length; i++) if (segs[i] === segs[i - 1]) dup = true;
      console.log('--- ' + model + ' ---');
      console.log('  耗时: ' + ms + 'ms  字数: ' + out.length);
      console.log('  输出: ' + JSON.stringify(out.slice(0, 200)));
      console.log('  连续重复段: ' + (dup ? '有（SSE 事件重复累加，需修）' : '无'));
    } catch (e) {
      console.log('--- ' + model + ' --- 失败: ' + (e.kind || '') + ' ' + e.message);
    }
  }
  const q2 = await client.getQuota(acc).catch(() => null);
  if (q2) console.log('额度快照(测试后): ' + JSON.stringify(q2).slice(0, 600));
}

client.flushState();

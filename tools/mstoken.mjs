#!/usr/bin/env node
/**
 * msToken 管理：豆包「客户端身份」的凭证
 *
 *   node tools/mstoken.mjs --show              # 看当前缓存与生效身份
 *   node tools/mstoken.mjs --harvest           # 从本机豆包客户端（9222）被动摘一个
 *   node tools/mstoken.mjs --set <token>       # 手工粘贴（从抓包里复制 msToken= 后面那串）
 *   node tools/mstoken.mjs --harvest --port 9222 --wait 30000
 *
 * 为什么要它：网页身份（aid=497858）的请求一旦被判定可疑就回 710022004（要人机验证），
 * 客户端身份（aid=582478 + msToken + SamanthaDoubao UA）不受影响。msToken 由豆包的
 * webmssdk 现算，自己编的会 710022002，所以只能借：
 *   1. 用 tools/start-doubao-debug.cmd 启动豆包（带 --remote-debugging-port=9222）
 *   2. 在豆包里随便点两下（切会话/点开输入框都会发带 msToken 的请求）
 *   3. 跑 --harvest，摘到就写进 <数据目录>/mstoken.json，插件重启或下次请求即生效
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMsToken, writeMsToken, harvestMsToken } from '../mstoken.js';

const dir = process.env.DSH_DOUBAO_DATA_DIR || path.join(os.homedir(), '.dsh', 'doubao-work');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return '';
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : '1';
};

if (flag('set')) {
  const token = flag('set');
  writeMsToken(dir, token, 'manual');
  console.log('已写入缓存：' + token.slice(0, 16) + '…（' + token.length + ' 字符）→ ' + path.join(dir, 'mstoken.json'));
} else if (argv.includes('--harvest')) {
  console.log('正在从豆包客户端摘 msToken（端口 ' + (flag('port') || '9222') + '）…');
  const r = await harvestMsToken({ port: flag('port') || 9222, waitMs: Number(flag('wait')) || 20000 });
  if (!r.token) {
    console.log('失败：' + (r.reason || '没摘到'));
    console.log('提示：确认豆包是用 tools/start-doubao-debug.cmd 启动的，且在豆包里点一下任意对话再重试。');
    process.exit(1);
  }
  writeMsToken(dir, r.token, r.source);
  console.log('摘到：' + r.token.slice(0, 16) + '…（' + r.token.length + ' 字符）来源 ' + r.source);
}

const c = readMsToken(dir);
if (!c.token) {
  console.log('\n当前状态：无缓存（插件走网页身份 aid=497858）');
} else {
  const age = Math.round((Date.now() - c.at) / 60000);
  console.log(`\n当前状态：已缓存 ${c.token.slice(0, 16)}…（${c.token.length} 字符，${age} 分钟前，来源 ${c.source || '未知'}）`);
  console.log('文件：' + path.join(dir, 'mstoken.json') + (fs.existsSync(path.join(dir, 'mstoken.json')) ? '' : '（不存在？）'));
}

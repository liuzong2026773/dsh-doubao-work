#!/usr/bin/env node
/**
 * 生成：图片 / 视频 / 文件（PPT、Word、PDF、表格）
 *
 *   node tools/generate.mjs --prompt "画一只戴墨镜的柴犬，扁平插画"
 *   node tools/generate.mjs --kind image --prompt "..." --save cat.png
 *   node tools/generate.mjs --kind file --prompt "做一份 3 页 PPT，主题 2026 计划" --save plan.pptx
 *   node tools/generate.mjs --id acc-2 --prompt "..."
 *
 * 走的是豆包普通对话（实测生图/出文件都在普通对话里完成，不必切工作模式）。
 * 有 msToken 时自动用客户端身份；没有就用网页身份（更容易被风控挡）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DoubaoClient } from '../doubao.js';
import { readMsToken } from '../mstoken.js';

const dir = process.env.DSH_DOUBAO_DATA_DIR || path.join(os.homedir(), '.dsh', 'doubao-work');
const argv = process.argv.slice(2);
const opt = (name, dflt = '') => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '1';
};

const prompt = opt('prompt');
if (!prompt) {
  console.log('用法：node tools/generate.mjs --prompt "要生成什么" [--kind image|video|file] [--save 文件名] [--id 账号]');
  process.exit(1);
}
const kind = opt('kind', 'any');
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).accounts;
const client = new DoubaoClient({ accounts }, { log: () => {} });
const token = readMsToken(dir).token;
if (token) client.setMsToken(token);
console.log('身份：' + (client.clientTransport ? '客户端（aid=582478）' : '网页（无 msToken，可能被风控）'));

const started = Date.now();
// 视频是两轮 + 异步出片：走 generateVideo（提需求 → 确认 → 轮询会话等 mp4）
const r = kind === 'video'
  ? await client.generateVideo(prompt, { id: opt('id'), maxWaitMs: Number(opt('max-wait', '0')) || 420000, pollMs: Number(opt('poll', '0')) || 15000 })
  : await client.generate(prompt, { id: opt('id') });
console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s｜账号 ${r.account}`);
console.log('会话:', r.conversationId || '(无)');
// 文件类产出在流结束后才落进会话：没拿到就再等一会儿
if (!r.media.length && r.conversationId && kind !== 'video') {
  console.log('本轮 SSE 没有产出，回收会话消息中（最多 ' + (Number(opt('wait', '120000')) / 1000) + 's）…');
  const got = await client.collectMedia(client._pickAccount(opt('id')), r.conversationId, {
    kind: kind === 'any' ? '' : kind,
    everyMs: 8000,
    maxMs: Number(opt('wait', '120000')) || 120000,
  });
  if (got.media.length) console.log('回收成功（第 ' + got.polls + ' 次）');
  r.media = got.media;
}
console.log('文本：' + (r.text || '（空）').slice(0, 400));
const picked = r.media.filter(m => kind === 'any' || m.kind === kind);
if (!r.media.length) console.log('\n媒体：无（上游只回了文字——可能额度不足、或它判断这不该生成）');
else console.log('\n媒体：' + JSON.stringify(r.media.map(m => m.kind + ' ' + m.url.slice(0, 100)), null, 1));

const save = opt('save');
if (save && picked.length) {
  const res = await fetch(picked[0].url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.resolve(save), buf);
  console.log(`\n已存 ${path.resolve(save)}（${(buf.length / 1024).toFixed(0)}KB，HTTP ${res.status} ${res.headers.get('content-type')}）`);
}

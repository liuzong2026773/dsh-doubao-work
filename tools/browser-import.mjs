#!/usr/bin/env node
/**
 * 从浏览器一键导入豆包 Cookie（CDP 方案，跨平台、不读浏览器隐私库）
 *
 *   node tools/browser-import.mjs                       # 自动探测浏览器，开窗口，等登录，入库
 *   node tools/browser-import.mjs --browser edge        # 指定浏览器（edge / chrome / 可执行文件路径）
 *   node tools/browser-import.mjs --wait 300 --id acc-2 --remark 小号
 *   node tools/browser-import.mjs --no-save             # 只抓不改账号文件（调试用）
 *   node tools/browser-import.mjs --port 9222 --attach   # 连你自己开着的调试端口，不新开窗口
 *
 * 原理：用 --remote-debugging-port + 独立临时 user-data-dir 打开浏览器，让它自己带着登录态，
 * 再走 CDP 的 Storage.getCookies 只读指令取 .doubao.com 的 Cookie（含 HttpOnly 的 sessionid）。
 * 只连 127.0.0.1；只发这一条只读指令；日志不打印 Cookie 本体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, grabDoubao, closeBrowser } from '../browser.js';
import { dataPaths, ACCOUNTS_FILE } from '../paths.js';

const argv = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flag = (name) => argv.includes('--' + name);

const port = Number(opt('port', 0)) || 0;
const waitSec = Number(opt('wait', 180));
const id = String(opt('id', '') || '');
const remark = String(opt('remark', '') || '');
const attach = flag('attach');

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const paths = dataPaths({ legacyDir: pluginDir });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function appendAccount(cookie) {
  let data = { accounts: [] };
  try { data = JSON.parse(fs.readFileSync(paths.accountsPath, 'utf8')); } catch { /* 首次写入 */ }
  if (!Array.isArray(data.accounts)) data.accounts = [];
  const find = id ? data.accounts.find(a => a.id === id) : data.accounts.find(a => a.cookie === cookie);
  if (find) { find.cookie = cookie; find.enabled = true; if (remark) find.remark = remark; }
  else {
    let n = data.accounts.length + 1;
    let newId = id || `acc-${n}`;
    while (!id && data.accounts.some(a => a.id === newId)) newId = `acc-${++n}`;
    data.accounts.push({ id: newId, remark, cookie, enabled: true });
  }
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.accountsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(paths.accountsPath, 0o600); } catch { /* Windows 上不生效 */ }
  return data;
}

let handle = null;
const cleanup = async (code) => {
  if (handle && !flag('keep')) await closeBrowser(handle);
  process.exit(code);
};

try {
  if (attach) {
    if (!port) { console.error('--attach 需要同时给 --port（例如 --port 9222）'); process.exit(1); }
    handle = { port };
    console.log(`连已开着的调试端口 127.0.0.1:${port}（不会新开窗口）`);
  } else {
    const browserArg = opt('browser', '');
    handle = await launchBrowser({
      browserId: browserArg && !browserArg.includes('/') && !browserArg.includes('\\') ? browserArg : '',
      browserPath: browserArg && (browserArg.includes('/') || browserArg.includes('\\')) ? browserArg : '',
      port,
    });
    console.log(`已打开 ${handle.browser.name}（调试端口 ${handle.port}，临时配置 ${handle.profileDir}）`);
    console.log('请在这个窗口里登录豆包；登录完成后不用关窗口，脚本会自动抓取。');
  }

  const deadline = Date.now() + waitSec * 1000;
  const startedAt = Date.now();
  let result = null;
  let lastReason = '';
  while (Date.now() < deadline) {
    result = await grabDoubao({ port: handle.port });
    if (result.ok) break;
    // 浏览器刚启动那几秒端口还没起来，属正常，别拿它吓用户
    const warmingUp = result.stage === 'probe' && Date.now() - startedAt < 12000;
    if (!warmingUp && result.reason !== lastReason) { console.log('… ' + result.reason); lastReason = result.reason; }
    await sleep(2000);
  }
  if (!result || !result.ok) {
    console.error(`\n✗ ${waitSec}s 内没抓到登录态。可在窗口里登录后重跑，或改用粘贴方式。`);
    await cleanup(1);
  }

  console.log(`\n✓ 抓到 ${result.doubaoCookies} 个豆包 Cookie（HttpOnly ${result.httpOnly.length} 个：${result.httpOnly.join(', ')}）`);
  if (flag('no-save')) {
    console.log('（--no-save：没有写入账号文件）');
  } else {
    appendAccount(result.cookie);
    const data = JSON.parse(fs.readFileSync(paths.accountsPath, 'utf8'));
    console.log(`✓ 已写入 ${paths.accountsPath}，当前共 ${data.accounts.length} 个账号（Cookie 不打印）`);
  }
  await cleanup(0);
} catch (e) {
  console.error('✗ ' + (e.message || e));
  await cleanup(1);
}

#!/usr/bin/env node
/**
 * model_item_key 抓取与验证（补齐 8 个模型用）
 *
 * 1) 抓：让浏览器替你「点菜单」
 *      node tools/model-probe.mjs --capture            # 自动开临时窗口（未登录会提示先登录）
 *      node tools/model-probe.mjs --capture --port 9222 --attach
 *    然后在网页里：欢迎页选「工作」→ 左下角选一个模型（如 豆包 2.1 Pro）→ 随便发一句话。
 *    每抓到一个 key 就打印一行，Ctrl+C 结束。keys 会写进 <数据目录>/model-keys.json。
 *
 * 2) 验：key 是否真的被服务端接受（最省额度的验证方式）
 *      node tools/model-probe.mjs --key person-deepseek-v4-1-flash-261017
 *      node tools/model-probe.mjs --key xxx --id acc-2
 *    判据是 SSE_ACK 里服务端回写的 model_item_key（回写 == 传入才算生效），不是模型自认知。
 *
 * 3) 列：当前已配置的模型与 key 对照
 *      node tools/model-probe.mjs --list
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launchBrowser, closeBrowser, captureModelKeys, probeDebugPort } from '../browser.js';
import { DoubaoClient, BUILTIN_MODELS } from '../doubao.js';
import { withDefaults } from '../index.js';
import { dataPaths } from '../paths.js';

const argv = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flag = (name) => argv.includes('--' + name);

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const paths = dataPaths({ legacyDir: pluginDir });
const keysFile = path.join(paths.dir, 'model-keys.json');

/** 还没抓到的 8 个模型（2026-11-13 抓包时的菜单名） */
const MISSING = [
  { name: '豆包 2.1 Pro', ratio: '0.65x' },
  { name: 'Kimi K3.1 Pro', ratio: '0.95x' },
  { name: 'Kimi K3.1 Pro 高速', ratio: '1.44x' },
  { name: 'Kimi K3', ratio: '1.48x' },
  { name: 'GLM 5.3', ratio: '0.80x' },
  { name: 'GLM 5.3 Flash', ratio: '0.08x' },
  { name: 'DeepSeek V4 Pro', ratio: '0.46x' },
];

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(keysFile, 'utf8')); } catch { return { keys: [] }; }
}
function saveKeys(data) {
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(keysFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function listMode() {
  console.log('已内置（extraModels 之外）：');
  for (const m of BUILTIN_MODELS) console.log(`  ${m.id.padEnd(24)} ${String(m.modelItemKey).padEnd(34)} ${m.name}`);
  const saved = loadKeys();
  if (saved.keys?.length) {
    console.log('\n已抓到（model-keys.json）：');
    for (const k of saved.keys) console.log(`  ${k.key.padEnd(34)} ${k.label || '（没标名字）'}  ${new Date(k.at).toLocaleString('zh-CN')}`);
  } else {
    console.log('\n（model-keys.json 还没有抓到的 key）');
  }
  console.log('\n还没抓到的菜单项：');
  for (const m of MISSING) console.log(`  ${m.name}  ${m.ratio}`);
  console.log('\n抓法见文件头注释；抓到后用 --key <key> 验证，验证过再写进插件配置 extraModels。');
}

async function verifyMode() {
  const key = String(opt('key', '') || '');
  const id = String(opt('id', '') || '');
  const client = new DoubaoClient(withDefaults({ accounts: readAccounts(), providerId: 'doubao-work' }), {
    statePath: path.join(paths.dir, 'gateway-state.json'),
    accountsPath: paths.accountsPath,
    log: () => {},
  });
  const list = client.allAccounts().filter(a => a.enabled !== false);
  const account = id ? list.find(a => a.id === id) : list[0];
  if (!account) { console.error('没有可用账号：先在面板「从浏览器导入」或粘贴一个 Cookie'); process.exit(1); }
  console.log(`用账号 ${account.id} 验证 ${key}（发一句「嗨」，读 SSE_ACK 回写）…`);
  const r = await client.probeModelKey(account, key);
  if (r.ok) console.log(`✓ 生效：服务端回写 ${r.echoed}`);
  else console.error(`✗ 未生效：回写=${r.echoed || '（无）'}${r.error ? '，错误：' + r.error : ''}`);
  process.exit(r.ok ? 0 : 1);
}

function readAccounts() {
  try {
    const d = JSON.parse(fs.readFileSync(paths.accountsPath, 'utf8'));
    return Array.isArray(d) ? d : (d.accounts || []);
  } catch { return []; }
}

async function captureMode() {
  const attach = flag('attach');
  const port = Number(opt('port', 0)) || 9222;
  let handle = null;
  if (!attach) {
    handle = await launchBrowser({ port: port || undefined });
    console.log(`已打开 ${handle.browser.name}（调试端口 ${handle.port}）。请登录豆包，进到聊天页。`);
  } else {
    const p = await probeDebugPort(port);
    if (!p.ok) { console.error(`127.0.0.1:${port} 没有响应（${p.reason}）`); process.exit(1); }
    console.log(`连已开着的调试端口 127.0.0.1:${port}`);
  }
  const usePort = handle ? handle.port : port;
  console.log('现在在网页里：欢迎页选「工作」→ 左下角选一个模型 → 随便发一句话。每抓到一个 key 打印一行。');
  console.log('按 Ctrl+C 结束（keys 已实时写盘）。\n');

  const data = loadKeys();
  const known = new Set((data.keys || []).map(k => k.key));
  try {
    await captureModelKeys({
      port: usePort,
      timeoutMs: 30 * 60 * 1000,
      onKey: (item) => {
        const dup = known.has(item.key);
        console.log(`${dup ? '（重复）' : '新 key'}  ${item.key}  ${new Date(item.at).toLocaleTimeString('zh-CN')}`);
        if (!dup) {
          known.add(item.key);
          (data.keys = data.keys || []).push({ key: item.key, label: '', at: item.at });
          saveKeys(data);
        }
      },
    });
  } catch (e) {
    console.error('✗ ' + (e.message || e));
  } finally {
    if (handle && !flag('keep')) await closeBrowser(handle);
  }
  console.log('\n下一步：给每个 key 标上菜单名（编辑 ' + keysFile + ' 的 label 字段），');
  console.log('再用 --key 验证；验证过的写进插件配置 extraModels（面板设置里加 JSON 数组即可）。');
}

const cmd = flag('list') ? 'list' : flag('capture') ? 'capture' : opt('key') ? 'verify' : 'list';
if (cmd === 'list') await listMode();
else if (cmd === 'verify') await verifyMode();
else await captureMode();

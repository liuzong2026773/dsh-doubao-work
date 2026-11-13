#!/usr/bin/env node
/**
 * doubao-gateway —— 豆包工作 → OpenAI 兼容网关（独立进程版）
 *
 * 1.4.0 起**复用插件的 `doubao.js`**：账号池、RPM 限速、并发排队、冷却分级（429/403 长冷却、
 * 5xx 短冷却、Cookie 失效标记）、SSE 解析、流中断保护、conversation_id 复用，全部只有一份实现。
 * 本文件只做 OpenAI 协议适配 + HTTP 服务 + 状态页。
 *
 * 端点：
 *   POST /v1/chat/completions   OpenAI 兼容（stream / 非 stream）
 *   GET  /v1/models
 *   GET  /status                简易状态页（账号池 + 最近日志）
 *   GET  /health
 *   POST /admin/check           手动健康检查（逐个账号验登录态）
 *
 * 配置：同目录 config.json（可选）+ accounts.json（必需）
 *   { "port": 3040, "apiKey": "", "models": { "deepseek-v4.1-flash": "person-deepseek-v4-1-flash-261017" },
 *     "strategy": "round-robin", "rpmPerAccount": 6, "globalMaxConcurrency": 2,
 *     "coolSeconds": 86400, "shortCoolSeconds": 300, "queueWaitMs": 30000,
 *     "requestTimeoutMs": 180000, "maxAttempts": 2, "reasoningEffort": 0,
 *     "contextReuse": true, "baseUrl": "" }
 *   models 省略时用插件内置的两个 0.01x 模型；只允许这里列出的模型（未列出返回 400）。
 *
 * 启动：node standalone/index.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DoubaoClient, DoubaoError, BUILTIN_MODELS, conversationKey } from '../doubao.js';
import { estimateTokens } from '../index.js';
import { parseCookieInput } from '../cookie-input.js';

/**
 * OpenAI messages → 豆包单段文本。
 * 注意：插件里的 messagesToText 吃的是 DSH 的 content block 数组，OpenAI 这边 content 是纯字符串，
 * 所以协议侧各自转换（这正是 standalone 该做的事），底层上游调用完全共用。
 */
function openaiText(messages, system) {
  const textOf = (m) => {
    const c = m?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x?.text || ''))).filter(Boolean).join('\n');
    return '';
  };
  const msgs = Array.isArray(messages) ? messages : [];
  const last = msgs[msgs.length - 1];
  if (msgs.length === 1 && last?.role === 'user' && !system) return textOf(last);
  const label = (r) => (r === 'assistant' ? 'AI' : r === 'system' ? '系统' : '用户');
  const lines = [];
  if (system) lines.push(`系统: ${system}`);
  for (const m of msgs) lines.push(`${label(m.role)}: ${textOf(m)}`);
  return `以下是你（AI 助手）与用户的对话记录。请作为 AI 助手，直接回答用户最后一条消息，不要复述记录本身。\n\n${lines.join('\n\n')}\n\nAI:`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 配置/账号/状态/日志的目录：默认与脚本同目录；测试或多实例部署用
// DSH_DOUBAO_GATEWAY_DIR 指到别处，免得往仓库里写文件。
const BASE_DIR = process.env.DSH_DOUBAO_GATEWAY_DIR || __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const ACCOUNTS_PATH = path.join(BASE_DIR, 'accounts.json');
const STATE_PATH = path.join(BASE_DIR, 'gateway-state.json');
const LOG_DIR = path.join(BASE_DIR, 'logs');

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

const config = loadJson(CONFIG_PATH, {});
const accountsFile = loadJson(ACCOUNTS_PATH, { accounts: [] });
fs.mkdirSync(LOG_DIR, { recursive: true });

const CFG = {
  port: config.port ?? 3040,
  apiKey: config.apiKey || '',
  defaultModel: config.defaultModel || Object.keys(config.models || {})[0] || 'deepseek-v4.1-flash',
  baseUrl: config.baseUrl || '',
};
/** 只暴露配置里列出的模型，行为与 1.3.x 一致（未列出按 400 处理） */
const ALLOWED = new Set(config.models ? Object.keys(config.models) : BUILTIN_MODELS.map(m => m.id));

function log(level, msg, extra = {}) {
  const rec = { ts: new Date().toISOString(), level, msg, ...extra };
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fs.appendFileSync(path.join(LOG_DIR, `gateway-${day}.jsonl`), JSON.stringify(rec) + '\n');
  } catch { /* 日志写失败不影响服务 */ }
  if (level !== 'debug') console.log(`[${rec.ts}] [${level}] ${msg}`);
}

const client = new DoubaoClient({
  providerId: 'doubao-gateway',
  providerName: '豆包网关',
  accounts: accountsFile.accounts,
  strategy: config.strategy === 'random' ? 'random' : 'round-robin',
  rpmPerAccount: config.rpmPerAccount ?? 6,
  globalMaxConcurrency: config.globalMaxConcurrency ?? 2,
  coolSeconds: config.coolSeconds ?? 86400,
  shortCoolSeconds: config.shortCoolSeconds ?? 300,
  queueWaitMs: config.queueWaitMs ?? 30000,
  requestTimeoutMs: config.requestTimeoutMs ?? 180000,
  maxAttempts: config.maxAttempts ?? 2,
  reasoningEffort: Math.min(3, Math.max(0, Number(config.reasoningEffort ?? 0) || 0)),
  dailyQuota: config.dailyQuota ?? 200,
  contextReuse: config.contextReuse !== false,
  // config.models 里非内置的条目转成 extraModels（id → model_item_key）
  extraModels: Object.entries(config.models || {})
    .filter(([id]) => !BUILTIN_MODELS.some(m => m.id === id))
    .map(([id, key]) => ({ id, name: id, modelItemKey: String(key) })),
  baseUrl: CFG.baseUrl,
  upstream: config.upstream || {},
}, { statePath: STATE_PATH, accountsPath: ACCOUNTS_PATH, log });

// ---------------- HTTP 辅助 ----------------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function oaiErr(res, code, type, message) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  json(res, code, { error: { message, type, code: type } });
}

function checkAuth(req) {
  if (!CFG.apiKey) return true;
  return (req.headers['authorization'] || '') === 'Bearer ' + CFG.apiKey;
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'BAD_REQUEST' })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON 解析失败'), { code: 'BAD_REQUEST' })); }
    });
    req.on('error', reject);
  });
}

const HTTP_BY_KIND = { auth: 401, ratelimit: 429, quota: 429, noaccount: 503, upstream: 502, timeout: 504, network: 502, empty: 502, aborted: 499 };
const TYPE_BY_KIND = {
  auth: 'authentication_error', ratelimit: 'rate_limit_error', quota: 'rate_limit_error', noaccount: 'service_unavailable',
  upstream: 'upstream_error', timeout: 'timeout_error', network: 'upstream_error', empty: 'upstream_error', aborted: 'cancelled',
};

// ---------------- 端点 ----------------

const startedAt = Date.now();

async function handleChatCompletions(req, res) {
  const abort = new AbortController();
  try {
    const body = await readBody(req);
    const model = body.model || CFG.defaultModel;
    if (!ALLOWED.has(model)) {
      return oaiErr(res, 400, 'invalid_request_error', `未知模型 ${model}，可用：${[...ALLOWED].join(', ')}`);
    }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const text = openaiText(msgs, body.system);
    if (!String(text).trim()) return oaiErr(res, 400, 'invalid_request_error', 'messages 里没有可用文本');
    const wantStream = body.stream === true;
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    // 会话复用：OpenAI 客户端不传会话号，这里用「模型 + 首条消息」做键（与插件同一套判定）
    let reuseId = '';
    let reuseKey = '';
    if (config.contextReuse !== false) {
      reuseKey = conversationKey(model, msgs[0] ? openaiText([msgs[0]]) : '');
      const prevReply = msgs.length >= 2 && msgs[msgs.length - 2]?.role === 'assistant'
        ? openaiText([msgs[msgs.length - 2]]) : '';
      const plan = client.planReuse(reuseKey, msgs, prevReply);
      if (plan) reuseId = plan.conversationId;
    }
    const sendText = reuseId && msgs.length > 1 ? openaiText(msgs.slice(-1)) : text;

    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(startedAt / 1000);
    let full = '';
    let result = null;
    const gen = client.chat(model, sendText, abort.signal, { conversationId: reuseId });
    while (true) {
      const { value, done } = await gen.next();
      if (done) { result = value; full = result?.text ?? full; break; }
      full += value;
      if (wantStream) {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: value }, finish_reason: null }],
        })}\n\n`);
      }
    }
    const finishReason = result?.truncated ? 'length' : 'stop';
    if (reuseKey && result?.conversationId) client.rememberConversation(reuseKey, result.conversationId, msgs.length, full);

    if (wantStream) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (!full) return oaiErr(res, 502, 'upstream_error', '上游未返回内容（可能触发风控或额度不足，请看网关日志）');
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: full }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: estimateTokens(text),
        completion_tokens: estimateTokens(full),
        total_tokens: estimateTokens(text) + estimateTokens(full),
      },
    });
  } catch (e) {
    if (e.code === 'BAD_REQUEST') return oaiErr(res, 400, 'invalid_request_error', e.message);
    const kind = e instanceof DoubaoError ? e.kind : 'upstream';
    if (kind === 'aborted') { try { res.end(); } catch { /* ignore */ } return; }
    log('warn', `请求失败(${kind})：${e.message}`);
    return oaiErr(res, HTTP_BY_KIND[kind] || 500, TYPE_BY_KIND[kind] || 'internal_error', e.message || '豆包上游调用失败');
  }
}

function handleModels(res) {
  const now = Math.floor(Date.now() / 1000);
  json(res, 200, {
    object: 'list',
    data: client.models().filter(m => ALLOWED.has(m.id)).map(m => ({
      id: m.id, object: 'model', created: now, owned_by: 'doubao-gateway', description: m.description || '',
    })),
  });
}

function recentLogs(n = 30) {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const lines = fs.readFileSync(path.join(LOG_DIR, `gateway-${day}.jsonl`), 'utf8').trim().split('\n');
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { msg: l }; } });
  } catch { return []; }
}

function handleStatus(res) {
  const rows = client.snapshot();
  const logs = recentLogs();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>doubao-gateway 状态</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;background:#f6f7f9;color:#222}h1{font-size:20px}table{border-collapse:collapse;width:100%;background:#fff;font-size:14px}th,td{border:1px solid #e2e5ea;padding:8px 10px;text-align:left}th{background:#eef1f5}.ok{color:#0a7d34}.warn{color:#b25e00}.err{color:#c0392b}.log{font-size:12px;background:#111;color:#ddd;padding:12px;overflow:auto;max-height:340px;white-space:pre-wrap}small{color:#888}</style></head><body>
<h1>doubao-gateway 状态 <small>端口 ${CFG.port}｜调度 ${config.strategy || 'round-robin'}｜RPM ${config.rpmPerAccount ?? 6}/账号｜全局并发 ${config.globalMaxConcurrency ?? 2}</small></h1>
<h3>账号池</h3><table><tr><th>ID</th><th>备注</th><th>状态</th><th>今日请求</th><th>累计请求</th><th>累计输出字数</th><th>最近错误</th></tr>
${rows.map(r => `<tr><td>${r.id}</td><td>${r.remark}</td><td class="${r.status === '可用' ? 'ok' : (String(r.status).includes('失效') ? 'err' : 'warn')}">${r.status}</td><td>${r.todayReq}</td><td>${r.totalReq}</td><td>${r.totalChars}</td><td>${r.lastError}</td></tr>`).join('')}
</table>
<h3>最近日志</h3><div class="log">${logs.map(l => `[${l.ts}] [${l.level}] ${l.msg}`).join('\n')}</div>
<p><small>模型映射：${client.models().filter(m => ALLOWED.has(m.id)).map(m => `${m.id} → ${m.modelItemKey}`).join('｜')}</small></p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleAdminCheck(res) {
  try { json(res, 200, { results: await client.checkAll() }); }
  catch (e) { json(res, 500, { results: [], error: e.message }); }
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, accounts: client.allAccounts().length, running: client.running, queued: client.queue.length });
    if (p === '/v1/models') { if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key'); return handleModels(res); }
    if (p === '/v1/chat/completions' && req.method === 'POST') {
      if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key');
      return await handleChatCompletions(req, res);
    }
    if (p === '/status') return handleStatus(res);
    if (p === '/admin/check' && req.method === 'POST') { if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key'); return await handleAdminCheck(res); }
    return oaiErr(res, 404, 'not_found', '未知路径，可用：/v1/chat/completions /v1/models /status /health /admin/check');
  } catch (e) {
    log('error', 'server error: ' + (e.stack || e.message));
    if (!res.headersSent) oaiErr(res, 500, 'internal_error', e.message);
  }
});

// ---------------- 首次启动：从 cookie-header.json 自举账号 ----------------

function bootstrapAccount() {
  if (client.allAccounts().length > 0) return;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'cookie-header.json'), 'utf8'));
    const parsed = parseCookieInput(raw.cookie || raw.Cookie || JSON.stringify(raw));
    if (parsed.pairs && parsed.cookie.length > 50) {
      accountsFile.accounts.push({ id: 'acc-1', remark: '从浏览器导出的账号', cookie: parsed.cookie, enabled: true });
      fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accountsFile, null, 2), { mode: 0o600 });
      client.cfg.accounts = accountsFile.accounts;
      log('info', '已从 cookie-header.json 自举账号 acc-1');
    }
  } catch { /* 文件不存在则跳过 */ }
}

bootstrapAccount();

if (client.allAccounts().length === 0) {
  console.error('[init] accounts.json 中没有账号。可以先在插件面板「从浏览器导入」，或把 Cookie 填进 accounts.json 后重启。');
  process.exit(1);
}

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`[doubao-gateway] 已启动 http://127.0.0.1:${CFG.port}`);
  console.log(`  OpenAI 端点:  http://127.0.0.1:${CFG.port}/v1/chat/completions`);
  console.log(`  模型列表:     ${[...ALLOWED].join(', ')}`);
  console.log(`  账号数:       ${client.allAccounts().length}｜状态页: http://127.0.0.1:${CFG.port}/status`);
  log('info', `网关启动 端口=${CFG.port} 账号=${client.allAccounts().length}`);
});

const shutdown = (sig) => {
  try { client.flushState(); } catch { /* ignore */ }
  log('info', `收到 ${sig}，状态已落盘`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

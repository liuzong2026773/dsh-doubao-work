#!/usr/bin/env node
/**
 * doubao-gateway —— 豆包工作 → OpenAI 兼容网关
 *
 * 功能：
 *  - OpenAI 兼容端点：/v1/chat/completions（流式 + 非流式）、/v1/models
 *  - 账号池：轮询/随机调度、单账号 RPM 限速、全局并发上限（带排队）
 *  - 冷却分级：429/403 长冷却（默认 24h）、5xx 短冷却、Cookie 失效标记
 *  - 状态看板：GET /status；健康检查：GET /health；手动检查：POST /admin/check
 *  - 日志持久化：logs/gateway-YYYYMMDD.jsonl；运行状态持久化：gateway-state.json
 *
 * 依赖：Node >= 18（无第三方依赖）
 * 启动：node index.js   （配置见同目录 config.json / accounts.json）
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const STATE_PATH = path.join(__dirname, 'gateway-state.json');
const LOG_DIR = path.join(__dirname, 'logs');

// ---------------- 配置加载 ----------------

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
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
  strategy: config.strategy === 'random' ? 'random' : 'round-robin',
  rpmPerAccount: config.rpmPerAccount ?? 6,
  globalMaxConcurrency: config.globalMaxConcurrency ?? 2,
  coolSeconds: config.coolSeconds ?? 86400,
  shortCoolSeconds: config.shortCoolSeconds ?? 300,
  queueWaitMs: config.queueWaitMs ?? 30000,
  requestTimeoutMs: config.requestTimeoutMs ?? 180000,
  maxAttempts: config.maxAttempts ?? 2,
  reasoningEffort: Math.min(3, Math.max(0, Number(config.reasoningEffort ?? 0) || 0)),
  upstream: {
    aid: '497858',
    version_code: '20800',
    pc_version: '3.45.5',
    language: 'zh',
    region: 'CN',
    tz_name: 'Asia/Shanghai',
    ...(config.upstream || {}),
  },
  models: config.models || {
    'deepseek-v4.1-flash': 'person-deepseek-v4-1-flash-261017',
    'doubao-2.1-lite': 'seed-lite-7b',
  },
  defaultModel: config.defaultModel || Object.keys(config.models || {})[0] || 'deepseek-v4.1-flash',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

// ---------------- 运行状态 ----------------

/** 每个账号的运行时状态（持久化到 gateway-state.json，不混进账号配置） */
const state = loadJson(STATE_PATH, { accounts: {} });
function accState(id) {
  if (!state.accounts[id]) {
    state.accounts[id] = { coolUntil: 0, lastReqTimes: [], totalReq: 0, totalChars: 0, authError: false, lastError: '' };
  }
  return state.accounts[id];
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) { log('warn', 'save state failed: ' + e.message); }
  }, 2000);
}

let roundIndex = 0;
let running = 0;
const waiters = []; // 全局并发排队

function log(level, msg, extra = {}) {
  const rec = { ts: new Date().toISOString(), level, msg, ...extra };
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    fs.appendFileSync(path.join(LOG_DIR, `gateway-${day}.jsonl`), JSON.stringify(rec) + '\n');
  } catch (e) { /* 忽略日志失败 */ }
  if (level !== 'debug') console.log(`[${rec.ts}] [${level}] ${msg}`);
}

// ---------------- 账号池 ----------------

function validAccounts() {
  const now = Date.now();
  return accountsFile.accounts.filter(a => a.enabled !== false && typeof a.cookie === 'string' && a.cookie.trim().length > 20 && accState(a.id).coolUntil <= now);
}

function pickAccount(excludeId) {
  const pool = validAccounts().filter(a => a.id !== excludeId);
  if (pool.length === 0) return null;
  const now = Date.now();
  const windowMs = 60000;
  const ok = pool.filter(a => {
    const st = accState(a.id);
    st.lastReqTimes = (st.lastReqTimes || []).filter(t => now - t < windowMs);
    return st.lastReqTimes.length < CFG.rpmPerAccount;
  });
  const usable = ok.length ? ok : pool; // 全部限速时仍取一个（宁可等待也不空转）
  let acc;
  if (CFG.strategy === 'random') acc = usable[Math.floor(Math.random() * usable.length)];
  else { roundIndex = (roundIndex + 1) % usable.length; acc = usable[roundIndex]; }
  return acc;
}

function rpmWaitMs(acc) {
  const st = accState(acc.id);
  const now = Date.now();
  st.lastReqTimes = (st.lastReqTimes || []).filter(t => now - t < 60000);
  if (st.lastReqTimes.length < CFG.rpmPerAccount) return 0;
  const oldest = Math.min(...st.lastReqTimes);
  return Math.max(0, oldest + 60000 - now + 50);
}

function coolAccount(acc, seconds, reason) {
  const st = accState(acc.id);
  st.coolUntil = Date.now() + seconds * 1000;
  st.lastError = reason;
  scheduleSave();
  log('warn', `账号 ${acc.id}(${acc.remark || ''}) 冷却 ${seconds}s：${reason}`);
}

function markAuthError(acc, reason) {
  const st = accState(acc.id);
  st.authError = true;
  st.lastError = reason;
  scheduleSave();
  log('error', `账号 ${acc.id}(${acc.remark || ''}) Cookie 失效：${reason}`);
}

// ---------------- 并发控制（排队） ----------------

function acquireSlot(waitMs) {
  return new Promise((resolve, reject) => {
    const tryAcquire = () => {
      if (running < CFG.globalMaxConcurrency) { running++; resolve(() => { running--; const w = waiters.shift(); if (w) w(); }); return true; }
      return false;
    };
    if (tryAcquire()) return;
    const entry = { tryAcquire, release: null };
    entry.release = () => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); reject(Object.assign(new Error('全局并发排队超时'), { code: 'QUEUE_TIMEOUT' })); };
    waiters.push(entry);
    setTimeout(() => entry.release(), waitMs);
  });
}

// ---------------- 豆包上游 ----------------

function uuid() { return crypto.randomUUID(); }

function buildUrl() {
  const u = CFG.upstream;
  const p = new URLSearchParams({
    aid: u.aid, device_id: u.device_id, device_platform: 'web', doubao_device_platform: 'web',
    doubao_pc_version: u.pc_version, fp: u.fp, language: u.language, pc_version: u.pc_version,
    pkg_type: 'release_version', real_aid: u.aid, region: u.region, samantha_web: '1',
    sys_region: u.region, tea_uuid: u.tea_uuid || u.web_id, tz_name: u.tz_name,
    'use-olympus-account': '1', version_code: u.version_code, web_id: u.web_id,
    web_platform: 'browser', web_tab_id: uuid(),
  });
  return 'https://www.doubao.com/chat/completion?' + p.toString();
}

/** OpenAI messages → 豆包单段文本 */
function messagesToText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw Object.assign(new Error('messages 不能为空'), { code: 'BAD_REQUEST' });
  const fmt = m => {
    const role = m.role === 'assistant' ? 'AI' : (m.role === 'system' ? '系统' : '用户');
    const content = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : String(m.content ?? ''));
    return `${role}: ${content}`;
  };
  const lines = messages.map(fmt).join('\n\n');
  if (messages.length === 1 && messages[0].role === 'user') {
    const c = typeof messages[0].content === 'string' ? messages[0].content : (Array.isArray(messages[0].content) ? messages[0].content.filter(x => x.type === 'text').map(x => x.text).join('\n') : String(messages[0].content));
    return c;
  }
  return `以下是你（AI 助手）与用户的对话记录。请作为 AI 助手，直接回答用户最后一条消息，不要复述记录。\n\n${lines}\n\nAI:`;
}

function buildUpstreamBody(text, modelItemKey, reasoningEffort) {
  const now = Date.now();
  const localConv = 'gw_' + uuid();
  const localMsg = uuid();
  return {
    client_meta: {
      local_conversation_id: localConv, conversation_id: '', bot_id: '7338286299411103781',
      last_section_id: '', last_message_index: null, local_permissions: [],
    },
    messages: [{
      local_message_id: localMsg,
      content_block: [{ block_type: 10000, content: { text_block: { text, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' }, block_id: uuid(), parent_id: '', meta_info: [], extra_info: {}, append_fields: [] }],
      message_status: 0,
    }],
    option: {
      send_message_scene: '', create_time_ms: now, collect_id: '', is_audio: false,
      answer_with_suggest: false, agent_mode: 1, tts_switch: false, need_deep_think: 0,
      click_clear_context: false, from_suggest: false, is_regen: false, is_replace: false,
      is_from_click_option: false, is_from_click_softlink: false, disable_sse_cache: false,
      select_text_action: '', is_select_text: false, resend_for_regen: false, scene_type: 0,
      unique_key: uuid(), start_seq: 0, need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: modelItemKey, reasoning_effort: String(reasoningEffort), mode_id: '3' },
      regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
      message_from: 0, shared_app_name: '', shared_app_id: '',
      sse_recv_event_options: { support_chunk_delta: true }, support_lazy_fetch_stream: true,
      is_ai_playground: false, is_old_user: false, general_task_param: { server_do_compare: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
      model_config: { model_item_key: modelItemKey, model_extra_params: {}, reasoning_effort: reasoningEffort },
      aggregate_params: {},
    },
  };
}

/** 调上游，返回 { ok, status, stream | error, kind } */
async function upstreamChat(account, modelItemKey, text, signal) {
  const url = buildUrl();
  const body = buildUpstreamBody(text, modelItemKey, CFG.reasoningEffort);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cookie': account.cookie.trim(),
        'agw-js-conv': 'str, str',
        'user-agent': UA,
        'referer': 'https://www.doubao.com/chat/',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return { ok: false, kind: 'network', error: e.message };
  }
  if (!res.ok) {
    // 消费响应体避免连接泄漏
    const t = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403 && /login|auth/i.test(t)) return { ok: false, kind: 'auth', status: res.status, error: t.slice(0, 200) };
    if (res.status === 429 || res.status === 403) return { ok: false, kind: 'ratelimit', status: res.status, error: t.slice(0, 200) };
    return { ok: false, kind: 'upstream', status: res.status, error: t.slice(0, 200) };
  }
  // 检查是否被重定向到登录（cookie 失效时字节网关有时回 200 + HTML）
  const ct = res.headers.get('content-type') || '';
  if (!/event-stream|text\/plain|octet-stream/i.test(ct)) {
    const t = await res.text().catch(() => '');
    if (/<!DOCTYPE|<html/i.test(t.slice(0, 500))) return { ok: false, kind: 'auth', status: 200, error: '返回 HTML（疑似登录态失效）' };
    return { ok: false, kind: 'upstream', status: 200, error: '异常 content-type: ' + ct };
  }
  return { ok: true, stream: res.body };
}

/** 流式解析豆包 SSE，回调 AI 增量文本。返回 Promise<全文> */
async function pumpDoubaoStream(webStream, onDelta, signal) {
  const reader = webStream.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  let ended = false;

  const handleEvent = (evName, dataStr) => {
    if (ended) return;
    try {
      if (evName === 'CHUNK_DELTA') {
        const d = JSON.parse(dataStr);
        if (typeof d.text === 'string' && d.text) { full += d.text; onDelta(d.text); }
        return;
      }
      if (evName === 'STREAM_CHUNK') {
        const d = JSON.parse(dataStr);
        const ops = d.patch_op || [];
        for (const op of ops) {
          const blocks = op?.patch_value?.content_block || [];
          for (const b of blocks) {
            const t = b?.content?.text_block?.text;
            if (typeof t === 'string' && t && op.patch_object === 1) { full += t; onDelta(t); }
          }
        }
        return;
      }
      if (evName === 'STREAM_MSG_NOTIFY') {
        // AI 消息首块（含首个文本分片）
        const d = JSON.parse(dataStr);
        const blocks = d?.content?.content_block || [];
        for (const b of blocks) {
          const t = b?.content?.text_block?.text;
          if (typeof t === 'string' && t) { full += t; onDelta(t); }
        }
        return;
      }
      if (evName === 'SSE_REPLY_END' || evName === 'STREAM_FINISH' || evName === 'DONE') { ended = true; return; }
    } catch (e) { /* 单事件解析失败不影响整体 */ }
  };

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evName = 'message';
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) evName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) handleEvent(evName, dataLines.join('\n'));
      if (ended) break;
    }
    if (ended) break;
  }
  try { await reader.cancel(); } catch (e) { /* ignore */ }
  // ended=false 表示没收到 SSE_REPLY_END 就断流（网络抖动 / 上游掐线），
  // 此时 full 只是半截内容，必须告知调用方，否则客户端会把半截当成完整回复。
  return { text: full, truncated: !ended && full.length > 0 };
}

// ---------------- OpenAI 层 ----------------

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const oaiErr = (res, code, type, msg) => json(res, code, { error: { message: msg, type, code: type } });

function estimateTokens(s) { return Math.ceil((s || '').length / 4); }

function checkAuth(req) {
  if (!CFG.apiKey) return true;
  const h = req.headers['authorization'] || '';
  return h === 'Bearer ' + CFG.apiKey;
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'BAD_REQUEST' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(Object.assign(new Error('JSON 解析失败'), { code: 'BAD_REQUEST' })); } });
    req.on('error', reject);
  });
}

async function handleChatCompletions(req, res) {
  let release = null;
  const abort = new AbortController();
  const startedAt = Date.now();
  try {
    const body = await readBody(req);
    const model = body.model || CFG.defaultModel;
    const modelItemKey = CFG.models[model];
    if (!modelItemKey) return oaiErr(res, 400, 'invalid_request_error', `未知模型 ${model}，可用：${Object.keys(CFG.models).join(', ')}`);
    const text = messagesToText(body.messages || []);
    const wantStream = body.stream === true;
    const clientId = body.user || '';

    release = await acquireSlot(CFG.queueWaitMs);
    req.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let lastErr = null;
    let usedAcc = null;
    for (let attempt = 0; attempt < Math.max(1, CFG.maxAttempts); attempt++) {
      const acc = pickAccount(usedAcc?.id);
      if (!acc) {
        const anyAccount = accountsFile.accounts[0];
        if (!anyAccount) return oaiErr(res, 503, 'service_unavailable', 'accounts.json 中没有配置账号');
        const st = accState(anyAccount.id);
        if (st.authError) return oaiErr(res, 401, 'authentication_error', `账号 ${anyAccount.id} Cookie 失效，请更新 accounts.json`);
        const waitSec = Math.ceil((st.coolUntil - Date.now()) / 1000);
        return oaiErr(res, 429, 'rate_limit_error', waitSec > 0 ? `全部账号冷却中，${waitSec}s 后重试` : '全部账号限速/冷却中，请稍后重试');
      }
      usedAcc = acc;
      const wait = rpmWaitMs(acc);
      if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 15000)));

      const st = accState(acc.id);
      st.lastReqTimes.push(Date.now());
      st.totalReq++;
      scheduleSave();

      const up = await upstreamChat(acc, modelItemKey, text, abort.signal);
      if (up.ok) {
        log('info', `上游 200 账号=${acc.id} 模型=${model}`, { acc: acc.id });
        const out = await pumpDoubaoStream(up.stream, chunk => {
          if (!wantStream) return;
          const payload = {
            id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
            object: 'chat.completion.chunk',
            created: Math.floor(startedAt / 1000),
            model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }, abort.signal);
        const fullText = out.text;
        if (out.truncated) log('warn', `上游流中断，仅返回部分内容（${fullText.length} 字）`);

        const ms = Date.now() - startedAt;
        accState(acc.id).totalChars += fullText.length;
        scheduleSave();
        log('info', `完成 账号=${acc.id} 模型=${model} 字数=${fullText.length} 耗时=${ms}ms`, { acc: acc.id, ms, chars: fullText.length });

        if (wantStream) {
          const fin = { id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24), object: 'chat.completion.chunk', created: Math.floor(startedAt / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: out.truncated ? 'length' : 'stop' }] };
          res.write(`data: ${JSON.stringify(fin)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          if (!fullText) return oaiErr(res, 502, 'upstream_error', '上游未返回内容（可能触发风控或额度不足，请看网关日志）');
          json(res, 200, {
            id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
            object: 'chat.completion',
            created: Math.floor(startedAt / 1000),
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: out.truncated ? 'length' : 'stop' }],
            usage: { prompt_tokens: estimateTokens(text), completion_tokens: estimateTokens(fullText), total_tokens: estimateTokens(text) + estimateTokens(fullText) },
          });
        }
        return;
      }

      // 失败分级
      lastErr = up;
      if (up.kind === 'auth') { markAuthError(acc, up.error); continue; }
      if (up.kind === 'ratelimit') { coolAccount(acc, CFG.coolSeconds, `限流 HTTP ${up.status}`); continue; }
      if (up.kind === 'network') { log('warn', `网络错误 账号=${acc.id}: ${up.error}`); continue; }
      coolAccount(acc, CFG.shortCoolSeconds, `上游错误 HTTP ${up.status || '?'}: ${up.error}`);
    }
    return oaiErr(res, 502, 'upstream_error', `所有尝试失败：${lastErr?.error || lastErr?.kind || 'unknown'}`);
  } catch (e) {
    if (e.code === 'BAD_REQUEST') return oaiErr(res, 400, 'invalid_request_error', e.message);
    if (e.code === 'QUEUE_TIMEOUT') return oaiErr(res, 429, 'rate_limit_error', e.message);
    log('error', 'handleChat 异常: ' + (e.stack || e.message));
    if (!res.headersSent) return oaiErr(res, 500, 'internal_error', e.message);
    try { res.end(); } catch (_) { /* ignore */ }
  } finally {
    if (release) release();
  }
}

// ---------------- 辅助端点 ----------------

function handleModels(res) {
  const now = Math.floor(Date.now() / 1000);
  json(res, 200, {
    object: 'list',
    data: Object.keys(CFG.models).map(id => ({ id, object: 'model', created: now, owned_by: 'doubao-gateway' })),
  });
}

function accountRows() {
  return accountsFile.accounts.map(a => {
    const st = accState(a.id);
    const now = Date.now();
    const cooling = st.coolUntil > now;
    return {
      id: a.id, remark: a.remark || '', enabled: a.enabled !== false,
      status: st.authError ? 'Cookie失效' : (cooling ? `冷却至 ${new Date(st.coolUntil).toLocaleTimeString('zh-CN')}` : (a.enabled === false ? '已禁用' : '可用')),
      totalReq: st.totalReq || 0, totalChars: st.totalChars || 0, lastError: st.lastError || '',
    };
  });
}

function recentLogs(n = 30) {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const p = path.join(LOG_DIR, `gateway-${day}.jsonl`);
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return { msg: l }; } });
  } catch (e) { return []; }
}

function handleStatus(res) {
  const rows = accountRows();
  const logs = recentLogs();
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>doubao-gateway 状态</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:24px;background:#f6f7f9;color:#222}h1{font-size:20px}table{border-collapse:collapse;width:100%;background:#fff;font-size:14px}th,td{border:1px solid #e2e5ea;padding:8px 10px;text-align:left}th{background:#eef1f5}.ok{color:#0a7d34}.warn{color:#b25e00}.err{color:#c0392b}.log{font-size:12px;background:#111;color:#ddd;padding:12px;overflow:auto;max-height:340px;white-space:pre-wrap}small{color:#888}</style></head><body>
<h1>doubao-gateway 状态 <small>端口 ${CFG.port}｜调度 ${CFG.strategy}｜RPM ${CFG.rpmPerAccount}/账号｜全局并发 ${CFG.globalMaxConcurrency}</small></h1>
<h3>账号池</h3><table><tr><th>ID</th><th>备注</th><th>状态</th><th>累计请求</th><th>累计输出字数</th><th>最近错误</th></tr>
${rows.map(r => `<tr><td>${r.id}</td><td>${r.remark}</td><td class="${r.status === '可用' ? 'ok' : (r.status.includes('失效') ? 'err' : 'warn')}">${r.status}</td><td>${r.totalReq}</td><td>${r.totalChars}</td><td>${r.lastError}</td></tr>`).join('')}
</table>
<h3>最近日志</h3><div class="log">${logs.map(l => `[${l.ts}] [${l.level}] ${l.msg}`).join('\n')}</div>
<p><small>刷新页面即刷新数据。模型映射：${Object.entries(CFG.models).map(([k, v]) => `${k} → ${v}`).join('｜')}</small></p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/** 手动健康检查：对每个账号调 /alice/profile/self 验证登录态 */
async function handleAdminCheck(res) {
  const results = [];
  for (const a of accountsFile.accounts) {
    if (typeof a.cookie !== 'string' || a.cookie.trim().length < 20) { results.push({ id: a.id, ok: false, error: 'cookie 未配置' }); continue; }
    try {
      const r = await fetch('https://www.doubao.com/alice/profile/self?aid=497858&version_code=20800', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: a.cookie.trim(), 'user-agent': UA }, body: '{}',
      });
      const t = await r.text();
      const ok = r.ok && /"code":\s*0/.test(t) && !/<html/i.test(t.slice(0, 200));
      results.push({ id: a.id, ok, http: r.status });
      if (!ok && r.status === 401) markAuthError(a, 'profile/self 401');
    } catch (e) {
      results.push({ id: a.id, ok: false, error: e.message });
    }
  }
  json(res, 200, { results });
}

// ---------------- HTTP 服务器 ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, running, queued: waiters.length, accounts: accountsFile.accounts.length });
    if (p === '/v1/models') { if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key'); return handleModels(res); }
    if (p === '/v1/chat/completions' && req.method === 'POST') { if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key'); return handleChatCompletions(req, res); }
    if (p === '/status') return handleStatus(res);
    if (p === '/admin/check' && req.method === 'POST') { if (!checkAuth(req)) return oaiErr(res, 401, 'authentication_error', 'invalid api key'); return handleAdminCheck(res); }
    return oaiErr(res, 404, 'not_found', '未知路径，可用：/v1/chat/completions /v1/models /status /health /admin/check');
  } catch (e) {
    log('error', 'server error: ' + (e.stack || e.message));
    if (!res.headersSent) oaiErr(res, 500, 'internal_error', e.message);
  }
});

// ---------------- Cookie 自举 ----------------

/** 首次启动：若 accounts.json 无账号，尝试从抓到的 cookie-header.json 自举 */
function bootstrapAccount() {
  if (accountsFile.accounts.length > 0) return;
  const cookiePath = path.join(__dirname, 'cookie-header.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
    const cookie = (raw.cookie || '').trim();
    if (cookie.length > 50) {
      accountsFile.accounts.push({ id: 'acc-1', remark: '从浏览器导出的账号（重命名备注便于识别）', cookie, enabled: true });
      fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accountsFile, null, 2));
      log('info', '已从 cookie-header.json 自举账号 acc-1');
      console.log('[init] 已从 cookie-header.json 自举账号 acc-1（Cookie 已写入 accounts.json，可删除 cookie-header.json）');
    }
  } catch (e) { /* 文件不存在则跳过 */ }
}

bootstrapAccount();

if (accountsFile.accounts.length === 0) {
  console.error('[init] accounts.json 中没有账号。请把豆包网页版登录后的 Cookie 填入 accounts.json 的 accounts[0].cookie 后重启。');
  process.exit(1);
}

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`[doubao-gateway] 已启动 http://127.0.0.1:${CFG.port}`);
  console.log(`  OpenAI 端点:  http://127.0.0.1:${CFG.port}/v1/chat/completions`);
  console.log(`  模型列表:     ${Object.keys(CFG.models).join(', ')}`);
  console.log(`  账号数:       ${accountsFile.accounts.length}｜状态页: http://127.0.0.1:${CFG.port}/status`);
  log('info', `网关启动 端口=${CFG.port} 账号=${accountsFile.accounts.length}`);
});

process.on('SIGINT', () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) {} process.exit(0); });

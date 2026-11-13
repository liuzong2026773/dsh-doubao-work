/**
 * doubao.js —— 豆包工作上游调用内核（经真实接口验证）
 *
 * 已验证事实（2026-11-13 实测）：
 *  - 接口：POST https://www.doubao.com/chat/completion（SSE 流式）
 *  - 鉴权：完整浏览器 Cookie，无需 msToken/a_bogus 签名
 *  - 必需设备参数：device_id / web_id / tea_uuid / fp（缺失则不触发推理）
 *  - 模型切换：model_item_key（工作模式 mode_id="3"、agent_mode=1）
 *    - DeepSeek V4.1 Flash (0.01x) => person-deepseek-v4-1-flash-261017
 *    - 豆包 2.1 Lite (0.01x)       => seed-lite-7b
 *  - SSE 事件：SSE_HEARTBEAT / SSE_ACK / FULL_MSG_NOTIFY(用户回显,跳过) /
 *              STREAM_MSG_NOTIFY / STREAM_CHUNK / CHUNK_DELTA / SSE_REPLY_END
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BOT_ID = '7338286299411103781';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const uuid = () => crypto.randomUUID();

/** 带机器码的上游错误：kind ∈ auth | ratelimit | upstream | network | noaccount | empty | aborted */
export class DoubaoError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'DoubaoError';
    this.kind = kind;
    this.status = status;
  }
}

/** 内置模型映射（豆包工作 0.01x 限时优惠，实测抓包） */
export const BUILTIN_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: '豆包工作·限时优惠 0.01x', modelItemKey: 'person-deepseek-v4-1-flash-261017' },
  { id: 'doubao-2.1-lite', name: '豆包 2.1 Lite', description: '豆包工作·限时优惠 0.01x', modelItemKey: 'seed-lite-7b' },
];

export class DoubaoClient {
  /**
   * @param config 插件配置（accounts/strategy/rpm/...）
   * @param opts {{ statePath?: string, log?: (level: string, msg: string, extra?: object) => void }}
   */
  constructor(config, opts = {}) {
    this.cfg = config;
    this.log = opts.log || (() => {});
    this.statePath = opts.statePath;
    this.state = this._loadState();
    this.roundIndex = 0;
    this._saveTimer = null;
  }

  // ---------- 运行状态（冷却/统计独立持久化，不混入配置） ----------

  _loadState() {
    try {
      if (this.statePath && fs.existsSync(this.statePath)) return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (e) { /* ignore */ }
    return { accounts: {} };
  }

  _accState(id) {
    if (!this.state.accounts[id]) {
      this.state.accounts[id] = { coolUntil: 0, lastReqTimes: [], totalReq: 0, totalChars: 0, authError: false, lastError: '' };
    }
    return this.state.accounts[id];
  }

  _scheduleSave() {
    if (this._saveTimer || !this.statePath) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ }
    }, 2000);
  }

  flushState() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.statePath) { try { fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ } }
  }

  // ---------- 账号池 ----------

  _accounts() {
    return (this.cfg.accounts || []).filter(a => a.enabled !== false && typeof a.cookie === 'string' && a.cookie.trim().length > 20);
  }

  _validAccounts() {
    const now = Date.now();
    return this._accounts().filter(a => this._accState(a.id).coolUntil <= now);
  }

  pickAccount(excludeId) {
    const pool = this._validAccounts().filter(a => a.id !== excludeId);
    if (pool.length === 0) return null;
    const now = Date.now();
    const notLimited = pool.filter(a => {
      const st = this._accState(a.id);
      st.lastReqTimes = (st.lastReqTimes || []).filter(t => now - t < 60000);
      return st.lastReqTimes.length < (this.cfg.rpmPerAccount ?? 6);
    });
    const usable = notLimited.length ? notLimited : pool;
    if ((this.cfg.strategy === 'random') && usable.length > 1) return usable[Math.floor(Math.random() * usable.length)];
    this.roundIndex = (this.roundIndex + 1) % usable.length;
    return usable[this.roundIndex];
  }

  _rpmWaitMs(acc) {
    const st = this._accState(acc.id);
    const now = Date.now();
    st.lastReqTimes = (st.lastReqTimes || []).filter(t => now - t < 60000);
    if (st.lastReqTimes.length < (this.cfg.rpmPerAccount ?? 6)) return 0;
    const oldest = Math.min(...st.lastReqTimes);
    return Math.max(0, oldest + 60000 - now + 50);
  }

  coolAccount(acc, seconds, reason) {
    const st = this._accState(acc.id);
    st.coolUntil = Date.now() + seconds * 1000;
    st.lastError = reason;
    this._scheduleSave();
    this.log('warn', `账号 ${acc.id}(${acc.remark || ''}) 冷却 ${seconds}s：${reason}`);
  }

  markAuthError(acc, reason) {
    const st = this._accState(acc.id);
    st.authError = true;
    st.lastError = reason;
    this._scheduleSave();
    this.log('error', `账号 ${acc.id}(${acc.remark || ''}) Cookie 失效：${reason}`);
  }

  snapshot() {
    return this._accounts().map(a => {
      const st = this._accState(a.id);
      const now = Date.now();
      return {
        id: a.id, remark: a.remark || '', enabled: a.enabled !== false,
        status: st.authError ? 'Cookie失效' : (st.coolUntil > now ? `冷却至 ${new Date(st.coolUntil).toLocaleTimeString('zh-CN')}` : '可用'),
        totalReq: st.totalReq || 0, totalChars: st.totalChars || 0, lastError: st.lastError || '',
      };
    });
  }

  /** 健康检查：验证每个账号登录态 */
  async checkAll() {
    const results = [];
    for (const a of this._accounts()) {
      try {
        const r = await fetch('https://www.doubao.com/alice/profile/self?aid=497858&version_code=20800', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: a.cookie.trim(), 'user-agent': UA },
          body: '{}',
        });
        const t = await r.text();
        const ok = r.ok && /"code":\s*0/.test(t) && !/<html/i.test(t.slice(0, 200));
        results.push({ id: a.id, remark: a.remark || '', ok, http: r.status });
        if (!ok && r.status === 401) this.markAuthError(a, 'profile/self 401');
      } catch (e) {
        results.push({ id: a.id, remark: a.remark || '', ok: false, error: e.message });
      }
    }
    return results;
  }

  // ---------- 模型目录 ----------

  models() {
    const extra = (this.cfg.extraModels || []).filter(m => m && m.id && m.modelItemKey);
    return [...BUILTIN_MODELS, ...extra];
  }

  resolveModelItemKey(modelId) {
    const m = this.models().find(x => x.id === modelId);
    return m ? m.modelItemKey : null;
  }

  // ---------- 上游调用 ----------

  _buildUrl() {
    const u = this.cfg.upstream || {};
    const p = new URLSearchParams({
      aid: u.aid || '497858',
      device_id: u.device_id || '7707509248230065699',
      device_platform: 'web',
      doubao_device_platform: 'web',
      doubao_pc_version: u.pc_version || '3.45.5',
      fp: u.fp || 'verify_mwehdj77_p7te0LWd_xEFZ_4N2S_8jDq_L7Zl4uO5iI5F',
      language: u.language || 'zh',
      pc_version: u.pc_version || '3.45.5',
      pkg_type: 'release_version',
      real_aid: u.aid || '497858',
      region: u.region || 'CN',
      samantha_web: '1',
      sys_region: u.region || 'CN',
      tea_uuid: u.tea_uuid || u.web_id || '7707509253662393906',
      tz_name: u.tz_name || 'Asia/Shanghai',
      'use-olympus-account': '1',
      version_code: u.version_code || '20800',
      web_id: u.web_id || '7707509253662393906',
      web_platform: 'browser',
      web_tab_id: uuid(),
    });
    return 'https://www.doubao.com/chat/completion?' + p.toString();
  }

  _buildBody(text, modelItemKey) {
    const now = Date.now();
    return {
      client_meta: {
        local_conversation_id: 'gw_' + uuid(), conversation_id: '', bot_id: BOT_ID,
        last_section_id: '', last_message_index: null, local_permissions: [],
      },
      messages: [{
        local_message_id: uuid(),
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
        conversation_init_ext: { model_item_key: modelItemKey, reasoning_effort: '3', mode_id: '3' },
        regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
        message_from: 0, shared_app_name: '', shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true }, support_lazy_fetch_stream: true,
        is_ai_playground: false, is_old_user: false, general_task_param: { server_do_compare: true },
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
        message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
        model_config: { model_item_key: modelItemKey, model_extra_params: {}, reasoning_effort: 3 },
        aggregate_params: {},
      },
    };
  }

  /**
   * 单账号单次上游调用
   * @returns {AsyncGenerator<string, string>} AI 文本增量（return 值为全文）
   */
  async *chatOnce(account, modelItemKey, text, signal) {
    const startedAt = Date.now();
    const st = this._accState(account.id);
    st.lastReqTimes = st.lastReqTimes || [];
    st.lastReqTimes.push(Date.now());
    st.totalReq++;
    this._scheduleSave();

    let res;
    try {
      res = await fetch(this._buildUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: account.cookie.trim(),
          'agw-js-conv': 'str, str',
          'user-agent': UA,
          referer: 'https://www.doubao.com/chat/',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(this._buildBody(text, modelItemKey)),
        signal,
      });
    } catch (e) {
      throw new DoubaoError('network', `上游网络错误: ${e.message}`);
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (res.status === 401) throw new DoubaoError('auth', '登录态失效 HTTP 401', 401);
      if (res.status === 429 || res.status === 403) throw new DoubaoError('ratelimit', `限流 HTTP ${res.status}: ${t.slice(0, 120)}`, res.status);
      throw new DoubaoError('upstream', `上游错误 HTTP ${res.status}: ${t.slice(0, 120)}`, res.status);
    }

    const ct = res.headers.get('content-type') || '';
    if (!/event-stream|text\/plain|octet-stream/i.test(ct)) {
      const t = await res.text().catch(() => '');
      if (/<!DOCTYPE|<html/i.test(t.slice(0, 500))) throw new DoubaoError('auth', '返回 HTML（疑似登录态失效）', 200);
      throw new DoubaoError('upstream', `异常 content-type: ${ct}`, 200);
    }

    // SSE 解析
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    let ended = false;
    try {
      while (!ended) {
        if (signal?.aborted) throw new DoubaoError('aborted', '请求已取消');
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
          if (!dataLines.length) continue;
          const dataStr = dataLines.join('\n');
          try {
            if (evName === 'CHUNK_DELTA') {
              const d = JSON.parse(dataStr);
              if (typeof d.text === 'string' && d.text) { full += d.text; yield d.text; }
            } else if (evName === 'STREAM_CHUNK') {
              const d = JSON.parse(dataStr);
              for (const op of d.patch_op || []) {
                if (op.patch_object !== 1) continue;
                for (const b of op?.patch_value?.content_block || []) {
                  const t = b?.content?.text_block?.text;
                  if (typeof t === 'string' && t) { full += t; yield t; }
                }
              }
            } else if (evName === 'STREAM_MSG_NOTIFY') {
              const d = JSON.parse(dataStr);
              for (const b of d?.content?.content_block || []) {
                const t = b?.content?.text_block?.text;
                if (typeof t === 'string' && t) { full += t; yield t; }
              }
            } else if (evName === 'SSE_REPLY_END' || evName === 'STREAM_FINISH' || evName === 'DONE') {
              ended = true;
            }
          } catch (e) { /* 单事件解析失败不中断 */ }
          if (ended) break;
        }
      }
    } finally {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
    }

    const ms = Date.now() - startedAt;
    st.totalChars += full.length;
    this._scheduleSave();
    this.log('info', `上游完成 账号=${account.id} 字数=${full.length} 耗时=${ms}ms`, { acc: account.id, ms, chars: full.length });

    if (!full) throw new DoubaoError('empty', '上游未返回内容（可能触发风控/额度不足/参数被风）');
    return full;
  }

  /**
   * 带账号池调度与重试的完整调用
   * @returns {AsyncGenerator<string, string>} AI 文本增量（return 值为全文）
   */
  async *chat(modelId, text, signal) {
    const modelItemKey = this.resolveModelItemKey(modelId);
    if (!modelItemKey) throw new DoubaoError('upstream', `未知模型 ${modelId}`);
    const maxAttempts = Math.max(1, this.cfg.maxAttempts ?? 2);
    let usedId = null;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acc = this.pickAccount(usedId);
      if (!acc) {
        const accounts = this._accounts();
        if (accounts.length === 0) throw new DoubaoError('noaccount', '没有可用账号：请检查 accounts 配置（cookie 是否已填、是否启用）');
        const st = this._accState(accounts[0].id);
        if (st.authError) throw new DoubaoError('auth', `账号 ${accounts[0].id} Cookie 失效，请在插件配置里更新`);
        const waitSec = Math.ceil((st.coolUntil - Date.now()) / 1000);
        throw new DoubaoError('ratelimit', waitSec > 0 ? `全部账号冷却中，约 ${waitSec}s 后重试` : '全部账号限速中，请稍后重试');
      }
      usedId = acc.id;
      const wait = this._rpmWaitMs(acc);
      if (wait > 0 && wait < 15000) await new Promise(r => setTimeout(r, wait));
      try {
        const full = yield* this.chatOnce(acc, modelItemKey, text, signal);
        return full;
      } catch (e) {
        if (e instanceof DoubaoError) {
          lastErr = e;
          if (e.kind === 'aborted') throw e;
          if (e.kind === 'auth') this.markAuthError(acc, e.message);
          else if (e.kind === 'ratelimit') this.coolAccount(acc, this.cfg.coolSeconds ?? 86400, e.message);
          else if (e.kind === 'upstream' || e.kind === 'empty') this.coolAccount(acc, this.cfg.shortCoolSeconds ?? 300, e.message);
          // network：不冷却，直接换号重试
          this.log('warn', `账号 ${acc.id} 尝试失败(${e.kind})：${e.message}，尝试下一个账号`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new DoubaoError('upstream', '所有尝试均失败');
  }
}

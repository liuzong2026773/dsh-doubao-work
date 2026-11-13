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

// 豆包 PC 端每日签到活动 scene（即接口里的 campaign_group_code），客户端固定值
const CHECKIN_SCENE = 'pc_incentive_task_mvp_v3';
const uuid = () => crypto.randomUUID();
const shortHash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);

/**
 * 会话复用键。此前只取首条消息前 200 字，两个不同会话只要开头相同（例如都以
 * "帮我看下这段代码"起头）就会共用同一条上游会话，回答直接串号。
 * 这里用「全文长度 + 全文 SHA1 前 16 位」，同一会话仍稳定命中，不同会话基本不可能撞。
 * 局限：宿主未暴露 session id，只能靠内容指纹识别；首条消息完全相同的会话仍会被视为同一条
 * （那种情况下两者本就无法从内容上区分）。
 */
export const conversationKey = (model, firstText) => {
  const t = String(firstText || '');
  // 键里刻意不拼 model：豆包会话本身与模型无关，带上 model 会导致「换个模型→键变了→上下文断链」。
  // 区分不同会话已由首条消息指纹 + 上一条回复指纹双重校验保证，不需要 model 参与。
  void model;
  return t ? `${t.length}|${shortHash(t)}` : '';
};

// ---- 额度按「北京时间自然日」结算 ----
const CN_OFFSET = 8 * 3600 * 1000;
function cnDate(ts = Date.now()) { return new Date(ts + CN_OFFSET); }
function dayKeyCN(ts = Date.now()) { return cnDate(ts).toISOString().slice(0, 10); }
function isMondayCN(ts = Date.now()) { return cnDate(ts).getUTCDay() === 1; }
function msUntilMidnightCN(ts = Date.now()) {
  const t = cnDate(ts);
  const next = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
  return Math.max(1000, next - t.getTime());
}

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
   * @param opts {{ statePath?: string, accountsPath?: string, log?: (level: string, msg: string, extra?: object) => void }}
   */
  constructor(config, opts = {}) {
    this.cfg = config;
    this.log = opts.log || (() => {});
    // 上游站点可替换：默认豆包网页版；测试/自托管镜像时改 baseUrl 指向 mock 服务器
    this.baseUrl = (config.baseUrl || 'https://www.doubao.com').replace(/\/+$/, '');
    this.statePath = opts.statePath;
    this.accountsPath = opts.accountsPath; // accounts.json 热加载（改文件即生效，无需重启）
    this.state = this._loadState();
    this.roundIndex = 0;
    // 对话键 → { conversationId, msgCount, ts }；从持久化状态恢复，重启不丢上下文
    this.convMap = new Map(Object.entries(this.state.conversations || {}));
    this.running = 0;   // 全局并发
    this.queue = [];
    this._saveTimer = null;
    this._accountsFileMtime = 0;
    this._accountsFileAccounts = [];
  }

  // ---------- 运行状态（冷却/统计独立持久化，不混入配置） ----------

  _loadState() {
    try {
      if (this.statePath && fs.existsSync(this.statePath)) {
        const d = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        d.accounts = d.accounts || {};
        d.conversations = d.conversations || {};
        return d;
      }
    } catch (e) { /* ignore */ }
    return { accounts: {}, conversations: {} };
  }

  // ---------- 全局并发（避免 DSH 并发请求打爆同一账号） ----------

  _acquireSlot() {
    const max = Math.max(1, this.cfg.globalMaxConcurrency ?? 2);
    if (this.running < max) { this.running++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DoubaoError('ratelimit', '全局并发排队超时，请稍后重试'));
      }, this.cfg.queueWaitMs ?? 30000);
      this.queue.push(entry);
    });
  }

  _releaseSlot() {
    const next = this.queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else this.running = Math.max(0, this.running - 1);
  }

  // ---------- 按日用量（平台不提供余量接口，只能自记账） ----------

  _bumpDaily(id, chars) {
    const st = this._accState(id);
    const today = dayKeyCN();
    if (st.day !== today) { st.day = today; st.dayReq = 0; st.dayChars = 0; }
    st.dayReq = (st.dayReq || 0) + 1;
    st.dayChars = (st.dayChars || 0) + chars;
    this._scheduleSave();
  }

  _accState(id) {
    if (!this.state.accounts[id]) {
      this.state.accounts[id] = { coolUntil: 0, lastReqTimes: [], totalReq: 0, totalChars: 0, authError: false, lastError: '' };
    }
    return this.state.accounts[id];
  }

  _syncConversations() {
    const now = Date.now();
    const ttl = (this.cfg.conversationTtlSec ?? 1800) * 1000;
    const out = {};
    for (const [k, v] of this.convMap) if (now - v.ts < ttl) out[k] = v;
    this.state.conversations = out;
  }

  _scheduleSave() {
    if (this._saveTimer || !this.statePath) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { this._syncConversations(); fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ }
    }, 2000);
  }

  flushState() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.statePath) { try { this._syncConversations(); fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2)); } catch (e) { /* ignore */ } }
  }

  // ---------- 账号池 ----------

  /**
   * 热加载 accounts.json（存在时）：mtime 变化才重读。
   * 文件格式：{ "accounts": [ { "id": "acc-1", "cookie": "...", "remark": "...", "enabled": true } ] }
   * 同 id 时文件账号优先于配置面板账号；导出=复制此文件，导入=放到插件目录。
   */
  _syncAccountsFile() {
    if (!this.accountsPath) return;
    let st;
    try {
      st = fs.statSync(this.accountsPath);
    } catch (e) {
      if (e.code === 'ENOENT' && this._accountsFileAccounts.length) {
        this._accountsFileAccounts = [];
        this._accountsFileMtime = 0;
        this.log('info', 'accounts.json 已移除，回退到配置面板账号');
      }
      return;
    }
    if (st.mtimeMs === this._accountsFileMtime) return;
    this._accountsFileMtime = st.mtimeMs;
    try {
      const raw = fs.readFileSync(this.accountsPath, 'utf8').replace(/^\uFEFF/, ''); // 容错 UTF-8 BOM
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : (data.accounts || []);
      this._accountsFileAccounts = list
        .map((a, i) => ({ ...a, id: a.id || `file-acc-${i + 1}` }))
        .filter(a => typeof a.cookie === 'string' && a.cookie.trim().length > 0);
      this.log('info', `accounts.json 已加载：${this._accountsFileAccounts.length} 个账号（文件账号优先）`);
    } catch (e) {
      this.log('warn', 'accounts.json 解析失败（沿用上次的账号）: ' + e.message);
    }
  }

  /** 合并后的全部账号（含 enabled:false 的停用账号），用于设置页展示与启停操作 */
  _allAccounts() {
    this._syncAccountsFile();
    const configAccounts = (this.cfg.accounts || []).map((a, i) => ({ ...a, id: a.id || `acc-${i + 1}` }));
    const merged = new Map();
    for (const a of configAccounts) merged.set(a.id, a);
    for (const a of this._accountsFileAccounts) merged.set(a.id, a); // 同 id 文件优先
    return [...merged.values()].filter(a => typeof a.cookie === 'string' && a.cookie.trim().length > 20);
  }

  _accounts() {
    return this._allAccounts().filter(a => a.enabled !== false);
  }

  /** 公开接口：全部账号（含停用），管理接口需要拿 Cookie 做覆盖写 */
  allAccounts() {
    return this._allAccounts();
  }

  /** 公开接口：某账号的运行态；管理接口换 Cookie 后清失效标记用 */
  accountState(id) {
    return this._accState(id);
  }

  _validAccounts() {
    const now = Date.now();
    return this._accounts().filter(a => this._accState(a.id).coolUntil <= now);
  }

  pickAccount(exclude) {
    const skip = exclude instanceof Set ? exclude : (exclude ? new Set([exclude]) : new Set());
    const pool = this._validAccounts().filter(a => !skip.has(a.id));
    if (pool.length === 0) return null;
    const now = Date.now();
    const notLimited = pool.filter(a => {
      const st = this._accState(a.id);
      st.lastReqTimes = (st.lastReqTimes || []).filter(t => now - t < 60000);
      return st.lastReqTimes.length < (this.cfg.rpmPerAccount ?? 6);
    });
    const usable = notLimited.length ? notLimited : pool;
    if ((this.cfg.strategy === 'random') && usable.length > 1) return usable[Math.floor(Math.random() * usable.length)];
    const idx = this.roundIndex % usable.length;
    this.roundIndex = (idx + 1) % usable.length;
    return usable[idx];
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

  /** 额度耗尽：冷却到北京时间次日零点（额度按自然日重置） */
  coolUntilMidnight(acc, reason) {
    const st = this._accState(acc.id);
    st.coolUntil = Date.now() + msUntilMidnightCN();
    st.lastError = reason;
    this._scheduleSave();
    const mins = Math.ceil((st.coolUntil - Date.now()) / 60000);
    this.log('warn', `账号 ${acc.id} 额度用尽，冷却至次日零点（约 ${mins} 分钟）：${reason}`);
  }

  markAuthError(acc, reason) {
    const st = this._accState(acc.id);
    st.authError = true;
    st.lastError = reason;
    this._scheduleSave();
    this.log('error', `账号 ${acc.id}(${acc.remark || ''}) Cookie 失效：${reason}`);
  }

  snapshot() {
    const base = this.cfg.dailyQuota ?? 200;
    const quota = isMondayCN() ? base * 2 : base; // 周一翻倍
    const today = dayKeyCN();
    // 注意：这里必须用 _allAccounts()，否则停用的账号在设置页里消失、再也点不回来
    return this._allAccounts().map(a => {
      const st = this._accState(a.id);
      const now = Date.now();
      if (st.day !== today) { st.day = today; st.dayReq = 0; st.dayChars = 0; }
      const todayReq = st.dayReq || 0;
      const enabled = a.enabled !== false;
      return {
        id: a.id, remark: a.remark || '', enabled,
        status: !enabled ? '已停用'
          : st.authError ? 'Cookie失效'
            : (st.coolUntil > now ? `冷却至 ${new Date(st.coolUntil).toLocaleTimeString('zh-CN')}` : '可用'),
        totalReq: st.totalReq || 0, totalChars: st.totalChars || 0,
        todayReq, todayChars: st.dayChars || 0,
        quotaLeftEst: Math.max(0, quota - todayReq),
        checkinToday: st.checkinDay === today ? (st.checkinResult || '') : '',
        checkinAt: st.checkinAt || 0,
        lastError: st.lastError || '',
      };
    });
  }

  /**
   * 健康检查：验证每个账号登录态。
   * 注意：/alice/profile/self 对有效 Cookie 也会返回 code:710010202「系统错误」（实测 2026-11-13），
   * 网页端调用它时额外带了 msToken/a_bogus 签名。改用无需签名的 quota/summary 判定登录态。
   */
  async checkAll() {
    const results = [];
    for (const a of this._accounts()) {
      try {
        const r = await fetch(this.baseUrl + '/alice/commerce/sale/subscription/quota/summary/?aid=497858&version_code=20800', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: a.cookie.trim(), 'user-agent': UA },
          body: '{}',
          signal: this._withTimeout(),
        });
        const t = await r.text();
        let code = null;
        try { code = JSON.parse(t).code; } catch (e) { /* HTML 等非 JSON */ }
        const ok = r.ok && code === 0 && !/<html/i.test(t.slice(0, 200));
        results.push({ id: a.id, remark: a.remark || '', ok, http: r.status, code });
        if (ok) {
          const st = this._accState(a.id);
          st.authError = false;
        } else if (r.status === 401 || code === 401) {
          this.markAuthError(a, 'quota/summary 登录态失效');
        }
      } catch (e) {
        results.push({ id: a.id, remark: a.remark || '', ok: false, error: e.message });
      }
    }
    return results;
  }

  // ---------- 每日签到（活动额度） ----------
  // PC 客户端点「立即签到」走的是 XHR 裸请求：query 不带 a_bogus/msToken，
  // 头部只需 content-type / accept / agw-js-conv，body 只有 scene。

  /** 活动接口通用 query（实测 21 项，缺项会被服务端拒绝） */
  _campaignQuery() {
    const u = this.cfg.upstream || {};
    return new URLSearchParams({
      aid: u.aid || '497858',
      real_aid: u.aid || '497858',
      device_id: u.device_id || '7707509248230065699',
      device_platform: 'web',
      doubao_device_platform: 'web',
      doubao_pc_version: u.pc_version || '3.45.5',
      language: u.language || 'zh',
      pc_version: u.pc_version || '3.45.5',
      pkg_type: 'release_version',
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
      runtime: 'web',
    }).toString();
  }

  /** 打活动接口（不带签名，保持与客户端一致的最短头部集） */
  async _postCampaign(account, apiPath, body) {
    const url = this.baseUrl + apiPath + '?' + this._campaignQuery();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          'agw-js-conv': 'str',
          cookie: account.cookie.trim(),
          'user-agent': UA,
        },
        body: JSON.stringify(body || {}),
        signal: this._withTimeout(),
      });
    } catch (e) {
      throw new DoubaoError('network', '活动接口网络错误: ' + e.message);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON（HTML 错误页等） */ }
    return { http: res.status, data, text };
  }

  /** 读取账号今日签到状态：/alice/ug/campaign/v3/detail/ 里 tasks[].daily_checkin.checked_in_today */
  async getCheckinStatus(account) {
    const { http, data } = await this._postCampaign(account, '/alice/ug/campaign/v3/detail/', {
      campaign_group_code: CHECKIN_SCENE,
    });
    if (http === 401 || (data && data.code === 401)) throw new DoubaoError('auth', '签到状态查询：登录态失效');
    if (!data || data.code !== 0) {
      const code = data && data.code !== undefined ? data.code : http;
      throw new DoubaoError('upstream', `签到状态查询失败 code=${code} ${(data && (data.message || data.msg)) || ''}`.trim());
    }
    const tasks = Array.isArray(data.data && data.data.tasks) ? data.data.tasks : [];
    const task = tasks.find(t => t && (t.daily_checkin || t.dailyCheckin)) || tasks[0] || null;
    const ck = task ? (task.daily_checkin || task.dailyCheckin) : null;
    const checkedInToday = ck ? !!(ck.checked_in_today !== undefined ? ck.checked_in_today : ck.checkedInToday) : false;
    return { checkedInToday, reward: ck ? (ck.reward || null) : null };
  }

  /**
   * 单账号签到：先查状态，未签才发 checkin。
   * 已签到/当日已失败过都不再重打接口——710010702 是服务端硬拒，重试无意义且易触发风控。
   */
  async checkin(account) {
    const st = this._accState(account.id);
    const today = dayKeyCN();
    const status = await this.getCheckinStatus(account);
    if (status.checkedInToday) {
      st.checkinDay = today;
      st.checkinAt = Date.now();
      st.checkinResult = 'already';
      this._scheduleSave();
      return { id: account.id, remark: account.remark || '', result: 'already', reward: status.reward };
    }
    if (st.checkinDay === today && st.checkinResult === 'failed') {
      return { id: account.id, remark: account.remark || '', result: 'skipped', error: st.lastError || '今日签到已失败，跳过重试' };
    }
    const { http, data } = await this._postCampaign(account, '/alice/ug/campaign/landing/checkin', { scene: CHECKIN_SCENE });
    const code = data && data.code !== undefined ? data.code : http;
    const ok = http === 200 && code === 0;
    const title = (data && data.data && ((data.data.complete_page_info || {}).title || (data.data.toast || {}).text)) || '';
    const msg = (data && (data.message || data.msg)) || '';
    st.checkinDay = today;
    st.checkinAt = Date.now();
    st.checkinResult = ok ? 'ok' : 'failed';
    if (!ok) st.lastError = `签到失败 code=${code} ${msg}`.trim();
    this._scheduleSave();
    return {
      id: account.id,
      remark: account.remark || '',
      result: ok ? 'ok' : 'failed',
      code,
      title,
      error: ok ? '' : `code=${code} ${msg}`.trim(),
      reward: status.reward,
    };
  }

  /** 全账号签到；单账号异常不影响其他账号 */
  async checkinAll(opts = {}) {
    const only = opts.id ? String(opts.id) : '';
    const results = [];
    for (const a of this._accounts()) {
      if (only && a.id !== only) continue;
      try {
        results.push(await this.checkin(a));
      } catch (e) {
        if (e.kind === 'auth') this.markAuthError(a, '签到接口登录态失效');
        results.push({ id: a.id, remark: a.remark || '', result: 'error', error: e.message });
      }
    }
    return results;
  }

  // ---------- 多轮上下文（conversation_id 复用，实测有效） ----------

  /**
   * 判断某对话能否复用已有 conversation_id。
   * 仅在消息「严格追加一条」时复用；历史被改写/压缩就新建，避免上下文错位。
   */
  reusableConversation(key, msgCount, lastReplyText) {
    if (!key || this.cfg.contextReuse === false) return null;
    const e = this.convMap.get(key);
    if (!e) return null;
    const ttlMs = (this.cfg.conversationTtlSec ?? 1800) * 1000;
    if (Date.now() - e.ts > ttlMs) { this.convMap.delete(key); return null; }
    if (msgCount !== e.msgCount + 1) return null;
    // 用上一轮我们实际返回的内容做一致性校验，防止两段不同对话首句相同而串号
    if (e.replyHash && shortHash(lastReplyText) !== e.replyHash) return null;
    return e.conversationId;
  }

  /**
   * 规划本轮能否复用上游会话，并算出发送起点。
   * 与 reusableConversation 的区别：不要求「严格追加一条」。
   * 宿主每轮常会重排消息、重注入上下文块，条数容易跳变；只要
   * ① 键相同且在 TTL 内 ② 条数没有回退 ③ 上一条 assistant 与上次返回一致，
   * 就判定为同一段对话，只发 msgCount 之后的新消息：既不复读历史，也不丢上下文。
   * @returns {{conversationId: string, fromIndex: number} | null}
   */
  planReuse(key, msgs, lastReplyText) {
    if (!key || this.cfg.contextReuse === false) return null;
    const e = this.convMap.get(key);
    if (!e) return null;
    const ttlMs = (this.cfg.conversationTtlSec ?? 1800) * 1000;
    if (Date.now() - e.ts > ttlMs) { this.convMap.delete(key); return null; }
    // 上一条 assistant 与上次返回不一致，说明宿主换了分支/重建了历史，不能复用
    if (e.replyHash && lastReplyText && shortHash(lastReplyText) !== e.replyHash) return null;
    const len = Array.isArray(msgs) ? msgs.length : 0;
    // 条数回退说明历史被截断/压缩，复用上游会话会缺内容，宁可整段重发
    if (!len || len <= e.msgCount) return null;
    // 上一轮只发到 user 为止，其后的 assistant 是上游生成的；本轮必须从这条回复之后开始，
    // 否则会把自己的回复当用户输入再发一遍
    let from = Math.min(e.msgCount, len - 1);
    while (from < len - 1 && msgs[from]?.role === 'assistant') from += 1;
    if (from >= len) return null;
    return { conversationId: e.conversationId, fromIndex: from };
  }

  rememberConversation(key, conversationId, msgCount, replyText) {
    if (!key || !conversationId) return;
    this.convMap.set(key, { conversationId, msgCount, ts: Date.now(), replyHash: shortHash(replyText) });
    this._scheduleSave();
    if (this.convMap.size > 100) {
      const oldest = [...this.convMap.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.convMap.delete(oldest[0]);
    }
  }

  // ---------- 模型目录 ----------

  models() {
    const extra = (this.cfg.extraModels || []).filter(m => m && m.id && m.modelItemKey);
    return [...BUILTIN_MODELS, ...extra];
  }

  resolveModelItemKey(modelId) {
    const id = String(modelId || '').trim();
    if (!id) return null;
    const list = this.models();
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_]+/g, '-');
    let m = list.find(x => x.id === id)
      || list.find(x => norm(x.id) === norm(id))
      || list.find(x => x.modelItemKey === id);
    if (!m && id.includes('/')) {
      // 宿主有时把「provider/model」整串传下来，取最后一段再匹配一次
      const tail = id.slice(id.lastIndexOf('/') + 1);
      m = list.find(x => x.id === tail) || list.find(x => norm(x.id) === norm(tail));
    }
    return m ? m.modelItemKey : null;
  }

  /** 当前插件实际支持的模型 id 列表（报错与面板排查用） */
  modelIds() {
    return this.models().map(m => m.id);
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
    return this.baseUrl + '/chat/completion?' + p.toString();
  }

  /** 合并"上游超时"与调用方取消信号，避免 SSE 卡死到 DSH 超时 */
  _withTimeout(signal) {
    const ms = this.cfg.requestTimeoutMs ?? 180000;
    const t = AbortSignal.timeout(ms);
    if (!signal) return t;
    try { return AbortSignal.any([signal, t]); } catch (e) { return signal; }
  }

  /** 查询单账号订阅额度（/alice/commerce/sale/subscription/quota/summary/，实测可用） */
  async getQuota(account) {
    let res;
    try {
      res = await fetch(this.baseUrl + '/alice/commerce/sale/subscription/quota/summary/?aid=497858&version_code=20800', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: account.cookie.trim(), 'user-agent': UA },
        body: '{}',
        signal: this._withTimeout(),
      });
    } catch (e) {
      throw new DoubaoError('network', '额度查询网络错误: ' + e.message);
    }
    const t = await res.text().catch(() => '');
    if (!res.ok) throw new DoubaoError(res.status === 401 ? 'auth' : 'upstream', '额度查询 HTTP ' + res.status);
    try { return JSON.parse(t); } catch (e) { throw new DoubaoError('upstream', '额度查询返回非 JSON'); }
  }

  _buildBody(text, modelItemKey, conversationId = '') {
    const now = Date.now();
    // 推理档位：0 = 上游逐块流式；≥1 = 上游先推理完再整段返回（无流式体感）
    const effort = Math.min(3, Math.max(0, Number(this.cfg.reasoningEffort ?? 0) || 0));
    return {
      client_meta: {
        local_conversation_id: conversationId || ('gw_' + uuid()), conversation_id: conversationId, bot_id: BOT_ID,
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
        unique_key: uuid(), start_seq: 0, need_create_conversation: !conversationId,
        conversation_init_option: { need_ack_conversation: true },
        conversation_init_ext: { model_item_key: modelItemKey, reasoning_effort: String(effort), mode_id: '3' },
        regen_query_id: [], edit_query_id: [], regen_instruction: '', no_replace_for_regen: false,
        message_from: 0, shared_app_name: '', shared_app_id: '',
        sse_recv_event_options: { support_chunk_delta: true }, support_lazy_fetch_stream: true,
        is_ai_playground: false, is_old_user: false, general_task_param: { server_do_compare: true },
        recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
        message_storage_type: 0, related_deleted_message_ids: {}, connector_info_list: [],
        model_config: { model_item_key: modelItemKey, model_extra_params: {}, reasoning_effort: effort },
        aggregate_params: {},
      },
    };
  }

  /**
   * 单账号单次上游调用
   * @param attempt 可选的外层记账对象 { text, conversationId }：流中途出错时，
   *   调用方（chat）靠它判断"已经吐出内容"，从而不再换号重发（重发会让用户看到重复文本）。
   * @returns {AsyncGenerator<string, {text: string, conversationId: string}>} AI 文本增量（return 值为全文）
   */
  async *chatOnce(account, modelItemKey, text, signal, conversationId = '', attempt = null) {
    const startedAt = Date.now();
    const st = this._accState(account.id);
    st.lastReqTimes = st.lastReqTimes || [];
    st.lastReqTimes.push(Date.now());
    st.totalReq++;
    this._scheduleSave();
    // 记账对象：让上层看到"已输出多少 / 服务端会话号是多少"
    const sink = attempt || { text: '', conversationId: '' };

    /** 归类中止：区分"调用方取消"和"上游超时"，两者在 DSH 里处置方式不同 */
    const abortKind = (e) => {
      if (signal?.aborted) return new DoubaoError('aborted', '请求已取消');
      if (e?.name === 'TimeoutError') return new DoubaoError('timeout', `上游超时（${this.cfg.requestTimeoutMs ?? 180000}ms）`);
      return null;
    };

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
        body: JSON.stringify(this._buildBody(text, modelItemKey, conversationId)),
        signal: this._withTimeout(signal),
      });
    } catch (e) {
      throw abortKind(e) || new DoubaoError('network', `上游网络错误: ${e.message}`);
    }

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const quotaHint = /quota|额度|exceed|insufficient|余额不足/i.test(t);
      const withHint = (err) => { err.retryAfter = retryAfter; err.body = t.slice(0, 300); return err; };
      if (res.status === 401) throw withHint(new DoubaoError('auth', '登录态失效 HTTP 401', 401));
      if (res.status === 429) throw withHint(new DoubaoError('ratelimit', `限流 HTTP 429: ${t.slice(0, 120)}`, 429));
      // 403 既可能是风控也可能是额度耗尽，按响应体措辞区分
      if (res.status === 403) {
        if (quotaHint) throw withHint(new DoubaoError('quota', `额度不足 HTTP 403: ${t.slice(0, 120)}`, 403));
        throw withHint(new DoubaoError('ratelimit', `风控/限流 HTTP 403: ${t.slice(0, 120)}`, 403));
      }
      if (quotaHint) throw withHint(new DoubaoError('quota', `额度不足 HTTP ${res.status}: ${t.slice(0, 120)}`, res.status));
      throw withHint(new DoubaoError('upstream', `上游错误 HTTP ${res.status}: ${t.slice(0, 120)}`, res.status));
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
    let ackConv = '';
    /** 累加并透出增量，同时写进上层记账对象 */
    const push = (t) => { full += t; sink.text = full; return t; };
    try {
      while (!ended) {
        if (signal?.aborted) throw new DoubaoError('aborted', '请求已取消');
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          throw abortKind(e) || new DoubaoError('network', `上游流读取中断: ${e.message}`);
        }
        const { done, value } = chunk;
        // flush 尾部残留字节，避免多字节字符被截断
        if (done) buf += dec.decode();
        else buf += dec.decode(value, { stream: true });
        // 兼容 CRLF 分帧的 SSE
        if (buf.includes('\r\n')) buf = buf.replace(/\r\n/g, '\n');
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
              if (typeof d.text === 'string' && d.text) yield push(d.text);
            } else if (evName === 'STREAM_CHUNK') {
              const d = JSON.parse(dataStr);
              for (const op of d.patch_op || []) {
                if (op.patch_object !== 1) continue;
                for (const b of op?.patch_value?.content_block || []) {
                  const t = b?.content?.text_block?.text;
                  if (typeof t === 'string' && t) yield push(t);
                }
              }
            } else if (evName === 'STREAM_MSG_NOTIFY') {
              const d = JSON.parse(dataStr);
              for (const b of d?.content?.content_block || []) {
                const t = b?.content?.text_block?.text;
                if (typeof t === 'string' && t) yield push(t);
              }
            } else if (evName === 'SSE_ACK') {
              // 记录服务端分配的 conversation_id，供下一轮复用上下文
              const d = JSON.parse(dataStr);
              const ci = d?.ack_client_meta?.conversation_info;
              if (ci?.conversation_id) { ackConv = String(ci.conversation_id); sink.conversationId = ackConv; }
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
    st.authError = false; // 换新 Cookie 后自动恢复，不再永久显示"失效"
    st.lastError = '';
    this._bumpDaily(account.id, full.length);
    this._scheduleSave();
    this.log('info', `上游完成 账号=${account.id} 字数=${full.length} 耗时=${ms}ms`, { acc: account.id, ms, chars: full.length });

    if (!full) throw new DoubaoError('empty', '上游未返回内容（可能触发风控/额度不足/参数被风）');
    sink.conversationId = ackConv || conversationId;
    return { text: full, conversationId: ackConv || conversationId };
  }

  /**
   * 带账号池调度与重试的完整调用
   * @returns {AsyncGenerator<string, string>} AI 文本增量（return 值为全文）
   */
  async *chat(modelId, text, signal, opts = {}) {
    // 记录宿主本轮实际下发的模型名，/doubao/status 与日志据此排查「切换模型没生效」
    this.lastModel = modelId || '';
    this.lastModelAt = Date.now();
    const modelItemKey = this.resolveModelItemKey(modelId);
    if (!modelItemKey) {
      throw new DoubaoError('upstream', `未知模型 ${modelId || '(空)'}：本插件只接豆包账号，可选模型为 ${this.modelIds().join(', ')}`);
    }
    this.log('info', `模型映射 ${modelId} -> ${modelItemKey}`);
    const maxAttempts = Math.max(1, this.cfg.maxAttempts ?? 2);
    const tried = new Set();
    let lastErr = null;
    await this._acquireSlot();
    try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acc = this.pickAccount(tried);
      if (!acc) {
        // 本轮已经真试过账号（并且把它冷却了）：报出真实原因，别用"全部冷却中"盖掉它
        if (lastErr) throw lastErr;
        const accounts = this._accounts();
        if (accounts.length === 0) throw new DoubaoError('noaccount', '没有可用账号：请检查 accounts 配置（cookie 是否已填、是否启用）');
        const st = this._accState(accounts[0].id);
        if (st.authError) throw new DoubaoError('auth', `账号 ${accounts[0].id} Cookie 失效，请在插件配置里更新`);
        const waitSec = Math.ceil((st.coolUntil - Date.now()) / 1000);
        throw new DoubaoError('ratelimit', waitSec > 0 ? `全部账号冷却中，约 ${waitSec}s 后重试` : '全部账号限速中，请稍后重试');
      }
      tried.add(acc.id);
      const wait = this._rpmWaitMs(acc);
      if (wait > 20000) {
        // 等太久不值得，直接换号，避免"超时就直接发"绕过单账号 RPM
        lastErr = new DoubaoError('ratelimit', '账号 ' + acc.id + ' 已达单账号 RPM 上限，约 ' + Math.ceil(wait / 1000) + 's 后可用');
        this.log('warn', '账号 ' + acc.id + ' 达到 RPM 上限，跳过换号');
        continue;
      }
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      // 每个账号一次记账：流中途失败时据此判断"是否已经吐字"，已吐字就不再换号重发
      const attempt = { text: '', conversationId: '' };
      try {
        const full = yield* this.chatOnce(acc, modelItemKey, text, signal, opts.conversationId || '', attempt);
        return full;
      } catch (e) {
        if (e instanceof DoubaoError) {
          lastErr = e;
          if (e.kind === 'aborted') throw e;
          if (attempt.text) {
            // 已经向调用方输出过内容：换号重发会导致重复文本，宁可截断并如实标记
            this.coolAccount(acc, this.cfg.shortCoolSeconds ?? 300, `流中断（已输出 ${attempt.text.length} 字）：${e.message}`);
            this.log('warn', `账号 ${acc.id} 流中断，保留已输出内容（${attempt.text.length} 字），不再换号重发`);
            return { text: attempt.text, conversationId: attempt.conversationId || opts.conversationId || '', truncated: true };
          }
          if (e.kind === 'auth') this.markAuthError(acc, e.message);
          else if (e.kind === 'quota') this.coolUntilMidnight(acc, e.message);
          else if (e.kind === 'ratelimit') {
            // 有 Retry-After 就按它冷却（最多 24h），否则用配置的长冷却
            const sec = e.retryAfter > 0 ? Math.min(e.retryAfter, 86400) : (this.cfg.coolSeconds ?? 86400);
            this.coolAccount(acc, sec, e.message);
          }
          else if (e.kind === 'upstream' || e.kind === 'empty' || e.kind === 'timeout') this.coolAccount(acc, this.cfg.shortCoolSeconds ?? 300, e.message);
          // network：不冷却，直接换号重试
          this.log('warn', `账号 ${acc.id} 尝试失败(${e.kind})：${e.message}，尝试下一个账号`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new DoubaoError('upstream', '所有尝试均失败');
    } finally {
      this._releaseSlot();
    }
  }
}

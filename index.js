/**
 * dsh-doubao-work —— 把豆包工作免费额度接入 DeepSeek Harness 的模型插件
 *
 * 装载后通过 ctx.llm.registerAdapter 注册 provider "doubao-work"，
 * 模型直接出现在 DSH 模型列表（如 deepseek-v4.1-flash / doubao-2.1-lite，0.01x 限时优惠）。
 *
 * Cookie 获取：云电脑/电脑浏览器登录 www.doubao.com 后，F12 → Network →
 * 任一请求 → Request Headers → 复制完整 Cookie 值，粘贴到插件配置的 cookie 字段。
 */

import { Schema, LlmAdapter, LlmError, resolvedFrom } from './host.js';
import { dataPaths } from './paths.js';
import { DoubaoClient, DoubaoError, BUILTIN_MODELS, conversationKey } from './doubao.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-doubao-work';
export const inject = ['llm'];

/** 宿主没解析到时退化成空基类：registerAdapter 只鸭子校验 providerInfo/stream */
const AdapterBase = LlmAdapter ?? class {};

// ---------------- 配置面板 ----------------

const AccountSchema = Schema && Schema.object({
  cookie: Schema.string().description('豆包网页版完整 Cookie（浏览器 F12 复制整行 Cookie 值）').default(''),
  remark: Schema.string().description('账号备注').default(''),
  enabled: Schema.boolean().description('启用此账号').default(true),
});

const ExtraModelSchema = Schema && Schema.object({
  id: Schema.string().description('模型 ID（DSH 中显示的调用名）').required(),
  name: Schema.string().description('显示名称').default(''),
  modelItemKey: Schema.string().description('豆包 model_item_key（抓包获取）').required(),
});

export const Config = Schema && Schema.object({
  accounts: Schema.array(AccountSchema).description('豆包账号池（支持多账号轮询）').default([]),
  strategy: Schema.union([
    Schema.const('round-robin').description('轮询'),
    Schema.const('random').description('随机'),
  ]).description('多账号调度策略').default('round-robin'),
  rpmPerAccount: Schema.number().description('单账号每分钟最大请求数').min(1).max(30).default(6),
  coolSeconds: Schema.number().description('限流/429 长冷却秒数（默认 24h，对应“第二天恢复”）').default(86400),
  shortCoolSeconds: Schema.number().description('5xx/空响应 短冷却秒数').default(300),
  maxAttempts: Schema.number().description('失败时换号重试次数').min(1).max(5).default(2),
  providerId: Schema.string().description('DSH 中的 provider 路由名').default('doubao-work'),
  providerName: Schema.string().description('DSH 中显示的提供方名称').default('豆包工作（免费额度）'),
  extraModels: Schema.array(ExtraModelSchema).description('扩展模型（后续抓到新 model_item_key 可加）').default([]),
  reasoningEffort: Schema.number().description('推理档位 0-3。0=真流式（推荐，边生成边到达）；1-3=先推理完再整段返回，质量更高但没有流式体感').min(0).max(3).default(0),
  contextReuse: Schema.boolean().description('复用豆包会话做多轮上下文（只在历史严格追加时复用，实测有效）').default(true),
  conversationTtlSec: Schema.number().description('会话复用有效期（秒），超时后新建会话').min(60).default(1800),

  // ---- 以下为上游/运行时参数：doubao.js 会读取，此前未在 Schema 声明，
  //      导致配置面板无法修改、README 承诺的 baseUrl 替换实际做不到 ----
  baseUrl: Schema.string().description('上游站点地址（默认豆包网页版；自测/自建镜像时替换）').default('https://www.doubao.com'),
  requestTimeoutMs: Schema.number().description('单次上游请求超时（毫秒）').min(1000).default(180000),
  globalMaxConcurrency: Schema.number().description('全局并发上限（避免同时打爆同一账号）').min(1).max(16).default(2),
  queueWaitMs: Schema.number().description('并发排队最长等待（毫秒），超时按限流报错').min(0).default(30000),
  dailyQuota: Schema.number().description('单账号每日额度估算基数（周一翻倍，仅用于面板推算，非官方数字）').min(1).default(200),
  adminToken: Schema.string().description('跨机管理令牌：仅在非本机访问管理接口时需要，留空则只允许本机调用').default(''),
  dataDir: Schema.string().description('Cookie 与用量状态的存放目录（留空用 <dshHome>/doubao-work；不要放插件目录，升级会被覆盖）').default(''),
  upstream: Schema.object({
    aid: Schema.string().description('应用 ID').default('497858'),
    device_id: Schema.string().description('设备 ID').default('7707509248230065699'),
    web_id: Schema.string().description('web_id').default('7707509253662393906'),
    tea_uuid: Schema.string().description('tea_uuid（空则回退 web_id）').default(''),
    fp: Schema.string().description('浏览器指纹 fp').default('verify_mwehdj77_p7te0LWd_xEFZ_4N2S_8jDq_L7Zl4uO5iI5F'),
    pc_version: Schema.string().description('PC 版本号').default('3.45.5'),
    version_code: Schema.string().description('version_code').default('20800'),
    region: Schema.string().description('区域').default('CN'),
    language: Schema.string().description('语言').default('zh'),
    tz_name: Schema.string().description('时区名').default('Asia/Shanghai'),
  }).description('上游设备参数（默认值取自实测抓包，通常无需改动）'),
});

/** 插件版本（与 package.json 同步，状态接口用于排障） */
export const VERSION = '1.2.5';

/**
 * 配置默认值。
 *
 * 正常情况下宿主用上面的 `Config` 校验补默认值；但插件从 profile 安装、宿主又解析不到
 * schemastery 时 `Config` 会是 undefined，`config.providerId` 这类字段就成了 undefined。
 * 这张表是那种情况下的兜底。测试会比对它与 `Config` 的默认值，防止两处漂移。
 */
export const DEFAULTS = {
  accounts: [],
  strategy: 'round-robin',
  rpmPerAccount: 6,
  coolSeconds: 86400,
  shortCoolSeconds: 300,
  maxAttempts: 2,
  providerId: 'doubao-work',
  providerName: '豆包工作（免费额度）',
  extraModels: [],
  reasoningEffort: 0,
  contextReuse: true,
  conversationTtlSec: 1800,
  baseUrl: 'https://www.doubao.com',
  requestTimeoutMs: 180000,
  globalMaxConcurrency: 2,
  queueWaitMs: 30000,
  dailyQuota: 200,
  adminToken: '',
  dataDir: '',
  upstream: {
    aid: '497858',
    device_id: '7707509248230065699',
    web_id: '7707509253662393906',
    tea_uuid: '',
    fp: 'verify_mwehdj77_p7te0LWd_xEFZ_4N2S_8jDq_L7Zl4uO5iI5F',
    pc_version: '3.45.5',
    version_code: '20800',
    region: 'CN',
    language: 'zh',
    tz_name: 'Asia/Shanghai',
  },
};

/** 补齐默认值（upstream 需要一层浅合并） */
export function withDefaults(config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  cfg.upstream = { ...DEFAULTS.upstream, ...(cfg.upstream || {}) };
  return cfg;
}

// ---------------- OpenAI Message → 豆包文本 ----------------

function blockText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

/**
 * 粗略 token 估算（只用于 usage 上报，不参与计费）。
 * 中文/全角约 1 字 1 token，ASCII 约 4 字符 1 token——比一律 length/4 更接近真实。
 */
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let wide = 0;
  for (const ch of s) if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) wide++;
  return Math.max(1, Math.ceil(wide + (s.length - wide) / 4));
}

/** DoubaoError.kind → DSH 的错误码（宿主靠 code 做重试/提示路由，不要自己发明语义） */
export const ERROR_CODES = {
  auth: 'AUTH',
  ratelimit: 'RATE_LIMIT',
  quota: 'QUOTA',
  noaccount: 'NO_ADAPTER',
  network: 'TRANSPORT',
  timeout: 'TIMEOUT',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
  upstream: 'SERVER',
};

/** DSH Message[] + system → 豆包单段文本（每次新建会话，需自带完整上下文） */
function messagesToText(options) {
  const msgs = options.messages || [];
  const roleOf = (m) => {
    if (m.role === 'assistant') return 'AI';
    if (m.role === 'system') return '系统';
    if (m.source?.kind === 'tool') return '工具结果';
    return '用户';
  };
  const last = msgs[msgs.length - 1];
  const lastText = last ? blockText(last.content) : '';
  // 单条用户消息直发（最常见 & 最稳）
  if (msgs.length === 1 && msgs[0].role === 'user' && !options.system) {
    return lastText;
  }
  const lines = [];
  if (options.system) lines.push(`系统: ${options.system}`);
  for (const m of msgs) {
    let text = blockText(m.content);
    if (m.source?.kind === 'tool') {
      text = text || JSON.stringify(m.content?.find(b => b.type === 'tool-result')?.content ?? '');
    }
    lines.push(`${roleOf(m)}: ${text}`);
  }
  return `以下是你（AI 助手）与用户的对话记录。请作为 AI 助手，直接回答用户最后一条消息，不要复述记录本身。\n\n${lines.join('\n\n')}\n\nAI:`;
}

// ---------------- LlmAdapter ----------------

export class DoubaoLlmAdapter extends AdapterBase {
  /** @param {{ client: DoubaoClient, config: object, log: Function }} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }
  providerInfo(provider) {
    return { id: provider, name: this.deps.config.providerName || '豆包工作（免费额度）' };
  }

  /**
   * 宿主侧重试策略：账号池内部已经做了换号重试与冷却，
   * 这里只允许宿主对"瞬时类"错误补一次机会；RATE_LIMIT 除外——
   * 换号冷却动辄数小时，宿主立刻重试只会再撞一次墙。
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TRANSPORT', 'TIMEOUT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 5000, jitterRatio: 0.2 },
    };
  }

  async listModels(provider) {
    return this.deps.client.models().map(m => ({
      provider,
      id: m.id,
      name: m.name,
      description: m.description || '',
      inputModalities: ['text'],
    }));
  }

  async resolveModel(provider, model, _signal) {
    const m = this.deps.client.models().find(x => x.id === model) || {
      id: model, name: model, description: '',
    };
    return {
      provider,
      id: m.id,
      name: m.name,
      description: m.description || '豆包工作模型（免费额度/0.01x）',
      inputModalities: ['text'],
      context: { contextWindow: 128000 },
    };
  }

  async *stream(options) {
    const { client, log } = this.deps;
    const model = options.model;

    // 多轮上下文：同一段对话（首条用户消息不变、消息严格追加）时复用豆包会话，
    // 只发最后一条，不必每次把历史拼成整段文本。
    const msgs = options.messages || [];
    const firstUser = msgs.find(m => m.role === 'user');
    const firstText = firstUser ? blockText(firstUser.content) : '';
    // 键用全文指纹而非前 200 字，避免开头相同的两个会话共用同一条上游会话（串号）
    const convKey = conversationKey(model, firstText);
    // 上一条 assistant 消息（用于校验"确实是同一段对话"）
    const prevReply = msgs.length >= 2 && msgs[msgs.length - 2]?.role === 'assistant'
      ? blockText(msgs[msgs.length - 2].content) : '';
    // 复用上游会话：只补发上次之后的新消息。宿主每轮会重排/重注入消息，条数常常跳变，
    // 旧实现要求「严格 +1 条」否则整段重开，表现为「每个对话都是新对话」。
    const plan = client.planReuse(convKey, msgs, prevReply);
    const reuseId = plan ? plan.conversationId : '';
    const tailMsgs = plan ? msgs.slice(plan.fromIndex) : msgs;
    const tailText = tailMsgs.map(m => blockText(m.content)).join('\n\n');
    const reuseOk = !!(reuseId && tailText.trim());
    const lastMsg = msgs[msgs.length - 1];
    const lastText = lastMsg ? blockText(lastMsg.content) : '';
    const text = reuseOk ? tailText : messagesToText(options);
    // 留痕给 /doubao/status：本轮到底复用没复用、从第几条开始发
    client.lastReuse = {
      reused: reuseOk,
      fromIndex: plan ? plan.fromIndex : -1,
      total: msgs.length,
      at: Date.now(),
    };
    if (options.tools?.length) {
      log('warn', `豆包工作接口不支持工具调用（本次请求带 ${options.tools.length} 个工具，已忽略）。该模型适合对话/写作类任务，不适合做 Agent 主循环模型。`);
    }
    const signal = options.signal;
    const startedAt = Date.now();

    let full = '';
    let first = true;
    let result = null;
    try {
      const gen = client.chat(model, text, signal, { conversationId: reuseId || '' });
      while (true) {
        const { value: delta, done } = await gen.next();
        if (done) { result = delta; full = delta?.text || full; break; }
        if (first) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          first = false;
        }
        full += delta;
        yield { type: 'text-delta', index: 0, text: delta };
      }
    } catch (e) {
      const kind = e instanceof DoubaoError ? e.kind : 'upstream';
      throw new LlmError(e.message || '豆包上游调用失败', ERROR_CODES[kind] || 'PROVIDER_ERROR', { status: e.status });
    }

    if (first) {
      // 没有任何增量就结束了
      throw new LlmError('豆包上游未返回内容', 'EMPTY_RESPONSE');
    }

    // 记住服务端分配的会话号，供下一轮复用
    if (result?.conversationId) client.rememberConversation(convKey, result.conversationId, msgs.length, full);

    yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
    // 复用会话时本次只发最后一条，但上游计费覆盖整段上下文，按全量估算更贴近真实消耗
    const ctxText = msgs.map(m => blockText(m.content)).join('\n') + (options.system || '');
    const tokens = { inputTokens: estimateTokens(ctxText || text), outputTokens: estimateTokens(full) };
    yield {
      type: 'usage',
      usage: { ...tokens, totalTokens: tokens.inputTokens + tokens.outputTokens },
    };
    // 流中断保底返回的部分文本，用 max-tokens 让宿主知道这一段不完整
    yield { type: 'finish', reason: { kind: result?.truncated ? 'max-tokens' : 'stop' } };
    if (result?.truncated) log('warn', `豆包流中断，返回了部分内容（${full.length} 字）`);
    log('info', `调用完成 模型=${model} 字数=${full.length} 耗时=${Date.now() - startedAt}ms`);
  }
}

// ---------------- 插件入口 ----------------

export function apply(ctx, rawConfig) {
  // Config 能导出时宿主已补过默认值；导出不了（解析不到 schemastery）时靠 DEFAULTS 兜底
  const config = withDefaults(rawConfig);
  const log = (level, msg, extra) => {
    try {
      const l = ctx.logger;
      if (l?.[level]) l[level](msg, extra ?? '');
      else console.log(`[dsh-doubao-work][${level}] ${msg}`);
    } catch (e) { console.log(`[dsh-doubao-work][${level}] ${msg}`); }
  };

  // 规范化账号 id（配置面板新增的账号可能没有 id）
  const accounts = (config.accounts || []).map((a, i) => ({ ...a, id: a.id || `acc-${i + 1}` }));

  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  // Cookie 与用量状态不放插件目录：profile 安装的插件在 node_modules 里，
  // 升级会被整目录重抄，Cookie 会丢。见 paths.js。
  let dshHome = '';
  try { dshHome = String(ctx?.get?.('dshHomePath') || ''); } catch (e) { /* 测试用的 ctx 没有这个服务 */ }
  const files = dataPaths({
    explicit: config.dataDir,
    dshHome,
    legacyDir: pluginDir,
    onMigrate: (msg) => log('info', msg),
  });
  const client = new DoubaoClient(
    { ...config, accounts },
    { statePath: files.statePath, accountsPath: files.accountsPath, log },
  );
  log('info', `数据目录：${files.dir}`);

  const models = client.models();
  log('info', `已注册 provider "${config.providerId}"：${models.map(m => m.id).join(', ')}｜账号 ${accounts.filter(a => a.enabled !== false).length} 个`);

  ctx.llm.registerAdapter([config.providerId], new DoubaoLlmAdapter({ client, config, log }));

  // ---------------- 状态接口（本机只读） ----------------
  // GET  /doubao/status  → 账号池 + 今日用量 + 会话数
  // POST /doubao/check   → 逐个账号做健康检查
  let statusRoutesRegistered = false;
  let statusRouteDisposers = [];

  /**
   * 拿到 webServer 才注册；重复调用安全。
   * 同时挂两个前缀：/doubao/*（精确）与 /api/doubao/*（部分宿主只派发 /api）。
   */
  const registerStatusRoutes = (web) => {
    if (statusRoutesRegistered) return;
    if (!web || typeof web.register !== 'function') return;
    statusRoutesRegistered = true;
    try {
      const rawRegister = (r) => web.register(r);
      const handlersByPath = {};
      const register = (r) => {
        if (r.kind === 'exact') handlersByPath[r.path] = r.handler;
        return rawRegister(r);
      };
      register({
        kind: 'exact',
        path: '/doubao/status',
        handler: (req, res) => {
          if (guard(req, res)) return;
          const snap = client.snapshot();
          const body = JSON.stringify({
            provider: config.providerId,
            models: client.models().map(m => m.id),
            accounts: snap,
            summary: {
              accounts: snap.length,
              usable: snap.filter(a => a.status === '可用').length,
              disabled: snap.filter(a => !a.enabled).length,
              todayReq: snap.reduce((s, a) => s + a.todayReq, 0),
              quotaLeftEst: snap.filter(a => a.enabled).reduce((s, a) => s + a.quotaLeftEst, 0),
            },
            conversations: client.convMap.size,
            contextReuse: config.contextReuse !== false,
            // 宿主包从哪来的：bare=常规解析；install:<dir>=从安装目录取（profile 安装的正常情况）
            runtime: { host: { ...resolvedFrom }, version: VERSION },
            // 诊断字段：宿主最近一次实际下发的模型名 + 会话复用情况
            lastModel: client.lastModel || '',
            lastModelAt: client.lastModelAt || 0,
            lastReuse: client.lastReuse || null,
          }, null, 2);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(body);
        },
      });
      const readAccountsFile = () => {
        try {
          const d = JSON.parse(fs.readFileSync(files.accountsPath, 'utf8').replace(/^﻿/, ''));
          return Array.isArray(d) ? d : (d.accounts || []);
        } catch (e) { return []; }
      };
      const writeAccountsFile = (list) => {
        const p = files.accountsPath;
        fs.writeFileSync(p, JSON.stringify({ accounts: list }, null, 2), { mode: 0o600 });
        try { fs.chmodSync(p, 0o600); } catch (e) { /* ignore */ }
      };
      const readBody = (req) => new Promise(resolve => {
        let b = '';
        req.on('data', c => { b += c; });
        req.on('end', () => resolve(b));
      });
      /** 解析 JSON 请求体；非法 JSON 返回 null（调用方回 400，别让异常冒到宿主） */
      const parseBody = async (req) => {
        try {
          const raw = await readBody(req);
          return raw.trim() ? JSON.parse(raw) : {};
        } catch (e) { return null; }
      };
      /**
       * 浏览器发起的跨源 POST 一定带 Origin；同源请求与命令行（curl / 运维脚本）没有。
       * 插件接口能增删账号、写文件，挡掉"任意网页访问本机插件口"这一类 CSRF。
       */
      /** 回环地址判定（含 IPv4-mapped IPv6 写法） */
      const isLoopback = (req) => {
        const a = String(req.socket?.remoteAddress || '');
        return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
      };
      const sameOrigin = (req) => {
        const origin = req.headers?.origin;
        if (origin) {
          try {
            const host = String(req.headers?.host || '').replace(/^https?:\/\//, '');
            return new URL(origin).host === host;
          } catch (e) { return false; }
        }
        // 没有 Origin 的不等于可信：只放行本机回环，跨机必须带上 adminToken。
        // 此前这里直接 return true，等于只防住浏览器，任意本地进程都能增删账号。
        if (isLoopback(req)) return true;
        const need = String(config.adminToken || '').trim();
        if (!need) return false;
        const got = String(req.headers?.['x-doubao-admin-token'] || '').trim();
        // 等长后逐字节异或比较，避免按前缀提前返回泄露令牌
        if (got.length !== need.length) return false;
        let diff = 0;
        for (let i = 0; i < need.length; i++) diff |= need.charCodeAt(i) ^ got.charCodeAt(i);
        return diff === 0;
      };
      const json = (res, code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj, null, 2));
      };
      const guard = (req, res) => {
        if (sameOrigin(req)) return false;
        json(res, 403, {
          error: '已拒绝请求：跨源访问，或非本机且未携带有效 x-doubao-admin-token。'
            + '本机（127.0.0.1）调用与同源浏览器请求不受影响。',
        });
        return true;
      };
      const ID_RE = /^[A-Za-z0-9_.\u4e00-\u9fa5-]{1,64}$/;

      register({
        kind: 'exact',
        path: '/doubao/account/enable',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body || typeof body.id !== 'string' || !ID_RE.test(body.id)) return json(res, 400, { error: 'id 非法' });
          const list = readAccountsFile();
          let a = list.find(x => x.id === body.id);
          if (!a) {
            // 账号来自插件配置面板（不在 accounts.json 里）：借它的 Cookie 建一条覆盖记录，
            // 这样"停用/启用"对配置面板账号同样生效（同 id 时文件账号优先）
            const known = client.allAccounts().find(x => x.id === body.id);
            if (!known) return json(res, 404, { error: 'not found', id: body.id });
            a = { id: known.id, remark: known.remark || '', cookie: known.cookie, enabled: true };
            list.push(a);
          }
          a.enabled = !!body.enabled;
          writeAccountsFile(list);
          json(res, 200, { ok: true, id: a.id, enabled: a.enabled });
        },
      });
      register({
        kind: 'exact',
        path: '/doubao/account/add',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body) return json(res, 400, { error: '请求体不是合法 JSON' });
          const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
          if (cookie.length < 20) return json(res, 400, { error: 'Cookie 太短，疑似无效' });
          const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 64) : '';
          const list = readAccountsFile();
          let id = typeof body.id === 'string' ? body.id.trim() : '';
          if (id && !ID_RE.test(id)) return json(res, 400, { error: 'id 只能包含字母数字下划线点和中文，最长 64' });
          if (!id) {
            let n = list.length + 1;
            while (list.some(a => a.id === `acc-${n}`)) n++;
            id = `acc-${n}`;
          }
          if (list.some(a => a.id === id)) return json(res, 409, { error: 'id 已存在：' + id });
          list.push({ id, remark, cookie, enabled: true });
          writeAccountsFile(list);
          json(res, 200, { ok: true, id });
        },
      });

      // 换 Cookie / 改备注（Cookie 过期是最常见的运维动作，不必删了再加）
      register({
        kind: 'exact',
        path: '/doubao/account/update',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body || typeof body.id !== 'string' || !ID_RE.test(body.id)) return json(res, 400, { error: 'id 非法' });
          const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
          if (body.cookie !== undefined && cookie.length < 20) return json(res, 400, { error: 'Cookie 太短，疑似无效' });
          const list = readAccountsFile();
          let a = list.find(x => x.id === body.id);
          if (!a) {
            const known = client.allAccounts().find(x => x.id === body.id);
            if (!known) return json(res, 404, { error: 'not found', id: body.id });
            a = { id: known.id, remark: known.remark || '', cookie: known.cookie, enabled: known.enabled !== false };
            list.push(a);
          }
          if (cookie) a.cookie = cookie;
          if (typeof body.remark === 'string') a.remark = body.remark.trim().slice(0, 64);
          a.enabled = true;
          writeAccountsFile(list);
          // Cookie 变了就清掉运行态的"失效"标记，下次调用立刻重试
          const st = client.accountState ? client.accountState(body.id) : null;
          if (st) { st.authError = false; st.lastError = ''; st.coolUntil = 0; }
          json(res, 200, { ok: true, id: a.id });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/account/remove',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body || typeof body.id !== 'string' || !ID_RE.test(body.id)) return json(res, 400, { error: 'id 非法' });
          writeAccountsFile(readAccountsFile().filter(x => x.id !== body.id));
          json(res, 200, { ok: true });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/check',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          try {
            const results = await client.checkAll();
            json(res, 200, { results });
          } catch (e) {
            json(res, 500, { error: e.message });
          }
        },
      });
      register({
        kind: 'exact',
        path: '/doubao/checkin',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body) return json(res, 400, { error: '请求体不是合法 JSON' });
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (id && !ID_RE.test(id)) return json(res, 400, { error: 'id 非法' });
          if (id && !client.allAccounts().some(a => a.id === id)) return json(res, 404, { error: 'not found', id });
          try {
            const results = await client.checkinAll({ id });
            const summary = {
              total: results.length,
              ok: results.filter(r => r.result === 'ok').length,
              already: results.filter(r => r.result === 'already').length,
              skipped: results.filter(r => r.result === 'skipped').length,
              failed: results.filter(r => r.result === 'failed' || r.result === 'error').length,
            };
            json(res, 200, { summary, results });
          } catch (e) {
            json(res, 500, { error: e.message });
          }
        },
      });
      register({
        kind: 'exact',
        path: '/doubao/checkin/status',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          if (!body) return json(res, 400, { error: '请求体不是合法 JSON' });
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (!id || !ID_RE.test(id)) return json(res, 400, { error: 'id 必填且需合法' });
          const acc = client.allAccounts().find(a => a.id === id);
          if (!acc) return json(res, 404, { error: 'not found', id });
          try {
            const status = await client.getCheckinStatus(acc);
            json(res, 200, { id, ...status });
          } catch (e) {
            json(res, 500, { error: e.message });
          }
        },
      });
      // /api 前缀别名：部分宿主只把 /api/* 派发给插件
      web.register({
        kind: 'prefix',
        path: '/api/doubao',
        handler: (req, res) => {
          const u = new URL(req.url, 'http://localhost');
          const rest = u.pathname.replace(/^\/api\/doubao/, '');
          const target = '/doubao' + (rest || '/status');
          const h = handlersByPath[target];
          if (!h) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: 'not found', path: u.pathname }));
          }
          return h(req, res);
        },
      });
      log('info', '状态接口已注册：/doubao/* 与 /api/doubao/*');
    } catch (e) {
      statusRoutesRegistered = false;
      log('warn', '状态接口注册失败：' + e.message);
    }
  };

  // webServer 在 apply 阶段往往还没 ready（实测 ctx.get 此时为 undefined），
  // 所以：① 声明可选依赖，等它 ready 后回调；② 再用轮询兜底，确保只注册一次。
  try {
    if (typeof ctx.inject === 'function') {
      // 与 dsh-free-model 相同的写法：apply 时 webServer 还没 provide，
      // 声明依赖后 cordis 会在服务就绪时回调，用 scoped.effect 管注册生命周期。
      ctx.inject(['webServer'], (scoped) => {
        try {
          const server = scoped.webServer;
          scoped.effect(() => {
            registerStatusRoutes(server);
            return () => { statusRoutesRegistered = false; };
          }, 'dsh-doubao-work: status routes');
        } catch (e) { log('warn', '延迟注入注册失败：' + e.message); }
      });
    }
  } catch (e) { log('warn', 'ctx.inject 不可用：' + e.message); }

  try {
    if (!statusRoutesRegistered) {
      const poll = () => {
        if (statusRoutesRegistered) return true;
        let web;
        try { web = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined; } catch (e) { web = undefined; }
        if (web && typeof web.register === 'function') { registerStatusRoutes(web); return true; }
        return false;
      };
      if (!poll()) {
        const timer = setInterval(() => { if (poll()) clearInterval(timer); }, 1000);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  } catch (e) { log('warn', '状态接口兜底注册失败：' + e.message); }

  // 进程退出时落盘状态。
  // 不再接管 SIGINT：插件无权替宿主决定 Ctrl+C 的行为（此前 flush 后直接 process.exit(0)，
  // 等于插件替 DSH 强杀进程），且每次 apply 都注册会让监听器在热重载时累积。
  if (!globalThis.__dshDoubaoFlushers) {
    globalThis.__dshDoubaoFlushers = new Set();
    process.once('exit', () => {
      for (const f of globalThis.__dshDoubaoFlushers) { try { f(); } catch (e) { /* ignore */ } }
    });
  }
  globalThis.__dshDoubaoFlushers.add(() => client.flushState());
}

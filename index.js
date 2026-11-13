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
import { parseCookieInput, describeParse } from './cookie-input.js';
import { candidateBrowsers, launchBrowser, grabDoubao, closeBrowser, loginAssist, openCheckinPage } from './browser.js';
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
  itemId: Schema.number().description('模型 item_id（网页版 option.need_deep_think 的值，决定真正用哪个模型；4.1 flash=10001）').default(0),
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
  sendSystemPrompt: Schema.boolean().description('把宿主的系统提示词（含工具说明）也发给豆包。默认关闭：豆包用不到这些工具，白吃额度还会泄露本机信息').default(false),
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
  browserPath: Schema.string().description('「从浏览器导入」用的浏览器可执行文件路径（留空自动探测 Edge/Chrome/Chromium）').default(''),
  checkinSchedule: Schema.string().description('每日自动签到的本地时刻，形如 "09:30"；留空表示不自动签到').default(''),
  checkinCatchUp: Schema.boolean().description('DSH 启动时若已过签到时刻且今天还没签到，补跑一次').default(true),
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
export const VERSION = '1.5.3';

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
  sendSystemPrompt: false,
  conversationTtlSec: 1800,
  baseUrl: 'https://www.doubao.com',
  requestTimeoutMs: 180000,
  globalMaxConcurrency: 2,
  queueWaitMs: 30000,
  dailyQuota: 200,
  adminToken: '',
  dataDir: '',
  browserPath: '',
  checkinSchedule: '',
  checkinCatchUp: true,
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

// ---------------- 每日签到定时器 ----------------

/** 解析 "HH:MM"；不合法返回 null（不合法就不该起定时器） */
export function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** 距离下一个 "HH:MM" 还有多少毫秒（今天的已过就算明天） */
export function msUntilNextClock(text, now = Date.now()) {
  const c = parseClock(text);
  if (!c) return null;
  const d = new Date(now);
  d.setHours(c.h, c.m, 0, 0);
  let delta = d.getTime() - now;
  if (delta <= 0) delta += 24 * 3600 * 1000;
  return delta;
}

/** 今天的 "HH:MM" 是否已经过去（冷启动补跑判定用） */
export function clockPassedToday(text, now = Date.now()) {
  const c = parseClock(text);
  if (!c) return false;
  const d = new Date(now);
  d.setHours(c.h, c.m, 0, 0);
  return now >= d.getTime();
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
export function estimateTokens(text) {
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
export function messagesToText(options) {
  const msgs = options.messages || [];
  // 宿主的系统提示词（含工具说明）默认不透传：豆包那边既用不到这些工具，
  // 又白吃额度、把本机环境细节漏给第三方页面。要透传再开 sendSystemPrompt。
  const keepSystem = options.sendSystemPrompt === true;
  const system = keepSystem ? String(options.system || '') : '';
  const roleOf = (m) => {
    if (m.role === 'assistant') return 'AI';
    if (m.role === 'system') return '系统';
    if (m.source?.kind === 'tool') return '工具结果';
    return '用户';
  };
  const last = msgs[msgs.length - 1];
  const lastText = last ? blockText(last.content) : '';
  // 单条用户消息直发（最常见 & 最稳）
  if (msgs.length === 1 && msgs[0].role === 'user' && !system) {
    return lastText;
  }
  const lines = [];
  if (system) lines.push(`系统: ${system}`);
  for (const m of msgs) {
    if (m.role === 'system' && !keepSystem) continue;
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
    const text = reuseOk ? tailText : messagesToText({ ...options, sendSystemPrompt: this.deps.config.sendSystemPrompt === true });
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
  try {
    // 宿主注册的是函数 dshHomePath(...segments)，不是字符串：直接 String() 会把函数源码
    // 当成目录名（表现为 accounts.json 落到 "...function dshHomePath..." 这种路径下 → ENOENT）
    const v = ctx?.get?.('dshHomePath');
    if (typeof v === 'function') dshHome = String(v() || '').trim();
    else if (typeof v === 'string') dshHome = v.trim();
  } catch (e) { /* 测试用的 ctx 没有这个服务 */ }
  if (dshHome && /[\r\n]|function\s|=>/.test(dshHome)) {
    // 兜底：拿到的不是路径就当没拿到，落回 ~/.dsh/doubao-work
    log('warn', 'dshHomePath 返回的不是路径，改用 ~/.dsh');
    dshHome = '';
  }
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

  // ---------------- 每日自动签到 ----------------
  /** 排定状态，给 /doubao/status 与面板显示「下次几点签」用 */
  const checkinState = { schedule: '', nextAt: 0 };
  // 配置 checkinSchedule: "09:30" 后：到点全账号签到；DSH 重启时若已过点且今天还有账号没签，补跑一次
  //（checkinCatchUp）。结果写进账号状态（checkinToday 字段），面板与 /doubao/checkin/status 都可见。
  const runScheduledCheckin = async (why) => {
    try {
      const results = await client.checkinAll();
      const okN = results.filter(r => r.result === 'ok').length;
      const alreadyN = results.filter(r => r.result === 'already').length;
      const failN = results.filter(r => r.result === 'failed' || r.result === 'error').length;
      log('info', `定时签到（${why}）：成功 ${okN}｜已签过 ${alreadyN}｜失败 ${failN}`);
    } catch (e) { log('warn', `定时签到（${why}）失败：${e.message}`); }
  };
  // 热重载时同一个 provider 只保留一个定时器，否则每次 apply 都会多排一份
  if (!globalThis.__dshDoubaoCheckinTimers) globalThis.__dshDoubaoCheckinTimers = {};
  const timerKey = String(config.providerId);
  if (globalThis.__dshDoubaoCheckinTimers[timerKey]) clearTimeout(globalThis.__dshDoubaoCheckinTimers[timerKey]);
  checkinState.schedule = String(config.checkinSchedule || '');
  checkinState.nextAt = 0;
  if (parseClock(config.checkinSchedule)) {
    const arm = () => {
      const delta = msUntilNextClock(config.checkinSchedule);
      if (delta === null) return;
      checkinState.nextAt = Date.now() + delta;
      const t = setTimeout(async () => {
        delete globalThis.__dshDoubaoCheckinTimers[timerKey];
        await runScheduledCheckin('到点');
        arm();
      }, delta);
      if (typeof t.unref === 'function') t.unref(); // 不该让插件的定时器拖着宿主不退出
      globalThis.__dshDoubaoCheckinTimers[timerKey] = t;
    };
    arm();
    if (config.checkinCatchUp !== false && clockPassedToday(config.checkinSchedule)) {
      const enabled = client.snapshot().filter(a => a.enabled !== false);
      const done = enabled.filter(a => a.checkinToday === 'ok' || a.checkinToday === 'already');
      if (enabled.length && done.length < enabled.length) {
        log('info', `已过签到时刻 ${config.checkinSchedule}，还有 ${enabled.length - done.length} 个账号没签，15 秒后补跑`);
        const t = setTimeout(() => runScheduledCheckin('补跑'), 15000);
        if (typeof t.unref === 'function') t.unref();
      } else if (!enabled.length) {
        log('info', `每日签到已排定 ${config.checkinSchedule}（当前没有启用账号，等账号就绪后自动执行）`);
      }
    }
    log('info', `每日自动签到：${config.checkinSchedule}（下次 ${new Date(checkinState.nextAt).toLocaleString('zh-CN')}）`);
  }


  // ---------------- 状态接口（本机只读） ----------------
  // GET  /doubao/status  → 账号池 + 今日用量 + 会话数
  // POST /doubao/check   → 逐个账号做健康检查
  let statusRoutesRegistered = false;
  let statusRouteDisposers = [];
  /** 「从浏览器导入」拉起的浏览器窗口句柄（pid / 调试端口 / 临时 profile），同一次 apply 内复用 */
  let browserHandle = null;
  // 登录助手 + 自动导入：登录完成后不用再点「抓取」，后台自己把 Cookie 收进账号池
  const loginWatch = { state: 'idle', startedAt: 0, attempts: 0, lastReason: '', account: '', importedAt: 0 };
  // 入库函数定义在「注册路由」那段作用域里（依赖 accounts 文件的读写助手），这里用钩子接过来，
  // 免得把账号文件逻辑复制一份
  let saveAccountCookieImpl = null;
  let loginWatchTimer = null;
  const stopLoginWatch = () => { if (loginWatchTimer) { clearTimeout(loginWatchTimer); loginWatchTimer = null; } };
  const summarizeForm = (form) => ({
    url: form?.url || '',
    inputs: (form?.inputs || []).length,
    types: (form?.inputs || []).map(i => i.type || 'text'),
    hasSendButton: !!form?.sendBtn,
    hasSubmitButton: !!form?.submitBtn,
    pageText: String(form?.text || '').slice(0, 120),
  });
  const startLoginWatch = (port, why) => {
    stopLoginWatch();
    loginWatch.state = 'watching';
    loginWatch.startedAt = Date.now();
    loginWatch.attempts = 0;
    loginWatch.account = '';
    loginWatch.importedAt = 0;
    loginWatch.lastReason = '等待登录完成…';
    const deadline = Date.now() + 5 * 60 * 1000;
    const tick = async () => {
      loginWatchTimer = null;
      if (loginWatch.state !== 'watching') return;
      loginWatch.attempts += 1;
      try {
        const r = await grabDoubao({ port });
        if (r.ok) {
          const parsed = parseCookieInput(r.cookie);
          if (!saveAccountCookieImpl) throw new Error('账号入库函数还没就绪（webServer 未注册？）');
          const saved = saveAccountCookieImpl(parsed.cookie, { remark: '从浏览器登录导入' });
          loginWatch.state = 'done';
          loginWatch.account = saved.id;
          loginWatch.importedAt = Date.now();
          loginWatch.lastReason = `已导入账号 ${saved.id}`;
          log('info', `登录完成，已自动导入账号 ${saved.id}（${why}）`);
          try { await closeBrowser(browserHandle || { port }); browserHandle = null; } catch (e) { /* 关不掉就算了 */ }
          return;
        }
        loginWatch.lastReason = r.reason || r.stage || '还没检测到登录态';
      } catch (e) {
        loginWatch.lastReason = String(e.message || e);
      }
      if (Date.now() > deadline) {
        loginWatch.state = 'timeout';
        loginWatch.lastReason = '等了 5 分钟还没检测到登录态，请在窗口里完成登录后点「抓取 Cookie（并入库）」';
        log('warn', '自动导入等待超时');
        return;
      }
      loginWatchTimer = setTimeout(tick, 2500);
      loginWatchTimer.unref?.();
    };
    loginWatchTimer = setTimeout(tick, 2000);
    loginWatchTimer.unref?.();
  };

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
            // 每日签到排定状态（checkinSchedule 为空表示未启用自动签到）
            checkinSchedule: checkinState.schedule,
            checkinNextAt: checkinState.nextAt,
            // 账号文件到底在哪：面板空态文案与排障都要用它（1.2.5 起不再在插件目录）
            dataDir: files.dir,
            accountsPath: files.accountsPath,
            // 登录助手的自动导入状态（面板轮询它显示「已登录并自动导入」）
            loginWatch: {
              state: loginWatch.state,
              account: loginWatch.account,
              attempts: loginWatch.attempts,
              reason: loginWatch.lastReason,
            },
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
          // 粘贴内容不再要求「只有整段 Cookie 这一种形状」：cURL / 请求头 / JSON / cookies.txt
          // 先统一解析成规范串，再入库（见 cookie-input.js）
          const parsed = parseCookieInput(body.cookie);
          if (!parsed.pairs) {
            return json(res, 400, { error: '没能从粘贴内容里解析出任何 Cookie 字段', format: parsed.format, warnings: parsed.warnings });
          }
          if (parsed.cookie.length < 20) {
            return json(res, 400, { error: `Cookie 太短（${parsed.cookie.length} 字符），疑似无效`, format: parsed.format, warnings: parsed.warnings });
          }
          const cookie = parsed.cookie;
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
          // 把识别结果回给面板：用户粘的是 cURL 还是整段 Cookie，提取了几个字段，有什么要注意
          json(res, 200, { ok: true, id, parse: { format: parsed.format, pairs: parsed.pairs, describe: describeParse(parsed), warnings: parsed.warnings } });
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
          // 换 Cookie 走同一套识别：cURL / 请求头 / JSON / cookies.txt 都能直接贴
          const parsed = body.cookie === undefined ? null : parseCookieInput(body.cookie);
          if (parsed) {
            if (!parsed.pairs) return json(res, 400, { error: '没能从粘贴内容里解析出任何 Cookie 字段', format: parsed.format, warnings: parsed.warnings });
            if (parsed.cookie.length < 20) return json(res, 400, { error: `Cookie 太短（${parsed.cookie.length} 字符），疑似无效`, format: parsed.format, warnings: parsed.warnings });
          }
          const cookie = parsed ? parsed.cookie : '';
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
          json(res, 200, { ok: true, id: a.id, parse: parsed ? { format: parsed.format, pairs: parsed.pairs, describe: describeParse(parsed), warnings: parsed.warnings } : null });
        },
      });

      // ---------------- 从浏览器导入（CDP） ----------------
      // 为什么不读浏览器 Cookie 库：Chrome/Edge 127+ 的 App-Bound Encryption 让第三方解不开，
      // macOS 要 Keychain、Linux 要 Secret Service，各内核路径还不一样。CDP 走浏览器自己的
      // 调试端口，跨平台、跨内核，且拿得到 HttpOnly 的 sessionid/sid_guard。

      /** 抓到的 Cookie 入库：给了 id 就更新（没有则新建），没给 id 时按 Cookie 去重 */
      const saveAccountCookie = (cookie, { id, remark } = {}) => {
        const list = readAccountsFile();
        if (id) {
          let a = list.find(x => x.id === id);
          let created = false;
          if (!a) {
            const known = client.allAccounts().find(x => x.id === id);
            a = known
              ? { id: known.id, remark: known.remark || '', cookie: known.cookie, enabled: known.enabled !== false }
              : { id, remark: (remark || '').trim().slice(0, 64), cookie, enabled: true };
            list.push(a);
            created = true;
          }
          a.cookie = cookie;
          if (typeof remark === 'string' && remark.trim()) a.remark = remark.trim().slice(0, 64);
          a.enabled = true;
          writeAccountsFile(list);
          return { id: a.id, created };
        }
        const same = list.find(x => x.cookie === cookie);
        if (same) return { id: same.id, existing: true };
        let n = list.length + 1;
        while (list.some(a => a.id === `acc-${n}`)) n++;
        const newId = `acc-${n}`;
        list.push({ id: newId, remark: (remark || '').trim().slice(0, 64), cookie, enabled: true });
        writeAccountsFile(list);
        return { id: newId, created: true };
      };
      // 交给登录后的自动导入用（见 startLoginWatch）
      saveAccountCookieImpl = saveAccountCookie;

      register({
        kind: 'exact',
        path: '/doubao/browser/browsers',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const list = candidateBrowsers();
          json(res, 200, { browsers: list.map(b => ({ id: b.id, name: b.name, path: b.path })), configured: String(config.browserPath || '') });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/browser/launch',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = (await parseBody(req)) || {};
          try {
            // 已经拉起过就先复用：重复点「从浏览器导入」不该开一堆窗口
            if (browserHandle && browserHandle.port) {
              const alive = await grabDoubao({ port: browserHandle.port }).then(r => r.stage !== 'probe').catch(() => false);
              if (alive) return json(res, 200, { ok: true, reused: true, ...browserHandle });
            }
            browserHandle = await launchBrowser({
              browserId: typeof body.browserId === 'string' ? body.browserId : '',
              browserPath: String(body.browserPath || config.browserPath || ''),
              port: Number(body.port) || 0,
              startUrl: typeof body.startUrl === 'string' && body.startUrl ? body.startUrl : undefined,
            });
            // 打开后就开始等：无论你在窗口里自己登录，还是用面板的登录助手，
            // 一旦检测到登录态就自动入库，不用再点「抓取」
            startLoginWatch(browserHandle.port, '打开导入窗口后');
            json(res, 200, {
              ok: true,
              ...browserHandle,
              hint: '已打开一个独立的浏览器窗口（临时配置，不影响你日常浏览）。在里面用手机号/扫码登录豆包，登录成功会自动导入，不用再点抓取。',
            });
          } catch (e) {
            json(res, 500, { ok: false, error: String(e.message || e) });
          }
        },
      });

      // 用豆包客户端 UA 打开签到页：这一页只在客户端里给签到按钮（页面读 UA 尾巴的 SamanthaDoubao/<版本>）
      register({
        kind: 'exact',
        path: '/doubao/checkin/open',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = (await parseBody(req)) || {};
          try {
            const list = client.allAccounts().filter(a => a.enabled !== false);
            const acc = (typeof body.id === 'string' && list.find(a => a.id === body.id)) || list[0];
            if (!acc) return json(res, 400, { ok: false, error: '没有可用账号（先导入一个 Cookie）' });
            if (!browserHandle || !browserHandle.port) {
              browserHandle = await launchBrowser({
                browserId: typeof body.browserId === 'string' ? body.browserId : '',
                browserPath: String(body.browserPath || config.browserPath || ''),
                port: Number(body.port) || 0,
                startUrl: 'about:blank',
              });
            }
            const r = await openCheckinPage({ port: browserHandle.port, cookie: acc.cookie });
            json(res, r.ok ? 200 : 500, {
              ...r,
              account: acc.id,
              hint: r.ok
                ? (r.hasCheckinButton
                  ? '已用豆包客户端身份打开签到页，直接点「立即签到」。'
                  : '页面打开了，但没看到签到按钮——这个号的 Cookie 可能已失效，先在面板里更新 Cookie。')
                : '浏览器窗口没连上，重试一次或先点「从浏览器导入」把窗口拉起来。',
            });
          } catch (e) {
            json(res, 500, { ok: false, error: String(e.message || e) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/browser/grab',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = (await parseBody(req)) || {};
          const port = Number(body.port) || (browserHandle && browserHandle.port) || 9222;
          try {
            const r = await grabDoubao({ port });
            if (!r.ok) return json(res, 200, { ok: false, stage: r.stage, reason: r.reason, doubaoCookies: r.doubaoCookies ?? 0, keys: r.keys || [] });
            const parsed = parseCookieInput(r.cookie);
            const out = {
              ok: true,
              stage: 'done',
              browser: r.browser,
              doubaoCookies: r.doubaoCookies,
              httpOnly: r.httpOnly.length,
              keys: r.keys,
              describe: describeParse(parsed),
              warnings: parsed.warnings,
            };
            // save 缺省为 true：面板点一次就应该入库；工具/路由只要 Cookie 时传 save:false
            if (body.save !== false) {
              const id = typeof body.id === 'string' ? body.id.trim() : '';
              if (id && !ID_RE.test(id)) return json(res, 400, { ok: false, error: 'id 只能包含字母数字下划线点和中文，最长 64' });
              const saved = saveAccountCookie(parsed.cookie, { id, remark: typeof body.remark === 'string' ? body.remark : '' });
              out.id = saved.id;
              out.created = !!saved.created;
              out.existing = !!saved.existing;
            }
            json(res, 200, out);
          } catch (e) {
            json(res, 500, { ok: false, error: String(e.message || e) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/browser/login',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = (await parseBody(req)) || {};
          const action = ['probe', 'open', 'phone', 'code'].includes(String(body.action)) ? String(body.action) : 'probe';
          const port = Number(body.port) || (browserHandle && browserHandle.port) || 9222;
          try {
            const r = await loginAssist({
              port,
              action,
              phone: typeof body.phone === 'string' ? body.phone : '',
              code: typeof body.code === 'string' ? body.code : '',
            });
            if (r.stage === 'sent' || r.stage === 'submitted' || r.stage === 'pending') {
              startLoginWatch(port, '登录助手');
            }
            json(res, 200, {
              ok: !!r.ok,
              stage: r.stage,
              steps: r.steps || [],
              // 只回表单形状，不回填进去的手机号/验证码
              form: summarizeForm(r.form),
              port,
            });
          } catch (e) {
            const msg = String(e.message || e);
            const hint = !browserHandle && !Number(body.port)
              ? '还没打开导入窗口：先点「从浏览器导入」，或把 port 传进来'
              : (/fetch failed|ECONNREFUSED/i.test(msg) ? '调试端口没响应：窗口可能被关了，重新点一次「从浏览器导入」' : msg);
            json(res, 500, { ok: false, error: hint, port });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/browser/wait',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          json(res, 200, {
            ok: true,
            state: loginWatch.state,
            attempts: loginWatch.attempts,
            account: loginWatch.account,
            imported: loginWatch.state === 'done',
            sinceMs: loginWatch.startedAt ? Date.now() - loginWatch.startedAt : 0,
            reason: loginWatch.lastReason,
          });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/browser/close',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          try {
            stopLoginWatch();
            if (loginWatch.state === 'watching') loginWatch.state = 'closed';
            const r = await closeBrowser(browserHandle || {});
            browserHandle = null;
            json(res, 200, r);
          } catch (e) {
            json(res, 500, { ok: false, error: String(e.message || e) });
          }
        },
      });

      // ---------------- 账号包导出 / 导入（手机同步、备份、多机迁移） ----------------
      /** 只收「有 Cookie 且 Cookie 能规范化」的账号；Cookie 字段本身也走粘贴解析器，容错 */
      const normalizeImported = (raw) => {
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.accounts) ? raw.accounts : null);
        if (!list) return null;
        const out = [];
        for (const a of list) {
          if (!a || typeof a.cookie !== 'string' || !a.cookie.trim()) continue;
          const parsed = parseCookieInput(a.cookie);
          const cookie = parsed.pairs ? parsed.cookie : a.cookie.trim();
          if (cookie.length < 20) continue;
          out.push({
            id: typeof a.id === 'string' ? a.id : '',
            remark: typeof a.remark === 'string' ? a.remark : '',
            cookie,
            enabled: a.enabled !== false,
          });
        }
        return out;
      };

      register({
        kind: 'exact',
        path: '/doubao/accounts/export',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const list = readAccountsFile().map(a => ({ id: a.id, remark: a.remark || '', cookie: a.cookie, enabled: a.enabled !== false }));
          // json 字段就是可直接落盘的账号包文本：手机端/另一台机器拿它去 `import` 即可
          json(res, 200, { ok: true, count: list.length, accounts: list, json: JSON.stringify({ accounts: list }, null, 2) });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/accounts/import',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          const text = typeof body?.text === 'string' ? body.text.trim() : '';
          if (!text) return json(res, 400, { ok: false, error: '需要 text：导出的账号包 JSON，或一段 Cookie / `Cookie:` 头 / cURL / 扩展导出的 JSON' });
          // 先按账号包解析；不是 JSON 就退回「单个 Cookie」粘贴解析，两种形态共用一条入口
          let incoming = null;
          try { incoming = normalizeImported(JSON.parse(text)); } catch { /* 不是 JSON */ }
          if (incoming === null) {
            const p = parseCookieInput(text);
            if (!p.pairs || p.cookie.length < 20) {
              return json(res, 400, { ok: false, error: '既不是账号包 JSON，也没识别出 Cookie：' + (p.warnings || []).join('；') });
            }
            incoming = [{ id: '', remark: '', cookie: p.cookie, enabled: true }];
          }
          if (!incoming.length) return json(res, 400, { ok: false, error: '账号包里没有可用账号（Cookie 为空或太短）' });
          const mode = body?.mode === 'replace' ? 'replace' : 'merge';
          const current = mode === 'replace' ? [] : readAccountsFile();
          let added = 0, updated = 0, skipped = 0;
          for (const a of incoming) {
            const id = a.id && ID_RE.test(a.id) ? a.id : '';
            const i = current.findIndex(x => (id ? x.id === id : x.cookie === a.cookie));
            if (i >= 0) {
              current[i] = { ...current[i], cookie: a.cookie, enabled: a.enabled, ...(a.remark ? { remark: a.remark } : {}) };
              updated++;
            } else if (!id && current.some(x => x.cookie === a.cookie)) {
              skipped++;
            } else {
              let newId = id;
              if (!newId) { let n = current.length + 1; while (current.some(x => x.id === `acc-${n}`)) n++; newId = `acc-${n}`; }
              current.push({ id: newId, remark: a.remark || '', cookie: a.cookie, enabled: a.enabled });
              added++;
            }
          }
          writeAccountsFile(current);
          json(res, 200, { ok: true, mode, added, updated, skipped, total: current.length });
        },
      });

      register({
        kind: 'exact',
        path: '/doubao/models/probe',
        handler: async (req, res) => {
          if (guard(req, res)) return;
          const body = await parseBody(req);
          const key = typeof body?.key === 'string' ? body.key.trim() : '';
          if (!key) return json(res, 400, { ok: false, error: '需要 key：要验证的 model_item_key' });
          const itemId = Number(body?.itemId) || 0;
          const id = typeof body?.id === 'string' ? body.id : '';
          const list = client.allAccounts().filter(a => a.enabled !== false);
          const account = id ? list.find(a => a.id === id) : list[0];
          if (!account) return json(res, 400, { ok: false, error: '没有可用账号（先导入一个 Cookie）' });
          try {
            const r = await client.probeModelKey(account, { modelItemKey: key, itemId, extraParams: {} });
            json(res, 200, { ...r, account: account.id, key, itemId });
          } catch (e) {
            json(res, 500, { ok: false, error: String(e.message || e) });
          }
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

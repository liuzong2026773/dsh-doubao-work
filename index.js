/**
 * dsh-doubao-work —— 把豆包工作免费额度接入 DeepSeek Harness 的模型插件
 *
 * 装载后通过 ctx.llm.registerAdapter 注册 provider "doubao-work"，
 * 模型直接出现在 DSH 模型列表（如 deepseek-v4.1-flash / doubao-2.1-lite，0.01x 限时优惠）。
 *
 * Cookie 获取：云电脑/电脑浏览器登录 www.doubao.com 后，F12 → Network →
 * 任一请求 → Request Headers → 复制完整 Cookie 值，粘贴到插件配置的 cookie 字段。
 */

import { Schema } from '@deepseek-ai/schemastery';
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { DoubaoClient, DoubaoError, BUILTIN_MODELS } from './doubao.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-doubao-work';
export const inject = ['llm'];

// ---------------- 配置面板 ----------------

const AccountSchema = Schema.object({
  cookie: Schema.string().description('豆包网页版完整 Cookie（浏览器 F12 复制整行 Cookie 值）').default(''),
  remark: Schema.string().description('账号备注').default(''),
  enabled: Schema.boolean().description('启用此账号').default(true),
});

const ExtraModelSchema = Schema.object({
  id: Schema.string().description('模型 ID（DSH 中显示的调用名）').required(),
  name: Schema.string().description('显示名称').default(''),
  modelItemKey: Schema.string().description('豆包 model_item_key（抓包获取）').required(),
});

export const Config = Schema.object({
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
});

// ---------------- OpenAI Message → 豆包文本 ----------------

function blockText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

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

class DoubaoLlmAdapter extends LlmAdapter {
  /** @param {{ client: DoubaoClient, config: object, log: Function }} deps */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  providerInfo(provider) {
    return { id: provider, name: this.deps.config.providerName || '豆包工作（免费额度）' };
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
    const text = messagesToText(options);
    if (options.tools?.length) {
      log('warn', `豆包工作接口不支持工具调用（本次请求带 ${options.tools.length} 个工具，已忽略）。该模型适合对话/写作类任务，不适合做 Agent 主循环模型。`);
    }
    const signal = options.signal;
    const startedAt = Date.now();

    let full = '';
    let first = true;
    try {
      const gen = client.chat(model, text, signal);
      while (true) {
        const { value: delta, done } = await gen.next();
        if (done) { full = delta || full; break; }
        if (first) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          first = false;
        }
        full += delta;
        yield { type: 'text-delta', index: 0, text: delta };
      }
    } catch (e) {
      const kind = e instanceof DoubaoError ? e.kind : 'upstream';
      const codeMap = { auth: 'AUTH', ratelimit: 'RATE_LIMIT', noaccount: 'NO_ADAPTER', network: 'PROVIDER_UNAVAILABLE', empty: 'UPSTREAM_ERROR' };
      const code = codeMap[kind] || 'PROVIDER_ERROR';
      throw new LlmError(e.message || '豆包上游调用失败', code, { status: e.status });
    }

    if (first) {
      // 没有任何增量就结束了
      throw new LlmError('豆包上游未返回内容', 'UPSTREAM_ERROR');
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text: full } };
    yield {
      type: 'usage',
      usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: Math.ceil(full.length / 4) },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
    log('info', `调用完成 模型=${model} 字数=${full.length} 耗时=${Date.now() - startedAt}ms`);
  }
}

// ---------------- 插件入口 ----------------

export function apply(ctx, config) {
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
  const client = new DoubaoClient(
    { ...config, accounts },
    { statePath: path.join(pluginDir, 'gateway-state.json'), accountsPath: path.join(pluginDir, 'accounts.json'), log },
  );

  const models = client.models();
  log('info', `已注册 provider "${config.providerId}"：${models.map(m => m.id).join(', ')}｜账号 ${accounts.filter(a => a.enabled !== false).length} 个`);

  ctx.llm.registerAdapter([config.providerId], new DoubaoLlmAdapter({ client, config, log }));

  // 进程退出时落盘状态
  const flush = () => client.flushState();
  process.once('exit', flush);
  process.once('SIGINT', () => { flush(); process.exit(0); });
}

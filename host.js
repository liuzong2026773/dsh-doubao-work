/**
 * 宿主包解析：让「从 profile 安装」的插件也能拿到宿主那一份 `@deepseek-ai/*`。
 *
 * 为什么需要这一层：cordis 的 loader 只把**插件入口那一个裸名**重定向到宿主安装目录
 * （`HostResolvedRootInclude.import` → `internal.import(name, bareModuleBaseUrl)`），
 * 插件模块内部的 `import '@deepseek-ai/dsh-llm'` 仍走 Node 默认查找。profile 的
 * `node_modules` 里只有插件自己（pnpm 不装 peer），于是加载期直接
 * `ERR_MODULE_NOT_FOUND`——插件根本起不来。仓库内开发时能跑，是因为开发副本旁边
 * 有 `node_modules/@deepseek-ai/*`，这掩盖了问题。
 *
 * 也不能让 pnpm 再装一份副本：宿主的 `harnessErrorCode()` 用
 * `error instanceof HarnessError` 取错误码，第二份副本的 LlmError 判不中，
 * AUTH / RATE_LIMIT / QUOTA 这些码会整体退化成 UNKNOWN。所以必须回到安装目录取同一份。
 *
 * 兜底：连安装目录都找不到时（非常规部署），用本地错误类代替。它会把 `code` 和
 * `failure` 都写成**自身数据属性**——宿主 `normalizeLlmFailure()` 先读 own `failure`
 * 快照并校验 `carried.code === error.code`，命中即原样保留，因此错误码不会退化。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_PKG = '@deepseek-ai/schemastery';
const LLM_PKG = '@deepseek-ai/dsh-llm';

/** 解析来源，挂到 /doubao/status 上便于线上排障 */
export const resolvedFrom = { schemastery: '', 'dsh-llm': '' };

/** 兜底错误类：形状与宿主 LlmError 对齐，并让宿主的 failure 快照路径认出它 */
export class LocalLlmError extends Error {
  constructor(message, code, options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    if (typeof message !== 'string' || !message) throw new Error('LlmError message must be a non-empty string');
    if (typeof code !== 'string' || !code) throw new Error('LlmError code must be a non-empty string');
    this.name = 'LlmError';
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.providerRetryAfterMs !== undefined) this.providerRetryAfterMs = options.providerRetryAfterMs;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
    // 自身数据属性：宿主 normalizeLlmFailure() 会直接采用它，不必依赖 instanceof
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
    });
  }
}

/**
 * 可能装有宿主包的目录（按优先级）。
 * 桌面版：`<resources>/app.asar/dsh/node_modules`；解包或源码部署：`<resources>/dsh`。
 * `DSH_HOST_MODULES` 可覆盖，供自测与非常规安装使用。
 */
function installAnchors() {
  const anchors = [];
  const override = String(process.env.DSH_HOST_MODULES || '').trim();
  if (override) anchors.push(override);
  const res = process.resourcesPath;
  const execDir = path.dirname(process.execPath || '');
  if (res) {
    anchors.push(
      path.join(res, 'app.asar', 'dsh'),
      path.join(res, 'app.asar'),
      path.join(res, 'app.asar.unpacked', 'dsh'),
      path.join(res, 'dsh'),
    );
  }
  anchors.push(path.join(execDir, 'resources', 'app.asar', 'dsh'), path.join(execDir, 'resources', 'dsh'));
  return anchors;
}

/** 在安装目录里解析出包入口文件（asar 内路径由 Electron 的 fs 补丁支持） */
function resolveFromInstall(pkg) {
  for (const dir of installAnchors()) {
    try {
      // 锚点文件不必真实存在，createRequire 只借它的目录走 Node 的向上查找
      const req = createRequire(pathToFileURL(path.join(dir, 'host-anchor.cjs')).href);
      const file = req.resolve(pkg);
      return { file, dir };
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 先按常规裸名解析，再回安装目录；都失败返回 null */
async function loadPackage(pkg) {
  try {
    return { mod: await import(pkg), from: 'bare' };
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  const found = resolveFromInstall(pkg);
  if (!found) return null;
  return { mod: await import(pathToFileURL(found.file).href), from: `install:${found.dir}` };
}

const schemaPkg = await loadPackage(SCHEMA_PKG);
const llmPkg = await loadPackage(LLM_PKG);

resolvedFrom.schemastery = schemaPkg?.from || 'missing';
resolvedFrom['dsh-llm'] = llmPkg?.from || 'missing';

/** schemastery 的默认导出就是 Schema 工厂 */
export const Schema = schemaPkg ? (schemaPkg.mod.default ?? schemaPkg.mod.Schema) : undefined;
export const LlmAdapter = llmPkg?.mod.LlmAdapter;
export const LlmError = llmPkg?.mod.LlmError ?? LocalLlmError;

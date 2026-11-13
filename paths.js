/**
 * 数据目录：Cookie（accounts.json）与用量/冷却状态（gateway-state.json）的存放位置。
 *
 * 为什么不能放在插件目录：从 profile 安装的插件位于
 * `<profile>/node_modules/dsh-doubao-work`，而每次 `dsh plugin add` 升级都会把这个
 * 目录整份重抄一遍——写在里面的 Cookie 会跟着丢，用户得重新抓一遍。
 *
 * 解析顺序：
 *   1. 显式参数（插件配置项 dataDir / 工具的第二参数）
 *   2. 环境变量 DSH_DOUBAO_DATA_DIR
 *   3. 宿主提供的 dshHomePath（或 DSH_HOME）下的 doubao-work/
 *   4. ~/.dsh/doubao-work/
 *
 * 老版本把文件写在插件目录里，`dataPaths({ legacyDir })` 会在目标不存在时复制过去。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ACCOUNTS_FILE = 'accounts.json';
export const STATE_FILE = 'gateway-state.json';
const DIR_NAME = 'doubao-work';

/** @param {{explicit?: string, dshHome?: string}} [opts] */
export function resolveDataDir(opts = {}) {
  const explicit = String(opts.explicit || process.env.DSH_DOUBAO_DATA_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = String(opts.dshHome || process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, DIR_NAME);
}

/**
 * 建好目录、必要时从旧位置迁移，返回插件与工具共用的三个路径。
 * @param {{explicit?: string, dshHome?: string, legacyDir?: string, onMigrate?: (msg: string) => void}} [opts]
 */
export function dataPaths(opts = {}) {
  const dir = resolveDataDir(opts);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只读环境下仍按原样尝试读写 */ }
  if (opts.legacyDir && path.resolve(opts.legacyDir) !== dir) {
    for (const name of [ACCOUNTS_FILE, STATE_FILE]) {
      const legacy = path.join(opts.legacyDir, name);
      const target = path.join(dir, name);
      if (fs.existsSync(legacy) && !fs.existsSync(target)) {
        try {
          fs.copyFileSync(legacy, target);
          opts.onMigrate?.(`已把 ${name} 从插件目录迁到 ${target}`);
        } catch { /* 复制失败就沿用旧位置的行为：读的时候还有兜底 */ }
      }
    }
  }
  return { dir, accountsPath: path.join(dir, ACCOUNTS_FILE), statePath: path.join(dir, STATE_FILE) };
}

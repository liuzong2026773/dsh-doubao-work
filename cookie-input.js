/**
 * 粘贴内容 → 可用的 Cookie 头值
 *
 * 用户从浏览器里能拷到的形状远不止「整段 Cookie」一种，常见的有六种：
 *   1. 整段值：`sessionid=xxx; sid_guard=yyy; ...`（F12 → Request Headers → 复制值）
 *   2. 带头名的一行：`Cookie: sessionid=xxx; ...`
 *   3. 整页请求头（把整个 Request Headers 面板拷了出来）
 *   4. 「Copy as cURL」/「复制为 cURL」的整条命令（含 `-H 'Cookie: …'` 或 `-b '…'`）
 *   5. 浏览器扩展（EditThisCookie / Cookie-Editor）导出的 JSON
 *   6. Netscape 格式 cookies.txt
 *
 * 以前只有第 1 种能用，其余要么被当成「Cookie 太短」拒掉，要么把一堆噪声字段写进账号文件。
 * 这个模块把六种形状统一成 `k=v; k=v` 的规范串，并说明识别成了什么、丢了什么。
 *
 * 纯函数、无依赖：Node 侧（index.js 路由）与浏览器侧都能直接用。
 */

/** 判定登录态最有用的两个字段，缺了要提醒用户「可能没登录」 */
const AUTH_MARKERS = ['sessionid', 'sid_guard'];

const WARN = {
  EMPTY: 'empty',
  NO_PAIR: 'no_pair',
  NOT_LOGGED_IN: 'not_logged_in',
  CURL_NO_COOKIE: 'curl_no_cookie',
  FILE_REF: 'cookie_file_ref',
  DUP_KEYS: 'dup_keys',
  BARE_KEYS: 'bare_keys',
  TOO_SHORT: 'too_short',
};

/**
 * 统一换行，并去掉 BOM 与零宽/方向控制字符（从网页、聊天工具里粘贴时常见）。
 * 用码点范围判断，而不是在源码里写字面零宽字符——那样看不见，也容易被编辑器吞掉。
 */
function cleanText(raw) {
  const src = String(raw ?? '').replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of src) {
    const c = ch.codePointAt(0);
    if (c === 0xfeff) continue; // BOM
    if (c >= 0x200b && c <= 0x200f) continue; // 零宽空格/连接符/方向标记
    if (c >= 0x202a && c <= 0x202e) continue; // 双向格式控制符
    if (c === 0x2028 || c === 0x2029) continue; // 行分隔符
    out += ch;
  }
  return out;
}

/**
 * 拆掉 shell 续行符：bash 行尾的 `\`、cmd/PowerShell 行尾的 `^` 与反引号。
 * 导出的 cURL 命令经常是几十行的续行形式。
 */
function joinContinuations(text) {
  return text.replace(/(?:\\|\^|`)\n/g, ' ');
}

/** 这段文本是不是 cURL 命令（行首 curl / curl.exe，允许前面有 sudo） */
function looksLikeCurl(text) {
  return /^\s*(?:sudo\s+)?curl(?:\.exe)?\s/i.test(text);
}

/**
 * shell 分词：支持单引号、双引号（含 `\"`、cmd 的 `""`）与裸词。
 * 不需要完全符合 POSIX——只要把 `-H` / `-b` 后面那一个参数取准。
 */
function tokenize(input) {
  const src = joinContinuations(input);
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    let token = '';
    while (i < src.length && !/\s/.test(src[i])) {
      const ch = src[i];
      if (ch === "'") {
        i++;
        while (i < src.length && src[i] !== "'") { token += src[i]; i++; }
        i++;
      } else if (ch === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && i + 1 < src.length) {
            const next = src[i + 1];
            // bash 双引号里只有 " \ $ ` 是转义；引号内的续行直接吃掉
            if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') { token += next === '\n' ? '' : next; i += 2; continue; }
            token += src[i]; i++; continue;
          }
          if (src[i] === '"' && src[i + 1] === '"') { token += '"'; i += 2; continue; } // cmd 的 ""
          token += src[i]; i++;
        }
        i++;
      } else if (ch === '\\' && i + 1 < src.length) {
        token += src[i + 1]; i += 2;
      } else {
        token += ch; i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/** `Cookie: a=b; c=d`（允许全角冒号）→ 'a=b; c=d'；不是这种形式返回 null */
function stripCookieHeaderName(line) {
  const m = /^\s*cookie\s*[:：]\s*/i.exec(line);
  return m ? line.slice(m[0].length) : null;
}

/**
 * 从 cURL 命令里取 Cookie：`-H/--header "Cookie: …"` 与 `-b/--cookie "a=b; c=d"`。
 * @returns {{value: string, warnings: string[]}}
 */
function extractFromCurl(text) {
  const tokens = tokenize(text);
  const warnings = [];
  const parts = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const flag = tokens[i];
    const val = tokens[i + 1] ?? '';
    if (flag === '-H' || flag === '--header') {
      i++;
      const v = stripCookieHeaderName(val);
      if (v !== null && v.trim()) parts.push(v.trim());
      continue;
    }
    if (flag !== '-b' && flag !== '--cookie') continue;
    i++;
    // -b 后面可能是文件名（curl 的 cookie jar），不是 Cookie 内容
    if (val.startsWith('@') || /^\S+\.(txt|json|curl)$/i.test(val)) {
      warnings.push(`${WARN.FILE_REF}：-b 指向文件「${val.slice(0, 40)}」而不是 Cookie 内容，请直接粘贴请求头里的值`);
      continue;
    }
    if (val.includes('=')) parts.push(val.trim());
    else warnings.push(`${WARN.FILE_REF}：-b「${val.slice(0, 40)}」不像 Cookie 内容，已忽略`);
  }
  if (!parts.length) {
    warnings.push(`${WARN.CURL_NO_COOKIE}：这条 cURL 里没有 -H "Cookie: …" 也没有 -b 'k=v'。请用右键「Copy as cURL」复制完整请求（浏览器默认会带 -H 'cookie: …'）`);
  }
  return { value: parts.join('; '), warnings };
}

/**
 * 整页请求头文本：找出 cookie 头（含 RFC 折叠续行）。
 * @returns {string | null} 不像请求头返回 null；像但没有 cookie 头返回空串
 */
function extractFromHeaderDump(text) {
  const lines = text.split('\n');
  const named = lines.filter(l => /^[A-Za-z][A-Za-z0-9-]*\s*[:：]/.test(l.trim())).length;
  if (named < 2) return null; // 不是请求头转储
  const found = [];
  let collecting = false;
  let buffer = '';
  const flush = () => { if (collecting && buffer.trim()) found.push(buffer.trim()); collecting = false; };
  for (const line of lines) {
    if (/^[ \t]+\S/.test(line)) { // 续行：折叠进上一条
      if (collecting) buffer += ' ' + line.trim();
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*[:：]\s*(.*)$/.exec(line.trim());
    flush();
    if (!m) continue;
    if (m[1].toLowerCase() === 'cookie') { collecting = true; buffer = m[2]; }
  }
  flush();
  return found.join('; ');
}

/**
 * Netscape cookies.txt：制表符分隔 7 字段
 * （domain / includeSubdomains / path / secure / expiry / name / value）。
 * 第 2、4 列在 HTTP cookie jar 里是 TRUE|FALSE，在部分导出工具里是 0|1，两种都认。
 */
function extractFromNetscape(text) {
  const out = [];
  for (const row of text.split('\n')) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const flag = String(cols[3]).trim().toUpperCase();
    if (!['TRUE', 'FALSE', '0', '1'].includes(flag)) continue;
    if (!/^\d+$/.test(String(cols[4]).trim())) continue; // 过期时间列
    if (!cols[5]) continue;
    out.push(`${cols[5]}=${cols[6] ?? ''}`);
  }
  return out.length >= 2 ? out.join('; ') : null;
}

/** 浏览器扩展导出的 JSON：数组、{cookies:[…]}，或 {cookie:"…"} */
function extractFromJson(text) {
  const t = text.trim();
  if (!/^[{[]/.test(t)) return null;
  let data;
  try { data = JSON.parse(t); } catch { return null; }
  const list = Array.isArray(data) ? data : Array.isArray(data?.cookies) ? data.cookies : null;
  if (list) {
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const name = String(c.name ?? c.Key ?? '').trim();
      if (!name) continue;
      out.push(`${name}=${String(c.value ?? c.Value ?? '')}`);
    }
    return out.length ? out.join('; ') : null;
  }
  if (typeof data?.cookie === 'string' && data.cookie.trim()) return data.cookie.trim();
  return null;
}

/**
 * Cookie 字段名的合法字符（RFC 7230 token：ASCII，不含空格与 , ; = " 等分隔符）。
 * 用来把「随便粘进来的中文说明」和真的 Cookie 区分开——字段名不可能是中文或带空格。
 */
const NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * 把 Cookie 串切成字段：按 `;` 与换行切；值里允许 `=`；去掉包裹引号。
 * @returns {{pairs: Array<{k: string, v: string}>, warnings: string[]}}
 */
function splitPairs(value) {
  const warnings = [];
  const pairs = [];
  let bare = 0;
  let junk = 0;
  for (const chunk of String(value || '').split(/[;\n]+/)) {
    const piece = chunk.trim().replace(/^["']|["']$/g, '').trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq < 0) {
      // 没有值的裸字段：字段名合法才保留（浏览器确实会发空值 Cookie），否则是误粘的正文
      if (!NAME_RE.test(piece)) { junk++; continue; }
      bare++;
      pairs.push({ k: piece, v: '' });
      continue;
    }
    const k = piece.slice(0, eq).trim();
    const v = piece.slice(eq + 1).trim();
    if (!NAME_RE.test(k)) { junk++; continue; } // 明显不是字段名（正文、URL 片段）
    pairs.push({ k, v });
  }
  if (bare) warnings.push(`${WARN.BARE_KEYS}：${bare} 个字段没有值，已按空值保留（通常无害，可忽略）`);
  if (junk) warnings.push(`${WARN.BARE_KEYS}：已忽略 ${junk} 段不像 Cookie 的内容`);
  return { pairs, warnings };
}

/** 同名字段取最后一次（浏览器语义：后写入覆盖先写入） */
function dedupe(pairs) {
  const order = [];
  const map = new Map();
  let dups = 0;
  for (const { k, v } of pairs) {
    if (map.has(k)) dups++;
    else order.push(k);
    map.set(k, v);
  }
  const warnings = dups ? [`${WARN.DUP_KEYS}：${dups} 个字段名重复，已取最后一次`] : [];
  return { keys: order.map(k => ({ k, v: map.get(k) })), warnings };
}

/**
 * 主入口：识别任意粘贴形状，产出规范 Cookie 串。
 * @param {string} raw 用户粘贴的原文
 * @returns {{cookie: string, format: string, keys: string[], pairs: number, warnings: string[]}}
 */
export function parseCookieInput(raw) {
  const text = cleanText(raw);
  const warnings = [];
  if (!text.trim()) {
    return { cookie: '', format: 'empty', keys: [], pairs: 0, warnings: [`${WARN.EMPTY}：粘贴内容为空`] };
  }

  let value;
  let format = 'raw';
  const fromJson = extractFromJson(text);
  const fromNetscape = fromJson === null ? extractFromNetscape(text) : null;
  if (fromJson !== null) {
    value = fromJson;
    format = 'json';
  } else if (fromNetscape !== null) {
    value = fromNetscape;
    format = 'netscape';
  } else if (looksLikeCurl(text)) {
    const r = extractFromCurl(text);
    value = r.value;
    format = 'curl';
    warnings.push(...r.warnings);
  } else {
    const dump = extractFromHeaderDump(text);
    if (dump !== null) {
      format = 'headers';
      value = dump;
      if (!dump.trim()) warnings.push(`${WARN.NO_PAIR}：这段像是整页请求头，但里面没有 cookie 头`);
    } else {
      const named = stripCookieHeaderName(text.split('\n')[0] || '');
      if (named !== null) { format = 'cookie-header'; value = named; }
      else value = text;
    }
  }

  const split = splitPairs(value);
  warnings.push(...split.warnings);
  const ded = dedupe(split.pairs);
  warnings.push(...ded.warnings);

  const keys = ded.keys.map(x => x.k);
  const cookie = ded.keys.map(({ k, v }) => (v === '' ? k : `${k}=${v}`)).join('; ');
  if (!keys.length) warnings.push(`${WARN.NO_PAIR}：没能从粘贴内容里解析出任何 Cookie 字段`);
  else if (!AUTH_MARKERS.some(m => keys.includes(m))) {
    warnings.push(`${WARN.NOT_LOGGED_IN}：没有 ${AUTH_MARKERS.join(' / ')} 字段，这段 Cookie 可能不是登录状态下拷的`);
  }
  if (keys.length && cookie.length < 20) warnings.push(`${WARN.TOO_SHORT}：解析结果只有 ${cookie.length} 个字符，疑似不完整`);

  return { cookie, format, keys, pairs: keys.length, warnings };
}

const FORMAT_LABEL = {
  raw: '整段 Cookie',
  'cookie-header': 'Cookie: 请求头',
  headers: '整页请求头',
  curl: 'cURL 命令',
  json: '扩展导出的 JSON',
  netscape: 'cookies.txt',
  empty: '空内容',
};

/** 面板 / 命令行用的一句话摘要 */
export function describeParse(result) {
  const label = FORMAT_LABEL[result.format] || result.format;
  return `识别为「${label}」，提取 ${result.pairs} 个字段`;
}

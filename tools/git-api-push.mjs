#!/usr/bin/env node
/**
 * tools/git-api-push.mjs —— 走 GitHub REST API 提交并推进分支
 *
 * 用途：在国内直连 github.com 被重置（`Recv failure: Connection was reset`）时，
 * 依然能把本地改动推上私有仓库。api.github.com 通常是通的。
 *
 *   GITHUB_TOKEN=ghp_xxx node tools/git-api-push.mjs [owner/repo] [branch]
 *
 * - 在插件目录（含 .git）里运行；repo 缺省时读 origin URL 自动推断
 * - 只提交 `git ls-files` 收录的文件，`.gitignore` 里的 accounts.json / gateway-state.json 不会上传
 * - 提交信息取当前 HEAD 的 commit message（先 `git commit` 再跑这个）
 * - 令牌不要写进 URL 或文件，用环境变量传；泄露了立刻到 GitHub 撤销
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [, , repoArg, branchArg = 'main'] = process.argv;
const token = process.env.GITHUB_TOKEN;

const die = (msg) => { console.error('✗ ' + msg); process.exit(1); };
if (!token) die('缺少 GITHUB_TOKEN 环境变量（不要把令牌写进 URL 或提交进仓库）');

const git = (args) => execFileSync('git', args, { cwd: pluginDir, encoding: 'utf8' });

let repo = repoArg;
if (!repo) {
  let url;
  try { url = git(['config', '--get', 'remote.origin.url']); } catch (e) { die('没有 origin，请显式传 owner/repo'); }
  const m = String(url).match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?/);
  if (!m) die('无法从 origin 推断仓库：' + url);
  repo = m[1];
}

const api = (p, opts = {}) =>
  fetch('https://api.github.com' + p, {
    ...opts,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  }).then(async r => {
    const t = await r.text();
    if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} → HTTP ${r.status}: ${t.slice(0, 240)}`);
    return t ? JSON.parse(t) : null;
  });

const files = git(['-c', 'core.quotepath=false', 'ls-files']).split('\n').filter(Boolean);
if (!files.length) die('git ls-files 为空：先 git add / git commit');

const ref = await api(`/repos/${repo}/git/ref/heads/${branchArg}`);
const baseCommit = ref.object.sha;
const baseTree = (await api(`/repos/${repo}/git/commits/${baseCommit}`)).tree.sha;
console.log(`仓库 ${repo}@${branchArg}  远端 HEAD ${baseCommit.slice(0, 8)}  文件 ${files.length} 个`);

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      await fn(items[k], k);
    }
  }));
}

const entries = new Array(files.length);
await mapLimit(files, 4, async (f, k) => {
  const content = fs.readFileSync(path.join(pluginDir, f));
  // 删除检测：工作区里已不存在但索引仍收录的文件，用 null sha 从 tree 中移除
  if (!fs.existsSync(path.join(pluginDir, f))) { entries[k] = { path: f, mode: '100644', type: 'blob', sha: null }; return; }
  const blob = await api(`/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  entries[k] = { path: f, mode: '100644', type: 'blob', sha: blob.sha };
  process.stdout.write('.');
});
console.log('\nblob 完成');

const tree = await api(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: entries }) });
const message = git(['log', '-1', '--pretty=%B']).trim();
const newCommit = await api(`/repos/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommit] }),
});
await api(`/repos/${repo}/git/refs/heads/${branchArg}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha }) });
console.log(`✓ 已推进 ${branchArg} → ${newCommit.sha.slice(0, 8)}  ${message.split('\n')[0]}`);

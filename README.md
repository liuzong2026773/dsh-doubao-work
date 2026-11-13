# dsh-doubao-work

把**豆包工作**的免费额度接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的模型插件。

装载后，`doubao-work` provider 会出现在 DSH 的模型列表中，可直接选用：

| 模型 ID | 倍率 | 说明 |
|---------|------|------|
| `deepseek-v4.1-flash` | **0.01x 限时优惠** | DeepSeek V4.1 Flash |
| `doubao-2.1-lite` | **0.01x 限时优惠** | 豆包 2.1 Lite |

豆包工作签到每日送额度（200/天，周一翻倍，30 天有效），0.01x 模型消耗极少——相当于每天白嫖一笔可用额度。

## 工作原理

- 走豆包**网页版**接口（`www.doubao.com/chat/completion`，SSE 流式），与 APP 同账号同额度，**无需逆向 APP**
- 只需浏览器登录后的 **Cookie**，无需签名（实测 `msToken`/`a_bogus` 均不校验）
- 通过 DSH 的 `ctx.llm.registerAdapter()` 注册标准 `LlmAdapter`，流式输出符合 dsh-llm 协议

## 安装

1. 把本目录放到 DSH 可访问的插件目录
2. 按 DSH 插件bundle 机制挂载 `cordis.patch.yml`
3. 在插件配置面板的 `accounts` 里填入豆包 Cookie（见下）
4. 重启/刷新后，模型列表出现「豆包工作（免费额度）」

## 获取 Cookie

1. 电脑浏览器打开 [www.doubao.com](https://www.doubao.com) 并登录
2. `F12` → Network → 随便点一个请求 → Request Headers → 复制整条 `Cookie` 值
3. 粘贴到插件配置 `accounts[0].cookie`

## 功能

- **多账号池**：轮询/随机调度，Cookie 填多个即可
- **冷却分级**：429/403 长冷却 24h（对应“第二天恢复”）、5xx 空响应 短冷却 5 分钟、Cookie 失效单独标记
- **单账号 RPM 限速**（默认 6/分钟，可配），防止高频触发风控
- **失败自动换号重试**；**流中断保护**：已经吐出内容后不再换号重发，避免用户看到重复文本
- **错误码对齐宿主协议**：`QUOTA` / `RATE_LIMIT` / `AUTH` / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` /
  `ABORTED` / `SERVER`，并由 `providerRetryPolicy` 声明哪些错误宿主可以补一次重试
- **扩展模型**：后续抓到新的 `model_item_key` 可在 `extraModels` 配置里加

## 多账号与 Cookie 导入/导出（accounts.json）

账号有两种添加方式，可混用：

**方式 A：DSH 插件配置面板** —— 在 `accounts` 数组里加一项，填 `cookie` + `remark`，由 DSH 自己持久化配置。

**方式 B：accounts.json 文件（推荐，改文件即生效，无需重启 DSH）** —— 在插件目录放一个 `accounts.json`：

```json
{
  "accounts": [
    { "id": "acc-1", "cookie": "整段豆包Cookie……", "remark": "主号", "enabled": true },
    { "id": "acc-2", "cookie": "整段豆包Cookie……", "remark": "小号", "enabled": true }
  ]
}
```

- 每次调用前检查文件修改时间，**改完保存立即生效**（加号、换 Cookie、临时禁用 `enabled: false` 都不用重启）
- 同 `id` 时文件账号优先于配置面板账号
- **导出**：复制这个 `accounts.json` 就是完整账号备份
- **导入**：把文件放进另一台设备的插件目录即完成迁移
- 运行状态（冷却倒计时/用量统计）另存于插件目录 `gateway-state.json`，不影响账号数据

> 手机 DSH 小技巧：如果手机上不便直接编辑文件，可以直接对 DSH 说“把这段 Cookie 写进插件目录的 accounts.json，格式是……”让它代写。

## 获取新账号的 Cookie

每个豆包账号各自登录网页版抓一次：

1. 浏览器（建议开无痕窗口）打开 [www.doubao.com](https://www.doubao.com) 并登录该账号
2. `F12` → Network → 随便点一个请求 → Request Headers → 复制整条 `Cookie` 值
3. 加进 `accounts.json` 的一个新条目（`id` 别重复）

## 已知限制（如实说明）

- **不支持工具调用（function calling）**：豆包对话接口没有该能力，本模型适合对话/写作/问答，**不适合当 Agent 主循环模型**
- 模型自认知会回答“豆包”（平台壳层统一身份），底层实际路由由 `model_item_key` 决定
- Cookie 会过期（数天到数周），失效后重新登录复制即可
- 每次调用都会在豆包账号里产生一条真实对话记录
- 属于个人自用的非官方接入方式，违反豆包用户协议的风险自担；建议小号使用、控制频率

## 目录结构

```
dsh-doubao-work/
├── index.js           # 插件主体：注册 LlmAdapter + 状态/管理接口
├── doubao.js          # 上游内核：Cookie 直连 / SSE 解析 / 账号池 / 冷却 / 会话复用
├── client.js          # 浏览器半身：设置页「豆包工作」
├── package.json
├── cordis.patch.yml
├── tests/             # smoke.mjs（契约/接口）、upstream.mjs（本地假上游）
├── tools/             # status / accounts / panel / git-api-push
└── standalone/        # 同内核的 OpenAI 兼容网关（独立进程）
```

## 附：standalone 网关

`standalone/` 目录是同内核的独立 OpenAI 兼容网关（`node index.js`，默认 `127.0.0.1:3040/v1`），适合不想装插件、或想给其他 OpenAI 客户端/中转站供流的场景。配置 `config.json` + `accounts.json`（填 Cookie）后启动。

## 内嵌设置页

插件带浏览器半身（`client.js`），重启 DSH 后会在 **设置 → 模型接入** 里多出一页「豆包工作」，
直接显示账号池、今日用量、预估剩余额度，并支持健康检查 / 启用停用 / 删除账号。

页面上还能「添加账号」（直接粘贴整段 Cookie，保存即生效）、「停用/启用」、「换 Cookie」与「删除」。
停用的账号仍然显示在列表里（状态显示「已停用」），所以随时可以点回来启用。

离线自检（不重启、不联网、不耗额度）：

```bash
node tests/smoke.mjs      # 契约/路由/账号管理/错误码/流协议，共 40 项
node tests/upstream.mjs   # 本地假上游：SSE 解析/换号/冷却/流中断/取消/会话复用，共 11 项
```

数据来自宿主同源接口（双前缀，`/api/doubao/*` 与 `/doubao/*` 等价）：
`/api/doubao/status`、`/api/doubao/check`、`/api/doubao/account/add|update|enable|remove`。

> 这些接口能增删账号、写本地文件，因此只接受**同源**请求：浏览器跨源 POST 的 `Origin`
> 与 `Host` 不一致会直接 403。命令行（curl / 脚本）不带 `Origin`，照常可用。

## 本地面板

```bash
node tools/panel.mjs        # http://127.0.0.1:3041
```

只监听 127.0.0.1。页面能看到：账号状态、今日请求数、**预估剩余额度**（按 200/天、周一翻倍推算）、
累计字数、最近错误，并支持「健康检查」「停用/启用」「删除账号」。

> 平台没有提供余量查询接口（实测），所以"剩余"是**按调用次数自记账估算**，不是官方数字。

## 运维小工具（无需面板）

```bash
node tools/status.mjs          # 账号池状态：冷却到几点、累计用量、最近错误
node tools/status.mjs --check  # 额外校验每个账号 Cookie 是否还有效
node tools/status.mjs --quota  # 额外查询每个账号的订阅额度

node tools/accounts.mjs list                     # 列出账号
node tools/accounts.mjs add --id acc-2 --remark 小号 --cookie-file /tmp/c.txt
node tools/accounts.mjs disable --id acc-2
node tools/accounts.mjs export --out /tmp/backup.json
```

## 推送代码（国内网络备选）

直连 `github.com` 时常见 `Recv failure: Connection was reset`（`api.github.com` 往往还是通的）。
此时可以照常 `git add` / `git commit`，再用 API 推送：

```bash
GITHUB_TOKEN=ghp_xxx node tools/git-api-push.mjs            # 自动从 origin 推断仓库
GITHUB_TOKEN=ghp_xxx node tools/git-api-push.mjs liuzong2026773/dsh-doubao-work main
```

只提交 `git ls-files` 里的文件（`accounts.json`、`gateway-state.json` 被 `.gitignore` 挡住，不会上传），
提交信息取当前 HEAD 的那条。令牌用环境变量传，别写进 URL。

## 状态接口（插件内，需重启 DSH 后生效）

- `GET  /doubao/status`（或 `/api/doubao/status`）— 账号池（含停用）+ 今日用量 + 会话数
- `POST /doubao/check` — 逐账号健康检查
- `POST /doubao/account/add|update|enable|remove` — 账号增删改启停（`update` 用于换 Cookie，不用删了再加）

## 流式输出与推理档位（reasoningEffort）

实测豆包「工作模式」（`mode_id=3`）的推流行为取决于推理档位：

- `0`（默认）：**真流式**——上游逐块推送，界面边生成边显示，体感最快；
- `1`~`3`：**批推**——上游先推理完再一次性返回整段内容，没有流式体感，但复杂推理质量更高。

抓包记录（同一账号、同一句提示词）：`reasoning_effort=0` 时首包后逐块到达（每块间隔几十～几百 ms）；
`reasoning_effort=1/3` 时首包就是约 15KB 的完整回复。DSH 的「首 token / 输出速度」按总时长均摊，
所以高推理档会显示成 ~11 tok/s 的"慢速"。

- `reasoningEffort`（默认 `0`）：追求响应速度和流式体感保持 0；需要更强推理再调到 1~3。

## 多轮上下文（contextReuse）

默认开启：同一段对话里，插件会复用豆包侧的 `conversation_id`，**只发最后一条消息**，
不再把历史拼成整段文本。仅在消息严格追加一条时复用，历史被改写/压缩则自动新建会话。

- `contextReuse`（默认 `true`）：关掉就退回"每次新建会话 + 拼历史"的老行为
- `conversationTtlSec`（默认 `1800`）：复用有效期，超时新建

## 接口实测记录

抓包结论、模型 `model_item_key` 对照表、SSE 事件表、额度接口、以及**尚未抓到**的签到接口和补抓方法，见 [`docs/豆包接口实测-2026-11-13.md`](docs/豆包接口实测-2026-11-13.md)。

## 开发自测

两套离线测试都不联网、不消耗豆包额度：

```bash
node tests/smoke.mjs      # 插件契约 + HTTP 管理接口 + 适配器流协议
node tests/upstream.mjs   # 本地假豆包上游（SSE 帧与线上一致）
```

`tests/smoke.mjs` 会 `import('../index.js')`，因此需要能解析到 peer 依赖
`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery`。在本机开发时直接把 DSH 安装目录
`resources/app.asar` 里 `dsh/node_modules/@deepseek-ai/` 的同版本包放到本仓库 `node_modules/` 下即可
（`node_modules/` 已在 `.gitignore` 里）。装好真实包还有个好处：类型/字段名与宿主完全一致，
不会测出一个"只在 mock 里成立"的协议。

## 待办 / 已知缺口

- `standalone/` 独立网关是**同逻辑的另一份实现**，尚未同步 1.2.0 的流中断保护与错误码修正，
  后续应改为直接复用 `doubao.js`，避免两处漂移。
- 8 个未抓 `model_item_key`（豆包 2.1 Pro / Kimi K3 / GLM 5.3 等），抓到即可加进 `extraModels`。
- 签到接口在网页端不存在（详见 docs），插件侧只能做额度记账与提醒，无法自动签到。

## 更新记录

- **1.2.0**（2026-11-13）：
  - **停用账号重新可见**：此前 `enabled: false` 的账号会从设置页列表里消失，导致「停用」按下去就再也点不回来；
    现在快照含停用账号，按钮改为按 `enabled` 判断，显示「启用 / 停用」。
  - **流中断保护**：上游已经开始吐字后再断流，不再换号从头重发（用户会看到两段重复内容），
    而是保留已输出部分并以 `finish: max-tokens` 告知宿主这段不完整。
  - **错误码对齐宿主**：`quota → QUOTA`、`network → TRANSPORT`、`empty → EMPTY_RESPONSE`、
    `timeout → TIMEOUT`、`aborted → ABORTED`（此前落在 `PROVIDER_UNAVAILABLE`/`UPSTREAM_ERROR` 这类宿主不认的码上），
    并新增 `providerRetryPolicy`（`RATE_LIMIT` 不交给宿主立刻重试）。
  - **真实原因不再被掩盖**：单账号出错冷却后，此前会抛「全部账号冷却中」，把真正的额度/空响应错误盖掉。
  - **换 Cookie 接口** `POST /doubao/account/update` + 设置页「换 Cookie」按钮；配置面板账号的启停同样生效。
  - **同源校验**：管理接口拒绝浏览器跨源请求（CSRF）。
  - **用量估算**改为中文按宽字符计（此前一律 `长度/4`，中文严重低估）；`usage` 补 `totalTokens`。
  - **测试**：新增 `tests/upstream.mjs`（本地假豆包上游，11 项），`tests/smoke.mjs` 扩到 40 项；
    上游域名可经 `baseUrl` 配置替换，便于自测与镜像。
- **1.1.3**（2026-11-13）：新增 `reasoningEffort` 配置项（默认 0，走真流式）。此前写死为 3，
  豆包工作模式在推理档 ≥1 时会先推理完再整段返回，导致界面"卡一下再出全文"、TTFT/TPS 统计偏低。
- **1.1.2**（2026-11-13）：修复 `stream()` 中 `result` 变量作用域问题——此前每次生成完回复后都会抛
  `ReferenceError: result is not defined`，导致 DSH 把回合判为失败（表现为“豆包模型用不了”）。
- **1.1.1**：改用 `/api/doubao/*` 接口前缀，兼容只派发 `/api` 的宿主。
- **1.1.0**：会话复用增加回复哈希校验，防止串会话。

## License

MIT

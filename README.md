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

桌面版用自带的插件 CLI（本质是在 profile 目录里跑 pnpm）：

```powershell
# Windows：桌面版 CLI 在安装目录的 resources/runtime/cli/bin 下
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "file:C:\路径\dsh-doubao-work"
```

升级时 pnpm 会**整目录重抄**一遍 `node_modules/dsh-doubao-work`，所以要先 `remove` 再 `add`
（`add` 对同一个 `file:` 依赖会说 "Already up to date"，不会刷新内容）。

装完**必须重启 DSH** 才会加载（profile 的 bundle 花名册在启动时读取）。重启后：

1. 设置 → 模型接入 → 「豆包工作」里填 Cookie，或直接调用 `/doubao/account/add`
2. 模型列表出现「豆包工作（免费额度）」，选择 `doubao-work / deepseek-v4.1-flash` 等
3. 浏览器打开 `http://127.0.0.1:<端口>/doubao/status`，看 `runtime.host` 是否为
   `install:<安装目录>`——这是确认插件真的从安装目录拿到了宿主包（原理见「更新记录」1.2.5）

> 从 profile 安装的第三方插件旁边只有它自己，没有 `@deepseek-ai/*`。宿主的 loader 只把
> **插件入口那一个裸名**重定向到安装目录，插件内部的 `import '@deepseek-ai/dsh-llm'`
> 仍按 Node 默认规则查找，于是加载期就 `ERR_MODULE_NOT_FOUND`。`host.js` 负责回到安装目录
> 取宿主那一份；不能靠 pnpm 再装一份副本，因为宿主的 `harnessErrorCode()` 用
> `error instanceof HarnessError` 取错误码，第二份副本会让 AUTH/RATE_LIMIT/QUOTA 全部退化成 UNKNOWN。


## 获取 Cookie

**方式 A：设置页「从浏览器导入」（推荐，1.3.0 起，全程不用碰 F12）**

1. 设置 → 模型接入 → 豆包工作 → 点「从浏览器导入」
2. 插件会开一个**独立临时配置**的浏览器窗口（Edge/Chrome/Chromium 自动探测）
3. 登录豆包，二选一：
   - **在面板里填手机号** → 点「发送验证码」→ 收到后填验证码 → 点「登录」（1.5.0 起）；
     插件把这两个动作送进那个窗口，等同你自己在页面里操作，短信发到的是你填的号
   - 或者直接在窗口里登（手机号 / 扫码 / 抖音都行）
4. **登录成功会自动导入账号并关掉窗口**（1.5.0 起）。万一没自动导入，点一下「抓取 Cookie（并入库）」也能补上

**方式 B：粘贴（1.2.6 起自动识别形状）**

1. 电脑浏览器打开 [www.doubao.com](https://www.doubao.com) 并登录
2. `F12` → Network → 随便点一个请求 → Request Headers → 复制
3. 粘到「添加账号」的框里（或插件配置 `accounts[0].cookie`）

粘贴框不用自己剪裁：整段 Cookie、`Cookie: …` 请求头、整个 Request Headers 面板、
浏览器右键「Copy as cURL」的整条命令、EditThisCookie / Cookie-Editor 导出的 JSON、
Netscape `cookies.txt` 都能直接贴，识别结果会回显（「识别为『cURL 命令』，提取 14 个字段」），
缺登录态字段时会提示。命令行同样支持：`node tools/accounts.mjs add --cookie-file cURL.txt`。

## 从浏览器导入是怎么做的（以及为什么不是"读浏览器 Cookie 库"）

走 **CDP（Chrome DevTools 协议）**：`--remote-debugging-port` + 独立 `--user-data-dir` 拉起浏览器，
连 `ws://127.0.0.1:<port>/devtools/browser/...`，发一条 `Storage.getCookies` 只读指令，
过滤 `.doubao.com` 域后拼成 Cookie 串入库。

为什么不做成"直接读浏览器 Cookie 库"（很多同类工具的做法）：

- Chrome/Edge **127+** 在 Windows 上给 Cookie 的 AES key 加了 **App-Bound Encryption**，第三方进程解不开；
  社区库（`browser_cookie3` / `rookie` 一类）因此大面积失效，而且随浏览器版本反复变化。
- macOS 要 Keychain 授权弹窗并受签名/权限影响，Linux 要 Secret Service（headless 拿不到），
  360 / 夸克 / 千问这些国产内核路径与加密各不相同。
- 浏览器开着时 Cookie 库被占用（实测 `EBUSY`），要靠影子副本绕。
- 网页里跑 JS 读 `document.cookie` 拿不到 **HttpOnly** 的 `sessionid` / `sid_guard`——这正是登录态所在。

CDP 一条路把这四个问题全绕开，且对 Chromium 内核通用。代价是需要开一个专用窗口（本插件用临时
profile，不碰你日常浏览器的数据）。**手机版 DSH 不适用**：插件代码跑在桌面宿主上，读不到手机浏览器的
登录态，手机请用「粘贴」或把桌面导出的 `accounts.json` 同步过去。

安全边界（写死在 `browser.js`，不是配置项）：只连 `127.0.0.1`、只发 `Storage.getCookies` 这一条
只读指令、只取豆包域、日志与接口返回都不带 Cookie 本体（只报字段数与名字）。

探测顺序是 Edge → Chrome → Chromium（Windows 上连 `EdgeCore\<版本>\msedge.exe` 这种没有
Application 包装层的布局也认）。想用别的内核浏览器，在插件配置里填 `browserPath` 指向可执行文件即可。
命令行版：`node tools/browser-import.mjs --wait 300`（`--attach --port 9222` 可连你自己开着的调试端口）。

## 登录助手：手机号在面板里填，登录在浏览器里发生

豆包网页登录走 `accounts.doubao.com` 的 **webmssdk 风控签名**：纯后端重放只会拿到 `非法应用(22)`，
短信接口也一样（这点在 1.1.x 就实测过，写在 [`docs/豆包接口实测-2026-11-13.md`](docs/豆包接口实测-2026-11-13.md) 里）。
所以插件**不在后端模拟登录**，而是把「填手机号 / 点发送验证码 / 填验证码 / 点登录」这几个动作
送进它自己拉起的那个浏览器窗口——页面自己发请求、自己签名，风控看到的就是正常浏览器。

实现（`browser.js` 的 `loginAssist`）：

- 只连 `127.0.0.1` 上的调试端口，用 CDP 的 `Runtime.evaluate` 找元素、`Input.dispatchMouseEvent`
  点按钮、`Input.insertText` 填字（不是 `el.click()`，点击带真实坐标与按下/抬起序列）
- 按钮按「整串文字相等」匹配，同名时取离输入框最近的那个（页面顶部还有一个「登录」，
  早期用「包含」匹配会点到包裹容器上，坐标落在两个按钮之间、页面毫无反应——这是实测踩到的坑）
- 手机号只进浏览器输入框，插件不落盘、不在接口返回里回传（`/doubao/browser/login` 只回表单形状）
- 每步都回 `steps`（"已点击「登录」"/"找到 2 个输入框"/"没找到「发送验证码」…"），走不通时面板上能直接看到卡在哪，
  这时改成在窗口里手动登录即可——**自动导入照样生效**

自动导入（`startLoginWatch`）：窗口一打开就开始每 2.5 秒读一次 Cookie，检测到
`sessionid`/`sid_guard` 就入库、关窗口、刷新账号列表；5 分钟没等到就停下并在面板上说明原因。

## 功能

- **多账号池**：轮询/随机调度，Cookie 填多个即可
- **从浏览器一键导入**（1.3.0）：CDP 抓取，跨 Chromium 内核、拿得到 HttpOnly 登录态、不读浏览器隐私库
- **登录助手 + 自动导入**（1.5.0）：面板里填手机号/验证码，动作送进那个窗口，登录成功自动入库并关窗
- **冷却分级**：429/403 长冷却 24h（对应“第二天恢复”）、5xx 空响应 短冷却 5 分钟、Cookie 失效单独标记
- **单账号 RPM 限速**（默认 6/分钟，可配），防止高频触发风控
- **失败自动换号重试**；**流中断保护**：已经吐出内容后不再换号重发，避免用户看到重复文本
- **错误码对齐宿主协议**：`QUOTA` / `RATE_LIMIT` / `AUTH` / `TRANSPORT` / `TIMEOUT` / `EMPTY_RESPONSE` /
  `ABORTED` / `SERVER`，并由 `providerRetryPolicy` 声明哪些错误宿主可以补一次重试
- **每日自动签到**（1.4.0）：面板「一键签到」（整池或单号）+ 配置 `checkinSchedule: "09:30"` 后每天自动签，
  启动时若当天还没签会自动补一次
- **账号包导出/导入**（1.4.0）：面板一键把全部账号导出成一段 JSON，换设备/传手机后粘贴导入
- **模型切换真的生效**（1.5.1）：豆包工作模式的模型由 `option.need_deep_think`（模型 `item_id`）
  决定，`model_item_key` 只是辅助。三件套一起发才对：
  `need_deep_think=10001` + `model_config.model_extra_params={memory_profile:"300k_230",total_window_size:"300000"}`
  + `conversation_init_ext.agent_task_param`。只发 `model_item_key` 时上游会静默落回账号默认模型
  （表现就是"选了 4.1 flash，豆包那边还是豆包 2.1"）
- **扩展模型**：抓到新模型后，在 `extraModels` 里同时填 `modelItemKey` 和 `itemId`（网页版
  `need_deep_think` 的值），用 `node tools/capture-chat.mjs` 抓、`/doubao/models/probe` 验证
  （见「运维小工具」）
- **图片输入（1.6.0）**：DSH 会话里发图 → 豆包真的看图回答（适配器自动上传 + 登记，实测"蓝色，横向长方形"）
- **生图 / 生视频 / 出文件（1.6.0）**：面板「创作」区一键生成；生图回图片直链（markdown 内嵌显示），
  生视频等出片后回 mp4 直链，Word/PDF/表格回**签名直链**可直接下载，PPT 回对话入口；命令行 `tools/generate.mjs` 同能力
- **客户端身份（1.6.0）**：带 msToken 时请求整体切到豆包 PC 客户端身份（`aid=582478` + 客户端 UA +
  `chrome://doubao-chat/` Referer），实测网页身份被 710022004 风控拦死时客户端身份畅通
- **msToken 自动摘取（1.6.0）**：面板「抓取 msToken」/ `tools/mstoken.mjs --harvest`，从豆包客户端的
  请求里被动摘取并缓存，重启 DSH 也能用（存数据目录 `mstoken.json`）

## 多账号与 Cookie 导入/导出（accounts.json）

账号有两种添加方式，可混用：

**方式 A：DSH 插件配置面板** —— 在 `accounts` 数组里加一项，填 `cookie` + `remark`，由 DSH 自己持久化配置。

**方式 B：accounts.json 文件（推荐，改文件即生效，无需重启 DSH）** —— 在**数据目录**放一个 `accounts.json`：

> 数据目录默认是 `<dshHome>/doubao-work/`（Windows 即 `C:\Users\<你>\.dsh\doubao-work\`）。
> 1.2.5 之前它在插件目录里，而插件装在 `node_modules` 下，升级会被整目录重抄导致 Cookie 丢失；
> 老文件会在插件首次加载时自动迁移过去。可用配置项 `dataDir` 或环境变量 `DSH_DOUBAO_DATA_DIR` 覆盖。

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
- **导出**：复制这个 `accounts.json` 就是完整账号备份；面板「导出-导入账号」也能一键复制成账号包（见方式 C）
- **导入**：把文件放到另一台设备的**数据目录**（默认 `~/.dsh/doubao-work/`）即完成迁移
- 运行状态（冷却倒计时/用量统计）另存于同一数据目录的 `gateway-state.json`，不影响账号数据

**方式 C：账号包（1.4.0 起，换设备 / 传手机用这个）** —— 面板工具栏点「导出-导入账号」：

1. 点「导出账号包」→ 文本框里出现一整段 JSON（含全部账号的 Cookie），复制走
2. 在另一台设备（或手机）的面板里点「切到导入」，把这段 JSON 贴进去 → 「导入账号包」
3. 按 `id` 合并：同 id 覆盖 Cookie（续期/换号），新 id 追加；接口层还支持 `mode:'replace'` 整份替换

> 账号包 = `accounts.json` 的等价物，只走本机接口（同源 + 回环守卫），不经过任何服务器。
> 单个账号也可以直接把一段 Cookie 贴进导入框，服务端会认出来并当成新账号加进去。
>
> 手机 DSH 的用法：在电脑导出 → 用网盘/聊天工具/剪贴板同步把这段 JSON 传到手机 →
> 在手机 DSH 的同一页粘贴导入。这是目前手机上唯一能"整份迁移"的路子，原因见「待办 / 已知缺口」。

## 获取新账号的 Cookie

每个豆包账号各自登录网页版抓一次：

1. 浏览器（建议开无痕窗口）打开 [www.doubao.com](https://www.doubao.com) 并登录该账号
2. `F12` → Network → 随便点一个请求 → Request Headers → 复制整条 `Cookie` 值
3. 加进 `accounts.json` 的一个新条目（`id` 别重复）

## 多模态：看图 / 生图 / 生视频 / 出文件（1.6.0）

这四件事都走豆包**普通对话**（`agent_mode=2, mode_id=1, model_item_key=0`），不需要工作模式。

**前置：豆包 PC 客户端带调试端口启动**

```cmd
tools\start-doubao-debug.cmd
```

它在 127.0.0.1:9222 开调试口（不影响豆包正常使用）。客户端开着才有两样东西：
① msToken（客户端身份凭证，网页身份没有它会被 710022004 风控拦）② 图片上传通道（客户端有现成的
file input，借它上传不用自己实现火山引擎签名）。

**身份怎么选**：有 msToken 就走客户端（`aid=582478`、UA 带 `SamanthaDoubao/2.35.12`、
Referer `chrome://doubao-chat/`）；没有就退回网页身份。面板「看身份」能看到当前用的哪个。
msToken 是从客户端请求里**被动摘**的（`tools/mstoken.mjs --harvest`），自己随机编一个会被
710022002 拒掉，因为服务端会验。

**① 图片输入（DSH 发图 → 豆包看图）**

在 DSH 会话里直接发图。适配器把图块抽出来（兼容 base64/url/image_url 三种形状）→
借客户端上传成 `tos-cn-i-…` uri → 调 `pre_handle_v2_without_conv` 登记（**不登记豆包会装没看见**，
实测踩过）→ 消息体带 `attachment_block`（block_type 10052）。上传失败不静默丢图，会在正文里注明
"有几张没传过去、原因是什么"，让用户知道模型是在"没图"的情况下回答的。

**② 生图**：消息里出现 `block_type 2074` 创作块 → 解析 `creation_block.creations[].image.image_ori.url`
→ 以 markdown 图片内嵌在回复里。注意同一个创作块会先发占位（`{status,placeholder}`）再发真 URL，
去重必须等拿到 URL 再做（第一版在这里丢过整张图）。实测 12–18 秒出图，PNG 5–6MB。

**③ 生视频**：两轮协议——第一轮回"参数确认"（Seedance 2.0 Mini / 时长 / 比例），第二轮发
「确认，开始生成」才真排队；然后 mp4 **不在这条 SSE 里**，是之后以普通消息形式到达。所以
`generateVideo()` 会轮询 `/alice/conversation/latest_messagelist` 直到出现
`video.download_url`（实测 1–3 分钟，mp4 约 1.3MB）。拿不到时返回 `pending:true`，
稍后带同一个 `conversationId` 再调即可取回。

**④ 文件产出（Word / PDF / 表格 / PPT）**：两种形状都认：

| 形状 | 块 | 内容 | 能不能直接下 |
| --- | --- | --- | --- |
| `file_block` | `10020` | `{type,name,uri,url,size}`，`url` 是**签名直链** | ✅ 直接下载 |
| `artifact_block` | `10030` | 只有 `resource_id + conversation_id + title`（PPT 走这个） | ❌ 给"打开对话"入口 |

实测：Word 周报 113s 生成 → 回收直链 → 下载 HTTP 200、39KB、magic `PK`（合法 docx）。
文档类和视频一样，产出常在 **SSE 结束之后**才写进会话消息，所以 `generate()` 没拿到媒体时会自动
再轮询一轮（`collectMedia`，面板与 `tools/generate.mjs --kind file` 都走这套）。
PPT 走 `10030`：直连导出接口 `/samantha/otter/export/page/create` 试了十余组参数都是
`record not found`/`params invalid`（导出 token 只存在于云盘页面自己的会话里），**未攻克，如实标注**。

**接口与工具**：

```bash
# 面板操作即可完成；命令行等价物：
node tools/mstoken.mjs --status              # 看缓存的 token 与身份
node tools/mstoken.mjs --harvest             # 从客户端摘新 token（客户端要开着）
node tools/generate.mjs --kind image --prompt "画一只戴墨镜的柴犬，扁平插画" --save dog.png
node tools/generate.mjs --kind video --prompt "生成一段 5 秒视频：海边日落" --save sea.mp4
node tools/generate.mjs --kind file  --prompt "做一份 3 页 PPT：2026 计划"

# HTTP 接口（本机）：
curl -X POST http://127.0.0.1:<port>/doubao/generate -d '{"kind":"image","prompt":"..."}'
curl -X POST http://127.0.0.1:<port>/doubao/image/upload -d '{"path":"C:/tmp/a.png"}'
curl -X POST http://127.0.0.1:<port>/doubao/mstoken -d '{"action":"harvest"}'
```

## 已知限制（如实说明）

- **不支持工具调用（function calling）**：豆包对话接口没有该能力，本模型适合对话/写作/问答，**不适合当 Agent 主循环模型**
- 模型自认知会回答“豆包”（平台壳层统一身份），底层实际路由由 `model_item_key` 决定
- Cookie 会过期（数天到数周），失效后重新登录复制即可
- 每次调用都会在豆包账号里产生一条真实对话记录
- 属于个人自用的非官方接入方式，违反豆包用户协议的风险自担；建议小号使用、控制频率
- **图片输入依赖豆包客户端开着**（借它的 file input 上传）。客户端不开时会在回复里明确说
  "有几张图没传过去"，不会假装看过图
- **msToken 会过期**（跟登录态同寿命）。过期后表现为风控变严，面板点一次「抓取 msToken」即可续
- **只有 PPT 没有直链**：Word/PDF/表格（`10020`）给签名直链可直接下载；PPT 走产物卡片（`10030`），
  只能给"打开对话"的入口，下载要点豆包里的卡片
- **生视频要等**：提交后 1–3 分钟出片，插件默认最多轮询 8 分钟（`maxWaitMs` 可调），
  超时不代表失败，带 `conversationId` 再查一次就能取回
- 生图/生视频的直链是带签名的临时地址（几小时到几天），要留存就尽快下载

## 目录结构

```
dsh-doubao-work/
├── index.js           # 插件主体：注册 LlmAdapter + 状态/管理接口
├── doubao.js          # 上游内核：Cookie 直连 / SSE 解析 / 账号池 / 冷却 / 会话复用
├── host.js            # 宿主包解析：从安装目录取 @deepseek-ai/*（profile 安装的关键）
├── paths.js           # 数据目录：Cookie/状态放 <dshHome>/doubao-work，升级不丢
├── cookie-input.js    # 粘贴解析：整段 Cookie / 请求头 / cURL / JSON / cookies.txt → 规范串
├── browser.js         # 从浏览器导入：探测内核、拉起调试端口、CDP 只读抓 Cookie
├── uploader.js        # 图片上传：借豆包客户端的 file input 传到 imagex，回收 tos uri
├── mstoken.js         # msToken 摘取/缓存（客户端身份凭证）
├── client.js          # 浏览器半身：设置页「豆包工作」
├── package.json
├── cordis.patch.yml
├── tests/             # smoke.mjs（契约/接口）、upstream.mjs（本地假上游）、standalone.mjs（真启动网关打假上游）、
│                        browser-live.mjs（真开浏览器验登录助手）、profile-install.mjs（安装形态）
├── tools/             # status / accounts / panel / browser-import / model-probe / git-api-push
├── docs/              # 上游接口实测记录（抓包结论、SSE 事件表、模型 key 对照）
└── standalone/        # 复用 doubao.js 的 OpenAI 兼容网关（独立进程）
```

## 附：standalone 网关

`standalone/` 目录是独立 OpenAI 兼容网关（`node standalone/index.js`，默认 `127.0.0.1:3040/v1`），
适合不想装插件、或想给其他 OpenAI 客户端/中转站供流的场景。

- **1.4.0 起复用 `doubao.js`**：账号池、RPM 限速、并发排队、冷却分级、SSE 解析、流中断保护、
  `conversation_id` 复用全部与插件同一份代码，本文件只保留 OpenAI 协议适配 + HTTP 服务 + 状态页
- 配置 `config.json`，账号放 `accounts.json`；`models` 决定白名单（未列出的模型返回 400，不偷换）
- `config.contextReuse`（默认 `true`）复用上游会话；`DSH_DOUBAO_GATEWAY_DIR` 可换配置目录（多实例/测试用）
- 自测：`node tests/standalone.mjs`（真启动网关，上游指向本地假豆包，9 项）

## 内嵌设置页

插件带浏览器半身（`client.js`），重启 DSH 后会在 **设置 → 模型接入** 里多出一页「豆包工作」，
直接显示账号池、今日用量、预估剩余额度，并支持健康检查 / 启用停用 / 删除账号。

页面上还能「添加账号」（直接粘贴整段 Cookie，保存即生效）、「停用/启用」、「换 Cookie」与「删除」，
1.3.0 起多了「从浏览器导入」：点开临时浏览器窗口 → 在里面登录豆包 → 点「抓取 Cookie（并入库）」。
1.4.0 起工具栏还有「一键签到」（签整个账号池）、每行的「签到」（只签这一个号）、以及
「导出-导入账号」（账号包，见上文方式 C）。
1.5.0 起「从浏览器导入」展开后多了一行登录助手：手机号 / 打开登录框 / 发送验证码 / 验证码 / 登录，
下面实时显示自动导入状态与每一步的结果；导入成功后自动收起窗口并刷新列表。
停用的账号仍然显示在列表里（状态显示「已停用」），所以随时可以点回来启用。
「添加账号 / 换 Cookie」的粘贴框会自动识别六种粘贴形状并回显识别结果（见上文「获取 Cookie」），
空态文案与页脚会直接显示当前账号文件路径（数据目录可能被 `dataDir` 改过，写死路径会误导）；
页脚还会显示自动签到的下次执行时间（没配就提示 `checkinSchedule: "09:30"` 怎么写）。

离线自检（不重启、不联网、不耗额度）：

```bash
node tests/smoke.mjs      # 契约/路由/账号管理/粘贴解析/浏览器导入(CDP)/登录助手/自动导入/模型 key 抓取/签到/账号包/数据目录/模型选择/错误码/流协议，共 119 项
node tests/upstream.mjs   # 本地假上游：SSE 解析/换号/冷却/流中断/取消/会话复用/签到/key 验证/流内报错/活动下线，共 23 项
node tests/standalone.mjs # 真启动 standalone 网关（临时目录 + 假上游）：OpenAI 形状/流式/白名单/会话复用，9 项
ELECTRON_RUN_AS_NODE=1 "<安装目录>/DeepSeek Harness.exe" tests/browser-live.mjs
                          # 真开浏览器 + 本地假登录页，验证登录助手真的能点开弹窗/填号/发码/登录，6 项
ELECTRON_RUN_AS_NODE=1 DSH_HOST_MODULES="<安装目录>/app.asar/dsh/node_modules" \
  "<安装目录>/DeepSeek Harness.exe" tests/profile-install.mjs   # 模拟 profile 安装，6 项
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

node tools/browser-import.mjs --browser edge     # 命令行版「从浏览器导入」（--attach 连已开的调试端口）
node tools/model-probe.mjs --list                # 已配置模型 ↔ model_item_key 对照
node tools/model-probe.mjs --capture             # 抓新模型的 model_item_key（只开 Network 观察，不改页面）
node tools/capture-chat.mjs                      # 自动发一句话，抓网页版 /chat/completion 的模型字段（need_deep_think/item_id）
node tools/capture-chat.mjs --manual --wait 600  # 只观察不开火：你在窗口里切模型/发消息，它把请求体打出来
node tools/capture-live.mjs --seconds 600        # 记录窗口里所有 /alice /biz /samantha 接口调用（排查用）
node tools/model-probe.mjs --key <key>           # 验证某个 key 是否真生效（看 SSE_ACK 回写）

node tools/mstoken.mjs --status                  # 当前身份：客户端 / 网页，缓存的 token 从哪来
node tools/mstoken.mjs --harvest --wait 25       # 从客户端摘 msToken（客户端要带 9222 启动）
node tools/mstoken.mjs --set <token>             # 手工塞一个（比如从别处抓的）
node tools/generate.mjs --kind image --prompt "..." --save a.png   # 生图
node tools/generate.mjs --kind video --prompt "..." --save a.mp4   # 生视频（两轮 + 轮询）
node tools/generate.mjs --kind file  --prompt "..."                # 出文件（PPT/Word/PDF/表格）
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

- `GET  /doubao/status`（或 `/api/doubao/status`）— 账号池（含停用）+ 今日用量 + 会话数 +
  `runtime.host`（宿主包解析来源，排查「装上了但没生效」先看这里）+
  `dataDir` / `accountsPath`（账号文件到底在哪，面板空态就用它）+
  `checkinSchedule`（配置的每日签到时刻）/ `checkinNextAt`（下次执行时间戳，未开启为 0）+
  `loginWatch`（登录助手自动导入的 `{state, account, attempts, reason}`）
- `POST /doubao/check` — 逐账号健康检查
- `POST /doubao/account/add|update|enable|remove` — 账号增删改启停（`update` 用于换 Cookie，不用删了再加）。
  `add`/`update` 的 Cookie 字段接受任意常见粘贴形状，成功时返回 `parse`
  （`{format, pairs, describe, warnings}`），失败时返回 400 + `format` + `warnings` 说明为什么没解析出来
- `POST /doubao/checkin` — 全部账号（或 `{"id":"acc-1"}` 单号）每日签到，返回 ok/already/skipped/failed 汇总
- `POST /doubao/checkin/status` — 单账号今日签到状态（`{"id":"acc-1"}`）
- `POST /doubao/browser/browsers` — 探测到的可用浏览器（`{browsers:[{id,name,path}], configured}`）
- `POST /doubao/browser/launch` — 拉起带调试端口的临时浏览器窗口（`{browserId?, browserPath?, port?, startUrl?}`），
  返回 `{port, pid, profileDir, browser, hint}`；已活着则复用同一个窗口（`reused: true`）
- `POST /doubao/browser/grab` — 抓取并入库（`{port?, id?, remark?, save?}`，`save:false` 只回结果不写文件）；
  成功返回 `{ok:true, describe, doubaoCookies, httpOnly, keys, id}`，没登录返回 `{ok:false, stage:'login', reason}`
- `POST /doubao/browser/login` — 登录助手：`{action:'probe'|'open'|'phone'|'code', phone?, code?, port?}` →
  `{ok, stage, steps, form:{inputs,hasSendButton,hasSubmitButton,pageText}}`；`stage` 取值
  `form`/`sent`/`submitted`/`no-login-button`/`no-form`/`no-send-button`/`no-submit`/`bad-phone`/`bad-code`。
  手机号/验证码**不会**出现在返回里
- `POST /doubao/browser/wait` — 自动导入状态：`{state:'idle'|'watching'|'done'|'timeout'|'closed', imported, account, attempts, reason}`
- `POST /doubao/browser/close` — 结束拉起的浏览器进程并清理临时 profile
- `POST /doubao/accounts/export` — 导出账号包：`{ok, count, accounts, json}`，`json` 就是能整体复制的那段
- `POST /doubao/accounts/import` — 导入账号包或单条 Cookie：`{text, mode:'merge'|'replace'}` →
  `{ok, mode, added, updated, skipped, total}`（按 `id` 合并，同 id 覆盖 Cookie，重复导入幂等）
- `POST /doubao/models/probe` — 验证一个 `model_item_key` 是否真被服务端接受：`{key, id?}` →
  `{ok, echoed, key, account}`，判据是 SSE_ACK 里服务端回写的 key（不是模型自称），会消耗一次极短对话
- `POST /doubao/generate` — 生成产出：`{prompt, kind:'image'|'video'|'file'|'any', id?, conversationId?,
  imagePath?, pollMs?, maxWaitMs?}` → `{ok, kind, account, conversationId, text, media, all, pending, polls,
  transport, hint}`。`imagePath` 传本地图会先上传+登记再一起发（改图/看图）；视频 `pending:true`
  表示还在生成，带 `conversationId` 再调一次即可取回
- `POST /doubao/image/upload` — 上传本地图片：`{path}` → `{ok, uri, identifier, preGenerateId, transport}`，
  拿到 `uri` 就能在 `/doubao/generate` 里用
- `POST /doubao/mstoken` — msToken 管理：`{action:'status'|'set'|'harvest'|'clear', token?, port?, wait?}` →
  `{ok, transport, cached:{token,masked,source,ageMinutes}, ...}`；`harvest` 从豆包客户端被动摘取

**访问控制**：带 `Origin` 的浏览器请求必须同源；不带 `Origin` 的调用只放行本机（`127.0.0.1` / `::1`）。
需要从别的机器调管理接口时，在配置里设 `adminToken`，并带上请求头：

```bash
curl -X POST http://<host>:<port>/doubao/account/add \
  -H 'x-doubao-admin-token: <你的 adminToken>' \
  -H 'content-type: application/json' -d '{"account":"...","cookie":"..."}'
```

`adminToken` 留空 = 只允许本机调用（默认，最安全）。

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

1.6.0 的多模态实测（客户端身份参数表、msToken 三次验证、图片上传 + `pre_handle` 登记全流程、
生图 2074 块与占位去重、生视频两轮协议与 `latest_messagelist` 轮询、10030 产物卡片与导出接口失败记录）见
[`docs/接口勘察-2026-11-14-多模态实测.md`](docs/接口勘察-2026-11-14-多模态实测.md)。

## 开发自测

两套离线测试都不联网、不消耗豆包额度：

```bash
node tests/smoke.mjs      # 插件契约 + HTTP 管理接口 + 适配器流协议（123 项）
node tests/upstream.mjs   # 本地假豆包上游（SSE 帧与线上一致，38 项）
```

1.6.0 新增覆盖：带图消息体（10052 附件块 + pre_handle 登记）、图片占位块去重、产物卡片 10030 解析、
视频轮询（latest_messagelist → `download_url`）、`extractImageParts`/`uploadImagesForRequest` 的
失败路径（不静默丢图）。

`tests/smoke.mjs` 会 `import('../index.js')`，因此需要能解析到 peer 依赖
`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/schemastery`。在本机开发时直接把 DSH 安装目录
`resources/app.asar` 里 `dsh/node_modules/@deepseek-ai/` 的同版本包放到本仓库 `node_modules/` 下即可
（`node_modules/` 已在 `.gitignore` 里）。装好真实包还有个好处：类型/字段名与宿主完全一致，
不会测出一个"只在 mock 里成立"的协议。

## 待办 / 已知缺口

- **手机端一键导入做不了**（不是偷懒）：插件代码跑在桌面宿主上，读不到手机浏览器的登录态——
  iOS 沙箱不允许访问别的 App 的文件，Android 非 root 也一样。手机现实可用的路子是
  「桌面 `tools/browser-import.mjs` 抓完 → 把 `accounts.json` 传到手机的数据目录」或直接粘贴。
- **读浏览器 Cookie 库**（Chrome/Edge 的 sqlite + DPAPI/ABE）没有做，也不建议做：Chrome/Edge 127+ 的
  App-Bound Encryption 让第三方进程解不开，macOS/Linux 又各有 Keychain/Secret Service 门槛，
  国产内核路径不一。CDP 一条路把这些全绕开了，见上文「从浏览器导入是怎么做的」。
- 8 个未抓 `model_item_key`（豆包 2.1 Pro / Kimi K3.1 Pro / Kimi K3 / GLM 5.3 / GLM 5.3 Flash / DeepSeek V4 Pro 等）：
  抓取与验证工具已就位（`tools/model-probe.mjs --capture` / `--key` + `/doubao/models/probe`），
  但**真实 key 必须用登录态账号在网页里逐个点一遍才能拿到**，所以没在仓库里编造。抓到后加进 `extraModels` 即可。
- `standalone/` 已在 1.4.0 **改成直接复用 `doubao.js`**（账号池/RPM/冷却/SSE/会话复用只有一份实现），
  并补了 `tests/standalone.mjs`。仍**不支持 function calling**（上游没有这个能力），也没有接浏览器导入。
- 签到：面板「一键签到」+ 每日定时（`checkinSchedule` + 启动后补签）都已接线完成，见「更新记录」1.4.0。
- **后端**扫码/短信登录仍不可行（webmssdk，`非法应用(22)`）。1.5.0 改成"面板填号 → 动作送进我们开的窗口"，
  页面自己签名，所以不需要宿主暴露 WebContents；代价是必须开着那个临时窗口。
  若宿主将来提供内嵌窗口 API，这套 CDP 驱动就能整个搬进 DSH 自己的页面里（连窗口都不用另开）。

## 更新记录

- **1.6.1**（2026-11-14，文件直链 + 产出回收）：
  - **Word/PDF/表格能直接下载了**：这类文件是 `block_type 10020`（`file_block`），自带签名直链；
    实测 Word 周报 113s 生成 → 回收 → 下载 HTTP 200、39KB、magic `PK`（合法 docx）。
    PPT 仍是 `10030` 产物卡片（无直链，给对话入口）。
  - **新增 `collectMedia()`**：视频/文档的产出常在 SSE 结束之后才写进会话消息，统一轮询
    `latest_messagelist` 回收；`generate()`、`/doubao/generate`、`tools/generate.mjs` 都接上了。
  - **修掉生成长任务被掐断**：`_withTimeout(signal, extraMs)` 支持按次放宽，
    之前 PPT 跑到 182s 会被内部 180s 超时中断（`aborted`），现已放宽到 10 分钟。
  - 回复里的文件行按类型给不同提示：直链标"尽快下载（39KB）"，产物卡片标"进对话点卡片下载"。
  - 测试：`smoke` **123 项**、`upstream` **38 项**。

- **1.6.0**（2026-11-14，多模态与创作产出）：
  - **图片输入真的通了**：DSH 发图 → 借豆包客户端的 file input 上传到 imagex → 调
    `/alice/message/pre_handle_v2_without_conv` 登记 → 消息体带 `attachment_block`（10052）。
    实测：一张纯蓝 PNG，模型答「蓝色，横向长方形」；纯蓝 240×160，问到颜色形状全对。
  - **上传不用自己实现火山签名**：原来卡在 veImageX（prepare_upload 发 STS → 签名 PUT → Commit），
    后来发现客户端自己就能传，CDP 塞文件 + 从 `pre_handle` 请求里回收 `tos-cn-i-…` uri 即可。
  - **漏登记会装看不见图**：只带 uri 不登记 pre_handle 时模型会回「我这边没有收到图片」，
    补上登记后稳定；失败也不静默丢图，正文里注明"有几张没传过去 + 原因"。
  - **生图**：`2074` 创作块 → `creation_block.creations[].image.image_ori.url` → markdown 内嵌。
    占位块（无 URL）与真 URL 分两次下发，去重键改成 `id|url` 否则真图会被当重复丢掉（踩过）。
  - **生视频**：两轮协议（提需求 → 回参数确认 → 「确认，开始生成」）+ 轮询
    `/alice/conversation/latest_messagelist` 取 `video.download_url`。实测 5.4s 拿到确认、
    约 2 分钟后出片，mp4 1.3–1.7MB 可下载（`ftyp` 校验通过）。超时返回 `pending:true` 可续查。
  - **文件产出**：`10030` 产物卡片 → 解析 `resource_id/title/conversation_id`，给"打开对话"
    当下载入口；直连导出 `/samantha/otter/export/page/create` 试了十余组参数仍 `record not found`，
    如实标注未攻克。
  - **客户端身份 + msToken**：网页身份被 `710022004` 风控拦死（两个号都中），换客户端身份
    （`aid=582478`、UA `SamanthaDoubao/2.35.12`、Referer `chrome://doubao-chat/`、msToken）后畅通。
    msToken 自己编会被 `710022002` 拒，只能从客户端被动摘；已做缓存（`mstoken.json`）+ 面板一键摘。
  - **面板新增**：「创作」区（选生图/生视频/出文件 + 一句话 → 结果直接显示）+ 「抓取 msToken」/「看身份」。
  - **新接口**：`/doubao/generate`、`/doubao/image/upload`、`/doubao/mstoken`；
    新工具 `tools/generate.mjs`、`tools/mstoken.mjs`；新模块 `uploader.js`、`mstoken.js`。
  - **文件产出比预期好**：Word/PDF/表格走 `block_type 10020`（`file_block`），带**签名直链**，
    实测下载 39KB docx、magic `PK`；PPT 走 `10030` 产物卡片，没有直链，仍只能给对话入口。
  - **产出常在 SSE 结束后才落库**：新增 `collectMedia()` 回收器（视频/文档共用），
    默认再等 1–2 分钟，超时如实 `pending`。同时修掉"生成到 182s 被内部 180s 超时掐断"的老问题。
  - 测试：`smoke` 119 → **123 项**、`upstream` 27 → **38 项**，新增带图消息体、pre_handle 登记、
    视频轮询、10020/10030 两类文件块、collectMedia、上传失败提示等用例。
- **1.5.3**（2026-11-14，签到活动下线的实证 + 抓包工具）：
  - **签到为什么一直失败，终于有服务端原话了**：接进电脑版豆包自带的 webview 后抓到
    `POST /alice/ug/campaign/v3/detail/ {"campaign_group_code":"pc_incentive_task_mvp_v3"}`
    → `{"data":null,"code":2,"message":"campaign not found"}`，
    同时 `/alice/ug/campaign/landing/get` 返回的页面配置是空的（`buttons:[]`、`content:""`）。
    结论：这不是账号资格问题、不是代理问题、也不是本插件的实现问题——**限时活动在 0 点下线了**，
    客户端里那一页自然渲染不出内容（"该页面暂时不可用"），签到接口也就一律 `710010702`。
    插件现在把这个错误说成人话：「活动当前未开放（服务端 campaign not found，多为限时活动已下线）」。
  - **新增 `tools/start-doubao-debug.cmd`**：用 `--remote-debugging-port=9222` 启动电脑版豆包
    （只在 127.0.0.1 开调试口，不走代理、不改系统设置），配合 `tools/capture-app.mjs` 抓客户端内的接口。
  - **`tools/capture-app.mjs` 重写**：先等调试端口出现（豆包可能还没启动），再**动态挂上之后才打开的页面**
    ——签到页是点进「免费用豆包工作」时才创建的 webview，不等它出现就抓不到。
- **1.5.2**
- **1.5.2**（2026-11-14，签到真相 + 伪装客户端打开签到页）：
  - **查清了「签到失败」到底是谁的问题**：接进电脑版豆包（Chromium 147，`--remote-debugging-port=9222`）后，
    在它自带的 webview 里点「立即签到」，服务器返回的仍是 `710010702 系统错误`——和插件发的一模一样，
    请求体都是 `{"scene":"pc_incentive_task_mvp_v3"}`。所以失败不在插件、也不在代理，是服务端在拒。
    跨 0 点后连状态接口 `/alice/ug/campaign/v3/detail/` 都变成 `code=1 invalid param`（同一份参数当天早些时候还返回奖励配置）。
  - **新增「打开签到页」**：那一页只在豆包客户端里给签到按钮，判断依据是 UA 尾巴上的
    `SamanthaDoubao/<版本>`（实测客户端 webview 的 UA 是 `… Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.35.12`）。
    现在用 CDP 改 UA + 注入 Cookie，普通浏览器窗口里也能打开
    `https://www.doubao.com/pc/agent-explore?enter_method=fixed_entry` 并看到「立即签到」。
    面板加了按钮，接口 `POST /doubao/checkin/open`，命令行 `node tools/open-checkin.mjs`。
  - **签到状态不再笼统记"失败"**：活动接口不可用（`code=1` / `710010702`）时记为 `unavailable`，
    面板显示「活动暂不可用」，当天不再重复打接口（打也是硬拒，还白挨风控），活动恢复后能重新签。
- **1.5.1**
- **1.5.1**（2026-11-13，模型切换 + 两处误判）：
  - **选了模型不生效（P0，已修）**：抓了网页版工作模式的真实请求，模型是 `option.need_deep_think`
    （模型 `item_id`，4.1 flash = 10001）决定的，`model_item_key` 只作辅助。之前只发 key，
    上游静默落回账号默认模型（`model_id` 恒为 38，怎么换 key 都不变）。现在三件套一起发：
    `need_deep_think`、`model_config.model_extra_params`（`memory_profile`/`total_window_size`）、
    `conversation_init_ext.agent_task_param`（工作台运行时），并补上 `conversation_mode: 2`。
    实测同一句话：`need_deep_think=0` 回答"我是豆包…"，`=10001` 回答"模型名称属于内部细节，不便透露"，
    两种行为确实不同。`extraModels` 新增 `itemId` 字段，`/doubao/models/probe` 也接受 `itemId`。
  - **风控被误报为空响应（P1，已修）**：上游其实回了 `STREAM_ERROR 710022004 rate limited` +
    `type=verify`（要求人机验证），旧代码忽略该事件，最后只剩"上游未返回内容"。现在按 `RATE_LIMIT`
    上报并带错误码，日志和面板都能看出真因。
  - **系统提示词不再外发（P1，已修）**：宿主每轮会把整段系统提示词（含工具说明）传给适配器，
    旧实现原样拼进发给豆包的文本里——白吃额度，还把本机环境细节泄露给第三方页面。现在默认丢弃，
    需要透传时把 `sendSystemPrompt` 设为 true。
- **1.5.0**（2026-11-13，登录助手 + 自动导入，修「抓取失败 HTTP 500」）：
  - **修 P0：数据目录解析把函数当成路径**。宿主注册的是 `dshHomePath(...segments)` **函数**，
    旧代码 `String(ctx.get('dshHomePath'))` 把函数源码拼进了路径，于是
    `accountsPath` 变成 `…function dshHomePath(){…}…/doubao-work/accounts.json`，
    一写就 `ENOENT`（面板上就是「抓取失败：HTTP 500 … no such file or directory」）。
    现在按函数调用取返回值，并加了一道「返回值不像路径就落回 `~/.dsh/doubao-work`」的兜底；
    `/doubao/status` 的 `dataDir` / `accountsPath` 也终于显示真实路径了。
  - **登录助手**：面板里填手机号 → 「发送验证码」→ 填验证码 → 「登录」，动作通过 CDP
    （`Runtime.evaluate` 定位 + `Input.dispatchMouseEvent` 点击 + `Input.insertText` 填字）送进插件
    自己拉起的那个窗口。后端不模拟登录（webmssdk 签名只在页面上下文成立），手机号不落盘、
    不回传前端，每步回 `steps` 便于排障。
  - **登录后自动导入**：窗口一开就每 2.5 秒读一次 Cookie，检测到 `sessionid`/`sid_guard` 自动入库、
    关窗口、刷新列表；5 分钟超时会停并在面板说明。手动在窗口里登录同样会触发。
  - **修 `safeTempDir`**：从 Git Bash/MSYS 启动时 `os.tmpdir()` 可能是 `/tmp`，
    传给 Windows 浏览器会变成非法 `--user-data-dir`（窗口闪一下就没了、调试端口从不监听），
    现在换成真正的 Windows 临时目录。
  - **测试**：smoke 108 → 116（登录助手 6 项 + 自动导入 2 项），新增 `tests/browser-live.mjs`
    （真开浏览器 + 本地假登录页，6 项，验证点击/填字/发码/提交真的生效）。
- **1.4.0**（2026-11-13，签到/账号包/模型 key/standalone 合并）：
  - **每日自动签到**：面板加「一键签到」（整池）与每行「签到」（单号）；配置 `checkinSchedule: "09:30"`
    后每天到点自动签，`checkinCatchUp: true`（默认）时启动后 15 秒发现"今天还没签"会自动补一次。
    定时器按 provider 注册在 `globalThis.__dshDoubaoCheckinTimers`，重载插件时先清旧的，不会叠加。
    状态接口新增 `checkinSchedule` / `checkinNextAt`，面板页脚显示下次执行时间。
  - **账号包导出/导入**：`/doubao/accounts/export|import` + 面板「导出-导入账号」。导出是一段可整体复制的
    JSON（`accounts.json` 等价物），导入支持 `merge`（按 id 合并，同 id 覆盖 Cookie、幂等）与 `replace`；
    只贴一段 Cookie 也能当新账号导入。这是换设备/传手机时唯一能整份迁移的办法。
  - **模型 key 抓取与验证**：`tools/model-probe.mjs`（`--capture` 监听页面 `chat/completion` 请求体抓
    `model_item_key`、`--key` 验证、`--list` 对照）+ `POST /doubao/models/probe`。验证判据是
    **SSE_ACK 里服务端回写的 `model_item_key`**（`DoubaoClient.probeModelKey`），回写不等于传入就是没生效，
    不靠"模型自称是谁"猜。抓取只开 CDP `Network` 观察域，不注入脚本、不改页面，且必须用户手动触发。
  - **standalone 合并**：`standalone/index.js` 从 585 行降到 ~320 行，删掉第二份账号池/RPM/冷却/SSE 实现，
    改为 `new DoubaoClient(...)` + OpenAI 协议适配；顺带获得流中断保护、会话复用、统一冷却策略。
    新增 `tests/standalone.mjs`（真启动子进程 + 本地假上游，9 项：健康检查/模型白名单/apiKey/非流式/
    流式/未知模型 400/会话复用/状态页/健康检查接口）。
  - **测试**：smoke 94 → 108 项（新增 model_item_key 抓取 3 项 + 签到/账号包/浏览器用例），
    upstream 17 → 20 项（probeModelKey 三种结局）。
- **1.3.0**（2026-11-13，加「从浏览器导入」）：
  - **新增 `browser.js`**：CDP（Chrome DevTools 协议）抓取豆包 Cookie。探测本机 Chromium 内核浏览器
    （Edge → Chrome → Chromium，含 Windows 上 `EdgeCore\<版本>\msedge.exe` 这种布局），用
    `--remote-debugging-port=<随机端口>` + **独立临时 `--user-data-dir`** 拉起窗口（Chrome 136 起默认配置目录
    上的调试端口会被静默忽略，所以必须独立目录，同时也避免碰用户日常数据），登录完成后走 browser 端
    WebSocket 的 `Storage.getCookies` 取 Cookie，按 `.doubao.com` 域过滤、同域名按 path 长度择优，
    拼成规范串直接入库——HttpOnly 的 `sessionid` / `sid_guard` 也能拿到。
  - **不做成"读浏览器 Cookie 库"**：Chrome/Edge 127+ 的 App-Bound Encryption、macOS Keychain、
    Linux Secret Service、国产内核差异、库被占用时 `EBUSY`，任一都能让方案失效或误报「Cookie 无效」。
    这条路明确放弃并在 README 里写清理由，省得后来人重踩。
  - **安全边界写死**：只连 `127.0.0.1`（`grabAllCookies` 直接拒绝非本机 ws 地址）、只发 `Storage.getCookies`
    一条只读指令、只取豆包域；接口与日志不返回也不打印 Cookie 本体；临时 profile 在 `/doubao/browser/close`
    时删除。
  - **新增接口**：`/doubao/browser/browsers|launch|grab|close`（沿用同源/回环守卫与 `adminToken` 机制）。
    `grab` 默认入库（`save:false` 只取不写），同一份 Cookie 再抓不会重复建号；没登录时返回 `stage:'login'`
    和可读原因，而不是塞个坏账号进去。
  - **设置页**：工具栏加「从浏览器导入」，打开后显示临时窗口信息与「抓取 Cookie（并入库）」「关闭窗口」。
  - **新增 `tools/browser-import.mjs`**：命令行版（`--browser` / `--port` / `--attach` / `--wait` / `--no-save` /
    `--id` / `--remark`），适合无面板环境与排障。
  - **测试**：smoke 增至 94 项（CDP 10 项走假 CDP 服务 + 假 WebSocket + 假 spawn，不真开浏览器），
    并断言 spawn 参数必须带独立 `user-data-dir`、只发 `Storage.getCookies`、拒绝非本机端口。
  - **零依赖 WebSocket 兜底**：仓库声明 `engines: node>=20`，但普通 Node 20 没有全局 `WebSocket`，
    所以 `browser.js` 里带了一个只够 CDP 用的最小客户端（文本帧 + 掩码 + close/ping，不处理压缩分片）；
    运行时有全局 `WebSocket`（Electron 44 / Node 22+）就优先用运行时的。本机已实测：
    `node tools/browser-import.mjs --no-save` 在 Node 20 下真实拉起 EdgeCore 并读到豆包 Cookie
    （未登录时 11 个，登录后即可入库），结束后窗口自动关闭。
  - **残留清理**：`launch` 前清掉 6 小时前的 `dsh-doubao-cdp-*` 临时 profile（只认自家前缀，
    不动还开着的窗口）。

- **1.2.6**（2026-11-13，粘贴这一步做顺）：
  - **粘贴框不再只认「整段 Cookie」**：新增 `cookie-input.js`，把六种常见粘贴形状统一解析成规范串——
    整段 Cookie、`Cookie: …` 请求头、整个 Request Headers 面板、右键「Copy as cURL」的整条命令
    （`-H 'cookie: …'` 与 `-b "…"` 都认，含 bash `\` / cmd `^` 续行）、扩展导出的 JSON、Netscape `cookies.txt`。
    同名字段取最后一次，非 Cookie 正文会被丢掉而不是写成噪声字段；缺 `sessionid`/`sid_guard` 时提示
    「可能不是登录状态下拷的」。`/doubao/account/add|update` 成功时回 `parse`（识别成什么、几个字段、
    有哪些提醒），失败时回 400 + 原因；`tools/accounts.mjs add` 走同一套解析。
  - **面板空态与页脚改成真实路径**：空态不再说「在插件目录的 accounts.json 里加一条」（1.2.5 起已搬到
    数据目录，这句话会把用户指错地方），改为「点添加账号粘贴即可」，并直接显示 `/doubao/status` 返回的
    `accountsPath`；状态接口新增 `dataDir` / `accountsPath` 两个字段。
  - **测试**：smoke 从 66 项增至 84 项（新增粘贴解析 12 项 + 管理接口端到端 5 项 + 路径暴露 1 项）。

- **1.2.5**（2026-11-13，修的是「装上就加载不了」）：
  - **profile 安装后加载失败（P0，已修）**：宿主的 loader 只把**插件入口那一个裸名**重定向到安装目录
    （`HostResolvedRootInclude.import`），插件内部的 `import '@deepseek-ai/dsh-llm'` 仍按 Node 默认规则
    查找；profile 的 `node_modules` 里只有插件自己，于是加载期直接 `ERR_MODULE_NOT_FOUND`。仓库内开发有
    开发副本所以看不出问题——这个插件此前其实从未真正装载过。新增 `host.js`：显式回到安装目录
    （`process.resourcesPath` 下的 `app.asar/dsh/node_modules`）取宿主**同一份**模块，保证
    `LlmError instanceof HarnessError` 成立（换成 pnpm 再装一份副本的话，错误码会整体退化成 UNKNOWN）。
    实在取不到才退化为本地兜底错误类：把 `code` 与 `failure` 都写成自身数据属性，宿主
    `normalizeLlmFailure()` 的快照路径同样认得，错误码依然不丢。`/doubao/status` 增加 `runtime.host`
    显示解析来源（`bare` / `install:<目录>`），线上可自查。
  - **升级会丢 Cookie（P1，已修）**：`accounts.json` 与 `gateway-state.json` 原来写在插件目录里，
    而 `dsh plugin add` 升级会把 `node_modules/dsh-doubao-work` 整目录重抄一遍，Cookie 跟着丢。
    新增 `paths.js`：默认落到 `<dshHome>/doubao-work/`（与 dsh-ops 同构），首次使用自动从插件目录迁移
    并保留原件；可用配置项 `dataDir` 或环境变量 `DSH_DOUBAO_DATA_DIR` 指定；`tools/` 下四个命令行
    小工具同步改用同一份文件。
  - **新增安装形态自测**：`tests/profile-install.mjs` 用 Electron 的 node 模式把插件复制到没有
    `node_modules` 的临时目录里加载，验证「从安装目录拿到宿主包」「LlmError 与宿主同一个类」等 6 项；
    普通 node 环境自动跳过。
- **1.2.4**（2026-11-13）：
  - **复用起点改为尾部锚定（P1）**：`planReuse()` 原先按 `e.msgCount` 下标切片，而宿主会在**头部**重注入
    system/上下文块，下标整体右移——于是起点落在旧的 user 消息上，把上游已有的消息再发一遍
    （表现为同一轮上下文重复出现）。现在只要上一条 assistant 的哈希与上次返回一致，就直接取 `len - 1`，
    与下标漂移无关；一次追加多条而取不到上轮回复时，才退回按下标定位并跳过 assistant。
  - **测试恢复可用（P1）**：1.2.2 收紧回环守卫、1.2.3 加了两条签到路由之后，`tests/smoke.mjs` 其实一直全红
    （断言写死 7 条路由；mock 请求没带 `socket`，被守卫一律判 403；适配器桩没有 `planReuse`）。
    现改为断言路由集合、mock 带上回环 `socket`、补齐桩，并新增 planReuse 8 项、签到接口契约 8 项、上游签到 6 项。
- **1.2.3**（2026-11-13）：
  - **每轮都开新会话（P1，已修）**：`reusableConversation()` 要求历史条数**严格 +1** 才复用上游会话，而宿主每轮
    会重排消息、重注入 system/上下文块，条数几乎总在跳变，于是每一轮都整段重发、上游每次新建会话——表现就是
    "同一个对话里每轮都失忆"。新增 `planReuse()`：只要 ① 复用键一致且在 TTL 内 ② 条数**没有回退**
    ③ 上一条 assistant 内容与本插件上次返回一致（防宿主换分支/串号），就判定为同一段对话，
    只补发「上次之后真正的新消息」。条数回退（历史被截断/压缩）时仍整段重发，避免丢上下文。
  - **补发起点修正（P1）**：复用时的起点会跳过上一轮由上游生成的 assistant 回复，否则会把自己的回复
    当成用户输入再发一遍，模型会"复读"自己的话。
  - **切换模型即断上下文（P1，已修）**：`conversationKey()` 此前把模型名拼进复用键，模型一换键就变，
    上下文必然断。现只按「首条消息全文长度 + SHA1」计算，模型只影响上游 `model_item_key`。
  - **模型映射更宽容 + 可诊断（P2）**：`resolveModelItemKey()` 支持大小写/空格/下划线差异，以及宿主偶尔
    下发的 `provider/model` 整串（取末段再匹配一次）；未知模型报错里直接列出本插件支持的模型 id；
    每次调用记一条 `模型映射 x -> y` 日志；`/doubao/status` 新增 `lastModel` / `lastModelAt` / `lastReuse`
    （本轮是否复用、从第几条开始发、总条数），用于核对"我切了模型，宿主到底下发了什么"。
  - **一键签到（新增）**：`client.checkin()` / `checkinAll()` / `getCheckinStatus()`，走上游
    `POST /alice/ug/campaign/landing/checkin`（`scene: pc_incentive_task_mvp_v3`），配套
    `/v3/detail/` 读 `checked_in_today`；新增路由 `/doubao/checkin`、`/doubao/checkin/open`、`/doubao/checkin/status`
    （同源 + 回环 + `adminToken` 守卫），面板增「一键签到」按钮与 `/api/checkin`。
    注：2026-11-13 实测该接口服务端返回 `710010702 系统错误`（人工点击同样如此），属上游侧问题。
  - **面板 `contextReuse` 不再硬编码 `true`**：改为读实际配置，关掉复用时面板不再显示"开"。
- **1.2.2**（2026-11-13）：
  - **管理接口守卫收紧**（P1）：此前 `sameOrigin` 的逻辑是「没有 `Origin` 头就放行」，等于只防住了浏览器
    跨源请求（CSRF）；任何本机进程、或插件监听 `0.0.0.0` 时同网段的机器，都能直接 `POST` 增删账号。
    现在改为：带 `Origin` 必须同源；不带 `Origin` 只放行回环地址（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），
    跨机调用必须携带新增配置项 `adminToken` 对应的 `x-doubao-admin-token` 头（等长逐字节比较，不按前缀提前返回）。
    本机调用与同源浏览器访问不受影响。
  - **面板同源校验 + 注入修复**（P1）：`tools/panel.mjs` 的写接口此前**完全没有**同源校验，任意网页都能对
    `127.0.0.1:3000` 发 `POST` 增删账号；现已补上。同时账号 `id` 此前直接拼进内联 `onclick`，
    `id` 里若带单引号可跳出 JS 字符串——注意把 `'` 转成 `&#39;` **并不能**解决问题（浏览器解析属性时会还原成 `'`），
    现改为先 `JSON.stringify` 成字符串字面量再做属性转义，`esc` 也补齐了 `"` 与 `'`。
  - **会话复用不再串号**（P2）：复用键此前是「模型名 + 首条消息前 200 字」，两个不同会话只要开头相同
    （比如都以"帮我看下这段代码"起头）就会共用同一条上游会话，回答互相串。改为 `conversationKey()`
    （全文长度 + 全文 SHA1 前 16 位）。局限照旧：宿主未暴露 session id，首条消息完全相同的两段对话仍无法区分。
  - **不再接管 `SIGINT`**（P2）：此前插件在 `apply` 里注册 `SIGINT` 并 `flush` 后 `process.exit(0)`，
    等于插件替宿主决定 Ctrl+C 的行为，且每次热重载都会累积监听器。现只注册一次进程级 `exit` 落盘钩子。
  - **`usage.inputTokens` 按全量上下文估算**（P2）：复用会话时本次只发最后一条，但上游计费覆盖整段上下文，
    此前只按最后一条估算，统计偏低。
  - **standalone 同步**（P2）：流解析函数返回 `{ text, truncated }`，断流时 `finish_reason` 如实标为 `length`
    并记 warn 日志，不再把半截回复当成完整回复返回。
  - **`engines`**：补 `node: >=20`（用到 `crypto.randomUUID`、`node:` 前缀导入等）。
- **1.2.1**（2026-11-13）：
  - **配置项补齐**：`baseUrl` / `requestTimeoutMs` / `globalMaxConcurrency` / `queueWaitMs` /
    `dailyQuota` / `upstream`（设备参数）此前只在 `doubao.js` 里读取、未在 `Config` Schema 声明，
    导致配置面板改不了、README 里"经 `baseUrl` 替换上游"实际做不到。现已全部登记，保守默认值不变。
  - **推送脚本修复**：`tools/git-api-push.mjs` 的删除检测写在了 `fs.readFileSync` 之后，
    工作区里已删、索引仍收录的文件会先抛 `ENOENT`，`sha: null` 的删除分支永远走不到。已调整顺序。
  - **可执行位保留**：推送时 mode 改为从 `git ls-files -s` 读取真实值，不再硬编码 `100644`
    （此前带 shebang 的脚本推上去会丢可执行位）。
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

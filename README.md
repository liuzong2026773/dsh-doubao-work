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

1. 把本目录（4 个文件）放到 DSH 可访问的插件目录
2. 按 DSH 插件bundle 机制挂载 `cordis.patch.yml`
3. 在插件配置面板的 `accounts` 里填入豆包 Cookie（见下）
4. 重启/刷新后，模型列表出现「豆包工作（免费额度）」

## 获取 Cookie

1. 电脑浏览器打开 [www.doubao.com](https://www.doubao.com) 并登录
2. `F12` → Network → 随便点一个请求 → Request Headers → 复制整条 `Cookie` 值
3. 粘贴到插件配置 `accounts[0].cookie`

## 功能

- **多账号池**：轮询/随机调度，Cookie 填多个即可
- **冷却分级**：429/403 长冷却 24h（对应“第二天恢复”）、5xx 短冷却 5 分钟、Cookie 失效单独标记
- **单账号 RPM 限速**（默认 6/分钟，可配），防止高频触发风控
- **失败自动换号重试**
- **扩展模型**：后续抓到新的 `model_item_key` 可在 `extraModels` 配置里加

## 已知限制（如实说明）

- **不支持工具调用（function calling）**：豆包对话接口没有该能力，本模型适合对话/写作/问答，**不适合当 Agent 主循环模型**
- 模型自认知会回答“豆包”（平台壳层统一身份），底层实际路由由 `model_item_key` 决定
- Cookie 会过期（数天到数周），失效后重新登录复制即可
- 每次调用都会在豆包账号里产生一条真实对话记录
- 属于个人自用的非官方接入方式，违反豆包用户协议的风险自担；建议小号使用、控制频率

## 目录结构

```
dsh-doubao-work/
├── index.js           # 插件主体：注册 LlmAdapter
├── doubao.js          # 上游内核：Cookie 直连 / SSE 解析 / 账号池 / 冷却
├── package.json
└── cordis.patch.yml
```

## 附：standalone 网关

`standalone/` 目录是同内核的独立 OpenAI 兼容网关（`node index.js`，默认 `127.0.0.1:3040/v1`），适合不想装插件、或想给其他 OpenAI 客户端/中转站供流的场景。配置 `config.json` + `accounts.json`（填 Cookie）后启动。

## License

MIT

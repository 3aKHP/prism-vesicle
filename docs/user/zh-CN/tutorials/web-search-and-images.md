# 让模型联网搜索与查看图片

[English](../../en/tutorials/web-search-and-images.md) | 简体中文

Vesicle 有两条不同的联网研究路径,也能把剪贴板图片作为一条消息的一部分交给视觉模型。本页从用户任务出发说明怎么开始、怎样确认真的生效,以及不支持时怎么办。

## 先区分两种联网搜索

| 路径 | 谁执行搜索 | 怎么开启 | 调用前是否逐次确认 |
|---|---|---|---|
| **供应商内置搜索** | 当前模型供应商 | 活动会话中运行 `/websearch on` | 否;查询词随模型请求外发 |
| **Tavily 工具** | Vesicle 的 `web_search` / `web_fetch` / `web_map` / `web_crawl` / `web_research` 工具 | Setup 配置 Tavily,或在用户级 `.env` 写 `TAVILY_API_KEY` 后重启 | 按当前权限模式处理 |

两条路径不会同时提供 `web_search`:供应商内置搜索开启时,宿主侧 Tavily `web_search` 会从当前工具面移除,避免模型面对两个同名目的的搜索入口。其它 Tavily 研究工具仍按引擎工具面和权限设置决定是否可见。

## 使用供应商内置搜索

前置条件是:当前协议/profile、模型条目的 `capabilities.builtinWebSearch: true`,以及当前 Engine 都允许搜索。内置 Harness 中 ETL 与 Evaluate 允许;Stage 和 `/btw` 旁路不允许。还必须先发过一条消息或恢复一个会话,让活动会话存在。

1. 输入 `/websearch` 查看当前状态和默认值。
2. 输入 `/websearch on`。成功时会看到 `Built-in web search is ON for this session.` 以及查询外发、计费和关闭方法的提示。
3. 发一个明确需要新资料的问题,例如:

   > 搜索并核对这份角色素材涉及的公开设定更新,列出你实际使用的查询词,不确定的内容不要补写。

4. 搜索实际发生后,转录会出现 `Built-in web search (<供应商>): "<查询词>"`。供应商若返回引用,还会显示引用数量;**没有引用不等于没有搜索**,有些供应商只在服务端注入结果。
5. 用 `/websearch off` 关闭本会话的内置搜索。

这个开关只作用于当前会话。`/new` 或恢复另一个会话后,状态回到所选模型条目的 `webSearchDefault`。权限模式不控制这条供应商能力,因此开启前先理解查询和相关对话内容会发给供应商,并可能产生额外费用。

### 无法开启时

- `no active session yet`:先发一条普通消息或 `/resume` 一个会话,再开启。
- `selected model does not declare...`:换到声明内置搜索能力的模型,或检查 `providers.yaml` 的模型条目。
- `protocol/profile and model do not admit...`:仅改 capability 不够;所选协议档案也必须支持。不要靠伪造字段强行绕过。
- `unavailable in the ... Engine`:换到允许搜索的 Engine;Stage 与 `/btw` 故意保持无搜索。

## 使用 Tavily 研究工具

Setup 的 **Tavily (optional)** 步骤可以保存密钥;也可在用户级 `.env` 添加 `TAVILY_API_KEY=...` 后重启。运行 `vesicle doctor`,成功时应看到:

```text
Tavily web tools: available (.../.env)
```

然后在 ETL 或 Evaluate 对话里直接描述任务,不需要输入工具名:

> 用 Web 工具搜索这个设定的公开来源,读取最相关的页面,把来源和仍有冲突的说法分开列出。

模型会按需选择搜索、抓取、站点映射、爬取或研究工具。工具是否弹确认取决于当前[权限模式](./permissions-and-shell.md)。如果 Doctor 显示 unavailable,先确认密钥在正确的用户级 `.env`,然后完全重启 Vesicle。

## 把剪贴板图片交给模型

前置条件是所选模型在 `providers.yaml` 声明 `capabilities.vision: true`。先把一张 PNG/JPEG/GIF/WebP 图片复制到系统剪贴板:

1. 在输入框按 `Ctrl+V`;macOS 终端冲突时可用 `Option+V`。
2. 状态行先显示 `reading clipboard image`,成功后显示 `attached Image #1`,输入框出现 `[Image #1]` 占位符。
3. 在同一条消息中写清任务,例如“读图中的人物关系,只转录看得清的文字”,然后按 Enter。

同一张图片会按内容哈希保存为项目会话附件;会话记录保存引用,不是把 base64 塞进 JSONL。输入框中有附件时双击 Esc 会把整条草稿(含附件)放入历史后清空;忙碌时按 Esc 中断不会丢掉当前草稿和附件。

### 图片没有发出去

- 显示 `current model does not declare vision support`:图片可以附到草稿,但发送会被拒绝且草稿保留。用 `/model` 换到明确声明视觉能力的模型后重试。
- 显示 `No supported image was found in the clipboard`:先在图片查看器或浏览器中复制**图片本身**,不要只复制文件路径;Linux/WSL 还需要可用的系统剪贴板桥接。
- 显示 `image paste failed`:保留完整状态行报错,按[故障排查](../reference/troubleshooting.md)收集环境信息。

## 检查点

- [ ] 你能说明供应商内置搜索与 Tavily 的区别。
- [ ] 你用 `/websearch` 看到了真实状态,并知道用哪条系统记录确认搜索发生过。
- [ ] 你知道引用是可选反馈,不是搜索成功的唯一判据。
- [ ] 你给视觉模型发送过一条带 `[Image #1]` 的消息,或看到了明确的能力拒绝且草稿仍在。

完整配置字段见[配置文件](../reference/configuration.md),数据外发范围见项目根目录的 [`PRIVACY.zh-CN.md`](../../../../PRIVACY.zh-CN.md)。

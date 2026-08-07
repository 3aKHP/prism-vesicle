# 配置文件

[English](../../en/reference/configuration.md) | 简体中文

Vesicle 的配置是**用户级**的,跟项目目录分开。一份配置管你所有项目。

## 配置目录

所有配置文件都在同一个用户目录里:

| 平台 | 默认目录 |
|---|---|
| Windows | `%APPDATA%\prism-vesicle\` |
| Linux / macOS | `$XDG_CONFIG_HOME/prism-vesicle/`,或 `~/.config/prism-vesicle/` |

可用环境变量覆盖:`VESICLE_CONFIG_DIR`(整个目录)或 `VESICLE_PROVIDERS_FILE`(只指定 providers 文件,取其所在目录)。

与配置目录无关的显示环境变量:`VESICLE_REDUCED_MOTION=1` 关闭启动画面的动画(冻结为静帧),适合对动态画面敏感或低性能终端。`VESICLE_THEME=dark|light|default|auto` 指定界面主题,四值语义:`dark`/`light` 强制对应主题;`default` 跟随终端自身的明暗模式(未报告时回退到深色);`auto` 按本地时间切换(07:00–19:00 浅色,其余深色)。无效值会给出一条诊断并回退到 `default`,不会被静默当成 `auto`。会话内可用 `/theme` 临时切换(优先级更高),启动时也可用 `--dark`/`--light` 进程级标志选择;项目级持久化见[下文](#项目主题偏好可选)。

该目录下的文件:

| 文件 | 必需 | 内容 |
|---|---|---|
| `providers.yaml` | 是 | 供应商、模型、协议、端点、`apiKeyEnv` 名 |
| `.env` | 是 | 上面对应的密钥值 |
| `mcp.yaml` | 否 | 可选的 MCP 工具服务器 |
| `permissions.yaml` | 否 | 工具批准默认与 `shell_exec` 开关(见[权限](./permissions-and-security.md)) |
| `quality.yaml` | 否 | 实验性 Semantic Judge(`version: 2`;`mode: off` 可保留一组休眠的 provider/model/timeout)。见[质量守卫](../advanced/quality-guard.md);常规入口是 `/quality` |
| `settings.yaml` | 否 | 用户级宿主设置(`editor:` 用于 Workspace 页 `Ctrl+X` 外部编辑器;为后续设置项预留) |
| `assets/` | 否 | 用户级资源覆盖 |
| `VESICLE.md` / `VESICLE.<engine>.md` | 否 | 持久化指令(用户级,跨所有项目生效;见下文) |

> 不要依赖项目根目录的 `.env`。若还留着旧的项目根 `.env`,把里面的值迁到上面的用户目录并删掉它。

## providers.yaml

完整字段以仓库的 [`docs/examples/providers.yaml`](../../../examples/providers.yaml) 为准。结构要点:

```yaml
default:               # 启动时默认选中的供应商与模型
  provider: deepseek
  model: deepseek-v4-flash

providers:
  deepseek:
    protocol: openai-chat-compatible   # 也可选 openai-responses / Anthropic / Gemini
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY        # 只写变量名,密钥本身放 .env
    defaultModel: deepseek-v4-flash    # 可选:/model deepseek 切到哪个模型
    models:
      - id: deepseek-v4-flash
        capabilities: { streaming: true, tools: true }
        limits: { contextWindow: 1000000, maxOutputTokens: 65536 }
      - id: deepseek-reasoner
        generation: { temperature: 0.4, maxTokens: 8192 }
        capabilities: { streaming: true, tools: true, reasoningTier: true }
        limits:
          contextWindow: 1000000
          maxOutputTokens: 65536
          autoCompact: { enabled: true, threshold: 0.85, reserveOutputTokens: 20000 }
  local:
    protocol: openai-chat-compatible
    baseUrl: http://127.0.0.1:11434/v1
    apiKeyEnv: LOCAL_OPENAI_COMPAT_API_KEY
    models:
      - qwen3            # 也可以用字符串简写,不带额外配置
```

字段说明:

- `protocol`:`openai-chat-compatible`、`openai-responses`、`anthropic-messages`、`gemini-generate-content` 四选一。
- `apiKeyEnv`:**只填环境变量名**;真正的密钥放在 `.env`。`providers.yaml` 本身不含密钥。
- `authMethod`:Anthropic 或 MiMo Responses 可用 `x-api-key`,Gemini 用 `x-goog-api-key`;不填时 OpenAI 系协议使用 Bearer token。
- `userAgent`(可选):只替换该供应商的 User-Agent,其它指纹与鉴权头不变。
- 模型条目可以是字符串简写,也可以是对象,带 `generation`(`temperature`/`maxTokens`)、`capabilities`(`streaming`/`tools`/`vision`/`reasoningTier`/`reasoningContent`)、`limits`(`contextWindow`/`maxOutputTokens`/`autoCompact`)。
- `limits.contextWindow` 启用底部状态栏的上下文百分比。`autoCompact` 用于开启自动上下文压缩:仅当 `enabled` 不为 `false`、`threshold` 严格介于 0 与 1 之间、且 `contextWindow` 为正整数时才生效;生效后,Vesicle 会在下一次顶层输入之前、以及工具循环中的安全边界处,当预测的下一请求超过软阈值时(通过 portable `/compact` checkpoint)自动压缩。每次供应商请求都会在排队输入和已完成的后台进程通知加入后再检查。`reserveOutputTokens` 为下一轮输出预留空间(优先级:`reserveOutputTokens` → generation `maxTokens` → `limits.maxOutputTokens` → 0);供应商配置加载会拒绝使输入预算不再为正的静态预留组合。没有隐藏默认阈值。用 `/context` 查看实际生效的软阈值、硬上限、预留来源(包括当前模型的 generation 默认值)与激活状态。

### OpenAI Responses 档案

`openai-responses` 必须再明确写出 `responsesProfile`;Vesicle 不会根据 URL、供应商 id 或模型名猜测能力。Guided Setup 可直接选择 OpenAI Responses、MiMo Responses 或 DeepSeek Responses 子集,并写入保守的 HTTP 配置。完整可复制示例在 [`docs/examples/providers.yaml`](../../../examples/providers.yaml)。

在完整 `openai-public` 真实供应商门槛完成前,独立 Responses 协议仍保持 opt-in experimental。2026-07-31,充值后的 MiMo 端点与 DeepSeek v4 Flash 均分别通过了 reasoning 与函数调用闭环两个用例(`2` pass、`0` fail)。一个可信的 Codex 上游网关也通过了 relay HTTP/SSE 与非流式请求,但 standalone compact 仍返回 HTTP 503,WebSocket 连接仍失败;这些不可用能力不能记为通过。

- `openai-public` 是官方 `api.openai.com` 的公开协议档案,支持 HTTP/typed SSE,也可显式选择 `responsesTransport: websocket`。它保留有序 Items、精确 `call_id`、无状态加密 reasoning、会话级 WebSocket continuation,以及在模型条目声明 `capabilities.remoteCompact: true` 后的 `/responses/compact`。这是应用层协议声明,不代表 TLS/HTTP2 网络指纹与 Codex 相同。
- `mimo-subset-2026-07-30` 是固定日期的第三方兼容子集,只支持 HTTP。它会省略 MiMo 未声明或明确不支持的 `background`、`context_management`、`previous_response_id`、`parallel_tool_calls`、`store`、远程压缩和 WebSocket 字段,每轮回放完整上下文,并把 `response.reasoning_text.*` 显式映射为 Vesicle reasoning。它不是 OpenAI 或 Codex conformance。
- `deepseek-subset-2026-07-31` 是 DeepSeek 为 `deepseek-v4-flash` 提供的固定日期 HTTP 子集。它使用 Bearer 鉴权,省略不支持的 continuation、Conversations、存储、background、WebSocket 和远程压缩字段,每轮回放包含明文 reasoning Item 的完整上下文,并按 DeepSeek 文档映射 `none`/`low`/`high`/`max` effort。`deepseek-v4-pro` 在官方 8 月支持实际上线并完成独立验收前不属于此档案。
- `codex-http-relay` 是面向 Codex 服务网关的 HTTP-only 最大兼容档案:既接受公开协议式的终态有序 output,也接受 Codex 的事件/终态分离格式——由连续 completed Items 承载响应内容,随后合法的 `response.completed` 可省略 `output` 或返回空数组。Vesicle 仍会等成功终态后才提交工具,非空的双重表示必须一致,failed/incomplete/EOF 尝试一律拒绝。`codex-beta-2026-02-06` 仍是冻结的 WebSocket 指纹档案;两者都不会为了“像 Codex”而复制私有身份、attestation 或 `x-codex-*` 头。

`responsesTransport` 可为 `http` 或 `websocket`;不写时运行时走 HTTP。只有 `openai-public` 与冻结 Codex beta 档案允许 WebSocket;MiMo 与 DeepSeek 子集均只支持 HTTP。原生 Items 与 compact state 由精确档案拥有;同一端点切换档案时会回退到 portable history。无论是否启用远程压缩,portable `/compact` checkpoint 都是恢复权威;远程端点不可用不会让已有会话不可读。运行 `vesicle doctor` 可查看当前 Responses 档案、层级、传输和远程压缩声明。

## .env

把 `providers.yaml` 里所有 `apiKeyEnv` 对应的值放这里。从 [`docs/examples/provider.env.example`](../../../examples/provider.env.example) 起步:

```text
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
MIMO_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
LOCAL_OPENAI_COMPAT_API_KEY=
TAVILY_API_KEY=
MCP_CLUSTER_TOKEN=
```

`TAVILY_API_KEY` 打开 ETL/Evaluate 引擎的 Web 研究工具;MCP 的鉴权 token 也放这里。进程环境变量只是兜底。

## 供应商代理(可选)

只有一个可选键 `VESICLE_PROVIDER_PROXY`,放在上面的 `.env`(和 `providers.yaml` 同级)。如果你的网络必须经过代理才能访问模型供应商,请在运行 `vesicle setup` 前先写好它;Setup 的模型发现和之后的供应商请求都会使用同一设置。非空值必须是完整的 `http://` 或 `https://` 代理 URL:

```text
VESICLE_PROVIDER_PROXY=http://127.0.0.1:7890
```

需要 Basic 认证时,把用户名和密码写进 URL;其中的 `@`、`:`、`/` 等保留字符必须先做 URL 编码:

```text
VESICLE_PROVIDER_PROXY=http://username:password@proxy.example.com:8080
```

URL 里的凭据只随传输层下发,不会写进 `providers.yaml`、会话或日志。修改 `.env` 后请退出并重新启动 Vesicle。

它作用于**所有模型供应商的 HTTP(S) 与 WebSocket** 流量,包括主工作流、SubAgent、Quality Judge 和压缩流程发出的模型请求;它不是 Vesicle 的全局网络代理。MCP、Tavily/Web 工具、Skill 下载、资源同步、Git/包管理器、`shell_exec` 及其子进程不使用这项设置。

优先级:用户文件 `VESICLE_PROVIDER_PROXY` → 进程 `VESICLE_PROVIDER_PROXY` → 继承的终端代理变量(`https_proxy`/`HTTPS_PROXY` 等)→ 直连;留空代表"未设置"(继续向下 fallback),而不是"强制直连"。因此用户级 `.env` 里已有非空值时,临时进程变量不会覆盖它。显式设置会覆盖继承的终端代理,且不被终端 `NO_PROXY` 绕过。

只想对一次启动使用时,可以不改文件:

```bash
# Linux / macOS / WSL
VESICLE_PROVIDER_PROXY=http://127.0.0.1:7890 vesicle .
```

```powershell
# PowerShell 7
$env:VESICLE_PROVIDER_PROXY = "http://127.0.0.1:7890"
vesicle .
```

继承行为以当前 Bun 运行时为准:对 `https://`/`wss://` 目标,只认 `https_proxy`/`HTTPS_PROXY`(两者都在时取小写),`HTTP_PROXY`/`ALL_PROXY` 不适用于安全目标;`NO_PROXY` 支持 `*`、精确主机名(大小写不敏感)和点号前缀后缀(如 `.test`),不支持 `:port` 和 `*.`。OS 代理、PAC/WPAD、SOCKS、代理链、按供应商选择、NTLM、自定义代理头和生产环境跳过 TLS 校验均不支持。`vesicle doctor` 只显示路由状态/来源/协议/是否带认证,不会打印代理地址或凭据。

重启后运行 `vesicle doctor`,检查 `Provider proxy:` 行。`configured` 表示已选择代理,`inherited` 表示来自终端环境,`bypassed` 表示当前供应商端点被 `NO_PROXY` 绕过,`direct` 表示直连,`invalid` 表示显式 URL 无效。例如:

```text
Provider proxy: configured (user file; http; no authentication)
```

Doctor 只检查路由选择,不会尝试证明代理或供应商实际可达;还需发送一次真实模型请求完成连通性验证。错误处理见[故障排查](./troubleshooting.md)。

## 供应商与费用(给新手)

- **API key** 是你在模型供应商(DeepSeek、Anthropic、Google、或本地兼容服务)那里申请的一串密钥,用来证明你的账户。
- **Base URL** 是该供应商的接口地址;Vesicle 向它发请求。
- **费用**由供应商按用量(token)向你收取,Vesicle 本身不收费。不同模型价格差别很大,不确定时先用便宜的模型试。
- 本地模型(如 Ollama)通过 OpenAI 兼容接口接入,Base URL 指向 `http://127.0.0.1:<端口>/v1`。

## mcp.yaml(可选)

从 [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml) 起步。每个服务器可设 `transport`(streamable-http)、`url`、`timeoutSeconds`、`toolPrefix`、`headers`(支持 `${ENV_VAR}` 从 `.env` 展开)、`includeTools`/`excludeTools` 过滤、`enabledEngines`(限定哪些引擎能用)。文件存在即默认启用;密钥放 `.env`。

Vesicle 支持双纪元 Streamable HTTP MCP 工具兼容:同一个 Vesicle 进程可以同时连接 legacy(`initialize` 协商)和 modern(`server/discover` 协商)的 MCP 服务器。每个服务器可设 `negotiation`:

- `legacy`(默认,缺省值):只走 `initialize` 路径,不发 modern 探测。
- `auto`:先发 `server/discover` 探测,成功则用 modern,失败再走 legacy。新配置推荐使用。
- `modern`:只走 `2026-07-28` 协议,不回退 legacy。

`protocolVersion` 是 legacy 版本钉(默认 `2025-03-26`),不决定纪元。`supportedProtocolVersions` 是可选的 modern 版本列表(默认 `[“2026-07-28”]`)。

MCP 工具结果会先经过宿主的不可信内容边界。普通文本保持原顺序；如果当前模型声明 `capabilities.vision: true`，严格校验后的内联 PNG/JPEG/GIF/WebP 图片会作为图片附件交给模型。会话只保存内容寻址引用，不保存 base64。当前解码上限是临时的 20 MiB 安全边界，不是可配置的长期产品承诺。

如果当前模型不支持视觉，图片不会被解码或落盘，安全文本仍会继续并附带省略提示。MCP 错误结果也不会导入图片。resource、audio、URL/link 和未知结果目前只会给出有界的”不支持”提示；Vesicle 不会自动下载、读取、转录、播放或注入这些内容。

## 持久化指令(可选)

如果你经常要在某个引擎下重复同一套子工作流或规范,可以写进持久化指令文件——宿主在每个会话启动时自动把它们加载进系统 prompt,不需要再让模型写文件、下次会话再提醒它去读。

两个作用域,文件名一致:`VESICLE.md`(通用,所有引擎)和 `VESICLE.<engine>.md`(引擎专属覆盖,`<engine>` 是 `etl`/`runtime`/`stage` 等)。

- **项目级**:放在项目根目录(例如 `VESICLE.md`、`VESICLE.runtime.md`),随项目走,可提交到版本库。
- **用户级**:放在上面的配置目录里(和 `providers.yaml` 同级),**对所有项目生效**,所以换工作文件夹不用再搬运。

解析规则:**同一作用域内引擎专属文件替换通用文件;跨作用域时用户级在前、项目级在后,直接冲突时以项目级为准。** 引擎专属文件只要存在就替换通用文件(空文件 = 显式的空覆盖,会抑制通用文件回退)。这些指令只能自定义当前引擎工作流内的行为,**不能**新增工具、权限、门控、校验器或文件系统权限——能力边界仍由宿主独立强制。

指令追加在引擎 prompt 之后作为宿主上下文(引擎契约仍是唯一的系统权威),在顶层回合开始时从当前磁盘读取;**一个回合内指令是冻结的**——你在一个回合暂停期间(比如等待审批工具时)的编辑要等下一个回合才生效,不会中途切换。无效、被链接或超界的指令会被跳过并给出告警,不阻断回合;用户级 + 项目级合计上限 32 KiB。用 `/instructions` 查看当前引擎生效的指令,或 `vesicle prompt shape --engine <id>` 在命令行检查。用 `/init` 可根据项目扫描自动生成 `VESICLE.md` 初稿,再手动修订;如果项目根目录已经有 `VESICLE.md`,普通 `/init` 会在调用供应商前拒绝,只有 `/init --force [说明]` 才会把旧文件备份到 `.vesicle/init-backups/VESICLE.md.previous` 后替换。模型也可以用 `read_instructions` / `update_instructions` 工具读取或修改这些指令(非 Stage 引擎;`update_instructions` 按当前权限模式走审批、原子写入并自动备份,改动在本回合下一次 provider 请求生效)。

持久化指令属于宿主配置,不属于受保护制品。`/rewind` 和双击 Esc 即使把包含 `update_instructions` 的对话回退掉,也**不会**还原磁盘上的 `VESICLE.md` / `VESICLE.<engine>.md`;因此对话里可能不再显示该工具调用,而新指令仍然生效。每次成功修改后,工具结果会报告唯一的上一状态备份:项目级位于 `.vesicle/instruction-backups/<scope>-<文件名>.previous`,用户级位于配置目录的 `instruction-backups/`;首次创建只有对应的 `.previous.json` 记录“原先不存在”。当前恢复只能手工完成:有 `.previous` 时将它复制回目标文件,首次创建则删除新目标。再次修改会替换这份单一备份。


## 项目主题偏好(可选)

如果你希望某个工作目录默认用特定主题,可以在项目根目录下放一个 `.vesicle/preferences.yaml`(本机忽略状态,**不会**进版本库):

```yaml
version: 1
theme: auto   # dark | light | default | auto
```

- `version: 1` 必填;`theme` 可选,接受 `dark`/`light`/`default`/`auto` 四值;省略 `theme` 等于没有项目级偏好。
- 该文件只存主题字段,不接受密钥、供应商、权限、shell 或任意环境值;未知字段非法。
- 文件被符号链接、版本不符或字段非法时,启动会给出一条诊断并回退到更低优先级的来源,不会阻止 TUI 打开。

主题有效来源优先级(高到低):会话内 `/theme` 临时覆盖 → 启动 `--dark`/`--light` 标志 → 项目 `.vesicle/preferences.yaml` → `VESICLE_THEME` 环境变量 → 内置 `default`。

`/theme` 的持久化语法:

- `/theme dark|light|default|auto` —— 仅当前会话临时切换,不写盘。
- `/theme dark|light|default|auto --persist` —— 原子写入项目偏好,并立即在本会话生效。
- `/theme --unset-project` —— 移除项目 `theme`,清除会话覆盖,按上面优先级重新计算。

`/new` 或恢复另一个会话会清除会话级临时覆盖并重新计算启动偏好;主题从不写入会话 JSONL。

## 路径优先级速记

配置目录解析顺序:`VESICLE_PROVIDERS_FILE` 的目录 → `VESICLE_CONFIG_DIR` → `%APPDATA%\prism-vesicle` → `$XDG_CONFIG_HOME/prism-vesicle` → `~/.config/prism-vesicle`。

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

该目录下的文件:

| 文件 | 必需 | 内容 |
|---|---|---|
| `providers.yaml` | 是 | 供应商、模型、协议、端点、`apiKeyEnv` 名 |
| `.env` | 是 | 上面对应的密钥值 |
| `mcp.yaml` | 否 | 可选的 MCP 工具服务器 |
| `permissions.yaml` | 否 | 工具批准默认与 `shell_exec` 开关(见[权限](./permissions-and-security.md)) |
| `quality.yaml` | 否 | 实验性 Semantic Judge |
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
    protocol: openai-chat-compatible   # 或 anthropic-messages / gemini-generate-content
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

- `protocol`:`openai-chat-compatible`、`anthropic-messages`、`gemini-generate-content` 三选一。
- `apiKeyEnv`:**只填环境变量名**;真正的密钥放在 `.env`。`providers.yaml` 本身不含密钥。
- `authMethod`:Anthropic 用 `x-api-key`,Gemini 用 `x-goog-api-key`。
- `userAgent`(可选):只替换该供应商的 User-Agent,其它指纹与鉴权头不变。
- 模型条目可以是字符串简写,也可以是对象,带 `generation`(`temperature`/`maxTokens`)、`capabilities`(`streaming`/`tools`/`vision`/`reasoningTier`/`reasoningContent`)、`limits`(`contextWindow`/`maxOutputTokens`/`autoCompact`)。
- `limits.contextWindow` 启用底部状态栏的上下文百分比;`autoCompact` 控制自动压缩阈值与输出预留。

## .env

把 `providers.yaml` 里所有 `apiKeyEnv` 对应的值放这里。从 [`docs/examples/provider.env.example`](../../../examples/provider.env.example) 起步:

```text
DEEPSEEK_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
LOCAL_OPENAI_COMPAT_API_KEY=
TAVILY_API_KEY=
MCP_CLUSTER_TOKEN=
```

`TAVILY_API_KEY` 打开 ETL/Evaluate 引擎的 Web 研究工具;MCP 的鉴权 token 也放这里。进程环境变量只是兜底。

## 供应商与费用(给新手)

- **API key** 是你在模型供应商(DeepSeek、Anthropic、Google、或本地兼容服务)那里申请的一串密钥,用来证明你的账户。
- **Base URL** 是该供应商的接口地址;Vesicle 向它发请求。
- **费用**由供应商按用量(token)向你收取,Vesicle 本身不收费。不同模型价格差别很大,不确定时先用便宜的模型试。
- 本地模型(如 Ollama)通过 OpenAI 兼容接口接入,Base URL 指向 `http://127.0.0.1:<端口>/v1`。

## mcp.yaml(可选)

从 [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml) 起步。每个服务器可设 `transport`(streamable-http)、`url`、`timeoutSeconds`、`toolPrefix`、`headers`(支持 `${ENV_VAR}` 从 `.env` 展开)、`includeTools`/`excludeTools` 过滤、`enabledEngines`(限定哪些引擎能用)。文件存在即默认启用;密钥放 `.env`。

## 持久化指令(可选)

如果你经常要在某个引擎下重复同一套子工作流或规范,可以写进持久化指令文件——宿主在每个会话启动时自动把它们加载进系统 prompt,不需要再让模型写文件、下次会话再提醒它去读。

两个作用域,文件名一致:`VESICLE.md`(通用,所有引擎)和 `VESICLE.<engine>.md`(引擎专属覆盖,`<engine>` 是 `etl`/`runtime`/`stage` 等)。

- **项目级**:放在项目根目录(例如 `VESICLE.md`、`VESICLE.runtime.md`),随项目走,可提交到版本库。
- **用户级**:放在上面的配置目录里(和 `providers.yaml` 同级),**对所有项目生效**,所以换工作文件夹不用再搬运。

解析规则:**同一作用域内引擎专属文件替换通用文件;跨作用域时用户级在前、项目级在后,直接冲突时以项目级为准。** 引擎专属文件只要存在就替换通用文件(空文件 = 显式的空覆盖,会抑制通用文件回退)。这些指令只能自定义当前引擎工作流内的行为,**不能**新增工具、权限、门控、校验器或文件系统权限——能力边界仍由宿主独立强制。

指令追加在引擎 prompt 之后作为宿主上下文(引擎契约仍是唯一的系统权威),在顶层回合开始时从当前磁盘读取;**一个回合内指令是冻结的**——你在一个回合暂停期间(比如等待审批工具时)的编辑要等下一个回合才生效,不会中途切换。无效、被链接或超界的指令会被跳过并给出告警,不阻断回合;用户级 + 项目级合计上限 32 KiB。用 `/instructions` 查看当前引擎生效的指令,或 `vesicle prompt shape --engine <id>` 在命令行检查。

> 目前指令文件用文本编辑器手动编写;模型可见的读写工具(`read_instructions`/`update_instructions`)留待后续版本。

## 路径优先级速记

配置目录解析顺序:`VESICLE_PROVIDERS_FILE` 的目录 → `VESICLE_CONFIG_DIR` → `%APPDATA%\prism-vesicle` → `$XDG_CONFIG_HOME/prism-vesicle` → `~/.config/prism-vesicle`。

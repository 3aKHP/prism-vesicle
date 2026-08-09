<!-- Generated from docs/user/zh-CN/advanced/mcp.md — do not edit. -->

# MCP 工具

🟢 MCP 工具 · 🟡 输出落盘实验性

[English](../../en/advanced/mcp.md) | 简体中文

MCP(Model Context Protocol)让你的 Vesicle 连上**外部工具**。配好之后,模型在对话里就能调用这些外部能力——比如查一个数据库、搜你的知识库、请求你自己的接口——就像用 Vesicle 自带工具一样,不用离开终端。

每个配好的 MCP 服务器会给模型提供一组工具,名字形如 `mcp_<前缀>_<工具名>`。这些外部工具和 Vesicle 自带工具一样受管理:该确认时会让你确认,返回的内容也会被检查,不会因为来自外部就放松。

> 完整的配置字段说明见[配置参考](../reference/configuration.md)的 `mcp.yaml` 段。本页讲怎么用。

## 配置一个 MCP 服务器

从 [`docs/examples/mcp.yaml`](../../../examples/mcp.yaml) 起步,复制到和 `providers.yaml` 同一个目录(默认 `~/.config/prism-vesicle/mcp.yaml`)。最小可用配置:

```yaml
enabled: true

servers:
  mykb:
    transport: streamable-http
    url: https://mcp.example.com/mcp
    toolPrefix: mykb
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    enabledEngines:
      - etl
      - evaluate
```

- `enabled: true` 打开 MCP 功能。文件存在就默认开启;写 `false` 可以临时关掉所有服务器。
- 登录用的 token 放在同目录的 `.env` 文件里(`MCP_TOKEN=...`),在 `headers` 里用 `${MCP_TOKEN}` 引用;**不要**把密钥直接写进 YAML。
- `enabledEngines` 限定哪些引擎能用这个服务器;省略就所有引擎都能用。覆盖面广的服务器建议显式列出。
- `includeTools` / `excludeTools` 用来只保留或排除部分工具。
- 各字段的完整说明见[配置参考](../reference/configuration.md)。

## 连接方式:legacy / auto / modern

MCP 服务器可能用新旧两种连接协议。Vesicle 两种都支持,一个进程里可以混用。每个服务器可以单独指定用哪种:

| `negotiation` | 行为 | 什么时候用 |
|---|---|---|
| `legacy`(默认) | 只用传统方式连接,不尝试新协议 | 已知服务器只支持旧协议,或不想改动现有配置 |
| `auto` | 先试新协议,成功就用,失败再退回传统方式 | **新配的服务器推荐选这个** |
| `modern` | 只用新协议,不退回 | 确认服务器支持新协议,且不希望产生任何旧协议流量 |

`protocolVersion` 钉住旧协议的版本(默认 `2025-03-26`),`supportedProtocolVersions` 是新协议的可选版本列表。这两个都不决定用哪种协议——那是 `negotiation` 的事。

连上连不上,用 `vesicle doctor` 查看,它会列出每个服务器的连接方式、协议版本、工具数量和出错原因:

```text
MCP server mykb (auto): connected [modern] 2026-07-28, 4 tools
MCP server legacy-srv (legacy): connected [legacy] 2025-03-26, 2 tools
MCP server down-srv (auto): error (timeout)
```

界面侧栏的 MCP 区会显示一个简短的协议标记。

## 工具的可见性和权限

- 配好之后,服务器的工具会出现在模型的工具列表里,名字形如 `mcp_<toolPrefix>_<工具名>`(`toolPrefix` 没写时从服务器名派生)。
- Vesicle 把每个 MCP 工具都当成**可能产生外部影响**的工具——不会仅凭服务器自己的说明就放心调用。具体到你这边,各权限模式下的表现是:
  - **MANUAL / INERTIA**:每次调用前都会问你。
  - **MOMENTUM / YOLO**:直接放行,不问。
- 权限模式怎么选,见[权限与安全模型](../reference/permissions-and-security.md)。

## 工具返回时:模型能看到什么

- **文字**:按服务器返回的顺序原样保留。
- **图片**:只有当前模型支持看图(`capabilities.vision: true`)时,PNG/JPEG/GIF/WebP 图片才会检查通过后发给模型。如果模型不支持看图,图片会被跳过,文字照常给,并告诉你省略了几张图;MCP 报错的结果也不会带图。单张图片目前上限 20 MiB。
- **暂时不支持的类型**(resource、audio、URL/link 等):只会给一条"暂不支持"的提示。Vesicle **不会**自己去下载、读取、转录或播放这些内容。

## 把工具结果存下来(实验性)

默认情况下,MCP 工具的返回结果只出现在当前对话里,用完就没了:模型想再看一眼就得重新调用——而那次调用可能要花钱、可能有副作用、或者根本重复不了。开启"结果持久化"后,每次 MCP 调用返回的文字和图片都会额外存一份到磁盘上,模型之后可以用 `read_file`、`grep_files`、`view_image` 去翻这份存档,不用重复调用。

在项目根目录的 `.vesicle/preferences.yaml` 里开启:

```yaml
version: 1
mcpOutputPersistence: true            # 总开关,默认关
mcpOutputAutoTruncate: true           # 可选,需要先开总开关
```

| 总开关 | 截断开关 | 效果 |
|---|---|---|
| 开 | 关 | 完整结果**照常发给模型,同时另存一份**——不省上下文,相当于一份备份 |
| 开 | 开 | 超过 32 KiB 的大结果只发 4 KiB 预览给模型,外加一句"完整内容存在哪";小的照常全发 |

- 文字存在 `tmp/mcp-output/<会话-id>/` 下,图片存在 `.../blob/` 下(存成原生 `.png`/`.jpg` 等,不是编码文本)。文件名由工具名和参数拼成,方便找。
- 开启后你不用手动操作:Vesicle 会告诉模型结果存在哪,模型自己决定什么时候去重读。`/resume` 恢复会话时用的是同一个会话 id,所以文件还在原来的路径。
- 存盘尽量做,但不影响工具本身:就算存盘失败,模型该收到的结果还是照常收到。
- 这个功能还在实验阶段,默认关闭;只有当前引擎确实有 MCP 工具时才会提示模型。

> 这些存档文件在 `tmp/` 目录下:`/rewind` 不会动它们,Vesicle 也不会自动清理。不需要的时候请自己用文件工具删掉。`tmp/` 的完整说明见[权限与安全模型](../reference/permissions-and-security.md)。

## 局限

- 目前只支持 Streamable HTTP 这一种连接方式;本地进程(stdio)、OAuth 登录、资源/提示词等 MCP 功能暂不支持。
- 返回结果只处理文字和图片;resource、audio、URL/link 等类型只给"暂不支持"提示,不会自动获取。
- 完整的能力边界和已知限制以 [`STATUS.md`](../../../../STATUS.md) 为准。

## 排查

- **工具没出现 / 连不上**:先跑 `vesicle doctor`,看每个服务器的连接方式、协议和报错。确认 `mcp.yaml` 放对了位置(和 `providers.yaml` 同目录)、`enabled: true`、`.env` 里的 token 已经设好。
- **超时 / 连接被拒**:调大 `timeoutSeconds`;确认网络能访问到服务器地址。
- 更多排查思路见[故障排查](../reference/troubleshooting.md)。

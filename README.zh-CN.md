# Prism Vesicle

[English](./README.md) | [简体中文](./README.zh-CN.md)

Prism Vesicle 是一个使用 Bun 与 TypeScript 开发的 Prism Engine 终端工作流宿主。它默认启动经过验证的内置 V10 Harness，也可以选择项目固定的托管 Harness Pack，将当前运行时连接到模型供应商与宿主工具，并通过持久化会话保存对话和制品生产过程。

> **Alpha 状态：**`1.0.0-alpha.2` 是公开试用候选版本，而不是已经完成的终端用户产品。Windows 用户可通过引导式安装器完成安装与配置，无需编辑 YAML。受支持的参考资料仍包括[以 Windows 为主线的用户手册](./docs/user/zh-CN/README.md)、本 README、`vesicle doctor` 与 [`docs/examples/`](./docs/examples/) 下的示例。

如果你不熟悉终端、API 密钥或模型供应商，请先阅读[循序渐进的用户手册](./docs/user/zh-CN/README.md)，再使用下方的精简配置说明。

## 安装

### Windows 引导式安装器

从对应的 GitHub 预发布下载 `PrismVesicleSetup-<version>-windows-x64.exe` 并双击运行。该安装器按用户安装，不需要管理员权限。安装完成后会启动 Prism Vesicle Setup：用户只需填写 OpenAI 兼容服务的 Base URL 与 API Key，即可自动获取并勾选模型；也可选配 Tavily、MCP 和权限偏好，全程无需手写配置文件。项目选择可以跳过；即使选择，也只用于 Setup 完成后的那一次启动，Vesicle 不会保存全局唯一项目目录。

在 SignPath Foundation 申请等待期间，`1.0.0-alpha.2` 的 Windows 可执行文件和安装器明确不带 Authenticode 签名。该例外仅面向知情的 Alpha 测试群体；请只从官方 GitHub Release 下载，使用 `SHA256SUMS.txt` 核对文件，并且不要在系统范围内关闭 Windows 安全功能。除非某个 Release 的说明明确写明已签名，否则历史 Windows 制品也应视为未签名。依赖签名前请阅读[代码签名政策](./CODE_SIGNING_POLICY.zh-CN.md)；本地存储与外部服务数据传输方式见[隐私政策](./PRIVACY.zh-CN.md)。

安装器包含独立 Windows 运行时与完整的内置 V10 Harness，此路径不要求预先安装 Bun。升级和普通卸载不会删除 `%APPDATA%\prism-vesicle` 下的用户配置或项目数据。安装器会注册原生 `vesicle.exe` 命令，并添加当前用户的资源管理器目录操作 **Open in Prism Vesicle**。再次运行安装器时会显示 **重新安装 / 修复 / 卸载** 维护选项。在终端中启动项目时，先进入目标目录：

```powershell
Set-Location C:\path\to\my-project
vesicle .
```

下方 npm 与源码开发路径需要 [Bun](https://bun.sh/) 1.3.14 或更高版本。

### npm 或源码开发

安装软件包并确认其中包含的 ETL 引擎配置可用：

```bash
npm install prism-vesicle
bunx vesicle prompt shape --engine etl
```

软件包包含完整、只读的 `prism-engine-v10@10.1.0-rc.1` 默认运行时基线。普通使用不需要项目锁，也不需要额外安装 Harness。Vesicle 会先解析当前项目与用户级全局的稀疏 `assets/` 覆盖，然后只使用一个经过验证的完整基线：项目固定的托管 Harness Pack，或当前软件包与独立发行版附带的内置 V10 Pack。Harness 自己拥有已声明的提示词片段；受限的宿主扩展层提供五个通用 SubAgent 及其提示词。

查看当前资产层和生效 manifest 的来源：

```bash
bunx vesicle assets status
```

只把一个文件或目录复制到当前项目中进行编辑：

```bash
bunx vesicle assets materialize assets/prompts/engines/etl.md
```

添加 `--global` 后，该覆盖会对当前用户的所有项目生效。下面的原有命令仍可创建完整项目快照，但更推荐使用稀疏覆盖，这样未修改的文件仍能接收软件包更新：

```bash
bunx vesicle assets init
```

资产初始化和 materialize 命令都不会覆盖已经存在的文件。

高级项目可以验证并安装一个已经解压的 Harness Release，然后显式固定它：

```bash
bunx vesicle assets verify /path/to/extracted-pack
bunx vesicle assets install /path/to/extracted-pack
bunx vesicle assets use <pack-id>@<version>
bunx vesicle assets status
```

项目锁位于 `.vesicle/assets.lock.json`。Vesicle 会在启动和恢复会话时重新验证已安装的 Pack，并在 Harness 身份记录与项目不一致时阻止供应商续接。尚未处理的 Output Quality Guard 决策仍可打开，以便在本地选择使用当前版本或停止；只有恢复完全相同的记录身份后，才能再次修订。`bunx vesicle assets rollback` 会移除项目选择，并恢复内置 V10 基线。在 V10 基线迁移前创建的会话没有 Harness 身份，必须新建会话，不能直接恢复。压缩包解压、在线发现和自动更新不属于这条离线流程。

### 从源码运行

```bash
bun install
mkdir -p ~/.config/prism-vesicle
cp docs/examples/providers.yaml ~/.config/prism-vesicle/providers.yaml
cp docs/examples/provider.env.example ~/.config/prism-vesicle/.env
```

如需启用可选的 MCP 工具，还应复制示例注册表，并在启动 Vesicle 前完成编辑：

```bash
cp docs/examples/mcp.yaml ~/.config/prism-vesicle/mcp.yaml
```

如需显式启用受控宿主 shell，或选择更谨慎的默认批准模式，请复制权限设置示例：

```bash
cp docs/examples/permissions.yaml ~/.config/prism-vesicle/permissions.yaml
```

## 配置模型供应商

Vesicle 从用户级配置中读取供应商和模型配置档，而不是从项目仓库中读取。

| 平台 | 供应商注册表 | 密钥文件 |
|---|---|---|
| Windows | `%APPDATA%\prism-vesicle\providers.yaml` | `%APPDATA%\prism-vesicle\.env` |
| Linux 与 macOS | `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` 或 `~/.config/prism-vesicle/providers.yaml` | 与 `providers.yaml` 同目录的 `.env` |

用户级全局资产覆盖使用同目录下的 `assets/`：Windows 为 `%APPDATA%\prism-vesicle\assets\`，其他平台为 `$XDG_CONFIG_HOME/prism-vesicle/assets/` 或 `~/.config/prism-vesicle/assets/`。这些资产文件不包含密钥。

请从 [`docs/examples/providers.yaml`](./docs/examples/providers.yaml) 和 [`docs/examples/provider.env.example`](./docs/examples/provider.env.example) 开始配置。注册表保存供应商 id、协议、端点、模型元数据、默认值和 `apiKeyEnv` 名称；实际 API 密钥只能存放在同目录的 `.env` 中。进程环境变量仅作为后备值。

不要把密钥写入 `providers.yaml`，也不要依赖项目根目录的 `.env`。如果早期 Vesicle 配置仍留下了根目录 `.env`，请将其中的值迁移到用户级密钥文件，然后删除或重命名旧文件。

当前支持的供应商协议包括 OpenAI-compatible Chat Completions、Anthropic Messages 和 Gemini `generateContent`。模型条目可以声明生成默认值、视觉能力等能力元数据以及上下文限制。规范格式请参阅带注释的示例注册表。

可选的 Streamable HTTP MCP 服务器通过同目录的 `mcp.yaml` 配置；[`docs/examples/mcp.yaml`](./docs/examples/mcp.yaml) 说明了请求头变量展开、工具前缀、过滤器、引擎作用域和超时设置。在用户级 `.env` 中设置 `TAVILY_API_KEY`，即可为 ETL 和 Evaluate 引擎启用 Vesicle 的 Web 研究工具。

宿主工具批准设置位于同目录的 `permissions.yaml`；[`docs/examples/permissions.yaml`](./docs/examples/permissions.yaml) 说明了 MANUAL、INERTIA、MOMENTUM 默认模式、显式 `shellExec` 开关和宿主拥有的 shell 档案。Windows 的 `auto` 优先使用 PowerShell 7，并向 Windows PowerShell 5.1 降级；Linux/WSL 的 `auto` 始终为 `/bin/sh`；CMD、Git Bash 和固定的 PowerShell/POSIX 档案必须显式选择。YOLO 不能被持久化为默认值。`/permissions YOLO` 需要经过两次红色确认；`vesicle --dangerously-skip-permissions` 只为当前进程启用 YOLO，并持续显示危险状态。

## 首次运行

Vesicle 默认使用 ETL 引擎。输入提示并按 Enter 即可开始；模型交互回合、工具活动、确认门、用量元数据和引擎切换都会追加写入 `.vesicle/sessions/`。

从源码检出运行时，`bun run dev` 会直接启动完整的内置 V10 运行时；不需要初始化资产，也不需要创建项目 Harness 锁。

编辑供应商注册表及其同目录 `.env` 后，先检查生效配置且不暴露密钥值，再启动 Vesicle：

```bash
# npm 安装
bunx vesicle doctor
bunx vesicle

# 源码检出
bun run doctor
bun run dev
```

生成文件只能写入受保护的项目目录。研究材料应放在 `source_materials/` 中；最终制品应放在 `workspace/`、`novels/`、`reports/` 或 `test_runs/` 中。模型可以在这些根目录下组织嵌套目录、查看目录条目、移动或重命名目录树，并删除空目录；固定根目录与符号链接穿越仍受保护。通过 Vesicle 工具完成的文件和目录变更会纳入 `.vesicle/file-history/` 下的回退检查点。

常用命令：

| 命令 | 用途 |
|---|---|
| `/model` | 选择已配置的供应商和模型 |
| `/engine [id]` | 查看或切换当前 Prism 引擎 |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | 控制供应商思考强度 |
| `/reasoning hidden\|collapsed\|expanded` | 控制推理内容的显示方式 |
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | 查看或修改工具批准模式 |
| `/artifact [n\|path]` | 列出或预览生成的制品 |
| `/validate <n\|path>` | 按序号或路径验证制品 |
| `/resume` | 恢复持久化会话 |
| `/rewind` | 恢复对话分支、Vesicle 管理的文件或二者 |
| `/compact [notes]` | 将旧上下文总结为精简的续接信息 |
| `/context` | 查看 token 总量和已配置的上下文限制 |
| `/agents [handle\|stop <handle>\|retry]` | 使用 `explore-1` 这类短句柄列出、查看、中断 SubAgent，或重试暂停的结果投递 |

主输入框使用 Enter 提交，使用 Ctrl+Enter 插入换行。Escape 会取消正在进行的供应商请求；输入框为空时，双击 Escape 会打开回退选择器。声明视觉能力的模型可以通过 Alt+V 接收剪贴板图像；WSL 终端上报 Ctrl+Alt+V 时同样受支持。

## Vesicle 当前支持的能力

- 由配置档驱动的 Prism 引擎；其提示、工具、验证器和确认门通过项目/用户覆盖以及托管 Harness 或内置恢复基线解析。
- 支持流式输出的 OpenAI-compatible、Anthropic 和 Gemini 供应商适配器，包括原生工具调用、思考控制、用量归一化、取消和有界重试。
- 响应式 OpenTUI 界面，包括持久化会话、命令补全、供应商/模型切换、引擎移交、用户问题和确认门。
- 受保护的文件系统工具、制品预览与验证、只追加的对话回退以及由 Vesicle 管理的文件检查点。
- 面向实际 target 的 Output Quality Guard：检查当前 Runtime 制品的 post-image，持久保存 finding 与 warning，并为耗尽或中断的修订恢复“再次修订”“使用当前版本”和“停止”三种明确选择；还提供默认关闭、从用户已配置供应商模型中选择的实验性 Semantic Judge。
- 可选的 Tavily Web 研究、Streamable HTTP MCP 工具，以及面向声明视觉能力模型的多模态图像输入。
- 四档粗粒度工具批准模式，以及显式启用的非交互式 `shell_exec` 进程运行时；它提供宿主拥有的 PowerShell、CMD、Git Bash 与 POSIX shell 档案、绑定解释器的精确计划批准、环境过滤、受限 UTF-8 实时输出、超时、进程树清理、前台/后台执行、持久 `shell-N` 任务状态、完成通知和显式输出/停止控制。
- 支持前台与后台 SubAgent、并行执行、三个受 V10 Driver 契约约束的工作流 Agent、五个通用宿主 Agent（`explore`、`general`、`plan`、`research`、`reviewer`）、受当前 Harness 契约约束的自定义 Agent Profile、专用实时 Agent 卡片、持久化结果投递，以及无需轮询的主 Engine 自动续接。
- npm 分发，以及带有不可变内置 V10 运行时包、离线托管 Harness 选择和稀疏可编辑全局/项目覆盖的 Windows 与 Linux 独立构建。

权威的实现清单、工具接口、验证器和已知限制请参阅 [`STATUS.md`](./STATUS.md)。

## 开发

```bash
bun run lint
bun run typecheck
bun test
bun run doctor
```

| 脚本 | 用途 |
|---|---|
| `bun run dev` | 从源码运行 TUI |
| `bun run lint` | 运行固定版本的 Biome 正确性检查，不格式化文件 |
| `bun run typecheck` | 验证 TypeScript，但不生成文件 |
| `bun test` | 运行确定性测试套件 |
| `BUN_E2E_REAL_PROVIDER=1 bun test tests/e2e-gate.test.ts` | 运行可选的真实供应商确认门验收测试 |
| `bun run pack:check` | 验证 npm 发布白名单 |
| `bun run pack:smoke` | 对打包后的 npm 分发执行冒烟测试 |
| `bun run build:exe` | 构建 Windows 和 Linux 独立可执行文件 |
| `bun run build:assets` | 构建可编辑资产 ZIP |
| `bun run build:installer:stage` | 暂存完整 Windows 安装器载荷 |
| `bun run build:installer` | 在 Windows 上构建 Inno Setup 安装器 |

`vesicle debug markdown-runtime` 可以在不打开 TUI 的情况下验证独立 OpenTUI worker 和语法运行时。`vesicle prompt dump --engine <id>` 会输出模型可见的完整系统提示；`vesicle prompt shape --engine <id>` 只输出其组合结构。

仅供开发者使用的 `vesicle quality benchmark` 会针对当前已验证 Harness 运行明确授权、受预算上限保护的 Semantic Judge 评测。它与 Runtime policy 保持分离，并且必须显式传入 `--allow-live`；使用前请阅读 [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md)。

Pull request 和向 `develop` 的推送会调用同一套 Linux/Windows 可复用发布构建，其中包括 npm 消费者验证和引导式安装器的静默安装/升级/卸载 smoke。正常发版只需在命令行中，为已经验收的 `main` commit 创建并推送受保护的 annotated `v<软件包版本>` tag。Tag 工作流会重新执行同一组门禁、创建 GitHub Release 与校验和，并通过 Trusted Publishing 发布带 provenance 的 npm 软件包；无需在 Actions 网页中手动启动，也无需 GitHub Environment 审批。未来的 SignPath 签名批准仍是独立的人工信任门禁。完整命令、GitHub 设置和故障恢复规则见 [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md)。

## 文档

| 文档 | 职责 |
|---|---|
| [`docs/user/zh-CN/`](./docs/user/zh-CN/README.md) | 从计算机基础到高级操作、以 Windows 为主线的顺序用户手册 |
| [`STATUS.md`](./STATUS.md) | 当前实现、工具接口、验证方式和已知限制 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 已发布和未发布的用户可见变更 |
| [`CONTRIBUTING.zh-CN.md`](./CONTRIBUTING.zh-CN.md) | 贡献者配置、仓库边界和文档规范 |
| [`CODE_SIGNING_POLICY.zh-CN.md`](./CODE_SIGNING_POLICY.zh-CN.md) | Windows 签名范围、批准、验证与事件处理 |
| [`PRIVACY.zh-CN.md`](./PRIVACY.zh-CN.md) | 本地数据、外部服务传输、卸载行为与删除方式 |
| [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) | 架构与运行时边界 |
| [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) | 分支、审查、发布和文档扫描流程 |
| [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) | 内置 V10 清单、宿主扩展层、来源和更新规则 |
| [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md) | 仅供开发者使用的 Semantic Judge 评测、上限、恢复和证据边界 |

仓库内的 AI 协作者说明位于 [`AGENTS.md`](./AGENTS.md) 和 [`CLAUDE.md`](./CLAUDE.md)。

## 范围与来源

1.0 alpha 专注于让 Vesicle 成为实用的 Prism 工作流直连 API 宿主，而不是通用编码代理。OpenAI Responses、更广泛的 MCP 传输与功能范围、Skills 集成、长篇引擎专用流程框架和提示缓存工程仍处于延后状态；依赖未列出的能力前，请先查阅 [`STATUS.md`](./STATUS.md)。

Prism Vesicle 是 [`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology) 的姊妹项目；后者是这里内置的 V10 Harness Release 的公开来源。

## 许可证

[MIT](./LICENSE)

# 10 — 工具权限与宿主 Shell

[← 上一章：一次完整的 ETL 工作流](./09-complete-etl-workflow.md) | [手册目录](./README.md) | [English](../en/10-tool-permissions-and-shell.md)

## 你将学到什么

Vesicle 将工具可用性、批准行为和硬性运行时保护分开处理。权限模式只决定一个已经生效的模型可见工具是否暂停等待批准；它不会为 Engine 增加工具、绕过受保护的文件根目录、扩大 MCP 作用域，也不会关闭进程限制。

## 四档模式

| 模式 | 观察类工具 | 写入、MCP 与 Agent 控制 | `shell_exec` |
|---|---|---|---|
| MANUAL | 询问 | 询问 | 询问 |
| INERTIA | 放行 | 询问 | 询问 |
| MOMENTUM | 放行 | 放行 | 询问 |
| YOLO | 放行 | 放行 | 放行 |

MOMENTUM 是普通默认值。无论远端服务器如何描述，所有 MCP 工具都按可能产生副作用处理。工作流确认门、引擎移交和用户问题本身已经是交互请求，不会再叠加第二个权限提示。

使用以下命令查看或修改当前模式：

```text
/permissions
/permissions INERTIA
```

YOLO 需要经过两次红色确认，而且只对当前进程有效。恢复曾经使用 YOLO 的会话时，模式会回到 MOMENTUM。

## 启用 `shell_exec`

将示例复制到 Vesicle 用户配置目录，并把 `shellExec` 改为 `true`：

```powershell
$configDir = Join-Path $env:APPDATA "prism-vesicle"
Copy-Item "docs\examples\permissions.yaml" (Join-Path $configDir "permissions.yaml")
notepad (Join-Path $configDir "permissions.yaml")
```

`shellInterpreter` 用于选择一个由宿主拥有的命令档案：

| 值 | 可用平台与行为 |
|---|---|
| `auto` | Linux/WSL 使用 `/bin/sh`；Windows 优先使用 PowerShell 7，并且只向 Windows PowerShell 5.1 降级。 |
| `posix-sh` | 在 Linux/WSL 上显式使用 `/bin/sh`；Windows 不可用。 |
| `powershell-7` | 在 Windows 上显式使用 PowerShell 7；缺失时不降级。 |
| `windows-powershell-5.1` | 显式使用 Windows PowerShell 5.1。 |
| `cmd` | 显式使用 Windows Command Prompt，并关闭注册表 AutoRun。 |
| `git-bash` | 显式使用不加载用户 Profile 的 Git for Windows Bash。 |

档案永远不会跨命令方言静默降级。如果显式档案在当前平台不可用，`shell_exec` 会从模型的有效工具面移除，`vesicle doctor` 会报告不可用的选择。能力开关仍然开启时，`shell_output` 与 `shell_stop` 会继续可用，以便观察或终止已经运行的任务。危险启动参数只启用能力，仍然遵守 `shellInterpreter`。

选中的 shell 不可交互，从项目根目录启动，只接收经过过滤的环境变量，分别捕获并限制 stdout/stderr，而且具有墙钟超时。Vesicle 会请求 UTF-8 进程输出，向模型说明当前命令方言，并在批准前与进程卡片中显示解析后的解释器。前台命令会在 TUI 卡片中显示受限的实时尾部输出和已运行时间。

对于不需要立即取得结果的长命令，模型可以设置 `runInBackground: true`。Vesicle 会立即返回 `shell-1` 形式的短任务 id，在命令卡片、顶部状态和 Workspace 侧栏中持续显示进度，把受限输出与状态保存在 `.vesicle/processes/`，并在下一次 provider 轮次自动交付完成结果，无需例行轮询。`shell_output` 用于读取当前或最终输出，`shell_stop` 用于取消仍在运行的任务。Vesicle 重启后，未完成的托管后台进程会被标记为 interrupted，而不会被重放。

权限代表用户同意，并不代表隔离。获准的 shell 命令可以用当前宿主用户的权限访问项目外文件和网络。由 shell 创建的文件变化不保证能够通过 rewind 恢复。

## 危险启动参数

有经验的用户可以这样启动 Vesicle：

```powershell
vesicle --dangerously-skip-permissions
```

该参数会为当前进程启用 YOLO 和 `shell_exec`，并跳过 TUI 的两次确认。Vesicle 会持续显示红色的 `YOLO · CLI OVERRIDE` 标记。该参数不会关闭路径保护、MCP/Agent 作用域、参数验证、超时、环境过滤、输出限制、进程树清理或并发控制。

只有在你理解并接受当前 Engine 与已配置 MCP 服务器提供的全部工具时，才应使用该参数。

[下一步：返回手册目录 →](./README.md)

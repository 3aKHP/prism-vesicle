# 05 — 运行 Doctor 并启动 Vesicle

[← 上一章：供应商配置](./04-first-provider.md) | [手册目录](./README.md) | [English](../en/05-doctor-and-launch.md) | [下一章：第一次对话 →](./06-first-conversation.md)

## 本章目标

你将使用 Vesicle Doctor 查看已保存配置，从项目自身目录启动 Vesicle，并安全退出终端界面。

**预计耗时：** 5 分钟

**前置条件：** 第 00–04 章，并已完成引导式 Setup

## 运行 Doctor

打开 Windows 开始菜单，找到 **Prism Vesicle**，再选择 **Prism Vesicle Doctor**。诊断窗口会保持打开，便于阅读或复制输出。

Doctor 会检查运行时、所选供应商与模型、用户配置、API Key 可用性、可选 Tavily 与 MCP、权限以及已安装 Harness。它会报告状态，但不会输出密钥原文。

重要输出应类似：

```text
Prism Vesicle Doctor
Provider: example
Protocol: openai-chat-compatible
Model: selected-model
Provider config: file (...\prism-vesicle\providers.yaml)
Provider env: file (...\prism-vesicle\.env)
API key: available
Permissions: MOMENTUM (...\permissions.yaml)
Shell exec: disabled; interpreter PowerShell 7 (...\pwsh.exe)
Harness: bundled prism-engine-v10@10.0.1-alpha.2
Missing: none
```

可选的 Tavily 或 MCP 行可能显示 unavailable、disabled 或具体服务器连接错误。除非当前工作流确实依赖这些工具，否则它们不会使供应商配置失效。Shell exec 行会同时报告能力状态和解析后的 `shellInterpreter`；显式档案不可用时，shell 工具不会进入模型工具面，直到配置得到修正。

## 修正问题

如果 Doctor 报告缺少供应商配置、API Key 或模型，请关闭诊断窗口，再从开始菜单打开 **Configure Prism Vesicle**。向导会合并修正后的设置，并备份发生变化的已有文件；新手主线不需要手动修复 YAML。

MCP 连接错误可在 Setup 中修改或重试该服务器。Tavily Key 不可用时，可以重新配置，也可以明确保持跳过。

必要供应商配置显示 `API key: available` 与 `Missing: none` 后再继续。

## 启动一个项目

Vesicle 不保存全局唯一项目。打开 PowerShell 7，进入目标项目目录，再启动该目录：

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
vesicle .
```

也可以在资源管理器中右键项目文件夹或文件夹空白处，选择 **Open in Prism Vesicle**。Windows 11 上该入口可能位于 **显示更多选项** 中。

终端随后会切换为 Vesicle 全屏界面。你应当看到对话区域、状态信息，以及靠近底部的输入框。

## 退出并再次启动

按 Ctrl+Q。Vesicle 会返回普通终端或关闭应用窗口。如果某个模态面板正在接管键盘，请先按 Escape 关闭面板，再按 Ctrl+Q。

再次在同一目录运行 `vesicle .`，或使用该目录的资源管理器入口。请保持程序开启，以便继续下一章。

## 完成检查

满足以下条件时即可继续：

- Doctor 显示预期的供应商和模型；
- 必要配置显示 `API key: available` 与 `Missing: none`；
- `vesicle .` 能以当前目录为项目打开 TUI；
- Ctrl+Q 可以安全退出。

[下一章：完成第一次对话 →](./06-first-conversation.md)

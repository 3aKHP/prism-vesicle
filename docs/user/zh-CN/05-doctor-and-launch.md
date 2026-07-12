# 05 — 运行 Doctor 并启动 Vesicle

[← 上一章：供应商配置](./04-first-provider.md) | [手册目录](./README.md) | [English](../en/05-doctor-and-launch.md) | [下一章：第一次对话 →](./06-first-conversation.md)

## 本章目标

你将使用 Vesicle Doctor 检查安装与配置，理解重要结果，并安全地打开和退出终端界面。

**预计耗时：** 10 分钟

**前置条件：** 第 00–04 章

## 返回项目文件夹

打开使用 PowerShell 的 Windows Terminal，然后运行：

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

## 运行 Doctor

运行：

```powershell
bunx vesicle doctor
```

Doctor 会检查运行时、项目文件夹、所选供应商与模型、配置文件、API 密钥可用性和可选宿主工具。它会报告缺失内容，但不会输出 API 密钥本身。

重要输出应类似：

```text
Prism Vesicle Doctor
Bun: 1.3.14
Provider: deepseek
Protocol: openai-chat-compatible
Model: deepseek-v4-flash
Provider config: file (...\prism-vesicle\providers.yaml)
Provider env: file (...\prism-vesicle\.env)
API key: available
Missing: none
```

你的 Bun 版本和模型 id 可能不同。可选的 Tavily 或 MCP 行可能显示 unavailable 或 disabled；这不会阻止第一次对话。

## 处理常见 Doctor 问题

### 找不到供应商配置

确认文件准确命名为 `%APPDATA%\prism-vesicle\providers.yaml`，而不是 `providers.yaml.txt`。如有必要，返回第 04 章，用 PowerShell 命令重新创建。

### 找不到供应商环境文件

确认密钥文件准确命名为 `%APPDATA%\prism-vesicle\.env`，而不是 `.env.txt`。

### 缺少 API 密钥

重新打开 `.env`，确认变量名与 `providers.yaml` 中的 `apiKeyEnv` 完全一致，并且 `=` 后面存在值。

### 未知或无效的模型配置

确认相同的模型 id 同时出现在 `default.model`、`defaultModel` 和 `models` 下。YAML 空格与缩进必须和示例一致。

在 Doctor 对必要供应商配置输出 `Missing: none` 前，不要继续。

## 启动 Vesicle

运行：

```powershell
bunx vesicle
```

终端会切换到 Vesicle 的全屏界面。你应当看到对话区域、状态信息，以及靠近底部的输入框。

首次界面可能显示当前供应商与模型、ETL 引擎或已有会话。这些都是正常信息。

## 退出 Vesicle

按 Ctrl+Q。Vesicle 会关闭并返回普通 PowerShell 提示符。

如果某个面板正在接管键盘而导致 Ctrl+Q 没有生效，请先按 Escape 关闭面板，再按一次 Ctrl+Q。Vesicle 正在写入响应或文件时，尽量不要直接关闭整个终端。

## 再次启动

运行相同命令：

```powershell
bunx vesicle
```

这会确认 Vesicle 可以从项目文件夹重复启动。请保持程序开启，以便继续下一章。

## 完成检查

满足以下条件时即可继续：

- Doctor 显示预期的供应商和模型
- 输出中出现 `API key: available`
- 必要配置最终显示 `Missing: none`
- TUI 成功打开
- 你知道 Ctrl+Q 可以退出应用

[下一章：完成第一次对话 →](./06-first-conversation.md)

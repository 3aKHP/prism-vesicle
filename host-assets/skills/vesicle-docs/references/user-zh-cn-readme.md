<!-- Generated from docs/user/zh-CN/README.md — do not edit. -->

# Prism Vesicle 用户手册

[English](../en/README.md) | 简体中文

Prism Vesicle 是一个在终端里运行 Prism Engine 创作工作流的宿主程序:连接你自己的模型 API,把源材料加工成结构化的角色卡、情景卡和长篇叙事。

## 从这里开始:你是怎么拿到 Vesicle 的?

| 我拿到的是… | 适合谁 | 入门页 |
|---|---|---|
| Windows 安装器(`PrismVesicleSetup-<version>-windows-x64.exe`) | 第一次用终端程序,想要向导带着走 | [Windows 安装器](./start/windows-installer.md) |
| npm 包(`prism-vesicle`) | 已经在用 Bun 的开发者 | [npm 安装](./start/npm.md) |
| Windows 单文件版(`prism-vesicle-windows-x64-<version>.exe` + 资源包) | 不想运行安装器、需要免安装或自行校验 | [Windows 便携版](./start/windows-portable.md) |
| Linux 单文件版(`prism-vesicle-linux-x64-<version>` + 资源包) | Linux / WSL 用户 | [Linux 便携版](./start/linux-portable.md) |

> `.deb` 等其它 Linux 包尚未发布;发布后会在上表补一行。

不确定选哪个?没有历史包袱的 Windows 用户直接用安装器最省事。

## 之后的路径(四个入门页殊途同归)

无论从哪个入口进来,终点都一样:`vesicle doctor` 检查通过,并在你的项目目录里打开了 Vesicle 界面。到达终点后从同一条教程继续:

1. [第一次对话](./tutorials/first-conversation.md)
2. [在 Workspace 页查看和修改产物](./tutorials/workspace-page.md)
3. [运行中继续工作](./tutorials/work-while-running.md)
4. …(完整目录见[教程区](./tutorials/README.md))

## 我现在想做什么?

不必从头读完整本手册。按你眼前的任务直接进入:

| 我想… | 从这里开始 |
|---|---|
| 配好模型、API key,或修复启动检查 | 对应的[安装入门页](#从这里开始你是怎么拿到-vesicle-的),然后看[配置文件](./reference/configuration.md) |
| 发起第一次创作并看懂确认面板 | [第一次对话](./tutorials/first-conversation.md) |
| 选择 ETL、Runtime、Evaluate、Weaver、Dyad 等 Engine | [选择 Engine](./advanced/engines.md) |
| 查看、修改、校验或恢复一个文件 | [Workspace 页](./tutorials/workspace-page.md) |
| 让模型联网搜索,或把图片交给模型看 | [联网搜索与图片](./tutorials/web-search-and-images.md) |
| 恢复会话、重新生成、切换分支或压缩上下文 | [会话恢复与回退](./tutorials/sessions-and-rewind.md) |
| 把重复规则留给以后每个会话 | [持久化指令](./tutorials/persistent-instructions.md) |
| 让模型使用文档 Skill,或把任务交给 SubAgent | [Skills 与 SubAgents](./tutorials/skills-and-subagents.md) |
| 用角色卡和情景卡开始连续叙事 | [Stage 消费引擎](./advanced/stage.md) |
| 接入外部 MCP 工具 | [MCP 工具](./advanced/mcp.md) |
| 管理 Harness Pack、检查或切换创作基线 | [Harness Packs](./advanced/harness-packs.md) |
| 查完整终端命令或 TUI 快捷键 | [终端命令参考](./reference/cli-commands.md) / [TUI 命令速查](./reference/commands.md) |

## 参考

命令速查、配置文件、权限与安全模型、校验和与签名、更新与卸载、故障排查等内容见[参考区](./reference/README.md)。

## 高级与实验特性

宿主 Shell、Output Quality Guard、SubAgents、Stage、MCP 工具和 Harness Packs 等进阶能力见[高级区](./advanced/README.md)。

## 手册状态

Prism Vesicle 处于通往稳定版 `1.0.0` 的发布候选(RC)阶段,界面与命令在此之前仍可能变化。`vesicle doctor` 是环境诊断工具,不是全部功能的说明;手册与实际界面或命令不一致时,请保留报错原文并按[故障排查](./reference/troubleshooting.md)报告差异。

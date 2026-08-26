<!-- Generated from docs/user/zh-CN/advanced/README.md — do not edit. -->

# 高级与实验特性

[English](../../en/advanced/README.md) | 简体中文

这一区讲教程和参考里没有展开的进阶能力。建议先读完[教程](../tutorials/README.md)再来。

> **状态标注约定**:每篇开头标 🟢 已实现 / 🟡 实验性,反映 `1.0.0-beta.2` 的成熟度。实验性特性会随版本转稳——**以 [`STATUS.md`](../../../../STATUS.md) 为权威的当前状态**,本区的标记可能滞后于代码。特性转稳时,改本页的状态表与对应页的开头一行即可。

## 特性一览

| 特性 | 当前状态 | 简介 |
|---|---|---|
| [选择 Engine](./engines.md) | 🟢 已实现 | 七个内置 Engine 各自解决什么任务,以及怎样安全切换 |
| [宿主 Shell / Process Runtime](./shell-exec.md) | 🟢 已实现(非沙箱) | 让模型跑宿主命令:前台/后台、解释器档案、进程树清理 |
| [Output Quality Guard](./quality-guard.md) | 🟢 守卫主体 · 🟡 Judge/Policy 实验性 | 制品 post-image 的确定性检查、文档指标、可选 Semantic Judge |
| [SubAgents](./subagents.md) | 🟢 已实现 | 前台/后台子任务;generic 与 Driver-contract 两类 Agent |
| [Stage 消费引擎](./stage.md) | 🟢 已实现 | 用角色卡 + 情景卡开一个连续叙事会话 |
| [Skills](./skills.md) | 🟢 已实现 | 按需过程性上下文：发现、激活、资源读取、`/skill` 命令 |
| [MCP 工具](./mcp.md) | 🟢 MCP 工具 · 🟡 输出落盘实验性 | 接入外部工具:连接配置、工具权限、可选结果存档 |
| [Harness Packs](./harness-packs.md) | 🟢 离线管理已实现 | 验证、安装、选择和回退一整套创作基线;按需制作稀疏覆盖 |

## 前置

- 走完[教程](../tutorials/README.md),理解"门"、制品、权限模式。
- [权限与安全模型](../reference/permissions-and-security.md)是 shell_exec 与 SubAgent 的共同基础。

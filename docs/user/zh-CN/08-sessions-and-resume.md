# 08 — 会话与恢复

[← 上一章：模型与引擎](./07-models-and-engines.md) | [手册目录](./README.md) | [English](../en/08-sessions-and-resume.md)

## 本章目标

你将理解 Vesicle 会话保存哪些内容，在不删除历史记录的情况下创建全新会话，恢复较早的会话，并识别会话选择器中尚未处理的工作。

**预计耗时：**20 分钟

**前置条件：**第 00–07 章和至少一次已经完成的对话

## 什么是会话

会话是一段对话及其宿主状态的持久记录。Vesicle 把会话保存为当前项目下只追加写入的 JSONL 文件：

```text
.vesicle\sessions\
```

会话可以保存：

- 用户、助手和工具消息
- 所选供应商与模型
- 当前 Prism 引擎
- 思考强度和推理显示设置
- 用量元数据和验证通知
- 尚未解决的确认门、引擎切换请求、用户问题或 Output Quality Guard 决策

不要手动编辑会话 JSONL 文件。后续章节会介绍受支持的回退、备份和恢复操作。

## 会话属于项目文件夹

Vesicle 会相对于启动位置查找 `.vesicle\sessions`。如果从另一个项目文件夹启动 Vesicle，你会看到那个项目的会话。

在目标项目目录中运行 `vesicle .`。会话隔离以本次启动目录为准，而不是以引导式 Setup 保存的项目为准。

这种项目级行为可以隔离无关工作。用户级供应商配置仍可由多个项目共享。

## 同一时间只有一个当前会话

一次 TUI 运行会维持一个当前会话，直到你明确创建或恢复另一个会话。普通提示会自动延续当前对话，不需要每回合手动保存。

如果 Vesicle 启动时发现已有会话，会显示一条建议使用 `/resume` 的通知。直接输入普通提示会开始新的对话，而不是自动选择一个旧会话。

## 创建全新会话

提交：

```text
/new
```

Vesicle 会清空当前对话并报告：

```text
Started a fresh session. Type a prompt to begin.
```

`/new` 不会删除以前的会话或其中的文件，也会保留当前选择的供应商、模型和引擎。提交下一条真实提示时，才会创建新的会话文件。

在练习中发送一条便于识别的简短提示：

```text
这是我的第二个练习会话。请用一句话确认你能读到这条消息，并且不要创建文件。
```

等待响应完成。

## 打开会话恢复选择器

提交：

```text
/resume
```

选择器按从新到旧的顺序列出会话。每行包含编号、部分会话 id、对话预览和记录数量。

- 使用上、下方向键或 Ctrl+P、Ctrl+N 选择一行。
- 按 Enter 恢复所选会话。
- 按 Escape 关闭选择器，并且不改变当前会话。

找到预览中包含第一次对话文字的旧会话，选择它并按 Enter。

## 恢复操作会还原什么

恢复后，Vesicle 会重建可见对话，并还原该会话中最新的有效状态。宿主通知会报告恢复的引擎，以及可用时恢复的供应商和模型。

如果会话引用的供应商或模型已经不在 `providers.yaml` 中，Vesicle 会保留当前有效选择并显示说明，而不是凭空构造配置。

会话选择器还会标记中断的交互：

- `[gate:...]` 表示有确认门正在等待。
- `[engine:...]` 表示有引擎切换请求正在等待。
- `[question:...]` 表示模型问题正在等待回答。
- `[quality:interrupted]` 表示自动质量修订被中断。
- `[quality:decision]` 表示自动修订已经耗尽，需要你作出决定。

恢复这样的会话会还原相应面板，使你可以继续处理，而不是丢失尚未完成的决定。

实验性 Semantic Judge 默认关闭。`/quality` 会打开 mode、已登记 provider、model 与 rewrite 确认的选择器；`/quality status` 显示当前设置。也可以使用 `/quality observe <provider> <model> [timeout-ms]` 选择单独配置的供应商和模型；`/quality rewrite <provider> <model> [timeout-ms]` 会先显示一条明确的确认命令。设置保存在与 `providers.yaml` 同目录的用户级 `quality.yaml` 中；其中绝不包含 API key、URL、prompt、规则或工具权限。高级 alpha 内测人员可以从 [`docs/examples/quality.yaml`](../../examples/quality.yaml) 开始。

启用后，Runtime 正文会通过选定的 Judge 供应商和模型发起一次额外请求。该请求没有工具，也不包含普通会话历史，但会再次发送当前正文并消耗额外的供应商 token。`observe` 只记录文风 finding，不会修订。经过明确确认的实验性 `rewrite` 模式最多可要求原 Runtime Engine 修订两次，然后重新检查最终 post-image。这不是经过校准的生产 Policy，也不是 AI 作者身份检测。JSON 无效、供应商不可用、超时、正文超限或配置已变化时，界面与会话会记录检查未完成，不会显示 clean，也不会阻断普通交付。

处理质量决策时，`Revise again` 会授权同一个 Engine 再发起一次供应商请求；`Use current version` 和 `Stop` 都不会调用供应商，并且都会在持久会话记录中保留 warning。如果所需 Harness、Rule Pack 或实验性 Judge profile 身份已经变化，在恢复完全相同的身份之前无法再次修订，但仍可选择使用当前版本或停止。Workspace 侧边栏中文件旁的 `!` 表示该路径仍保留可见的质量 warning。这个状态只报告当前规则发现的问题，不判断文本是否由 AI 写成，也不提供通用写作质量保证。

## 按编号或 id 恢复

选择器是最安全的新手方式。Vesicle 也支持：

```text
/resume 2
```

该数字指当前 `/resume` 命令产生的从新到旧列表。高级用户也可以提供唯一的会话 id 前缀。如果数字或前缀不匹配，Vesicle 会报告问题，并且不改变当前会话。

## 安全查看会话文件

使用 Ctrl+Q 退出 Vesicle。在 PowerShell 中列出会话文件名，但不要打开或修改它们：

```powershell
Get-ChildItem ".vesicle\sessions"
```

每个 `.jsonl` 文件都是一份持久会话记录。之后回到同一项目目录并再次运行 `vesicle .`。

## 完成检查

满足以下条件时即可继续：

- 你知道会话属于项目，并且采用只追加写入方式
- `/new` 会创建全新对话，但不会删除旧会话
- 你创建了第二个练习会话
- `/resume` 打开了从新到旧的选择器，并恢复了一个较早的对话
- 你理解 gate、engine、question 和 quality 等待标记
- 你可以找到 `.vesicle\sessions`，并且没有编辑其中的文件

下一章会在一次完整 ETL 工作流中运用这些会话技能。

[下一章：一次完整的 ETL 工作流 →](./09-complete-etl-workflow.md)

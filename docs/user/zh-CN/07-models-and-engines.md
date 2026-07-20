# 07 — 模型与 Prism 引擎

[← 上一章：第一次对话](./06-first-conversation.md) | [手册目录](./README.md) | [English](../en/07-models-and-engines.md) | [下一章：会话与恢复 →](./08-sessions-and-resume.md)

## 本章目标

你将理解供应商、模型和 Prism 引擎之间的区别，查看已经配置的选项，并在不混淆其职责的情况下切换模型或引擎。

**预计耗时：**15 分钟

**前置条件：**第 00–06 章和一个可以正常运行的 Vesicle 安装

## 四个不同层次

Vesicle 把四个独立的选择组合在一起：

| 层次 | 控制内容 | 示例 |
|---|---|---|
| 供应商 | 远程服务、API 端点、账户和密钥 | DeepSeek |
| 模型 | 具体 AI 模型、能力、限制和调用价格 | `deepseek-v4-flash` |
| Prism 引擎 | 工作流指令、工具、验证器和确认门 | `etl` |
| Agent Profile | 拥有独立提示词、工具、上下文策略与执行默认值的专业委派执行者 | `explore` |

切换模型会改变由哪个 AI 处理未来请求。切换 Prism 引擎会改变该 AI 接到的工作指令。引擎不是模型，切换引擎也不会把你的账户转移到另一个供应商。

Agent Profile 同样不是引擎。当前引擎仍负责总体工作流，并且可以启动多个专业 SubAgent。例如，ETL 可以用 Explore 处理大量源材料，Weaver-Orch 可以先让 Plan 制定方案，Evaluate 则可以并行运行多个独立 Reviewer。

## 查看 Agent Profile 与子任务

提交：

```text
/agents
```

Vesicle 会列出内置的 Explore、Plan、Research、Reviewer 和 General Profile，以及 `assets/agents/` 下的项目或用户覆盖；同时显示当前会话拥有的 child。每个 child 都会得到 `explore-1` 这类短句柄，存储和恢复所用的长 UUID 保留在内部。

前台 child 只会暂停主模型循环；TUI 仍保持响应，其专用 Agent 卡片会持续显示进度，结果返回后主 Engine 会在同一回合继续。后台 child 会让 parent 立即继续；Agent 卡片、标题栏和 Workspace 侧栏会让任务从运行、结果就绪、整合中到已整合的过程持续可见。当一个或多个后台 child 完成时，Vesicle 会持久化其结果，并在 parent 空闲后自动续接，无需轮询。

查看一个 child 的详细信息：

```text
/agents explore-1
```

要中断一个运行中的 child：

```text
/agents stop explore-1
```

输入 `/agents ` 会打开句柄补全；在 `/agents stop ` 后只会列出正在排队或运行的 child。包含旧 UUID 风格 ID 的既有会话仍保持兼容，但新的工具结果和命令均使用短句柄。

Agent Profile 属于运行时资产，因此高级用户与 Harness Pack 可以添加自定义角色，而不必把它加入七大引擎列表。

如果后台结果整合已耗尽供应商的常规重试，Vesicle 会保留就绪的持久化结果，而不会启动无上限的计费重试循环。提交 `/agents retry` 可以显式重试该投递。

## 查看当前供应商与模型

TUI 底栏会显示当前供应商和模型。也可以提交下面的命令打开模型选择器：

```text
/model
```

选择器分为两步：

1. 使用上、下方向键选择已配置的供应商，然后按 Enter。
2. 选择该供应商下已经配置的一个模型，再按一次 Enter。

Ctrl+P 和 Ctrl+N 可以代替上、下方向键。Escape 会从模型步骤返回供应商步骤；再次按 Escape 会关闭选择器，并且不改变任何设置。

第 04 章的入门配置只有一个供应商和一个模型，因此每一步可能只有一个选项。以后在 `providers.yaml` 中加入更多配置档后，同一个选择器仍是带引导的切换方式。

打开或使用选择器属于本地宿主操作，不会发送提示，也不会消耗模型 token。所选供应商和模型会用于未来的模型请求，并在已有会话中记录。

## 直接使用模型命令

建议新手使用交互式选择器。Vesicle 也支持直接形式：

```text
/model deepseek
/model deepseek deepseek-v4-flash
```

`/model <provider>` 会选择该供应商配置的默认模型。`/model <provider> <model>` 会选择一个准确的已配置组合。单个参数如果不是供应商 id，则会被视为当前供应商下的模型。

Vesicle 会拒绝 `providers.yaml` 中没有列出的供应商和模型。在命令中修改模型 id 并不会自动把它添加到配置中。

## 查看 Prism 引擎

提交：

```text
/engine
```

Vesicle 会列出内置引擎，并用 `*` 标记当前引擎：

| 引擎 id | 预期职责 |
|---|---|
| `etl` | 把源材料转换成结构化卡片与人格提示 |
| `runtime` | 运行逐回合角色交互 |
| `evaluate` | 审查制品与连续性 |
| `weaver` | 起草场景片段 |
| `weaver-orch` | 协调长篇写作 |
| `dyad` | 处理双实体模拟数据 |
| `stage` | 从准备好的卡片运行连续、角色驱动的叙事 |

当前 alpha 中，不同引擎的验证与确认支持程度不同。当前限制以 `STATUS.md` 为准；不要假设所有引擎都拥有相同的验证器或引导式工作流。

## 启动 Stage 会话

Stage 是唯一不能通过 `/engine stage` 进入的引擎。它必须在会话创建前得到准备好的 Module A 角色卡和 Module B 场景卡，请使用：

```text
/stage workspace/character.md workspace/scenario.md
```

两个路径都必须相对于当前项目，并位于允许的项目根目录下。Vesicle 会在你的第一次行动前冻结所提供的角色卡和可见的场景开场。缺少结构或使用不常见格式时，可能出现简短的兼容性提示；提示不会认证、改写或拒绝你的创作内容。只有路径无法读取或不安全、已验证的 Harness 不可用、或新会话无法保存时，启动才会失败。Stage 默认没有模型可见工具、确认门、MCP 工具或自动重写。之后即使编辑了任一源卡，恢复的 Stage 会话仍会使用已保存的角色和场景上下文，并可能提示源文件已变化。

Stage 回复使用共享的三段式 packet。玩家视图以散文为主，只显示紧凑的状态指示，并默认隐藏完整的开场逻辑注释和 Neural Chain 注释。单击一条 Stage assistant 消息即可切换到它的完整原始源码，保留每一个 HTML 注释分隔符和 HUD 行；再次单击即可回到玩家视图。聚焦该消息后也可使用 `Ctrl+Alt+S` 切换。这个视图状态是临时的，所以恢复或回退会话时会回到玩家视图，而原始 packet 始终不会在 provider history 或 session 文件中被改写。

## 切换引擎

要让未来回合使用 Evaluate，请提交：

```text
/engine evaluate
```

Vesicle 应当报告未来回合会使用 Evaluate 配置。该命令本身在本地执行，不会调用供应商。

练习后返回 ETL：

```text
/engine etl
```

引擎切换默认保留当前对话上下文。在已有会话中，Vesicle 会记录这次切换，并向未来的模型回合提供一个有长度限制的移交信息包。这有助于新引擎理解控制权为何发生变化，但不会改写此前的消息。

同一个项目确实转向另一项 Prism 任务时，可以切换引擎。对于无关任务，先创建全新会话通常更加清晰；第 08 章会介绍 `/new`。

`/engine <id> --summary` 和模型请求的引擎移交等高级形式会在后续章节介绍。

## 选择正确的层次

- 需要不同 API 服务或账户时，切换**供应商**。
- 需要不同的智能、速度、价格、上下文、推理或视觉能力时，切换**模型**。
- 工作从提取转向评估、运行时交互、编织、编排或其他 Prism 工作流时，切换**引擎**。

如果某个引擎需要当前模型不支持的工具或能力，请另外切换模型。

## 完成检查

满足以下条件时即可继续：

- 你可以解释模型与引擎为什么不同
- `/model` 可以打开“供应商 → 模型”两步选择器
- `/engine` 会列出内置 Prism 引擎并标记当前引擎；Stage 只能通过 `/stage` 启动
- 你知道 `/stage` 会从角色卡和场景卡启动第七个引擎
- 你在不发送模型请求的情况下切换到 `evaluate`，然后返回 `etl`
- 你理解切换会影响未来回合，并且可以随会话恢复
- `/agents` 会独立于七大 Prism 引擎列出专业 Agent Profile
- 你理解前台等待与后台结果投递的区别

[下一章：会话与恢复 →](./08-sessions-and-resume.md)

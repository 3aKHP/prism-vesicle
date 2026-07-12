# 09 — 一次完整的 ETL 工作流

[← 上一章：会话与恢复](./08-sessions-and-resume.md) | [手册目录](./README.md) | [English](../en/09-complete-etl-workflow.md)

## 本章目标

你将使用一个原创全年龄练习角色完成两个核心 ETL 工作流：经过三个确认检查点构建 Module A 角色卡，从三个剧情钩子中选择一个并构建 Module B 场景卡，最后预览并验证两个制品。

**预计耗时：**45–75 分钟

**供应商用量：**需要多次模型请求；开始前请检查供应商余额

**前置条件：**第 00–08 章、一个支持工具调用的已配置模型，以及可以正常工作的 ETL 引擎

## ETL 会生成什么

Prism ETL 引擎会把源材料转换成结构化制品：

- **Module A — Character Card：**身份、外观、传记、决策过程、本能、拓扑、声线和世界背景
- **Module B — Scenario Card：**可运行的情境、开场、用户角色，以及从角色特征推导出的三至五步节拍图

ETL 引擎还支持 DLC 变换和 Lite 人格提示，但第一次完整工作流只关注 Module A 与 Module B。

当前 Prism v9 ETL 资产契约要求创意正文使用简体中文，同时让结构标题与标签保持英文。这是预期行为。

## 为什么使用受控练习

练习角色是原创、虚构且全年龄的。源材料已经提供足够信息，因此模型不需要使用 Web 或 MCP 研究。两个输出路径都提前指定，清理与验证结果会更容易预测。

模型响应并不确定。具体措辞会有变化，但阶段顺序、确认边界、文件路径和必要文档结构应当保持稳定。

## 第 1 步 — 创建源材料

使用 Ctrl+Q 退出 Vesicle。在 PowerShell 中确认你位于教程项目：

```powershell
Set-Location "$HOME\Documents\PrismVesicle\MyFirstProject"
```

创建源材料文件夹，并打开新的练习简介：

```powershell
New-Item -ItemType Directory -Force "source_materials"
New-Item -ItemType File -Force "source_materials\mira-brief.md"
notepad "source_materials\mira-brief.md"
```

把下面的完整简介复制到记事本中：

```markdown
# Mira Vale 练习简介

Mira Vale 是为本教程创建的原创全年龄角色。

- 年龄与职业：29 岁，浮空轨道城市 Bellweather 的夜班信号技术员。
- 外观：身形紧凑，深铜色头发剪至下颌，穿带反光接缝的灰色工作外套，佩戴老式黄铜无线电耳机，两根手指常有墨迹。
- 公开表现：精确、安静，比起解释感情，更习惯修复系统。
- 核心欲望：保证每一位乘客安全，同时证明自己永远不需要他人帮助。
- 起源事件：担任初级技术员时，Mira 报告了反复出现的警告音，但主管没有重视；后来发生的信号故障使她的妹妹受伤。
- 温暖记忆：父亲曾教她通过声音识别电路并修理无线电。
- 压力反应：语言变得简短，承担过多责任，并且拒绝委派任务。
- 正向变化：持续而耐心的信任会让她展现冷幽默、合作解决问题，并坦率请求帮助。
- 硬性边界：她绝不会为了保护名誉或完成时刻表而故意让平民陷入危险。
- 声线：平常使用简短的技术句式；压力下会在言语中加入节奏、静电和故障信号等比喻。
- 当前情境：一条关闭的午夜轨道线上出现了无法解释的信号回声，Mira 被安排与一名外部调查员搭档。
- 期望基调：氛围化谜团、职业信任、克制的温暖，不包含露骨或成人内容。
```

按 Ctrl+S 保存并关闭记事本。

该文件是输入材料，应放在 `source_materials`，而不是 `workspace` 中。

如果以后重复本章，请先移动或重命名此前的 `mira_vale` 练习输出，避免模型把旧的部分文件误认为本次干净流程的目标文件。

## 第 2 步 — 创建干净的 ETL 会话

启动 Vesicle：

```powershell
bunx vesicle
```

分别提交下面两个本地命令：

```text
/new
```

```text
/engine etl
```

`/new` 可以避免此前的教程对话干扰工作流。`/engine etl` 确认未来回合使用 ETL 配置。这两个命令都不会调用供应商。

## 第 3 步 — 请求 Module A 蓝图

提交下面的提示：

```text
请使用 ETL 工作流 A，根据 source_materials/mira-brief.md 为 Mira Vale 构建 Module A 角色卡。

这是一个原创全年龄练习角色。不要使用 Web 或 MCP 工具。使用 workspace/mira_vale.md 作为目标路径。

只从 Phase 0 开始：读取必要的 schema、template 和源材料；展示 Target Concept、Archetype、Core Desire 与 Topology Notes；然后请求 blueprint-confirmation。在我确认前，不要创建或编辑任何文件。
```

模型应当读取 schema、template 和源材料，然后在对话中展示蓝图。底部面板应显示：

```text
Stop Gate: blueprint-confirmation
```

此时不应存在 `workspace\mira_vale.md` 文件。

## 第 4 步 — 检查蓝图确认门

同时阅读对话中的完整蓝图和确认门中的精简摘要。确认它保留了：

- Mira 的责任感和拒绝委派倾向
- 警告被忽视的起源事件
- 逐渐信任他人并请求帮助的正向变化可能
- 绝不故意让平民陷入危险的硬性边界
- 全年龄氛围化谜团基调

如果蓝图可以接受，保持选中 **Confirm — proceed to next phase**，然后按 Enter。

如果重要内容有误，选择 **Reject — discuss or request changes**，在行内输入框中填写具体修改要求，然后按 Enter。模型应当修改或讨论蓝图，并再次请求确认。拒绝确认门不会结束会话。

不要仅仅因为面板出现就点击确认。确认门的作用是防止错误蓝图影响之后的每一个章节。

## 第 5 步 — Phase 1：The Shell

确认后，模型应创建：

```text
workspace\mira_vale.md
```

Phase 1 只写入静态 YAML frontmatter 和 `## Visual Cortex`，然后在下面的确认门暂停：

```text
Stop Gate: phase-confirmation
```

确认门摘要应给出文件名、已完成部分，并说明下一步是 Phase 2。

检查路径是否正确，并确认摘要只描述 Phase 1 的外壳内容。确认后继续。如果写入了错误文件，或者模型声称已经完成了更晚的部分，请拒绝并给出具体说明。

Phase 1 的部分文件尚不需要通过完整 Module A 验证器。

## 第 6 步 — Phase 2：The Neuro-Structure

下一次确认后，模型应在同一文件中追加：

- `## Biography`
- `## Cognitive Stack`，其中包含明确的 `Invariant:` 和 `Variant:` 行为
- `## Instinct Protocol`

随后，它应在另一个 `phase-confirmation` 确认门暂停，并说明下一步是 Phase 3。

检查摘要。同一目标文件已经更新并且所列部分符合 Phase 2 时，可以确认。如果模型丢失了原始角色锚点，或把运行时状态当成静态身份，请使用 Reject 提供反馈。

## 第 7 步 — Phase 3：Topology and Voice

第三次确认后，模型应使用以下内容完成角色卡：

- `## Persona Topology`
  - `### Invariant Axes`
  - `### Variant Axes`
  - `### Boundary Conditions`
- `## Narrative Engine`
- `## World Context`

Phase 3 会完成工作流 A，通常不会再出现确认门。助手应当提供移交或完成说明。

此时，`workspace\mira_vale.md` 应当是一份完整的 Module A 角色卡。

## 第 8 步 — 预览并验证 Module A

按准确路径预览文件：

```text
/artifact workspace/mira_vale.md
```

预览会主动限制长度，因此长文档在对话中可能被截断，磁盘上的文件仍然完整。

验证文件：

```text
/validate workspace/mira_vale.md
```

干净的结果会显示验证通过。检查结果属于建议性信号，并不会让程序终止。Module A 的常见问题包括缺少章节、YAML 字段不正确、不变轴或可变轴数量不足、没有正向变化，或者仅供生产层使用的 L-System 标签泄漏到制品中。

如果验证报告问题，请保留会话和准确文件。第 11 章会介绍严谨的“检查—修改—重新验证”循环。如果角色卡确实存在且内容可辨认，你可以继续本教程，但不要把未通过验证的角色卡视为可发布内容。

## 第 9 步 — 请求三个 Module B 剧情钩子

提交：

```text
现在请使用 ETL 工作流 B，并读取 workspace/mira_vale.md。

提出三个不同的全年龄谜团剧情钩子，所有钩子都应建立在 Mira 的拓扑和关闭的午夜轨道线之上。使用 ask_user_question 让我从三个钩子中选择一个。选择后，把对应场景写入 workspace/mira_vale_scenario_practice.md。
```

模型应当读取完成的角色卡，提出三个钩子，并打开问题面板。Vesicle 会在模型提供的三个选项后追加 **Skip** 和开放回答选项。

本次练习请选择前三个钩子中的一个：使用上、下方向键选择，然后按 Enter。不要选择 Skip，因为工作流需要一个明确钩子来构建场景。

## 第 10 步 — 让工作流 B 写入场景

选择后，模型会继续同一个 ETL 回合，并应创建：

```text
workspace\mira_vale_scenario_practice.md
```

工作流 B 不使用工作流 A 的 Phase 0/1/2 确认序列。明确的剧情钩子问题就是它的用户选择边界。

完成的场景应包含 YAML frontmatter、三至五步 `beat_map`、开场段落、第一句台词，以及描述 premise、neural state 和 user role 的隐藏 HTML 注释块。

## 第 11 步 — 预览并验证 Module B

预览场景：

```text
/artifact workspace/mira_vale_scenario_practice.md
```

验证场景：

```text
/validate workspace/mira_vale_scenario_practice.md
```

Module B 的常见问题包括缺少节拍字段、少于三个或多于五个节拍、张力值超出 `0–100`、张力轨迹只会上升，或者行为无法从角色可变轴中推导。

## 第 12 步 — 在 Windows 中确认文件

使用 Ctrl+Q 退出 Vesicle。在文件资源管理器中打开 workspace：

```powershell
explorer "workspace"
```

你应当看到：

```text
mira_vale.md
mira_vale_scenario_practice.md
```

如果希望检查完整文档，可以使用文本编辑器打开文件。本次练习中不要修改它们；第 11 章会介绍修改与重新验证。

## 工作流偏离预期时

### 模型在蓝图确认前写入文件

不要假装确认边界得到遵守并继续确认后续阶段。记录实际情况。对于可丢弃的练习，可以创建全新会话，并再次执行 Phase 0 提示，明确强调禁止提前写入。

### 模型描述了确认门，但没有出现确认面板

提交：`不要推进。现在请为当前所需 gate 调用 request_confirmation。` 普通文本问题不能替代宿主确认门。

### 模型要求进行 Web 研究

拒绝该请求，或者说明现有简介已经足够，并且本次练习没有授权外部研究。

### 供应商或工具错误中断工作流

不要立即从头开始。重新连接后运行 `/resume`，查看该会话是否带有等待处理的 gate 或 question 标记。只追加会话的设计目的之一，就是保存这些暂停点。

### 输出路径不同

继续前要求模型使用准确的练习路径。不要仅仅因为意外文件出现在制品列表中，就直接验证它。

## 完成检查

满足以下条件时，你已经完成核心 ETL 工作流：

- 源材料仍然位于 `source_materials` 下
- 工作流 A 在一个 `blueprint-confirmation` 和两个 `phase-confirmation` 确认门暂停
- `workspace\mira_vale.md` 包含 Module A 的全部七个章节
- 工作流 B 通过 `ask_user_question` 提供了三个钩子
- `workspace\mira_vale_scenario_practice.md` 包含节拍图与开场
- 你按准确路径预览并验证了两个文件
- 你理解确认是一项审查决定，而不是需要自动点击的按钮

下一章会重点介绍制品检查、验证结果、针对性修改和重新验证。

[返回手册目录](./README.md)

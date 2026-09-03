<!-- Generated from docs/user/zh-CN/advanced/quality-guard.md — do not edit. -->

# Output Quality Guard

[English](../../en/advanced/quality-guard.md) | 简体中文

> **状态(截至 `1.1.0`):** 🟢 守卫主体(确定性 finding + anti-ai-flavor 规则包)已实现并按当前 Harness 接线运行;🟡 Semantic Judge、rewrite 绑定下的文档指标、`semantic-rewrite@1` 策略为**实验性**。成熟度以 [`STATUS.md`](../../../../STATUS.md) 为准。

Output Quality Guard 是一层**面向 target** 的质量检查:在质量边界上重新读取受保护制品的完整 post-image,用 anti-ai-flavor 规则包检测"机器味",并可选用一个实验性 Semantic Judge 复核。它的目的是让产出散文更像人写的,而不是判定作者是不是 AI。

## 两层结构

### 1. 确定性守卫(🟢)

由当前 Harness 为每个引擎/Agent 声明的质量模式驱动(`off` / `observe` / `rewrite`,以及内部的 `strict` / `analyze`)。内置 V10 Harness 当前的接线大致是:Runtime 制品的散文走 `rewrite`(可阻塞),Stage / Weaver / Weaver-Orch / Scene Writer / Dyad 走 `observe`(只记录建议),ETL 等非散文producer 关闭。**这一层用户不直接开关**,它随 Harness 走。

检测内容:

- **anti-ai-flavor 规则包**(`quality-guard/anti-ai-flavor@1`):**字面**(子串)与**正则** finding。规则带 `maturity`(stable/experimental)与 `severity`(tier1/…)。
- **6 项文档指标**:有限的正则信号统计。代码里可见的如破折号密度(`em_dash_per_100_chars`)、动作列动词密度(`action_list_verbs_per_paragraph`)、比喻标记密度(`metaphor_markers_per_1000_chars`);完整清单在规则包。
- 检测前会**遮蔽**不当作散文的区域:代码块、HTML 注释、引用、HUD 行(`[Beat]`/`[Tension]`/`[!Neural Chain]` 等)、YAML 头、标题、列表、表格、章节标题。

**什么算阻塞**:`blockingFindings` 只包含 `maturity: stable` + `severity: tier1` 且**不是文档指标**的 finding。**文档指标即便在 rewrite 绑定下也只是建议性**,不进阻塞策略、不花 rewrite 次数。匹配有预算(每 target 10 万次),耗尽 → 产出 `detector-budget-exhausted` 不确定警告(不阻塞、不报 clean)。

**target 怎么来**:只从**成功的** `create_file` / `write_file` / `replace_in_file` / `append_file` 结果派生;每个受保护路径的完整当前 post-image 在质量边界被重新读取;每个 target 独立挂起。一个干净的完成摘要或无关的干净文件不能让一个未改的坏制品通过。

**rewrite 生命周期**(rewrite 模式):失败 target 最多 **2 次**原始引擎重写;每个 target 的 post-image 哈希独立追踪,重复出现同一哈希即停止(防死循环)。瞬态重试耗尽 → 持久化一条建议性质量警告 + 一个**决策点**:再修一次 / 用当前版本 / 停(不调用供应商)。取消、供应商失败、进程重启都保留这个决策;Harness / Rule Pack / 实验性 profile 身份漂移会禁用重试,但仍允许本地记录"用当前 / 停"。

### 2. Semantic Judge(🟡,可选,默认关)

一个用户级实验性覆盖,用**单独注册的** provider/model 复核散文。默认 `off`。

常规入口是 `/quality` 命令(不带参数运行)。它会打开一个状态感知的设置选择器,显示当前模式与生效的 Judge profile,并提供三种模式加一个次要的 **Change Judge** 动作:

| 标签 | 稳定值 | 效果 |
|---|---|---|
| `Off` | `off` | 不发任何 Judge 请求 |
| `Review only` | `observe` | 记录实验性 finding;不触发修订 |
| `Review and revise` | `rewrite` | 最多可请求两次 Engine 修订 |
| `Change Judge` | — | 浏览已注册的 provider/model 列表,不开启任何模式 |

`/quality` 会记住你的 profile:关闭 Judge(或运行 `/quality off`)会保留最近一次完整的 provider/model/timeout 组合作为休眠 profile,在关闭期间不发任何 Judge 请求。首次使用且无已保留 profile 时,选择器会显式预选当前注册的 provider/model——这是一个 UI 默认值加一次显式动作,绝不静默回退。不带参数的 `/quality observe` 在存在有效保留 profile 时立即开启 Observe,否则打开选择器并聚焦 `Review only`。不带参数的 `/quality rewrite` 会解析"保留或当前"候选并直接打开红色确认面板。

选择 **Review and revise**(或运行 `/quality rewrite [provider model [timeout-ms]]`)会暂存候选并打开一个红色两阶段确认面板,交互仿照 `/permissions YOLO`:Enter 从 `Continue` 推进到 `Enable Review and Rewrite`,第二次 Enter 才写入设置,任意阶段按 Esc 都保持原配置不变。已不再有 `/quality confirm` 这第二条命令。

用于自动化与诊断时,同样的设置写在 `quality.yaml`(与 `providers.yaml` 同目录):

```yaml
version: 2
mode: observe          # off / observe / rewrite
providerAlias: deepseek
modelId: deepseek-v4-flash
judgeTimeoutMs: 15000
```

完整的组合也可留在 `mode: off` 下作为休眠保留 profile。version 2 源自 alpha 阶段的前向迁移;较旧的 Vesicle 构建可能无法读取,首次改动设置会把 version 1 文件改写为 version 2。

它只在这些条件下运行:producer 是 `runtime` 或 `stage`,**且**确定性守卫已判定 `pass`(对已经干净的候选做二次复核)。特性:

- **工具面为空**、无正常对话历史、`temperature: 0`(若支持)、输出上限 2048 token、reasoning 关闭(若支持)。
- 输出必须是严格 JSON(`quality-judge-result/v1`);解析失败最多**修复一次**,再失败记为 `invalid`。
- 超时(默认 15 秒)/ 供应商失败 / 输出非法 / 候选超长(>30000 码点)→ 产出**持久化不确定警告**,不报 clean。
- `observe` 模式只记录 finding(建议性);`rewrite` 模式才会把 Judge 的 finding 提升为阻塞、进入上面那个 2 次重写生命周期(实验性)。
- 只留存**无密的** profile 快照(provider/model/protocol/timeout/configIdentity)、有界的 finding 与证据、计时、请求数、有界用量——**不**留存候选原文或原始 Judge 响应。
- 系统提示明确要求:**不得调用工具,不得声称文本是否由 AI 或人类撰写**。

> 它不是校准过的生产质量策略,也不做 AI 作者判定。

### 3. Semantic Rewrite Policy(`semantic-rewrite@1`,🟡)

当某个未来的 Harness Pack 要求它时,Vesicle 会识别并 fail-closed 地哈希校验、解析该策略(必须 active、allowlist 已知稳定 Judge 规则、每规则有限置信阈值、精确 protocol/model 作用域无重叠、含非占位校验摘要)。但目前它**只做纯资格判定**(`observe` / `inconclusive` / `eligible`),**没有**接进 rewrite 状态机——要等校准、held-out、保留门完成后才会连接。**当前 bundled Harness 仍是 semantic-observe only。**

## 可见性与持久化

- session 行标记 interrupted / pending 的质量工作;制品行标记有未决警告的路径;后续一次干净 post-image 会显式 resolve 对应警告。
- observe 绑定覆盖 Dyad / Weaver / Weaver-Orch / Scene Writer / Stage;**Evaluate 与 Chapter Reviewer 的报告不递归强制**。
- 质量决策优先级高于门:有未决质量决策时,它会先于其它 gate 处理。

## 看到质量决策面板时怎么选

自动修订被中断或两次机会耗尽时,底部会出现 `Revision interrupted` / `Revision exhausted` 面板。用 `↑` / `↓` 选择,Enter 确认:

| 选项 | 会发生什么 | 何时使用 |
|---|---|---|
| `Revise again` | 发起一次你明确授权的原 Engine 供应商请求,尝试修当前 target | 你认同 finding,且愿意付出一次请求与改写成本 |
| `Use current version` | 不再请求供应商;文件 target 保留当前文件,回复 target 则把当前候选显示为正式回复;两者都连同 warning/findings 记录为已接受 | 你检查过内容,认为当前版本可用但不应伪装成 clean |
| `Stop` | 不请求供应商;不把被拒绝的回复候选显示为正式回复,也不接受当前文件;结束这个待决点并保留 warning | 现在不想接受也不想继续花费,准备之后另行处理 |

选择后状态行先显示 `starting user-authorized quality revision` 或 `recording quality decision: ...`;记录成功后待决面板消失,会话与 Host 制品状态刷新。`Use current version` 与 `Stop` 都不会消灭 warning。两者都会解决当前待决点,所以重启后不会再次弹出同一个面板;区别是前者明确交付/接受当前版本,后者不交付被拒绝的回复候选、把当前 target 标为停止处理。若要稍后再修,请从 warning 标出的路径或会话上下文发起一条新的修订请求。

如果第一项显示 `Revision unavailable`,不要选它。常见原因是恢复会话时 Harness / Rule Pack / 实验性 profile 身份与记录不一致。运行 `vesicle assets status` 与 `vesicle doctor`,恢复记录使用的精确 Harness 身份后再 `/resume`;无法恢复时仍可选择 `Use current version` 或 `Stop`,也可以复制制品后在新会话中重新发起任务。不要编辑 session JSONL 强行清掉决策。

## 开发者专用

`vesicle quality benchmark` 是一个**仅供开发者**的 Semantic Judge 评测命令(需冻结 plan 与 `--allow-live`,只记录测量证据,不能开启语义阻塞)。它独立于 Runtime 策略,不在本页展开;见 [`docs/dev/QUALITY_BENCHMARK.md`](../../../dev/QUALITY_BENCHMARK.md)。

## 状态会变

本页的 🟢/🟡 标注反映 `1.1.0` 的成熟度。Semantic Judge、文档指标、Semantic Rewrite Policy 都可能随版本转稳——以 [`STATUS.md`](../../../../STATUS.md) 为权威当前状态。

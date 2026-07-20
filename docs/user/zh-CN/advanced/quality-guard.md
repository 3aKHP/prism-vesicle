# Output Quality Guard

[English](../../en/advanced/quality-guard.md) | 简体中文

> **状态(截至 `1.0.0-alpha.3`):** 🟢 守卫主体(确定性 finding + anti-ai-flavor 规则包)已实现并按当前 Harness 接线运行;🟡 Semantic Judge、rewrite 绑定下的文档指标、`semantic-rewrite@1` 策略为**实验性**。成熟度以 [`STATUS.md`](../../../../STATUS.md) 为准。

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

一个用户级实验性覆盖,用**单独注册的** provider/model 复核散文。通过 `quality.yaml`(与 `providers.yaml` 同目录)或 `/quality` 命令配置,默认 `off`。

```yaml
version: 1
mode: observe          # off / observe / rewrite
providerAlias: deepseek
modelId: deepseek-v4-flash
judgeTimeoutMs: 15000
```

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

## 开发者专用

`vesicle quality benchmark` 是一个**仅供开发者**的 Semantic Judge 评测命令(需冻结 plan 与 `--allow-live`,只记录测量证据,不能开启语义阻塞)。它独立于 Runtime 策略,不在本页展开;见 [`docs/dev/QUALITY_BENCHMARK.md`](../../../dev/QUALITY_BENCHMARK.md)。

## 状态会变

本页的 🟢/🟡 标注反映 `1.0.0-alpha.3` 的成熟度。Semantic Judge、文档指标、Semantic Rewrite Policy 都可能随版本转稳——以 [`STATUS.md`](../../../../STATUS.md) 为权威当前状态。

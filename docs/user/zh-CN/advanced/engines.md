# 选择 Prism Engine

[English](../../en/advanced/engines.md) | 简体中文

Engine 决定模型收到的工作流提示、可见工具、校验器和确认门。它不是模型:用 `/model` 换供应商/模型,用 `/engine` 换工作流。先在 TUI 输入:

```text
/engine
```

列表中 `*` 标记当前 Engine。除 Stage 外,用 `/engine <id>` 切换;成功时会看到 `Engine switched to <id>. Future turns will use that profile.`。切换只影响**之后的回合**,不会自动开始任务。

## 七个内置 Engine

| id | 适合的任务 | 最少输入 | 常见产出/反馈 |
|---|---|---|---|
| `etl` | 从原始素材制作角色卡、情景卡、扩展素材或轻量 persona prompt | `source_materials/` 中的笔记或已有卡片 | 蓝图与阶段确认门;制品通常写 `workspace/` |
| `runtime` | 用角色卡 + 情景卡进行逐回合、文件级模拟 | 两张卡和 `test_runs/` 中的会话日志路径 | 追加三段式回应到日志,每轮出现 runtime 确认门 |
| `evaluate` | 审计卡片、日志、扩展素材或长篇连续性 | 明确目标文件;需要事实核查时可读 `source_materials/` 或搜索 | `reports/audit_<target>.md` 和内联 PASS/CONDITIONAL/FAIL；默认只报告、不代修 |
| `weaver` | 单引擎写一章,按 Scene Shards 顺序写场景并编译 | 角色卡、情景卡、`outline.md`、`story_bible.md` | `novels/<项目>/chapters/Chapter_XX/Scene_NNN.md` 与编译章节 |
| `weaver-orch` | 编排长篇:规划、顺序委派 Scene Writer、同步 Story Bible、独立审计 | 卡片;新项目可从目标开始,既有项目需 outline/story bible | 项目骨架、场景、章节、Story Bible、审计报告和决策点 |
| `dyad` | 让模型同时扮演用户实体与角色实体,生成多轮模拟数据 | 角色卡 + 情景卡;可选 simulation plan | `test_runs/<name>_simulation_plan.md` 与 `_dyad_log.md` |
| `stage` | 用户亲自扮演一方的连续叙事消费体验 | 一张角色卡 + 一张情景卡 | 直接续写;无工具、无门。必须用 `/stage`,不能普通 `/engine stage` |

## 第一次切换示例:Evaluate

先确保 `workspace/` 里已有要检查的文件,然后:

```text
/engine evaluate
```

看到成功反馈后发送:

> 只读审计 workspace/角色卡.md。对照 source_materials/ 的事实与 Module A 结构,把报告写到 reports/audit_character.md。不要直接修改被审文件。

成功时最终回复应给出 verdict 和报告路径;用 `/artifact reports/audit_character.md` 打开。`/validate` 的结构校验与 Evaluate 审计不是一回事:前者是本地规则,后者是一次会产生供应商费用的模型审计。

## 长对话切换前压缩

直接切换会保留当前对话历史。如果旧工作流很长,可在切换前生成摘要:

```text
/engine evaluate --summary 重点保留卡片路径、已确认事实和仍待核查的问题
```

成功反馈包含 `with summarized context`。原转录仍保留,供应商上下文从 portable compact checkpoint 继续。摘要也会调用当前供应商;失败时 Engine 不应伪装成已经带摘要切换,可先 `/compact` 或缩短会话后重试。

## Stage 的特殊入口

Stage 必须冻结两张卡和开场上下文,所以普通 `/engine stage` 会拒绝并告诉你使用:

```text
/stage workspace/角色卡.md workspace/情景卡.md
```

详情与失败恢复见 [Stage 消费引擎](./stage.md)。想离开 Stage,用 `/new` 回到默认 ETL 新会话。

## 选择错误时

- `Unknown engine`:运行 `/engine` 并复制表中的 id,不要用显示名。
- Engine 切对但模型“没开始”:切换只选工作流,还要再发一条包含输入路径与目标的普通消息。
- 工具或门与预期不符:运行 `/engine` 确认星号,再用 `vesicle prompt shape --engine <id>` 检查生效资产;必要时 `/new` 排除旧会话身份。
- Weaver-Orch 的 Agent 失败:按界面给出的可恢复决策处理,不要把“子任务完成”当成文件已写;用 Workspace 检查实际制品。

## 检查点

- [ ] 你能区分 `/model` 与 `/engine`。
- [ ] 你用 `/engine` 看到了当前 id,并完成一次非 Stage 切换。
- [ ] 你知道 Stage 必须走 `/stage`。
- [ ] 你能根据任务在 ETL、Runtime、Evaluate、Weaver、Weaver-Orch、Dyad、Stage 中选一个入口。

<!-- Generated from docs/user/zh-CN/tutorials/skills-and-subagents.md — do not edit. -->

# 用 Skills 查资料,用 SubAgents 分工

[English](../../en/tutorials/skills-and-subagents.md) | 简体中文

Skill 给模型一份按需加载的操作指南与资源;SubAgent 则启动一个有独立上下文和工具范围的子运行时。前者适合“先学会怎么做”,后者适合“把一块边界清楚的工作交出去”。两者都不会扩大权限。

## 让模型查 Vesicle 自己的手册

每个安装包自带只读的 `vesicle-docs` Skill,内容与当前 Vesicle 版本匹配。先确认它存在:

```bash
vesicle skills inspect vesicle-docs
```

成功时输出会显示 `vesicle-docs` 的 `host` 范围、说明和资源清单。在 TUI 中直接问一个可执行的问题:

> 请使用 vesicle-docs,告诉我怎样恢复一个旧会话。先读取相关用户手册资源,再给出我现在能照做的步骤、成功反馈和失败时的下一步。

模型应先激活 Skill,再读取至少一个资源,然后回答。也可以显式运行:

```text
/skill vesicle-docs 怎样恢复旧会话并切换候选分支?
```

如果只想把文档上下文加载进当前会话、不立刻问供应商:

```text
/skill vesicle-docs --context-only
```

成功激活后,转录会显示 Skill 已激活及所读资源。Skill 资源是参考资料;用户手册与实际命令冲突时,保留具体差异并按[故障排查](../reference/troubleshooting.md)报告。

### Skill 找不到或没有生效

- 先运行 `vesicle skills list` 和 `vesicle skills inspect vesicle-docs`,确认当前生效范围以及它属于 disabled、invalid 还是 shadowed。`vesicle doctor` 也会汇总 valid / invalid / shadowed 数量。
- 如果 `list` 完全没有 `vesicle-docs` 且 `inspect` 报 `No skill named`,重新安装当前同一版本的 Vesicle;这是安装包应自带的 host Skill。
- 如果是 `(disabled)`,运行 `vesicle skills enable vesicle-docs`。
- 如果是 `invalid`,按 `inspect` 的诊断修复对应 project/user Skill 的 `SKILL.md`,再运行 `vesicle skills validate <该Skill目录>`;若损坏的是安装包自带的 host `vesicle-docs`,重新安装同一版本的 Vesicle。
- 如果内置 host `vesicle-docs` 被 project/user 范围的同名自定义 Skill shadowed,先备份该自定义目录,再将它移出 `.agents/skills/vesicle-docs/` 或用户配置的 `skills/vesicle-docs/`,或给它改一个不冲突的合法名称。`enable` 不会消除 shadow。
- 修复后**新建会话**再试。Skill 目录在会话首次解析时冻结,改动不会热替换当前目录。
- Stage 不加载任何 Skill;用 `/new` 回到 ETL 等普通 Engine 后再试。

## 把一个任务交给 SubAgent

最稳妥的任务要有明确输入、产出和禁止事项。例如:

> 请让 explore SubAgent 只读检查 source_materials/ 下有哪些角色资料,输出文件清单、每份资料的一句话摘要和缺失项。不要修改文件,后台运行;你继续和我讨论角色目标。

父模型会调用 `spawn_agent`;后台成功启动后会返回形如 `explore-1` 的短句柄。你可以立即继续主对话,完成结果会在父会话空闲时自动投递,通常不需要轮询。

在 TUI 中管理它:

```text
/agents
/agents explore-1
/agents stop explore-1
```

- `/agents` 列出已安装 Agent Profile 和本会话任务状态。
- `/agents <句柄>` 查看一个任务。
- `/agents stop <句柄>` 中断仍在运行或排队的任务。
- 供应商错误导致结果投递失败时,修复连接后用 `/agents retry` 重试**投递**;它不是无条件重跑整个任务。

前台 SubAgent 会让当前模型回合等待结果,但 TUI 仍可响应。后台 SubAgent 立即返回句柄。默认最多同时运行 4 个顶层子任务;子任务不能继续创建孙任务。

### 重启与文件冲突

Vesicle 重启时,仍在跑的 SubAgent 会被标为 failed 并向父会话投递终止结果,不会偷偷重放供应商请求。先看 `/agents <句柄>` 的终止信息,再决定是否重新委派。

并行任务可能写文件时,应在提示中给每个 Agent 不重叠的目标路径。Vesicle 会拒绝已经检测到的重叠写入所有权,但清晰的分工仍能避免两个任务产生互相矛盾的内容。候选切换与重生成会等待活动 SubAgent 结束或被中断。

## 什么时候不用 SubAgent

- 只查一个命令:让当前模型读 `vesicle-docs`,不必创建子运行时。
- 任务依赖频繁向你提问:留在主对话更清楚。
- 只是想让模型遵守固定规则:用[持久化指令](./persistent-instructions.md)。
- 要接外部数据库或服务:用 [MCP](../advanced/mcp.md),不是 SubAgent。

## 检查点

- [ ] 你用 `vesicle skills inspect vesicle-docs` 看到了版本随附文档资源。
- [ ] 你让模型读取一个 `vesicle-docs` 资源后回答了具体问题。
- [ ] 你能写出含输入、产出和禁止事项的 SubAgent 任务。
- [ ] 你知道后台结果自动投递、重启不重放,并会用 `/agents stop <句柄>`。

完整 Skill 生命周期见 [Skills](../advanced/skills.md),Agent Profile 与 Driver-contract 细节见 [SubAgents](../advanced/subagents.md)。

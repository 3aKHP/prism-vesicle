# SubAgents

[English](../../en/advanced/subagents.md) | 简体中文

> **状态(截至 `1.0.0-alpha.4`):** 🟢 已实现。成熟度以 [`STATUS.md`](../../../../STATUS.md) 为准。

SubAgent 是一个**子运行时**:主引擎把一块自包含的任务委派给一个专门的 Agent Profile 去跑,前台等结果或后台异步进行。多个 `spawn_agent` 在同一回合里**并行**启动。

## 两类 Agent

| 类别 | 成员 | 行为 |
|---|---|---|
| **generic host Agents**(固定白名单) | `explore`、`general`、`plan`、`research`、`reviewer` | 普通并发 SubAgent,**不**走 Driver-contract 委派 |
| **Harness Driver-contract Agents** | V10 的 `scene-writer`、`continuity-editor`、`chapter-reviewer`,以及自定义 Profile | 绑定到父引擎声明的委派契约(固定前台/后台、用途、重试上限、ABI 错误模型) |

两类 Profile 都从 `assets/agents/*.agent.yaml` 经同样的项目/用户/bundled/host 覆盖层加载。generic 五个固定 id 绕过委派绑定;其余每一个 Agent 请求都要绑定到父引擎**唯一**声明的委派。

## 五个工具

| 工具 | 作用 |
|---|---|
| `spawn_agent` | 启动一个子任务;参数 `profile`、`description`(≤120 字)、`prompt`,可选 `mode`(foreground/background,默认用 profile 的) |
| `list_agents` | 列出已安装的 Profile 和本会话内的子任务(短句柄 + 生命周期状态) |
| `send_message` | 给**正在跑**的子任务追加指令(按短句柄,在下一个 provider-request 边界送达) |
| `interrupt_agent` | 取消正在跑或排队的子任务 |
| `wait_agent` | 显式等某个子任务并取回终止结果(后台通常无需主动等,见下) |

子任务用**短句柄**引用,形如 `explore-1`(句柄在父会话内唯一;底层还有 host-only 的 UUID run id 作全局/恢复身份)。

## 前台 vs 后台

- **前台**:阻塞当前回合等子任务结果,TUI 仍可响应。
- **后台**:立即返回句柄,不阻塞。结果进**持久父收件箱**,在父会话**空闲**时合并投递(防抖后一次性送出 `<subagent-results>` 包,不让多个完成各自打断你)。所以后台任务**通常无需轮询**——完成会自动在下一回合通知对话。

用 `/agents` 管理子任务:`/agents` 列出、`/agents <handle>` 查看、`/agents stop <handle>` 中断、`/agents retry` 在子任务因供应商错误终止后重试投递。活动/就绪的后台工作在 header 和工作区侧栏可见,每个子任务有专用 Agent 卡片原地更新。

## 限制(如实写)

- **递归禁用**:子任务拿不到 agent-control 工具,不能再 spawn 子任务。
- 顶层子任务并发(默认上限 **4**)。
- **重启行为**:Vesicle 重启时,之前在跑的子任务被**标记为 failed 并投递终止结果**,不会替你重放进行中的 provider 请求。
- 句柄在父会话内唯一;旧的 UUID 式引用仍被接受但不再发出。
- Weaver-Orch 的场景分配、Evaluate 的评审组成、制品合并策略属 **Harness 职责**,Vesicle 只提供调度/持久化/投递底座。

## Driver-contract 委派

contract-bound 委派**顺序**执行(不并发),持久化每次尝试与终止态;瞬态重试耗尽后,进入契约声明的**可恢复用户决策点**(类似质量守卫的"再试/用当前/停")。这是 Harness 驱动的工作流 Agent(scene-writer 等)与 generic host Agent 的关键区别。

## 自定义 Agent Profile

Profile 文件 `assets/agents/<id>.agent.yaml`,字段:

```yaml
id: my-agent            # 小写字母/数字/连字符
displayName: My Agent
description: 一句话用途
systemPrompt:           # 路径必须在 assets/prompts/agents/ 或 assets/prompts/host/ 下
  - assets/prompts/agents/base.md
  - assets/prompts/agents/my-agent.md
tools:                  # 具体工具名,或单独一个 "*"
  - read_file
  - grep_files
contextMode: fresh      # fresh / summary / fork
modelPolicy: inherit    # 目前只支持 inherit
defaultMode: background # foreground / background
maxTurns: 20
```

非白名单的自定义 Profile 在 V10 Harness 激活时必须满足当前 Driver Contract 才能运行。用 `vesicle assets materialize assets/agents/<id>.agent.yaml` 把一个 Profile 复制到项目或用户层进行编辑(同其它 assets 覆盖规则)。

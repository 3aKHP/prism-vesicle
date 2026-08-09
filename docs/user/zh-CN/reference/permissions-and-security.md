# 权限与安全模型

[English](../../en/reference/permissions-and-security.md) | 简体中文

这篇把 Vesicle 的工具批准机制和底层守卫讲清楚。教程里的 [权限与 Shell](../tutorials/permissions-and-shell.md) 是入门版,这里是完整参考。

## 四档权限模式

`/permissions` 查看,`/permissions <MODE>` 切换。模式只改变"工具调用前要不要问你"这道摩擦。

| 模式 | 行为 |
|---|---|
| **MOMENTUM**(默认) | 读取自动放行,常规写操作自动放行——**仅 `shell_exec` 会问** |
| **INERTIA** | 读取自动放行,**改动类操作每次都问** |
| **MANUAL** | **每一个**模型可见工具调用都问 |
| **YOLO** | 全部自动放行;**不能存为默认**,只能当次会话开 |

关键不变量:**权限模式永远不会放宽底层守卫**。即使在 YOLO,模型也只能在批准的项目根里写文件,路径守卫、MCP/Agent 作用域、超时、环境过滤、输出上限、进程清理一律不松动。

## 路径守卫与可写根

模型可见的文件工具受硬性约束:

- 路径**只能项目内相对**;绝对路径、`..` 上跳、符号链接穿越一律拒绝。
- 写操作只允许落在这些根下:`source_materials/`、`workspace/`、`novels/`、`reports/`、`test_runs/`,以及暂存根 `tmp/`。
  - `source_materials/` 存放导入、研究或模型生成的素材;最终产物落在其余四个根。
  - `tmp/` 是项目相对的暂存根(`<项目>/tmp/`,不是操作系统 `/tmp`),用于草稿和中间工作;它受同样的路径守卫与权限模式约束,其改动可写入但不纳入回合级文件检查点/回退,因此暂存区编辑不可回退。跨 `tmp/` 边界的移动在回退时不可完全逆转:从 `tmp/` 移入内容根的文件会被删除且无法恢复;从内容根移入 `tmp/` 的文件会还原到原位,而 `tmp/` 中的副本仍保留。若可能回退,请用 `copy_file` 提升暂存内容。它不会进入制品列表、`/validate`、`/init`、Stage 输入或自动发布。宿主不会自动创建或清空 `tmp/`;需要清理时请显式删除文件。
- Host 侧栏的制品列表只索引 `workspace/`、`novels/`、`reports/`、`test_runs/`(不含 `source_materials/`,也不含 `tmp/`)。
- 进程工具是显式例外:`shell_exec` 和 Skill 自带脚本可能拥有宿主用户权限,其进程内文件操作不走模型文件工具的路径守卫。二者的调用面不同:`shell_exec` 接受模型生成的自由命令并需单独开启;`run_skill_script` 只能选择已激活 Skill 中的固定脚本并传结构化参数。

> 校验器(角色卡 / 情景卡等)是**建议性**信号:它指出结构问题,但不会强行中断你的回合。

## permissions.yaml

可选文件,与 `providers.yaml` 同目录(也可用 `VESICLE_PERMISSIONS_FILE` 指定)。从 [`docs/examples/permissions.yaml`](../../../examples/permissions.yaml) 起步:

```yaml
version: 1              # 必填,必须为 1
defaultMode: MOMENTUM   # MANUAL / INERTIA / MOMENTUM;不可填 YOLO
shellExec: false        # 是否启用 shell_exec 工具
shellInterpreter: auto  # auto / posix-sh / powershell-7 / windows-powershell-5.1 / cmd / git-bash
```

未提供此文件时,默认为 `MOMENTUM` + `shellExec: false` + `shellInterpreter: auto`。`defaultMode: YOLO` 会被拒绝——YOLO 只能交互式开启或用进程级开关。

## shell_exec:需要单独打开的宿主命令

`shell_exec` 让模型在你机器上跑 shell 命令。它的性质和文件工具完全不同:

- **不是沙箱**。已批准的命令有你的用户权限,能读写项目之外的文件、能联网。
- 默认**关闭**;要在 `permissions.yaml` 里 `shellExec: true` 才出现在工具面。
- 打开后,在 MANUAL/INERTIA/MOMENTUM 下**每次调用仍要你批准**;只有 YOLO 不问。
- 子进程环境被过滤、输出/寿命有上限、进程组会被清理——但这些不改变"已批准命令拥有宿主权限"这一事实。
- shell 改动的文件**不在**回退检查点账本里,不保证能回退。

`shellInterpreter`:`auto` 在 Linux/WSL 是 `/bin/sh`,Windows 优先 PowerShell 7 并只在 PowerShell 家族内兜底;显式选 `posix-sh`/`cmd`/`git-bash` 等不会跨 shell 家族静默切换。

> 完整的 Process Runtime(后台任务、解释器档案全集、进程树清理、计划绑定)见 [高级:宿主 Shell](../advanced/shell-exec.md)。

## Skill 脚本:不依赖 Shell 开关的结构化执行

`run_skill_script` 只能执行已激活 Skill 的 `scripts/` 资源,脚本路径受 Skill 虚拟根守卫,并会在执行前重新校验 catalog 绑定的资源哈希;参数以结构化 argv 传递,不经过 Shell 插值。它不受 `permissions.yaml` 的 `shellExec` 或 `shellInterpreter` 控制;运行时按扩展名解析 `sh`、Python、Node、Bun 或 PowerShell 等所需解释器,缺少解释器或资源发生漂移时明确失败。

- MANUAL / INERTIA:每次执行前询问。
- MOMENTUM / YOLO:按当前模式自动放行。
- 环境过滤、超时、输出上限、取消和进程树清理始终生效。
- 脚本仍可能以宿主用户权限访问项目外文件或网络;它造成的文件改动会使检查点完整性变为 tainted,不保证可由 `/rewind` 恢复。

这不会为 Skill 增加权限:工具面、当前权限模式和 Process Runtime 仍由 Vesicle Host 决定。它只是把“选择一个可检查的 Skill 脚本”与“执行模型生成的自由 Shell 命令”分成两个权限类别。

## 进程级跳过确认

只想对**这一次运行**全程不打断(危险):

```bash
vesicle --dangerously-skip-permissions .
```

它只对本进程启用 YOLO,退出即失效,期间一直显示危险指示。这比把 YOLO 存成默认安全得多。

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
- 写操作只允许落在这些根下:`source_materials/`、`workspace/`、`novels/`、`reports/`、`test_runs/`。
  - `source_materials/` 存放导入、研究或模型生成的素材;最终产物落在其余四个根。
- 制品工作台侧栏只索引 `workspace/`、`novels/`、`reports/`、`test_runs/`(不含 `source_materials/`)。
- `shell_exec` 是**唯一**的显式例外:它有宿主用户权限,刻意不走路径守卫(见下)。

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

## 进程级跳过确认

只想对**这一次运行**全程不打断(危险):

```bash
vesicle --dangerously-skip-permissions .
```

它只对本进程启用 YOLO,退出即失效,期间一直显示危险指示。这比把 YOLO 存成默认安全得多。

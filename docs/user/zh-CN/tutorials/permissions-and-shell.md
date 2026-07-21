# 权限与宿主 Shell

[English](../../en/tutorials/permissions-and-shell.md) | 简体中文

模型在帮你干活时会调用工具(读写文件、搜索等)。**权限模式**决定这些工具调用要不要先问你。这篇讲清四档模式,以及那个需要单独打开的宿主 Shell。

## 四档权限模式

```
/permissions
```

查看当前模式;`/permissions MOMENTUM` 切换。四档:

| 模式 | 行为 |
|---|---|
| **MOMENTUM**(默认) | 读取类工具自动放行,常规的写操作也自动放行——**只有 `shell_exec` 会问**。日常创作用这档。 |
| **INERTIA** | 读取自动放行,**改动类操作每次都问**。想对每一次写文件都点头的人用这档。 |
| **MANUAL** | **每一个**模型可见的工具调用都问。最谨慎。 |
| **YOLO** | 全部自动放行。**不能存为默认**,只能当次会话开;`/permissions YOLO` 需要两次红色确认。 |

> 权限模式只改变"要不要问你"这道摩擦,**不会**放宽路径守卫、工具能力或进程清理。换句话说,即使在 YOLO,模型也只能在批准的项目根目录里写文件,守卫不松动。

## 宿主 Shell:需要单独打开的能力

`shell_exec` 是一个**宿主命令**工具,让模型在你机器上跑 shell 命令。它和普通文件工具性质不同:

- 它有**你的用户权限**,能读写项目之外的文件、能联网——**不是沙箱**。
- 默认**关闭**。要打开,在用户级配置里加一份 `permissions.yaml`(与 `providers.yaml` 同目录),把 `shellExec` 设为 `true`:

```yaml
version: 1
defaultMode: MOMENTUM
shellExec: true
shellInterpreter: auto
```

  样例见仓库的 [`docs/examples/permissions.yaml`](../../../examples/permissions.yaml)。

- 打开之后,在 MANUAL/INERTIA/MOMENTUM 下**每一次** shell 调用仍会找你确认;只有 YOLO 才不问。
- `shellInterpreter` 选 shell:`auto`(Linux/WSL 是 `/bin/sh`,Windows 优先 PowerShell 7)、`posix-sh`、`powershell-7`、`windows-powershell-5.1`、`cmd`、`git-bash`。

> shell 改动的文件**不保证**能被回退(回退只覆盖 Vesicle 自有工具的改动,见 [会话恢复与回退](./sessions-and-rewind.md))。

## 一次性跳过确认(危险)

偶尔想整段不打断,可以只对**这一次进程**开 YOLO,退出即失效:

```bash
vesicle --dangerously-skip-permissions .
```

界面会一直显示危险指示。这比把 YOLO 存成默认安全得多——默认值仍是你配置里的 MOMENTUM/INERTIA/MANUAL。

## 检查点

- [ ] 你用 `/permissions` 查看过当前模式,并能说清 MOMENTUM 和 INERTIA 的区别。
- [ ] 你知道 `shell_exec` 默认关闭、需要 `permissions.yaml` 打开,且它不是沙箱。
- [ ] 你知道 `--dangerously-skip-permissions` 是进程级、退出即失效。

到这里五篇教程就完成了。需要命令速查、完整配置项、安全模型、故障排查时,去[参考区](../reference/README.md)。

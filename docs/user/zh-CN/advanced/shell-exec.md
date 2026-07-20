# 宿主 Shell 与 Process Runtime

[English](../../en/advanced/shell-exec.md) | 简体中文

> **状态(截至 `1.0.0-alpha.2`):** 🟢 已实现。这是一个拥有宿主用户权限的**非沙箱**能力,默认关闭。成熟度以 [`STATUS.md`](../../../../STATUS.md) 为准。
>
> 基础用法(四档权限、`permissions.yaml` 的 `shellExec` 开关、路径守卫)见 [权限与安全模型](../reference/permissions-and-security.md);本页是操作者深潜。

## 它究竟是什么

`shell_exec` 让模型在你机器上跑**一条**非交互式 shell 命令,工作目录是项目根。工具描述里写明:它**可以访问项目外的文件、可以联网**,权限是你的宿主用户。每次调用都受当前权限模式约束——MANUAL/INERTIA/MOMENTUM 下逐次批准,只有 YOLO 不问。

打开方式:`permissions.yaml` 里 `shellExec: true`(见参考)。打开后该工具才出现在模型工具面。

## 前台 vs 后台

- **前台**(默认):阻塞当前回合,跑完返回 stdout/stderr、退出码、耗时。
- **后台**(`runInBackground: true`):立即返回一个任务 id(形如 `shell-N`),不阻塞。进度和完成在 TUI 可见,**完成时在下一回合自动通知对话,无需轮询**;输出持久化在项目的 `.vesicle/processes/`。

后台任务用两个工具操控:

- `shell_output <taskId>` —— 读当前输出与状态;可加 `wait` 等它完成。
- `shell_stop <taskId>` —— 停掉它。

> 重启恢复:Vesicle 重启时,仍在跑的后台任务被**恢复为 interrupted(不重放)**——不会替你把进行中的命令再跑一遍。

## 输出与超时

- 默认超时 120 秒,最长 600 秒(`timeoutMs` 取值 1–600000)。
- 每条流(stdout/stderr)最多捕获 256 KiB,超出截断并标注,另保留 8 KiB 尾部预览。
- PowerShell/CMD 的输出归一化到 UTF-8(PowerShell 强制 UTF-8 输出编码;CMD 用 `chcp 65001`)。

## 解释器档案

`permissions.yaml` 的 `shellInterpreter` 决定用哪个 shell:

| 档案 | 平台 | 说明 |
|---|---|---|
| `auto` | Linux/WSL | `/bin/sh` |
| `auto` | Windows | 优先 PowerShell 7,只在 PowerShell 家族内降级到 5.1 |
| `posix-sh` | Linux/WSL | `/bin/sh` |
| `powershell-7` | Windows | pwsh;`&&`/`||` 可用 |
| `windows-powershell-5.1` | Windows | 5.1;**不可**用 `&&`/`||`,改用 `cmd1; if ($?) { cmd2 }` |
| `cmd` | Windows | `%NAME%` 取环境变量 |
| `git-bash` | Windows | Git for Windows 的 bash,不加载用户 profile |

**fail-closed**:在平台上选了不可用的档案(例如 Linux 上选 `cmd`、Windows 上选 `posix-sh`),**不会静默换 shell**,而是把 `shell_exec` 从有效工具面移除(`shell_output`/`shell_stop` 仍可用以管控已有任务)。解析后的解释器路径与运行时策略会被**绑进已批准的计划**,TUI 里能看到当前用的是哪个 shell。

> 计划绑定:批准一条命令后,若实际执行的命令与批准时的计划哈希不一致,Vesicle 拒绝执行。这是防止批准后被偷换命令。

## 进程清理,以及"非沙箱"的精确含义

- 命令结束(正常退出、超时、取消)时,Vesicle 终止受管进程树:Windows 用 `taskkill /T /F`,POSIX 先向进程组发 SIGTERM、250ms 宽限后 SIGKILL。即便 shell 早早退出却留下后台后代,原始进程树也会被清理。
- **但这不是沙箱。** 一个被批准的命令仍可用平台手段(新会话、外部服务管理器等)在受管树之外创建工作。子进程环境被过滤成白名单(`PATH`/`HOME`/`USERPROFILE`/`TEMP`/`LANG`/`TERM` 等),输出和寿命有界,进程组会被清理——这些都不改变"已批准命令拥有宿主权限"这一事实。

## 与回退的关系

shell 改动的文件**不进** Vesicle 的回退检查点账本(回退只覆盖 Vesicle 自有工具的改动)。也就是说 shell 造成的文件变化不保证能 `/rewind`。见[会话与回退](../tutorials/sessions-and-rewind.md)。

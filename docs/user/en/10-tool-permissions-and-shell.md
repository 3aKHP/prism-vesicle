# 10 — Tool Permissions and the Host Shell

[← Previous: A complete ETL workflow](./09-complete-etl-workflow.md) | [Manual index](./README.md) | [简体中文](../zh-CN/10-tool-permissions-and-shell.md)

## What You Will Learn

Vesicle separates tool availability, approval behavior, and hard runtime guards. Permission modes decide whether an effective model-visible tool pauses for approval; they never add a tool to an Engine, bypass guarded filesystem roots, widen MCP scope, or disable process limits.

## The Four Modes

| Mode | Observation tools | Mutation, MCP, and Agent control | `shell_exec` |
|---|---|---|---|
| MANUAL | Ask | Ask | Ask |
| INERTIA | Allow | Ask | Ask |
| MOMENTUM | Allow | Allow | Ask |
| YOLO | Allow | Allow | Allow |

MOMENTUM is the normal default. Every MCP tool is treated as mutation-capable even when its server describes it as read-only. Workflow gates, engine handoffs, and user questions are already interactive and do not receive a second permission prompt.

Inspect or change the current mode with:

```text
/permissions
/permissions INERTIA
```

YOLO requires two red confirmations and applies only to the current process. A resumed session that previously used YOLO returns to MOMENTUM.

## Enable `shell_exec`

Copy the example into the Vesicle user configuration directory and change `shellExec` to `true`:

```powershell
$configDir = Join-Path $env:APPDATA "prism-vesicle"
Copy-Item "docs\examples\permissions.yaml" (Join-Path $configDir "permissions.yaml")
notepad (Join-Path $configDir "permissions.yaml")
```

`shellInterpreter` selects one host-owned command profile:

| Value | Availability and behavior |
|---|---|
| `auto` | Linux/WSL uses `/bin/sh`. Windows prefers PowerShell 7 and falls back only to Windows PowerShell 5.1. |
| `posix-sh` | Explicit `/bin/sh` on Linux/WSL; unavailable on Windows. |
| `powershell-7` | Explicit PowerShell 7 on Windows; does not fall back when missing. |
| `windows-powershell-5.1` | Explicit Windows PowerShell 5.1. |
| `cmd` | Explicit Windows Command Prompt with registry AutoRun disabled. |
| `git-bash` | Explicit Git for Windows Bash without user profiles. |

Profiles never silently fall back across command dialects. If an explicit profile is unavailable on the current platform, `shell_exec` is removed from the effective model tool surface and `vesicle doctor` reports the unavailable selection. When the capability remains enabled, `shell_output` and `shell_stop` stay available so an already-running task can still be observed or terminated. The dangerous startup override enables the capability but still respects `shellInterpreter`.

The selected shell is non-interactive, starts in the project root, receives a filtered environment, separates and bounds stdout/stderr, and has a wall-clock timeout. Vesicle requests UTF-8 process output, tells the model which command dialect is active, and shows the resolved interpreter before approval and in process cards. Foreground commands show bounded live tail output and elapsed time in their TUI card.

For a long command whose result is not needed immediately, the model can set `runInBackground: true`. Vesicle returns a short id such as `shell-1`, keeps its progress visible in the command card, header, and Workspace sidebar, persists bounded output/status under `.vesicle/processes/`, and delivers completion to the next provider turn without routine polling. `shell_output` reads current or completed output and `shell_stop` cancels a running task. Managed background processes are marked interrupted rather than replayed after a Vesicle restart.

Permission is consent, not containment. An approved shell command can access project-external files and the network with your host-user authority. Shell-created file changes are not guaranteed to rewind.

## Dangerous Startup Override

Experienced users can start Vesicle with:

```powershell
vesicle --dangerously-skip-permissions
```

This enables YOLO and `shell_exec` for that process without the two TUI confirmations. Vesicle keeps a red `YOLO · CLI OVERRIDE` indicator visible. The flag does not disable path guards, MCP/Agent scopes, argument validation, timeouts, environment filtering, output limits, process-tree cleanup, or concurrency controls.

Use this flag only when you understand and accept every tool available to the active Engine and configured MCP servers.

[Next: return to the manual index →](./README.md)

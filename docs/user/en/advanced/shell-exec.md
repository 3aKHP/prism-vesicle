# Host shell and Process Runtime

English | [简体中文](../../zh-CN/advanced/shell-exec.md)

> **Status (as of `1.0.0-alpha.2`):** 🟢 Implemented. This is a **non-sandboxed** capability with host-user authority, off by default. Maturity per [`STATUS.md`](../../../../STATUS.md).
>
> The basics (four permission modes, the `shellExec` switch in `permissions.yaml`, path guards) are in [Permissions and security model](../reference/permissions-and-security.md); this page is the operator deep dive.

## What it actually is

`shell_exec` lets the model run **one** non-interactive shell command on your machine, with the project root as the working directory. Its tool description states plainly: it **can access files outside the project and the network**, with your host user's authority. Every call is subject to the active permission mode — under MANUAL/INERTIA/MOMENTUM each call is approved individually; only YOLO skips the ask.

Enable it with `shellExec: true` in `permissions.yaml` (see the reference). The tool only appears in the model's tool surface once enabled.

## Foreground vs background

- **Foreground** (default): blocks the current turn and returns stdout/stderr, exit code, and duration when done.
- **Background** (`runInBackground: true`): returns a task id immediately (like `shell-N`) without blocking. Progress and completion are visible in the TUI, and **completion is reported to the conversation on the next turn automatically — no polling**. Output is persisted under the project's `.vesicle/processes/`.

Two tools control background tasks:

- `shell_output <taskId>` — read current output and status; add `wait` to wait for completion.
- `shell_stop <taskId>` — stop it.

> Restart recovery: when Vesicle restarts, a background task still running is **recovered as interrupted (not replayed)** — it does not re-run an in-flight command for you.

## Output and timeout

- Default timeout 120 seconds, maximum 600 seconds (`timeoutMs` 1–600000).
- Each stream (stdout/stderr) is captured up to 256 KiB; excess is truncated and flagged, with an 8 KiB tail preview kept.
- PowerShell/CMD output is normalized to UTF-8 (PowerShell forces UTF-8 output encoding; CMD uses `chcp 65001`).

## Interpreter profiles

`shellInterpreter` in `permissions.yaml` decides which shell is used:

| Profile | Platform | Notes |
|---|---|---|
| `auto` | Linux/WSL | `/bin/sh` |
| `auto` | Windows | Prefers PowerShell 7, falls back only within the PowerShell family to 5.1 |
| `posix-sh` | Linux/WSL | `/bin/sh` |
| `powershell-7` | Windows | pwsh; `&&`/`||` available |
| `windows-powershell-5.1` | Windows | 5.1; `&&`/`||` **not** available — use `cmd1; if ($?) { cmd2 }` |
| `cmd` | Windows | `%NAME%` for environment variables |
| `git-bash` | Windows | Git for Windows bash; user profiles not loaded |

**Fail-closed:** selecting a profile unavailable on the platform (e.g. `cmd` on Linux, `posix-sh` on Windows) **does not silently switch shells** — `shell_exec` is removed from the effective tool surface (`shell_output`/`shell_stop` remain available to manage existing tasks). The resolved interpreter path and runtime policy are **bound into the approved plan**, and the TUI shows which shell is active.

> Plan binding: after a command is approved, if the command actually executed does not match the approved plan's hash, Vesicle refuses to run it. This prevents a bait-and-switch after approval.

## Process cleanup, and the precise meaning of "not a sandbox"

- When a command ends (normal exit, timeout, cancellation), Vesicle terminates the managed process tree: `taskkill /T /F` on Windows, SIGTERM to the process group on POSIX followed by SIGKILL after a 250ms grace period. Even if the shell exits early but leaves background descendants, the original process tree is cleaned up.
- **But this is not a sandbox.** An approved command can still use platform facilities (a new session, an external service manager, etc.) to create work outside the managed tree. The child environment is filtered to a whitelist (`PATH`/`HOME`/`USERPROFILE`/`TEMP`/`LANG`/`TERM`, etc.), output and lifetime are bounded, and the process group is cleaned up — none of that changes the fact that an approved command has host authority.

## Relationship to rewind

Files changed by shell are **not** in Vesicle's rewind checkpoint ledger (rewind covers only changes made by Vesicle's own tools). In other words, shell-caused file changes are not guaranteed to `/rewind`. See [Sessions and rewind](../tutorials/sessions-and-rewind.md).

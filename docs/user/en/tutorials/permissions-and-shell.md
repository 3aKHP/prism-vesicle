# Permissions and the host shell

English | [简体中文](../../zh-CN/tutorials/permissions-and-shell.md)

As the model works for you it calls tools (read/write files, search, and so on). The **permission mode** decides whether those tool calls ask you first. This page covers the four modes and the host shell that needs a separate opt-in.

## The four permission modes

```
/permissions
```

shows the current mode; `/permissions MOMENTUM` switches. The four modes:

| Mode | Behavior |
|---|---|
| **MOMENTUM** (default) | Read tools auto-allow, ordinary writes auto-allow — **only `shell_exec` asks**. Use this for everyday work. |
| **INERTIA** | Reads auto-allow, **every change asks first**. For those who want to approve every write. |
| **MANUAL** | **Every** model-visible tool call asks. Most cautious. |
| **YOLO** | Everything auto-allows. **Cannot be saved as a default**, only opened for the current session; `/permissions YOLO` needs two red confirmations. |

> A permission mode only changes the "ask first" friction — it **never** widens path guards, tool capabilities, or process cleanup. In other words, even in YOLO the model can only write inside the approved project roots; the guards do not loosen.

## Host shell: a capability you open separately

`shell_exec` is a **host command** tool that lets the model run shell commands on your machine. It differs in kind from the file tools:

- It has **your user authority**; it can read and write files outside the project and use the network — **it is not a sandbox**.
- It is **off by default**. To enable it, add a `permissions.yaml` in the user-level config (beside `providers.yaml`) with `shellExec: true`:

```yaml
version: 1
defaultMode: MOMENTUM
shellExec: true
shellInterpreter: auto
```

  See [`docs/examples/permissions.yaml`](../../../examples/permissions.yaml).

- Once enabled, under MANUAL/INERTIA/MOMENTUM **every** shell call still asks for approval; only YOLO skips the ask.
- `shellInterpreter` picks the shell: `auto` (`/bin/sh` on Linux/WSL, PowerShell 7 preferred on Windows), `posix-sh`, `powershell-7`, `windows-powershell-5.1`, `cmd`, `git-bash`.

> Files changed by shell are **not guaranteed** to rewind (rewind covers only Vesicle's own tool changes; see [Sessions and rewind](./sessions-and-rewind.md)).

## Skip approval for one run (dangerous)

Occasionally you want a whole stretch without interruption. You can enable YOLO for **this one process** only; it expires on exit:

```bash
vesicle --dangerously-skip-permissions .
```

The danger indicator stays visible. This is much safer than persisting YOLO as a default — your default stays at whatever you configured (MOMENTUM/INERTIA/MANUAL).

## Checklist

- [ ] You checked the current mode with `/permissions` and can explain the difference between MOMENTUM and INERTIA.
- [ ] You know `shell_exec` is off by default, needs `permissions.yaml` to enable, and is not a sandbox.
- [ ] You know `--dangerously-skip-permissions` is process-scoped and expires on exit.

That completes the five tutorials. For a command cheatsheet, full configuration, the security model, and troubleshooting, go to the [reference section](../reference/README.md).

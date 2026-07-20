# Permissions and security model

English | [简体中文](../../zh-CN/reference/permissions-and-security.md)

This page covers Vesicle's tool-approval mechanism and the underlying guards. The tutorial [Permissions and shell](../tutorials/permissions-and-shell.md) is the introduction; this is the full reference.

## The four permission modes

`/permissions` shows the current mode; `/permissions <MODE>` switches. A mode only changes the "ask before a tool call" friction.

| Mode | Behavior |
|---|---|
| **MOMENTUM** (default) | Reads auto-allow, ordinary writes auto-allow — **only `shell_exec` asks** |
| **INERTIA** | Reads auto-allow, **every change asks first** |
| **MANUAL** | **Every** model-visible tool call asks |
| **YOLO** | Everything auto-allows; **cannot be saved as a default**, only opened for the current session |

The key invariant: **a permission mode never widens the underlying guards.** Even in YOLO the model can only write inside the approved project roots; path guards, MCP/Agent scope, timeout, environment filtering, output limits, and process cleanup all stay in force.

## Path guards and writable roots

The model-visible file tools are hard-constrained:

- Paths are **project-relative only**; absolute paths, `..` escapes, and symbolic-link traversal are rejected.
- Writes are allowed only under these roots: `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`.
  - `source_materials/` holds imported, researched, or model-generated source material; final artifacts go under the other four roots.
- The artifact workbench sidebar indexes only `workspace/`, `novels/`, `reports/`, `test_runs/` (not `source_materials/`).
- `shell_exec` is the **one** explicit exception: it has host-user authority and intentionally bypasses path guards (see below).

> Validators (character card / scenario card, and so on) are **advisory** signals: they report structural problems but never forcibly abort your turn.

## permissions.yaml

An optional file beside `providers.yaml` (or set via `VESICLE_PERMISSIONS_FILE`). Start from [`docs/examples/permissions.yaml`](../../../examples/permissions.yaml):

```yaml
version: 1              # required, must be 1
defaultMode: MOMENTUM   # MANUAL / INERTIA / MOMENTUM; not YOLO
shellExec: false        # whether the shell_exec tool is enabled
shellInterpreter: auto  # auto / posix-sh / powershell-7 / windows-powershell-5.1 / cmd / git-bash
```

Without this file, the defaults are `MOMENTUM` + `shellExec: false` + `shellInterpreter: auto`. `defaultMode: YOLO` is rejected — YOLO is interactive-only or set with the process-level switch.

## shell_exec: a host command you open separately

`shell_exec` lets the model run shell commands on your machine. It is fundamentally different from the file tools:

- **It is not a sandbox.** An approved command has your user authority; it can read and write files outside the project and use the network.
- It is **off by default**; it only appears in the tool surface when `permissions.yaml` sets `shellExec: true`.
- Once enabled, under MANUAL/INERTIA/MOMENTUM **each call still asks for approval**; only YOLO skips it.
- The child environment is filtered, output and lifetime are bounded, and the process group is cleaned up — but none of that changes the fact that an approved command has host authority.
- Files changed by shell are **not** in the rewind checkpoint ledger and are not guaranteed to rewind.

`shellInterpreter`: `auto` is `/bin/sh` on Linux/WSL and prefers PowerShell 7 on Windows, falling back only within the PowerShell family; an explicit `posix-sh`/`cmd`/`git-bash` choice never silently switches shell families.

## Process-level approval skip

To skip approval for **this one run** only (dangerous):

```bash
vesicle --dangerously-skip-permissions .
```

It enables YOLO for that process only, expires on exit, and keeps the danger indicator visible. It is much safer than persisting YOLO as a default.

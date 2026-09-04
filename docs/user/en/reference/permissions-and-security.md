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
- Reads additionally reach the resolver-backed `assets/` namespace and, for Skills activated in the session, the read-only `skills/` mount: `skills/<name>/...` resolves inside that Skill's virtual root with the same hardening and 256 KiB text cap as `read_skill_resource`. The mount is strictly read-only — every write, move, copy target, and delete under `skills/` is rejected.
- Writes are allowed only under these roots: `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`, and the scratch root `tmp/`.
  - `source_materials/` holds imported, researched, or model-generated source material; final artifacts go under the other four roots.
  - `tmp/` is the project-relative scratch root (`<project>/tmp/`, never the operating-system `/tmp`) for drafts and intermediate work. It is governed by the same path guards and permission modes; its changes are writable but not included in per-turn file checkpoints or rewind, so scratch edits are not rewind-safe. A move across the `tmp/` boundary is not fully reversible on rewind: a file moved out of `tmp/` into a content root is deleted and not recovered; a file moved into `tmp/` is restored to its origin while the scratch copy remains. Use `copy_file` to promote scratch work if you may rewind. It never enters the artifact list, `/validate`, `/init`, Stage input discovery, or automatic publication. The host creates any missing writable roots, `tmp/` included, when a new session starts (resuming a session does not recreate roots you deleted), and it never auto-empties `tmp/`; delete files explicitly when you want to clean up.
- The Host sidebar's artifact list indexes only `workspace/`, `novels/`, `reports/`, `test_runs/` (not `source_materials/`, and not `tmp/`).
- Deletion and relocation go through the same guards: `delete_file` removes files only, `delete_directory` removes empty directories only (never a fixed writable root), and `move_directory` never overwrites an existing target; `move_file` overwrites only when its `overwrite` argument is `true` (default `false`). All four are mutate-class tools, so INERTIA and MANUAL modes ask before they run.
- Process tools are explicit exceptions: `shell_exec` and bundled Skill scripts may have host-user authority, and filesystem work inside those processes does not use the model file-tool guards. Their invocation surfaces differ: `shell_exec` accepts a model-authored free-form command and must be enabled separately; `run_skill_script` can only select a fixed script from an activated Skill and pass structured arguments.

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
- While a call waits for approval, the transcript keeps a `Permission pending` line with a bounded one-line summary of the command; after approval, the run renders as the standard `●` command card paired with its result row.
- The child environment is filtered, output and lifetime are bounded, and the process group is cleaned up — but none of that changes the fact that an approved command has host authority.
- Files changed by shell are **not** in the rewind checkpoint ledger and are not guaranteed to rewind.

`shellInterpreter`: `auto` is `/bin/sh` on Linux/WSL and prefers PowerShell 7 on Windows, falling back only within the PowerShell family; an explicit `posix-sh`/`cmd`/`git-bash` choice never silently switches shell families.

> The full Process Runtime (background tasks, the complete interpreter-profile set, process-tree cleanup, plan binding) is in [Advanced: host shell](../advanced/shell-exec.md).

## Skill scripts: structured execution without the Shell switch

`run_skill_script` can only execute a `scripts/` resource from an activated Skill. The script path is guarded inside the Skill virtual root, its catalog-pinned content hash is rechecked immediately before execution, arguments are passed as structured argv, and no shell interpolation occurs. It is not controlled by `permissions.yaml`'s `shellExec` or `shellInterpreter`; the runtime resolves the required `sh`, Python, Node, Bun, or PowerShell interpreter from the file extension and fails clearly when it is unavailable or the resource has changed.

- MANUAL / INERTIA ask before each execution.
- MOMENTUM / YOLO auto-allow according to the active mode.
- Environment filtering, timeout, output limits, cancellation, and process-tree cleanup always remain active.
- A script may still access project-external files or the network with host-user authority; its file changes taint checkpoint completeness and are not guaranteed to rewind.

This does not grant a Skill new authority: Vesicle Host still owns the effective tool surface, active permission mode, and Process Runtime. It only separates “run this inspectable Skill script” from “run a model-authored free-form shell command” as two permission classes.

## Process-level approval skip

To skip approval for **this one run** only (dangerous):

```bash
vesicle --dangerously-skip-permissions .
```

It enables YOLO for that process only, expires on exit, and keeps the danger indicator visible. It is much safer than persisting YOLO as a default.

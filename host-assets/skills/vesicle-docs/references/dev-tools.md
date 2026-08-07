<!-- Generated from docs/dev/TOOLS.md — do not edit. -->

# Tool And Interaction Runtime Contract

This document defines the capability boundary for model-visible tools, external MCP tools, process execution, and host interactions initiated through tool calls.

## Filesystem Tools

- Model-visible filesystem paths are project-relative. Absolute paths and traversal outside the project root are rejected.
- Existing path components must not be symbolic links or linked directory junctions. Mutations of missing targets validate the nearest existing ancestor.
- Read, list, stat, and grep operations are limited to `assets/`, `source_materials/`, `workspace/`, `test_runs/`, `novels/`, `reports/`, and the scratch root `tmp/`.
- File and directory mutations are limited to `source_materials/`, `workspace/`, `test_runs/`, `novels/`, `reports/`, and the scratch root `tmp/`.
- The canonical root taxonomy lives in `core/project/roots.ts`: `sourceRoots`, `artifactRoots`, and `scratchRoots` (`tmp/`) are distinct categories, and `projectContentRoots` / `modelWritableRoots` derive from them. `source_materials/` is writable research input but not a final artifact root.
- `tmp/` is model-visible scratch state: writable through the ordinary guarded tools, retained across turns and restarts, and never auto-cleaned by the host. It is excluded from Artifact Workbench, `/artifact`, `/validate`, `/init` scanning, Stage input discovery and source-drift checks, and Output Quality Guard artifact targets, so scratch drafts never enter final-artifact validation or rewrite lifecycles.
- `read_file` is UTF-8 text-only. `view_image` uses the same readable-root guard, validates image type and size, and emits a structured attachment rather than base64 tool text.
- `delete_file` deletes files only. `delete_directory` deletes empty directories only, and fixed writable roots (including the `tmp` root itself) cannot be created, moved, or deleted.
- Directory listing exposes symbolic-link entries without following them. Recursive operations and outputs remain bounded.
- Regex grep is accepted only for the current trusted single-user model-input boundary. Exposure to untrusted plugin input requires a bounded regex engine or worker isolation.
- A model must not claim that a file mutation succeeded unless the corresponding tool result reports success.

## Mutation Records And Checkpoints

- Successful filesystem operations persist structured `FileToolEvent` metadata rather than requiring callers to parse result prose.
- File-event byte counts describe the resulting or observed file size; deletion records the deleted size, append may also report delta bytes, and query tools report their bounded entry or match counts.
- Successful create, write, replace, and append operations record the SHA-256 of the complete resulting file.
- Mutation tools capture every affected writable path before changing it so the owning user turn can restore guarded file state through its checkpoint. Guarded mutations under `tmp/` participate in the same per-turn checkpoint and rewind lifecycle as the durable roots; scratch state is never auto-cleaned by the host.
- The opt-in `shell_exec` tool is outside guarded file-tool authority. Shell mutations taint checkpoint completeness and must never be described as rewind-safe.

## Permission Runtime

- Permission modes change approval friction and never widen the effective tool surface or bypass runtime guards.
- MANUAL asks for every model-visible execution, INERTIA auto-allows observation tools, MOMENTUM auto-allows every effective tool except `shell_exec`, and YOLO auto-allows all effective tools.
- Unknown tools fail closed into the mutate class. Every returned call is checked against the active effective tool surface before permission evaluation or execution.
- MCP tools are classified as mutate regardless of their remote names, descriptions, or schemas.
- Permission requests bind to the originating session and tool call. Shell approval additionally binds to the exact normalized execution-plan hash.
- Child tool calls route through the parent-owned permission broker. A foreground or background child pauses at its call boundary until the parent resolves the request; absence of an interactive broker fails closed.
- Rejection returns a failed tool result and does not create a synthetic user turn.
- YOLO cannot be persisted as a default. Interactive activation requires explicit high-risk confirmation, resume downgrades a prior YOLO session to MOMENTUM, and `--dangerously-skip-permissions` applies only to the current process.
- Permission bypass never disables path guards, MCP or Agent scope, argument validation, output bounds, timeouts, environment filtering, process cleanup, or concurrency controls.
- Warning and confirmation behavior follows [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md); subsystems must not add a second trust or approval system for an action already governed here.

## Process Runtime

- `shell_exec` is opt-in through user-level `permissions.yaml` and has host-user filesystem and network authority. It is not an operating-system sandbox.
- Shell interpreters are selected from host-owned profiles rather than model-provided executable paths.
- Resolve the interpreter before approval and bind the profile id, executable path, and runtime-policy version into the approved plan. Do not perform an unapproved cross-profile fallback after approval.
- Foreground processes expose bounded live tail output and elapsed time without allowing observability callbacks to change process lifetime or results.
- Background processes return a short managed task id, persist bounded state under ignored `.vesicle/processes/`, and deliver completion as host-owned context at the next available turn.
- Managed background execution does not survive host restart. Recovery marks stale running records interrupted and never replays their commands.
- Structured-argv Skill script execution (`run_skill_script`) uses the same Process Runtime timeout, output cap, cancellation, and cleanup as `shell_exec` but spawns no shell. Script extension resolution maps `.sh`, `.py`, `.js`/`.mjs`/`.cjs`, `.ts`, and `.ps1` to their interpreters; `.ps1` prefers PowerShell 7 then Windows PowerShell 5.1 on Windows and `pwsh` only elsewhere, executing with `-NoLogo -NoProfile -NonInteractive -File` (never `-Command` or `-ExecutionPolicy Bypass`). The logical interpreter identity (`pwsh`, `powershell-5.1`, `sh`, etc.) appears in model-visible events, never the absolute executable path.
- Skill scripts receive Host-owned self-invocation values (`VESICLE_SELF_EXECUTABLE`, `VESICLE_SELF_ENTRYPOINT`) in their filtered child environment so first-party wrappers can re-invoke the exact Vesicle runtime without PATH assumptions. These are injected into the `run_skill_script` child only; `shell_exec` never receives them, the caller environment cannot override them, and persisted events do not automatically record the absolute values. A process-authorized Skill script can still read and deliberately print its child environment, so these paths are runtime metadata rather than secrets; first-party wrappers must not echo them.

## Gates, Questions, And Engine Handoffs

- `request_confirmation`, `request_engine_switch`, and `ask_user_question` are interaction requests, not permission checks, and remain outside Tool Permission Runtime.
- A workflow gate is available only when the active Engine declares its id in `stopGates`. Undeclared gates return a failed tool result instead of pausing.
- The agent loop returns a durable continuation state to its caller and never calls into TUI rendering. The TUI resolves the interaction and the agent loop persists the tool result before continuation.
- Gate confirmation advances the declared workflow. Rejection completes the tool call under the current Engine and carries feedback or requests clarification.
- An Engine handoff changes future turns only. It must not continue the same tool loop under a different system prompt.
- Manual and model-requested Engine transitions share one host transition shape. Summary transitions compact first; full-context transitions preserve the current context.
- `ask_user_question` presents one model-authored single-select question with bounded options plus host-owned Skip and open-ended fallbacks. Skip and open-ended input are distinct outcomes.
- Resume restores unresolved interactions when their original arguments are available. Noninteractive recovery may synthesize bounded unresolved tool results only to preserve provider tool-call pairing.

## Execution Limits

- Tool-loop protection measures consecutive rounds containing failed tool results rather than raw tool-call count, so legitimate multi-tool work is not stopped merely for being long.
- Tool definitions, arguments, results, concurrent execution, and persisted output remain bounded by their owning runtime contracts.

## Web And MCP Tools

- Tavily web tools are host-executed research tools, not provider adapter features. They persist structured web metadata and do not mutate project files directly.
- MCP configuration is user-level host state. Secret header values expand from the sibling user `.env` and must not be logged or persisted.
- MCP supports dual-era Streamable HTTP: legacy (`initialize`, revisions through `2025-11-25`) and modern (`server/discover`, revision `2026-07-28`). Per-server `negotiation: legacy|modern|auto` controls the connection path; absent defaults to `legacy` with zero wire change. The official `@modelcontextprotocol/client@2` SDK owns wire negotiation behind a thin Vesicle adapter; SDK types do not enter `core/`, providers, or TUI.
- MCP discovery and calls are normalized into ordinary host tool definitions and typed, untrusted results; provider adapters remain unaware of MCP transport, era, and result parsing.
- The effective Engine and server configuration scope MCP availability. Model arguments and permission modes cannot widen that scope.
- MCP text items keep their upstream order. Raw unknown content arrays and `structuredContent` are never JSON-stringified as a provider-visible fallback; the host emits bounded, payload-free diagnostics for unsupported or malformed items.
- The supported multimodal result path is inline `ImageContent` with strict base64, declared MIME, and detected magic bytes that agree. Accepted PNG, JPEG, GIF, and WebP bytes use the existing content-addressed attachment store with `source: "mcp"`; server-provided filenames are ignored. The shared decoded-image ceiling is currently 20 MiB and is an internal, provisional safety policy rather than a configurable product limit.
- A vision-capable selected model receives accepted MCP images through ordinary `ToolResult.images` materialization. A non-vision model keeps safe text plus an omission notice without decoding or persisting the image. An MCP error result never imports media; cancellation, invalid data, a MIME mismatch, an over-budget item, or an attachment-write failure cannot expose the binary payload to model text, session metadata, logs, or a provider request.
- Resource, audio, URL/link, and unknown result items remain explicitly unsupported. Vesicle does not auto-read, download, transcribe, play, inject, or otherwise promote them into a prompt or a wider tool scope.

The current tool inventory belongs in [`STATUS.md`](../../STATUS.md); user-facing shell guidance belongs in the language-mirrored user manual.

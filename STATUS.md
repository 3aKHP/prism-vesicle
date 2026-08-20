# Prism Vesicle Project Status

_Snapshot: 1.0.0-alpha.10 (2026-08-14)._

> This is the authoritative current implementation inventory: capability state, tool surface, validators, verification, and known limits. Behavioral contracts live in [`docs/dev/`](./docs/dev/README.md) and the user manual under [`docs/user/`](./docs/user/); each section below links to the authoritative source rather than duplicating it. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the root-document responsibility split.

## Version & Capabilities

Release candidate: **1.0.0-alpha.10**. The `State` column tracks the candidate's public contract: `released` = included in the 1.0.0-alpha.10 GitHub Release and npm package once the accepted candidate is tagged; `experimental` = shipped for explicit opt-in while real-provider acceptance remains incomplete, or while a passing gate awaits graduation into a released candidate; `deferred` = not included (see [Known Limits & Deferred Work](#known-limits--deferred-work)).

| Subsystem | Capability | State |
|-----------|-----------|-------|
| Assets | Bundled V10 Harness (`prism-engine-v10@10.3.0-alpha.1`, verified 73-file inventory) | experimental |
| Assets | Managed Harness Packs: offline verify/install/pin/use/status/rollback | released |
| Providers | OpenAI-compatible Chat, Anthropic Messages, and Gemini adapters with SSE streaming | released |
| Providers | Explicit Responses profiles: official OpenAI HTTP/SSE/WebSocket + remote compact, and frozen MiMo/DeepSeek HTTP subsets | released |
| Providers | Multi-provider registry with generation defaults and capability/limits metadata | released |
| Providers | Cross-provider usage normalization and de-duplicated TUI footer counters | released |
| Providers | Thinking-effort controls and reasoning-block visibility | released |
| Providers | Optional provider HTTP/WebSocket proxy (`VESICLE_PROVIDER_PROXY`): terminal-env precedence, native Bun CONNECT routing, redacted diagnostics | experimental |
| Context | Portable `/compact` checkpoint (`compact-checkpoint-v1`): atomic replacement history (summary + verbatim retained tail), append-only transcript preserved, projection/resume/rewind exact across the checkpoint | released |
| Context | Opt-in automatic compaction: pre-turn and exact provider-send guards over current history, queued/background input, and tool schemas; provider-observation delta projection; pre-install replacement ceiling validation; soft-trigger continue + hard-ceiling block; truthful `/context`; cancelled lifecycle | released |
| TUI | OpenTUI + Solid responsive shell with host-owned multiline composer | released |
| TUI | Startup splash and empty-session hero derived from the brand ANSI mark; truecolour animation degrades to a static frame on 256-colour terminals and freezes under `VESICLE_REDUCED_MOTION=1` | released |
| TUI | Static motif wiring: per-message role spectrum lanes, per-engine refraction accents, and ASCII-frame sidebar section labels | released |
| TUI | Day/night theme: four-value preference (dark/light/default/auto), terminal-following `default` with dark fallback, time-based `auto` (light 07:00–19:00), `/theme` session override plus `--persist`/`--unset-project` project file, `--dark`/`--light` launch flags, and `VESICLE_THEME` env | released |
| TUI | Two-page shell (Chat / Workspace, `Ctrl+O` and `/workspace`), page-aware header, sidebar renamed to Host | released |
| TUI | Workspace page workbench: file tree (lazy load, hidden-file toggle, refresh), read-only viewer (numbered source, Markdown source/preview, image/binary metadata, metadata-only symlinks, 512 KB / 2000-line bounds), `Ctrl+P` fuzzy quick open, three-region `F6` focus model, a B3 editing kernel (per-file textarea undo, dirty + atomic save / save-as, find / goto / reload, dirty-on-close and overwrite confirms, external-modification detection by mtime + inode identity, 8-buffer LRU pool), B4 file management + in-page validation (`a`/`A`/`m`/`c`/`d` create/rename/copy/delete with recycle-bin trash, ops + delete confirms, buffer rekey on rename; `v` findings panel with anchor-based line jumps, auto-validate on open/save, shared `ARTIFACT_VALIDATOR_NAMES`; path-owned current/stale validation snapshots bound to their focus target, capability-aware mode/action hints, and a width-aware one-line status projection that stays usable at 80 columns), and B5 external-editor handoff (`Ctrl+X` suspends the renderer, opens the file via `$VESICLE_EDITOR` / `settings.yaml` / `$VISUAL` / `$EDITOR` / platform fallback, resumes, reload + revalidate on return; dirty gate); `/workspace [path]` locates and `/artifact` opens in the viewer | released |
| TUI | Shared FIFO for user messages and capability-classified commands, with tool/Loop boundaries, preview, edit recall, and an Escape interrupt that dispatches the captured FIFO head once as a fresh top-level input after interrupted-session rebuild | released |
| TUI | `/btw` side questions: one tool-free question over a frozen context boundary, shown in an ephemeral overlay while the main turn continues | released |
| Instructions | Persistent Instructions: user-authored `VESICLE.md` / `VESICLE.<engine>.md` at the project root and beside `providers.yaml`, auto-loaded into the system prompt each session with user + project scope and Engine-specific replacement | released |
| Instructions | `/init [--force] [notes]`: scan the project and draft a project-scope `VESICLE.md` via a dedicated host prompt (no new Harness); refuses an existing file unless `--force` explicitly backs it up and replaces it | released |
| Instructions | `read_instructions` / `update_instructions` tools (non-Stage Engines): enum-target read/write/delete of Persistent Instructions with optimistic concurrency, atomic write, previous-state backup, and 32 KiB budget validation | released |
| TUI | Clipboard image attachments (`Ctrl+V`, with Alt/Option+V compatibility; vision-gated) | released |
| TUI | Rewind: conversation branches plus per-turn file checkpoints | released |
| TUI | Horizontal candidate branching: Chat-page `Ctrl+R` re-runs the last turn as a switchable candidate (`Option+←/→`); append-only sibling subtrees off the shared user record, selection persisted, on-disk file state switches with the candidate | released |
| TUI | Any-depth candidate tree: `/branch` / `Ctrl+B` browses every fork at every depth (including inactive subtrees) and switches to any candidate after a read-only file-preview confirm; full-manifest file bundles make the disk strictly equal to the selected candidate | experimental |
| TUI | Unified turn-focus cursor: `Alt+↑/↓` navigates every transcript turn-by-turn with wrap-around and highlighting; `Alt+←/→` reports `Ctrl+B`/`Ctrl+R` guidance when no switcher is armed | experimental |
| Tools | Guarded filesystem loop, `request_confirmation` gate, engine handoff, clarifying question | released |
| Tools | Unified `list_directory` query, bounded Project State orientation, and structured missing-path observations | experimental |
| Tools | Tavily web tools (`web_search` / `web_fetch` / `web_map` / `web_crawl` / `web_research`; hidden without `TAVILY_API_KEY`, and `web_search` yields to a session's enabled built-in search) | released |
| Tools | Dual-era Streamable HTTP MCP tools: legacy `initialize` and modern `server/discover` with per-server `auto`/`legacy`/`modern` negotiation | released |
| Tools | Opt-in MCP tool-output persistence (`mcpOutputPersistence` in `.vesicle/preferences.yaml`): every MCP call's text + images saved under `tmp/mcp-output/<sessionId>/` for re-read via existing file tools; optional `mcpOutputAutoTruncate` sub-toggle replaces oversized inline results with a bounded preview + reference; inline default unchanged | experimental |
| Tools | Opt-in `shell_exec` with bounded Process Runtime | released |
| Tools | Structured Skill scripts with independent `skill_exec` permission class (no `shellExec` gate) | released |
| Tools | Tool Permission Runtime (`MANUAL` / `INERTIA` / `MOMENTUM` / `YOLO`) | released |
| Agents | Foreground/background SubAgents with contract-bound Harness delegation | released |
| Stage | First-party consumer RP bootstrap Engine (`/stage`) | released |
| Validators | Module A, Module B v9, runtime packet, and evaluate-report checks | released |
| Workbench | `/artifact` discovery, Workspace-page preview, validation, and revision | released |
| Quality | Output Quality Guard: deterministic findings, document metrics, durable decisions, and experimental Semantic Judge/rewrite-policy loader | released |
| Release | Standalone Windows PE and Linux ELF binaries | released |
| Release | npm/Bun package with a precompiled Solid TUI entry, clean installed production tree, global/local consumer audit, and behavioral Linux PTY startup gate | released |
| Release | Guided per-user Windows installer (Inno Setup + `vesicle setup`) | released |
| Release | Reusable Linux/Windows release build with tag-triggered publication | released |

## Scope

The 1.0 alpha makes Vesicle a credible direct API host for the Prism Engine, not just a chat wrapper: it loads Prism engine profiles, drives their system prompt, tool surface, validators, and stop gates at runtime, and runs a terminal UI for the resulting gated workflow.

Public user-facing documentation is intentionally limited during the alpha. Treat the [`docs/user/`](./docs/user/) manual, the [README](./README.md) installation and first-run guide, `vesicle doctor`, `vesicle prompt shape --engine <id>`, and [`docs/examples/`](./docs/examples/) as the supported onboarding references; other behavior is subject to alpha-level change while feature and fix work remains the priority.

Architecture and runtime contracts are routed from [`docs/dev/ARCHITECTURE.md`](./docs/dev/ARCHITECTURE.md) to their authoritative domain documents. Source-code conventions live separately in [`docs/dev/STYLE.md`](./docs/dev/STYLE.md). This file intentionally records current implementation state and limits rather than duplicating those contracts.

The Prism asset lineage comes from the public sibling repository [`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology).

## Repository Structure

```text
prism-vesicle/
├── src/
│   ├── cli/              # CLI entry, doctor, prompt dump, quality benchmark
│   ├── config/           # Environment config loading
│   ├── setup/            # Guided onboarding UI, discovery, config transactions
│   ├── core/
│   │   ├── agent-loop/   # Provider calls, tool loop, gate pause/resume
│   │   ├── agents/       # Agent profiles, child runtime, scheduling, inbox
│   │   ├── artifacts/    # Artifact scanning, preview bounds, validation selection
│   │   ├── attachments/  # Image content-addressed store and request materialization
│   │   ├── checkpoints/  # Per-turn file snapshots, diff stats, restore
│   │   ├── compact/      # Context compaction service
│   │   ├── engine/       # Engine profile YAML loader
│   │   ├── gate/         # request_confirmation tool + GateRequest types
│   │   ├── harness/      # Harness manifest verification, compatibility, install
│   │   ├── permissions/  # Tool Permission Runtime broker and policy
│   │   ├── process/      # Bounded Process Runtime and shell profiles
│   │   ├── project/      # Project root taxonomy and path classification
│   │   ├── prompt/       # Prompt loading and composition
│   │   ├── quality/      # Output Quality Guard host runtime
│   │   ├── rewind/       # Conversation rewind and partial summarization
│   │   ├── runtime/      # Engine and runtime asset resolution helpers
│   │   ├── session/      # JSONL session store + resume helpers
│   │   ├── stage/        # Stage consumer bootstrap
│   │   ├── tools/        # Vesicle tool contracts and implementations
│   │   ├── user-question/# ask_user_question host question types
│   │   └── validators/   # Module A/B v9 validators + registry
│   ├── providers/        # Provider-neutral types and adapters
│   ├── mcp/              # Streamable HTTP MCP tool discovery and execution
│   ├── skills/           # Agent Skills parser, discovery, store, install, catalog, authoring (Phase 0–3)
│   ├── tui/              # OpenTUI/Solid interface, theme, GatePrompt
│   └── types/            # Shared host types
├── assets/               # Exact 73-file V10 Harness manifest inventory
├── host-assets/
│   ├── agents/           # Five generic Vesicle Agent Profiles
│   └── prompts/          # Host base prompts + generic Agent prompts
├── harness-manifest.json # Bundled prism-harness-pack/v1 identity and hashes
├── docs/
│   ├── dev/              # Developer docs and architecture rules
│   ├── examples/         # Canonical provider/MCP/permissions/quality config
│   └── user/             # Channel-funnelled user manual (zh-CN canonical, en mirrored)
├── dev/
│   ├── docs/             # Ignored local working notes, decisions, and archive
│   └── drafts/           # Ignored local scratch and miscellaneous material
└── tests/
    ├── unit/             # Pure-logic tests by domain (cli, core, providers, quality, tui)
    ├── component/        # OpenTUI testRender component tests (setup, tui)
    ├── integration/      # Multi-module integration with tmp fs / fetch stubs
    ├── contract/         # Architecture, release, and prompt static contracts
    ├── acceptance/       # Opt-in real-provider gate (.acceptance.ts, not auto-discovered)
    └── support/          # Shared test infrastructure (async, providers)
```

## Tool Surface

Model-visible tools and their write scope. Path guards, permissions, process authority, gates, questions, and MCP execution are defined in [`docs/dev/TOOLS.md`](./docs/dev/TOOLS.md); the table below is the authoritative current tool inventory.

| Tool | Write scope |
|------|-------------|
| `stat_path` | Read-only existence/type probe; allowed missing paths return structured `not_found` |
| `list_directory` | Read-only unified directory query; `.` is a safe virtual root, `full`/`names` results are structured and bounded, and layered `assets/` is supported |
| `grep_files` | Read-only |
| `read_file` | Read-only, with optional line ranges |
| `view_image` | Read-only, guarded image attachment (vision-capable models only) |
| `read_instructions` | Read-only access to one fixed user/project Persistent Instruction target (non-Stage Engines) |
| `update_instructions` | Fixed user/project Persistent Instruction target; permission-routed host-config mutation outside writable roots (non-Stage Engines) |
| `create_file` | Writable roots (no overwrite) |
| `create_directory` | Below writable roots; fixed roots protected |
| `write_file` | Writable roots (full overwrite) |
| `replace_in_file` | Writable roots (exact text replacement) |
| `append_file` | Writable roots |
| `delete_file` | Writable roots (files only) |
| `copy_file` | Source: read roots; target: writable roots |
| `move_file` | Writable roots |
| `move_directory` | Below writable roots; fixed roots protected (no overwrite) |
| `delete_directory` | Below writable roots; fixed roots protected (empty only) |
| `web_search` / `web_fetch` / `web_map` / `web_crawl` / `web_research` | No filesystem access (Tavily host tools, ETL/Evaluate) |
| `mcp_<prefix>_<tool>` | Delegated to the configured Streamable HTTP MCP server |
| `ask_user_question` | No filesystem access (single-select host question) |
| `request_confirmation` | No filesystem access (gate) |
| `request_engine_switch` | No filesystem access (handoff gate) |
| `spawn_agent` | Delegated Agent Profile scope |
| `list_agents` | No filesystem access |
| `send_message` | No filesystem access (child request boundary) |
| `interrupt_agent` | No filesystem access |
| `wait_agent` | No filesystem access (foreground join / background inbox) |
| `shell_exec` | Host-user filesystem/process/network authority; **not** path-guarded (opt-in) |
| `activate_skill` / `read_skill_resource` | Activate an effective catalog entry / read a guarded Skill resource |
| `run_skill_script` | Fixed activated-Skill script with a catalog-pinned content hash, structured argv, Process Runtime, host-process checkpoint taint, and host-user process authority; independent of `shellExec` |
| `shell_output` | Reads bounded `.vesicle/processes/` runtime state |
| `shell_stop` | Terminates the managed process group/tree |
| `config.load` / `prompt.load` | Internal contract |
| `session.write` | `.vesicle/sessions/` |

Read/list/stat/grep roots: `assets/`, `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`, and the scratch root `tmp/`. Writable roots: `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`, and the scratch root `tmp/`; `tmp/` holds drafts and intermediate work, is excluded from per-turn file checkpoints and rewind (so its mutations are not rewind-safe), and is retained unless explicitly cleaned; `tmp/` is also excluded from `/init` scanning, Stage input discovery, the Artifact Workbench, `/artifact`, `/validate`, Quality Guard artifact targets, and automatic publication. The Artifact workbench indexes only the four final-output roots (`workspace`, `novels`, `reports`, `test_runs`). All model-visible filesystem paths are project-relative; absolute paths, `..` escapes, and symbolic-link traversal are rejected. `request_confirmation` is attached only when the active engine profile declares at least one stop gate.

## Gate Runtime

| Gate | Engine | Status |
|------|--------|--------|
| `blueprint-confirmation` | etl | Wired (Phase 0) |
| `phase-confirmation` | etl | Wired (Phase artifact checkpoints) |
| `runtime-turn` | runtime | Declared in profile and prompt-bound |

Engines with empty `stopGates` never offer `request_confirmation`, so their models cannot invoke a gate the host would then have to refuse. `request_engine_switch` is available to all engines as a user-confirmed handoff; transition restrictions are intentionally deferred. Gate and handoff semantics live in [`docs/dev/TOOLS.md`](./docs/dev/TOOLS.md), while presentation belongs to [`docs/dev/TUI.md`](./docs/dev/TUI.md).

## Validators

| Validator | Engine | Checks |
|-----------|--------|--------|
| `character-card` | etl | Module A v9: parsed YAML field contract, ordered/non-empty sections and Persona Topology subsections, axis counts, scoped `Hard limit:`, artifact lexical-policy warnings, L-System leakage |
| `scenario-card` | etl | Module B v9: parsed YAML field and beat-map contract, single-line `world_state`, trajectory, visible opening, ordered/non-empty logic-comment sections, artifact lexical-policy warnings, L-System leakage |
| `runtime-packet` | runtime, stage | Ordered three-part packet: scoped Hidden Neural Chain fields, standalone ordered Dynamic HUD lines, non-empty prose, Runtime/Stage marker separation, L-System leakage |
| `evaluate-report` | evaluate | One independent Overall Verdict (PASS/CONDITIONAL/FAIL) and five exactly-once, ordered, non-empty sections; inline only — file-written reports are not read yet |

Validator findings are advisory: they surface in the TUI and session log but never abort a turn. Each validator runs only when its own applicable content shape matches — Module A/B YAML-frontmatter artifacts for `character-card` and `scenario-card`, the three-part turn packet for `runtime-packet` on Runtime and Stage, or an inline audit report for `evaluate-report` — never on ordinary phase-transition prose.

The Module A/B artifact Validators intentionally mirror the verified `zh-f1-not-x-but-y` matcher as a transitional lexical-policy warning. It applies only after artifact-shape routing, reports the matched prohibited `不是……而是……` pattern without inferring authorship, and does not add an ETL Quality Guard binding, provider call, rewrite, or delivery gate.

## Known Limits & Deferred Work

Grouped by subsystem. Each item states the current limit or deferral; behavioral detail, where it exists, lives in the linked document.

### Filesystem & Session

- Directory tools intentionally omit recursive deletion and directory-tree copying. Models must delete contents explicitly before `delete_directory`; `move_directory` never overwrites an existing target.
- Rewind file checkpoints track only mutations performed through Vesicle's guarded filesystem tools under the durable content and artifact roots (not the scratch root `tmp/`), including nested directory topology. Files or directories changed only by the user, an external process, `shell_exec`, or `run_skill_script` are outside that ledger and are not independently discovered as rewind targets. Moves across the `tmp/` boundary are asymmetric under rewind: scratch→content loses the moved body; content→scratch leaves a duplicate in `tmp/`.
- Regenerate (Chat-page `Ctrl+R`; Workspace keeps `Ctrl+R` for file reload) re-runs the last turn as a new candidate by appending a sibling subtree off the shared user record (Model B: one user record, N candidate subtrees); the candidate-tree panel (`/branch`, `Ctrl+B`) additionally regenerates any turn of the active branch via its fork row. Old candidates are never deleted or garbage-collected, so the session JSONL grows with each regenerate and candidate switch, and `loadSessionSnapshot` (which reads the whole file) slows accordingly. Per-candidate file coexistence is implemented with full-manifest bundles: leaving a candidate snapshots everything on disk under the content roots into an append-only version-2 `candidate-file-state` bundle chained off its content leaf, regenerate restores the fork baseline (the first-wins merge of every candidate's pre-turn checkpoint state) before the new candidate runs, and switching candidates — inline at the last turn or at any depth through the candidate tree — makes the disk strictly equal to the target candidate's manifest before re-pointing the selection marker (Stage, which writes no files, is unaffected). Caveats: bundles recorded before the full-manifest upgrade (no `version` field) are rejected at parse and their candidates switch conversation-only with a degradation marker, and candidates never departed since creation have no bundle at all; symlinks and special files are never captured, restored, or deleted (surfaced as `untracked` in switch outcomes), the scratch root `tmp/` stays outside manifests, host-process turns (`shell_exec` / `run_skill_script`) surface taint warnings; and when file checkpointing was disabled while the fork turn ran there is no ledger anchor, so that fork degrades to conversation-only behavior. Because manifests are full, manual edits and MCP-tool writes made while a candidate is active are snapshotted on departure and deleted or restored with the switch. A failed or interrupted regenerate re-points the marker and restores the old candidate's bundled files best-effort. Regenerate is refused while a turn is running, a confirmation/permission/question is unresolved, or a background SubAgent is still in flight; candidate switching is likewise refused while a background SubAgent is running or queued.
- Persistent Instruction targets are host configuration outside the guarded writable roots, so `/rewind` and double-Esc do not restore changes made by `update_instructions`. Rewinding the conversation can therefore remove the visible tool call while leaving the instruction file changed on disk. The tool reports the single `.previous` backup location after each mutation; recovery is manual until a dedicated restore command exists.

### Providers & Streaming

- OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini `generateContent` are supported user-facing protocols. The independent OpenAI Responses adapter is an explicit opt-in protocol, released with the 1.0.0-alpha.10 candidate after the full `openai-public` real-provider gate passed on 2026-08-11. Responses selection is never inferred from a URL or model name. `openai-public` is the official application-layer profile with HTTPS/non-stream JSON, typed SSE, opt-in session-scoped WebSocket, stateless ordered/encrypted Items, exact `call_id` pairing, terminal commit, full replay recovery, and model-capability-gated `/responses/compact`. The HTTP-only `codex-http-relay` profile is the maximum-compatibility tier for Codex-serving gateways: after a valid `response.completed`, it accepts either public-style terminal ordered output or reconstructs an empty/omitted terminal output from contiguous completed Item events; non-empty dual representations must match on semantic payload (a terminal that omits optional fields the relay strips is accepted as a subset of the completed-Item stream, and the fuller completed Items are retained), and failed/incomplete/EOF attempts commit nothing. The dated MiMo and DeepSeek profiles are HTTP-only third-party compatibility tiers: unsupported stateful OpenAI fields, WebSocket, and remote compaction are omitted, full context is replayed, and `response.reasoning_text.*` is mapped explicitly. `deepseek-subset-2026-07-31` admits the documented `deepseek-v4-flash` and `deepseek-v4-pro` pair; v4 Pro became officially supported and was independently accepted on 2026-08-13, while other models remain excluded. The `codex-beta-2026-02-06` profile is a fingerprint-level Codex V2 simulation profile: with WebSocket transport it sends Codex's V2 beta wire shape (`responses_websockets=2026-02-06` header plus `stream: true`) and falls back to HTTPS/SSE on exhaustion like Codex; over HTTPS/SSE it is indistinguishable from `openai-public`. Portable compaction remains recovery authority. Application conformance excludes TLS/HTTP2 fingerprint identity and all Codex-private headers, identity, and attestation. Real-provider suites report missing configuration or credentials as skipped/unavailable, never passed. Every documented profile has passed real-provider acceptance against its official endpoint — the official OpenAI four-piece gate, the MiMo and DeepSeek reasoning and function-loop subsets, and relay compatibility lanes — and each release candidate re-verifies the applicable lanes; dated acceptance history lives in [`CHANGELOG.md`](./CHANGELOG.md).
- Model discovery currently targets the OpenAI-compatible `GET /v1/models` response shape. Anthropic and Gemini use their existing profiles plus exact manual model ids until their native discovery APIs receive separate adapters. Discovery never infers capabilities from names.
- Gemini `generateContent` history serialization keeps a strict Content boundary for tool results: a `user` Content holds either `functionResponse` parts only or ordinary multimodal parts only. MCP tool-result images replay as a separate ordinary `user` Content (image notice plus `inlineData`) following the `functionResponse` Content; the former mixed shape was rejected by the endpoint with HTTP 400 and blocked continuation after an image-producing tool call (#226, fixed 2026-08-19 with real-provider streaming acceptance). See [`docs/dev/PROVIDERS.md`](./docs/dev/PROVIDERS.md) § Protocol Mapping.
- Mid-stream SSE disconnect replay is deferred: replaying partial assistant/tool deltas requires explicit UI and tool-loop reconciliation. Transport and retryable-HTTP retry is implemented; see [`docs/dev/PROVIDERS.md`](./docs/dev/PROVIDERS.md).
- Provider proxy support ships deterministic and local real-CONNECT coverage for HTTP and native WebSocket through one optional `VESICLE_PROVIDER_PROXY` (`docs/dev/PROVIDERS.md` § Proxy). The official OpenAI HTTP and native WebSocket function loops through a required proxy passed on 2026-07-31 (`gpt-5.6-luna`) with sanitized evidence, and a WebSocket proxy `407` is terminal via a per-session preflight (native WebSocket otherwise surfaces a proxy 407 as a generic connection failure). The official acceptance is opt-in, injects the resolved proxy policy, and reports unavailable when its prerequisites (credentials, proxy network isolation, observer) are absent. Inherited selection mirrors the pinned Bun runtime: for secure targets `https_proxy`/`HTTPS_PROXY` are honored (lowercase preferred) and `HTTP_PROXY`/`ALL_PROXY` are not; `NO_PROXY` supports `*`, exact host, and leading-dot suffix but not `:port` or `*.`. OS/PAC/SOCKS discovery, proxy chaining, per-provider selection, NTLM, and custom proxy headers are non-goals.

### Engines & Gates

- Long-form engines (Weaver / Weaver-Orch / Dyad) have profiles and prompts but no dedicated validators or gate wiring.
- Engine transition context policy supports `preserve_full` and `summary`; the `fresh` (explicit context-discard) policy remains reserved for a future workflow.
- Higher-level workflow scaffolding above manual `/engine` and model-requested `request_engine_switch` remains deferred.
- Gate UI is Select-style for ETL blueprint and phase checkpoints; Workflow B hook selection may still need a more specialized selector later.

### Agents & Delegation

- SubAgent recursion is disabled: top-level children run concurrently (default maximum four), but child profiles do not receive the agent-control tools. A process restart marks previously running children as failed and delivers that terminal result; it does not replay an in-flight provider request.
- SubAgent handles are unique within one parent session rather than globally; host-only run ids preserve global storage and recovery identity. Legacy UUID-style references remain accepted but are no longer emitted.
- Concrete Weaver-Orch scene allocation, Evaluate reviewer composition, and artifact merge policy remain Harness responsibilities. Vesicle supplies the generic Agent scheduling, persistence, and delivery substrate; every non-whitelisted Agent request must bind to the parent Engine's declared Driver Contract. See [`docs/dev/SUBAGENTS.md`](./docs/dev/SUBAGENTS.md).

### Web & MCP

- MCP supports dual-era Streamable HTTP tools: legacy `initialize` (revisions through `2025-11-25`) and modern `server/discover` (`2026-07-28`). Per-server `negotiation: legacy|modern|auto` controls the connection path; absent defaults to `legacy` with zero wire change. The official `@modelcontextprotocol/client@2` SDK owns wire negotiation behind a thin Vesicle adapter; SDK types do not enter `core/`, providers, or TUI. Both eras normalize into the same `ToolDefinition`/`ToolCall`/`ToolResult` boundary. The existing inline image path, secret hygiene, permission class, Engine scoping, and result normalization are preserved. Strictly validated inline PNG/JPEG/GIF/WebP tool-result images are supported. Resource, audio, URL/link, and unknown result kinds are omitted without auto-fetch or prompt injection (deferred). `input_required` (modern MRTR) is rejected with a stable unsupported-capability error — no retry or side effect. Automatic `subscriptions/listen` is not enabled. Local stdio servers, classic HTTP+SSE, prompts/resources APIs, non-image media delivery, OAuth, and background tool-list-change handling are deferred.
- Web tools are limited to the five Tavily host tools on ETL and Evaluate profiles. Provider-native built-in web search groundwork (normalized `WebSearchReport`, `capabilities.builtinWebSearch` + `webSearchDefault` config, `/websearch` session toggle, Tavily surface rules) has landed, and the OpenAI Responses protocol consumes it (`openai-public` and the new dated `deepseek-subset-2026-08-19` declare the bare `web_search` tool, admit `web_search_call` Items/events, normalize queries/citations/call records, and replay call Items; frozen profiles stay fail-closed). The Gemini generateContent adapter remains a follow-up slice ([#225](https://github.com/3aKHP/prism-vesicle/issues/225) slice 3).

### Host Shell

- `shell_exec` and `run_skill_script` are user-authorized host processes, **not an OS sandbox**. Their child environment is filtered and their process lifetime/output are bounded, but an approved process can still read or mutate project-external files and use the network. Host-process file changes taint the turn's checkpoint completeness and are not guaranteed to rewind.
- Process cleanup terminates the managed shell and ordinary descendants in its process group/tree; an explicitly approved command can still escape that tree through a new session or external service manager. See [`docs/dev/TOOLS.md`](./docs/dev/TOOLS.md) for the runtime contract and [`docs/user/en/advanced/shell-exec.md`](./docs/user/en/advanced/shell-exec.md) for the user-facing surface.

### Quality Guard & Stage

- The Output Quality Guard ships deterministic findings, the six published document metrics, and durable per-target rewrite decisions on `develop`. The Semantic Judge is an **experimental** user-level override that defaults to `off` in `quality.yaml` and makes no production-quality or AI-authorship claim; its findings remain advisory even under Runtime `rewrite` and never enter blocking policy.
- The calibrated `quality-policy/semantic-rewrite@1` policy is recognized but **not connected** to the rewrite state machine: the host exposes pure eligibility evaluation only, and the currently bundled Harness remains semantic-observe only until calibration, held-out, and preservation gates are complete.
- Archive extraction, online Release discovery, channels, downloads, and automatic Harness updates are deferred; the offline CLI accepts an already-extracted pack directory.
- Stage, Quality Guard, and the experimental Semantic Judge each carry point-in-time status in the user-manual advanced chapters ([`stage`](./docs/user/en/advanced/stage.md), [`quality-guard`](./docs/user/en/advanced/quality-guard.md)); developer benchmarking is documented in [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md).

### Assets & Harness

- Asset overlays do not support deletion tombstones. An absent higher-layer file falls back to the next layer; disabling packaged engines/assets will require a future explicit manifest policy rather than magic filenames.
- With no project lock, Vesicle automatically verifies and activates the bundled `prism-engine-v10`; rollback returns to that same baseline. Sessions recorded before the V10 migration have no Harness identity and fail closed on resume.
- See [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) for the bundled inventory, host extension layer, managed Pack verification, Driver bindings, Quality Guard bindings, lineage, and update rules.

### Persistent Instructions

- Persistent Instructions are model context, not capability enforcement: they can customize workflow, tone, ordering, artifacts, and user-defined specs within the active Engine, but cannot change the tool surface, permission mode, path roots, stop gates, validators, Harness identity, or provider configuration. A conflict with the Engine contract is ignored in favor of the Engine contract.
- Instruction files are user-authored with a text editor, `/init`, or the `read_instructions` / `update_instructions` model tools (non-Stage Engines). `/init` refuses to replace an existing project `VESICLE.md` unless the user supplies `--force`, which stores the previous file under `.vesicle/init-backups/`. `update_instructions` is a `mutate` tool routed through the Tool Permission Runtime (MANUAL/INERTIA pause via the standard permission request; MOMENTUM/YOLO execute); it uses a fixed `{ scope, engine }` enum target, atomic write, optimistic concurrency (`ifMatchSha256`), a single previous-state backup, and a 32 KiB budget check across affected Engines. A successful update refreshes the in-turn frozen snapshot so it applies on the next provider round. A custom unified-diff permission preview, automatic backup restore, and per-turn change-detection audit records remain deferred.
- Instruction target files are resolved by a fixed enum `{ scope, engine }` and never by an arbitrary path. They live outside the guarded `assets/` namespace and the writable artifact roots, so they do not perturb the Harness integrity fingerprint or widen the model-visible write surface.
- File-capable Engine turns receive a bounded `<project_state>` snapshot at turn start. It is live Host prompt context rather than session identity or conversation history: in-process pauses reuse the frozen snapshot, while restarts and new top-level turns observe again.

### Other

- Skills Phase 0 (format, inventory, Skill Store), Phase 1 (repository installation and lifecycle), Phase 2 (activation, resources, scripts), Phase 3 (authoring and project scope), Host-bundled first-party Skills, and the bundled `skillify` workflow are implemented: a strict Agent Skills `SKILL.md` parser and validator, bounded discovery for the Host (`host-assets/skills/`), Harness (`assets/skills/`), user (`<user-config>/skills/`), and project (`.agents/skills/`) scopes with deterministic `project` > `user` > `installed` > `harness` > `host` precedence, collision and unsupported-field diagnostics, an immutable versioned Skill Store with an active index, catalog hashing, and cross-process index locking, and the `vesicle skills list|validate|inspect|create|enable|disable|copy-template|install|update|rollback|uninstall` commands plus `vesicle doctor` integration. `install` accepts a local path or a GitHub repository URL (`--ref`, `--path`, `--all`, `--include-worktree`), resolves remote refs to immutable commits, installs immutable snapshots with a provenance sidecar, and refuses to guess when a source contains multiple Skills; `update`/`rollback`/`uninstall` operate on the active index and retained versions. Phase 2 adds model-visible activation: `activate_skill` (enum dynamic catalog, hash dedup), `read_skill_resource` (script sources readable without process execution, 256 KiB truncation), and `run_skill_script` (fixed activated-Skill resource, structured argv, no shell interpolation, independent `skill_exec` approval, no `shellExec` gate, shared Process Runtime timeout/output/cancel/cleanup, `.ps1` PowerShell 7/5.1 support); the `/skill` TUI command (bare picker, `<name> [task]` activate-and-invoke, `--context-only`); per-session catalog freeze with resume by name+hash; catalog prompt block injection; compaction reattach (16 KiB budget) with loss reporting; Engine-switch eligibility filtering and activation registry pruning; and replay/rewind/resume derivation from durable records. Skill scripts receive stable Host self-invocation values (`VESICLE_SELF_EXECUTABLE`/`VESICLE_SELF_ENTRYPOINT`) in their filtered child environment so first-party wrappers can re-invoke the exact Vesicle runtime without PATH assumptions; process-authorized scripts can observe and print their own environment, while persisted events do not record these paths automatically. Skill tools are host-injected for all non-Stage engines independent of the Harness profile's `defaultTools`, so harness bumps cannot clobber them. Phase 3 adds project `.agents/skills/` discovery with visible provenance and no separate trust gate, `create` scaffolding with explicit overwrite behavior, `enable`/`disable` across all scopes (store index for installed; line-delimited disabled-names files for user/project/host), and `copy-template` into approved durable content roots. Host scope adds generic package-owned first-party Skill discovery independent of the active Harness; the bundled `vesicle-docs` Skill ships version-matched public documentation (README, user manual, developer contracts, examples) as readable references without scripts or process capability; the bundled `skillify` Skill captures a proven workflow from the current conversation into `tmp/skillify/<name>/`, validates it through the shared bundle seam, and publishes create-only to `project` (`.agents/skills/<name>/`) or `installed` (Skill Store) through two thin `.sh`/`.ps1` wrappers and a non-model-visible JSON CLI (`vesicle skills validate --draft --json`, `vesicle skills publish-draft --target <project|installed> --json`). The bundled `novel-outline-v3` Skill ships a hierarchical novel-outline workflow (volume → chapter → scene, per-chapter tension-budget allocation with closed-form checks, foreshadow tracking, and two living-document ledgers for character growth and world state) as readable references without scripts or process capability. The bundled `update-config` Skill guides configuration changes through validated, atomic `vesicle config` CLI operations (sanitized `show`, `set`, `add-provider`, `add-model`, `add-mcp`, `remove-mcp`, `remove-model`, `remove-provider`, `unset`, non-secret `env-*` management, `validate`) via two thin `.sh`/`.ps1` wrappers; secret values are structurally excluded — `.env` reads are whitelist-sanitized and no operation accepts a secret value as an argument. Skill scripts also receive `VESICLE_HOST_CONFIG_DIR` (the resolved user-level config directory) alongside `VESICLE_SELF_EXECUTABLE`/`VESICLE_SELF_ENTRYPOINT` in their filtered child environment. See [`docs/dev/SKILLS.md`](./docs/dev/SKILLS.md). Deferred to later phases: SubAgent Skill inheritance; and optional registry or marketplace work.
- Prompt-cache engineering (PrefixShape hashing, CacheDiagnostics) is deferred.

## Verification

Standard checks:

```bash
bun run lint
bun run typecheck
bun test
bun run doctor
bun run build:installer:stage
```

The `bun run test:acceptance:provider` lane runs the general real-provider connectivity and strict ETL gate only when `BUN_E2E_REAL_PROVIDER=1` is set. `bun run test:acceptance:gemini` replays an MCP-sourced image tool result through a `gemini-generate-content` endpoint; it needs `BUN_E2E_REAL_PROVIDER=1` plus `BUN_E2E_GEMINI_IMAGE_TOOL_PROVIDER` (optional `BUN_E2E_GEMINI_IMAGE_TOOL_MODEL`) selecting a provider whose model declares `capabilities.vision: true`. `bun run test:acceptance:responses` adds explicit Responses tiers for the existing narrow relay, official `api.openai.com`, MiMo, and DeepSeek. The official suite covers HTTP/SSE, non-stream, standalone compact, and public WebSocket; the third-party suites cover profile-owned reasoning and a function loop. The deterministic suite separately proves subset request-field omission and profile-scoped reasoning-event mapping. All acceptance files are excluded from `bun test` default discovery; missing opt-in selectors, profiles, capabilities, endpoints, or credentials produce real test skips with a documented unavailable reason, never a passing test. Run the applicable lane as a recorded internal acceptance before a public tag. Tavily-backed web tools are enabled by setting `TAVILY_API_KEY` in the same user-level `.env` file or process environment. MCP tools are enabled by copying [`docs/examples/mcp.yaml`](./docs/examples/mcp.yaml) beside `providers.yaml`, setting `enabled: true`, and adding the referenced header variables to the sibling `.env`.

Native Windows CI installs pinned Inno Setup, builds the versioned guided installer, performs a silent per-user install plus a second upgrade install, removes simulated legacy executable/wrapper/Start Menu launchers, verifies the native `vesicle.exe` command and Explorer directory actions, runs standalone runtime diagnostics from a separate project directory, silently uninstalls, and proves that user configuration and project sentinels survive while the exact PATH entry and Explorer integration are removed. Release, tag, and signing workflow live in [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md).

## Documentation Map

| Document | Authority |
|----------|-----------|
| [`README.md`](./README.md) | Project entry point, installation, first run, feature overview, navigation |
| [`docs/user/`](./docs/user/) | User manual (Simplified Chinese canonical, English mirrored) |
| [`STATUS.md`](./STATUS.md) | This file — current implementation inventory |
| [`CHANGELOG.md`](./CHANGELOG.md) | Notable released and unreleased changes |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor workflow, repo boundary, documentation style |
| [`CODE_SIGNING_POLICY.md`](./CODE_SIGNING_POLICY.md) | Windows signing scope, approval, verification, incident handling |
| [`PRIVACY.md`](./PRIVACY.md) | Local data, external-service transfers, uninstall, deletion |
| [`AGENTS.md`](./AGENTS.md) / [`CLAUDE.md`](./CLAUDE.md) | AI collaborator startup and coordination |
| [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) | Source-code structure and maintainability rules |
| [`docs/dev/ARCHITECTURE.md`](./docs/dev/ARCHITECTURE.md) | Layering, dependency direction, and runtime-contract routing |
| [`docs/dev/PROVIDERS.md`](./docs/dev/PROVIDERS.md) | Provider adapters, protocol mapping, transport, usage, and configuration |
| [`docs/dev/TOOLS.md`](./docs/dev/TOOLS.md) | Tool capability, path, permission, process, gate, question, web, and MCP contracts |
| [`docs/dev/SESSIONS.md`](./docs/dev/SESSIONS.md) | Session persistence, projection, checkpoints, rewind, compaction, and recovery |
| [`docs/dev/PERSISTENT_INSTRUCTIONS.md`](./docs/dev/PERSISTENT_INSTRUCTIONS.md) | Persistent Instruction resolution, composition, mutation, and capability limits |
| [`docs/dev/TUI.md`](./docs/dev/TUI.md) | Terminal layout, input, rendering, commands, rewind, and side-question contracts |
| [`docs/dev/USER_AGENCY_AND_RISK_DISCLOSURE.md`](./docs/dev/USER_AGENCY_AND_RISK_DISCLOSURE.md) | User agency, risk disclosure, confirmation, and enforceable-boundary policy |
| [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) | Branching, PRs, hotfixes, independent CR, release lifecycle |
| [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) | Bundled Harness inventory, host layer, lineage, updates |
| [`docs/dev/SUBAGENTS.md`](./docs/dev/SUBAGENTS.md) | SubAgent lifecycle and delivery contract |
| [`docs/dev/SKILLS.md`](./docs/dev/SKILLS.md) | Skills runtime boundary (Agent Skills format, discovery, store) |
| [`docs/dev/STAGE.md`](./docs/dev/STAGE.md) | Stage consumer Engine bootstrap, three-part packet, and prose-first rendering contract |
| [`docs/dev/QUALITY_GUARD.md`](./docs/dev/QUALITY_GUARD.md) | Output Quality Guard delivery-policy runtime (detection, Semantic Judge, host policy, rewrite) |
| [`docs/dev/COMMAND_COMPLETION.md`](./docs/dev/COMMAND_COMPLETION.md) | Slash-command argument completion contract |
| [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md) | Developer Quality Guard benchmark runner |

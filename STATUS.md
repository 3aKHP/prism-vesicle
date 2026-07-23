# Prism Vesicle Project Status

_Snapshot: 1.0.0-alpha.3 released baseline plus unreleased `develop` changes (2026-07-23)._

> This is the authoritative current implementation inventory: capability state, tool surface, validators, verification, and known limits. Behavioral contracts live in [`docs/dev/`](./docs/dev/) and the user manual under [`docs/user/`](./docs/user/); each section below links to the authoritative source rather than duplicating it. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the root-document responsibility split.

## Version & Capabilities

Current public release: **1.0.0-alpha.3**. The `State` column tracks the public contract and subsequent development: `released` = included in the 1.0.0-alpha.3 GitHub Release and npm package; `unreleased` = implemented on `develop` but not yet included in a public release; `deferred` = not included (see [Known Limits & Deferred Work](#known-limits--deferred-work)).

| Subsystem | Capability | State |
|-----------|-----------|-------|
| Assets | Bundled V10 Harness (`prism-engine-v10@10.1.0-rc.1`, verified 73-file inventory) | released |
| Assets | Managed Harness Packs: offline verify/install/pin/use/status/rollback | released |
| Providers | OpenAI-compatible Chat, Anthropic Messages, and Gemini adapters with SSE streaming | released |
| Providers | Multi-provider registry with generation defaults and capability/limits metadata | released |
| Providers | Cross-provider usage normalization and de-duplicated TUI footer counters | released |
| Providers | Thinking-effort controls and reasoning-block visibility | released |
| TUI | OpenTUI + Solid responsive shell with host-owned multiline composer | released |
| TUI | Shared FIFO for user messages and capability-classified commands, with tool/Loop boundaries, Escape interrupt, preview, and edit recall | unreleased |
| TUI | `/btw` side questions: one tool-free question over a frozen context boundary, shown in an ephemeral overlay while the main turn continues | unreleased |
| Instructions | Persistent Instructions: user-authored `VESICLE.md` / `VESICLE.<engine>.md` at the project root and beside `providers.yaml`, auto-loaded into the system prompt each session with user + project scope and Engine-specific replacement | unreleased |
| Instructions | `/init [notes]`: scan the project and draft a project-scope `VESICLE.md` via a dedicated host prompt (no new Harness); backs up an existing file before replacing | unreleased |
| TUI | Clipboard image attachments (`Alt+V`, vision-gated) | released |
| TUI | Rewind: conversation branches plus per-turn file checkpoints | released |
| Tools | Guarded filesystem loop, `request_confirmation` gate, engine handoff, clarifying question | released |
| Tools | Tavily web tools (`web_search` / `web_fetch` / `web_map` / `web_crawl` / `web_research`) | released |
| Tools | Streamable-HTTP MCP tools | released |
| Tools | Opt-in `shell_exec` with bounded Process Runtime | released |
| Tools | Tool Permission Runtime (`MANUAL` / `INERTIA` / `MOMENTUM` / `YOLO`) | released |
| Agents | Foreground/background SubAgents with contract-bound Harness delegation | released |
| Stage | First-party consumer RP bootstrap Engine (`/stage`) | released |
| Validators | Module A, Module B v9, runtime packet, and evaluate-report checks | released |
| Workbench | `/artifact` discovery, preview, validation, and revision | released |
| Quality | Output Quality Guard: deterministic findings, document metrics, durable decisions, and experimental Semantic Judge/rewrite-policy loader | released |
| Release | Standalone Windows PE and Linux ELF binaries | released |
| Release | npm/Bun package with pinned runtime dependencies | released |
| Release | Guided per-user Windows installer (Inno Setup + `vesicle setup`) | released |
| Release | Reusable Linux/Windows release build with tag-triggered publication | released |

## Scope

The 1.0 alpha makes Vesicle a credible direct API host for the Prism Engine, not just a chat wrapper: it loads Prism engine profiles, drives their system prompt, tool surface, validators, and stop gates at runtime, and runs a terminal UI for the resulting gated workflow.

Public user-facing documentation is intentionally limited during the alpha. Treat the [`docs/user/`](./docs/user/) manual, the [README](./README.md) installation and first-run guide, `vesicle doctor`, `vesicle prompt shape --engine <id>`, and [`docs/examples/`](./docs/examples/) as the supported onboarding references; other behavior is subject to alpha-level change while feature and fix work remains the priority.

Architecture and runtime contracts — provider adapters, tool guards, gates, sessions, prompts, TUI behavior, the SubAgent lifecycle, Harness and Quality Guard contracts, and command completion — live in [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) and its sibling documents under [`docs/dev/`](./docs/dev/). This file intentionally does not restate them.

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
│   │   ├── attachments/  # Clipboard image content-addressed store
│   │   ├── checkpoints/  # Per-turn file snapshots, diff stats, restore
│   │   ├── compact/      # Context compaction service
│   │   ├── engine/       # Engine profile YAML loader
│   │   ├── gate/         # request_confirmation tool + GateRequest types
│   │   ├── harness/      # Harness manifest verification, compatibility, install
│   │   ├── permissions/  # Tool Permission Runtime broker and policy
│   │   ├── process/      # Bounded Process Runtime and shell profiles
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
│   ├── skills/           # Future controlled skill bundle surface
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
│   └── drafts/           # Ignored local dogfood and miscellaneous material
└── tests/
    ├── unit/             # Pure-logic tests by domain (cli, core, providers, quality, tui)
    ├── component/        # OpenTUI testRender component tests (setup, tui)
    ├── integration/      # Multi-module integration with tmp fs / fetch stubs
    ├── contract/         # Architecture, release, and prompt static contracts
    ├── acceptance/       # Opt-in real-provider gate (.acceptance.ts, not auto-discovered)
    └── support/          # Shared test infrastructure (async, providers)
```

## Tool Surface

Model-visible tools and their write scope. Path-guard rules, write roots, and the full tool-runtime contract live in [`docs/dev/STYLE.md` § Tool Runtime](./docs/dev/STYLE.md#tool-runtime); the table below is the authoritative tool inventory.

| Tool | Write scope |
|------|-------------|
| `stat_path` | Read-only |
| `list_files` | Read-only |
| `list_directory` | Read-only, structured entries with bounded recursion |
| `grep_files` | Read-only |
| `read_file` | Read-only, with optional line ranges |
| `view_image` | Read-only, guarded image attachment (vision-capable models only) |
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
| `shell_output` | Reads bounded `.vesicle/processes/` runtime state |
| `shell_stop` | Terminates the managed process group/tree |
| `config.load` / `prompt.load` | Internal contract |
| `session.write` | `.vesicle/sessions/` |

Read/list/stat/grep roots: `assets/`, `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`. Writable roots: `source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`; the Artifact workbench indexes only the latter four final-output roots. All model-visible filesystem paths are project-relative; absolute paths, `..` escapes, and symbolic-link traversal are rejected. `request_confirmation` is attached only when the active engine profile declares at least one stop gate.

## Gate Runtime

| Gate | Engine | Status |
|------|--------|--------|
| `blueprint-confirmation` | etl | Wired (Phase 0) |
| `phase-confirmation` | etl | Wired (Phase artifact checkpoints) |
| `runtime-turn` | runtime | Declared in profile and prompt-bound |

Engines with empty `stopGates` never offer `request_confirmation`, so their models cannot invoke a gate the host would then have to refuse. `request_engine_switch` is available to all engines as a user-confirmed handoff; transition restrictions are intentionally deferred. Gate semantics and the Confirm/Reject/summary UI contract live in [`docs/dev/STYLE.md` § Gate Runtime](./docs/dev/STYLE.md#gate-runtime).

## Validators

| Validator | Engine | Checks |
|-----------|--------|--------|
| `character-card` | etl | Module A v9: frontmatter allowlist, seven sections, Persona Topology subsections, axis counts, L-System leakage |
| `scenario-card` | etl | Module B v9: 3–5 beat map, per-beat fields, tension range, trajectory, legacy field rejection |
| `runtime-packet` | runtime, stage | Three-part turn packet: Hidden Neural Chain (`[!Neural Chain]`), five-line Dynamic HUD markers, L-System leakage (thin MVP; output contract owned by Neural-Narratology) |
| `evaluate-report` | evaluate | Audit report Overall Verdict (PASS/CONDITIONAL/FAIL) and five numbered sections; inline only — file-written reports are not read yet |

Validator findings are advisory: they surface in the TUI and session log but never abort a turn. Each validator runs only when its own applicable content shape matches — Module A/B YAML-frontmatter artifacts for `character-card` and `scenario-card`, the three-part turn packet for `runtime-packet` on Runtime and Stage, or an inline audit report for `evaluate-report` — never on ordinary phase-transition prose.

## Known Limits & Deferred Work

Grouped by subsystem. Each item states the current limit or deferral; behavioral detail, where it exists, lives in the linked document.

### Filesystem & Session

- Directory tools intentionally omit recursive deletion and directory-tree copying. Models must delete contents explicitly before `delete_directory`; `move_directory` never overwrites an existing target.
- Rewind file checkpoints track only mutations performed through Vesicle's guarded filesystem tools, including nested directory topology. Files or directories changed only by the user, an external process, or `shell_exec` are outside that ledger and are not independently discovered as rewind targets.

### Providers & Streaming

- OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini `generateContent` are implemented. **OpenAI Responses is deferred.**
- Model discovery currently targets the OpenAI-compatible `GET /v1/models` response shape. Anthropic and Gemini use their existing profiles plus exact manual model ids until their native discovery APIs receive separate adapters. Discovery never infers capabilities from names.
- Mid-stream SSE disconnect replay is deferred: replaying partial assistant/tool deltas requires explicit UI and tool-loop reconciliation. Transport and retryable-HTTP retry is implemented; see [`docs/dev/STYLE.md` § Provider Adapters](./docs/dev/STYLE.md#provider-adapters).

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

- MCP currently supports Streamable HTTP tools only. Local stdio servers, classic HTTP+SSE, prompts/resources, and background tool-list-change handling are deferred.
- Web tools are limited to the five Tavily host tools on ETL and Evaluate profiles.

### Host Shell

- `shell_exec` is a user-authorized host command, **not an OS sandbox**. Its child environment is filtered and its process lifetime/output are bounded, but an approved command can still read or mutate project-external files and use the network. Shell-created file changes taint the turn's checkpoint completeness and are not guaranteed to rewind.
- Process cleanup terminates the managed shell and ordinary descendants in its process group/tree; an explicitly approved command can still escape that tree through a new session or external service manager. See [`docs/dev/STYLE.md` § Tool Permission Runtime](./docs/dev/STYLE.md#tool-permission-runtime) for the runtime contract and [`docs/user/en/advanced/shell-exec.md`](./docs/user/en/advanced/shell-exec.md) for the user-facing surface.

### Quality Guard & Stage

- The Output Quality Guard ships deterministic findings, the six published document metrics, and durable per-target rewrite decisions on `develop`. The Semantic Judge is an **experimental** user-level override that defaults to `off` in `quality.yaml` and makes no production-quality or AI-authorship claim; its findings remain advisory even under Runtime `rewrite` and never enter blocking policy.
- The calibrated `quality-policy/semantic-rewrite@1` policy is recognized but **not connected** to the rewrite state machine: the host exposes pure eligibility evaluation only, and the currently bundled Harness remains semantic-observe only until calibration, held-out, and preservation gates are complete.
- Archive extraction, online Release discovery, channels, downloads, and automatic Harness updates are deferred; the offline CLI accepts an already-extracted pack directory.
- Stage, Quality Guard, and the experimental Semantic Judge each carry point-in-time status in the user-manual advanced chapters ([`stage`](./docs/user/en/advanced/stage.md), [`quality-guard`](./docs/user/en/advanced/quality-guard.md)); developer benchmarking is documented in [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md).

### Assets & Harness

- Asset overlays do not support deletion tombstones. An absent higher-layer file falls back to the next layer; disabling packaged engines/assets will require a future explicit manifest policy rather than magic filenames.
- With no project lock, Vesicle automatically verifies and activates the bundled `prism-engine-v10@10.1.0-rc.1`; rollback returns to that same baseline. Sessions recorded before the V10 migration have no Harness identity and fail closed on resume.
- See [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) for the bundled inventory, host extension layer, lineage, and update rules, and [`docs/dev/STYLE.md` § Managed Harness Packs](./docs/dev/STYLE.md#managed-harness-packs) for the verification and contract boundary.

### Persistent Instructions

- Persistent Instructions are model context, not capability enforcement: they can customize workflow, tone, ordering, artifacts, and user-defined specs within the active Engine, but cannot change the tool surface, permission mode, path roots, stop gates, validators, Harness identity, or provider configuration. A conflict with the Engine contract is ignored in favor of the Engine contract.
- Instruction files are user-authored with a text editor today. Model-visible `read_instructions` / `update_instructions` tools (with Tool Permission Runtime integration, optimistic concurrency, atomic write, and previous-state backup) and per-turn change-detection audit records are deferred to a follow-up; the host already records the session-start instruction resolution in the system-record metadata and re-resolves current disk state on every top-level turn, resume, and Engine switch.
- Instruction target files are resolved by a fixed enum `{ scope, engine }` and never by an arbitrary path. They live outside the guarded `assets/` namespace and the writable artifact roots, so they do not perturb the Harness integrity fingerprint or widen the model-visible write surface.

### Other

- Skills are a directory stub, not a runtime integration.
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

The `bun run test:acceptance:provider` lane runs two opt-in suites against a real provider only when `BUN_E2E_REAL_PROVIDER=1` is set — a connectivity smoke (`provider-connectivity.acceptance.ts`) that only proves the adapter normalizes a real response, and a strict ETL Phase 0 gate (`e2e-gate.acceptance.ts`) that fails on any deviation from the blueprint/phase-confirmation protocol. Both are excluded from `bun test` default discovery and skip (not pass) with a documented reason when the env var or credentials are missing, so the deterministic suite never reports an unexecuted real-provider run as passing; run the lane as a recorded dogfood acceptance before a public tag. Tavily-backed web tools are enabled by setting `TAVILY_API_KEY` in the same user-level `.env` file or process environment. MCP tools are enabled by copying [`docs/examples/mcp.yaml`](./docs/examples/mcp.yaml) beside `providers.yaml`, setting `enabled: true`, and adding the referenced header variables to the sibling `.env`.

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
| [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) | Architecture and runtime contract boundaries |
| [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) | Branching, PRs, hotfixes, independent CR, release lifecycle |
| [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) | Bundled Harness inventory, host layer, lineage, updates |
| [`docs/dev/SUBAGENTS.md`](./docs/dev/SUBAGENTS.md) | SubAgent lifecycle and delivery contract |
| [`docs/dev/COMMAND_COMPLETION.md`](./docs/dev/COMMAND_COMPLETION.md) | Slash-command argument completion contract |
| [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md) | Developer Quality Guard benchmark runner |

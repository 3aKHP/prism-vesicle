# Prism Vesicle Project Status

_Last updated: 2026-07-16_

## Current Version

| Area | Version | Status |
|------|---------|--------|
| Prism Vesicle | 1.0.0-alpha.2 | Guided Windows installer candidate with profile-driven engine host |
| Prism assets | Verified bundled V10 Harness + optional project-pinned managed Harness | Implemented on development branch |
| Provider protocols | OpenAI-compatible Chat + Anthropic Messages + Gemini generateContent | Implemented |
| TUI | OpenTUI + Solid | Responsive shell + gate/session panels |
| Gate runtime | request_confirmation + needs_user loop | ETL blueprint + phase gates wired |
| Validators | Module A + Module B v9 + runtime packet + evaluate report | Implemented (thin MVP) |
| Streaming | OpenAI-compatible + Anthropic + Gemini SSE | Implemented |
| Provider registry | OpenAI-compatible + Anthropic + Gemini profiles | Implemented |
| Model config | Generation defaults + capability + limits metadata | Implemented |
| Response usage metadata | Cross-provider token/cache/context normalization + de-duplicated turn/session TUI footer | Implemented on development branch |
| Thinking effort | Provider-native reasoning controls | Implemented |
| Reasoning visibility | TUI collapsed/expanded reasoning blocks | Implemented |
| Artifact workbench | TUI commands + validation | Implemented |
| Rewind | Conversation branches + file checkpoints | Implemented on development branch |
| Web research | Tavily web host tools for ETL/Evaluate | Implemented on development branch |
| MCP tools | Streamable HTTP tools-only client | Implemented on development branch |
| Multimodal input | Clipboard attachments + guarded project image inspection | Implemented on development branch |
| Runtime assets | Project/user sparse overrides + managed or bundled V10 complete baseline + restricted host layer | Implemented on development branch |
| Managed Harness Packs | Offline verify/install/use/status/rollback + project/session pinning | Implemented on development branch |
| Harness delegation | Contract-bound Driver delegation over the generic SubAgent runtime | Implemented on development branch |
| Output Quality Guard | Target-aware deterministic findings + document metrics + Runtime Semantic Judge observe + Semantic Rewrite Policy contract loader + durable decisions + developer benchmark runner | Implemented on development branch |
| SubAgents | Profile-driven foreground/background child runtime + contract-bound sequential Harness delivery | Implemented on development branch |
| Tool permissions | MANUAL / INERTIA / MOMENTUM / YOLO + parent-owned child requests | Implemented on development branch |
| Host shell | Opt-in foreground/background shell_exec + host-owned interpreter profiles + bounded Process Runtime | Implemented on development branch |
| Guided Windows onboarding | Inno Setup + Vesicle-owned interactive Setup | Implemented on development branch |

## Current Scope

The 1.0 alpha makes Vesicle a credible direct API host for Prism Engine, not just a
Chat wrapper:

User-facing documentation is intentionally limited during this alpha. Treat the Windows-first `docs/user/` manual, README installation and first-run guide, `vesicle doctor`, `vesicle prompt shape --engine <id>`, and `docs/examples/` as the supported onboarding references; other behavior is subject to alpha-level change while feature/fix work remains the priority.

- Resolve each logical `assets/...` file through sparse project overrides, user-global overrides, then one complete verified V10 baseline without exposing physical paths to the model. The baseline is either a project-pinned managed Harness Pack or the packaged/standalone bundled `prism-engine-v10@10.0.1-alpha.3` Pack. A restricted host layer supplies only the two external base prompts and five generic Vesicle Agent Profiles. Load engine profiles from `assets/engines/*.yaml` and drive systemPrompt,
  tool surface, validators, and stop gates from them at runtime.
- Run a terminal UI with provider status, markdown-rendered conversation with
  terminal-readable LaTeX math cleanup and readable fallbacks for common
  Markdown extension syntax,
  inline tool and artifact cards, a responsive workspace sidebar, a filtered
  slash-command candidate menu, prompt history recall, and input bar. The
  command menu supports Up/Down or Ctrl+P/Ctrl+N selection, Tab/Enter
  completion, and Escape cancellation.
- Compile standalone Windows PE and Linux ELF binaries with the OpenTUI
  tree-sitter worker embedded as a flat Bun worker entrypoint. Prompt and
  profile runtime files remain an external V10 release pack containing `harness-manifest.json`, `assets/`, and `host-assets/`; executables preserve the invocation directory as the project root and locate defaults beside the executable. `vesicle debug
  markdown-runtime` is the non-interactive runtime smoke check and `bun run
  build:assets` creates the release ZIP.
- Build a single-download per-user Windows installer around the complete standalone V10 payload. Its completion page launches `vesicle setup`, where OpenAI-compatible users enter a Base URL and masked API key, discover `/v1/models`, select and add models, optionally configure Tavily and Streamable HTTP MCP, and choose a safe permission preset without editing YAML. Setup provides explicit backward navigation, compacts safely in small terminal windows, may create a folder for its one-time first launch, and never persists one global project. The installer exposes the native `vesicle.exe` command and Explorer directory action, removes legacy launchers on upgrade, and presents Reinstall / Repair / Uninstall maintenance choices when rerun; existing user configuration and project state remain untouched.
- Publish an npm/Bun package with pinned runtime dependencies, the exact bundled V10 Harness inventory, its root manifest, and the restricted host extension layer. Package invocations resolve their installed OpenTUI worker and runtime assets independently of the active project directory. `vesicle assets verify/install/use/status/rollback` manages already-extracted offline Harness Packs and the project lock; `assets materialize <assets/path> [--global]` creates sparse project or user overrides, and `assets init [--global]` retains full-snapshot compatibility.
- GitHub Actions CI and tag-triggered publication call one reusable Linux/Windows release build. PR and `develop` CI retain short-lived versioned PE, ELF, assets-ZIP, and installer artifacts for review and human acceptance.
- Pushing a protected annotated `v<package.json version>` tag on the accepted `main` commit is the publication authorization. The workflow rejects tags outside `main`, reruns the shared release gates, creates the GitHub Release with SHA-256 checksums, and runs npm Trusted Publishing with provenance without normal browser dispatch or GitHub Environment approval. Future SignPath signing approval remains a separate manual trust gate.
- Public [`CODE_SIGNING_POLICY.md`](./CODE_SIGNING_POLICY.md) and [`PRIVACY.md`](./PRIVACY.md) documents define the intended SignPath Authenticode scope, mandatory per-request human approval, historical unsigned-artifact boundary, local data retention, external-service transfers, and user deletion controls. The SignPath application was submitted on 2026-07-15. While approval and CI integration are pending, `1.0.0-alpha.2` is an explicitly disclosed unsigned exception for the informed alpha group; public-trust signing becomes mandatory no later than `1.0.0-beta.1`.
- Attach PNG, JPEG, GIF, or WebP clipboard images through `Alt+V` (including
  `Ctrl+Alt+V` when reported under WSL). Image references are atomic composer
  elements, survive history/rewind/session resume, and are sent only when the
  selected model declares `capabilities.vision`.
- Inspect or switch Prism engine profiles through `/engine [id]`; subsequent
  provider turns and gate resolution use the active engine, and session resume
  restores the saved selection.
- Allow models to request a user-confirmed engine handoff with
  `request_engine_switch`; confirmed handoffs write session metadata and take
  effect on future turns instead of continuing the current tool loop under a
  new system prompt. Rejected handoffs are returned as the handoff tool result
  and continue the loop under the current engine. Manual `/engine`
  switches and confirmed model handoffs now share a persisted transition
  record; confirmed or in-session switches append a bounded user-role
  `engine_handoff` packet for the next provider turn so OpenAI-compatible,
  Anthropic Messages, and Gemini adapters all see the handoff without dynamic
  system-prompt mutation.
- Allow models to ask one user-facing single-select question with
  `ask_user_question`; the TUI renders the model's 2-4 options in order,
  appends host-owned Skip and open-ended answer fallbacks, keeps arrow-key
  selection inside the question panel, and continues the current engine loop
  after the user chooses.
- Route the main prompt box through a host-owned Claude Code-style multiline
  composer instead of OpenTUI's built-in single-line input. Draft editing keys
  are isolated from request interruption: Backspace/Delete edit text,
  `Ctrl+Enter` inserts newlines, `Shift+Enter` is inert when the terminal
  reports it distinctly, plain Enter submits, and Up/Down move within
  soft-wrapped or explicit multiline drafts before prompt-history fallback.
  Long continuous pasted text soft-wraps inside a cursor-following viewport,
  and the bottom input area expands when the draft needs multiple visual rows.
  Trailing backslash+Enter remains a compatibility newline fallback.
- Call OpenAI-compatible Chat Completions endpoints, Anthropic Messages
  endpoints, and Gemini `generateContent` endpoints, including SSE streaming
  on all three protocols.
- Retry transient provider connection failures and retryable HTTP responses
  (408, 429, and 5xx) twice with bounded exponential backoff, jitter, and
  `Retry-After` support. Esc cancellation interrupts both requests and
  backoff; an SSE body that has started producing output is not replayed.
- Normalize outbound application headers by protocol: OpenAI-compatible Chat
  follows the audited OpenCode shape, Anthropic Messages follows the Claude
  Code fingerprint, and Gemini follows Gemini CLI / Google GenAI SDK headers.
  The branded `User-Agent` derives its versions at runtime and supports an
  optional provider-level `userAgent` override.
- Load multiple OpenAI-compatible provider/model profiles from the user-level
  provider config (`%APPDATA%\prism-vesicle\providers.yaml` on Windows,
  `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` or
  `~/.config/prism-vesicle/providers.yaml` elsewhere); the TUI can switch
  provider/model through a two-step `/model` picker or direct command forms.
  Direct input offers provider completion after the first argument space and
  provider-scoped model completion after the second. Provider files name
  `apiKeyEnv` variables only; actual secrets stay in the same user-level
  directory's `.env` file, with process environment variables used only as
  fallback.
- Offer fixed-value argument completion for `/engine`, `/effort`, and
  `/reasoning`, using the same filtered Up/Down, Ctrl+P/Ctrl+N, Tab, Enter, and
  Escape interaction as command and model completion.
- Configure a provider-level `defaultModel` plus low-frequency model defaults
  in `providers.yaml` object model entries: `generation.temperature`,
  `generation.maxTokens`, capability metadata for display and future protocol
  gating, and optional `limits` metadata for context-window display. String
  model entries remain supported.
- Normalize provider response usage across OpenAI-compatible Chat Completions,
  Anthropic Messages, and Gemini `generateContent`. Sessions persist the
  counters as host-only metadata, and the TUI footer shows de-duplicated
  logical-turn upstream/downstream token totals (`↑`/`↓`), cached-input hits
  (`↻`), and latest request context-window percentage when configured. Session
  totals add those logical-turn summaries instead of re-counting repeated
  provider context sends inside tool loops.
- Control thinking behavior for subsequent TUI turns with
  `/effort off|low|medium|high|xhigh|max`; `/effort auto` clears the explicit
  choice. Unset sessions preserve the provider/model default instead of
  sending control fields.
- Show provider `reasoning_content` as a separate TUI thinking block before
  assistant text, with `/reasoning hidden|collapsed|expanded`; the default
  collapsed mode keeps long reasoning bounded to a short tail preview.
- Preserve provider thinking state as session-replayed thinking blocks, with
  OpenAI-compatible `reasoning_content` mapped into that structure as a bridge
  and Anthropic `thinking` / `redacted_thinking` content blocks preserved
  natively.
- Persist sessions as JSONL under `.vesicle/sessions/`; resume them through a
  TUI picker, including unresolved `request_confirmation` gates,
  `request_engine_switch` handoff confirmations, and `ask_user_question`
  prompts.
- Store session records as an append-only `uuid` / `parentUuid` graph. `/rewind`
  and its `/checkpoint` alias select a real user prompt, restore the active
  conversation to immediately before that prompt, refill it for editing, and
  let the next submission fork without deleting the abandoned JSONL branch.
- Compact active provider context with `/compact [notes]`, which summarizes
  the current branch through the active provider, starts a new compact branch
  after the initial system record, and keeps the summary as user-role provider
  context. Manual `/engine <id> --summary [notes]` reuses the same summary
  path before switching engines; model-requested engine switches expose a
  `Confirm with summary` choice that confirms the handoff and then compacts
  the new target-engine context.
- Inspect active model context state with `/context`; it reports configured
  context limits, latest provider-reported context occupancy, session totals,
  and auto-compact metadata without calling the provider.
- Create default-on file checkpoints per real user turn under
  `.vesicle/file-history/`. Rewind can restore conversation, Vesicle-managed
  code/artifacts, or both, and reports changed files plus insertion/deletion
  counts before confirmation. `Summarize from here` compacts the selected tail
  through the active provider and keeps the selected prompt editable.
- Match Claude Code's Escape contract: empty-input double Esc within 800ms
  opens rewind, non-empty double Esc saves and clears the draft, and Esc during
  generation aborts the active provider request. Modal panels continue to own
  Escape while visible.
- Persist successful filesystem tool operations as structured `fileEvent`
  metadata on session tool records, so generated file changes can be replayed
  or audited without scraping prose. Create/write/replace/append events also
  record the SHA-256 of the complete resulting file for post-image quality tracking.
- Load independent Agent Profiles from the active Harness and restricted host layer through the same user-global and sparse project overlay rules as engine assets. V10 supplies `scene-writer`, `continuity-editor`, and `chapter-reviewer`; Vesicle retains `explore`, `general`, `plan`, `research`, and `reviewer` as a fixed generic host whitelist. Generic host Agents remain ordinary concurrent SubAgents, while arbitrary non-whitelisted project/user Agents must satisfy the active Driver Contract. `spawn_agent` supports foreground joins and non-blocking background work; multiple generic calls in one response launch concurrently. Background results are coalesced in a durable parent inbox and automatically resume an idle parent session. Each child keeps a host-only UUID run id and exposes a short handle such as `explore-1` to models and users. Dedicated Agent cards update in place; active/ready background work remains visible in the header and Workspace sidebar. `/agents [handle]` lists or inspects child state, `/agents stop <handle>` interrupts queued or running work, and `/agents retry` retries delivery after an exhausted provider error.
- Search the live web through Tavily-backed `web_search`, extract readable page
  content through `web_fetch`, discover site URLs through `web_map`, run bounded
  multi-page extraction through `web_crawl`, and request cited synthesis through
  `web_research` on ETL and Evaluate profiles. Web results are structured tool
  output; durable research captures are written separately under
  `source_materials/`.
- Load optional user-level MCP servers from `mcp.yaml` beside `providers.yaml`
  (or `VESICLE_MCP_FILE`), connect to Streamable HTTP endpoints, discover
  paginated `tools/list` results, and expose filtered aliases like
  `mcp_prts_search_prts` to scoped engines. MCP headers expand `${ENV_VAR}`
  values from the sibling `.env`, tool results persist structured `mcpEvent`
  metadata, `vesicle doctor` reports server status without printing secret
  headers, and the Workspace sidebar shows configured MCP server ids plus tool
  counts.
- Execute a guarded filesystem tool loop (`stat_path`, `list_files`, `list_directory`,
  `grep_files`, `read_file`, vision-gated `view_image`, `create_file`, `create_directory`, `write_file`, `replace_in_file`,
  `append_file`, `delete_file`, `copy_file`, `move_file`, `move_directory`, `delete_directory`) with a high ceiling
  and a no-progress circuit breaker instead of a coding-agent hard cap.
- Pause the workflow on `request_confirmation` gates; the user confirms or
  rejects, then the loop continues. Empty rejection is valid and tells the
  model to clarify what should change before retrying.
- Validate artifact-shaped ETL output against Module A (character card) and
  Module B (scenario card) v9 schemas; ordinary prose replies are not reported
  as schema failures.
- List or preview generated files through one `/artifact [n|path]` command,
  with bounded Markdown-cleaned previews in the message stream; validate and
  revise them through commands that operate on the actual artifact files.
- Group the sidebar artifact index under the fixed `workspace/`, `novels/`,
  `reports/`, and `test_runs/` roots, preserving useful paths without repeating
  long root prefixes on every row.
- Dump the fully composed system prompt via `vesicle prompt dump --engine <id>`
  for host-pollution auditing, including the effective model-visible tools
  after runtime-added question, handoff, and declared stop-gate tools.

The Prism asset lineage comes from the public sibling repository
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology).

## Repository Structure

```text
prism-vesicle/
├── src/
│   ├── cli/              # CLI entry, doctor, prompt dump
│   │   └── commands/     # prompt-dump subcommand
│   ├── config/           # Environment config loading
│   ├── core/
│   │   ├── artifacts/    # Artifact scanning, preview bounds, validation selection
│   │   ├── agent-loop/   # Provider calls, tool loop, gate pause/resume
│   │   ├── agents/       # Agent profiles, child runtime, scheduling, inbox
│   │   ├── checkpoints/  # Per-turn file snapshots, diff stats, restore
│   │   ├── engine/       # Engine profile YAML loader
│   │   ├── gate/         # request_confirmation tool + GateRequest types
│   │   ├── prompt/       # Prompt loading and composition
│   │   ├── rewind/       # Conversation rewind and partial summarization
│   │   ├── session/      # JSONL session store + resume helpers
│   │   ├── tools/        # Vesicle tool contracts and implementations
│   │   └── validators/   # Module A/B v9 validators + registry
│   ├── providers/        # Provider-neutral types and adapters
│   ├── setup/            # Guided onboarding UI, discovery, config transactions
│   ├── tui/              # OpenTUI/Solid interface, theme, GatePrompt
│   ├── mcp/              # Streamable HTTP MCP tool discovery and execution
│   └── skills/           # Future controlled skill bundle surface
├── assets/
│   └── ...               # Exact 54-file V10 Harness manifest inventory
├── host-assets/
│   ├── agents/           # Five generic Vesicle Agent Profiles
│   └── prompts/          # Host base prompts + generic Agent prompts
├── harness-manifest.json # Bundled prism-harness-pack/v1 identity and hashes
├── docs/
│   └── dev/              # Developer docs and architecture rules
├── dev/
│   ├── docs/             # Ignored local working notes, decisions, and archive
│   └── drafts/           # Ignored local dogfood and miscellaneous material
└── tests/                # Bun tests
```

## Tool Surface

| Tool | Status | Write scope |
|------|--------|-------------|
| `stat_path` | Implemented | Read-only |
| `list_files` | Implemented | Read-only |
| `list_directory` | Implemented, structured entries with bounded recursion | Read-only |
| `grep_files` | Implemented | Read-only |
| `read_file` | Implemented, with optional line ranges | Read-only |
| `view_image` | Implemented for vision-capable models | Read-only, guarded image attachment |
| `create_file` | Implemented, no overwrite | Writable roots, including `source_materials/` |
| `create_directory` | Implemented, optional recursive parent creation | Below writable roots; fixed roots protected |
| `write_file` | Implemented, full overwrite | Writable roots, including `source_materials/` |
| `replace_in_file` | Implemented, exact text replacement | Writable roots, including `source_materials/` |
| `append_file` | Implemented | Writable roots, including `source_materials/` |
| `delete_file` | Implemented, files only | Writable roots, including `source_materials/` |
| `copy_file` | Implemented | Source: read roots; target: writable roots |
| `move_file` | Implemented | Writable roots, including `source_materials/` |
| `move_directory` | Implemented, no target overwrite | Below writable roots; fixed roots protected |
| `delete_directory` | Implemented, empty directories only | Below writable roots; fixed roots protected |
| `web_search` | Implemented for ETL/Evaluate via Tavily | No filesystem access |
| `web_fetch` | Implemented for ETL/Evaluate via Tavily Extract | No filesystem access |
| `web_map` | Implemented for ETL/Evaluate via Tavily Map | No filesystem access |
| `web_crawl` | Implemented for ETL/Evaluate via Tavily Crawl | No filesystem access |
| `web_research` | Implemented for ETL/Evaluate via Tavily Research | No filesystem access |
| `mcp_<prefix>_<tool>` | Implemented from enabled Streamable HTTP MCP servers | Delegated to configured MCP server |
| `ask_user_question` | Implemented (single-select question + host fallback options) | No filesystem access |
| `request_confirmation` | Implemented (gate) | No filesystem access |
| `request_engine_switch` | Implemented (handoff gate) | No filesystem access |
| `spawn_agent` | Implemented (foreground/background, concurrent) | Delegated Agent Profile scope |
| `list_agents` | Implemented | No filesystem access |
| `send_message` | Implemented (child request boundaries) | No filesystem access |
| `interrupt_agent` | Implemented | No filesystem access |
| `wait_agent` | Implemented (explicit terminal wait and background inbox consumption) | No filesystem access |
| `shell_exec` | Implemented foreground/background behind user-level opt-in, active permission mode, and resolved shell profile | Host-user filesystem/process/network authority; not path-guarded |
| `shell_output` | Implemented for persisted background-shell status/output | Reads bounded `.vesicle/processes/` runtime state |
| `shell_stop` | Implemented for active background-shell cancellation | Terminates the managed process group/tree |
| `config.load` | Internal contract | N/A |
| `prompt.load` | Internal contract | N/A |
| `session.write` | Internal contract | `.vesicle/sessions/` |

All model-visible filesystem paths are project-relative. Absolute paths and
`..` escapes and symbolic-link traversal are rejected. The `request_confirmation` tool is only attached to
a turn when the active engine profile declares at least one stop gate.
Writable project roots are `source_materials/`, `workspace/`, `novels/`,
`reports/`, and `test_runs/`; the Artifact workbench intentionally indexes only
the latter four final-output roots.

## Gate Runtime

| Gate | Engine | Status |
|------|--------|--------|
| `blueprint-confirmation` | etl | Wired (Phase 0) |
| `phase-confirmation` | etl | Wired (Phase artifact checkpoints) |
| `runtime-turn` | runtime | Declared in profile and prompt-bound |

Engines with empty `stopGates` never offer `request_confirmation`, so their
models cannot invoke a gate the host would then have to refuse.
`request_engine_switch` is available to all engines as a user-confirmed
handoff request; target restrictions are intentionally deferred until concrete
workflow transitions settle.

## Validators

| Validator | Engine | Checks |
|-----------|--------|--------|
| `character-card` | etl | Module A v9: frontmatter allowlist, seven sections, Persona Topology subsections, axis counts, L-System leakage |
| `scenario-card` | etl | Module B v9: 3–5 beat map, per-beat fields, tension range, trajectory, legacy field rejection |
| `runtime-packet` | runtime | Three-part turn packet: Hidden Neural Chain (`[!Neural Chain]`), five-line Dynamic HUD markers, L-System leakage (thin MVP; output contract owned by Neural-Narratology) |
| `evaluate-report` | evaluate | Audit report Overall Verdict (PASS/CONDITIONAL/FAIL) and five numbered sections; inline only — file-written reports are not read yet |

Validator failures are advisory — they surface in the TUI and session log but
never abort a turn. Validators run only on artifact-shaped assistant content
(YAML-frontmatter documents), not on ordinary phase-transition prose.

## Known Limits

- Directory tools intentionally omit recursive deletion and directory-tree copying in the first guarded surface. Models must delete contents explicitly before `delete_directory`; `move_directory` never overwrites an existing target.
- SubAgent recursion is disabled in the first runtime. Top-level children run concurrently (default maximum four), but child profiles do not receive the agent-control tools. A process restart marks previously running children as failed and delivers that terminal result; it does not replay an in-flight provider request.
- SubAgent handles are unique within one parent session rather than globally; host-only run ids preserve global storage and recovery identity. Legacy UUID-style Agent references remain accepted but are no longer emitted.
- Concrete Weaver-Orch scene allocation, Evaluate reviewer composition, and artifact merge policy remain Harness responsibilities. Vesicle supplies the generic Agent scheduling, persistence, and delivery substrate. Every active bundled or managed Harness provides a verified Driver Contract. The exact five generic host Agent ids bypass delegation binding and preserve ordinary concurrent SubAgent behavior; every other Agent request must bind to the parent Engine's unique declared delegation, fixed foreground/background mode, purpose, retry limit, and ABI error model. Contract-bound delegations run sequentially, persist attempts and terminal state, and enter the declared resumable user decision point after transient retries are exhausted.
- OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini
  `generateContent` are implemented. OpenAI Responses is deferred.
- Guided model discovery currently targets the OpenAI-compatible `GET /v1/models` response shape. Anthropic and Gemini use their existing provider profiles plus exact manual model ids until their native discovery APIs receive separate adapters. Discovery never infers model capabilities from names.
- The provider registry supports multiple configured providers using
  `openai-chat-compatible`, `anthropic-messages`, or
  `gemini-generate-content`.
- OpenAI-compatible, Anthropic Messages, and Gemini `generateContent` SSE
  streaming are implemented for assistant content deltas, provider thinking
  deltas where available, and streamed tool-call/function-call reconstruction.
- Provider retry covers transport failures before response consumption and
  retryable HTTP statuses. Mid-stream SSE disconnect replay remains deferred
  because replaying partial assistant/tool deltas requires explicit UI and
  tool-loop reconciliation.
- Thinking-tier control maps to OpenAI-compatible `thinking` /
  `reasoning_effort`, Anthropic `thinking`, and Gemini `thinkingConfig`
  request fields. User-visible reasoning is currently a TUI display feature
  for preserved provider thinking blocks; OpenAI Responses thinking surfaces
  are deferred.
- TUI engine switching is manual or model-requested through
  `request_engine_switch`; higher-level workflow scaffolding remains deferred.
- Engine transition context policy supports `preserve_full` and `summary`
  through `/engine --summary` or engine-switch `Confirm with summary`. The
  `fresh` policy remains reserved for a future explicit context-discard
  workflow.
- Gate UI is Select-style for ETL blueprint and phase checkpoints, with a
  dedicated bottom confirmation panel. Workflow B hook selection may still need
  a more specialized selector later.
- Rewind file checkpoints track mutations performed through Vesicle's guarded
  filesystem tools, including nested directory topology. Files or directories changed only by the user or an external process are
  outside that ledger and are not independently discovered as rewind targets.
- MCP currently supports Streamable HTTP tools only. Local stdio servers,
  classic HTTP+SSE, prompts/resources, and background tool-list-change handling
  are deferred.
- Skills are a directory stub, not a runtime integration.
- Long-form engines (Weaver / Weaver-Orch / Dyad) have profiles and prompts
  but no dedicated validators or gate wiring.
- Prompt-cache engineering (PrefixShape hashing, CacheDiagnostics) is deferred.
- `shell_exec` is a user-authorized host command, not an OS sandbox. Its child environment is filtered and its process lifetime/output are bounded, but an approved command can still read or mutate project-external files and use the network. `permissions.yaml` selects `auto`, `posix-sh`, `powershell-7`, `windows-powershell-5.1`, `cmd`, or `git-bash`; Linux/WSL `auto` is `/bin/sh`, while Windows `auto` falls back only within the PowerShell family. Explicit unavailable or cross-platform profiles remove new `shell_exec` launches from the effective surface rather than silently changing command dialect; `shell_output` and `shell_stop` remain available while the capability is enabled so existing work can still be controlled. The resolved executable and runtime policy are part of the approved plan, and the TUI exposes the selected interpreter. Shell-created file changes taint the turn's checkpoint completeness and are not guaranteed to rewind. `runInBackground` returns a managed `shell-N` task immediately; progress and completion remain visible in the TUI, terminal output/status are persisted under `.vesicle/processes/`, and completion is delivered to the next provider turn without polling. A process still running when the Vesicle host restarts is recovered as interrupted rather than replayed.
- Process cleanup terminates the managed shell and ordinary descendants in its process group/tree. Because `shell_exec` is intentionally not an OS sandbox, an explicitly approved command can still use platform facilities such as a new session or external service manager to create work outside that managed tree.
- Asset overlays do not support deletion tombstones. An absent higher-layer file falls back to the next layer; disabling packaged engines/assets will require a future explicit manifest policy rather than magic filenames.
- Bundled and managed Harness verification, immutable managed installation, project selection, exact session identity, and whole-baseline rollback are implemented. With no project lock, Vesicle automatically verifies and activates bundled `prism-engine-v10@10.0.1-alpha.3`; rollback returns to that same baseline. Sessions recorded before the V10 migration have no Harness identity and fail closed on resume. `prism-agent/delegation@1`, `quality-guard/anti-ai-flavor@1`, the finite `quality-detector/document-metrics@1` registry, and `quality-judge/anti-ai-flavor@1` are enforced. The Guard validates the released Rule Pack, matches normalized protected prose with UTF-16 evidence offsets, and evaluates the six published document metrics without executing unknown signal kinds. Metric regex contracts fail closed on unsafe structure or excess total patterns, and every target shares a bounded match-work budget; exhausting that budget delivers an append-only `detector-budget-exhausted` inconclusive warning instead of blocking the turn or reporting clean. Those metrics remain experimental advisory findings even under Runtime's `rewrite` binding; they do not enter blocking policy or spend rewrite attempts. Runtime also sends each deterministic-clean target of at most 30,000 UTF-16 units through a separate current-provider/model Semantic Judge request with no tools or normal conversation history, low generation variance, bounded output, strict JSON/rule/evidence validation, and at most one format repair. Judge findings are observe-only and never enter rewrite policy. Timeout, provider failure, invalid output, and oversize targets deliver with durable inconclusive warnings; session metadata retains only hashes, bounded evidence, provider/model, timing, request count, and bounded usage rather than the candidate or raw Judge response. The developer-only `vesicle quality benchmark` command separately runs an explicit provider/model matrix from a frozen plan, including a bounded per-evaluation Judge timeout that does not alter the interactive 15-second deadline; it appends resumable hash-only measurement rows, reserves two-request format-repair budget before each evaluation, writes Wilson/slice reports without raw candidates or responses, and refuses live provider calls without `--allow-live`. It does not authorize semantic blocking. Stable literal and regex findings retain the target-aware lifecycle: successful prose mutations bind to independent project-relative artifact targets, every complete guarded post-image is reread before delivery, failing Runtime targets receive at most two original-Engine rewrites, and repeated per-target post-image hashes stop the loop. Exhaustion persists an append-only quality warning and decision point instead of reporting ordinary completion; the TUI can authorize one more original-Engine revision, use the current version with its warning, or stop without a provider call. Cancellation, provider failure, and process restart preserve the same decision, while Harness or Rule Pack identity drift disables retry without preventing a local accept/stop record. Session rows mark interrupted or pending quality work, artifact rows mark paths with unresolved warnings, and a later clean post-image writes an explicit resolution. Observe bindings still cover Dyad, Weaver, Weaver-Orch, and Scene Writer; Evaluate and Chapter Reviewer reports remain excluded from recursive enforcement. Archive extraction, online Release discovery, channels, downloads, and automatic updates remain deferred; the offline CLI accepts an already-extracted pack directory.
- Vesicle recognizes `quality-policy/semantic-rewrite@1` for a future exact Harness Pack. When required, the policy schema and artifact are hash-verified and parsed fail-closed: it must be active, allowlist known stable Judge rules, map every rule to a finite confidence threshold, scope exact protocol/model IDs without overlap, and contain non-placeholder calibration digests. The resulting evaluator is intentionally not connected to the rewrite state machine until the calibrated policy, held-out, and preservation gates are complete; the currently bundled Harness remains semantic-observe only.

## Verification

Current standard checks:

```bash
bun run typecheck
bun test
bun run doctor
bun run build:installer:stage
```

Native Windows CI installs pinned Inno Setup, builds the versioned guided installer, performs a silent per-user install plus a second upgrade install, removes simulated legacy executable/wrapper/Start Menu launchers, verifies the native `vesicle.exe` command and Explorer directory actions, runs standalone runtime diagnostics from a separate project directory, silently uninstalls, and proves that user configuration/project sentinels survive while the exact PATH entry and Explorer integration are removed.

The `tests/e2e-gate.test.ts` suite runs against a real provider only when
`BUN_E2E_REAL_PROVIDER=1` is explicitly set. This keeps `bun test`
deterministic even when a developer has provider credentials locally; run that
opt-in command as a recorded dogfood acceptance before a public tag.
Tavily-backed web tools are enabled by setting `TAVILY_API_KEY` in the
same user-level `.env` file or process environment.
MCP tools are enabled by copying `docs/examples/mcp.yaml` to the same
user-level directory as `providers.yaml`, setting `enabled: true`, and adding
the referenced header variables to the sibling `.env`.

## Workflow Docs

- `AGENTS.md`: AI collaborator startup rules and guardrails.
- `CLAUDE.md`: Claude Code collaborator startup rules.
- `docs/dev/WORKFLOW.md`: branch model, rapid-development exception, iteration
  loop, hotfix path, and independent CR process.
- `docs/dev/STYLE.md`: architecture, tool-runtime, prompt, session, and TUI rules.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows Semantic Versioning once releases begin.

## [Unreleased]

### Added

- Added the first-party `stage` consumer narrative Engine. `/stage <character-card-path> <scenario-card-path>` validates guarded Module A and Module B cards, renders the released Stage context template, persists the host-created opening assistant message before the first player action, and freezes source hashes plus rendered context for resume. Stage exposes no model-visible tools, gates, MCP surface, or default rewrite; it validates the shared three-part packet and records `stage.prose` quality observations. Full consumer Neural Chain/HUD rendering remains deferred.
- Added an opt-in experimental Runtime Semantic Judge. User-level `quality.yaml` defaults to `off`, accepts only a registered provider/model and bounded timeout, and is configured through `/quality`; `rewrite` requires an explicit confirmation command. The host records only a secret-free profile snapshot and bounded results, preserves strict Judge parsing and one repair, and rejects pending retry after profile drift. This experimental override is separate from calibrated Policy activation and makes no production-quality or AI-authorship claim.
- Added the developer-only `vesicle quality benchmark` command for PR 6B Semantic Judge measurement. It loads the active verified Harness contract, requires an explicit frozen plan and `--allow-live`, reserves the possible two-request repair path against request/token/cost caps, appends resumable hash-only JSONL rows, and writes per-model Wilson/slice reports without candidate text or raw provider responses. The command records measurement evidence only and cannot enable semantic blocking.
- Benchmark plans can now set `earlyStop.minimumEvaluations` to avoid applying a rate-based early stop before an operational pilot has enough observations; legacy plans retain the previous minimum of one evaluation.
- Added fail-closed support for `quality-policy/semantic-rewrite@1`. A Harness that requires it must publish an active, hash-verified Semantic Rewrite Policy with known stable Judge rules, exact protocol/model scopes, complete per-rule confidence thresholds, and non-placeholder calibration digests. The host exposes only pure eligibility evaluation at this stage; current published Harnesses remain observe-only and semantic findings still cannot enter rewrite decisions.

### Fixed

- Semantic Judge benchmark plans now reject unsupported corpus target types before calling a provider, preventing a mixed corpus from producing a partial run with no report. The current Runtime Judge benchmark explicitly supports only `narrative-prose` targets.
- Developer Semantic Judge benchmarks can now freeze a bounded per-evaluation Judge timeout (1-180 seconds), pass it into the measurement request, and record it in the report without changing the interactive Runtime's 15-second deadline. The timeout participates in the plan hash, so resuming under a different deadline requires a new output path.
- Output Quality Guard artifact enforcement now derives targets only from successful `create_file`, `write_file`, `replace_in_file`, and `append_file` results, reads each guarded path's complete current UTF-8 post-image at the quality boundary, and keeps blocking paths pending independently across rewrites, permission pauses, cancellation, and restart. A clean completion summary or unrelated clean file can no longer make an unchanged bad artifact pass; same-response mutation plus gate rounds are checked after the mutation succeeds.
- Output Quality Guard exhaustion no longer falls through as ordinary completion. Quality events now separate assessment outcome from host action, retain per-target finding summaries, and project legacy events compatibly; append-only warning and resolution records preserve exhausted, unreadable, and oversize targets across restart. The TUI restores interrupted or exhausted revisions as a three-way decision to retry once with the same Engine and verified Harness identity, use the current version with its warning, or stop without a provider call. Quality decisions take priority over gates, unresolved artifact warnings appear in the sidebar and beside resumed gates, and later clean post-images resolve matching warnings explicitly.
- Guided Setup now bounds page descriptions and budgets model-selection rows from the actual compact or regular panel structure, preventing text overlap when Setup starts in a non-maximized Windows Terminal window.
- Fixed-height TUI rows now opt out of implicit OpenTUI word wrapping, and shared measurement, truncation, padding, and composer editing preserve grapheme clusters while using Bun/OpenTUI terminal display columns instead of JavaScript string length. Rewind panels account for visible history, restore errors, and compact confirmation metadata so current-point, warning, error, and hint rows remain separate; Permission and YOLO panels reserve bounded command or warning rows so approval controls remain visible.
- Windows `shell_exec` no longer requires PowerShell 7. The new `shellInterpreter` host profile selects `auto`, `powershell-7`, `windows-powershell-5.1`, `cmd`, `git-bash`, or explicit Linux/WSL `posix-sh`; Windows `auto` falls back only from PowerShell 7 to Windows PowerShell 5.1, while Linux/WSL `auto` remains `/bin/sh`. The resolved executable and runtime policy are bound into the approved plan, PowerShell/CMD output is normalized to UTF-8, model guidance follows the selected command dialect, and unavailable explicit profiles fail closed instead of crossing shell families.
- Guided Setup no longer persists one first-project directory and routes every Start Menu launch back to it. Project choice is optional and one-time, legacy `setup-state.json` pointers are ignored without deletion, invalid launch paths produce one bounded CLI error, and Setup now exposes backward navigation without overlapping compact terminal layouts. Installed Windows users receive a native `vesicle.exe` command plus the per-user Explorer directory action; upgrades remove legacy launchers, and rerunning the installer presents Reinstall / Repair / Uninstall maintenance choices.
- Generic `explore`, `general`, `plan`, `research`, and `reviewer` SubAgents remain ordinary concurrent host Agents while a V10 Harness is active, while undeclared non-host Agent Profiles still fail closed through the Driver Contract.
- Permission pauses no longer render empty assistant bubbles, and the active TUI bottom surface now owns keyboard and paste input through the same modal priority used for rendering.
- The Workspace sidebar now keeps a fixed two-row Shell summary, preventing multiple background tasks from overwriting the Effort, session, and MCP rows in OpenTUI.
- Provider-returned tool calls are now checked against the current effective tool surface before permission evaluation or execution, so YOLO cannot execute a hallucinated `shell_exec` when the host-shell capability is disabled.
- Shell process deadlines now remain active until inherited stdout/stderr pipes close, and successful shell exit also cleans up surviving in-group descendants instead of leaving ordinary child work behind.
- Permission recovery now fails closed across capability/config drift and interrupted multi-tool windows: resumed approvals cannot re-enable a disabled tool, incomplete calls are never replayed, and shell-tainted checkpoints surface a targeted rewind warning.
- MANUAL and INERTIA approvals preserve the existing parallel foreground SubAgent contract by collecting exact per-call decisions before starting the approved Agent batch concurrently; simultaneous parent/child permission prompts resolve the request actually shown.
- Mixed host-tool and SubAgent rounds now persist every already-started SubAgent result before propagating a sibling host-tool failure, preserving the durable tool-call/result pairing for recovery.
- Cancelling a background SubAgent no longer enqueues a synthetic result or wakes the parent Engine for another provider turn. Cancellation remains a durable terminal Agent state, and legacy queued cancellation notices are acknowledged without delivery.
- SubAgent lifecycle and progress events no longer overwrite the parent Engine's Workspace STATUS line. Agent activity remains visible through its dedicated cards, header summary, Agents sidebar, and activity records without causing concurrent parent/child status flicker.
- Interrupted foreground Agents now close their original `spawn_agent` tool call during crash recovery, session restoration blocks background delivery until provider/gate state is coherent, terminal children reject late control requests, and `/agents retry` explicitly resumes a delivery paused after exhausted provider retries.
- npm/Bun installs now expose `vesicle` through an `.mjs` Bun launcher, which
  npm 11 retains during publication.
- Standalone binaries now use their embedded tree-sitter worker even when the
  build directory's `node_modules/` remains reachable, preventing that
  development-only path from overriding the single-file runtime in Linux ELF
  release smoke checks.
- Standalone binaries preserve the directory from which the user launched them as the project root instead of changing into the executable directory. Sessions, workspaces, and project asset overrides therefore stay with the active project while runtime/default files resolve explicitly beside the executable.

### Changed

- Refreshed the complete bundled V10 baseline to exact Neural Narratology Release `harness-20260720-1` / `prism-engine-v10@10.0.1-alpha.7` from commit `aaa171bcf0cbf95b3721382ec4949f5bbb402e9f`. The package, standalone payload, and rollback baseline carry the exact 65-file manifest inventory, Stage profile/template, and Anti-AI-Flavor Rule Pack `0.3.0-alpha.4`.
- Moved the remaining CI and publication JavaScript Actions onto their Node 24 runtime release lines while retaining Bun 1.3.14 for project verification and explicitly installed Node 24 for npm Trusted Publishing. Artifact downloads now also fail on digest mismatches by default.
- Authorized `1.0.0-alpha.2` as an explicitly disclosed unsigned Windows prerelease for the informed alpha group while the submitted SignPath Foundation application is pending. The GitHub Release now prepends a bilingual unsigned-artifact warning, links the code-signing policy, and directs users to `SHA256SUMS.txt`; the temporary publication workflow rejects every other package version until a reviewed signing integration or another explicit alpha decision replaces the pin, and public-trust Authenticode becomes mandatory no later than `1.0.0-beta.1`.
- Consolidated CI and release publication onto one reusable Linux/Windows release build. Pushing a protected annotated version tag on the accepted `main` commit now authorizes the workflow to rerun all gates, create the GitHub Release, and publish npm through Trusted Publishing. The normal path is command-line driven and has no Actions-page dispatch, Candidate workflow, or GitHub Environment approval step; future SignPath signing approval remains a separate manual trust gate, and bootstrap plus CLI retry rules are documented separately.
- Advanced the dogfood candidate to `1.0.0-alpha.2` and made the single-download per-user Windows installer the primary non-technical onboarding path while retaining npm, PE/ELF, and assets-ZIP artifacts for development and expert use.

- Replaced the working-tree V9 recovery assets with a complete verified V10 baseline. A no-lock project now automatically activates bundled V10; the runtime distribution contains the exact Harness manifest inventory, root `harness-manifest.json`, and a restricted 12-file host extension layer. V9 remains available only through Git history.
- Runtime assets now resolve file by file through sparse project overrides, user-global overrides under the Vesicle configuration directory, one verified managed or bundled V10 baseline, and the restricted host extension layer. Directory listings merge the active resolution stack, while model-visible file tools retain logical `assets/...` paths and never expose physical global or package locations.
- New sessions persist the bundled or managed Harness identity. Sessions created before the bundled V10 migration have no compatible identity and are blocked on resume instead of silently continuing under different prompt, Driver, or Quality Guard contracts.
- New sessions persist a content-only fingerprint of the effective merged asset tree. TUI resume and continued turns warn when the active profile, prompt, spec, template, or protocol assets drift without persisting prompt contents or absolute paths.

- Reorganized the root README into a concise installation and onboarding entry point, moved detailed implementation inventory behind `STATUS.md`, established natural line wrapping as the Markdown prose convention, added synchronized Simplified Chinese editions of the README and contribution guide, and introduced a bilingual Windows-first user manual covering computer basics through a complete gated Module A and choice-driven Module B ETL workflow.
- Renamed the npm/Bun package from the unowned scoped candidate
  `@prism/vesicle` to the available public package name `prism-vesicle`.
- Declared the public alpha documentation boundary: setup, diagnostics, prompt
  shape inspection, and bundled examples are the supported onboarding path;
  comprehensive user documentation is intentionally deferred while feature and
  fix work remains the priority.
- Prepared the public `1.0.0-alpha.1` release contract: deterministic tests no
  longer run a real provider merely because local credentials exist, npm
  packages contain only runtime files with pinned dependencies, package assets
  and the OpenTUI worker resolve independently of the caller's cwd, and
  `vesicle assets init` creates an editable project-local asset copy.
- The release pipeline builds versioned PE, ELF, editable assets ZIP, Windows installer, and SHA-256 checksums after the same shared gates; pushing the protected `main` version tag is the sole normal publication action.

### Added

- Added `quality-judge/anti-ai-flavor@1` as a Runtime-only observe layer. Vesicle loads the verified rubric, Judge rules, and result schema; sends each bounded target through the current provider/model with no tools or ordinary conversation history; strictly validates JSON, known rule ids, exact-substring evidence, and one format repair; and records provider/model, timing, request count, and bounded usage without persisting the candidate or raw Judge response in quality metadata. Semantic findings never enter rewrite policy. Timeout, cancellation, provider failure, invalid output, and the 30,000 UTF-16 target limit are covered across OpenAI-compatible, Anthropic Messages, Gemini, streaming, non-streaming, session replay, and TUI status paths.
- Added the finite `quality-detector/document-metrics@1` registry for six published Chinese narrative signals: micro-action repetition, action-list density, cliché density, metaphor density, reasoning-chain density, and abstract-summary density. Vesicle executes the bundled Rule Pack's exact thresholds, pattern buckets, visible-character denominator, dialogue exclusions, and host conformance corpus while rejecting unknown, malformed, or potentially unsafe metric regex contracts before they run. A per-target match-work budget turns pathological dense input into a durable inconclusive warning instead of blocking the turn or reporting clean. These experimental findings remain advisory in every mode and never authorize Runtime rewrite or claim AI authorship.
- Added bilingual public code-signing and privacy policies for the SignPath Foundation application. They define the intended Windows Authenticode scope and manual approval roles, preserve the unsigned status of historical artifacts, document signature verification and incident handling, and explain local state, external-service transfers, uninstall preservation, and deletion controls.

- Added `vesicle setup`, a full-screen guided onboarding flow that accepts an OpenAI-compatible Base URL and masked API key, discovers `GET /v1/models`, offers checkbox model selection plus exact manual model ids, chooses a default model, and saves validated user-level configuration with timestamped backups. Optional Tavily, Streamable HTTP MCP authentication/testing/Engine scoping, safe permission presets, and first-project creation are integrated without requiring YAML editing.
- Added an Inno Setup 6 per-user Windows installer with a stable upgrade identity, complete standalone V10 payload, Start Menu Setup/Doctor entries, exact user-PATH add/remove behavior, preserved user/project state, and Windows CI install/runtime/uninstall smoke coverage. PR CI and tag-triggered publishing carry the versioned installer alongside the portable artifacts.

- Deterministic `quality-guard/anti-ai-flavor@1` enforcement for verified Harness Packs. Vesicle now validates the released Rule Pack and detector contracts, preserves normalized UTF-16 evidence offsets across protected Markdown/HUD regions, buffers Runtime prose until Guard policy resolves, requests at most two rewrites from the original Runtime Engine, stops on repeated candidate hashes, and persists resumable bounded QualityEvents. Dyad, Weaver, Weaver-Orch, and Scene Writer use the released observe paths; Evaluate and Chapter Reviewer reports are not recursively guarded.
- Contract-bound `prism-agent/delegation@1` over the existing SubAgent runtime. Verified Driver Contracts now uniquely bind parent Engine, Agent Profile, execution mode, purpose, and retry limit; reject undeclared, ambiguous, or mode-escalating requests; serialize Harness delegations; normalize Driver ABI errors; persist attempt and terminal metadata; and open the declared resumable user decision point when transient retries are exhausted. Child tool calls continue through the parent `/permissions` broker and existing Tool Runtime guards.
- Added a fail-closed Prism Harness Pack foundation with strict `prism-harness-pack/v1` parsing, exact file/hash and Profile/Prompt binding verification, Adapter/capability compatibility checks, external host asset validation, and staging-based immutable directory installation. `/permissions` remains the sole tool-call authorization layer rather than being duplicated in Harness or HAL.
- Added the minimum offline managed-Harness lifecycle: `vesicle assets verify`, `install`, `use`, `status`, and `rollback` accept already-extracted packs, persist exact project and session identity, reverify immutable content on activation and resume, and select one complete managed baseline below sparse project/user overrides. Missing managed files cannot fall through to bundled V10; only declared external host assets and the fixed generic host Agent whitelist remain available, and rollback atomically restores the whole bundled V10 baseline.

- Claude Code-aligned background shell execution through `shell_exec.runInBackground`: commands return a managed `shell-N` task immediately, persist bounded status/output under `.vesicle/processes/`, notify the next provider turn on completion, and expose `shell_output` and `shell_stop` controls. Foreground and background shell cards now show live tail output, elapsed time, task ids, terminal status, and active header/sidebar summaries.
- Four coarse Tool Permission Runtime modes: MANUAL asks for every tool, INERTIA auto-allows observation tools, MOMENTUM auto-allows all tools except `shell_exec`, and YOLO auto-allows the effective tool surface after two red confirmations. MCP tools are always treated as side-effecting, and SubAgent requests route through the parent TUI.
- Opt-in non-interactive `shell_exec` backed by a bounded cross-platform Process Runtime: fixed project cwd, filtered child environment, separate stdout/stderr limits, wall-clock timeout, process-tree termination, exact-plan approval hashes, durable request/resolution/process metadata, and no replay after indeterminate crash recovery.
- User-level `permissions.yaml`, `/permissions`, and the process-scoped `--dangerously-skip-permissions` override. Persistent YOLO defaults are refused and resumed YOLO sessions downgrade to MOMENTUM unless the dangerous CLI override is active.

- Guarded directory tools let models inspect files and empty directories with `list_directory`, create nested directories with `create_directory`, move or rename directory trees with `move_directory`, and delete empty non-root directories with `delete_directory`. File checkpoints now preserve directory topology, parallel Agent write ownership detects ancestor/descendant conflicts, and model-visible project paths reject symbolic-link traversal.

- Profile-driven SubAgent runtime with bundled Explore, Plan, Research, Reviewer, and General agents plus sparse project/user Agent Profile overrides under `assets/agents/`. Foreground children pause only the parent model loop while streaming progress; background children return immediately, run concurrently, persist completion in a durable parent inbox, and trigger an automatic parent continuation when the session is idle. The model can spawn, list, message, interrupt, and explicitly wait for children, while the TUI exposes `/agents` status and cancellation.
- Parent/child SubAgent metadata, concurrency management, crash recovery, foreground cancellation propagation, background-result coalescing, child usage capture, explicit-wait inbox consumption, and child/parent parallel-write ownership checks.
- First-class SubAgent observability in the TUI: dedicated lifecycle cards, live progress and bounded result previews, persistent active/ready summaries in the header and Workspace sidebar, background delivery states, restored cards on session resume, and `/agents <handle>` detail with argument completion.
- Dual SubAgent identity: opaque UUID `runId` values remain host-only while model tools and user commands use stable parent-scoped handles such as `explore-1`. Existing UUID metadata and control references remain compatible.

- `vesicle assets status`, `vesicle assets materialize <assets/path> [--global]`, and global `vesicle assets init --global` support inspecting and creating user-wide or project-specific editable asset layers. Existing full project initialization remains compatible, while sparse materialization is the recommended upgrade-safe path.

- Standalone builds now embed OpenTUI's tree-sitter worker through a flat Bun
  worker entrypoint, avoiding an external `node_modules/` runtime bundle. The
  new `vesicle debug markdown-runtime` command verifies the worker, WASM
  runtime, and fixed Markdown/TypeScript highlight probes without starting the
  TUI. Windows now uses full Markdown by default again; set
  `VESICLE_MARKDOWN_RENDERER=plain` for an explicit fallback. Editable Prism
  `assets/` remain a separate release pack.
- `bun run build:assets` now creates the separately distributed editable
  `dist/prism-vesicle-assets.zip` release pack.
- GitHub Actions CI now validates Linux ELF and native Windows PE release shapes, including the standalone Markdown runtime diagnostic and external assets. Pull-request runs upload short-lived versioned artifacts for review without publishing a GitHub Release or npm package.

- Protocol-specific outbound request header profiles aligned with audited
  OpenCode Chat Completions, Claude Code Messages, and Gemini CLI behavior.
  Vesicle now emits a branded `User-Agent` derived from `package.json` and the
  active Bun runtime, supports an optional provider-level `userAgent` override,
  preserves protocol-native streaming `Accept` behavior, and updates the
  Anthropic Stainless retry counter on each transport attempt.
- Provider requests now retry pre-response network failures, HTTP 408/429,
  and 5xx responses up to two times with bounded exponential backoff, jitter,
  and `Retry-After` support across OpenAI-compatible, Anthropic Messages, and
  Gemini adapters. Cancellation interrupts backoff immediately; partially
  consumed SSE streams are never replayed implicitly.
- Multimodal image input across OpenAI-compatible Chat, Anthropic Messages,
  and Gemini generateContent providers. Models opt in with
  `capabilities.vision: true`; the TUI accepts clipboard images with `Alt+V`
  (and WSL-compatible `Ctrl+Alt+V`), keeps atomic `[Image #N]` elements through
  history/rewind/resume, and permits image-only turns.
- Content-addressed image storage under `.vesicle/attachments/`. Session JSONL
  records persist bounded metadata and file references, while base64 exists
  only on the in-memory provider request copy.
- A guarded `view_image` tool for PNG, JPEG, GIF, and WebP files under allowed
  roots such as `source_materials/`. It returns native multimodal tool-result
  content and is hidden when the selected model does not declare vision support.

- `/context` shows the active provider/model context state without calling the
  provider, including configured model limits, latest provider-reported context
  occupancy, session token totals, and auto-compact metadata.
- Model entries in user-level `providers.yaml` now support optional `limits`
  metadata (`contextWindow`, `maxOutputTokens`, and `autoCompact`) used for
  context-window telemetry.
- Streamable HTTP MCP tool integration: optional user-level `mcp.yaml` beside
  `providers.yaml` can declare enabled servers, headers with `${ENV_VAR}`
  expansion from the sibling `.env`, tool prefixes, include/exclude filters,
  engine scoping, and timeouts. Discovered MCP tools are exposed as
  `mcp_<prefix>_<tool>` aliases, execute through `tools/call`, surface
  structured `mcpEvent` session metadata, appear in prompt dumps, and are
  reported by `vesicle doctor` without printing secret header values.
- The left Workspace sidebar now shows a compact MCP status section, including
  configured server ids and discovered tool counts, without showing endpoint
  URLs or header values.
- Engine switches now persist a unified transition record for both manual
  `/engine` changes and model-requested `request_engine_switch` handoffs.
  Confirmed switches also append a bounded user-role `engine_handoff` packet
  so OpenAI-compatible, Anthropic Messages, and Gemini providers all receive
  the same target-engine context without mutating the dynamic system prompt.
- `/compact [notes]` now summarizes the active session through the configured
  provider and replaces old provider context with a user-role conversation
  summary on a new append-only branch. `/engine <id> --summary [notes]`
  compacts first, then switches with an engine transition whose context policy
  is `summary`; model-requested engine handoffs now also offer `Confirm with
  summary` in the confirmation panel. `fresh` remains reserved for a future
  explicit discard mode.
- Provider responses now normalize runtime usage metadata across
  OpenAI-compatible, Anthropic Messages, and Gemini adapters. The TUI footer
  shows compact logical-turn upstream/downstream token totals (`↑`/`↓`),
  cached-input hits (`↻`), and context-window percentage when configured, plus
  session-level totals that add those logical-turn summaries instead of
  re-counting repeated context sends inside tool loops. Sessions persist the
  underlying provider telemetry as host-only metadata for resume. Host-only
  engine switch confirmations leave token telemetry unchanged; rejected switch
  continuations start a new measured provider turn.
- Tavily-backed `web_search`, `web_fetch`, `web_map`, `web_crawl`, and
  `web_research` host tools for ETL and Evaluate turns. The tools read
  `TAVILY_API_KEY` from the user-level `.env` or process environment, return
  cited source discovery, URL extraction, site maps, bounded crawls, or research
  synthesis, and persist structured `webEvent` metadata in session tool
  records.
- Provider/model registry: a user-level `providers.yaml` can declare multiple
  providers and models plus an optional provider-level `defaultModel`. The TUI
  offers a two-step `/model` picker, provider-default shortcuts, exact
  provider/model selection, and the established active-provider model form.
- Artifact workbench commands: one `/artifact [n|path]` entry point lists or
  previews generated files, while `/validate` checks the selected file on disk.
  Artifact previews render as bounded, structure-preserving cards in the
  message stream.
- Claude Code-compatible rewind: `/rewind` (alias `/checkpoint`) and empty-input
  double Esc open one message selector that can restore conversation, file
  checkpoints, both together, or summarize from a selected prompt. Rewind
  restores the selected prompt into the composer and forks future turns while
  preserving abandoned branches in append-only session JSONL.
- Per-user-turn file checkpoints under `.vesicle/file-history/`, including
  pre-mutation backups for every guarded filesystem mutation, changed-file and
  insertion/deletion previews, a 100-snapshot active limit, branch-aware
  resume, and code-only restoration.
- Provider cancellation via `AbortSignal` for OpenAI-compatible, Anthropic
  Messages, and Gemini requests. Esc during generation interrupts the request;
  an early interruption restores the submitted prompt for editing.
- Filesystem tool v2 surface: `stat_path`, `grep_files`, ranged `read_file`,
  vision-gated `view_image`,
  `create_file`, `replace_in_file`, `append_file`, `delete_file`, `copy_file`,
  and `move_file`, all behind the existing project-relative path guards and
  artifact-root write boundaries.
- File tool operation ledger: successful filesystem tools now emit structured
  `fileEvent` metadata through agent-loop activity events and session JSONL
  tool records.
- OpenAI-compatible Chat Completions streaming path: provider responses now use
  SSE when available, emitting assistant content deltas and reconstructing
  streamed `tool_calls` into the same final `VesicleResponse` shape used by
  non-streaming calls.
- Agent-loop streaming events for assistant deltas and streamed tool-call
  deltas.
- TUI live assistant draft rendering while a provider response is in flight.
- TUI `/effort off|low|medium|high|xhigh|max` command for runtime thinking-effort
  control, plus `/effort auto`/`unset` to return to provider defaults. Selected
  tiers are passed through the agent loop, persisted in session metadata, and
  restored on resume.
- TUI `/reasoning hidden|collapsed|expanded` command and independent thinking
  blocks for provider `reasoning_content`, including live streamed reasoning
  display and bounded collapsed/expanded tail views.
- TUI `/engine [id]` command for manual Prism engine inspection and switching;
  the selected engine is persisted in session metadata and restored on resume.
- `request_engine_switch` model-visible handoff tool, which pauses for TUI
  confirmation and switches the active engine only for future turns after the
  user confirms.
- `ask_user_question` model-visible clarification tool, following the
  reference-project `AskUserQuestion` naming pattern while using Vesicle's
  snake_case tool names. It pauses for one single-select user question with
  2-4 model options plus host-owned Skip and open-ended answer fallbacks, keeps
  question-panel arrow-key selection from scrolling the message history, and
  resumes the current engine loop after selection.
- Object model entries in `providers.yaml` for config-driven generation
  defaults (`temperature`, `maxTokens`) and model capability metadata, while
  preserving existing string model entries.
- Anthropic Messages provider protocol for non-streaming text responses,
  `tool_use` / `tool_result` loops, and `thinking` / `redacted_thinking` block
  preservation.
- Anthropic Messages SSE streaming for text deltas, thinking deltas,
  streamed tool-use JSON, and final response reconstruction.
- Gemini `generateContent` provider protocol for non-streaming and SSE
  streaming text, function calls / function responses, thinking-effort controls,
  thought-summary display, and `thoughtSignature` replay across tool loops.
- `bun run build:exe` compiles the CLI into standalone executables: from WSL it
  cross-compiles both a Windows PE (`prism-vesicle.exe`, for the dogfood `.exe`
  distribution) and a host ELF (`prism-vesicle`) in one run, fetching the
  os-gated `@opentui/core-win32-x64` native on demand (Bun's installer skips it
  on Linux). Pass `windows` or `linux` to build a single target. The compiled
  binary loads its immutable default `assets/` beside `process.execPath`, so
  distribute it next to the `assets/` folder while launching from the project
  working directory.
- Runtime engine now declares a `runtime-packet` validator: a thin MVP that
  checks the three-part turn packet (Hidden Neural Chain, five-line Dynamic HUD)
  the current runtime prompt emits, plus L-System leakage.
- Evaluate engine now declares an `evaluate-report` validator: checks the
  audit report's Overall Verdict and five numbered sections. It runs only on
  report content emitted inline; file-written reports are not read yet.
- Validator dispatch is now per-validator applicability instead of a hardcoded
  YAML-frontmatter gate, so non-ETL engines' validators actually fire on their
  own content shapes while ETL behavior is unchanged.
- The prompt composer now opens a filtered slash-command candidate menu while
  typing a command token, with Up/Down or Ctrl+P/Ctrl+N selection, Tab/Enter
  completion, and Escape cancellation. Slash-command definitions and dispatch
  are now kept in a dedicated TUI command subsystem. `/model` continues this
  interaction into its arguments: the first space offers providers and the
  second offers models scoped to the completed provider. `/engine`, `/effort`,
  and `/reasoning` likewise offer their fixed argument values after the first
  space, including alias matching that completes to canonical values.

### Changed

- Assistant messages, streaming drafts, and artifact previews now run through a
  shared Markdown display preparation layer that conservatively converts common
  LaTeX formulas into terminal-readable Unicode outside fenced code blocks.
  The same layer now downgrades common Markdown extension syntax into readable
  terminal text, including `==mark==`, simple `~sub~` / `^sup^`, footnotes,
  definition lists, image alt text, emoji shortcodes, and static fallbacks for
  common inline HTML such as `<u>`, `<mark>`, `<kbd>`, `<abbr>`, and
  `<details>`.
  Artifact previews also strip common Markdown markers before rendering in
  their stable text card, and the shared TUI syntax style registers Prism-toned
  Markdown/code token colours instead of leaving OpenTUI markdown at unstyled
  defaults.
- The main prompt composer now soft-wraps long continuous input and pasted
  text, expands the bottom input area based on visual line count, keeps a
  cursor-following viewport when the draft exceeds the visible height, and
  lets Up/Down move through wrapped visual rows before falling back to prompt
  history.
- Session records now carry `uuid` and `parentUuid`, allowing append-only
  conversation forks. Existing linear JSONL sessions receive deterministic
  implicit parents when loaded and remain resumable.
- Escape follows the Claude Code prompt contract: single empty Escape is a
  no-op, empty-input double Escape opens rewind, and non-empty double Escape
  saves then clears the draft. Ctrl+Q and the existing double Ctrl+C path remain
  explicit exit controls.

- Adopted the "Synaptic Prism" TUI identity palette in `src/tui/theme.ts` — a
  deep cool surface, near-invisible borders, a single emerald prism accent
  (with `success` on teal and a dim-emerald `brandDim`), and a cool→warm role
  spectrum — replacing the generic Tailwind-derived defaults. The accent moved
  from an earlier violet, which read as generic AI-product chrome.
  First step of a broader TUI visual rewrite; layout and message rendering
  follow. `lane*` tokens are reserved for the upcoming per-message spectrum
  lane.
- Message stream boundary treatment (Phase C): each entry now carries a 1-cell
  left "spectrum lane" coloured by role (the glanceable who-said-what
  boundary), with asymmetric containment — user input as a bordered card,
  assistant output as borderless flowing prose; the old `━━━ role` separator
  lines are gone. The header wordmark now takes a per-engine accent colour
  (etl emerald, runtime cyan, evaluate yellow, weaver orange, weaver-orch rose,
  dyad magenta) via a new `engineAccent` helper.
- Tool-call display (Phase D): filesystem tool calls now render inline as
  compact cards instead of flat transcript lines. A mutation tool shows a `●`
  header with the verb and target path plus a folded content preview — a real
  line-level diff (shared context kept as neutral, changed lines marked `+`/`-`)
  for `replace_in_file`, and all-added previews for `create_file`,
  `append_file`, and `write_file`; read-only and structural tools show a
  one-line `●` header. Every content preview carries a per-line file-line-number
  gutter (create/append/write from line 1; `replace_in_file` from the matched
  line), and `replace_in_file` additionally shows a git-style
  `@@ -l,n +l,n @@` hunk header once the tool's result is merged back onto the
  call card. Each call is followed by a `⎿` footer summarising the structured
  outcome (`replaced 1× · 1.2KB`, `replaced 3× · at lines 12, 47, 89 · 1.2KB`
  for `replaceAll`, `read · 42 lines`, `3 matches · truncated`, …) or the error
  on failure. The replace tool records the start line of each matched
  occurrence (`matchLines`) in its `fileEvent` metadata. Long previews fold to a
  bounded head/tail window with an elision marker. Tool cards carry no spectrum
  lane (they are scaffolding beneath the assistant turn, not a conversation
  turn), and the assistant message no longer duplicates a "Tool calls:" text
  list. Resumed sessions reconstruct the same inline cards by correlating each
  stored tool result with its call arguments (carried in the assistant record's
  `toolCalls` metadata) via `callId`; older sessions that predate `matchLines`
  still render `replace_in_file` line numbers via their scalar `matchLineStart`
  field.
- The sidebar status line now tracks the live turn phase — `sending request`,
  `generating response`, and `calling · {tool}` from the moment a tool call
  starts streaming (so a long `write_file` argument body no longer reads as
  "generating response") through execution — instead of holding on "sending
  request" for the whole turn. The phases are derived from existing agent-loop
  events (no loop change); busy phases share the warn colour, completion stays
  on `complete`.
- Each assistant turn now carries a per-turn `▣ {engine}·{model}` marker
  (coloured by `engineAccent`) above its prose, giving every output block an
  engine identity at a glance. Assistant session records now persist `engine`
  and `model`, so resumed sessions reconstruct the marker; live turns tag it
  from the active engine/model. The marker is omitted when the metadata is
  absent (e.g. sessions recorded before this change).
- Visual polish (Phase E): the question panel frame now uses `gateBorder` to
  match the gate panel, giving the two decision overlays a consistent amber
  frame (it previously used the brighter `gateAccent`, so its frame matched its
  heading instead of the gate's frame). An audit confirmed `src/tui` has no
  off-palette colours and emerald remains the sole identity accent outside
  state/role colour. Completes the planned TUI rewrite phases (A–E).
- Engine ids now render with consistent capitalisation in the TUI: a new
  `engineDisplayName` helper maps ids to short labels (etl → ETL, runtime →
  Runtime, weaver-orch → Weaver-Orch; abbreviations uppercased, words
  title-cased). Applied to the header wordmark, the per-turn ▣ marker, the
  `/engine` confirmation and profile list (which now shows `ETL (etl)`
  so the display name and command id are both visible). The stored engine field
  stays the id; only display converts.
- Added `scripts/palette.ts`, a dev utility that prints every theme colour as a
  truecolor swatch (reads live from `src/tui/theme.ts`) for palette iteration.
- Restructured the TUI shell to a stream-first single-sidebar layout: the former
  two-pane status + activity layout becomes one left sidebar (status / thinking
  / session / artifacts); the right-hand Activity pane is removed (agent-loop
  detail will fold into the message stream in a later pass); a bottom telemetry
  footer carries the provider/model/key line. Status moved out of the header
  into the sidebar with semantic colour, and section labels gain a dim emerald
  structural accent. First structural pass of the TUI rewrite.
- TUI polish: idle status reads "ready" (was echoing the provider id, which is
  already in the footer); the header wordmark uses a fixed brand colour,
  leaving turn-state colour solely to the sidebar status; the sidebar reasoning
  line shows the "preview" alias instead of the internal "collapsed".
- The workspace sidebar now groups artifact paths under the fixed
  `workspace/`, `novels/`, `reports/`, and `test_runs/` roots. Rows retain the
  same numeric order used by `/artifact <n>` while spending their width on the
  meaningful path inside each root.
- Shape-near singular/plural command pairs are consolidated: `/artifact`
  lists without arguments and previews with a target, while `/engine` lists
  profiles without arguments and switches with an engine id. The redundant
  `/artifacts` and `/engines` entries are removed.
- Provider thinking control is now `/effort`, clearly separated from the
  `/reasoning` display command. The former command name and the hidden
  `/workflow` alias for `/engine` are removed, leaving `workflow` available for
  a future guided-workflow feature. The canonical medium effort spelling is
  corrected across configuration, sessions, adapters, completion, and docs.
- Reasoning preservation now uses provider-neutral thinking blocks internally,
  while keeping OpenAI-compatible `reasoningContent` as a compatibility bridge.
  Agent-loop events, session replay, and TUI display can now carry provider
  thinking state without flattening it into assistant prose.
- Expanded `AGENTS.md` and `CLAUDE.md` into full AI-collaborator entry points
  that link the repo's workflow, style, status, contribution, provider config,
  verification, and documentation-sweep rules.
- Added a rapid-development workflow exception that treats `develop` as the
  active trunk for low-risk internal iteration while preserving PR/CR flow for
  high-risk or release-bound work.
- Split the OpenAI-compatible provider backend into request shaping, response
  parsing, streaming, wire types, and structured provider errors to harden the
  transport foundation before adding more protocols.
- Provider configuration now requires the user-level `providers.yaml`; Vesicle
  no longer falls back to a single `VESICLE_API_KEY` environment configuration
  when that file is missing.
- Provider API keys can now be loaded from the `.env` file beside the
  user-level `providers.yaml`; that user-level `.env` takes precedence over
  inherited process variables so legacy project-root `.env` files cannot mask
  it.
- `vesicle doctor` now reports whether the user-level provider `.env` file was
  found, without printing secret values.
- OpenAI-compatible request shaping now maps normalized thinking tiers to
  provider wire controls: `off` disables thinking, `low`/`medium`/`high` map to
  high effort, and `xhigh`/`max` map to max effort. Unset sessions keep the
  provider/model default and do not send thinking control fields.
- OpenAI-compatible request shaping now receives generation defaults from the
  selected model config instead of inventing a hardcoded adapter temperature.
- Provider configuration now accepts the `anthropic-messages` protocol and an
  optional `authMethod` (`x-api-key` or `bearer`) for Anthropic-compatible
  endpoints.
- Provider configuration now accepts the `gemini-generate-content` protocol
  and `authMethod: x-goog-api-key` for Gemini API keys.

### Fixed

- Rewind confirmation panels with file changes now reserve enough bottom
  layout height for the `Never mind` option, manual-edit warning, and footer,
  preventing those rows from overlapping in short terminals.
- Filesystem mutation tools now allow `source_materials/` as a writable project
  root. ETL can persist model-generated research and web captures there,
  while `/artifact` remains scoped to
  the four final-output roots.
- `/artifact <n|path>` now renders the selected file in the message stream.
  The former implementation only wrote an unconsumed selection signal and
  claimed the preview was visible in a right-hand pane that had already been
  removed.
- Sidebar artifact numbering now follows the same fixed root order used for
  grouped display (`workspace`, `novels`, `reports`, `test_runs`), with newest
  files first inside each root. Global recency ordering no longer produces
  visibly scrambled indices after grouping. The artifact section now scrolls
  within the remaining sidebar height instead of silently dropping entries
  after the first eight.
- The non-confirm `request_confirmation` and `request_engine_switch` option
  routes typing and paste events to its always-visible Reject composer. The
  `ask_user_question` freeform fallback now shares one activation predicate
  across rendering, keyboard, and paste routing to prevent the same class of
  drift.
- Inline freeform question composers now reserve two layout rows and raise the
  decision panel's minimum height while selected; gate note/reject composers
  reduce the summary budget by one row, preventing option, input, and footer
  overlap in short terminals.
- Non-confirmed `request_engine_switch` decisions now return their tool result
  to the provider and continue under the current engine. Confirmed handoffs
  still switch only future turns without calling the provider under a new
  system prompt.
- Slash-command candidate selection now renders reactively, resets when the
  filter query changes, and remains valid for empty result sets, so arrow keys
  move exactly one visible cursor instead of leaving stale markers behind.
- Provider/model pickers now participate in bottom-layout sizing and cap their
  visible rows to the available terminal height instead of overwriting the
  composer or telemetry footer. Invalid provider `defaultModel` references are
  rejected while loading configuration, and `/model <model>` remains backward
  compatible with active-provider switching.
- Prompt contracts now align user-choice checkpoints with the current
  `ask_user_question` runtime, bind the Runtime engine's `runtime-turn` stop
  gate to `request_confirmation`, and keep RooCode-era mismatched tool names
  such as `ask_followup_questions` and `apply_diff` out of bundled prompts.
- `vesicle prompt dump` / `prompt shape` now report the effective
  model-visible tool surface, including runtime-added `ask_user_question`,
  `request_engine_switch`, and stop-gate-only `request_confirmation`.
- Replaced the main OpenTUI single-line prompt input with a host-owned
  Claude Code-style multiline composer. Backspace/Delete now edit the draft
  instead of leaking into running-turn control, `Ctrl+Enter` inserts newlines,
  `Shift+Enter` is inert when reported distinctly, trailing backslash+Enter
  remains a compatibility newline fallback, and plain Enter submits.
- Windows Ctrl+C selection copying now writes clipboard text through a UTF-8
  base64 bridge before `Set-Clipboard`, avoiding mojibake when copying Chinese
  or other non-ASCII text.
- TUI tool calls/results now render as compact transcript summaries instead of
  dumping full tool arguments or full file contents into the main chat stream.
- Streaming now rejects premature SSE EOF, reports malformed chunks with a
  provider-stream error, retries without OpenAI-specific `stream_options` for
  stricter compatible providers, and preserves the final assistant turn in the
  in-memory conversation history.
- OpenAI-compatible streamed tool-call names now keep the latest provider value
  instead of concatenating repeated `function.name` deltas, avoiding duplicated
  names from non-conformant streams.
- OpenAI-compatible reasoning responses now preserve provider
  `reasoning_content` through non-streaming, streaming, tool-loop follow-up
  requests, and session resume so reasoning models can use tools without losing
  required thinking context.
- TUI provider/model switches now resolve API-key availability through the
  user-level provider `.env`, so `/model` and session resume do not
  incorrectly show "API key: missing" when the selected key is stored there.
- Source TUI startup and compiled-executable startup now use separate OpenTUI
  setup paths: `bun run dev` preloads OpenTUI before importing the TUI, while
  `build:exe` applies the OpenTUI Bun build plugin explicitly, avoids external
  `bunfig.toml` preload lookup, and resolves compiled runtime files without changing the project cwd.
- `bun run build:exe` now succeeds on Linux/macOS. The compile step emits the
  entry basename with a platform-appropriate extension, so the post-build rename
  no longer fails looking for a nonexistent `main.exe` and produces a host-native
  `prism-vesicle` binary outside Windows.

## [0.1.0] - 2026-07-07

### Added

- Engine profile loader: `assets/engines/*.yaml` now drives systemPrompt
  composition, tool resolution, validator names, and declared stop gates at
  runtime. A hand-written YAML parser handles the narrow profile schema with
  no dependency. Profiles that name unknown tools or omit required fields fail
  loudly.
- Stop-gate runtime: the `request_confirmation` tool lets the model pause the
  workflow for user confirmation. The agent loop returns a `needs_user` result;
  `resolveGate()` feeds the decision back and continues. Undeclared gates are
  refused, not paused. ETL Phase 0 blueprint confirmation is wired end-to-end.
- Module A and Module B validators: v9 schema checks for character cards
  (frontmatter field allowlist, seven sections, Persona Topology subsections,
  Invariant/Variant axis counts, positive-shift direction, L-System leakage)
  and scenario cards (3–5 beat map, per-beat fields, tension range, non-
  monotonic trajectory, legacy field rejection).
- `vesicle prompt dump --engine <id>` and `vesicle prompt shape --engine <id>`
  print the fully composed system prompt and profile structure for "is there
  host pollution?" auditing.
- Session resume: `listSessions()` and `loadSessionMessages()` reconstruct
  prior turns. The TUI `/resume`, `/resume <n|id>`, `/new`, and `/help`
  commands manage sessions without hitting the provider.
- Markdown rendering in the TUI: assistant messages render through OpenTUI's
  `<markdown>` component with `conceal`, so headings, lists, emphasis, and code
  spans display as formatted output.
- Select-style gate UI borrowing Claude Code's PermissionPrompt shape:
  numbered Confirm/Reject options, Tab to expand confirm notes, and a
  persistent reject/discussion escape hatch.
- Centralised colour palette and shared syntax style in `src/tui/theme.ts`.

### Changed

- ETL stop gates now include `phase-confirmation` in addition to
  `blueprint-confirmation`, so Phase 1/2 artifact checkpoints use the
  `request_confirmation` tool instead of plain prose pauses.
- The TUI shell is now responsive: narrow terminals use a readable single
  message column, medium terminals add a workspace/artifact sidebar, and wide
  terminals add the activity/artifact pane.
- `/resume` now opens a TUI session picker, and sessions paused at an unresolved
  `request_confirmation` gate can be resumed back into the gate panel. Resumed
  sessions now load prior visible conversation into the message stream.
- ETL validators no longer run on ordinary assistant prose; they run only on
  artifact-shaped YAML-frontmatter assistant output.
- Wide TUI layouts now use the right pane for activity and recent artifacts
  instead of repeating the last assistant output.
- The agent loop emits coarse activity events for provider requests, assistant
  responses, tool calls, gate pauses, and validation.
- The input area now shows slash-command hints and supports Up/Down prompt
  history recall.
- Agent-loop tool ceiling raised 6 -> 40 with a no-progress circuit breaker
  (4 consecutive failing-tool rounds stop the loop and persist the last
  response instead of throwing). Vesicle's controlled file tools do not need
  the strict caps a coding-agent host would impose.
- `RunPromptResult` is now a discriminated union (`complete` | `needs_user`)
  with an optional `validation` outcome on the complete branch.
- ETL engine prompt Phase 0 now instructs an explicit `request_confirmation`
  call instead of prose "wait for user confirmation"; a new Stop Gate contract
  section documents all gated vs conversation-bound points.
- Validator outcomes surface in the TUI message stream and session log;
  failures are advisory and never abort a turn.

### Fixed

- Gate confirmation now renders in a dedicated bottom panel with bounded
  summary text, stable option rows, and no side-panel squeezing at gate time.
- Runtime artifact roots (`workspace/`, `test_runs/`, `novels/`, `reports/`,
  `source_materials/`) are now gitignored with `.gitkeep` stubs, so model/user
  output does not enter git history.

## [0.0.0] - 2026-07-07

### Added

- Added the M0 Bun + TypeScript + OpenTUI project scaffold.
- Added Prism v9 prompt, spec, template, protocol, and engine-profile assets.
- Documented `3aKHP/Neural-Narratology` as the public sibling/source repository
  for Prism Engine assets.
- Added OpenAI-compatible Chat Completions provider support.
- Added JSONL session persistence under `.vesicle/sessions/`.
- Added `list_files`, `read_file`, and `write_file` tool calling through the
  provider loop, with project-relative path guards.
- Added project status, contribution, workflow, and style documentation adapted
  from the user's existing project workflow.
- Added smoke tests for config loading, prompt loading, TUI rendering, session
  reuse, and file-tool execution.

### Changed

- Updated the Vesicle base prompt to require successful `write_file` tool
  results before claiming that artifacts were written.
- Changed Ctrl+C handling to copy selected text when possible and use a
  double-press flow for exit.

### Fixed

- Fixed TUI message prefixes using dangling `role>` markers.
- Fixed the input bar not clearing after submit.
- Fixed per-turn session creation that caused model memory loss across turns.

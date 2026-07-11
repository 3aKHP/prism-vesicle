# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows Semantic Versioning once releases begin.

## [Unreleased]

### Changed

- Declared the public alpha documentation boundary: setup, diagnostics, prompt
  shape inspection, and bundled examples are the supported onboarding path;
  comprehensive user documentation is intentionally deferred while feature and
  fix work remains the priority.
- Prepared the public `1.0.0-alpha.1` release contract: deterministic tests no
  longer run a real provider merely because local credentials exist, npm
  packages contain only runtime files with pinned dependencies, package assets
  and the OpenTUI worker resolve independently of the caller's cwd, and
  `vesicle assets init` creates an editable project-local asset copy.
- Protected matching `v<package.json version>` tags now publish the PE, ELF,
  editable assets ZIP, SHA-256 checksums, and provenance-enabled npm package
  after the same release gates.

### Added

- Standalone builds now embed OpenTUI's tree-sitter worker through a flat Bun
  worker entrypoint, avoiding an external `node_modules/` runtime bundle. The
  new `vesicle debug markdown-runtime` command verifies the worker, WASM
  runtime, and fixed Markdown/TypeScript highlight probes without starting the
  TUI. Windows now uses full Markdown by default again; set
  `VESICLE_MARKDOWN_RENDERER=plain` for an explicit fallback. Editable Prism
  `assets/` remain a separate release pack.
- `bun run build:assets` now creates the separately distributed editable
  `dist/prism-vesicle-assets.zip` release pack.
- GitHub Actions CI now validates Linux ELF and native Windows PE release
  shapes, including the standalone Markdown runtime diagnostic and external
  assets. A manual Release verification workflow uploads labelled candidate
  artifacts without publishing a GitHub Release or npm package.

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
  binary loads `assets/` from its working directory, so distribute it next to
  the `assets/` folder.
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
  `bunfig.toml` preload lookup, and changes cwd before loading project modules.
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

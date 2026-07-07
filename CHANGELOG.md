# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows Semantic Versioning once releases begin.

## [Unreleased]

### Added

- Provider/model registry: a user-level `providers.yaml` can declare multiple
  OpenAI-compatible providers and models, with TUI commands for `/providers`,
  `/models`, `/use`, and `/model`.
- Artifact workbench commands for `/artifacts`, `/artifact`, `/validate`, and
  `/revise`, including validation against the selected artifact file on disk.
- OpenAI-compatible Chat Completions streaming path: provider responses now use
  SSE when available, emitting assistant content deltas and reconstructing
  streamed `tool_calls` into the same final `VesicleResponse` shape used by
  non-streaming calls.
- Agent-loop streaming events for assistant deltas and streamed tool-call
  deltas.
- TUI live assistant draft rendering while a provider response is in flight.
- TUI `/think off|low|midium|high|xhigh|max` command for runtime thinking-tier
  control, plus `/think auto`/`unset` to return to provider defaults. Selected
  tiers are passed through the agent loop, persisted in session metadata, and
  restored on resume.
- TUI `/reasoning hidden|collapsed|expanded` command and independent thinking
  blocks for provider `reasoning_content`, including live streamed reasoning
  display and bounded collapsed/expanded tail views.
- Object model entries in `providers.yaml` for config-driven generation
  defaults (`temperature`, `maxTokens`) and model capability metadata, while
  preserving existing string model entries.

### Changed

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
  provider wire controls: `off` disables thinking, `low`/`midium`/`high` map to
  high effort, and `xhigh`/`max` map to max effort. Unset sessions keep the
  provider/model default and do not send thinking control fields.
- OpenAI-compatible request shaping now receives generation defaults from the
  selected model config instead of inventing a hardcoded adapter temperature.

### Fixed

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
  user-level provider `.env`, so `/use`, `/model`, and session resume do not
  incorrectly show "API key: missing" when the selected key is stored there.

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
- Select-style gate UI borrowing Claude Code's PermissionPrompt shape: numbered
  Confirm/Revise/Chat options, Tab to expand inline feedback, persistent chat
  escape hatch.
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

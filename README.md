# Prism Vesicle

Prism Vesicle is a Bun + TypeScript TUI host for Prism Engine prompts. The
`1.0.0-alpha.1` release is an early public baseline: it loads Prism v9 assets,
hosts provider-driven workflows in a terminal UI, and persists sessions as
append-only JSONL.

Prism Vesicle is a sibling project of the public
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology)
repository, which hosts the Prism Engine / State-Space protocol assets that
Vesicle runs directly.

> **Alpha documentation status:** Vesicle is being released for practical
> dogfood use, not as a fully documented end-user product. The setup steps,
> `vesicle doctor`, `vesicle prompt shape --engine <id>`, and the bundled
> examples are the supported onboarding path for this alpha. Command UX,
> provider details, workflow semantics, and asset conventions may still change
> between alpha releases. We are intentionally prioritizing feature/fix work
> over a comprehensive manual; report a blocker with the command, platform,
> Bun version, and `doctor` output rather than relying on undocumented
> behaviour.

## Quick Start

```bash
bun install
mkdir -p ~/.config/prism-vesicle
cp docs/examples/providers.yaml ~/.config/prism-vesicle/providers.yaml
cp docs/examples/provider.env.example ~/.config/prism-vesicle/.env
# Optional: prepare external MCP tools, then edit mcp.yaml and remove or flip enabled: false.
cp docs/examples/mcp.yaml ~/.config/prism-vesicle/mcp.yaml
```

Edit your user-level provider config and set the environment variables named
by each provider's `apiKeyEnv` in the `.env` file beside it. The default
config path is
`%APPDATA%\prism-vesicle\providers.yaml` on Windows and
`$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` or
`~/.config/prism-vesicle/providers.yaml` on Linux/macOS. Use `/model` to open
the provider/model picker, `/model <provider>` to select that provider's
configured default, or `/model <provider> <model>` for an exact pair. The
established `/model <model>` active-provider form remains supported. Vesicle
shows provider candidates after the first space and that provider's model
candidates after the second; use Up/Down or Ctrl+P/Ctrl+N to select and Tab to
complete. The fixed arguments for `/engine`, `/effort`, and `/reasoning` use the
same popup after their first space. Vesicle starts on the ETL engine profile;
use `/engine` to inspect profiles and `/engine <id>` to switch the active Prism
engine for future turns.
Use `/effort off|low|medium|high|xhigh|max` to set provider thinking effort for
subsequent requests, or `/effort auto` to clear the explicit choice. Before
this command is used, Vesicle leaves thinking behavior at the provider/model
default. Use `/reasoning hidden|collapsed|expanded` to
control whether provider reasoning content is shown in the TUI; the default is
collapsed with a bounded tail preview.
Use `/rewind` (or `/checkpoint`) to open the Claude Code-style rewind picker.
It can restore the conversation, Vesicle-managed file changes, both together,
or summarize from a selected user prompt. With an empty prompt, pressing Esc
twice within 800ms opens the same picker; with a non-empty prompt, double Esc
saves the draft to history and clears it. Esc during generation cancels the
active provider request.
Use `/compact [notes]` to summarize the active session and replace older
provider context with a compact continuation brief. Use
`/engine <id> --summary [notes]` to compact before switching engines; when
the model requests an engine handoff, choose `Confirm with summary` in the
confirmation panel for the same compact-before-next-turn behavior.
Use `/context` to inspect the active model's configured context window, latest
provider-reported context usage, session token totals, and auto-compact
metadata. Footer context percentages appear only when the active model declares
`limits.contextWindow`.
Vision-capable models can accept conversation images. Declare `vision: true`
under the model's `capabilities`, then press `Alt+V` in the main composer to
attach a clipboard image (`Ctrl+Alt+V` is also accepted when reported by the
terminal under WSL). PNG, JPEG, GIF, and WebP images up to 5 MB appear as
atomic `[Image #N]` composer elements and persist under
`.vesicle/attachments/` for history, rewind, and session resume.
The provider file intentionally supports only Vesicle's small YAML subset:
`default`, `providers`, scalar provider fields (including optional
`defaultModel` and `userAgent`), and `models` entries. The canonical templates
live together under `docs/examples/`: `providers.yaml` for the registry and
`mcp.yaml` for optional Streamable HTTP MCP servers, plus
`provider.env.example` for the sibling user-level `.env`.
Models may be simple strings or object entries with `id`, optional
`generation` defaults (`temperature`, `maxTokens`), optional `capabilities`,
and optional `limits` metadata (`contextWindow`, `maxOutputTokens`, and
`autoCompact`). Provider secrets are not read from the YAML file; every
provider must name an `apiKeyEnv` variable and the actual key belongs in the
same user-level directory's `.env` file. Process environment variables are
used only when the user-level `.env` does not define that key. The same
user-level `.env` may also contain `TAVILY_API_KEY`, which enables the
provider-neutral Tavily web tools (`web_search`, `web_fetch`, `web_map`,
`web_crawl`, and `web_research`) for ETL and Evaluate research turns.
Provider requests use protocol-specific application headers aligned with
OpenCode Chat Completions, Claude Code Messages, and Gemini CLI. Their default
`User-Agent` is generated from the package and Bun runtime versions; optional
provider-level `userAgent` replaces only that value without changing the
protocol fingerprint or authentication headers.
The optional `mcp.yaml` in the same directory enables Streamable HTTP MCP
servers. It supports `transport: streamable-http` or the compatibility alias
`transport: http`, `${ENV_VAR}` header expansion from the sibling `.env`, tool
prefixes, include/exclude filters, and `enabledEngines` scoping. Discovered
tools are exposed as aliases such as `mcp_prts_search_prts`.

If you still have an old project-root `.env` from early testing, move the
provider key variables into the user-level `.env` beside `providers.yaml`, then
delete or rename the root file so local runs cannot depend on stale secrets.

Then run:

```bash
bun run doctor
bun run dev
```

### Install from npm

The npm package requires Bun 1.3.14 or newer. It ships package-owned default
assets, so it works from an ordinary project directory without copying
`node_modules` or extracting a binary release pack:

```bash
npm install @prism/vesicle
bunx vesicle prompt shape --engine etl
bunx vesicle
```

To take ownership of editable assets for one project, materialize them once in
that project's current directory. A local `assets/` directory then overrides
the package defaults; the command refuses to overwrite an existing directory.

```bash
bunx vesicle assets init
```

The TUI starts in a responsive workspace view. Type a prompt, press Enter, and
Vesicle sends it through the configured provider. Successful interactions are
stored under `.vesicle/sessions/`; `/resume` opens a session picker and can
return to an unresolved gate. Session messages form append-only branches, and
file checkpoints used by rewind live under `.vesicle/file-history/`. Use
`/artifact` to list generated files and `/artifact <n|path>` to place a bounded,
structure-preserving preview directly in the message stream.

Transient provider connection failures and retryable HTTP responses (408,
429, and 5xx) are retried twice with bounded exponential backoff. Esc cancels
both an active request and any pending retry delay; partially received streams
are not replayed automatically.

## Scripts

- `bun run dev`: launch the TUI
- `bun run doctor`: print runtime, provider configuration, user-level
  provider `.env`, Tavily web-tool key status, and MCP server status
- `bun run typecheck`: TypeScript validation
- `bun test`: deterministic test suite; it never calls a real provider merely
  because local credentials exist
- `BUN_E2E_REAL_PROVIDER=1 bun test tests/e2e-gate.test.ts`: opt-in real
  provider gate acceptance test
- `bun run pack:check`: verify the npm publish allowlist contains only runtime
  files and excludes tests, workflows, and private development material
- `bun run build:exe`: compile the CLI into standalone executables. From WSL it
  produces both a Windows `prism-vesicle.exe` (cross-compiled, for the dogfood
  distribution) and a Linux `prism-vesicle`; pass `windows` or `linux` to build
  one target. The binary embeds its OpenTUI Markdown worker and runtime; ship
  the separately editable `assets/` release pack beside it.
- `bun run build:assets`: create `dist/prism-vesicle-assets.zip`, the editable
  assets release pack that users extract beside either standalone binary.
- `vesicle debug markdown-runtime`: non-interactively verify the OpenTUI worker,
  tree-sitter WASM, and fixed Markdown/TypeScript highlight probes. This is the
  release smoke command for standalone binaries.
- `vesicle prompt dump --engine <id>`: print the fully composed system prompt
  the model receives — the primary "is there host pollution?" audit tool
- `vesicle prompt shape --engine <id>`: print profile structure only

## CI And Release Verification

Pull requests into `develop`/`main` and pushes to `develop` run the GitHub
Actions CI workflow. It typechecks, tests, validates the npm package shape,
builds the Linux ELF and Windows PE, builds the editable assets ZIP, and
smoke-tests each binary beside extracted assets. The manual `Release
verification` workflow uploads candidate artifacts without publishing.

A protected tag matching `v${package.json.version}` runs the publish workflow.
It rebuilds and smokes both binaries, creates a prerelease containing the
Windows PE, Linux ELF, editable assets ZIP, and `SHA256SUMS.txt`, then publishes
the npm package using npm trusted publishing/provenance. Configure the npm
trusted publisher and protect the `v*` tag namespace before creating that tag.

## Current Capabilities

- OpenAI-compatible Chat Completions provider path
- Anthropic Messages provider path for text, streaming, tool calls, and
  thinking block preservation
- Gemini `generateContent` provider path for text, streaming, function calls,
  function responses, thinking-effort controls, and Gemini thought-signature
  replay
- Streaming OpenAI-compatible Chat Completions responses when the provider
  supports SSE, including streamed tool-call reconstruction
- Provider/model registry from the user-level `providers.yaml`, with TUI
  picker and `/model` forms to switch provider and model inside a session
- Manual engine inspection and switching through the single `/engine [id]`
  command for ETL, Runtime, Evaluate, Weaver, Weaver-Orch, and Dyad profiles;
  sessions restore the selected engine on resume. Add `--summary [notes]` to
  compact the current session before switching.
- Model-requested engine switching through `request_engine_switch`: the model
  can ask for a handoff, the TUI asks the user to confirm, and confirmed
  switches affect future turns; rejected handoffs return to the current
  engine so the conversation continues. Manual `/engine` switches and
  confirmed model handoffs share a persisted transition record. Inside an
  existing session, the target engine receives a bounded user-role
  `engine_handoff` packet, preserving compatibility across OpenAI-compatible,
  Anthropic Messages, and Gemini protocols without changing the system prompt.
  Context policy defaults to full preservation; manual `/engine --summary`
  and the engine-switch panel's `Confirm with summary` option use the
  implemented summary policy, while `fresh` remains reserved.
- Model-requested user questions through `ask_user_question`: the model can
  pause with one single-select question and 2-4 model options; the host
  appends Skip and open-ended answer fallbacks, then continues after the user
  chooses
- Config-driven model defaults, capability metadata, and limits metadata in `providers.yaml`:
  provider-level `defaultModel` controls one-argument provider switches;
  low-frequency generation knobs such as `temperature` and `maxTokens` stay in
  config while high-frequency thinking control stays in the TUI. Model
  `limits` metadata drives context-window percentage display and `/context`.
- Provider response usage telemetry is normalized across OpenAI-compatible,
  Anthropic Messages, and Gemini responses. When a provider returns token
  counters, the TUI footer shows logical-turn upstream/downstream token totals
  (`↑`/`↓`), cached-input hits (`↻`), and the latest request's context-window
  percentage when configured. Session totals add those per-turn summaries
  instead of re-counting repeated context sends inside a tool loop; sessions
  persist the underlying provider counters as host-only resume metadata.
  Host-only engine switch confirmations do not change token telemetry;
  rejected switch continuations start a new measured provider turn.
- Runtime thinking-effort control with `/effort off|low|medium|high|xhigh|max`
  plus `/effort auto` to return to provider defaults; adapters map the
  normalized tier to OpenAI-compatible, Anthropic, or Gemini-native thinking
  controls
- Reasoning visibility for models that return `reasoning_content`: the TUI
  renders reasoning as a separate bounded block, defaults to collapsed preview,
  and offers `/reasoning hidden|collapsed|expanded`
- Provider thinking state is preserved as replayable thinking blocks in
  sessions, with OpenAI-compatible `reasoning_content` mapped into that shape
  for future native protocol adapters
- Engine profiles drive systemPrompt, tools, validators, and stop gates from
  `assets/engines/*.yaml`
- Tavily-backed `web_search`, `web_fetch`, `web_map`, `web_crawl`, and
  `web_research` tools for ETL and Evaluate turns. Search discovers sources,
  fetch extracts known URLs, map discovers site paths, crawl performs bounded
  multi-page extraction, research returns cited synthesis, and durable research
  notes should be synthesized and written under `source_materials/` with the
  existing file tools.
- Streamable HTTP MCP tool discovery and execution from optional user-level
  `mcp.yaml`. Vesicle initializes each enabled server, lists tools with
  pagination, exposes filtered `mcp_<prefix>_<tool>` aliases to scoped engines,
  calls remote `tools/call`, records structured `mcpEvent` metadata in
  sessions, reports connection/tool counts in `vesicle doctor`, and shows a
  compact MCP section in the Workspace sidebar without printing configured
  headers.
- JSONL session persistence under `.vesicle/sessions/` with `/resume` picker
  support and interactive pending-gate recovery
- Structured `fileEvent` metadata in session tool records for successful
  filesystem operations, enabling artifact/file-operation audit views without
  parsing prose
- Multimodal image input for models declaring `capabilities.vision: true`.
  OpenAI-compatible, Anthropic Messages, and Gemini adapters map shared
  attachments to native image blocks. The guarded `view_image` tool inspects
  project-relative images such as files in `source_materials/` and is hidden
  for non-vision models.
- Tool-calling loop for guarded filesystem CRUD/search tools (`stat_path`,
  `list_files`, `grep_files`, `read_file`, `view_image`, `create_file`, `write_file`,
  `replace_in_file`, `append_file`, `delete_file`, `copy_file`, `move_file`)
  with a high ceiling and no-progress circuit breaker (not a coding-agent hard
  cap)
- Writable research material under `source_materials/`, alongside the four
  final artifact roots. This supports ETL-generated background research and a
  Tavily-backed web capture pipeline without mixing research notes into the
  Artifact workbench index.
- `request_confirmation` gate runtime: the model pauses for user confirmation
  at declared stop gates (ETL blueprint and phase checkpoints wired)
- `request_engine_switch` handoff runtime: the model can pause for user
  confirmation before switching the active Prism engine profile
- `ask_user_question` interaction runtime: the model can ask one clarifying
  single-select question when the answer materially affects the next action;
  the TUI keeps arrow-key selection local to the question panel and supports an
  inline open-ended answer fallback
- Claude Code-style prompt composer semantics in the TUI: Backspace/Delete and
  readline shortcuts edit only the draft, `Ctrl+Enter` inserts a newline,
  `Shift+Enter` is inert when the terminal reports it distinctly, plain Enter
  submits, and Up/Down move inside soft-wrapped or explicit multiline drafts
  before falling back to prompt history. Long continuous input and pasted text
  soft-wrap inside a cursor-following viewport, and the input area expands as
  the draft grows. Trailing backslash+Enter remains a compatibility newline
  fallback for terminals that cannot report modified Enter keys.
- Claude Code-compatible `/rewind` message selector (also opened by empty-input
  double Esc) with append-only conversation forks, prompt restoration,
  conversation/code/both recovery, and partial summarization. File checkpoints
  cover mutations made through Vesicle's guarded filesystem tools; unrelated
  manual edits are not treated as rewind-managed changes.
- Claude Code-style `/compact [notes]` command for replacing the active
  provider context with a user-role conversation summary while preserving the
  append-only JSONL history for replay/debugging.
- Module A (character card) and Module B (scenario card) v9 schema validators;
  prose replies are not treated as artifacts
- Responsive OpenTUI shell: compact single-column at narrow widths and a
  stream-first layout with a workspace sidebar at medium and wide widths
- Artifact workbench commands: the unified `/artifact [n|path]` lists or
  previews generated files, while `/validate` checks them. Previews render as
  bounded document cards in the message stream, with Markdown cleanup and
  terminal-readable LaTeX math and Markdown extension fallbacks.
- Markdown rendering in the TUI for assistant messages, including conservative
  terminal-readable LaTeX math conversion and readable fallbacks for common
  Markdown extension syntax outside fenced code blocks.
- Select-style gate UI (Confirm / Reject, plus Confirm with summary for engine
  switches), rendered as a dedicated confirmation panel. Reject owns an
  optional input and can be submitted empty.
- Workspace sidebar grouping recent generated artifacts under the fixed
  `workspace/`, `novels/`, `reports/`, and `test_runs/` roots so repeated root
  prefixes do not truncate the meaningful path
- Filtered slash-command candidates with stable Up/Down or Ctrl+P/Ctrl+N
  selection, Tab/Enter completion, and Escape cancellation, plus Up/Down
  prompt-history recall outside the menu; `/model` extends the same popup flow
  to provider candidates after its first space and model candidates after its
  second, while `/engine`, `/effort`, and `/reasoning` offer their fixed values
- Prism v9 ETL prompt as the default engine, with manual switching to the
  other bundled engine profiles

## Assets

Prism v9 prompt/spec/template assets are copied under `assets/`. See `assets/README.md` for source paths and M0 adaptation notes.

## Documentation

- [`STATUS.md`](./STATUS.md): current version, scope, structure, tool surface, and known limits
- [`CHANGELOG.md`](./CHANGELOG.md): user-visible changes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): local workflow, commit style, repo boundary, docs sweep
- [`docs/dev/STYLE.md`](./docs/dev/STYLE.md): architecture, tool-runtime, prompt, session, and TUI rules
- [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md): branch workflow, iteration loop, and independent CR process
- [`AGENTS.md`](./AGENTS.md) / [`CLAUDE.md`](./CLAUDE.md): repo-local AI collaborator startup rules

## Scope

The 1.0 alpha focuses on making Vesicle usable across multiple
OpenAI-compatible, Anthropic Messages, Gemini `generateContent`, and external
Streamable HTTP MCP tool profiles, while treating generated artifact files as
first-class workflow objects. OpenAI Responses, MCP stdio/classic SSE,
Skills, guided long-form workflow scaffolding, and prompt-cache engineering are
deferred to later milestones — see
`STATUS.md` for the full known-limits list.

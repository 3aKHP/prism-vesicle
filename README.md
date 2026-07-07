# Prism Vesicle

Prism Vesicle is a Bun + TypeScript TUI harness for Prism Engine prompts. M0 proves the smallest useful loop: load Prism v9 assets, accept one prompt in a terminal UI, call an OpenAI-compatible Chat Completions endpoint, display the model output, and persist the session as JSONL.

Prism Vesicle is a sibling project of the public
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology)
repository, which hosts the Prism Engine / State-Space protocol assets that
Vesicle runs directly.

## Quick Start

```powershell
bun install
New-Item -ItemType Directory -Force $env:APPDATA\prism-vesicle
Copy-Item docs\examples\providers.yaml $env:APPDATA\prism-vesicle\providers.yaml
Copy-Item docs\examples\provider.env.example $env:APPDATA\prism-vesicle\.env
```

Edit your user-level provider config and set the environment variables named
by each provider's `apiKeyEnv` in the `.env` file beside it. The default
config path is
`%APPDATA%\prism-vesicle\providers.yaml` on Windows and
`$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` or
`~/.config/prism-vesicle/providers.yaml` on Linux/macOS. The TUI can then
switch with `/providers`, `/models`, `/use <provider> <model>`, and
`/model <model>`. Use `/think off|low|midium|high|xhigh|max` to set the
thinking tier for subsequent provider requests, or `/think auto` to clear the
explicit choice. Before this command is used, Vesicle leaves thinking behavior
at the provider/model default. Use `/reasoning hidden|collapsed|expanded` to
control whether provider reasoning content is shown in the TUI; the default is
collapsed with a bounded tail preview.
The provider file intentionally supports only Vesicle's small YAML subset:
`default`, `providers`, scalar provider fields, and `models` entries. The
canonical templates live together under `docs/examples/`: `providers.yaml` for
the registry and `provider.env.example` for the sibling user-level `.env`.
Models may be simple strings or object entries with `id`, optional
`generation` defaults (`temperature`, `maxTokens`), and optional
`capabilities`. Provider secrets are not read from the YAML file; every
provider must name an `apiKeyEnv` variable and the actual key belongs in the
same user-level directory's `.env` file. Process environment variables are
used only when the user-level `.env` does not define that key.

If you still have an old project-root `.env` from early testing, move the
provider key variables into the user-level `.env` beside `providers.yaml`, then
delete or rename the root file so local runs cannot depend on stale secrets.

Then run:

```powershell
bun run doctor
bun run dev
```

The TUI starts in a responsive workspace view. Type a prompt, press Enter, and
Vesicle sends it through the configured provider. Successful interactions are
stored under `.vesicle/sessions/`; `/resume` opens a session picker and can
return to an unresolved gate.

## Scripts

- `bun run dev`: launch the TUI
- `bun run doctor`: print runtime, provider configuration, and user-level
  provider `.env` status
- `bun run typecheck`: TypeScript validation
- `bun test`: test suite (includes a real-provider E2E gate test that returns
  early when the selected provider's `apiKeyEnv` is missing)
- `vesicle prompt dump --engine <id>`: print the fully composed system prompt
  the model receives — the primary "is there host pollution?" audit tool
- `vesicle prompt shape --engine <id>`: print profile structure only

## Current Capabilities

- OpenAI-compatible Chat Completions provider path
- Anthropic Messages provider path for text, streaming, tool calls, and
  thinking block preservation
- Gemini `generateContent` provider path for text, streaming, function calls,
  function responses, thinking-tier controls, and Gemini thought-signature
  replay
- Streaming OpenAI-compatible Chat Completions responses when the provider
  supports SSE, including streamed tool-call reconstruction
- Provider/model registry from the user-level `providers.yaml`, with TUI
  commands to switch provider and model inside a session
- Config-driven model defaults and capability metadata in `providers.yaml`:
  low-frequency generation knobs such as `temperature` and `maxTokens` stay in
  config while high-frequency thinking control stays in the TUI
- Runtime thinking-tier control with `/think off|low|midium|high|xhigh|max`
  plus `/think auto` to return to provider defaults; adapters map the
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
- JSONL session persistence under `.vesicle/sessions/` with `/resume` picker
  support and interactive pending-gate recovery
- Structured `fileEvent` metadata in session tool records for successful
  filesystem operations, enabling artifact/file-operation audit views without
  parsing prose
- Tool-calling loop for guarded filesystem CRUD/search tools (`stat_path`,
  `list_files`, `grep_files`, `read_file`, `create_file`, `write_file`,
  `replace_in_file`, `append_file`, `delete_file`, `copy_file`, `move_file`)
  with a high ceiling and no-progress circuit breaker (not a coding-agent hard
  cap)
- `request_confirmation` gate runtime: the model pauses for user confirmation
  at declared stop gates (ETL blueprint and phase checkpoints wired)
- Module A (character card) and Module B (scenario card) v9 schema validators;
  prose replies are not treated as artifacts
- Responsive OpenTUI shell: compact single-column at narrow widths, workspace
  sidebar at medium widths, and activity/artifact pane at wide widths
- Activity pane for provider requests, assistant responses, tool calls, gate
  events, validation, and recent artifacts
- Artifact workbench commands: `/artifacts`, `/artifact`, `/validate`, and
  `/revise` list, preview, validate, and revise generated files
- Markdown rendering in the TUI for assistant messages
- Select-style gate UI (Confirm / Revise / Chat with Tab amend), rendered as a
  dedicated confirmation panel
- Workspace sidebar showing recent generated artifacts
- Slash-command hints and Up/Down prompt-history recall in the input area
- Prism v9 ETL prompt as the default engine

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

0.3.0 development focuses on making Vesicle usable across multiple
OpenAI-compatible, Anthropic Messages, and Gemini `generateContent` provider
profiles and on treating generated artifact files as first-class workflow
objects. OpenAI Responses, MCP, Skills, long-form engines, and prompt-cache
engineering are deferred to later milestones — see `STATUS.md` for the full
known-limits list.

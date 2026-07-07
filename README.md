# Prism Vesicle

Prism Vesicle is a Bun + TypeScript TUI harness for Prism Engine prompts. M0 proves the smallest useful loop: load Prism v9 assets, accept one prompt in a terminal UI, call an OpenAI-compatible Chat Completions endpoint, display the model output, and persist the session as JSONL.

Prism Vesicle is a sibling project of the public
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology)
repository, which hosts the Prism Engine / State-Space protocol assets that
Vesicle runs directly.

## Quick Start

```powershell
bun install
Copy-Item .env.example .env
```

Set:

- `VESICLE_PROVIDER=openai-chat-compatible`
- `VESICLE_BASE_URL`
- `VESICLE_MODEL`
- `VESICLE_API_KEY`

For multiple OpenAI-compatible providers, copy
`docs/examples/providers.yaml` to `.vesicle/providers.yaml` and set each
provider's `apiKeyEnv` environment variable. The TUI can then switch with
`/providers`, `/models`, `/use <provider> <model>`, and `/model <model>`.
The provider file intentionally supports only Vesicle's small YAML subset:
`default`, `providers`, scalar provider fields, and `models` string lists.
Provider secrets are not read from this file; every provider must name an
`apiKeyEnv` variable and the actual key belongs in `.env` or the process
environment.

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
- `bun run doctor`: print runtime and provider configuration status
- `bun run typecheck`: TypeScript validation
- `bun test`: test suite (includes a real-provider
  E2E gate test that auto-skips without `VESICLE_API_KEY`)
- `vesicle prompt dump --engine <id>`: print the fully composed system prompt
  the model receives — the primary "is there host pollution?" audit tool
- `vesicle prompt shape --engine <id>`: print profile structure only

## Current Capabilities

- OpenAI-compatible Chat Completions provider path
- Streaming OpenAI-compatible Chat Completions responses when the provider
  supports SSE, including streamed tool-call reconstruction
- Provider/model registry from `.vesicle/providers.yaml`, with TUI commands to
  switch provider and model inside a session
- Engine profiles drive systemPrompt, tools, validators, and stop gates from
  `assets/engines/*.yaml`
- JSONL session persistence under `.vesicle/sessions/` with `/resume` picker
  support and interactive pending-gate recovery
- Tool-calling loop for `list_files`, `read_file`, and `write_file` with a
  high ceiling and no-progress circuit breaker (not a coding-agent hard cap)
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
OpenAI-compatible provider profiles and on treating generated artifact files as
first-class workflow objects. Native Anthropic, Gemini, OpenAI Responses, MCP,
Skills, long-form engines, and prompt-cache engineering are deferred to later
milestones — see `STATUS.md` for the full known-limits list.

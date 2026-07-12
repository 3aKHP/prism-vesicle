# Prism Vesicle

[English](./README.md) | [简体中文](./README.zh-CN.md)

Prism Vesicle is a Bun + TypeScript terminal host for Prism Engine workflows. It loads editable Prism v9 engine assets, connects them to direct model providers and host tools, and keeps conversations and artifact work durable across sessions.

> **Alpha status:** `1.0.0-alpha.1` is a public dogfood release, not a finished end-user product. The supported onboarding path is the [Windows-first user manual](./docs/user/en/README.md), this README, `vesicle doctor`, `vesicle prompt shape --engine <id>`, and the examples under [`docs/examples/`](./docs/examples/). Command UX and runtime contracts may still change between alpha releases.

New to terminals, API keys, or model providers? Start with the [step-by-step user manual](./docs/user/en/README.md) before following the condensed setup below.

## Install

Vesicle requires [Bun](https://bun.sh/) 1.3.14 or newer.

### npm

Install the package and verify that its bundled ETL profile is available:

```bash
npm install prism-vesicle
bunx vesicle prompt shape --engine etl
```

The package includes read-only default runtime assets. Vesicle resolves each logical `assets/...` file through three layers: the current project's sparse `assets/` overrides, user-global overrides under the Vesicle configuration directory, then the defaults shipped with the active package or standalone release.

Inspect the active layers and the source of the effective manifest:

```bash
bunx vesicle assets status
```

Copy only one file or directory into the current project for editing:

```bash
bunx vesicle assets materialize assets/prompts/engines/etl.md
```

Add `--global` to make that override apply to every project for the current user. The existing command below still creates a full project snapshot, but sparse overrides are preferred because untouched files continue to receive packaged updates:

```bash
bunx vesicle assets init
```

Asset initialization and materialization refuse to overwrite existing files.

### Source checkout

```bash
bun install
mkdir -p ~/.config/prism-vesicle
cp docs/examples/providers.yaml ~/.config/prism-vesicle/providers.yaml
cp docs/examples/provider.env.example ~/.config/prism-vesicle/.env
```

To enable optional MCP tools, also copy the example registry and edit it before starting Vesicle:

```bash
cp docs/examples/mcp.yaml ~/.config/prism-vesicle/mcp.yaml
```

## Configure Providers

Vesicle reads provider and model profiles from user-level configuration rather than from the project repository.

| Platform | Provider registry | Secret file |
|---|---|---|
| Windows | `%APPDATA%\prism-vesicle\providers.yaml` | `%APPDATA%\prism-vesicle\.env` |
| Linux and macOS | `$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` or `~/.config/prism-vesicle/providers.yaml` | `.env` beside `providers.yaml` |

User-global asset overrides use the sibling `assets/` directory: `%APPDATA%\prism-vesicle\assets\` on Windows or `$XDG_CONFIG_HOME/prism-vesicle/assets/` / `~/.config/prism-vesicle/assets/` elsewhere. These files contain no secrets.

Start from [`docs/examples/providers.yaml`](./docs/examples/providers.yaml) and [`docs/examples/provider.env.example`](./docs/examples/provider.env.example). The registry contains provider ids, protocols, endpoints, model metadata, defaults, and `apiKeyEnv` names; actual API keys belong only in the sibling `.env`. Process environment variables are fallback values.

Do not place secrets in `providers.yaml`, and do not depend on a project-root `.env`. If one remains from an early Vesicle setup, migrate its values to the user-level secret file and remove or rename it.

The current provider protocols are OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini `generateContent`. Model entries may declare generation defaults, capability metadata such as vision support, and context limits. See the annotated example registry for the canonical shape.

Optional Streamable HTTP MCP servers are configured in a sibling `mcp.yaml`; [`docs/examples/mcp.yaml`](./docs/examples/mcp.yaml) documents header expansion, tool prefixes, filters, engine scoping, and timeouts. `TAVILY_API_KEY` in the user-level `.env` enables Vesicle's web research tools for the ETL and Evaluate engines.

## First Run

Vesicle starts with the ETL engine. Type a prompt and press Enter to begin; provider turns, tool activity, gates, usage metadata, and engine transitions are appended to `.vesicle/sessions/`.

After editing the provider registry and sibling `.env`, verify the effective setup without exposing secret values, then start Vesicle:

```bash
# npm installation
bunx vesicle doctor
bunx vesicle

# source checkout
bun run doctor
bun run dev
```

Generated files are limited to guarded project roots. Research material belongs under `source_materials/`; final artifacts belong under `workspace/`, `novels/`, `reports/`, or `test_runs/`. Models may organize these roots into nested directories, inspect directory entries, move or rename directory trees, and delete empty directories; fixed roots and symbolic-link traversal remain protected. File and directory changes made through Vesicle tools participate in rewind checkpoints under `.vesicle/file-history/`.

Useful commands:

| Command | Purpose |
|---|---|
| `/model` | Pick a configured provider and model |
| `/engine [id]` | Inspect or switch the active Prism engine |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | Control provider thinking effort |
| `/reasoning hidden\|collapsed\|expanded` | Control reasoning display |
| `/artifact [n\|path]` | List or preview generated artifacts |
| `/validate <n\|path>` | Validate an artifact by index or path |
| `/resume` | Resume a persisted session |
| `/rewind` | Restore a conversation branch, Vesicle-managed files, or both |
| `/compact [notes]` | Summarize older context into a compact continuation |
| `/context` | Inspect token totals and configured context limits |
| `/agents [handle\|stop <handle>\|retry]` | List, inspect, interrupt, or retry paused delivery for SubAgents using short handles such as `explore-1` |

The main composer uses Enter to submit and Ctrl+Enter to insert a newline. Escape cancels an active provider request; with an empty composer, double Escape opens rewind. Vision-capable models can receive a clipboard image through Alt+V, with Ctrl+Alt+V accepted when reported by WSL terminals.

## What Vesicle Supports

- Profile-driven Prism engines whose prompts, tools, validators, and stop gates resolve through bundled, user-global, and project `assets/` layers.
- Streaming OpenAI-compatible, Anthropic, and Gemini provider adapters with native tool calls, thinking controls, usage normalization, cancellation, and bounded retry.
- A responsive OpenTUI interface with durable sessions, command completion, provider/model switching, engine handoff, user questions, and confirmation gates.
- Guarded filesystem tools, artifact previews and validation, append-only conversation rewind, and Vesicle-managed file checkpoints.
- Optional Tavily web research, Streamable HTTP MCP tools, and multimodal image input for models that declare vision support.
- Foreground and background SubAgents with parallel execution, independent built-in or custom Agent Profiles, dedicated live Agent cards, short model/user-facing handles, durable completion delivery, and parent continuation without polling.
- npm distribution plus standalone Windows and Linux builds with an immutable external default asset pack and sparse editable global/project overrides.

See [`STATUS.md`](./STATUS.md) for the authoritative implementation inventory, tool surface, validators, and known limits.

## Development

```bash
bun run typecheck
bun test
bun run doctor
```

| Script | Purpose |
|---|---|
| `bun run dev` | Run the TUI from source |
| `bun run typecheck` | Validate TypeScript without emitting files |
| `bun test` | Run the deterministic test suite |
| `BUN_E2E_REAL_PROVIDER=1 bun test tests/e2e-gate.test.ts` | Run the opt-in real-provider gate acceptance test |
| `bun run pack:check` | Verify the npm publish allowlist |
| `bun run pack:smoke` | Smoke-test the packed npm distribution |
| `bun run build:exe` | Build standalone Windows and Linux executables |
| `bun run build:assets` | Build the editable assets ZIP |

`vesicle debug markdown-runtime` verifies the standalone OpenTUI worker and syntax runtime without opening the TUI. `vesicle prompt dump --engine <id>` prints the complete model-visible system prompt; `vesicle prompt shape --engine <id>` prints only its composed structure.

Pull requests and `develop` pushes run the release-shape checks on Linux and Windows. Protected version tags publish a GitHub prerelease, checksums, standalone executables, the editable assets ZIP, and the provenance-enabled npm package. See [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) for the branch and release workflow.

## Documentation

| Document | Responsibility |
|---|---|
| [`docs/user/en/`](./docs/user/en/README.md) | Ordered Windows-first user manual from computer basics through advanced operation |
| [`STATUS.md`](./STATUS.md) | Current implementation, tool surface, verification, and known limits |
| [`CHANGELOG.md`](./CHANGELOG.md) | Released and unreleased user-visible changes |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor setup, repository boundaries, and documentation style |
| [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) | Architecture and runtime boundaries |
| [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) | Branching, review, release, and documentation sweep |
| [`assets/README.md`](./assets/README.md) | Prism asset source and adaptation notes |

Repository-local AI collaborator instructions live in [`AGENTS.md`](./AGENTS.md) and [`CLAUDE.md`](./CLAUDE.md).

## Scope And Lineage

The 1.0 alpha focuses on making Vesicle a practical direct API host for Prism workflows rather than a generic coding agent. OpenAI Responses, broader MCP transports and surfaces, Skills integration, dedicated long-form engine scaffolding, and prompt-cache engineering remain deferred; consult [`STATUS.md`](./STATUS.md) before relying on an unlisted capability.

Prism Vesicle is a sibling of [`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology), the public source for the Prism Engine and State-Space protocol assets adapted here.

## License

[MIT](./LICENSE)

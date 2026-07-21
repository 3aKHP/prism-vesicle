# Prism Vesicle

[English](./README.md) | [简体中文](./README.zh-CN.md)

Prism Vesicle is a Bun + TypeScript terminal host for Prism Engine workflows. It starts from a verified bundled V10 Harness, can select a project-pinned managed Harness Pack, connects the active runtime to direct model providers and host tools, and keeps conversations and artifact work durable across sessions.

> **Alpha status:** `1.0.0-alpha.3` is a public dogfood candidate, not a finished end-user product. Windows users can install and configure it through the guided installer without editing YAML. The [user manual](./docs/user/en/README.md), this README, `vesicle doctor`, and the examples under [`docs/examples/`](./docs/examples/) remain the supported references.

New to terminals, API keys, or model providers? Start with the [step-by-step user manual](./docs/user/en/README.md) before following the condensed setup below.

## Install

### Guided Windows installer

Download `PrismVesicleSetup-<version>-windows-x64.exe` from the matching GitHub prerelease and open it. The per-user installer does not require administrator access. At completion it launches Prism Vesicle Setup, which can discover OpenAI-compatible models from a Base URL and API key, configure optional Tavily and MCP services, and choose a safe permission preset without manual configuration-file editing. Project selection is optional and applies only to the one-time launch immediately after Setup; Vesicle never stores one global project directory.

The Windows executable and installer for `1.0.0-alpha.3` are intentionally not Authenticode-signed. Windows signing is deferred until the project has a stronger basis for a signing provider, with no version deadline. Download only from the official GitHub Release, verify `SHA256SUMS.txt`, and do not disable Windows security features globally. Historical Windows artifacts are also unsigned unless their individual Release notes explicitly state otherwise. Read the [Code Signing Policy](./CODE_SIGNING_POLICY.md) before relying on a signature, and see the [Privacy Policy](./PRIVACY.md) for local storage and external-service data transfers.

The guided installer includes the standalone Windows runtime and complete bundled V10 Harness. Bun is not required for this path. Existing `%APPDATA%\prism-vesicle` configuration and project data are preserved across upgrade and ordinary uninstall. It installs the native `vesicle.exe` command and a per-user Explorer **Open in Prism Vesicle** directory action. Running the installer again presents **Reinstall / Repair / Uninstall** maintenance choices. To launch from a terminal, make the intended project the current directory:

```powershell
Set-Location C:\path\to\my-project
vesicle .
```

The npm and source-development paths below require [Bun](https://bun.sh/) 1.3.14 or newer.

### npm or source development

Install the package and verify that its bundled ETL profile is available:

```bash
npm install -g prism-vesicle
vesicle prompt shape --engine etl
```

The package includes the complete read-only `prism-engine-v10@10.1.0-rc.1` runtime baseline. No project lock or separate Harness installation is required for normal use. Vesicle resolves each logical `assets/...` file through sparse project and user-global overrides, then one complete verified baseline: either a project-pinned managed Harness Pack or the bundled V10 Pack shipped with the active package or standalone release. The Harness owns its declared prompt sections; a restricted host layer supplies the five generic SubAgents and their prompts.

Inspect the active layers and the source of the effective manifest:

```bash
vesicle assets status
```

Copy only one file or directory into the current project for editing:

```bash
vesicle assets materialize assets/prompts/engines/etl.md
```

Add `--global` to make that override apply to every project for the current user. The existing command below still creates a full project snapshot, but sparse overrides are preferred because untouched files continue to receive packaged updates:

```bash
vesicle assets init
```

Asset initialization and materialization refuse to overwrite existing files.

An advanced project can verify and install an already-extracted Harness Release, then pin it explicitly:

```bash
vesicle assets verify /path/to/extracted-pack
vesicle assets install /path/to/extracted-pack
vesicle assets use <pack-id>@<version>
vesicle assets status
```

The project lock is `.vesicle/assets.lock.json`. Vesicle reverifies the installed pack on start and resume, and blocks provider continuation when the recorded Harness identity differs. A pending Output Quality Guard decision can still be opened to use or stop the current version locally, but revision remains unavailable until the exact recorded identity is restored. `vesicle assets rollback` removes the project selection and restores the bundled V10 baseline. Sessions created before the V10 baseline migration have no Harness identity and must be replaced with a new session. Archive extraction, online discovery, and automatic updates are not part of this offline flow.

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

To opt into the guarded host shell or choose a more cautious default approval mode, copy the permission settings example:

```bash
cp docs/examples/permissions.yaml ~/.config/prism-vesicle/permissions.yaml
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

Host tool approval settings live in sibling `permissions.yaml`; [`docs/examples/permissions.yaml`](./docs/examples/permissions.yaml) documents the MANUAL, INERTIA, and MOMENTUM defaults, the explicit `shellExec` opt-in, and the host-owned shell profiles. Windows `auto` prefers PowerShell 7 and falls back to Windows PowerShell 5.1, while Linux/WSL `auto` remains `/bin/sh`; CMD, Git Bash, and fixed PowerShell/POSIX profiles are explicit choices. YOLO cannot be persisted as a default. `/permissions YOLO` requires two red confirmations, while `vesicle --dangerously-skip-permissions` enables YOLO only for that process and keeps the danger indicator visible.

## First Run

Vesicle starts with the ETL engine. Type a prompt and press Enter to begin; provider turns, tool activity, gates, usage metadata, and engine transitions are appended to `.vesicle/sessions/`.

From a source checkout, `bun run dev` directly starts the complete bundled V10 runtime; no asset initialization or project Harness lock is needed.

After editing the provider registry and sibling `.env`, verify the effective setup without exposing secret values, then start Vesicle:

```bash
# npm installation
vesicle doctor
vesicle

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
| `/stage <character-card-path> <scenario-card-path>` | Start the consumer Stage engine with frozen Module A/B cards |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | Control provider thinking effort |
| `/reasoning hidden\|collapsed\|expanded` | Control reasoning display |
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | Inspect or change tool approval behavior |
| `/artifact [n\|path]` | List or preview generated artifacts |
| `/validate <n\|path>` | Validate an artifact by index or path |
| `/resume` | Resume a persisted session |
| `/rewind` | Restore a conversation branch, Vesicle-managed files, or both |
| `/compact [notes]` | Summarize older context into a compact continuation |
| `/context` | Inspect token totals and configured context limits |
| `/agents [handle\|stop <handle>\|retry]` | List, inspect, interrupt, or retry paused delivery for SubAgents using short handles such as `explore-1` |

The main composer uses Enter to submit and Ctrl+Enter to insert a newline. While the Agent Loop is running, Enter queues ordinary messages; after the current complete tool round, Vesicle injects them before the next provider request. Slash commands use command-owned scheduling: safe host-only commands run immediately, artifact reads wait for the tool round, and configuration, picker, or session commands wait for the Agent Loop. The mixed queue is shown above the composer, and Up with an empty draft retrieves its latest item for editing. Escape interrupts the current provider or tool operation and immediately processes the next queued input; with an empty composer, double Escape opens rewind. Vision-capable models can receive a clipboard image through Alt+V, with Ctrl+Alt+V accepted when reported by WSL terminals.

## What Vesicle Supports

- Profile-driven Prism engines whose prompts, tools, validators, and stop gates resolve through project/user overrides over a managed Harness or bundled recovery baseline.
- A consumer-grade Stage engine that freezes supplied Module A/B cards into a prose-first narrative bootstrap with no model-visible tools or gates. Quality enforcement defaults to observe; only an explicitly enabled host quality configuration can trigger an experimental bounded rewrite.
- Streaming OpenAI-compatible, Anthropic, and Gemini provider adapters with native tool calls, thinking controls, usage normalization, cancellation, and bounded retry.
- A responsive OpenTUI interface with durable sessions, command completion, provider/model switching, engine handoff, user questions, and confirmation gates.
- Guarded filesystem tools, artifact previews and validation, append-only conversation rewind, and Vesicle-managed file checkpoints.
- A target-aware Output Quality Guard that checks current Runtime artifact post-images, persists findings and warnings, restores exhausted or interrupted revisions with explicit revise-again, use-current, and stop choices, and offers a default-off experimental Semantic Judge selected from the user's configured provider models.
- Optional Tavily web research, Streamable HTTP MCP tools, and multimodal image input for models that declare vision support.
- Four coarse tool approval modes plus an opt-in non-interactive `shell_exec` process runtime with host-owned PowerShell, CMD, Git Bash, and POSIX shell profiles, exact interpreter-bound plan approval, filtered environment, bounded UTF-8 live output, timeout, process-tree cleanup, foreground/background execution, durable `shell-N` task state, completion notification, and explicit output/stop controls.
- Foreground and background SubAgents with parallel execution, three V10 Driver-contract workflow Agents, five generic host Agents (`explore`, `general`, `plan`, `research`, and `reviewer`), custom Agent Profiles subject to the active Harness contract, dedicated live Agent cards, durable completion delivery, and parent continuation without polling.
- npm distribution plus standalone Windows and Linux builds with an immutable bundled V10 runtime pack, offline managed-Harness selection, and sparse editable global/project overrides.

See [`STATUS.md`](./STATUS.md) for the authoritative implementation inventory, tool surface, validators, and known limits.

## Development

```bash
bun run lint
bun run typecheck
bun test
bun run doctor
```

| Script | Purpose |
|---|---|
| `bun run dev` | Run the TUI from source |
| `bun run lint` | Run the pinned Biome correctness checks without formatting files |
| `bun run typecheck` | Validate TypeScript without emitting files |
| `bun test` | Run the deterministic test suite |
| `BUN_E2E_REAL_PROVIDER=1 bun test ./tests/acceptance/provider/e2e-gate.acceptance.ts` | Run the opt-in real-provider gate acceptance test |
| `bun run pack:check` | Verify the npm publish allowlist |
| `bun run pack:smoke` | Smoke-test the packed npm distribution |
| `bun run build:exe` | Build standalone Windows and Linux executables |
| `bun run build:assets` | Build the editable assets ZIP |
| `bun run build:installer:stage` | Stage the complete Windows installer payload |
| `bun run build:installer` | Build the Inno Setup installer on Windows |

`vesicle debug markdown-runtime` verifies the standalone OpenTUI worker and syntax runtime without opening the TUI. `vesicle prompt dump --engine <id>` prints the complete model-visible system prompt; `vesicle prompt shape --engine <id>` prints only its composed structure.

The developer-only `vesicle quality benchmark` command runs an explicitly authorized, budget-capped Semantic Judge measurement against the active verified Harness. It remains separate from Runtime policy and requires `--allow-live`; see [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md) before using it.

Pull requests and `develop` pushes call one reusable Linux/Windows release build, including npm consumer validation and a silent guided-installer install/upgrade/uninstall smoke. A release is authorized from the command line by pushing a protected annotated `v<package version>` tag on the accepted `main` commit. The tag workflow reruns the same gates, creates the GitHub Release and checksums, and publishes npm with provenance; no normal Actions-page dispatch or GitHub Environment approval is required. Windows signing is deferred and is not part of this publication path. See [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) for the exact commands, GitHub settings, and recovery rules.

## Documentation

| Document | Responsibility |
|---|---|
| [`docs/user/en/`](./docs/user/en/README.md) | User manual (start pages, tutorials, reference); Simplified Chinese canonical, English mirror |
| [`STATUS.md`](./STATUS.md) | Current implementation, tool surface, verification, and known limits |
| [`CHANGELOG.md`](./CHANGELOG.md) | Released and unreleased user-visible changes |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Contributor setup, repository boundaries, and documentation style |
| [`CODE_SIGNING_POLICY.md`](./CODE_SIGNING_POLICY.md) | Windows signing scope, approval, verification, and incident handling |
| [`PRIVACY.md`](./PRIVACY.md) | Local data, external-service transfers, uninstall behavior, and deletion |
| [`docs/dev/STYLE.md`](./docs/dev/STYLE.md) | Architecture and runtime boundaries |
| [`docs/dev/WORKFLOW.md`](./docs/dev/WORKFLOW.md) | Branching, review, release, and documentation sweep |
| [`docs/dev/ASSETS.md`](./docs/dev/ASSETS.md) | Bundled V10 inventory, host extension layer, lineage, and update rules |
| [`docs/dev/QUALITY_BENCHMARK.md`](./docs/dev/QUALITY_BENCHMARK.md) | Developer-only Semantic Judge measurement, caps, resume, and evidence boundary |

Repository-local AI collaborator instructions live in [`AGENTS.md`](./AGENTS.md) and [`CLAUDE.md`](./CLAUDE.md).

## Scope And Lineage

The 1.0 alpha focuses on making Vesicle a practical direct API host for Prism workflows rather than a generic coding agent. OpenAI Responses, broader MCP transports and surfaces, Skills integration, dedicated long-form engine scaffolding, and prompt-cache engineering remain deferred; consult [`STATUS.md`](./STATUS.md) before relying on an unlisted capability.

Prism Vesicle is a sibling of [`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology), the public source for the V10 Harness Release bundled here.

## License

[MIT](./LICENSE)

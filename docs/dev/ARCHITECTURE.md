# Prism Vesicle Architecture

This document defines the stable ownership and dependency boundaries of the Vesicle host. Detailed runtime behavior belongs to the linked domain contracts; current capability state and known limits belong in [`STATUS.md`](../../STATUS.md).

## Layering

```text
cli/  # command dispatch only
tui/  # OpenTUI rendering and keyboard interaction
config/  # host configuration loading and inspection
setup/  # guided onboarding and validated configuration transactions
core/agent-loop/  # provider rounds, tool loop, and continuation orchestration
core/agents/  # Agent profiles, child lifecycle, concurrency, and delivery
core/artifacts/  # artifact discovery, preview bounds, and validation selection
core/attachments/  # image content-addressed store and request-only materialization
core/checkpoints/  # per-turn file snapshots and restore
core/compact/  # context compaction service
core/engine/  # Engine profile loading
core/gate/  # workflow-gate request types
core/harness/  # Harness verification, compatibility, and installation
core/permissions/  # Tool Permission Runtime policy and broker
core/process/  # bounded Process Runtime and shell profiles
core/project/  # project root taxonomy and path classification
core/prompt/  # prompt loading and composition
core/quality/  # Output Quality Guard host runtime
core/rewind/  # conversation rewind and partial summarization
core/runtime/  # runtime asset resolution
core/session/  # durable session persistence and projection
core/side-question/  # tool-free side-question snapshots and service
core/stage/  # Stage consumer bootstrap
core/tools/  # model-visible host tool contracts and execution
core/user-question/  # host clarification-question types
core/validators/  # artifact validators and registry
mcp/  # external MCP discovery and execution
providers/  # protocol adapters only
skills/  # Agent Skills parsing, discovery, store, and catalog
types/  # genuinely shared host types
assets/  # exact bundled Harness manifest inventory
host-assets/  # restricted Vesicle prompts and generic Agent extensions
```

## Dependency Direction

- `cli` may compose `tui`, `setup`, `core`, `config`, and provider types; domain layers must not import CLI dispatch.
- `tui` may consume `core`, `config`, and normalized provider types; core runtime and provider adapters must not depend on TUI rendering.
- `setup` may consume `config`, `mcp`, Engine and permission types, and reusable presentation primitives; installer code must not become a second configuration parser.
- `core/agent-loop` orchestrates providers, prompts, sessions, tools, gates, Engines, validators, Agents, quality handling, and MCP without transferring ownership among them.
- `providers` may depend on normalized provider-shared types and configuration only. Adapters must not import project tools, sessions, TUI, or Prism workflow policy.
- `core/tools` and `mcp` may share normalized tool contracts, but neither may depend on providers or TUI.
- `core/harness` may validate and bind Engine, Agent, tool, validator, runtime-asset, and quality contracts; those domains must not depend on a sibling source checkout.
- `skills` receives pre-resolved discovery roots and must not import the asset resolver, provider runtime, Harness runtime, or TUI.
- `core/gate` contains host-neutral request types. Agent-loop and TUI own continuation and presentation respectively.

## Cross-Cutting Boundaries

- Provider adapters translate normalized requests and responses; they do not own host policy. See [`PROVIDERS.md`](./PROVIDERS.md).
- Responses capability profiles are explicit configuration data consumed only by the Responses adapter. Core/session/TUI own normalized effects and opaque state, never OpenAI, MiMo, or DeepSeek wire fields; Setup may write reviewed profiles but must not infer them from provider or model identity. See [`OPENAI_RESPONSES_CONFORMANCE.md`](./OPENAI_RESPONSES_CONFORMANCE.md).
- Model-visible tools remain behind host capability, path, permission, and process enforcement. See [`TOOLS.md`](./TOOLS.md). Project-root taxonomy (source, artifact, scratch, content, and model-writable categories) and scratch-path classification live in `core/project/roots.ts`; consumers must select the semantically correct set instead of re-deriving root lists.
- `mcp` owns protocol-neutral result normalization and untrusted per-kind validation. It connects to Streamable HTTP MCP Servers through the official `@modelcontextprotocol/client@2` SDK, supporting both legacy (`initialize`) and modern (`server/discover`) protocol eras per server. The SDK is wrapped in a thin adapter at the `src/mcp` boundary; SDK types never enter `core/`, providers, Engine profiles, permission runtime, or TUI rendering. It may deliver accepted media through `core/attachments`, but provider adapters receive only the established normalized message shape and never parse MCP payloads, fetch MCP references, or decide MCP media policy.
- Sessions are append-only durable history. Projection, rewind, checkpoints, compaction, and continuation recovery must preserve that invariant. See [`SESSIONS.md`](./SESSIONS.md).
- Prompt assets are runtime files resolved through the active verified asset stack; Engine prompts are not TypeScript literals. See [`ASSETS.md`](./ASSETS.md).
- Generation prompts receive only the role, task, relevant input, effective actions, output contract, and concise task-specific quality guidance. Host enforcement — tool allowlists, permissions, path guards, integrity hashes, session identity, and the Quality lifecycle — is applied at runtime and must not be duplicated as prompt prose. Harness contract data stays declarative unless the active model must act on the exact binding in the current task; a profile with no tools must not be told about tools, Agents, shell, Web, state roots, or resource paths it cannot use. Prompt ledgers and prompt inspection keep capability and audience drift measurable without turning a review budget into a runtime admission threshold.
- Persistent Instructions are live host configuration and model context, not capability authority or session identity. See [`PERSISTENT_INSTRUCTIONS.md`](./PERSISTENT_INSTRUCTIONS.md).
- SubAgents have explicit lifecycle, identity, capability, ownership, and delivery contracts. See [`SUBAGENTS.md`](./SUBAGENTS.md).
- Skills provide bounded procedural context and resources without granting capabilities. See [`SKILLS.md`](./SKILLS.md).
- TUI presentation and input routing observe and control host state without redefining domain semantics. See [`TUI.md`](./TUI.md).
- The TUI is built on OpenTUI with Solid. Its hard limit is the terminal medium, not a missing framework API: font choice, anti-aliasing, sub-cell positioning, arbitrary transforms, blur, vector graphics, and pixel-perfect image composition cannot be made consistent across terminal emulators, SSH, and multiplexers, so effects are designed as terminal-native visuals with graceful degradation rather than as a simulation of a browser canvas. OpenTUI upgrades are evaluated in isolated branches against source, npm, Linux binary, and native Windows binary lanes; they are maintenance work, not an automatic substitute for the stack decision. Interaction and workflow rules live in pure TypeScript controllers, and OpenTUI types must not enter `core/`, provider adapters, session semantics, or tool-runtime contracts.
- Profile validators inspect Prism artifact documents rather than ordinary transition prose or every assistant turn. Artifact workbench validation reads the selected file from disk, and findings remain advisory unless a feature contract explicitly introduces a stronger policy.
- Stage bootstraps a consumer narrative session from frozen card input and renders the validated three-part turn packet prose-first while preserving raw content in provider history and sessions. See [`STAGE.md`](./STAGE.md).
- The Output Quality Guard applies the active Harness's delivery-quality policy to generated prose through deterministic detection, an optional experimental Semantic Judge, and a bounded host-policy rewrite. It is a delivery-policy runtime, not a second permission system. See [`QUALITY_GUARD.md`](./QUALITY_GUARD.md).
- Warning, confirmation, and risk-control design preserves informed user choice while enforcing concrete host boundaries. See [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md).
- Guided Setup and the Windows installer own first-run onboarding, model discovery, configuration transactions, and OS integration within a bounded, secret-free scope. See [`SETUP.md`](./SETUP.md).

## Configuration And Setup Ownership

- Provider, MCP, permission, quality, and user asset configuration are user-level host state. Project runtime state must not become an alternate source for those settings.
- `src/config` owns decoding and validation of configuration files. Consumers receive validated values and must not independently reinterpret the same schema.
- `src/setup` owns interactive onboarding, discovery, validation, backup, and configuration transactions. The Windows installer owns only the installed application lifecycle and operating-system integration.
- Setup configuration writes are direct host actions, not model-visible tools. They validate the complete staged shape and preserve unrelated user configuration.
- Project launch derives its root from the invocation directory or explicit directory argument. Setup and standalone asset resolution must not change the parent process working directory to make lookup succeed.

Installer, onboarding, model-discovery, configuration-write, and project-launch rules live in [`SETUP.md`](./SETUP.md).

## Contract Ownership

| Document | Authority |
|---|---|
| [`STYLE.md`](./STYLE.md) | Source-code structure, maintainability, types, errors, naming, comments, and test design |
| [`PROVIDERS.md`](./PROVIDERS.md) | Normalized provider boundary, protocol mapping, transport, usage, and provider configuration |
| [`OPENAI_RESPONSES_CONFORMANCE.md`](./OPENAI_RESPONSES_CONFORMANCE.md) | Frozen Responses/Codex application-layer target and structured evidence contract |
| [`TOOLS.md`](./TOOLS.md) | Model-visible tools, path guards, permissions, process authority, gates, questions, and MCP execution |
| [`SESSIONS.md`](./SESSIONS.md) | Session persistence, projection, checkpoints, rewind, compaction, and recovery |
| [`PERSISTENT_INSTRUCTIONS.md`](./PERSISTENT_INSTRUCTIONS.md) | Instruction resolution, prompt composition, mutation, and capability limits |
| [`TUI.md`](./TUI.md) | Terminal layout, input ownership, commands, rendering, and side-question interaction |
| [`ASSETS.md`](./ASSETS.md) | Bundled and managed Harness assets, host extensions, verification, and Quality Guard bindings |
| [`SUBAGENTS.md`](./SUBAGENTS.md) | Child-Agent lifecycle, persistence, capability, concurrency, and delivery |
| [`SKILLS.md`](./SKILLS.md) | Skill format, discovery, storage, path safety, and current capability boundary |
| [`STAGE.md`](./STAGE.md) | Stage consumer Engine bootstrap, three-part packet, and prose-first rendering contract |
| [`QUALITY_GUARD.md`](./QUALITY_GUARD.md) | Output Quality Guard delivery-policy runtime and rewrite lifecycle |
| [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md) | User agency, disclosure, confirmation, and enforceable-boundary policy |
| [`SETUP.md`](./SETUP.md) | Windows installer scope, guided onboarding, model discovery, configuration transactions, and project-launch rules |
| [`WORKFLOW.md`](./WORKFLOW.md) | Branching, verification, review, publication, and documentation workflow |
| [`brand/VISUAL_LANGUAGE.md`](../../brand/VISUAL_LANGUAGE.md) | Brand aesthetic, palette of record, motion grammar, and anti-patterns |

Each contract has one owner. Other documents should summarize only what their audience needs and link to that owner instead of repeating detailed rules.

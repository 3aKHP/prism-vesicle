# Public Developer Documentation

This directory contains the tracked, public developer contracts for Prism Vesicle. Its documents must be sufficient for a contributor to understand the current architecture, runtime boundaries, engineering rules, and delivery workflow without access to machine-local notes.

## Boundary With `dev/docs`

The two similar paths have deliberately different roles:

| Path | Publication | Authority | Content |
|------|-------------|-----------|---------|
| `docs/dev/` | Tracked and public | Current contributor and runtime contracts | Architecture, engineering policy, supported behavior, and reproducible workflows |
| `dev/docs/` | Gitignored and machine-local | Supporting context only; always subordinate to source, `STATUS.md`, and `docs/dev/` | Active plans, private reference paths, research, local decisions, and historical execution records |

A public developer contract must never require a file under `dev/docs/` to be understood or followed. The deliberate navigation exception is that `AGENTS.md` and `CLAUDE.md` directly index the optional local `dev/docs/REFERENCE_PROJECTS.md` file for AI collaborators; this does not make any runtime or contributor contract depend on its contents. A local note may cite public contracts. When local research establishes a durable rule that contributors or implementations must follow, summarize the decision, remove machine-private details, and update the owning public document; do not publish the local note by moving it wholesale.

Promotion flows in one direction. An internal conclusion becomes public only by being distilled into the owning document here, under `brand/`, or in the user manual. Once the effective result of an internal decision is fully carried by a public contract and verified against current source, the consumed internal note is archived under `dev/docs/archive/YYYY-MM/` with a header that marks it as historical and points at the current public authority; it is not deleted. A rule that is still internal, future, or not yet shipped stays in `dev/docs/decisions/` and must not be described here as a current contract. Internal Decision Record metadata, promotion, and archive lifecycle are defined by the local `dev/docs/README.md`.

## Document Classes

### Core governance

| Document | Responsibility |
|----------|----------------|
| [`STYLE.md`](./STYLE.md) | Source-code structure, maintainability, types, errors, naming, comments, and test design |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Ownership, dependency direction, cross-cutting boundaries, and domain-contract routing |
| [`WORKFLOW.md`](./WORKFLOW.md) | Branching, verification, review, publication, and documentation workflow |
| [`AUDIT_DRIFT.md`](./AUDIT_DRIFT.md) | Audit-database drift recognition, fix-forward SOP, waiver path, and release rule |
| [`USER_AGENCY_AND_RISK_DISCLOSURE.md`](./USER_AGENCY_AND_RISK_DISCLOSURE.md) | User agency, disclosure, confirmation, and enforceable-boundary policy |

### Runtime and product contracts

| Document | Responsibility |
|----------|----------------|
| [`ASSETS.md`](./ASSETS.md) | Bundled and managed Harness assets, host extensions, verification, and Quality Guard bindings |
| [`PROVIDERS.md`](./PROVIDERS.md) | Provider selection, normalized protocol boundary, transport, usage, and configuration |
| [`OPENAI_RESPONSES_CONFORMANCE.md`](./OPENAI_RESPONSES_CONFORMANCE.md) | Versioned Responses/Codex application-layer profile, evidence fixtures, and update procedure |
| [`TOOLS.md`](./TOOLS.md) | Model-visible tools, path guards, permissions, process authority, gates, questions, and MCP execution |
| [`SESSIONS.md`](./SESSIONS.md) | Session persistence, projection, checkpoints, rewind, compaction, and recovery |
| [`PERSISTENT_INSTRUCTIONS.md`](./PERSISTENT_INSTRUCTIONS.md) | Instruction resolution, prompt composition, mutation, and capability limits |
| [`SUBAGENTS.md`](./SUBAGENTS.md) | Child-Agent lifecycle, persistence, capability, concurrency, and delivery |
| [`SKILLS.md`](./SKILLS.md) | Skill format, discovery, storage, path safety, and current capability boundary |
| [`TUI.md`](./TUI.md) | Terminal layout, input ownership, commands, rendering, and side-question interaction |
| [`STAGE.md`](./STAGE.md) | Stage consumer Engine bootstrap, three-part packet, and prose-first rendering contract |
| [`QUALITY_GUARD.md`](./QUALITY_GUARD.md) | Output Quality Guard delivery-policy runtime: candidate extraction, detector, Semantic Judge, host policy, and rewrite lifecycle |
| [`SETUP.md`](./SETUP.md) | Windows installer scope, guided onboarding, configuration transactions, and project launch |

### Focused specifications

| Document | Responsibility |
|----------|----------------|
| [`COMMAND_COMPLETION.md`](./COMMAND_COMPLETION.md) | Slash-command argument-completion contract |
| [`COMMAND_QUEUE.md`](./COMMAND_QUEUE.md) | Slash-command scheduling while the Agent Loop is busy |
| [`QUALITY_BENCHMARK.md`](./QUALITY_BENCHMARK.md) | Developer-only Semantic Judge measurement, limits, recovery, and evidence boundary |

## Maintenance Rules

- Keep documents current and self-contained. Shipped state and known limits belong in [`STATUS.md`](../../STATUS.md); link there instead of copying volatile inventories.
- Use `UPPER_SNAKE_CASE.md` for new files; `README.md` is the directory-entry exception.
- Keep this directory single-language English under the language policy in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
- Use natural Markdown wrapping and repository-relative links. Do not include absolute local paths, private endpoints, credentials, or unverified machine-specific claims.
- Put a new rule in the document that owns the decision. Create another file only when it defines a distinct durable contract or focused specification.
- Update the owning contract in the same change as the behavior it governs, then run link, stale-term, and formatting checks proportionate to the change.

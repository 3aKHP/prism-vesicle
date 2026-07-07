# Prism Vesicle Project Status

_Last updated: 2026-07-07_

## Current Version

| Area | Version | Status |
|------|---------|--------|
| Prism Vesicle | 0.1.0 | Profile-driven engine host with gate runtime |
| Prism assets | v9.0 State-Space | Copied and host-adapted |
| Default provider | OpenAI-compatible Chat Completions | Implemented |
| TUI | OpenTUI + Solid | Responsive shell + gate/session panels |
| Gate runtime | request_confirmation + needs_user loop | ETL blueprint + phase gates wired |
| Validators | Module A + Module B v9 schemas | Implemented |
| Streaming | OpenAI-compatible SSE | In progress on 0.2 branch |

## Current Scope

0.1.0 makes Vesicle a credible direct API host for Prism Engine, not just a
Chat wrapper:

- Load engine profiles from `assets/engines/*.yaml` and drive systemPrompt,
  tool surface, validators, and stop gates from them at runtime.
- Run a terminal UI with provider status, markdown-rendered message stream,
  responsive workspace/artifact sidebar, wide-screen activity/artifact pane,
  slash hints, prompt history recall, and input bar.
- Call an OpenAI-compatible Chat Completions endpoint.
- Persist sessions as JSONL under `.vesicle/sessions/`; resume them through a
  TUI picker, including unresolved `request_confirmation` gates.
- Execute a file-tool loop (`list_files` / `read_file` / `write_file`) with a
  high ceiling and a no-progress circuit breaker instead of a coding-agent
  hard cap.
- Pause the workflow on `request_confirmation` gates; the user confirms,
  revises, or retreats to chat, then the loop continues.
- Validate artifact-shaped ETL output against Module A (character card) and
  Module B (scenario card) v9 schemas; ordinary prose replies are not reported
  as schema failures.
- Dump the fully composed system prompt via `vesicle prompt dump --engine <id>`
  for host-pollution auditing.

The Prism asset lineage comes from the public sibling repository
[`3aKHP/Neural-Narratology`](https://github.com/3aKHP/Neural-Narratology).

## Repository Structure

```text
prism-vesicle/
├── src/
│   ├── cli/              # CLI entry, doctor, prompt dump
│   │   └── commands/     # prompt-dump subcommand
│   ├── config/           # Environment config loading
│   ├── core/
│   │   ├── agent-loop/   # Provider calls, tool loop, gate pause/resume
│   │   ├── engine/       # Engine profile YAML loader
│   │   ├── gate/         # request_confirmation tool + GateRequest types
│   │   ├── prompt/       # Prompt loading and composition
│   │   ├── session/      # JSONL session store + resume helpers
│   │   ├── tools/        # Vesicle tool contracts and implementations
│   │   └── validators/   # Module A/B v9 validators + registry
│   ├── providers/        # Provider-neutral types and adapters
│   ├── tui/              # OpenTUI/Solid interface, theme, GatePrompt
│   ├── mcp/              # Future MCP integration surface
│   └── skills/           # Future controlled skill bundle surface
├── assets/
│   ├── engines/          # Engine profile YAML
│   ├── prompts/          # Vesicle base + Prism engine prompts
│   ├── specs/            # Prism v9 schemas
│   ├── templates/        # Prism v9 templates
│   └── protocol/         # Protocol references
├── docs/
│   └── dev/              # Developer docs and architecture rules
├── dev/
│   └── docs/working/     # Working plans and drafts
└── tests/                # Bun tests
```

## Tool Surface

| Tool | Status | Write scope |
|------|--------|-------------|
| `list_files` | Implemented | Read-only |
| `read_file` | Implemented | Read-only |
| `write_file` | Implemented | `workspace/`, `test_runs/`, `novels/`, `reports/` |
| `request_confirmation` | Implemented (gate) | No filesystem access |
| `config.load` | Internal contract | N/A |
| `prompt.load` | Internal contract | N/A |
| `session.write` | Internal contract | `.vesicle/sessions/` |

All model-visible filesystem paths are project-relative. Absolute paths and
`..` escapes are rejected. The `request_confirmation` tool is only attached to
a turn when the active engine profile declares at least one stop gate.

## Gate Runtime

| Gate | Engine | Status |
|------|--------|--------|
| `blueprint-confirmation` | etl | Wired (Phase 0) |
| `phase-confirmation` | etl | Wired (Phase artifact checkpoints) |
| `runtime-turn` | runtime | Declared in profile, runtime-ready |

Engines with empty `stopGates` never offer `request_confirmation`, so their
models cannot invoke a gate the host would then have to refuse.

## Validators

| Validator | Engine | Checks |
|-----------|--------|--------|
| `character-card` | etl | Module A v9: frontmatter allowlist, seven sections, Persona Topology subsections, axis counts, L-System leakage |
| `scenario-card` | etl | Module B v9: 3–5 beat map, per-beat fields, tension range, trajectory, legacy field rejection |

Validator failures are advisory — they surface in the TUI and session log but
never abort a turn. Validators run only on artifact-shaped assistant content
(YAML-frontmatter documents), not on ordinary phase-transition prose.

## Known Limits

- Only OpenAI-compatible Chat Completions is implemented (Anthropic Messages,
  OpenAI Responses, Gemini are deferred).
- OpenAI-compatible SSE streaming is implemented on the 0.2 branch for
  assistant content deltas and streamed tool-call reconstruction. Other
  provider protocols are still deferred.
- TUI engine switching is hardcoded to ETL (runtime/evaluate profiles exist
  and load, but the TUI does not yet offer a selector).
- Gate UI is Select-style for ETL blueprint and phase checkpoints, with a
  dedicated bottom confirmation panel. Workflow B hook selection may still need
  a more specialized selector later.
- MCP and Skills are directory stubs, not runtime integrations.
- Long-form engines (Weaver / Weaver-Orch / Dyad) have profiles and prompts
  but no dedicated validators or gate wiring.
- Prompt-cache engineering (PrefixShape hashing, CacheDiagnostics) is deferred.

## Verification

Current standard checks:

```powershell
bun run typecheck
bun test
bun run doctor
```

The `tests/e2e-gate.test.ts` suite runs against the real provider when
`VESICLE_API_KEY` is present; it is skipped otherwise.

## Workflow Docs

- `AGENTS.md`: AI collaborator startup rules and guardrails.
- `CLAUDE.md`: Claude Code startup pointer.
- `docs/dev/WORKFLOW.md`: branch model, iteration loop, hotfix path, and
  independent CR process.
- `docs/dev/STYLE.md`: architecture, tool-runtime, prompt, session, and TUI rules.

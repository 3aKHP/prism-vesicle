# Prism Vesicle Architecture And Style

This file records the hard rules for code shape, prompt/runtime boundaries, and
tool behavior. It is intentionally practical: keep Vesicle small, explicit, and
hard to fool.

## Layering

```text
cli/            # command dispatch only
tui/            # OpenTUI rendering and keyboard interaction
config/         # environment loading and config inspection
core/engine/    # engine profile YAML loading
core/prompt/    # prompt asset loading and composition
core/session/   # durable session persistence + resume helpers
core/tools/     # host tool contracts and execution
core/gate/      # request_confirmation tool + GateRequest types
core/agent-loop/# provider requests, tool loop, gate pause/resume
core/validators/# Module A/B v9 schema checks + registry
providers/      # protocol adapters only
assets/         # runtime prompt/spec/template/profile assets
```

Allowed dependency direction:

- `cli -> tui, core, config`
- `tui -> core, config, providers/types`
- `core/agent-loop -> providers, prompt, session, tools, gate, engine, validators`
- `providers -> providers/shared` and config only
- `core/tools` must not depend on providers or TUI
- `core/gate` depends only on `core/tools` types

## File Size And Responsibility

- A file should do one job. If a file crosses roughly 300 lines, ask whether a
  subsystem should be split.
- A function over roughly 50 lines or with nesting deeper than three levels
  should usually become smaller units.
- Do not create generic `helpers.ts` piles. Name modules by domain.

## Provider Adapters

Provider adapters convert Vesicle's internal request model to wire format and
back. They must not:

- read or write project files
- mutate sessions
- know about Prism engine phases
- implement host tools directly

Tool calls are normalized into `ToolCall` and executed by `core/tools`.

## Tool Runtime

Model-visible tools are a security boundary.

- Only project-relative paths are allowed.
- Absolute paths and traversal outside the project root are rejected.
- Read/list roots: `assets/`, `source_materials/`, `workspace/`, `test_runs/`,
  `novels/`, `reports/`.
- Write roots: `workspace/`, `test_runs/`, `novels/`, `reports/`.
- A model must not claim a file was written unless `write_file` returned success.
- The `request_confirmation` gate tool is attached only when the active engine
  profile declares at least one stop gate. Undeclared gates are refused with a
  tool result, not paused — the model self-corrects on the next turn.
- Tool-loop ceilings protect against genuinely stuck models, not against a
  model that legitimately chains many tool calls. The breaker fires on
  consecutive *failing* tool rounds, not on raw tool count.

Add tests when adding or changing a tool. Include both the successful behavior
and the boundary check that prevents overreach.

## Gate Runtime

Gates are workflow discipline, not a security permission system. They encode
"the engine should pause here for human confirmation" — the opposite of a
coding agent's "should I let this tool run?" prompt.

- A gate is declared in an engine profile's `stopGates` list and triggered by
  a `request_confirmation` tool call.
- The agent loop returns `needs_user` and hands control to the caller (TUI);
  it does not call back into the UI. Session state is durable, so resume is
  just reading the session.
- `resolveGate()` writes the user's decision as the gate tool result and
  continues the loop. `confirm` advances, `revise` retries with feedback,
  `chat` retreats to free conversation.
- Engines with no declared stop gates never offer the gate tool. A model
  cannot invent a gate the host did not approve.
- Interactive resume must preserve unresolved gate state for the TUI. A
  non-interactive provider resume may synthesize "gate was not resolved" tool
  results to satisfy Chat Completions tool-call pairing, but the TUI should
  restore the decision panel when the original request_confirmation arguments
  are available.

## Prompt Assets

Prompts are runtime assets, not hardcoded source literals.

- Vesicle host rules live in `assets/prompts/shared/vesicle-base.md`.
- Prism engine prompts live in `assets/prompts/engines/`.
- Specs and templates under `assets/` are read-only references for the model.
- Host-specific references such as Codex, Claude Code, RooCode, `AGENTS.md`,
  `CLAUDE.md`, `ask_followup_question`, and `new_task` should not leak into
  Vesicle engine prompts except as negative host-boundary examples.

## Session Semantics

- One interactive TUI run should reuse one active session until the user starts
  or resumes another session.
- JSONL records are append-only.
- Provider requests must include prior user/assistant turns when continuing a
  session.
- Tool calls and tool results should be persisted for replay/debugging.
- Session lists should mark unresolved gates so the user can distinguish a
  normal transcript from a workflow waiting for confirmation.
- Long-running turns should emit host-visible activity events before and after
  provider requests, tool calls, gate pauses, and validation. Provider
  streaming should emit assistant deltas as they arrive while still
  reconstructing a final provider response for session replay.

## Validation Semantics

- Profile validators check Prism artifact documents, not every assistant turn.
- Ordinary phase-transition prose such as "confirmed, moving to Phase 1" must
  not be reported as a Module A/B schema failure.
- Artifact-shaped assistant content starts with YAML frontmatter. Future
  artifact-file validation should read the corresponding `write_file` output or
  artifact on disk before presenting findings.

## TUI Interaction

- Keep the surface dense and operational.
- The layout must remain readable at 80 columns. Hide secondary panes before
  squeezing the message stream below a useful width.
- Gate and picker panels own the bottom area while active; side panes may be
  hidden during those modes so confirmation controls stay legible.
- The wide right pane should show operational activity or artifact context, not
  duplicate the last assistant message already visible in the main stream.
- Ctrl+C behavior:
  - With a selectable OpenTUI range, copy selection.
  - Without a selection, first press arms exit and the second press exits.
  - Use `renderer.destroy()` for real shutdown.
- Avoid changing layout dimensions based on dynamic text when possible.

## Tests

Use Bun tests under `tests/`.

Standard checks:

```powershell
bun run typecheck
bun test
```

Add focused tests for:

- config and prompt loading
- session history reuse
- provider tool-call normalization
- tool execution and path guards
- TUI smoke rendering

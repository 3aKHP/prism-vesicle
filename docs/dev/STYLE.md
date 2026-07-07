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

Provider selection is host state, not prompt state. The TUI may switch among
configured provider/model profiles, but adapters still receive a normalized
`VesicleRequest` and must not know about sessions, artifacts, or Prism phases.
Generation controls follow the same rule: core/TUI may pass the normalized
`reasoningTier` values (`off`, `low`, `midium`, `high`, `xhigh`, `max`), but
only the provider adapter maps them to wire fields such as `thinking` and
`reasoning_effort`. TUI commands may offer `auto`/`unset` to clear an explicit
selection; that means no `reasoningTier` is sent.
Anthropic Messages adapters map Vesicle messages to Anthropic content blocks:
assistant thinking blocks must be emitted before text/tool_use blocks, and
tool results are user messages containing `tool_result` blocks. The agent loop
and session store must not interpret these native blocks beyond preserving
their typed metadata. Anthropic streaming must reconstruct text, thinking, and
tool_use blocks by provider content-block index before emitting the final
`VesicleResponse`.
Gemini `generateContent` adapters map Vesicle messages to `systemInstruction`
plus `contents`, and tool results to `functionResponse` parts. If Gemini
returns `thought` / `thoughtSignature` metadata, preserve the original model
parts as provider-native `gemini_part` thinking blocks and replay those parts
on the next request instead of reconstructing them from assistant prose. This
keeps Gemini's tool-loop thought signatures attached to the exact parts that
the provider expects.
High-frequency thinking controls may be interactive TUI state. Lower-frequency
generation defaults such as `temperature` and `maxTokens` belong in the
user-level provider model config and are merged by `core/agent-loop` before
calling adapters. Adapters should only map the normalized request shape to wire
fields; they should not invent host policy defaults.
Persistent provider profiles live in the user-level provider config, not in the
project `.vesicle/` runtime state directory. The default path is
`%APPDATA%\prism-vesicle\providers.yaml` on Windows and
`$XDG_CONFIG_HOME/prism-vesicle/providers.yaml` or
`~/.config/prism-vesicle/providers.yaml` elsewhere. API keys must be referenced
via per-provider environment variables (`apiKeyEnv`) and must not be stored
inline in the provider file. The user-level `.env` file beside
`providers.yaml` is the default place for those secret values; process
environment variables are fallback only so a legacy project-root `.env` loaded
by the runtime cannot override the user-level secret file.
`providers.yaml` supports string model entries for the common case and object
model entries for `id`, `generation`, and `capabilities` metadata. Keep this
schema small and explicit until native protocol adapters require more fields.

## Tool Runtime

Model-visible tools are a security boundary.

- Only project-relative paths are allowed.
- Absolute paths and traversal outside the project root are rejected.
- Read/list/stat/grep roots: `assets/`, `source_materials/`, `workspace/`,
  `test_runs/`, `novels/`, `reports/`.
- Create/write/replace/append/delete/copy-target/move roots: `workspace/`,
  `test_runs/`, `novels/`, `reports/`.
- `delete_file` must delete only files, never directories or directory trees.
- `grep_files` regex mode is for trusted single-user model input. If Vesicle
  ever exposes untrusted model/plugin input, regex matching needs a timeout
  boundary such as RE2 or a worker-thread sandbox.
- A model must not claim a file was created, written, edited, deleted, copied,
  or moved unless the corresponding file tool returned success.
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
- User-selected reasoning tiers should be persisted as session metadata so
  interactive resume restores runtime generation behavior. Provider
  thinking state is preserved as thinking blocks for protocol continuity and
  TUI display, but it is metadata and must not be merged into normal assistant
  prose. OpenAI-compatible `reasoning_content` is a compatibility bridge into
  that block structure.
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
- Artifact-shaped assistant content starts with YAML frontmatter. Artifact
  workbench validation reads the selected artifact file from disk before
  presenting findings, so validation reflects what was actually written rather
  than only the last assistant message.

## TUI Interaction

- Keep the surface dense and operational.
- The layout must remain readable at 80 columns. Hide secondary panes before
  squeezing the message stream below a useful width.
- Gate and picker panels own the bottom area while active; side panes may be
  hidden during those modes so confirmation controls stay legible.
- The wide right pane should show operational activity or artifact context, not
  duplicate the last assistant message already visible in the main stream.
- Provider/model switching commands and artifact workbench commands are local
  host actions. They should add concise host notices to the transcript and must
  not call the provider unless the command explicitly starts a revision prompt.
- Reasoning content should follow the RikkaHub-style pattern of a separate
  thinking block before assistant text: it is independent from the assistant
  markdown body, collapsible or hideable, and bounded by height/tail display so
  long thinking does not dominate the transcript.
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

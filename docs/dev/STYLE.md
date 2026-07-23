# Prism Vesicle Architecture And Style

This file records the hard rules for code shape, prompt/runtime boundaries, and
tool behavior. It is intentionally practical: keep Vesicle small, explicit, and
hard to fool.

## Layering

```text
cli/  # command dispatch only
tui/  # OpenTUI rendering and keyboard interaction
config/  # environment loading and config inspection
setup/  # guided onboarding, discovery, validated config transactions
core/agent-loop/  # provider requests, tool loop, gate pause/resume
core/agents/  # Agent profiles, child lifecycle, concurrency, inbox delivery
core/artifacts/  # artifact discovery, preview bounds, validation selection
core/attachments/  # clipboard image content-addressed store
core/checkpoints/  # per-turn file snapshots, diff stats, restore
core/compact/  # context compaction service
core/engine/  # engine profile YAML loading
core/gate/  # request_confirmation tool + GateRequest types
core/harness/  # Harness manifest verification, compatibility, immutable install
core/permissions/  # Tool Permission Runtime broker and policy
core/process/  # bounded Process Runtime and shell profiles
core/prompt/  # prompt asset loading and composition
core/quality/  # Output Quality Guard host runtime
core/rewind/  # conversation rewind and partial summarization
core/runtime/  # engine and runtime asset resolution helpers
core/session/  # durable session persistence + resume helpers
core/side-question/  # `/btw` tool-free side question snapshot + service
core/stage/  # Stage consumer bootstrap
core/tools/  # host tool contracts and execution
core/user-question/  # ask_user_question host question types
core/validators/  # Module A/B v9 schema checks + registry
mcp/  # external MCP tool discovery and execution
providers/  # protocol adapters only
skills/  # future controlled skill bundle surface
types/  # shared host types
assets/  # exact bundled V10 Harness manifest inventory
host-assets/  # restricted Vesicle prompts and generic Agent extensions
harness-manifest.json  # bundled V10 Harness identity and hashes
```

Allowed dependency direction:

- `cli -> tui, core, config`
- `tui -> core, config, providers/types`
- `setup -> config, mcp, core engine/permission types, and reusable TUI presentation/input primitives`
- `core/agent-loop -> providers, prompt, session, tools, gate, engine, validators, mcp`
- `core/agents -> providers, session, tools, runtime assets, mcp`
- `core/harness -> engine, agents, tools, validators, runtime assets, config paths`
- `core/artifacts -> tools, validators`
- `providers -> providers/shared` and config only
- `core/tools` must not depend on providers or TUI
- `mcp` must not depend on providers or TUI; it may depend on core tool types
  and engine ids for tool definitions and engine scoping
- `core/gate` depends only on `core/tools` types

## Responsibility And Maintainability

Do not use line counts, function length, nesting depth, or similar numeric thresholds as hard pass/fail rules. They may help locate code worth reviewing, but they do not prove that code is well or poorly structured.

Evaluate structure from several signals together:

- Semantic cohesion: a module or function should express one recognizable domain responsibility, even when that responsibility needs substantial code.
- Reasons to change: unrelated policy, persistence, I/O, state-machine, protocol, and presentation concerns should not accumulate under one owner.
- Coupling and knowledge: watch dependency fan-out, cross-layer imports, duplicated invariants, and code that must understand several subsystems to make a local change.
- Local reasoning and testing: behavior should be understandable and testable through a narrow interface without constructing unrelated runtime state.
- Change safety: prefer boundaries that let one concern evolve without broad edits, synchronized changes across files, or fragile ordering assumptions.

Split code when these signals reveal a stable domain boundary or a recurring maintenance cost. Keep a large composition root, registry, parser, state machine, or data table intact when it remains cohesive and splitting it would scatter invariants or introduce indirect coupling. Do not create generic `helpers.ts`, `utils.ts`, or `common.ts` piles; name extracted modules by the domain responsibility they own.

## Provider Adapters

Provider adapters convert Vesicle's internal request model to wire format and
back. They must not:

- read or write project files
- mutate sessions
- know about Prism engine phases
- implement host tools directly

Tool calls are normalized into `ToolCall` and executed by `core/tools`. MCP
tools are the origin exception, not a provider-shape exception: the agent loop
discovers them through `src/mcp`, exposes them as ordinary function tool
definitions, and dispatches `mcp_<prefix>_<tool>` aliases back through the MCP
registry. Provider adapters still see only normalized tool definitions and
tool-call messages.

Provider selection is host state, not prompt state. The TUI may switch among
configured provider/model profiles, but adapters still receive a normalized
`VesicleRequest` and must not know about sessions, artifacts, or Prism phases.
Provider responses may include normalized usage counters (`contextInputTokens`,
`inputTokens`, `outputTokens`, cache read/write/hit/miss counts, reasoning
tokens, and effective tokens). `contextInputTokens` is the request's active
context-window occupancy after provider-specific cache accounting: do not add
cached tokens twice for OpenAI-compatible/Gemini providers, but do include
Anthropic cache creation/read counters. Adapters may map provider-native usage
detail objects into `providerDetails`, but must keep raw requests, headers,
URLs, and secrets out of that metadata. Pricing and billing policy belong
outside adapters.
User and tool messages may carry durable image attachment references. Core
materializes those references into base64 before invoking an adapter;
provider adapters map already-materialized data to native image blocks and
must not read image files themselves. Models opt in with
`capabilities.vision: true`; non-vision models receive neither image content
nor the `view_image` tool.
Generation controls follow the same rule: core/TUI may pass the normalized
`reasoningTier` values (`off`, `low`, `medium`, `high`, `xhigh`, `max`), but
only the provider adapter maps them to wire fields such as `thinking` and
`reasoning_effort`. TUI commands may offer `auto`/`unset` to clear an explicit
selection; that means no `reasoningTier` is sent.
Provider HTTP calls share one transport retry policy under `providers/shared`.
Retry only failures that are safe before a response is consumed: connection
errors, 408, 429, and 5xx. Use bounded exponential backoff with jitter, honor a
bounded `Retry-After`, and let host cancellation interrupt both fetch and
backoff. Do not replay a partially consumed SSE stream inside an adapter; that
requires agent-loop/TUI reconciliation so deltas and tool calls cannot be
duplicated.
Application-level provider headers are centralized under `providers/shared`.
OpenAI-compatible Chat follows the audited OpenCode header shape, Anthropic
Messages follows the Claude Code fingerprint, and Gemini follows Gemini CLI's
Google GenAI SDK shape. Streaming must preserve each protocol's normal
`Accept` behavior instead of applying a shared `text/event-stream` override;
Gemini selects SSE through `alt=sse`. Leave `Host`, `Content-Length`,
`Connection`, and compression negotiation to Bun. Authentication headers are
injected by the adapter after the fingerprint. The only user-configurable
header is provider-level `userAgent`; arbitrary header overrides are not part
of the provider registry contract.
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
`providers.yaml` supports optional provider-level `defaultModel` and
`userAgent` fields, string model entries for the common case, and object model
entries for `id`,
`generation`, `capabilities`, and `limits` metadata. `generation.maxTokens` is
the provider request default; `limits.contextWindow` is model capacity metadata
used by `/context` and footer percentages. A `defaultModel` must name a model
in the same provider catalog. Keep this schema small and explicit until native
protocol adapters require more fields.

## Guided Setup And Installer

- The Windows installer owns only the application lifecycle: complete runtime payload, per-user install location, PATH, shortcuts, upgrade identity, and uninstall. It must not parse provider/MCP schemas, accept secrets, or mutate `%APPDATA%\prism-vesicle`.
- The installed terminal command is the native `vesicle.exe`, renamed from the staged release binary during installation rather than wrapped in a batch file. Upgrades remove superseded executable, wrapper, and Start Menu launch entries. A detected installation exposes Reinstall, Repair, and Uninstall maintenance choices; Repair restores installed files and Windows integration without reopening Guided Setup.
- `src/setup` owns interactive onboarding. Network discovery, masked input, configuration merge/backup, validation, optional MCP/Tavily setup, permission defaults, and project selection stay in the application so they reuse runtime contracts.
- Setup choice pages must expose a visible backward action in addition to Escape handling, reset selection when returning to a shorter option list, and keep every rendered row clipped within compact terminal bounds.
- OpenAI-compatible model discovery may use the user-supplied Base URL and API key only for a bounded `GET /v1/models` request. Do not follow credential-bearing redirects, log the key, infer capabilities from model names, or make discovery success mandatory when exact manual ids are available.
- Setup configuration writes are host actions, not model-visible tools. Validate the complete staged provider/MCP/environment shape, preserve unrelated secrets and profiles, create timestamped backups for existing files, and keep YOLO and `shell_exec` out of first-run persistent defaults.
- Setup must not persist a global project pointer. An optional onboarding folder is only a one-time post-Setup launch target. Every later project launch derives its root from the invocation directory or an explicit `vesicle <directory>` argument; path-based launch starts a new process with that directory as cwd rather than changing the parent process cwd.

## Tool Runtime

Model-visible tools are a security boundary.

- Only project-relative paths are allowed.
- Absolute paths and traversal outside the project root are rejected.
- Existing path components must not be symbolic links or linked directory junctions. For missing targets, validate the nearest existing ancestor before mutation.
- Read/list/stat/grep roots: `assets/`, `source_materials/`, `workspace/`,
  `test_runs/`, `novels/`, `reports/`.
- Create/write/replace/append/delete/copy-target/move and directory-mutation roots:
  `source_materials/`, `workspace/`, `test_runs/`, `novels/`, `reports/`.
- The canonical generated-artifact root set and display order live in
  `core/artifacts/roots.ts`. Filesystem write guards and artifact workbench
  discovery must consume that shared constant instead of declaring parallel
  arrays. `source_materials/` is a writable research/input root but is not a
  final artifact root, so `/artifact` discovery and the Artifacts sidebar stay
  scoped to the other four roots.
- `read_file` remains UTF-8 text-only. Binary visual inspection uses
  `view_image`, which shares the readable-root path guard, validates image
  magic bytes and size, and emits a structured attachment instead of base64
  tool text.
- `delete_file` must delete only files, never directories or directory trees.
- `list_directory` exposes files, directories, and symbolic-link entries without following links. Recursive listings are bounded.
- `create_directory`, `move_directory`, and `delete_directory` operate only below writable roots; the fixed roots themselves cannot be created, moved, or deleted.
- `delete_directory` deletes empty directories only. Recursive directory deletion is intentionally not model-visible.
- `grep_files` regex mode is for trusted single-user model input. If Vesicle
  ever exposes untrusted model/plugin input, regex matching needs a timeout
  boundary such as RE2 or a worker-thread sandbox.
- A model must not claim a file was created, written, edited, deleted, copied,
  or moved unless the corresponding file tool returned success.
- The `request_confirmation` gate tool is attached only when the active engine
  profile declares at least one stop gate. Undeclared gates are refused with a
  tool result, not paused — the model self-corrects on the next turn.
- The `request_engine_switch` handoff tool is available to all engines. It is
  a user-confirmed host workflow boundary, not a normal tool side effect:
  confirmed switches update future turns and must not continue the same tool
  loop under a different system prompt. Rejected switches must complete the
  tool call and continue the current engine loop so the model can respond to
  the user's feedback or ask for clarification when no feedback was supplied.
- Engine switches use one host-level transition shape whether they come from
  manual `/engine` commands or model-requested `request_engine_switch`
  handoffs. Confirmed/in-session transitions may append a bounded user-role
  `engine_handoff` packet to the conversation instead of adding a dynamic
  history `system` message or modifying the composed system prompt. This keeps
  the packet visible to OpenAI-compatible, Anthropic Messages, and Gemini
  adapters while preserving the engine prompt as the stable prefix-cache
  boundary. Runtime behavior defaults to full-context preservation; manual
  `/engine <id> --summary [notes]` compacts first, and model-requested
  handoffs can use the confirmation panel's `Confirm with summary` option.
  Both record the transition as `contextPolicy: summary`. The `fresh` policy
  remains reserved for a future explicit context-discard workflow.
- The `ask_user_question` tool is available to all engines for one
  user-facing single-select clarification question. The model supplies 2-4
  concrete options; the host appends Skip and open-ended answer fallbacks while
  preserving the model option order. The open-ended fallback exposes an inline
  composer and continues the current engine loop after the user chooses,
  unlike engine handoff. Do not collapse Skip and open-ended answer: neither is
  semantically equivalent to gate rejection.
- `web_search`, `web_fetch`, `web_map`, `web_crawl`, and `web_research` are
  host-executed Tavily web tools, not provider adapter features. Attach them
  only to research/audit engines that declare them, keep provider adapters
  unaware of Tavily, and persist structured `webEvent` metadata for replay. Web
  results do not mutate project files; engines must use file tools to write
  synthesized notes under `source_materials/`.
- MCP tools are host-executed external tools configured in user-level
  `mcp.yaml` beside `providers.yaml`, or by `VESICLE_MCP_FILE`. Header values
  may use `${ENV_VAR}` or `${ENV_VAR:-fallback}` placeholders that expand from
  the sibling `.env` loaded for provider/Tavily secrets. Do not log or persist
  resolved header values. The first runtime milestone supports Streamable HTTP
  `tools/list` and `tools/call` only; stdio, classic HTTP+SSE, prompts, and
  resources remain separate future work.
- Tool-loop ceilings protect against genuinely stuck models, not against a
  model that legitimately chains many tool calls. The breaker fires on
  consecutive *failing* tool rounds, not on raw tool count.

Add tests when adding or changing a tool. Include both the successful behavior
and the boundary check that prevents overreach.

## Tool Permission Runtime

- Permission modes control approval friction and never widen the effective tool surface or bypass runtime guards. MANUAL asks for every model-visible execution, INERTIA auto-allows observation tools, MOMENTUM auto-allows every tool except `shell_exec`, and YOLO auto-allows all effective tools.
- `request_confirmation`, `request_engine_switch`, and `ask_user_question` are interaction requests and remain outside Tool Permission Runtime. Gates continue to represent workflow discipline rather than security approval.
- Unknown tools fail closed into the mutate class. Every provider-returned call is also checked against the current effective tool surface before permission evaluation or execution; a permission mode must never make an unavailable tool executable. Every MCP tool is mutate regardless of its remote name, description, or schema.
- Permission requests bind to the originating session and tool call. Shell approval additionally binds to the exact normalized execution plan hash. Rejection returns a failed tool result; it does not add a synthetic user turn.
- Child requests are routed through the parent-owned permission broker. A foreground or background child pauses at its call boundary until the parent TUI resolves the request. Child `shell_exec`, `shell_output`, and `shell_stop` remain disabled in the first runtime.
- YOLO cannot be persisted as a user default. Interactive activation requires two red confirmations, resume downgrades a prior YOLO session to MOMENTUM, and `--dangerously-skip-permissions` applies only to the current process while keeping a visible red indicator.
- Permission bypass never disables path guards, MCP/Agent capability scopes, argument validation, output bounds, timeout, environment filtering, process-tree cleanup, or concurrency controls.
- `shell_exec` is opt-in through user-level `permissions.yaml`. It is a non-interactive host command with host-user filesystem and network authority, not an OS sandbox. Shell mutations must mark checkpoint completeness as tainted and must never be described as rewind-safe.
- Shell interpreter selection uses host-owned profiles rather than model-provided executables. Resolve the interpreter before approval, bind its profile id, absolute executable path, and runtime policy version into the exact plan hash, and execute that approved plan without a later cross-profile fallback. Windows `auto` may fall back from PowerShell 7 to Windows PowerShell 5.1 only; Linux/WSL `auto` remains `/bin/sh`. Explicit unavailable profiles fail closed. Every profile owns its non-interactive arguments, output encoding policy, display name, and model-visible command dialect guidance.
- `shell_exec` may set `runInBackground: true` to return a managed short task id immediately. Background output/status is bounded and persisted under ignored `.vesicle/processes/` state, completion is delivered as host-owned provider context at the next available turn, and `shell_output` / `shell_stop` provide explicit observation and cancellation. Background work does not survive a Vesicle host restart as a managed live process; stale running records recover as interrupted and are never replayed.
- Foreground shell cards show bounded live tail output and elapsed time. Background shell cards retain their task id and terminal state, while active background work remains visible in the TUI header and Workspace sidebar. Observability callbacks must not alter process lifetime or tool results.

## SubAgent Runtime

- Agent Profiles are logical runtime assets under `assets/agents/`, independent of the six Prism Engine profiles. User-global, Harness-provided, host-provided, and sparse project profiles use one loader. The only hardcoded profile ids are the exact five generic host Agents (`explore`, `general`, `plan`, `research`, and `reviewer`) because they form a security-relevant exemption from Driver delegation; do not expand that whitelist implicitly.
- Foreground/background controls whether the parent provider loop joins the child. Sequential/parallel is separate: multiple spawn calls from one assistant response must begin before any foreground join is awaited.
- A foreground child shares parent-turn cancellation but keeps the Bun event loop and TUI responsive. A background child owns an independent controller, returns an accepted handle immediately, and delivers its terminal result through the durable parent inbox.
- Never append a late result to the original `spawn_agent` tool call. The accepted background handle completes that call; later completion is a host-owned user-role packet delivered by the continuation scheduler when the parent session is idle.
- `SessionRecord.parentUuid` is only an intra-session branch edge. Persist `parentSessionId` and `parentToolCallId` separately for child ownership.
- Keep host identity and interaction identity separate. Persist an opaque `runId` for storage/recovery and a parent-scoped `<profile>-<ordinal>` handle for model tools and user commands. Never expose new run UUIDs merely because an internal map or error message uses them; legacy ids remain input-only compatibility references.
- Render `spawn_agent` as a first-class Agent card rather than a generic tool card. The stream card owns lifecycle/progress, while the header and sidebar retain a compact active/ready summary after the spawn position scrolls away. Background `ready`, `integrating`, and `integrated` are delivery states and must not be conflated with provider execution.
- Agent `*` inherits the parent's effective tools. An explicit installed profile allowlist may select guarded host tools outside the parent Engine's ordinary surface; MCP tools remain subject to their configured server and Engine scope. Task arguments cannot widen the installed profile.
- Parallel writers are supported. Claim mutated paths for the lifetime of a child and coordinate parent file-tool mutations through the same ownership table. Ownership conflicts include the same path and ancestor/descendant paths, so a directory-tree mutation cannot overlap a child file mutation. Reject conflicting ownership instead of globally forcing children to be read-only.
- Parent completion delivery is serialized with user turns, gates, questions, and engine handoffs. Never mutate an in-flight provider request.

See `docs/dev/SUBAGENTS.md` for the complete lifecycle and delivery contract.

## Gate Runtime

Gates are workflow discipline, not a security permission system. They encode
"the engine should pause here for human confirmation" — the opposite of a
coding agent's "should I let this tool run?" prompt.

- A gate is declared in an engine profile's `stopGates` list and triggered by
  a `request_confirmation` tool call.
- Engine handoff is triggered by `request_engine_switch` and confirmed through
  the same Confirm/Reject UI pattern, with an additional Confirm with summary
  option. It intentionally has no transition allowlist yet; concrete workflow
  restrictions are deferred.
- Clarifying questions are triggered by `ask_user_question` and rendered as an
  option selector with host-owned Skip and open-ended answer fallbacks.
  Arrow-key selection belongs to the question panel and must not scroll the
  message history while the panel is active. Keep it distinct from
  `request_confirmation`; question answers are ordinary information gathering,
  not workflow gates.
- The agent loop returns `needs_user` and hands control to the caller (TUI);
  it does not call back into the UI. Session state is durable, so resume is
  just reading the session.
- `resolveGate()` writes the user's decision as the gate tool result and
  continues the loop. `confirm` advances; `reject` does not advance and either
  carries user feedback or explicitly asks the model to clarify what should
  change before retrying.
- Engines with no declared stop gates never offer the gate tool. A model
  cannot invent a gate the host did not approve.
- Interactive resume must preserve unresolved gate state for the TUI. A
  non-interactive provider resume may synthesize "gate was not resolved" tool
  results to satisfy Chat Completions tool-call pairing, but the TUI should
  restore the decision panel when the original `request_confirmation`,
  `request_engine_switch`, or `ask_user_question` arguments are available.

## Prompt Assets

Prompts are runtime assets, not hardcoded source literals.

- Vesicle host rules resolve logically as `assets/prompts/shared/vesicle-base.md` but are physically owned by the restricted `host-assets/` layer.
- Prism engine prompts live in `assets/prompts/engines/`.
- Specs and templates under `assets/` are read-only references for the model.
- Host-specific references such as Codex, Claude Code, RooCode, `AGENTS.md`,
  `CLAUDE.md`, `ask_followup_question`, and `new_task` should not leak into
  Vesicle engine prompts except as negative host-boundary examples.
- Treat `assets/...` as a logical read-only namespace, not as one physical project directory. Resolution order is sparse project override, user-global override, then one complete verified baseline: either a project-pinned managed Harness or the packaged/standalone bundled V10 Harness. The restricted host layer may supply only declared external host assets and the fixed generic Agent whitelist; directories merge only within the selected resolution stack.
- Profile/prompt loaders and model-visible read tools must consume the same asset resolver. Never let the model receive APPDATA, home-directory, `node_modules`, executable, or Bun virtual filesystem paths.
- Standalone executables must preserve the invocation cwd as the project root. Resolve executable-owned runtime/default files explicitly through `process.execPath`; do not call `process.chdir()` to make asset lookup work.
- Session roots record a content-only fingerprint of the effective merged asset tree. Resume and active continuation warn when that fingerprint changes, while keeping prompt text, user content, absolute paths, and secrets out of drift metadata.
- Sparse overrides are the recommended editing contract. Full snapshots remain available for compatibility but can mask future packaged updates. Version 1 intentionally has no deletion tombstones.

## Persistent Instructions

Persistent Instructions are user-authored Markdown that customizes an Engine's
workflow and survives new sessions. The host loads them into the system prompt
automatically; the user never has to ask the model to write a spec to a file
and remind it to read it next session. This is model context, not automatic
memory: the host never infers, summarizes, or writes instructions without a
model tool call (deferred) or a direct user edit.

- File names are Vesicle-native and aligned across both scopes: `VESICLE.md`
  (general, every Engine) and `VESICLE.<engine>.md` (Engine-specific override),
  where `<engine>` is one of the `engineIds`. They are the Vesicle analog of a
  coding agent's `CLAUDE.md`/`AGENTS.md`. The host must not auto-load those
  aliases, inject coding-agent identity, or name them in Prism engine prompts or
  the instruction envelope preamble. User-authored instruction text is preserved
  verbatim (byte-exact apart from one stripped BOM) and may mention anything —
  the boundary is on what the host names and loads, not on user content.
- Project scope lives at the launch project root and travels with the project.
  User scope lives beside `providers.yaml` (resolved through `userConfigDirectory`),
  so it applies across every project root. Both are outside the guarded `assets/`
  namespace and the writable artifact roots; instruction resolution must not be
  routed through `core/tools/file/path-policy.ts` or the asset resolver, and must
  not perturb the Harness asset fingerprint.
- Resolution is **replacement within a scope, composition across scopes**. Within
  one scope, an Engine-specific target fully replaces that scope's general target;
  file existence — not nonempty content — controls replacement, so an empty Engine
  file is an intentional empty override that suppresses general fallback. If an
  Engine-specific file is present but invalid, fallback to the general file is
  suppressed for that scope. Across scopes, the selected user file is followed by
  the selected project file; project content has higher precedence on a direct
  conflict. Neither can override the Engine contract or host runtime.
- Instructions are appended after the byte-identical Engine prompt as ordered host
  context, never as a second system authority. A fixed host preamble frames each
  block with its scope, target, precedence, and the capability boundary. The
  Engine prompt stays first so provider prefix caching keeps the stable Harness
  prefix; Stage character context follows Persistent Instructions. Every
  system-prompt construction site — turn bootstrap, continuation context, Stage
  bootstrap, `/compact`, and the `/btw` snapshot resolver — composes through one
  primitive, while continuations, the provider round, side-question projection,
  and fork children inherit the already-composed string.
- Persistent Instructions are live user configuration, not session identity.
  The host resolves the active Engine selection from current disk when a
  top-level turn begins, when a session is resumed after a process restart, and
  on a confirmed Engine switch. Within a single turn the selection is frozen:
  an in-process continuation (gate/permission/question/quality) reuses the
  turn-start instruction blocks instead of re-reading disk, so a tool call
  decided under one instruction set never continues under another after a
  mid-turn pause. The frozen snapshot is in-process only; a Vesicle restart
  loses it, so a resumed continuation re-reads current disk, and a new top-level
  turn re-resolves and overwrites it. Editing an instruction file is a
  configuration update that takes effect on the next turn, never mid-turn.
- Validation is fail-soft per scope: decode UTF-8 with fatal error handling
  (strip one leading BOM), require a regular file, reject a project target that
  is a symbolic link and skip a user-scope link, and bound the combined selected
  content to 32 KiB. An invalid, linked, or oversized scope is skipped with a
  diagnostic while the rest of the turn continues; content is never truncated and
  the turn is never blocked by optional instruction state. Never log instruction
  contents; diagnostics and session audit use target, bytes, and hash only.
- Targets are identified by a fixed enum `{ scope, engine }` and never by an
  arbitrary path. Instruction text cannot widen the effective tool surface,
  permission mode, path roots, stop gates, validators, Harness identity, or
  provider configuration; the tool runtime enforces capabilities independently.
- `read_instructions` and `update_instructions` are the model-visible surface for
  Persistent Instructions, available on every Engine except Stage (Stage stays
  strictly tool-less — its consumer-RP role does not benefit from
  self-management of host configuration). `read_instructions` is an observation;
  `update_instructions` is a mutation. They resolve only the fixed `{ scope,
  engine }` target — never an arbitrary path — so they are a bounded host
  exception that writes outside the model-visible writable roots, not a widened
  filesystem surface. `update_instructions` writes atomically (temp + rename),
  keeps one recoverable previous-state backup per target under
  `.vesicle/instruction-backups/` (project) or beside `providers.yaml` (user),
  honors optional `ifMatchSha256` optimistic concurrency (`"absent"` or a 64-hex
  hash; a stale value never overwrites), and rejects any write whose new content
  plus the other scope would exceed the 32 KiB budget for an Engine it affects.
  It routes through the existing Tool Permission Runtime as an ordinary
  `mutate` (MANUAL/INERTIA pause, MOMENTUM/YOLO execute) — never a second
  approval system. A successful update is the one mid-turn reason to recompose:
  it refreshes the in-turn frozen instruction snapshot so the next provider round
  of the same turn observes the new content. The tools are for explicit,
  user-requested persistent workflow management, not autonomous self-modification.

## Managed Harness Packs

- Neural Narratology Harness Packs are independently versioned runtime products. Vesicle must consume a released pack or explicit local pack directory; runtime code and tests must not read a sibling checkout, follow cross-repository symlinks, or embed local source paths.
- `core/harness` owns strict `prism-harness-pack/v1` parsing, file inventory and hash verification, Adapter/capability compatibility, Profile/Prompt binding checks, external host asset checks, and immutable installation under the user configuration directory.
- Compatibility is fail-closed. Do not advertise a capability until Vesicle enforces its full host contract; in particular, generic SubAgent availability is not sufficient for contract-bound `prism-agent/delegation@1`, and prompt guidance is not a substitute for `quality-guard/anti-ai-flavor@1`.
- Contract-bound delegation is a Driver Adapter over the generic SubAgent runtime. Resolve a unique delegation from the active parent Engine and requested Agent Profile, then bind mode, purpose, and retry limit from the verified Driver Contract. Model arguments may provide the self-contained `prompt` and a display label but must not widen those bindings. Harness delegations are sequential within one parent session; transient failures consume the declared retry budget, while exhaustion creates the Contract-declared, append-only, resumable user decision point. A user-authorized extra retry must persist its intent before resolving that decision; if restart cannot restore the same verified Harness context, session resume blocks instead of silently dropping or replaying the retry.
- Delegation failures use the Driver ABI categories `unsupported`, `invalid_request`, `denied`, `not_found`, `conflict`, `transient`, and `failed`. Persist the delegation id, Agent Profile, mode, attempt history, category, and terminal result in session metadata. Cancellation is terminal and does not consume or silently restart a retry.
- `core/quality` owns the host Output Quality Guard. Load Rule Pack and Detector assets only from a verified Harness directory, check their inner artifact hashes and published schema contracts, normalize CRLF/CR to LF plus Unicode NFC, and preserve normalized-candidate UTF-16 offsets while masking fenced code, blockquotes, HTML comments, Prism HUD and host-provided protected ranges. Unknown matcher, metric, preprocessing, schema, or binding semantics fail closed; the first host does not claim `strict` mode.
- Harness `qualityBindings` and `agentQualityBindings` are delivery policy, not permissions or Validators. Artifact targets come only from successful create/write/replace/append `FileToolEvent` records, are keyed by normalized project-relative path, and are evaluated from the complete current UTF-8 post-image through the same writable-path and symlink guards as file tools. A later successful mutation supersedes the same target without clearing its rejected hash history; clean prose or another clean path cannot resolve a blocking target. Runtime `rewrite` buffers prose, keeps rejected candidates out of the displayed transcript, returns target-specific structured findings to the same Engine, allows at most two shared rewrite rounds, and stops when a blocking target repeats its post-image hash. Quality feedback, per-target pending state, pack/rule identity and bounded events must persist before another provider request so permission pauses, cancellation, or restart cannot silently bypass the Guard.
- Quality assessment, policy outcome, and host action are separate durable concepts. New `QualityEvent` records retain the legacy decision projection while adding the policy version, outcome/action, and bounded per-target finding summaries. Exhaustion is a `needs_quality_decision` pause backed by append-only warning, retry-intent, and resolution records; it must not be overwritten by ordinary completion or a simultaneous gate. Retry permits exactly one user-authorized provider continuation under the same Engine, Harness, manifest, and Rule Pack identity. Accept and stop do not call the provider, retain target warnings, and restore any lower-priority gate or question. Cancellation or provider failure leaves the same decision recoverable. Unreadable, non-UTF-8, and over-budget post-images are inconclusive warnings rather than clean results, and only an explicit user resolution or a later clean assessment of the same target may close a warning.
- `observe` records deterministic findings without blocking Dyad, Weaver, Weaver-Orch or Scene Writer. Scene Writer observation runs in the child session before terminal delivery to the parent. `analyze` bindings for Evaluate and Chapter Reviewer describe their own audit role and are excluded from recursive Guard enforcement; a future model-visible analysis tool is a separate capability.
- Explicit tool allowlists in released Harness Agent Profiles may reference only Vesicle built-in host tools, so packs remain portable across projects. Runtime-local MCP or parent-provided tools are not valid explicit pack dependencies; wildcard inheritance remains subject to the runtime child-tool scope.
- `/permissions` is the only ask/allow/deny layer for model-visible tool calls. Harness and HAL declare capabilities and map operations; they must not duplicate permission prompts or require a second per-delegation path-authorization system. Agent Profiles narrow the effective tool surface, while Tool Runtime continues to enforce path, symlink, concurrency, timeout, environment, and process invariants independently of permission mode.
- Installation and activation are separate. The installer accepts an already-extracted directory, verifies it before and after staging, and atomically renames it into `asset-packs/<id>/<version>/`; explicit activation reverifies that immutable directory and atomically writes `.vesicle/assets.lock.json` without mutating editable user assets.
- The bundled V10 Harness is a first-class verified Pack selected automatically when no project lock exists. Its root `harness-manifest.json` and exact `assets/` inventory must be verified before runtime construction; project/user overrides are excluded from that integrity check.
- A selected managed Harness is one complete baseline, not another sparse fallback layer. Project and user overrides may remain above it, but a missing pack file must not fall through to the bundled Pack unless the manifest declares that exact logical path in `externalHostAssets`. Removing a project lock returns to the whole bundled V10 baseline.
- The three Harness workflow Agents remain Driver-contract Agents. Only the exact five generic host Agent ids may use the ordinary concurrent SubAgent path while a Harness is active. Arbitrary project/user Agent Profiles must not use the host exemption and must fail closed when the Driver Contract does not declare a matching delegation.
- Project locks and initial session host metadata persist pack id/version, source commit, manifest hash, and Adapter identity. Every start and resume reverifies the active bundled or managed Pack and requires exact session/project identity; missing, malformed, tampered, rolled-back, or switched identities block provider continuation instead of silently changing Harness content. A persisted quality decision may still be opened under identity drift so the user can accept or stop locally, but retry remains disabled until the exact recorded Harness and Rule Pack identity is restored. Sessions created before bundled V10 activation intentionally fail this identity check and require a new session.

## Session Semantics

- One interactive TUI run should reuse one active session until the user starts
  or resumes another session.
- JSONL records are append-only.
- Image bytes live in the ignored content-addressed
  `.vesicle/attachments/` store. Session JSONL persists attachment ids,
  hashes, MIME types, sizes, and relative storage/source paths, never base64
  image payloads.
- Conversational records carry stable `uuid` and `parentUuid` links. Rewind
  moves the in-memory head and lets the next persisted record create a new
  branch; it must not truncate or rewrite JSONL. Legacy linear records are
  projected as an implicit parent chain when read.
- A real user prompt owns the file checkpoint for the work it initiates.
  Mutation tools must capture every affected writable path before changing it;
  checkpoint metadata remains host-only and must not enter provider messages.
- Checkpoints preserve absent paths, files, and directory topology. Directory-tree moves must capture the source tree and target path so rewind can restore empty directories as well as file content.
- Provider requests must include prior user/assistant turns when continuing a
  session.
- Response usage metadata is host-only. It may be persisted on assistant
  records and restored for TUI footer display, but must not be forwarded back
  to providers as part of resumed `VesicleMessage` request history.
- Tool calls and tool results should be persisted for replay/debugging.
- Successful filesystem tool results should persist structured `fileEvent`
  metadata on the session tool record. Callers may use this for artifact
  audit/ledger views without parsing natural-language tool result text.
  In `fileEvent`, `bytes` means the resulting or observed file size, and for
  `delete_file` it means the deleted file size. Successful create/write/replace/append results also include the SHA-256 of the complete resulting file. `append_file` may also report
  `deltaBytes`; `list_files` and `list_directory` report `entryCount`; `grep_files` reports
  `matches`.
- User-selected reasoning tiers should be persisted as session metadata so
  interactive resume restores runtime generation behavior. Provider
  thinking state is preserved as thinking blocks for protocol continuity and
  TUI display, but it is metadata and must not be merged into normal assistant
  prose. OpenAI-compatible `reasoning_content` is a compatibility bridge into
  that block structure.
- User-selected engine profiles should be persisted as session metadata so
  interactive resume restores which Prism workflow profile future turns and
  gate resolution should use.
- Engine handoff packets are user-role provider context with host metadata
  `kind: engine-handoff`. Resume should pass them back to providers as normal
  user messages for protocol compatibility, but the TUI should render them as
  host/system notices, and rewind/user-turn accounting must not treat them as
  authored prompts.
- Compact summaries are also user-role provider context with host metadata
  `kind: compact-summary`. `/compact` should create a new append-only branch
  after the retained system root instead of deleting old records. Resume should
  pass summaries back to providers, while the TUI renders them as host/system
  notices and rewind/user-turn accounting skips them as authored prompts.
- Session lists should mark unresolved gates and interrupted or exhausted quality decisions so the user can distinguish a normal transcript from a workflow waiting for confirmation or quality recovery.
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
- Artifact previews belong in the message stream as bounded, structure-
  preserving cards. The sidebar is an index, not a second preview surface.
- Markdown extension and LaTeX cleanup is a TUI display concern. Keep
  terminal-readable formula conversion and static formatting fallbacks outside
  fenced code blocks, and do not mutate session records, provider messages, or
  artifact files for rendering-only cleanup. Prefer readable static fallbacks
  for terminal-hostile constructs such as images and disclosure widgets instead
  of pretending they are interactive.
- Avoid shape-near command pairs such as singular/plural twins. Prefer one
  canonical command that inspects or lists without arguments and acts when an
  argument is present: `/artifact [n|path]` and `/engine [id]` follow this
  contract.
- Use `/effort` for provider generation effort and `/reasoning` for reasoning
  visibility. Do not give `/engine` a `workflow` alias; that command name is
  reserved for a future host-owned workflow surface.
- `/rewind` and empty-input double Esc must open the same selector. The picker
  defaults to a virtual `(current)` row, selects only authored user prompts,
  and restores to immediately before the chosen prompt. Keep `/checkpoint` as
  the Claude Code compatibility alias; do not introduce additional rewind
  synonyms.
- `/compact [notes]` is the standalone active-session compaction command. It
  may call the provider, but it must not expose tools to the summarization
  request. Keep optional custom instructions as plain text appended to the
  compaction prompt.
- `/btw <question>` is a one-shot, tool-free side question over the current
  conversation. It is `immediate` because it copies the immutable
  `SideQuestionContextSnapshot` published before each main provider request
  (never a half-written tool round) and sends one no-tools request through a
  side-specific AbortController independent of the main turn. The request has
  exactly one system authority — the dedicated `assets/prompts/shared/side-question.md`
  — and one user message: a host-rendered reference packet that quotes the
  parent Engine prompt, the conversation, and tool results verbatim as inert
  reference data (`src/core/side-question/reference.ts`). Parent workflow
  intent, tool protocol (`toolCalls`/`toolCallId`/tool-role messages),
  reasoning, and thinking blocks never become active side instructions or
  provider protocol fields; inherited images stay reference-only in the
  snapshot and materialize on the single user packet for vision models. No
  tools are declared, and any structured tool call in the response (including
  mixed text-plus-tool) fails the exchange. Side exchanges are in-memory only:
  they must never enter session JSONL, the main `conversation()` value, the
  visible transcript, checkpoints, validators, gates, permissions, or tool
  execution, and must not cancel or fail the main Agent Loop. The side overlay
  is visual priority only — a gate, permission, or question the main loop
  raises while it is open stays pending and appears on dismissal. Bare `/btw`
  reopens the latest in-memory exchange for the current session; with no prior
  exchange it returns to the composer with a usage hint.
- Escape uses an 800ms double-press window: empty input opens rewind, non-empty
  input saves and clears the draft, and an in-flight request is aborted. Active
  modal panels consume Escape before the prompt-level handler.
- Provider/model switching commands and artifact workbench commands are local
  host actions. They should add concise host notices to the transcript and must
  not call the provider.
- Opening rewind and restoring checkpoints are host actions. Only `/compact`
  and the explicit `Summarize from here` restore option call the active
  provider.
- Slash commands with fixed argument enums should expose those values through
  the shared argument-completion popup instead of requiring memorized input.
  Keep completion values sourced from the runtime enum where one exists, and
  preserve parser aliases while completing to canonical values.
- See [`COMMAND_COMPLETION.md`](./COMMAND_COMPLETION.md) for the command-owned
  registration contract, dynamic candidate rules, and required regression
  coverage for slash-command argument completion.
- Main prompt editing should go through Vesicle's host-owned composer layer,
  not directly through OpenTUI's single-line `<input>`. Keep the core keyboard
  semantics aligned with Claude Code's prompt input model: ordinary editing
  keys never interrupt a running turn, `Ctrl+Enter` inserts a newline,
  `Shift+Enter` is inert when reported distinctly, plain Enter submits, and
  Up/Down first move within soft-wrapped or explicit multiline drafts before
  falling back to history. The render layer should own visual wrapping,
  cursor-following viewport selection, and adaptive composer height; the
  keyboard state machine should stay focused on text mutation and submit/
  history actions. Trailing backslash+Enter remains a compatibility newline
  fallback for terminals that cannot distinguish modified Enter keys.
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

```bash
bun run typecheck
bun test
```

Add focused tests for:

- config and prompt loading
- session history reuse
- provider tool-call normalization
- tool execution and path guards
- TUI smoke rendering

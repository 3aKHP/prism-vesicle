<!-- Generated from docs/dev/PERSISTENT_INSTRUCTIONS.md — do not edit. -->

# Persistent Instructions Runtime Contract

Persistent Instructions are user-authored Markdown that customizes an Engine workflow across sessions. They are live model context, not automatic memory, capability authority, or durable session identity.

## Targets And Resolution

- File names are `VESICLE.md` for a general target and `VESICLE.<engine>.md` for an Engine-specific target.
- Project scope lives at the launch project root. User scope lives in the user configuration directory beside `providers.yaml`.
- Targets are selected from a fixed `{ scope, engine }` domain and never from an arbitrary path supplied by the model.
- Within one scope, an existing Engine-specific target fully replaces the general target. File existence controls replacement, so an empty Engine file is an intentional empty override.
- An invalid Engine-specific file suppresses general fallback for that scope rather than silently changing the selected target.
- Across scopes, selected user content is followed by selected project content. Project content has higher precedence on a direct instruction conflict.
- Neither scope can override the Engine contract, Harness identity, tool surface, permission mode, path roots, gates, validators, provider configuration, or host runtime.

## Prompt Composition

- Instructions are appended after the byte-identical Engine prompt as ordered host context, never as a second system authority.
- A fixed host preamble identifies each block's scope, target, precedence, and capability boundary without altering user-authored content.
- The Engine prompt remains the stable provider-prefix boundary. Stage character context follows Persistent Instructions.
- Every system-prompt construction site uses one composition primitive. Continuations, provider rounds, side-question projection, and child forks inherit the already composed prompt rather than independently rebuilding it.
- Vesicle does not auto-load coding-agent aliases such as `AGENTS.md` or `CLAUDE.md`, inject a coding-agent identity, or name those aliases in Engine prompts.
- User-authored instruction bytes are preserved apart from stripping one leading BOM.

## Freshness And Session Interaction

- The host resolves current instruction files when a top-level turn begins, after process restart on resume, and after a confirmed Engine switch.
- One turn freezes its resolved instruction snapshot. Permission, gate, question, and quality continuations reuse that snapshot so a paused tool call cannot resume under externally changed instructions.
- A new top-level turn resolves current disk state again. Persistent Instructions therefore remain live configuration rather than session identity.
- Restart loses the in-process snapshot, so a resumed continuation resolves current disk state and must not pretend to preserve an unavailable prior snapshot.
- A successful `update_instructions` call is the explicit mid-turn exception: it refreshes the frozen snapshot so the next provider round observes the requested change.
- Instruction changes do not alter the Harness asset fingerprint.

## Validation And Privacy

- Decode UTF-8 with fatal error handling, require a regular file, strip one leading BOM, and bound the combined selected content to 32 KiB.
- Reject a project instruction target that is a symbolic link and skip linked user-scope targets.
- Validation is fail-soft per scope. Invalid, linked, unreadable, or oversized content is skipped with a diagnostic while valid scopes continue; content is never truncated.
- Diagnostics and session audit may include target identity, byte count, and content hash, but never instruction contents or absolute host paths.
- Instruction resolution is independent from the guarded artifact path policy and runtime asset resolver.

## Model-Visible Tools

- `read_instructions` observes fixed instruction targets. `update_instructions` creates, replaces, or deletes a fixed target and is classified as a mutate operation by Tool Permission Runtime.
- Stage does not expose instruction-management tools because its consumer role is deliberately tool-less.
- `update_instructions` writes atomically, supports optimistic concurrency through `ifMatchSha256`, and rejects changes that exceed the combined Engine budget.
- Each successful mutation keeps one recoverable previous-state backup in the owning scope and reports its location and manual recovery meaning in the tool result.
- Instruction writes are outside guarded file checkpoints. Rewind may remove their conversation records but never restores the target file automatically.
- These tools exist for explicit user-requested workflow management, not autonomous self-modification.

## Direct Host Initialization

- `/init` drafts the general project target as a direct host action.
- It refuses an existing `VESICLE.md` before any provider request unless the user supplies `--force`.
- Forced replacement backs up the existing target. A non-forced write also fails if the target appears while generation is in flight.

User-facing setup and recovery instructions live in the mirrored Persistent Instructions tutorial and configuration reference under [`docs/user/`](../user/).

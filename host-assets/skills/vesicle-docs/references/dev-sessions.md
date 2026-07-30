<!-- Generated from docs/dev/SESSIONS.md — do not edit. -->

# Session And Context Runtime Contract

This document defines durable conversation history, provider projection, file checkpoints, rewind, context compaction, and interrupted-turn recovery.

## Session Identity And Persistence

- One interactive TUI run keeps one active session until the user starts or resumes another session.
- Session JSONL is append-only. Rewind, compaction, recovery, and branching append records and never truncate or rewrite prior records.
- Conversational records carry stable `uuid` and `parentUuid` links. Legacy linear records project as an implicit parent chain.
- Provider and Engine selection, usage metadata, validation, gates, questions, permissions, quality decisions, tool calls, and tool results persist when required for replay or recovery.
- The initial session system record stores SHA-256 hashes, logical asset paths, safe layer ids for the effective merged tree, and the exact bundled or managed Pack, manifest, source, and Adapter identity. It never stores prompt text, image bytes, secrets, or absolute paths.
- Resume and continuation reverify the active Harness identity against that initial record and block continuation on mismatch rather than silently switching runtime contracts; see [`ASSETS.md`](./ASSETS.md).
- Host-only metadata may support replay and rendering but must not be forwarded to providers unless its record kind explicitly defines provider-visible context.
- Malformed tool arguments persist only as a replay-safe `{}` in provider-visible tool-call metadata. A separate host-only diagnostic may retain the call id/name, failure class, UTF-8 length, SHA-256, and a bounded prefix; the original unbounded malformed string is not replay authority.
- A completed assistant record may persist one validated, owner-qualified provider-state envelope. Session code treats its bounded JSON payload as opaque and never interprets provider wire semantics.
- Child-session ownership uses separate parent session and parent tool-call identity; `parentUuid` remains an intra-session branch edge. See [`SUBAGENTS.md`](./SUBAGENTS.md).

## Provider History Projection

- Continuing a session includes prior provider-visible user, assistant, tool-call, and tool-result content in protocol-valid order.
- Thinking and provider-native metadata remain separate from ordinary assistant prose while being preserved when a protocol requires replay.
- Usage metadata is host-only and must not be sent back as conversational content.
- Host packets such as Engine handoffs and compact summaries use explicit record kinds so the provider projection, transcript, rewind accounting, and empty-session UI can treat them consistently.
- Projection must fail with an actionable session error when it encounters an unknown durable replacement format that cannot be interpreted safely.
- Projection sanitizes malformed tool arguments in legacy assistant records to `{}` so an existing paired failure result remains protocol-replayable instead of trapping resume in a serialization loop.
- Provider-owned state is cloned across load and every provider-message conversion. Resume, rewind, and append-only branching therefore reproduce the envelope attached to the selected assistant ancestor without sharing mutable payload objects.
- An unknown required provider-state version or malformed envelope fails projection actionably. Legacy records with no provider state remain compatible and project unchanged.

## Attachments And File Checkpoints

- Image bytes live in the ignored content-addressed `.vesicle/attachments/` store. JSONL records ids, hashes, MIME types, sizes, and relative paths, never base64 payloads.
- A real user prompt owns the guarded-file checkpoint for the work it initiates.
- Mutation tools capture every affected writable path before changing it. Checkpoint metadata remains host-only.
- Checkpoints preserve absent paths, file contents, and directory topology. Directory-tree moves capture both the source tree and target path so empty directories can be restored.
- Rewind moves the in-memory head and restores guarded checkpoint state; the next persisted record creates a new append-only branch.
- Host configuration changes and shell mutations outside guarded file tools are not rewind-safe. Their tools must disclose the applicable backup or recovery contract.

## Failed Turns And Continuations

- A top-level user turn whose provider round fails before any assistant response keeps the authored prompt in the transcript and appends a host-only failure marker.
- Provider projection excludes the failed round's unmatched user tail so resume or resend cannot create invalid consecutive same-role messages.
- A completed compact checkpoint remains a valid replacement boundary even when a later provider round fails.
- A mid-loop failure after an assistant response retains the already valid alternation tail and is not rewritten as a failed top-level turn.
- After any main-turn exception, the TUI rebuilds its in-memory provider conversation from the durable session projection. Records already appended by a partial tool round therefore remain in the next request instead of being hidden by a stale pre-turn snapshot.
- Continuation state must be persisted before another provider request so cancellation, provider failure, or restart cannot silently lose or replay a gate, question, permission, Agent delivery, or quality decision.

## Compact Checkpoints

- Manual and automatic compaction install one atomic `compact-checkpoint-v1` system record at the active head. The original transcript remains intact for display, rewind, and audit.
- A portable compact checkpoint contains a summary of the evicted prefix, a verbatim retained recent tail, and the active frontier when compaction occurs mid-turn.
- Verbatim retained assistant messages may carry their validated provider-state envelopes through a portable checkpoint. Generated summaries never fabricate, merge, or reinterpret provider-native state.
- Provider-visible history resets at the newest valid checkpoint and replays its suffix. The selected-pivot rewind summary keeps its separate branch behavior.
- Records use stable logical-turn and provider-round identity so compaction evicts only complete units and never separates a tool call from its result. Legacy records without those ids are grouped conservatively.
- The exact replacement request must reduce the projected request and fit the hard input ceiling before the checkpoint is appended.
- A compact provider request is standalone, exposes no tools, and cannot recursively compact itself. At most one compact operation runs at one boundary.
- Cancellation is distinct from failure. A soft-trigger failure leaves the old head and continues; a hard-ceiling failure or insufficient reduction blocks the pending provider request without installing an ineffective checkpoint.

## Automatic Compaction

- Automatic compaction is opt-in and provider-neutral. It activates only from a valid model limit configuration; there is no hidden threshold.
- The soft trigger is `floor(min(contextWindow * threshold, contextWindow - reserve))`; the hard input ceiling is `contextWindow - reserve`.
- Reserve precedence is configured `reserveOutputTokens`, then effective turn `maxTokens`, then `limits.maxOutputTokens`, then zero. Configuration must reject a statically known reserve that leaves no positive input budget.
- The primary estimate starts from the latest provider-confirmed context input paired with the host estimate of that same request, then adds host-estimated growth.
- The fallback estimate includes the system prompt, messages, tool envelopes, and the active tool schema. Excluded or approximate material must be labeled rather than reported as provider-confirmed protection.
- Pre-turn compaction runs before a new user record persists. Mid-turn checks run only at complete, recoverable boundaries before the next provider request.
- Unresolved interactions defer compaction, but their resumed provider request still passes the exact send guard.
- `/context` reports configured capacity, the latest provider usage or its absence, activation status, effective soft and hard limits, reserve source, strategy, and degraded or deferred state.

## Activity And Streaming

- Long-running turns emit host-visible activity around provider requests, tool calls, interaction pauses, compaction, quality handling, and validation.
- Provider streaming may expose assistant deltas while still reconstructing one final normalized response for persistence and replay.
- Streamed tool candidates are provisional. A disconnect, cancellation, retry, or adapter failure before the terminal provider commit leaves no assistant record, provider state, tool result, or tool side effect from that attempt.
- Observability does not change provider, process, tool, or session semantics.

Persistent Instructions are deliberately outside session identity; their separate resolution and mutation contract lives in [`PERSISTENT_INSTRUCTIONS.md`](./PERSISTENT_INSTRUCTIONS.md).

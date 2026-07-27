# TUI Runtime Contract

This document defines terminal layout, input ownership, transcript presentation, local commands, and tool-free side questions. Domain state remains owned by core runtime modules; the TUI renders and resolves it.

## Layout And Ownership

- Keep the surface dense, operational, and readable at 80 columns.
- Hide secondary panes before squeezing the message stream below a useful width.
- Gate, permission, question, and picker panels own the bottom area while active. Side panes may be hidden so the active controls remain legible.
- Artifact previews appear as bounded structure-preserving cards in the message stream. The sidebar is an index rather than a duplicate preview surface.
- Avoid changing stable layout dimensions from dynamic labels or transient content when a bounded region can scroll, clip, or reserve space.
- Modal input routing has priority over prompt editing, command completion, history scrolling, and global key handling.

## Rendering

- Markdown extension and LaTeX cleanup are display-only transformations. They must not mutate session records, provider messages, or artifact files.
- Rendering cleanup must stay outside fenced code blocks and use readable static fallbacks for terminal-hostile constructs.
- Thinking content renders separately from assistant prose, before the assistant body, with bounded or collapsible presentation.
- Tool, Agent, validation, quality, and host-action records render from structured state rather than parsing natural-language result text.
- Theme changes refresh mounted renderables whose colors are not reactively inherited from the root palette.

## Prompt Editing And Keys

- Main prompt editing goes through the host-owned composer rather than OpenTUI's single-line input component.
- Ordinary editing keys never interrupt an active turn. Plain Enter submits, `Ctrl+Enter` inserts a newline, and distinctly reported `Shift+Enter` remains inert.
- Up and Down move within soft-wrapped or explicit multiline drafts before falling back to prompt history.
- The render layer owns visual wrapping, cursor-following viewport selection, and adaptive composer height; the keyboard state machine owns text mutation, submission, and history actions.
- Trailing backslash plus Enter remains a compatibility newline fallback for terminals that cannot distinguish modified Enter.
- Escape dispatches to the active modal first. At prompt level, the bounded double-press behavior distinguishes rewind, draft clearing, and request cancellation.
- `Ctrl+C` copies an active OpenTUI selection. Without a selection, the first press arms exit and the second exits through `renderer.destroy()`.

## Commands And Host Actions

- Avoid shape-near singular and plural command pairs. Prefer one canonical command that lists without arguments and acts when given a target.
- Provider/model switching, ordinary Engine switching, artifact inspection, and rewind opening are local host actions and do not call the provider.
- `/compact` and the explicit summarize-from-here rewind action may call the provider through their dedicated no-tools summarization contract.
- Fixed-enum command arguments use the shared completion popup and source candidates from the runtime enum when available. See [`COMMAND_COMPLETION.md`](./COMMAND_COMPLETION.md).
- Command scheduling follows the registration and boundary rules in [`COMMAND_QUEUE.md`](./COMMAND_QUEUE.md).
- Host actions add concise structured notices without masquerading as authored user or assistant messages.

## Rewind And Compaction UI

- `/rewind` and empty-input double Escape open the same selector.
- The rewind picker defaults to a virtual current row, selects authored user prompts, and restores to immediately before the chosen prompt.
- Host-generated handoffs, compact summaries, Agent delivery packets, and other provider-context records do not count as authored prompts.
- `/checkpoint` remains the compatibility alias for rewind; additional synonyms require an explicit command-design decision.
- `/compact [notes]` appends optional user instructions as plain text to the dedicated summarization request and exposes no tools.
- Compacted transcripts retain a host display record so the empty-session presentation cannot reappear over existing history.

## Side Questions

- `/btw <question>` is a one-shot, tool-free side exchange over an immutable snapshot published before a main provider request.
- The side request has one dedicated system authority and one host-rendered user reference packet containing quoted parent context as inert data.
- Parent workflow instructions, tool protocol fields, reasoning, and thinking blocks do not become active side instructions. Images remain reference-only and materialize only for a vision-capable side request.
- No tools are declared. Any structured tool call in the side response, including mixed text and tool output, fails the exchange.
- Side exchanges remain in memory and never enter session JSONL, the main conversation, transcript, checkpoints, validators, gates, permissions, or tool execution.
- A side exchange has an independent cancellation controller and cannot cancel or fail the main Agent Loop.
- The overlay has visual priority only. Main-loop interactions remain pending and appear after dismissal.
- Bare `/btw` reopens the latest in-memory exchange for the active session; without one it returns to the composer with a usage hint.

## Verification Boundary

- Static rendering tests do not prove modal transitions, raw terminal key sequences, scrolling, or production preload behavior.
- Interaction changes should receive focused component or PTY coverage at the real boundary when the regression risk justifies it.
- The affected workflow must remain usable at 80 columns and at the relevant wide layout before the change is considered complete.

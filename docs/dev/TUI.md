# TUI Runtime Contract

This document defines terminal layout, input ownership, transcript presentation, local commands, and tool-free side questions. Domain state remains owned by core runtime modules; the TUI renders and resolves it.

## Layout And Ownership

- Keep the surface dense, operational, and readable at 80 columns.
- Hide secondary panes before squeezing the message stream below a useful width.
- Gate, permission, question, and picker panels own the bottom area while active. Side panes may be hidden so the active controls remain legible.
- Artifact previews appear as bounded structure-preserving cards in the message stream. The sidebar is an index rather than a duplicate preview surface.
- The persistent artifact sidebar is deliberately narrow, so its rows stay one line and middle truncation would make long paths indistinguishable. `Alt+A` (meta/option + `a`) enters artifact focus only when the Host sidebar is visible, the host is not busy, and at least one artifact is available. While focus is active, `Up`/`Down` move the focused artifact, `Enter` opens the existing `/artifact` preview path, and `Escape` or `Alt+A` returns focus to the composer. The selected relative path renders in an untruncated, display-width-aware strip above the workspace for that one focused item; rows themselves are not widened or multi-lined. Focus is transient presentation state — it clears when the sidebar hides and does not change artifact scanning, selection syntax, session records, or tool/runtime authority.
- Avoid changing stable layout dimensions from dynamic labels or transient content when a bounded region can scroll, clip, or reserve space.
- Modal input routing has priority over prompt editing, command completion, history scrolling, and global key handling.
- Chat-page `Ctrl+R` regenerates the latest completed turn as a new horizontal candidate; Workspace owns the same key for its existing file-reload action. `Ctrl+B` opens the candidate-tree panel from both pages: it sits at the same routing layer as the `Ctrl+O` page switch — after bottom-surface modals (an open panel keeps its keys) and above Workspace routing — and supersedes the composer's Emacs backward-char (bare `←` and `Meta+b` word movement remain). Cross-platform letter shortcuts must remain representable by traditional VT input: do not require Shift to distinguish a Ctrl+letter binding (traditional terminals collapse `Ctrl+Shift+R` to the same `0x12` as `Ctrl+R`), and do not make an Alt/Option+letter binding the sole trigger because host overlays and terminal Meta configuration can intercept or reinterpret it. Shortcut regression tests parse real terminal sequences through OpenTUI before dispatch instead of constructing idealized modifier objects.

## Visual And Motion Maintenance

- Essential information and actions must never depend on an animation or effect completing; every animated state has an immediate non-animated fallback and `VESICLE_REDUCED_MOTION=1` freezes it to a static frame.
- Continuous animation is confined to brand signature moments; the working area below the composer stays static so reading and editing never fight a moving surface.
- Centralize palette, motion duration, easing, effect intensity, and terminal-capability degradation in the owning theme or host-surface controller instead of scattering animation constants through views.
- Static rendering and component tests do not reproduce every OpenTUI effect, keyboard, mouse, streaming, or native-renderer path; visual changes that touch the renderer or worker boundary should be smoked in a live terminal, including native Windows where relevant.

The brand aesthetic, palette of record, motion grammar, and anti-patterns are owned by [`brand/VISUAL_LANGUAGE.md`](../../brand/VISUAL_LANGUAGE.md). The TUI carries three signature surfaces under that language: a startup splash (ANSI mark, wordmark, one slow traveling light; degrades animated → static → frozen → skipped and never blocks startup), an empty-session hero that the first turn replaces, and the static motif wiring — a 1-cell per-message role spectrum lane, the active engine refraction accent on the header and turn markers, and a restrained `┌─ Title ─` ASCII-frame label on the sidebar's internal sections. Easing is `linear`/`steps` only.

## Rendering

- Markdown extension and LaTeX cleanup are display-only transformations. They must not mutate session records, provider messages, or artifact files.
- Rendering cleanup must stay outside fenced code blocks and use readable static fallbacks for terminal-hostile constructs.
- Thinking content renders separately from assistant prose, before the assistant body, with bounded or collapsible presentation.
- Tool, Agent, validation, quality, and host-action records render from structured state rather than parsing natural-language result text.
- Theme changes refresh mounted renderables whose colors are not reactively inherited from the root palette.
- The theme palette owns a complete text-selection foreground/background pair and the Workspace editor cursor color. Selectable production text uses `ThemedText`; native editor and rich-text adapters must apply the same pair explicitly and refresh mounted renderables on a theme change. Decorative renderables that should not participate in copy selection declare `selectable={false}`.
- The TUI runs on the self-maintained OpenTUI fork: `@3akhp/opentui-core@0.5.3-zv6` plus `@3akhp/opentui-solid@0.5.3-zv6` (upstream base v0.5.3 carrying the Vesicle patch queue: the worker-side backslash-escape fix, Markdown/TextTable selection colors propagated to prose, list markers, and fenced code, and the two native editor repairs for Issues #89/#99; provenance and native-artifact hashes live in the fork's GitHub Release `v0.5.3-zv6`). Markdown backslash escapes (`\~`, `\*`, …) therefore render as the escaped character natively in the fork's parser worker — the interim host-side transform and the 0.4.3 selection patch are gone. darwin-x64/arm64 resolve upstream `@opentui/core-darwin-*@0.5.3` natives through the fork's optional dependencies (byte-identical base: macOS gets the JavaScript fixes but not the two native editor repairs — disclosed in the fork release notes, not a platform narrowing). The parser worker resolves through the fork's `./parser.worker` export, and native library selection is entirely the fork loader's job — dynamic platform-package import, `OTUI_ASSET_ROOT` relocation, and bunfs-embedded libraries in compiled binaries; the host adds no pin and no fork/upstream selection logic. `vesicle debug markdown-runtime` forces the native load through that loader (ok means the library really dlopen'ed); where the fork's installed-package asset table resolves (the source channel) it reports the native entry with `source: "asset-table"` — a table that resolves without a native entry fails the probe as a fork shape change — while npm-bundle installs and compiled binaries carry an inlined or embedded copy of the runtime whose asset table cannot resolve the installed layout and report `source: "forced-load"` with no path rather than inventing one. The diagnostic also performs real native Markdown drag selection; package/binary/installer smoke runs it at each distribution boundary, its `escape` field asserts the fork worker's concealed tuples, and `tests/component/tui/markdown-escape.test.tsx` asserts the rendered frame.

## Prompt Editing And Keys

- Main prompt editing goes through the host-owned composer rather than OpenTUI's single-line input component.
- Ordinary editing keys never interrupt an active turn. Plain Enter submits, `Ctrl+Enter` inserts a newline, and distinctly reported `Shift+Enter` remains inert.
- Up and Down move within soft-wrapped or explicit multiline drafts before falling back to prompt history.
- The render layer owns visual wrapping, cursor-following viewport selection, and adaptive composer height; the keyboard state machine owns text mutation, submission, and history actions.
- Trailing backslash plus Enter remains a compatibility newline fallback for terminals that cannot distinguish modified Enter.
- Escape dispatches to the active modal first; an owning modal, picker, or overlay consumes it and the parent turn is not aborted. At prompt level, the bounded double-press behavior distinguishes rewind, draft clearing, and request cancellation. A busy prompt-level Esc aborts the active provider or tool operation and preserves any composer draft, cursor, elements, and image attachments. When the FIFO has a head, the composer advertises `Esc interrupt & send next` and that exact head is dispatched once as a fresh top-level input after the interrupted durable session projection is rebuilt; an empty busy queue advertises `Esc interrupt` and nothing is auto-enqueued or auto-submitted.
- `Ctrl+C` copies an active OpenTUI selection. Without a selection, the first press arms exit and the second exits through `renderer.destroy()`.
- Global paste handlers must leave an unobscured editable native control unconsumed so OpenTUI delivers the bracketed paste to the focused textarea, and must block non-composer Workspace surfaces (tree, read-only viewer, missing focus data) so their paste never falls into the shared composer. Global overlays, Workspace-local panels, input bars, dialogs, and bottom-surface ownership still outrank Workspace editor delivery.

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

## Candidate Tree And Turn-Focus Cursor

- `/branch` and `Ctrl+B` open the candidate-tree panel, a bottom-surface modal in the `/rewind` pattern: it owns the bottom area and its keys while active, refuses to open while busy, and pauses queued-work draining.
- The panel renders every fork at every depth of the session tree, including branches inside inactive candidates; the active path is expanded by default and the deepest active candidate is selected. Fork rows are authored-turn prompts (or the fork record for `/rewind` forks); candidate rows carry excerpts, continuation counts, and file-state hints.
- Navigation is read-only until confirm: `↑/↓` move, `←/→` fold/unfold, `Enter` on a candidate opens the confirm step (file-diff preview, taint/missing-bundle warnings), `r` on a fork opens a regenerate confirm. No disk write happens before the confirm step is accepted; switching executes through the shared candidate-switch kernel (files before marker, busy/SubAgent guards).
- `Alt+↑/↓` moves a transcript-wide turn-focus cursor (every engine): stops at each authored turn's prompt and final reply, wraps at the edges, highlights both in the brand color, and keeps Stage's `Ctrl+Alt+S`/mouse toggle targeting the focused turn's eligible Stage message. With the cursor set, `Ctrl+R` regenerates the focused turn instead of the last turn. Display ids key on durable record uuids (the projector stamps `recordUuid` onto user/assistant messages), so anchors survive candidate switches; streaming messages without records are not anchors yet.
- `Alt+←/→` cycles candidates when the inline switcher is armed; otherwise it is never swallowed silently — the status line guides toward `Ctrl+B` (focused turn has candidates) or `Ctrl+R` (otherwise), on the Chat page, Workspace page, and hero alike.

## Side Questions

- `/btw <question>` is a one-shot, tool-free side exchange over an immutable snapshot published before a main provider request. It never inherits provider-native built-in search from the parent session.

- `/title` shows the durable session title and source; `/title rename <text>` sets a permanent user title; `/title regenerate` resets automatic generation. The Session Picker renders a title as its primary line and the first-user preview as supporting text.

- The TUI projects host state to the terminal tab through the OpenTUI renderer's `setTerminalTitle()` boundary. The one-column status slot is `·` for idle, a same-width `◇`/`◈`/`◆`/`◈` diamond pulse for working, and `!` when a gate, permission, question, or other user decision is pending; working advances every 800ms and freezes at `◇` under `VESICLE_REDUCED_MOTION=1`. A durable session title is displayed directly without a product prefix; untitled sessions fall back to `Prism Vesicle · <safe project basename>` and then the engine id. `VESICLE_TERMINAL_TITLE=auto|on|off` controls TTY admission, while `VESICLE_DISABLE_TERMINAL_TITLE=1` is a hard no-write override. Setup uses the fixed `Prism Vesicle Setup` title. Renderer shutdown, suspend/resume, and external-editor return clear or force-reproject through the same host-only controller; non-interactive output never contains title control sequences. If a Windows Terminal profile sets `suppressApplicationTitle`, the terminal may hide application-provided titles. Automated title-consumer evidence currently covers the Linux/WSL source TUI PTY; npm, standalone-binary, and native Windows Terminal title acceptance remain release follow-ups.
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

## Structured Summaries And One-Line Status

- A structured state summary (validation, quality, gate, or any reusable status string) must stay **action-free**: it states a semantic outcome only (`✓ passed`, `✗ N · ⚠ M`, `validation stale`, `no validator matched`, …) and never embeds an input instruction (`v`, `view`, `Enter`, …). The component that owns the current focus decides which single action, if any, is reachable, so one key is never advertised twice and a summary never tells the user to open a panel that is already open.
- A reusable status value must carry the identity of what it describes (e.g. the project-relative path a validation result belongs to). A surface may show it only when that identity matches the object its focus represents; a tree selection must never wear another file's verdict.
- A dirty editor buffer projects its prior validator verdict as a neutral `validation stale` (no old pass/fail colour or counts); undo-back-to-clean, save, and reload restore or replace it. Validators are not run on every keystroke.
- One-line action/status surfaces (the Workspace status row, input bars, confirmation dialogs) compose by **display-width priority**, not tail clipping: drop whole low-priority segments before middle-truncating a path, keep destructive/committing choices and the cursor visible, and guarantee the rendered width never exceeds the supplied content budget. A long or CJK path must not push a warning or a primary action off the row at 80 columns.

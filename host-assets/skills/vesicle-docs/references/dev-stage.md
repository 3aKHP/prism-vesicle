<!-- Generated from docs/dev/STAGE.md — do not edit. -->

# Stage Engine

Stage is Prism's consumer-side collaborative-fiction engine. The host bootstraps it from a character card (Module A) and a scenario card (Module B), then runs a third-person continuous narrative session in which each user message is a character action. This document owns the Stage developer contract: bootstrap input authority, the three-part turn packet, the prose-first presentation layer, provider/session preservation, and the verification boundary. The user-facing surface lives in the [`stage`](../../docs/user/en/advanced/stage.md) user-manual page; current capability state in [`STATUS.md`](../../STATUS.md).

## Bootstrap And Input Authority

`/stage <character-card-path> <scenario-card-path>` starts a Stage session. Both cards must be files under a guarded project content root (typically `workspace/`, where ETL writes them). Stage input roots are the `projectContentRoots` from `core/project/roots.ts`: `source_materials/` plus the four final artifact roots. The scratch root `tmp/` is explicitly excluded from card completion, bootstrap path resolution, and source-drift checks; a scratch path is rejected by the guarded root policy before any provider or session work. Bootstrap:

1. freezes the raw text of both cards (recording SHA-256) and renders the frozen context from the character card's raw text plus the scenario's visible opening and its hidden HTML-comment logic layer;
2. persists that system record plus an opening assistant message containing visible opening prose and dialogue and an HTML-comment logic layer, then waits for the first action input; and
3. emits at most three bounded compatibility warnings for harmless card variation (for example empty input, missing YAML frontmatter, a scenario with no optional logic comment, or an unclosed HTML comment). These inform; they do not block.

Hard startup failures are limited to unavailable or unreadable input, unsafe paths, an inability to persist the session, unavailable verified Harness state, or an impossible Engine/profile contract. Source drift in the cards after bootstrap does not reinterpret a running Stage session: on resume the host detects whether a source hash changed but keeps using the frozen context, preserving continuity.

## Engine Profile

The Stage Engine profile forces `defaultTools: []` and `stopGates: []`. The model has no model-visible tools, no MCP, no Agents, no shell, and no confirmation gates — it is a gate-free continuous flow, unlike ETL which pauses at blueprint and phase gates. The only validation is `runtime-packet`.

## Three-Part Turn Packet

Every Stage model response is validated as a `runtime-packet` (the same validator Runtime uses) with three ordered parts:

1. Part 1 — an HTML comment containing `[!Neural Chain]`.
2. Part 2 — the Dynamic HUD beginning with `【Status】`.
3. Part 3 — prose content.

The bootstrap's opening logic layer has the same visibility rules as Neural Chain: retained in the raw message, supplied to the model on later turns, and hidden from the default player reading surface.

## Prose-First Presentation

The consumer presentation preserves the packet for model history and durable sessions while giving players a prose-first reading experience. The host must not silently discard or flatten those parts.

- Prose is the primary, normally visible reading surface.
- Neural Chain and the opening message's logic layer are hidden by default but remain deliberately inspectable. Clicking a Stage assistant message toggles that one message between its normal player view and its complete source view; clicking again restores the normal view. This is a direct per-message reading action, not a command, picker, modal, or separate inspection workflow. `Ctrl+Alt+S` focuses the same per-message view state for keyboard access.
- The source view displays the complete original message, including every `<!--`, comment body, and `-->`, whether the comment occurs at the start, middle, or end and whether the message has more than one.
- HUD is not rendered as a full production-audit block; it is a compact, low-salience status indicator whose details stay inspectable without competing with prose.
- Quality observe findings stay separate from both HUD and Neural Chain. They must not become a rewrite panel or interrupt the player.

## Comment Visibility Layer

The implementation is a reusable message-rendering layer, not a Neural-Chain-specific widget. It has two display modes for a message: `normal` renders the visible Markdown segments in source order while concealing complete eligible HTML-comment segments, and `source` renders the original message in full including comment delimiters and contents. Segment identity is retained across the two modes so the stream preserves its reading position while a comment changes height.

This is a parsing and presentation abstraction, not a global content policy. Other conversations keep their current Markdown behavior unless an explicit caller opts into comment concealment. In particular: comments inside fenced or inline code remain literal code, not concealed content; an unclosed `<!--` remains visible unchanged rather than being silently swallowed or repaired; and the source view cannot rely on a Markdown renderer's native HTML treatment (which may suppress comments), so comment segments are explicitly rendered as their literal source text in that mode. Pointer selection takes precedence over toggling: a drag that forms a text selection retains normal selection/copy behavior, while an unselected click toggles the view.

Expanding a source view legitimately increases the message height and moves later messages. The renderer does not manually offset every following message; it lets the stream's ordinary vertical flow reflow and preserves the reader's viewport through one scroll-anchoring transaction owned by the message stream: before changing a view it records whether the scrollbox is following its bottom edge; when following, it scrolls to the new `scrollHeight` after layout; when reading history, it captures the first visible stable segment and its offset and restores that segment to the recorded offset after layout; and it applies the change immediately without height animation and never forces the scrollbox back to the bottom while the reader has scrolled away.

## Provider And Session Preservation

Raw assistant content — including HTML comments and the HUD — remains intact in provider history and session JSONL. Rendering visibility and expanded-message state are presentation-only: expanded state is not durable session data, and resumed sessions begin in the normal view. The implementation preserves exact raw packet content across streaming, session resume, rewind, and provider replay.

## Boundaries

Comment concealment applies only to Stage bootstrap content and validated Stage response packets. Do not infer that HTML comments may be globally hidden in all Vesicle conversations, and never expose model reasoning outside the explicit player-controlled inspection affordance.

## Verification

Stage presentation is covered by focused tests for Stage opening content and validated packets with comments at the start, middle, end, and in multiple locations; literal HTML-comment syntax in ordinary conversations, fenced code, inline code, and unclosed-comment input; complete source-view fidelity without mutating provider history or session JSONL; click-versus-text-selection behavior; and bottom-following and history-reading scroll positions while expanding and collapsing comments. Live terminal smoke remains part of the acceptance boundary because static rendering does not reproduce every streaming or native-renderer path.

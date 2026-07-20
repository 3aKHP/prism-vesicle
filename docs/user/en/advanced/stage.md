# Stage consumer engine

English | [简体中文](../../zh-CN/advanced/stage.md)

> **Status (as of `1.0.0-alpha.2`):** 🟢 Implemented. Maturity per [`STATUS.md`](../../../../STATUS.md).

Stage is Prism's **consumer-side** collaborative fiction engine: feed it a character card (Module A) and a scenario card (Module B) and it opens a third-person continuous narrative session — your messages are your character's actions, and it narrates the response.

## Open a Stage session

```
/stage <character-card-path> <scenario-card-path>
```

Both cards must be files under a guarded, readable project root (usually `workspace/`, where ETL writes cards). Stage will:

1. **Freeze** the raw text of both cards (recording SHA-256), and render a frozen context from the character card's raw text + the scenario's visible opening + its hidden logic (the HTML comment block inside the scenario).
2. Persist that system record + an opening assistant message, then wait for your first action input.
3. Emit bounded compatibility warnings (at most 3) for **harmless card variation** — for example missing YAML frontmatter, a scenario with no logic comment, or an unclosed HTML comment. These only inform; they do not block.

> Later drift in the source cards does not affect an in-flight session: on resume Stage detects whether the source file hash changed, but **keeps using the frozen context**, preserving continuity.

## Empty tool surface, no gates

The Stage engine profile forces `defaultTools: []` and `stopGates: []` — the model has **no** model-visible tools, no MCP, no Agents, no shell, and no confirmation gates. It is a **gate-free continuous flow**: each of your messages is your character's action input, and the model continues directly, unlike ETL which pauses at blueprint and phase gates.

The only validation is `runtime-packet` (the three-part turn packet).

## Three-part turn packet

Each Stage turn outputs three parts:

1. **Hidden Neural Chain** (`<!-- [!Neural Chain] … -->`): perception/instinct/state/strategy. Collapsed by default on the consumer side; click that message (or focus it with `Ctrl+Alt+S`) to inspect the raw content.
2. **Dynamic HUD** (`【Status】`/`[Space-Time]`/`[Physical]`/`[Psychology]`/`[Beat]`/`[Impression]`): shown as a low-key indicator.
3. **Prose**: the default-visible main narrative (200–800 Chinese characters, high density, at least two sensory modalities).

The consumer presentation is controlled by the host frontend (prose first, HUD compact, Neural Chain hidden by default); this presentation state **is not persisted**, while the raw three parts stay intact in provider history and session JSONL.

## Topological coherence

Stage initializes its state navigator from the scenario's beat map (not the character card YAML) and tracks the current beat, tension, variant config, and boundary proximity turn by turn. Behavior must stay consistent with the character card's Invariant Axes; Variants can only move along the Variant Axes; boundary conditions are absolute. If a beat stays for 3 turns without the pivot condition being met, a "tension nudge" applies — a small environmental or internal event pressing toward the pivot, without forcing it.

## When to use Stage

Stage is for **playing** cards, not **making** them. Make cards with ETL (see [First character card](../tutorials/first-character-card.md)); once made, use `/stage` to enter the narrative directly. To start a fresh session use `/new` (which switches back from Stage to ETL).

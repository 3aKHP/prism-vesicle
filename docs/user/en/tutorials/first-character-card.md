# First character card

English | [简体中文](../../zh-CN/tutorials/first-character-card.md)

In the previous tutorial you confirmed a character direction at the blueprint gate. This one walks the rest of ETL Workflow A and produces a Module A character card in `workspace/` that passes validation.

If you haven't reached the blueprint confirmation yet, do [First conversation](./first-conversation.md) first.

## How phases advance

ETL splits a character card into phases. Each phase writes part of the file, then stops at a **gate** for your review:

| Phase | What it writes into `workspace/{name}.md` | Gate after |
|---|---|---|
| Phase 1 — The Shell | YAML header (`name`/`archetype`/`age_gender`/`inventory`) + `## Visual Cortex` | Phase review gate |
| Phase 2 — Neuro-Structure | `## Biography`, `## Cognitive Stack`, `## Instinct Protocol` | Phase review gate |
| Phase 3 — Topology & Voice | `## Persona Topology`, `## Narrative Engine`, `## World Context` | Wrap-up; prints the file path |

Use a gate the same way as before: confirm to advance, reject and explain what to change.

## Let it keep writing

After the blueprint confirmation, pick **Confirm** at each phase gate, or type "continue". It will:

1. Create `workspace/<name>.md`, write the static fields and appearance first (Phase 1), then pause for review.
2. After you confirm, append biography, cognition, instinct (Phase 2), then pause again.
3. After you confirm again, append persona topology, narrative engine, world context (Phase 3), wrap up, and print the file path.

> The benefit of small confirmations: if a section is unsatisfactory, reject and explain; it redoes only that section, not the whole card.

## Look at the artifact

Files written to `workspace/` show up in the workspace sidebar. In the input box:

```
/artifact
```

lists artifacts (an `Artifacts:` list with numbers); `/artifact 1` (or a path) previews the first one in the conversation area.

## Validate: Module A

A character card follows structural rules (Module A): a YAML header, seven fixed sections, three subsections under Persona Topology, at least two Invariant Axes, at least three Variant Axes, and more. Validation is **advisory** — it reports problems but does not forcibly interrupt your workflow.

```
/validate 1
```

(or `/validate workspace/<name>.md`)

When it passes:

```text
Validation passed:
  ✓ character-card
```

When there are problems, it shows which rule failed:

```text
Validation found issues:
  ✗ character-card
      Module A: missing mandatory section ## Narrative Engine.
      Module A: Variant Axes must have at least three entries, found 2.
```

`✗` is an error, `⚠` is an advisory warning (non-blocking). Common errors: a missing section, fewer than two Invariant Axes, fewer than three Variant Axes, or an accidental L-System tag (output files must not contain tags like `L1`/`L3-A`). Tell Vesicle the requirement and let it fix the card against the validation result.

## What a card looks like

A finished `workspace/<name>.md` has roughly this structure (creative prose in Chinese, headings in English):

```text
---
name: 林越
archetype: The Quiet Witness
age_gender: 28, 男
inventory: 纸杯、钢笔、旧记者证
---

## Visual Cortex
…
## Biography
…
## Cognitive Stack
- Invariant: 永远亲自核实会影响他人安全的信息。
- Variant: 措辞——压力下从克制转向简短的祈使句。
## Instinct Protocol
…
## Persona Topology
### Invariant Axes
- Will always …
### Variant Axes
- Under increasing tension, … shifts from … toward …
### Boundary Conditions
- Hard limit: …
## Narrative Engine
…
## World Context
…
```

## Checklist

- [ ] There is a character card file under `workspace/`.
- [ ] `/artifact` lists it and `/validate` shows `Validation passed` (or warnings you accept).
- [ ] You used "reject + explain" at least once at a phase gate.

Next: build a [scenario card](./first-scenario-card.md) from this character.

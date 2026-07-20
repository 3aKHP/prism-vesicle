# First scenario card

English | [简体中文](../../zh-CN/tutorials/first-scenario-card.md)

With a character card in hand, you can design an opening scene for it. This tutorial runs ETL Workflow B and produces a Module B scenario card, then validates it.

Prerequisite: you have a validated [character card](./first-character-card.md) in `workspace/`.

## What a scenario card is

A scenario card (Module B) gives a character a concrete opening scene: an opening passage, plus a **beat map** — 3–5 beats, each stating the tension level to reach (`tension_target`, 0–100), the character's active behavioral config (`variant_config`), and the trigger that advances to the next beat (`pivot_condition`).

## Have ETL propose hooks

Tell it in the input box:

> Design an opening scene based on workspace/林越.md and give me a few directions.

ETL reads the character card, proposes **three story hooks**, each with a draft beat map, and runs a few self-checks (does the hook still hold with a different character; does it advance plot, reveal personality, and build credibility at once; does it need narration to explain itself). Then it pauses at a **gate** for you to pick a hook.

- Pick the hook you want — ETL generates the full scenario card to `workspace/<name>_scenario_<tag>.md`.
- Reject with a direction if none fit — it tries again.

## Validate: Module B

```
/validate workspace/林越_scenario_closing.md
```

The main Module B rules: 3–5 beats, all four fields per beat, `tension_target` an integer 0–100, the tension cannot only rise (at least one beat must descend or stall), no L-System tags, and no legacy fields like `l_system_level` or `Action Guide`. When it passes:

```text
Validation passed:
  ✓ scenario-card
```

Handle `✗` errors or `⚠` warnings the same way as a [character card](./first-character-card.md): feed the validation result back to Vesicle and let it fix the card.

## What a scenario card looks like

```text
---
scenario_name: 打烊时刻
tags: ["#邂逅", "#深夜"]
world_state: 深夜,林越的咖啡馆,只剩一位迟迟不离开的客人

beat_map:
  - label: Arrival
    tension_target: 15
    variant_config: suppression-active
    pivot_condition: 客人开口说出一个林越无法忽视的名字
  - label: Surface Crack
    tension_target: 35
    variant_config: defense-softening
    pivot_condition: 林越主动续杯并坐下
  - label: Recede
    tension_target: 25
    variant_config: guard-return
    pivot_condition: 客人结账离开,留下那张写有名字的纸杯
---

雨把整条街洗空了。林越数着第三遍杯沿的缺口,听见门推开的动静却没抬头——这个点还来的人,多半是不想回家。

"还营业吗。"
```

(The opening passage is written through the character's perceptual lens, flush left; the `<!-- … -->` comment block holds structural info for the engine: scene premise, neural state, user role.)

## Checklist

- [ ] There is a scenario card under `workspace/`, named like `<name>_scenario_<tag>.md`.
- [ ] `/validate` shows `Validation passed` for it (or warnings you accept).
- [ ] You picked or rejected at the hook gate.

You can now produce the core asset pair — character card + scenario card — on your own. Next, learn to manage sessions: [Sessions and rewind](./sessions-and-rewind.md).

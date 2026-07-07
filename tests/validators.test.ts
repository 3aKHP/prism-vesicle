import { describe, expect, test } from "bun:test";
import { validateCharacterCard, validateScenarioCard, validateM0Output } from "../src/core/validators";

describe("validateM0Output (legacy stub, kept for non-artifact turns)", () => {
  test("passes on non-empty content", () => {
    expect(validateM0Output("hello").ok).toBe(true);
  });
  test("fails on empty content", () => {
    expect(validateM0Output("").ok).toBe(false);
  });
});

describe("validateCharacterCard (Module A)", () => {
  test("accepts a well-formed character card", () => {
    const card = VALID_CHARACTER_CARD;
    const result = validateCharacterCard(card);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("rejects missing YAML frontmatter", () => {
    const result = validateCharacterCard("# just a body, no frontmatter");
    expect(result.errors.some((e) => e.includes("YAML frontmatter"))).toBe(true);
  });

  test("rejects a disallowed YAML field", () => {
    const card = VALID_CHARACTER_CARD.replace("inventory: none", "inventory: none\ntension: 50");
    const result = validateCharacterCard(card);
    expect(result.errors.some((e) => e.includes('"tension" is not allowed'))).toBe(true);
  });

  test("rejects a missing body section", () => {
    const card = VALID_CHARACTER_CARD.replace("## Biography\n诞生于人类集体之声的数字歌姬。\n", "");
    const result = validateCharacterCard(card);
    expect(result.errors.some((e) => e.includes("## Biography"))).toBe(true);
  });

  test("rejects too few Invariant Axes", () => {
    const card = VALID_CHARACTER_CARD.replace(
      /### Invariant Axes[\s\S]*?### Variant Axes/,
      "### Invariant Axes\n- Only one axis.\n\n### Variant Axes",
    );
    const result = validateCharacterCard(card);
    expect(result.errors.some((e) => e.includes("at least two"))).toBe(true);
  });

  test("rejects leaked L-System tag", () => {
    const card = VALID_CHARACTER_CARD + "\n\n(some note about L3-A territory)\n";
    const result = validateCharacterCard(card);
    expect(result.errors.some((e) => e.includes('"L3-A"'))).toBe(true);
  });

  test("warns when no positive shift direction exists", () => {
    const card = VALID_CHARACTER_CARD.replace(
      /### Variant Axes[\s\S]*?### Boundary Conditions/,
      "### Variant Axes\n- Under tension, suppression increases toward total lockdown.\n- Under tension, voice becomes clipped.\n- Under tension, trust evaporates entirely.\n\n### Boundary Conditions",
    );
    const result = validateCharacterCard(card);
    expect(result.warnings.some((w) => w.includes("positive"))).toBe(true);
  });
});

describe("validateScenarioCard (Module B)", () => {
  test("accepts a well-formed scenario card", () => {
    const result = validateScenarioCard(VALID_SCENARIO_CARD);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("rejects beat_map with too few beats", () => {
    const card = VALID_SCENARIO_CARD.replace(
      /beat_map:[\s\S]*?---/,
      "beat_map:\n  - label: A\n    tension_target: 20\n    variant_config: x\n    pivot_condition: y\n---",
    );
    const result = validateScenarioCard(card);
    expect(result.errors.some((e) => e.includes("3–5 beats"))).toBe(true);
  });

  test("rejects beat with out-of-range tension", () => {
    const card = VALID_SCENARIO_CARD.replace("tension_target: 70", "tension_target: 150");
    const result = validateScenarioCard(card);
    expect(result.errors.some((e) => e.includes("must be integer 0–100"))).toBe(true);
  });

  test("rejects legacy l_system_level field", () => {
    const card = VALID_SCENARIO_CARD.replace(
      "world_state: 深夜公寓",
      "world_state: 深夜公寓\nl_system_level: L3-A",
    );
    const result = validateScenarioCard(card);
    expect(result.errors.some((e) => e.includes("l_system_level"))).toBe(true);
  });

  test("warns on strictly monotonic tension trajectory", () => {
    const card = VALID_SCENARIO_CARD
      .replace("tension_target: 20", "tension_target: 10")
      .replace("tension_target: 45", "tension_target: 30")
      .replace("tension_target: 70", "tension_target: 50");
    // now 10, 30, 50 — strictly increasing
    const result = validateScenarioCard(card);
    expect(result.warnings.some((w) => w.includes("monotonic"))).toBe(true);
  });

  test("rejects leaked L-System tag", () => {
    const card = VALID_SCENARIO_CARD + "\nL5 territory mentioned in prose.\n";
    const result = validateScenarioCard(card);
    expect(result.errors.some((e) => e.includes('"L5"'))).toBe(true);
  });
});

const VALID_CHARACTER_CARD = `---
name: 洛天依
archetype: 回响之心
age_gender: 15岁 / 女性
inventory: none
---

## Visual Cortex
身高约156cm，银灰色长发。

## Biography
诞生于人类集体之声的数字歌姬。

## Cognitive Stack
Invariant: 从不把决策权让渡给会伤害他人的方向。
Variant: 在张力下，语言从沉稳转向短促的命令式。

## Instinct Protocol
核心欲望是被真正听见。

## Persona Topology

### Invariant Axes
- Will always respond to a sincere voice regardless of tension level.
- Will always protect the speaker's dignity even in conflict.

### Variant Axes
- Under increasing tension, vocal register shifts from measured warmth toward clipped commands.
- Under increasing tension, trust softens and genuine connection becomes accessible.
- Under increasing tension, physical stillness shifts toward restless motion.

### Boundary Conditions
- Hard limit: will never use voice to deceive or manipulate.
- Deep access condition: requires established trust and explicit initiation.

## Narrative Engine
语速稳定，喜欢用音乐隐喻。

## World Context
当前位于声学实验室。
`;

const VALID_SCENARIO_CARD = `---
scenario_name: 屋顶夜话
tags: ["#night", "#rooftop"]
world_state: 深夜公寓屋顶，雨后
beat_map:
  - label: Arrival
    tension_target: 20
    variant_config: suppression-active
    pivot_condition: 用户越过身体接近阈值
  - label: Surface Crack
    tension_target: 45
    variant_config: defense-softening
    pivot_condition: 主要防御机制失效一次
  - label: Disclosure
    tension_target: 70
    variant_config: disclosure-open
    pivot_condition: 角色主动承认情感
---

雨后的屋顶泛着潮湿的光泽。她侧身靠在栏杆上，没有回头，只是把声音放得很轻。

"你来了。"

<!--
## Scene Premise
两人刚从一场尴尬的聚会脱身。

## Neural State
- **Surface emotion:** 平静掩盖的不安
- **Tension source:** 未说出口的告白
- **Active lens:** 声学感知

## User Role
- **Identity:** 长期朋友
- **Immediate goal:** 想确认她的真实感受
-->
`;

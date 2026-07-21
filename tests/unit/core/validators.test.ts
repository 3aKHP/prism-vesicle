import { describe, expect, test } from "bun:test";
import { validateCharacterCard, validateScenarioCard, validateRuntimePacket, validateEvaluateReport, validateM0Output } from "../../../src/core/validators";

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

describe("validateRuntimePacket (Runtime engine)", () => {
  test("accepts a well-formed three-part packet", () => {
    const result = validateRuntimePacket(VALID_RUNTIME_PACKET);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("rejects a missing Hidden Neural Chain", () => {
    const result = validateRuntimePacket(VALID_RUNTIME_PACKET.replace("[!Neural Chain]\n", ""));
    expect(result.errors.some((e) => e.includes("[!Neural Chain]"))).toBe(true);
  });

  test("rejects a missing HUD line marker", () => {
    const result = validateRuntimePacket(VALID_RUNTIME_PACKET.replace("[Scene]", "[Place]"));
    expect(result.errors.some((e) => e.includes("[Scene]"))).toBe(true);
  });

  test("rejects leaked L-System tag", () => {
    const result = validateRuntimePacket(VALID_RUNTIME_PACKET + "\n某段提及 L3-A 的文字\n");
    expect(result.errors.some((e) => e.includes('"L3-A"'))).toBe(true);
  });

  test("accepts the published Stage packet variant", () => {
    expect(validateRuntimePacket(VALID_STAGE_PACKET).ok).toBe(true);
  });

  test("rejects a Stage packet without its consumer HUD", () => {
    const result = validateRuntimePacket(VALID_STAGE_PACKET.replace("[Impression]", "[View]"));
    expect(result.errors.some((error) => error.includes("[Impression]"))).toBe(true);
  });
});

describe("validateEvaluateReport (Evaluate engine)", () => {
  test("accepts a well-formed audit report", () => {
    const result = validateEvaluateReport(VALID_EVALUATE_REPORT);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("rejects a missing Overall Verdict", () => {
    const result = validateEvaluateReport(VALID_EVALUATE_REPORT.replace("**Overall Verdict:** CONDITIONAL", ""));
    expect(result.errors.some((e) => e.includes("Overall Verdict"))).toBe(true);
  });

  test("rejects a missing report section", () => {
    const result = validateEvaluateReport(VALID_EVALUATE_REPORT.replace("## 3. Detailed Findings\n", ""));
    expect(result.errors.some((e) => e.includes("## 3. Detailed Findings"))).toBe(true);
  });
});

const VALID_RUNTIME_PACKET = `<!--
[!Neural Chain]
Perception: 用户语气转冷被解读为边界试探
Instinct: 防御本能上升，但有被触动的诱因
State: Beat 1 / tension 45 / variant defense-softening / boundary approaching
Decision: 选择半退半守，用一句反问拖延
-->

[Beat] Arrival（1 轮）| Config: defense-softening | Boundary: approaching
[Tension] 45/100
[Char] 洛天依 | 防御略起但仍开放
[Scene] 屋顶，雨后
[Turn] 1

她没有回头，只是把指尖搭在栏杆上，雨后的凉意渗进声音里。

"你来得比我以为的早。"
`;

const VALID_STAGE_PACKET = `<!--
[!Neural Chain]
Perception: Rain darkens the platform.
Instinct: She keeps the umbrella tilted.
State: guarded hope.
Strategy: Let the silence hold.
-->
【Status】
[Space-Time] Night | platform
[Physical] Cold fingers | shared umbrella | worn coat
[Psychology] Tension: 40 (waiting) | Lens: rain
[Beat] Arrival (1 turn) | Config: guarded | Boundary: safe
[Impression] The player remains nearby.

Rain tapped softly against the umbrella.`;

const VALID_EVALUATE_REPORT = `# Neuro-Integrity Report: workspace/luotianyi.md
**Date:** 2026-07-10
**Overall Verdict:** CONDITIONAL

## 1. Executive Summary
角色卡基本合规，但 Variant Axes 缺少正向位移方向。

## 2. Dimension Scores
- Voice Fidelity: 8/10
- Neuro-Logic: 7/10

## 3. Detailed Findings
Persona Topology 的 Invariant Axes 满足两条，Topology 结构完整。

## 4. Issue List
1. Variant Axes 无正向软化方向。

## 5. Optimization Recommendations
建议增加一条描述"张力下信任软化、真诚连接变得可达"的 Variant Axis。
`;

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

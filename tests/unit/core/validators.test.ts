import { describe, expect, test } from "bun:test";
import { validateCharacterCard, validateScenarioCard, validateRuntimePacket, validateEvaluateReport, validateM0Output } from "../../../src/core/validators";
import { resolveValidators, validateContent, applicableValidators } from "../../../src/core/validators/registry";

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

  test("rejects invalid YAML, duplicate fields, and wrong field types", () => {
    const invalid = validateCharacterCard(VALID_CHARACTER_CARD.replace("name: 洛天依", "name: [洛天依"));
    expect(invalid.errors.some((error) => error.includes("invalid YAML syntax"))).toBe(true);

    const duplicate = validateCharacterCard(VALID_CHARACTER_CARD.replace("name: 洛天依", "name: 洛天依\nname: 言和"));
    expect(duplicate.errors.some((error) => error.includes('field "name" is duplicated'))).toBe(true);

    const wrongType = validateCharacterCard(VALID_CHARACTER_CARD.replace("archetype: 回响之心", "archetype: 42"));
    expect(wrongType.errors.some((error) => error.includes('field "archetype" must be a non-empty string'))).toBe(true);
  });

  test("rejects a missing body section", () => {
    const card = VALID_CHARACTER_CARD.replace("## Biography\n诞生于人类集体之声的数字歌姬。\n", "");
    const result = validateCharacterCard(card);
    expect(result.errors.some((e) => e.includes("## Biography"))).toBe(true);
  });

  test("rejects duplicate, out-of-order, and empty body sections", () => {
    const duplicate = validateCharacterCard(VALID_CHARACTER_CARD.replace("## Biography", "## Biography\n## Biography"));
    expect(duplicate.errors.some((error) => error.includes("## Biography must appear exactly once"))).toBe(true);

    const outOfOrder = validateCharacterCard(VALID_CHARACTER_CARD
      .replace("## Visual Cortex", "## Biography")
      .replace("## Biography\n诞生", "## Visual Cortex\n诞生"));
    expect(outOfOrder.errors.some((error) => error.includes("out of order"))).toBe(true);

    const empty = validateCharacterCard(VALID_CHARACTER_CARD.replace("## Visual Cortex\n身高约156cm，银灰色长发。", "## Visual Cortex"));
    expect(empty.errors.some((error) => error.includes("## Visual Cortex is empty"))).toBe(true);
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

  test("does not guess whether Variant Axes have a positive semantic direction", () => {
    const card = VALID_CHARACTER_CARD.replace(
      /### Variant Axes[\s\S]*?### Boundary Conditions/,
      "### Variant Axes\n- Under tension, decisions become shared.\n- Under tension, the character begins active creation.\n- Under tension, time together is openly chosen.\n\n### Boundary Conditions",
    );
    const result = validateCharacterCard(card);
    expect(result.warnings.some((warning) => warning.includes("positive"))).toBe(false);
  });

  test("requires an explicit non-empty Hard limit item in Boundary Conditions", () => {
    const card = VALID_CHARACTER_CARD.replace(
      "- Hard limit: will never use voice to deceive or manipulate.",
      "- There is no hard limit.\n\nThe Biography says Hard limit: elsewhere.",
    );
    const result = validateCharacterCard(card);
    expect(result.errors).toContain('Module A: Boundary Conditions must contain a non-empty "Hard limit:" list item.');
  });

  test("rejects the standalone L4 production label without treating L4-A as L4", () => {
    const standalone = validateCharacterCard(`${VALID_CHARACTER_CARD}\nStandalone L4 territory.`);
    expect(standalone.errors.some((error) => error.includes('"L4"'))).toBe(true);

    const sublevel = validateCharacterCard(`${VALID_CHARACTER_CARD}\nStandalone L4-A territory.`);
    expect(sublevel.errors.filter((error) => error.includes('L-System tag'))).toEqual([
      'Module A: L-System tag "L4-A" leaked into output. These are production-layer only.',
    ]);
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

  test("rejects multiline world_state and an unrelated HTML comment", () => {
    const card = VALID_SCENARIO_CARD
      .replace("world_state: 深夜公寓屋顶，雨后", "world_state: |\n  深夜公寓屋顶\n  雨后")
      .replace(/<!--[\s\S]*?-->/, "<!-- unrelated note -->");
    const result = validateScenarioCard(card);
    expect(result.errors.some((error) => error.includes("ordinary single-line string"))).toBe(true);
    expect(result.errors.some((error) => error.includes('exactly one "## Scene Premise"'))).toBe(true);
    expect(result.errors.some((error) => error.includes('exactly one "## Neural State"'))).toBe(true);
    expect(result.errors.some((error) => error.includes('exactly one "## User Role"'))).toBe(true);
  });

  test("rejects duplicate beat fields and non-string beat fields", () => {
    const card = VALID_SCENARIO_CARD
      .replace("    variant_config: suppression-active", "    label: Duplicate\n    variant_config: suppression-active")
      .replace("    pivot_condition: 用户越过身体接近阈值", "    pivot_condition: 42");
    const result = validateScenarioCard(card);
    expect(result.errors.some((error) => error.includes('beat 1 field "label" is duplicated'))).toBe(true);
    expect(result.errors.some((error) => error.includes('field "pivot_condition" must be a non-empty string'))).toBe(true);
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

  test("rejects Runtime tokens stacked on one line outside their structural scopes", () => {
    const result = validateRuntimePacket(
      "[!Neural Chain] Perception: x Instinct: y State: z Decision: q [Beat] A [Tension] 20 [Char] C [Scene] S [Turn] 1",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("Part 1 must begin"))).toBe(true);
    expect(result.errors.some((error) => error.includes("exactly one non-empty [Beat] line"))).toBe(true);
  });

  test("rejects Stage HUD fields in the wrong order and empty prose", () => {
    const result = validateRuntimePacket(VALID_STAGE_PACKET
      .replace("[Space-Time] Night | platform\n[Physical] Cold fingers | shared umbrella | worn coat", "[Physical] Cold fingers | shared umbrella | worn coat\n[Space-Time] Night | platform")
      .replace("\n\nRain tapped softly against the umbrella.", ""));
    expect(result.errors.some((error) => error.includes("out of order"))).toBe(true);
    expect(result.errors.some((error) => error.includes("Part 3 prose content is empty"))).toBe(true);
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

  test("rejects reversed, duplicate, and empty report sections", () => {
    const result = validateEvaluateReport(`# Neuro-Integrity Report: target
**Overall Verdict:** PASS

## 5. Optimization Recommendations
## 4. Issue List
## 3. Detailed Findings
## 2. Dimension Scores
## 1. Executive Summary
## 1. Executive Summary
`);
    expect(result.errors.some((error) => error.includes("out of order"))).toBe(true);
    expect(result.errors.some((error) => error.includes('exactly one section "## 1. Executive Summary"'))).toBe(true);
    expect(result.errors.some((error) => error.includes("is empty"))).toBe(true);
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

describe("validator applies discrimination (registry)", () => {
  const validators = resolveValidators(["character-card", "scenario-card"]);
  const applies = (name: string, content: string) =>
    validators.find((v) => v.name === name)!.applies(content);

  const characterCard = `---
name: 谬因
archetype: 观测者
age_gender: 女
inventory: 终端
---

## Visual Cortex
appearance
## Biography
bio
## Cognitive Stack
### Invariant
- a
- b
## Instinct Protocol
x
## Persona Topology
### Invariant Axes
- a
- b
### Variant Axes
- a
- b
- c
### Boundary Conditions
- **Hard limit:** none
## Narrative Engine
voice
## World Context
world
`;

  const scenarioCard = `---
scenario_name: 助理的第一天
tags: ["#office"]
world_state: "office"
beat_map:
  - label: A
    tension_target: 20
    variant_config: x
    pivot_condition: y
  - label: B
    tension_target: 10
    variant_config: x
    pivot_condition: y
  - label: C
    tension_target: 30
    variant_config: x
    pivot_condition: y
---

opening paragraph

<!--
## Scene Premise
s
## Neural State
n
## User Role
u
-->
`;

  // A Markdown report that starts with a `---` horizontal rule — the
  // regression source: it must not trigger either card validator.
  const leadingRuleReport = `---

## 核查结果报告

我通过工具核实了角色信息。

---

### 基本信息
| 项目 | 素材 |
|---|---|
| 代号 | 谬因 |
`;

  test("a character card applies only to character-card", () => {
    expect(applies("character-card", characterCard)).toBe(true);
    expect(applies("scenario-card", characterCard)).toBe(false);
  });

  test("a scenario card applies only to scenario-card", () => {
    expect(applies("scenario-card", scenarioCard)).toBe(true);
    expect(applies("character-card", scenarioCard)).toBe(false);
  });

  test("a leading `---` report applies to neither card validator", () => {
    expect(applies("character-card", leadingRuleReport)).toBe(false);
    expect(applies("scenario-card", leadingRuleReport)).toBe(false);
  });

  test("a card with keys but a missing closing fence is still recognized (then flagged malformed)", () => {
    // Lenient classification: no closing `---`, but the keys are present. The
    // card must still match so the validator runs and reports the malformation
    // rather than silently passing.
    const unclosed = `---
name: x
archetype: observer
age_gender: f
inventory: tool

## Visual Cortex
appearance`;
    expect(applies("character-card", unclosed)).toBe(true);
    const result = validateContent(["character-card", "scenario-card"], unclosed);
    expect(result?.results[0]?.result.ok).toBe(false);
    expect(result?.results[0]?.result.errors.some((e: string) => e.includes("frontmatter is missing or malformed"))).toBe(true);
  });

  test("a Module A card missing archetype is still recognized (shape, not field)", () => {
    const missingArchetype = characterCard.replace("archetype: 观测者\n", "");
    // age_gender / inventory still mark it as a character card.
    expect(applies("character-card", missingArchetype)).toBe(true);
    expect(applies("scenario-card", missingArchetype)).toBe(false);
  });

  test("a Module B card missing scenario_name is still recognized via world_state/beat_map", () => {
    const missingScenarioName = scenarioCard.replace("scenario_name: 助理的第一天\n", "");
    expect(applies("scenario-card", missingScenarioName)).toBe(true);
    expect(applies("character-card", missingScenarioName)).toBe(false);
  });

  test("the wired validateContent path runs only applying validators (no cross-noise)", () => {
    // validateContent is the single wired path used by both turn-finalizer
    // auto-validation and /validate, so this exercises the real
    // resolve+filter+run rather than mirroring the filter locally.
    const runFor = (content: string) => {
      const result = validateContent(["character-card", "scenario-card"], content);
      return result
        ? { ran: result.results.map((entry) => entry.name), ok: result.ok }
        : { ran: [] as string[], ok: true };
    };
    expect(runFor(characterCard)).toEqual({ ran: ["character-card"], ok: true });
    expect(runFor(scenarioCard)).toEqual({ ran: ["scenario-card"], ok: true });
    // The report triggers no validator at all.
    expect(runFor(leadingRuleReport).ran).toEqual([]);
  });

  test("the wired path warns on prohibited contrast prose only inside Module A/B artifacts", () => {
    const characterResult = validateContent(
      ["character-card", "scenario-card"],
      characterCard.replace("bio", "这不是迟疑，而是她对边界的重新确认。"),
    );
    expect(characterResult?.results).toHaveLength(1);
    expect(characterResult?.results[0]?.name).toBe("character-card");
    expect(characterResult?.results[0]?.result.ok).toBe(true);
    expect(characterResult?.results[0]?.result.warnings).toContain(
      "Module A: artifact text matches the prohibited “不是……而是……” contrast pattern (Rule zh-f1-not-x-but-y).",
    );

    const scenarioResult = validateContent(
      ["character-card", "scenario-card"],
      scenarioCard.replace("opening paragraph", "这不是巧合，而是她提前安排的会面。"),
    );
    expect(scenarioResult?.results).toHaveLength(1);
    expect(scenarioResult?.results[0]?.name).toBe("scenario-card");
    expect(scenarioResult?.results[0]?.result.ok).toBe(true);
    expect(scenarioResult?.results[0]?.result.warnings).toContain(
      "Module B: artifact text matches the prohibited “不是……而是……” contrast pattern (Rule zh-f1-not-x-but-y).",
    );

    expect(validateContent(
      ["character-card", "scenario-card"],
      "这不是遗漏，而是普通 ETL 回复中目前允许的表达。",
    )).toBeUndefined();
  });

  test("applicableValidators returns the matched names only", () => {
    expect(applicableValidators(["character-card", "scenario-card"], characterCard)).toEqual(["character-card"]);
    expect(applicableValidators(["character-card", "scenario-card"], scenarioCard)).toEqual(["scenario-card"]);
    expect(applicableValidators(["character-card", "scenario-card"], leadingRuleReport)).toEqual([]);
  });
});

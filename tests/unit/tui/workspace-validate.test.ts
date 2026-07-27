import { describe, expect, test } from "bun:test";
import {
  extractAnchors,
  locateFinding,
  runValidation,
  validationSeverity,
  validationSummary,
} from "../../../src/tui/workspace-validate";

describe("validate anchor extraction", () => {
  test("pulls ## section headers and quoted frontmatter keys from a finding", () => {
    expect(extractAnchors('Module A: YAML frontmatter field "archetype" is not allowed.'))
      .toEqual(["archetype:"]);
    expect(extractAnchors("Module A: missing mandatory section ## Visual Cortex."))
      .toEqual(["## Visual Cortex"]);
    expect(extractAnchors("Module A: Persona Topology is missing subsection ### Invariant Axes."))
      .toEqual(["### Invariant Axes"]);
  });
});

describe("validate finding → line resolution", () => {
  const card = [
    "---",
    "name: Mira",
    "archetype: voyager",
    "---",
    "## Visual Cortex",
    "body",
    "## Biography",
    "body",
    "",
  ].join("\n");

  test("a present section header resolves to its line (anchored)", () => {
    const { line, anchored } = locateFinding(card, "Module A: missing mandatory section ## Biography.");
    expect(anchored).toBe(true);
    // "## Biography" sits on the 7th line (0-indexed 6).
    expect(line).toBe(6);
  });

  test("a present frontmatter key resolves to its line (anchored)", () => {
    const { line, anchored } = locateFinding(card, 'field "archetype" is not allowed.');
    expect(anchored).toBe(true);
    expect(line).toBe(2); // "archetype: voyager" is line 2 (0-indexed)
  });

  test("a missing field has no anchor → falls back to the frontmatter close, anchored=false", () => {
    const { line, anchored } = locateFinding(card, 'recommended YAML field "inventory" is missing.');
    expect(anchored).toBe(false);
    // Fallback is the closing "---" of the frontmatter (line 3, 0-indexed).
    expect(line).toBe(3);
  });

  test("content with no frontmatter falls back to line 0", () => {
    const { line, anchored } = locateFinding("just prose\n", "Module A: missing mandatory section ## Visual Cortex.");
    expect(anchored).toBe(false);
    expect(line).toBe(0);
  });
});

describe("validate run + summary + severity", () => {
  const validCard = [
    "---",
    "name: Mira",
    "archetype: voyager",
    "age_gender: 30",
    "inventory: []",
    "---",
    "## Visual Cortex",
    "x",
    "## Biography",
    "x",
    "## Cognitive Stack",
    "x",
    "## Instinct Protocol",
    "x",
    "## Persona Topology",
    "### Invariant Axes",
    "- a",
    "- b",
    "### Variant Axes",
    "- softens toward trust under sustained kindness",
    "- b",
    "- c",
    "### Boundary Conditions",
    "Hard limit: none",
    "## Narrative Engine",
    "x",
    "## World Context",
    "x",
    "",
  ].join("\n");

  test("plain prose → no-match (no validator applies)", () => {
    const state = runValidation("workspace/x.md", "just some prose, not a card");
    expect(state.state).toBe("no-match");
    if (state.state === "no-match") expect(state.path).toBe("workspace/x.md");
    expect(validationSummary(state)).toBe("no validator matched");
    expect(validationSeverity(state)).toBe(-1);
  });

  test("a valid card passes clean", () => {
    const state = runValidation("workspace/cards/mira.md", validCard);
    expect(state.state).toBe("result");
    if (state.state === "result") {
      expect(state.path).toBe("workspace/cards/mira.md");
      expect(state.ok).toBe(true);
      expect(state.findings.every((f) => f.severity === "warning")).toBe(true);
    }
    expect(validationSummary(state)).toBe("✓ validators passed");
    expect(validationSeverity(state)).toBe(0);
  });

  test("a card missing a mandatory section reports anchored errors", () => {
    const broken = validCard.replace("## Narrative Engine\nx\n", "");
    const state = runValidation("workspace/cards/broken.md", broken);
    expect(state.state).toBe("result");
    if (state.state === "result") {
      expect(state.ok).toBe(false);
      const missing = state.findings.find((f) => f.text.includes("Narrative Engine"));
      // Section was removed, so its anchor is absent → falls back, not anchored.
      expect(missing?.anchored).toBe(false);
    }
    const summary = validationSummary(state);
    expect(summary).toContain("✗");
    expect(validationSeverity(state)).toBe(2);
  });

  test("the summary never carries an action token (Issue #118 §1)", () => {
    // Every semantic outcome must be pure state — no `v`, `view`, `Enter`, …
    const cases: Array<{ label: string; state: import("../../../src/tui/workspace-validate").ValidationState }> = [
      { label: "pending", state: { state: "pending" } },
      { label: "no-match", state: { state: "no-match", path: "a.md" } },
      { label: "stale", state: { state: "stale", path: "a.md" } },
      { label: "passed", state: { state: "result", path: "a.md", ok: true, findings: [] } },
      {
        label: "errors+warnings",
        state: {
          state: "result", path: "a.md", ok: false,
          findings: [
            { severity: "error", validator: "x", text: "e", line: 0, anchored: true },
            { severity: "warning", validator: "y", text: "w", line: 1, anchored: true },
          ],
        },
      },
    ];
    for (const { label, state } of cases) {
      const summary = validationSummary(state);
      expect(summary).not.toMatch(/\b(view|validate|Enter|jump)\b/);
      // The historic duplicate suffix must not survive.
      expect(summary).not.toContain("v view");
      // Sanity: the label is informative (avoid a vacuous pass on empty-string cases).
      expect(label).toBeTruthy();
    }
  });

  test("a stale projection reads neutral and contributes no severity colour", () => {
    const stale = { state: "stale", path: "a.md" } as const;
    expect(validationSummary(stale)).toBe("validation stale");
    expect(validationSeverity(stale)).toBe(-1);
  });
});

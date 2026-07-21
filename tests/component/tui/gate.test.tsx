import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { GatePrompt, gateComposerIsActive, gateOptionLine, gateSummaryLineBudget, sanitizeGateLabel, wrapGateSummary } from "../../../src/tui/GatePrompt";

describe("tui: gate surfaces", () => {
  test("renders a usable stop gate panel at 100 columns", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: "Target Concept: 测试角色\nArchetype: Mirror\nCore Desire: 被理解",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        width={100}
        maxSummaryLines={3}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Stop Gate: blueprint-confirmation");
    expect(frame).toContain("Target Concept: 测试角色");
    expect(frame).toContain(">1. Confirm");
  });

  test("renders request_confirmation reject input without overlapping summary and confirm rows", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: [
            "Target Concept: 一个很长的蓝图预览",
            "Archetype: Mirror",
            "Core Desire: 被理解",
            "Topology Notes: should be hidden behind ellipsis",
          ].join("\n"),
        }}
        focused="reject"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(3, true)}
      />
    ), { width: 80, height: 9 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n");
    const ellipsisLine = lines.findIndex((line) => line.includes("..."));
    const confirmLine = lines.findIndex((line) => line.includes("1. Confirm"));
    const rejectLine = lines.findIndex((line) => line.includes(">2. Reject"));
    const inputLine = lines.findIndex((line) => line.includes("✎"));

    expect(ellipsisLine).toBeGreaterThan(-1);
    expect(confirmLine).toBeGreaterThan(ellipsisLine);
    expect(rejectLine).toBeGreaterThan(confirmLine);
    expect(inputLine).toBeGreaterThan(rejectLine);
    expect(lines[confirmLine]).not.toContain("...");
    expect(lines[confirmLine]).not.toContain("Core Desire");
  });

  test("renders stop gate markdown summaries instead of raw markdown markers", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "blueprint-confirmation",
          summary: "**Target Concept:** 测试角色\n\n**Archetype:** Mirror",
        }}
        focused="confirm"
        feedbackMode={null}
        feedback=""
        width={100}
        maxSummaryLines={4}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Target Concept:");
    expect(frame).toContain("Archetype:");
    expect(frame).not.toContain("**Target Concept:**");
    expect(frame).not.toContain("**Archetype:**");
  });

  test("builds stop gate options as stable single-line labels", () => {
    expect(gateOptionLine(1, "Confirm - proceed to next phase", true)).toBe(">1. Confirm - proceed to next phase");
    expect(gateOptionLine(2, "Reject - discuss or request changes", false)).toBe(" 2. Reject - discuss or request changes");
  });

  test("renders engine-switch summary option without overlapping the footer", async () => {
    expect(gateSummaryLineBudget(4, false, 1)).toBe(3);
    expect(gateSummaryLineBudget(4, true, 1)).toBe(2);

    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "engine-switch",
          summary: "Current Engine: etl\nTarget Engine: runtime\n\nReason: Runtime should handle this.\n\nHandoff Summary: Cards are ready.",
          options: [
            { label: "Confirm - switch to runtime", decision: "confirm" },
            { label: "Reject - stay on etl and discuss", decision: "reject" },
          ],
        }}
        focused="confirm-summary"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(4, false, 1)}
        showSummaryOption
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Stop Gate: engine-switch");
    expect(frame).toContain(">2. Confirm with summary - compact context first");
    expect(frame).toContain(" 3. Reject - stay on etl and discuss");
    expect(frame).toContain("↑/↓ navigate");
  });

  test("renders engine-switch reject input without overlapping summary options", async () => {
    const setup = await testRender(() => (
      <GatePrompt
        gate={{
          gate: "engine-switch",
          summary: [
            "Current Engine: etl",
            "Target Engine: runtime",
            "",
            "Reason: Runtime should handle this.",
            "",
            "Handoff Summary: Cards are ready.",
          ].join("\n"),
          options: [
            { label: "Confirm - switch to runtime", decision: "confirm" },
            { label: "Reject - stay on etl and discuss", decision: "reject" },
          ],
        }}
        focused="reject"
        feedbackMode={null}
        feedback=""
        width={80}
        maxSummaryLines={gateSummaryLineBudget(4, true, 1)}
        showSummaryOption
      />
    ), { width: 80, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n");
    const confirmLine = lines.findIndex((line) => line.includes("1. Confirm - switch to runtime"));
    const summaryLine = lines.findIndex((line) => line.includes("2. Confirm with summary"));
    const rejectLine = lines.findIndex((line) => line.includes(">3. Reject - stay on etl"));
    const inputLine = lines.findIndex((line) => line.includes("✎"));

    expect(confirmLine).toBeGreaterThan(-1);
    expect(summaryLine).toBeGreaterThan(confirmLine);
    expect(rejectLine).toBeGreaterThan(summaryLine);
    expect(inputLine).toBeGreaterThan(rejectLine);
    expect(lines[summaryLine]).not.toContain("Handoff Summary");
    expect(lines[rejectLine]).not.toContain("Handoff Summary");
  });

  test("activates the visible Reject composer without requiring Tab amend", () => {
    expect(gateComposerIsActive("reject", null)).toBe(true);
    expect(gateComposerIsActive("confirm", null)).toBe(false);
    expect(gateComposerIsActive("confirm", "confirm")).toBe(true);
    expect(gateSummaryLineBudget(4, false)).toBe(4);
    expect(gateSummaryLineBudget(4, true)).toBe(3);
  });

  test("sanitizes model-provided stop gate option labels before rendering", () => {
    expect(sanitizeGateLabel("\u001b[31mConfirm\u001b[0m\r\nnow\b")).toBe("Confirm now");
  });

  test("wraps stop gate summary into real layout lines", () => {
    expect(wrapGateSummary("A\n\nB", 10)).toEqual(["A", "", "B"]);

    const wrapped = wrapGateSummary("Archetype: 天真的共鸣者 The Innocent Resonator", 24);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join("")).toBe("Archetype: 天真的共鸣者 The Innocent Resonator");
  });
});

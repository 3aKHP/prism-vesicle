import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "../src/tui/app";
import { GatePrompt, gateOptionLine, sanitizeGateLabel, wrapGateSummary } from "../src/tui/GatePrompt";

describe("TUI", () => {
  test("renders a readable balanced shell at 100 columns", async () => {
    const setup = await testRender(() => <App />, { width: 100, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Prism Vesicle");
    expect(frame).toContain("Workspace");
    expect(frame).toContain("Messages");
    expect(frame).not.toContain("Output / Validation");
    // Initial system notice should render as plain text (not the old role> prefix).
    expect(frame).toContain("Ready. Enter one Prism");
    expect(frame).not.toContain("system>");
    // Input bar present.
    expect(frame).toContain("Type prompt, Enter to send");
  });

  test("renders the activity pane only when the terminal is wide enough", async () => {
    const setup = await testRender(() => <App />, { width: 124, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Workspace");
    expect(frame).toContain("Messages");
    expect(frame).toContain("Activity / Artifacts");
  });

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
        onFeedbackInput={() => undefined}
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

  test("builds stop gate options as stable single-line labels", () => {
    expect(gateOptionLine(1, "Confirm - proceed to next phase", true)).toBe(">1. Confirm - proceed to next phase");
    expect(gateOptionLine(2, "Revise - tell the engine what to change", false)).toBe(" 2. Revise - tell the engine what to change");
    expect(gateOptionLine(3, "Chat about this", false)).toBe(" 3. Chat about this");
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

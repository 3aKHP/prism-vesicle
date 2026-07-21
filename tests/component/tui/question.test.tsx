import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { QuestionPrompt, optionLine, questionComposerIsActive, questionPanelMinHeight } from "../../../src/tui/QuestionPrompt";
import { resolveTuiLayout } from "../../../src/tui/layout";

describe("tui: question surfaces", () => {
  test("builds question options as stable single-line labels", () => {
    expect(optionLine(1, "Narrow", "Minimum change.", true, 80)).toBe(">1. Narrow - Minimum change.");
    expect(optionLine(2, "Broad", "Include adjacent cleanup.", false, 80)).toBe(" 2. Broad - Include adjacent cleanup.");
    expect(optionLine(4, "Answer freely", "Type an open-ended answer.", false, 80)).toBe(" 4. Answer freely - Type an open-ended answer.");
  });

  test("uses the same freeform predicate for question rendering and input", () => {
    expect(questionComposerIsActive({ label: "Answer freely", description: "Type freely.", kind: "freeform" })).toBe(true);
    expect(questionComposerIsActive({ label: "Skip", description: "Continue.", kind: "skip" })).toBe(false);
    expect(questionComposerIsActive(undefined)).toBe(false);
  });

  test("reserves two rows when the selected question option is freeform", () => {
    const question = {
      header: "Scope",
      question: "Which scope?",
      options: [
        { label: "Narrow", description: "Minimum.", kind: "model" as const },
        { label: "Broad", description: "Adjacent cleanup.", kind: "model" as const },
        { label: "Rewrite", description: "Larger change.", kind: "model" as const },
        { label: "Audit", description: "Inspect only.", kind: "model" as const },
        { label: "Skip", description: "Continue.", kind: "skip" as const },
        { label: "Answer freely", description: "Type freely.", kind: "freeform" as const },
      ],
    };

    expect(questionPanelMinHeight(question, 0)).toBe(10);
    expect(questionPanelMinHeight(question, 5)).toBe(12);
    expect(resolveTuiLayout(100, 24, true, false, questionPanelMinHeight(question, 5)).bottomHeight).toBe(12);
  });

  test("renders the question open answer fallback with inline input", async () => {
    const setup = await testRender(() => (
      <QuestionPrompt
        question={{
          header: "Scope",
          question: "Which scope should I use?",
          options: [
            { label: "Narrow", description: "Minimum change.", kind: "model" },
            { label: "Broad", description: "Include adjacent cleanup.", kind: "model" },
            { label: "Skip", description: "Let the model continue.", kind: "skip" },
            { label: "Answer freely", description: "Type an open-ended answer.", kind: "freeform" },
          ],
        }}
        selected={3}
        width={100}
        freeformValue="Use the existing shape"
        freeformCursor={22}
      />
    ), { width: 100, height: 10 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain(">4. Answer freely");
    expect(frame).toContain("Use the existing shape");
    const lines = frame.split("\n");
    const freeformOptionLine = lines.findIndex((line) => line.includes(">4. Answer freely"));
    const inputLine = lines.findIndex((line) => line.includes("Use the existing shape"));
    expect(inputLine).toBeGreaterThan(freeformOptionLine);
    expect(lines[freeformOptionLine]).not.toContain("Use the existing shape");
  });

});

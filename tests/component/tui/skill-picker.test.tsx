import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { OptionPicker } from "../../../src/tui/widgets/OptionPicker";
import { resolveBottomSurfaceMode, type BottomSurfaceState } from "../../../src/tui/views/BottomSurface";
import type { SkillPickerState } from "../../../src/tui/skill-picker-controller";
import type { OptionItem } from "../../../src/tui/types";

const skillItems: OptionItem[] = [
  { id: "review-rubric", label: "review-rubric", detail: "[user] Evaluate prose against a structured rubric" },
  { id: "md2docx", label: "md2docx", detail: "[installed] · 1 script Convert Markdown to OOXML" },
  { id: "research-synthesis", label: "research-synthesis", detail: "[harness] · 2 scripts Synthesize research notes" },
];

describe("tui: skill picker", () => {
  test("bottom surface resolves skill-picker above composer", () => {
    const base: BottomSurfaceState = {
      yoloStage: null,
      permissionRequest: undefined,
      question: null,
      gate: null,
      rewind: null,
      branch: null,
      session: null,
      skillPicker: null,
      model: null,
    };
    expect(resolveBottomSurfaceMode(base).kind).toBe("composer");
    const picker: SkillPickerState = { selected: 0 };
    expect(resolveBottomSurfaceMode({ ...base, skillPicker: picker }).kind).toBe("skill-picker");
  });

  test("bottom surface priority: gate beats skill-picker", () => {
    const base: BottomSurfaceState = {
      yoloStage: null,
      permissionRequest: undefined,
      question: null,
      gate: { gate: "phase", summary: "Confirm phase", options: [] },
      rewind: null,
      branch: null,
      session: null,
      skillPicker: { selected: 1 },
      model: null,
    };
    expect(resolveBottomSurfaceMode(base).kind).toBe("gate");
  });

  test("renders skill picker at 80 columns without clipping", async () => {
    const setup = await testRender(() => (
      <OptionPicker
        title="Skills (3)"
        items={skillItems}
        selected={0}
        width={80}
        hint="↑/↓ choose · Enter activate · Esc close"
        maxVisible={5}
      />
    ), { width: 80, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(frame).toContain("Skills (3)");
    expect(frame).toContain("review-rubric");
    expect(frame).toContain("md2docx");
    expect(frame).toContain("research-synthesis");
  });

  test("renders selection marker on the active row", async () => {
    const setup = await testRender(() => (
      <OptionPicker
        title="Skills (3)"
        items={skillItems}
        selected={1}
        width={80}
        hint="↑/↓ choose · Enter activate · Esc close"
        maxVisible={5}
      />
    ), { width: 80, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const lines = frame.split("\n");
    const md2docxLine = lines.find((line) => line.includes("md2docx"));
    expect(md2docxLine).toBeDefined();
    expect(md2docxLine).toContain(">");
    const rubricLine = lines.find((line) => line.includes("review-rubric"));
    expect(rubricLine).toBeDefined();
    expect(rubricLine).not.toContain(">");
  });

  test("empty catalog shows title without items", async () => {
    const setup = await testRender(() => (
      <OptionPicker
        title="No skills available"
        items={[]}
        selected={0}
        width={80}
        hint="Esc close"
        maxVisible={5}
      />
    ), { width: 80, height: 4 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("No skills available");
  });
});

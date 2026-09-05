import { describe, expect, test } from "bun:test";
import { projectReadingSurface } from "../../../src/tui/reading/surfaces";
import { readingModes, readingOptions } from "../../support/reading-fixtures";

describe("bottom-surface readable data", () => {
  test.each(readingModes.map((mode) => [mode.kind, mode] as const))("%s exposes existing user-facing content", (_kind, mode) => {
    const doc = projectReadingSurface(mode, readingOptions);
    expect(doc?.enabled).toBe(true);
    expect(doc?.blocks.length).toBeGreaterThan(0);
  });

  test("migration includes findings beyond the previous eight-item limit", () => {
    const doc = projectReadingSurface(readingModes.find((mode) => mode.kind === "session-migration")!, readingOptions)!;
    const text = doc.blocks.map((block) => block.text).join("\n");
    for (let i = 0; i < 24; i += 1) expect(text).toContain(`finding-${i}:`);
    expect(doc.hidden).toBe(true);
  });

  test("question options and branch file details are not reduced to display excerpts", () => {
    const question = projectReadingSurface(readingModes.find((mode) => mode.kind === "question")!, readingOptions)!;
    expect(question.blocks.map((block) => block.text).join("\n")).toContain("Answer freely - Type");
    const branch = projectReadingSurface(readingModes.find((mode) => mode.kind === "branch")!, readingOptions)!;
    expect(branch.blocks.map((block) => block.text).join("\n")).toContain("workspace/file-19.md");
  });

  test("a single truncated label expands even when there are few detail lines", () => {
    const mode = readingModes.find((mode) => mode.kind === "model")!;
    expect(projectReadingSurface(mode, { ...readingOptions, modelItems: [{ id: "m", label: "a".repeat(30), detail: "short" }] })?.hidden).toBe(true);
    expect(projectReadingSurface(mode, { ...readingOptions, modelItems: [{ id: "m", label: "m", detail: "short" }] })?.hidden).toBe(false);
  });

  test("a multiline question option expands even in a wide terminal", () => {
    const mode = readingModes.find((mode) => mode.kind === "question")!;
    const pending = { ...mode.pending, question: { header: "Q", question: "Choose", options: [
      { label: "First", description: "VISIBLE\nHIDDEN-DETAIL" }, { label: "Second", description: "Other" },
    ] } };
    const doc = projectReadingSurface({ kind: "question", pending }, { ...readingOptions, width: 120 })!;
    expect(doc.hidden).toBe(true);
    expect(doc.blocks.map((block) => block.text).join("\n")).toContain("HIDDEN-DETAIL");
  });

  test("picker error reading accounts for the compact Error prefix", () => {
    for (const mode of readingModes) {
      if (mode.kind !== "rewind" && mode.kind !== "branch") continue;
      const doc = projectReadingSurface({ ...mode, picker: { ...mode.picker, error: "e".repeat(70) } } as typeof mode, readingOptions)!;
      expect(doc.hidden).toBe(true);
      expect(doc.blocks.at(-1)?.text).toBe("e".repeat(70));
      const short = projectReadingSurface({ ...mode, picker: { ...mode.picker, error: "short error" } } as typeof mode, readingOptions)!;
      expect(short.hidden).toBe(false);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { runMarkdownRuntimeDiagnostic } from "../../../src/tui/markdown-runtime-diagnostic";
import { configureTreeSitterWorkerPath } from "../../../src/tui/tree-sitter-runtime";

describe("Markdown runtime diagnostic", () => {
  test("resolves the installed worker independently of the active project and proves fixed Markdown and TypeScript highlighting", async () => {
    expect(configureTreeSitterWorkerPath()).toContain("node_modules/@opentui/core/parser.worker.js");

    const diagnostic = await runMarkdownRuntimeDiagnostic();
    expect(diagnostic.ok).toBe(true);
    expect(diagnostic.probes).toEqual([
      expect.objectContaining({ filetype: "markdown", error: undefined, highlights: expect.objectContaining({ count: expect.any(Number) }) }),
      expect.objectContaining({ filetype: "typescript", error: undefined, highlights: expect.objectContaining({ count: expect.any(Number) }) }),
    ]);
    expect(diagnostic.probes.every((probe) => probe.highlights.count > 0)).toBe(true);
  });
});

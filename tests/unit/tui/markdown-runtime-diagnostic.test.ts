import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMarkdownRuntimeDiagnostic } from "../../../src/tui/markdown-runtime-diagnostic";
import { configureTreeSitterWorkerPath } from "../../../src/tui/tree-sitter-runtime";

type GlobalWithWorkerPath = typeof globalThis & { OTUI_TREE_SITTER_WORKER_PATH?: string };

describe("Markdown runtime diagnostic", () => {
  // configureTreeSitterWorkerPath short-circuits on OTUI_TREE_SITTER_WORKER_PATH
  // and writes its resolved value back into process.env and globalThis. Snapshot
  // and clear both so the assertion is independent of the host environment.
  let previousEnv: string | undefined;
  let previousGlobal: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.OTUI_TREE_SITTER_WORKER_PATH;
    previousGlobal = (globalThis as GlobalWithWorkerPath).OTUI_TREE_SITTER_WORKER_PATH;
    delete process.env.OTUI_TREE_SITTER_WORKER_PATH;
    delete (globalThis as GlobalWithWorkerPath).OTUI_TREE_SITTER_WORKER_PATH;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.OTUI_TREE_SITTER_WORKER_PATH;
    else process.env.OTUI_TREE_SITTER_WORKER_PATH = previousEnv;
    if (previousGlobal === undefined) delete (globalThis as GlobalWithWorkerPath).OTUI_TREE_SITTER_WORKER_PATH;
    else (globalThis as GlobalWithWorkerPath).OTUI_TREE_SITTER_WORKER_PATH = previousGlobal;
  });

  test("resolves the installed worker independently of the active project and proves fixed Markdown and TypeScript highlighting", async () => {
    // path.join yields backslashes on Windows; normalize before the substring check.
    const workerPath = configureTreeSitterWorkerPath();
    expect(workerPath?.replace(/\\/g, "/")).toContain("node_modules/@3akhp/opentui-core/parser.worker.js");

    const diagnostic = await runMarkdownRuntimeDiagnostic();
    expect(diagnostic.ok).toBe(true);
    expect(diagnostic.probes).toEqual([
      expect.objectContaining({ filetype: "markdown", error: undefined, highlights: expect.objectContaining({ count: expect.any(Number) }) }),
      expect.objectContaining({ filetype: "typescript", error: undefined, highlights: expect.objectContaining({ count: expect.any(Number) }) }),
    ]);
    expect(diagnostic.probes.every((probe) => probe.highlights.count > 0)).toBe(true);
    expect(diagnostic.escape).toEqual({ ok: true, concealedCount: 2 });
    expect(diagnostic.native).toEqual(
      expect.objectContaining({
        ok: true,
        source: "asset-table",
        key: expect.stringMatching(
          process.platform === "darwin" ? /^@opentui\/core-darwin-/ : /^@3akhp\/opentui-core-/,
        ),
        path: expect.any(String),
      }),
    );
    expect(diagnostic.selection.ok).toBe(true);
    expect(diagnostic.selection.cases).toEqual([
      expect.objectContaining({ name: "prose", ok: true, selectedText: expect.stringContaining("alpha") }),
      expect.objectContaining({ name: "list", ok: true, selectedText: expect.stringContaining("beta") }),
      expect.objectContaining({ name: "link", ok: true, selectedText: expect.stringContaining("epsilon") }),
      expect.objectContaining({ name: "fenced-code", ok: true, selectedText: expect.stringContaining("gamma") }),
      expect.objectContaining({ name: "table-cell", ok: true, selectedText: expect.stringContaining("delta") }),
    ]);
  });
});

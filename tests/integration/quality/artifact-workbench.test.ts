import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { artifactRoots, previewArtifactContent, scanArtifacts, sortArtifacts } from "../../../src/core/artifacts/workbench";
import {
  artifactRoots as projectArtifactRoots,
  modelWritableRoots,
  projectContentRoots,
  scratchRoots,
  sourceRoots,
} from "../../../src/core/project/roots";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact workbench", () => {
  test("classifies source, artifact, scratch, content, and model-writable roots distinctly", () => {
    expect(sourceRoots).toEqual(["source_materials"]);
    expect(artifactRoots).toEqual(["workspace", "novels", "reports", "test_runs"]);
    expect(projectArtifactRoots).toEqual(["workspace", "novels", "reports", "test_runs"]);
    expect(scratchRoots).toEqual(["tmp"]);
    expect(projectContentRoots).toEqual(["source_materials", "workspace", "novels", "reports", "test_runs"]);
    expect(modelWritableRoots).toEqual(["source_materials", "workspace", "novels", "reports", "test_runs", "tmp"]);
  });

  test("preserves document structure in bounded message-stream previews", () => {
    const content = "---\nname: Mira\n---\n\n## Biography\n\nKeeps paragraph structure.";
    expect(previewArtifactContent(content)).toEqual({ preview: content, truncated: false });
  });

  test("marks previews truncated after the line budget", () => {
    const content = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = previewArtifactContent(content);
    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("line 80");
    expect(result.preview).not.toContain("line 81");
  });

  test("scans the fixed artifact roots and ignores gitkeep stubs", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-artifacts-"));
    roots.push(root);
    await mkdir(join(root, "workspace", "cards"), { recursive: true });
    await mkdir(join(root, "reports"), { recursive: true });
    await mkdir(join(root, "source_materials"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    await writeFile(join(root, "workspace", ".gitkeep"), "", "utf8");
    await writeFile(join(root, "workspace", "cards", "mira.md"), "# Mira", "utf8");
    await writeFile(join(root, "reports", "audit.md"), "# Audit", "utf8");
    await writeFile(join(root, "source_materials", "research.md"), "# Research", "utf8");
    await writeFile(join(root, "tmp", "scratch-draft.md"), "# Draft", "utf8");

    const entries = await scanArtifacts(root);
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "reports/audit.md",
      "workspace/cards/mira.md",
    ]);
    expect(entries.some((entry) => entry.path.startsWith("tmp/"))).toBe(false);
  });

  test("orders numeric selection by fixed root, then newest file within each root", () => {
    const entries = sortArtifacts([
      { path: "reports/audit.md", updatedAt: "2026-07-10T05:00:00.000Z" },
      { path: "workspace/older.md", updatedAt: "2026-07-10T01:00:00.000Z" },
      { path: "test_runs/run.md", updatedAt: "2026-07-10T06:00:00.000Z" },
      { path: "workspace/newer.md", updatedAt: "2026-07-10T04:00:00.000Z" },
      { path: "novels/chapter.md", updatedAt: "2026-07-10T02:00:00.000Z" },
    ]);

    expect(entries.map((entry) => entry.path)).toEqual([
      "workspace/newer.md",
      "workspace/older.md",
      "novels/chapter.md",
      "reports/audit.md",
      "test_runs/run.md",
    ]);
  });
});

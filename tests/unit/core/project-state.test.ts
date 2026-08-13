import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeProjectStateBlock } from "../../../src/core/prompt/project-state";
import { AssetResolver } from "../../../src/core/runtime/assets";

describe("project-state orientation", () => {
  test("reports only bounded logical root state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-project-state-"));
    const outside = await mkdtemp(join(tmpdir(), "vesicle-project-state-outside-"));
    try {
      await mkdir(join(root, "workspace", "nested"), { recursive: true });
      await mkdir(join(root, "source_materials"), { recursive: true });
      await mkdir(join(root, "reports", "empty-directory"), { recursive: true });
      await mkdir(join(root, ".vesicle"), { recursive: true });
      await writeFile(join(root, "workspace", "nested", "draft.md"), "draft", "utf8");
      await writeFile(join(root, "source_materials", ".gitkeep"), "", "utf8");
      await writeFile(join(root, ".vesicle", "session.jsonl"), "private", "utf8");
      await writeFile(join(outside, "secret.md"), "secret", "utf8");
      await symlink(outside, join(root, "workspace", "linked"), "dir");

      const block = await composeProjectStateBlock(root, new AssetResolver(root, { includeOverrides: false }));

      expect(block).toContain("<project_state>");
      expect(block).toContain("workspace: 1 file");
      expect(block).toContain("source_materials: empty (0 files)");
      expect(block).toContain("reports: 0 files (contains directories or other entries)");
      expect(block).toContain("list_directory with path '.'");
      expect(block).toContain("VESICLE.md");
      expect(block).not.toContain(root);
      expect(block).not.toContain(outside);
      expect(block).not.toContain(".vesicle");
      expect(block).not.toContain("session.jsonl");
      expect(block).not.toContain("secret.md");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("caps directory traversal even when a tree contains no files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-project-state-cap-"));
    try {
      await Promise.all(Array.from({ length: 300 }, (_, index) =>
        mkdir(join(root, "workspace", `empty-${index}`), { recursive: true })));
      const block = await composeProjectStateBlock(root, new AssetResolver(root, { includeOverrides: false }));
      expect(block).toContain("workspace: 0 observed files (scan truncated)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

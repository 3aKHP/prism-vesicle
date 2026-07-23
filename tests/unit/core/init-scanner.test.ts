import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../../../src/core/init";

describe("init scanner", () => {
  test("lists files under the writable roots with short text heads", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-"));
    try {
      await mkdir(join(root, "workspace", "cards"), { recursive: true });
      await writeFile(join(root, "workspace", "cards", "hero.md"), "# Hero\nbrave and bold", "utf8");
      await mkdir(join(root, "source_materials"), { recursive: true });
      await writeFile(join(root, "source_materials", "notes.txt"), "setting notes here", "utf8");
      await mkdir(join(root, "novels"), { recursive: true });
      const digest = await scanProject(root);
      expect(digest).toContain("workspace/");
      expect(digest).toContain("cards/hero.md");
      expect(digest).toContain("brave and bold");
      expect(digest).toContain("source_materials/");
      expect(digest).toContain("setting notes");
      expect(digest).toContain("novels/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("notes when a VESICLE.md already exists at the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-exists-"));
    try {
      await writeFile(join(root, "VESICLE.md"), "existing rules", "utf8");
      const digest = await scanProject(root);
      expect(digest).toContain("already exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips non-text files without reading their heads", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-binary-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(join(root, "workspace", "card.md"), "# Card", "utf8");
      const digest = await scanProject(root);
      expect(digest).toContain("image.png");
      // The markdown file gets a quoted head; the PNG (non-text) does not.
      const mdLine = digest.split("\n").find((line) => line.includes("card.md"));
      const pngLine = digest.split("\n").find((line) => line.includes("image.png"));
      expect(mdLine).toBeDefined();
      expect(pngLine).toBeDefined();
      expect(mdLine!.includes('"')).toBe(true);
      expect(pngLine!.includes('"')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

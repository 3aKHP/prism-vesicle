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

  test("caps files per root and reports the remainder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-filecap-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      for (let i = 0; i < 70; i++) {
        await writeFile(join(root, "workspace", `f${i}.md`), `file ${i}`, "utf8");
      }
      const digest = await scanProject(root);
      // MAX_FILES_PER_ROOT (60) caps the listing; the overflow is reported.
      expect(digest).toContain("more file");
      const listed = digest.match(/- workspace\/f\d+\.md/g) ?? [];
      expect(listed.length).toBeLessThanOrEqual(60);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps the total digest byte size", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-bytecap-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      // 40 files with >240-byte heads would exceed 8 KiB without the cap.
      for (let i = 0; i < 40; i++) {
        await writeFile(join(root, "workspace", `big${i}.md`), `${"word ".repeat(80)}${i}`, "utf8");
      }
      const digest = await scanProject(root);
      expect(digest.length).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never reads project-root config or .vesicle state (path confinement)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-init-scan-canary-"));
    try {
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace", "card.md"), "CARD-MARKER", "utf8");
      // Canary files OUTSIDE the writable roots that must never reach the digest.
      await writeFile(join(root, "providers.yaml"), "SECRET-PROVIDER-KEY\n", "utf8");
      await writeFile(join(root, ".env"), "SECRET-ENV-KEY\n", "utf8");
      await mkdir(join(root, ".vesicle"), { recursive: true });
      await writeFile(join(root, ".vesicle", "state.json"), "SECRET-STATE\n", "utf8");
      const digest = await scanProject(root);
      expect(digest).toContain("CARD-MARKER");
      expect(digest).not.toContain("SECRET-PROVIDER-KEY");
      expect(digest).not.toContain("SECRET-ENV-KEY");
      expect(digest).not.toContain("SECRET-STATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

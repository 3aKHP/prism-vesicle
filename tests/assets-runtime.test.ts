import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { initializeEditableAssets } from "../src/cli/assets";
import { resolveAssetsRoot } from "../src/core/runtime/assets";

describe("runtime assets", () => {
  test("falls back to package assets and can materialize an editable project override", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vesicle-assets-"));
    try {
      expect(resolveAssetsRoot(rootDir)).toBe(process.cwd());

      await initializeEditableAssets(rootDir);
      expect(resolveAssetsRoot(rootDir)).toBe(rootDir);
      expect(await Bun.file(join(rootDir, "assets", "manifest.json")).exists()).toBe(true);
      await expect(initializeEditableAssets(rootDir)).rejects.toThrow("Refusing to overwrite existing editable assets");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

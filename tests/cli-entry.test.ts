import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("CLI entrypoint", () => {
  test("loads OpenTUI preload before importing the TUI", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "cli", "main.ts"), "utf8");
    const preloadIndex = source.indexOf('await import("@opentui/solid/preload")');
    const tuiIndex = source.indexOf('await import("../tui")');

    expect(source).not.toMatch(/import\s+\{\s*runTui\s*\}\s+from\s+["']\.\.\/tui["']/);
    expect(preloadIndex).toBeGreaterThanOrEqual(0);
    expect(tuiIndex).toBeGreaterThan(preloadIndex);
  });
});

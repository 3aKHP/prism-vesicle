import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// OpenTUI requires its preload to run before the Solid/TUI module is imported;
// violating this order crashes the TUI at startup. This ordering cannot be
// exercised in-process without a native TUI launch, so it is held as a static
// guard here until the Phase 7 native TUI smoke can assert it behaviourally.
// The standalone-build cwd invariant (main.ts never calls process.chdir) is
// covered by the launch cwd assertion in setup-launch.test.ts instead.
describe("CLI entrypoint", () => {
  test("loads OpenTUI preload before importing the TUI", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "cli", "main.ts"), "utf8");
    const preloadIndex = source.indexOf('await import("@opentui/solid/preload")');
    const tuiIndex = source.indexOf('await import("../tui")');

    expect(source).not.toMatch(/import\s+\{\s*runTui\s*\}\s+from\s+["']\.\.\/tui["']/);
    expect(preloadIndex).toBeGreaterThanOrEqual(0);
    expect(tuiIndex).toBeGreaterThan(preloadIndex);
  });
});

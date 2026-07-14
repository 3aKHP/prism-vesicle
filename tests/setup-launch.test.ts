import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("guided Setup launch boundary", () => {
  test("launches a fresh process instead of stealing the Setup process cwd", async () => {
    const main = await readFile(join(import.meta.dir, "..", "src", "cli", "main.ts"), "utf8");
    const launch = await readFile(join(import.meta.dir, "..", "src", "cli", "launch.ts"), "utf8");
    expect(main).not.toContain("process.chdir(");
    expect(main).toContain("launchVesicleInProject");
    expect(main).toContain('case "launch"');
    expect(main).toContain("readSetupState");
    expect(launch).toContain("cwd: projectDirectory");
    expect(launch).toContain("stdin: \"inherit\"");
  });
});

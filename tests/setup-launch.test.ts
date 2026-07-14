import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDirectory } from "../src/cli/project-target";

describe("guided Setup launch boundary", () => {
  test("launches a fresh process instead of stealing the Setup process cwd", async () => {
    const main = await readFile(join(import.meta.dir, "..", "src", "cli", "main.ts"), "utf8");
    const launch = await readFile(join(import.meta.dir, "..", "src", "cli", "launch.ts"), "utf8");
    expect(main).not.toContain("process.chdir(");
    expect(main).toContain("launchVesicleInProject");
    expect(main).toContain('case "launch"');
    expect(main).not.toContain("readSetupState");
    expect(main).toContain("launchProjectArgument(command)");
    expect(launch).toContain("cwd: projectDirectory");
    expect(launch).toContain("stdin: \"inherit\"");
    expect(launch).toContain("...args");
  });

  test("resolves dot and explicit directories without accepting files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-project-target-"));
    try {
      const child = join(root, "project");
      await Bun.write(join(child, ".gitkeep"), "");
      await writeFile(join(root, "not-a-project.txt"), "file", "utf8");
      expect(await resolveProjectDirectory(".", child)).toBe(child);
      expect(await resolveProjectDirectory("project", root)).toBe(child);
      await expect(resolveProjectDirectory("missing", root)).rejects.toThrow("does not exist");
      await expect(resolveProjectDirectory("not-a-project.txt", root)).rejects.toThrow("not a directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

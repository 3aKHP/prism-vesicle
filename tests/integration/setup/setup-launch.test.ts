import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDirectory } from "../../../src/cli/project-target";

describe("guided Setup launch boundary", () => {
  test("launches a fresh process with the project directory as cwd instead of stealing the Setup cwd", async () => {
    const main = await readFile(join(import.meta.dir, "..", "..", "..", "src", "cli", "main.ts"), "utf8");
    const launch = await readFile(join(import.meta.dir, "..", "..", "..", "src", "cli", "launch.ts"), "utf8");
    expect(main).not.toContain("process.chdir(");
    expect(launch).toContain("cwd: projectDirectory");
  });

  test("resolves dot and explicit directories without accepting files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-project-target-"));
    try {
      const child = join(root, "project");
      await mkdir(child);
      await writeFile(join(root, "not-a-project.txt"), "file", "utf8");
      expect(await resolveProjectDirectory(".", child)).toBe(child);
      expect(await resolveProjectDirectory("project", root)).toBe(child);
      await expect(resolveProjectDirectory("missing", root)).rejects.toThrow("does not exist");
      await expect(resolveProjectDirectory("not-a-project.txt", root)).rejects.toThrow("not a directory");
      await expect(resolveProjectDirectory("   ", root)).rejects.toThrow("Project directory is required");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports invalid project arguments once without leaking a runtime stack", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-project-cli-"));
    try {
      const main = join(import.meta.dir, "..", "..", "..", "src", "cli", "main.ts");
      const missing = join(root, "missing");
      for (const args of [["launch", missing], [missing], ["launch", "   "]]) {
        const child = Bun.spawn([process.execPath, main, ...args], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr.match(/Project directory/g)).toHaveLength(1);
        expect(stderr).not.toContain("Unknown command");
        expect(stderr).not.toContain("Bun v");
        expect(stderr).not.toContain("src/cli/project-target.ts");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

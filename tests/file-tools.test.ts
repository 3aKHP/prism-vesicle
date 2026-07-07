import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeFileTool } from "../src/core/tools";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vesicle-file-tools-"));
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await mkdir(join(rootDir, "reports"), { recursive: true });
  await mkdir(join(rootDir, "source_materials"), { recursive: true });
  await writeFile(join(rootDir, "source_materials", "seed.md"), "Alpha seed\nBeta seed\n", "utf8");
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("file tools v2", () => {
  test("supports create, ranged read, exact replace, append, grep, stat, copy, move, and delete", async () => {
    await expectTool("create_file", {
      path: "workspace/a.md",
      content: "alpha\nbeta\nalpha",
    }, "Created workspace/a.md");

    await expectToolFailure("create_file", {
      path: "workspace/a.md",
      content: "duplicate",
    }, "EEXIST");

    await expectTool("read_file", {
      path: "workspace/a.md",
      startLine: 2,
      endLine: 2,
    }, "beta");

    await expectToolFailure("replace_in_file", {
      path: "workspace/a.md",
      oldText: "alpha",
      newText: "gamma",
    }, "matched 2 times");

    await expectTool("replace_in_file", {
      path: "workspace/a.md",
      oldText: "alpha",
      newText: "gamma",
      replaceAll: true,
    }, "Replaced 2 occurrence(s) in workspace/a.md");

    await expectTool("append_file", {
      path: "workspace/a.md",
      content: "\nend",
    }, "Appended 4 char(s) to workspace/a.md");

    const statResult = await executeFileTool(rootDir, call("stat_path", { path: "workspace/a.md" }));
    expect(statResult.ok).toBe(true);
    expect(JSON.parse(statResult.content)).toMatchObject({
      path: "workspace/a.md",
      type: "file",
    });

    const grepResult = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "gamma",
      maxMatches: 10,
    }));
    expect(grepResult.ok).toBe(true);
    expect(JSON.parse(grepResult.content)).toMatchObject({
      matches: [
        { path: "workspace/a.md", line: 1, text: "gamma" },
        { path: "workspace/a.md", line: 3, text: "gamma" },
      ],
      truncated: false,
    });

    await expectTool("copy_file", {
      sourcePath: "workspace/a.md",
      targetPath: "reports/b.md",
    }, "Copied workspace/a.md to reports/b.md");
    expect(await readFile(join(rootDir, "reports", "b.md"), "utf8")).toContain("gamma");

    await expectTool("move_file", {
      sourcePath: "reports/b.md",
      targetPath: "workspace/c.md",
    }, "Moved reports/b.md to workspace/c.md");

    await expectTool("delete_file", {
      path: "workspace/c.md",
    }, "Deleted workspace/c.md");
  });

  test("keeps write operations inside artifact roots and refuses risky deletes", async () => {
    await expectToolFailure("write_file", {
      path: "assets/leak.md",
      content: "nope",
    }, "Path must be under one of");

    await expectToolFailure("delete_file", {
      path: "workspace",
    }, "Path must be a file");

    await expectToolFailure("move_file", {
      sourcePath: "source_materials/seed.md",
      targetPath: "workspace/seed.md",
    }, "Path must be under one of");

    await expectTool("copy_file", {
      sourcePath: "source_materials/seed.md",
      targetPath: "workspace/seed.md",
    }, "Copied source_materials/seed.md to workspace/seed.md");
  });

  test("append_file requires an existing file unless createIfMissing is set", async () => {
    await expectToolFailure("append_file", {
      path: "workspace/missing.md",
      content: "tail",
    }, "ENOENT");

    await expectTool("append_file", {
      path: "workspace/missing.md",
      content: "tail",
      createIfMissing: true,
    }, "Appended 4 char(s) to workspace/missing.md");

    expect(await readFile(join(rootDir, "workspace", "missing.md"), "utf8")).toBe("tail");
  });
});

async function expectTool(name: string, args: Record<string, unknown>, content: string): Promise<void> {
  const result = await executeFileTool(rootDir, call(name, args));
  expect(result.ok).toBe(true);
  expect(result.content).toBe(content);
}

async function expectToolFailure(name: string, args: Record<string, unknown>, content: string): Promise<void> {
  const result = await executeFileTool(rootDir, call(name, args));
  expect(result.ok).toBe(false);
  expect(result.content).toContain(content);
}

function call(name: string, args: Record<string, unknown>) {
  return {
    id: `call-${name}`,
    name,
    arguments: JSON.stringify(args),
  };
}

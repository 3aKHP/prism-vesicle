import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeFileTool } from "../src/core/tools";
import type { ToolResult } from "../src/core/tools";

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
    const createResult = await expectTool("create_file", {
      path: "workspace/a.md",
      content: "alpha\nbeta\nalpha",
    }, "Created workspace/a.md");
    expect(createResult.fileEvent).toMatchObject({
      operation: "create",
      path: "workspace/a.md",
      changed: true,
      bytes: 16,
    });

    await expectToolFailure("create_file", {
      path: "workspace/a.md",
      content: "duplicate",
    }, "EEXIST");

    const readResult = await expectTool("read_file", {
      path: "workspace/a.md",
      startLine: 2,
      endLine: 2,
    }, "beta");
    expect(readResult.fileEvent).toMatchObject({
      operation: "read",
      path: "workspace/a.md",
      changed: false,
      bytes: 4,
      lines: 1,
    });

    await expectToolFailure("replace_in_file", {
      path: "workspace/a.md",
      oldText: "alpha",
      newText: "gamma",
    }, "matched 2 times");

    const replaceResult = await expectTool("replace_in_file", {
      path: "workspace/a.md",
      oldText: "alpha",
      newText: "gamma",
      replaceAll: true,
    }, "Replaced 2 occurrence(s) in workspace/a.md");
    expect(replaceResult.fileEvent).toMatchObject({
      operation: "replace",
      path: "workspace/a.md",
      changed: true,
      bytes: 16,
      occurrences: 2,
    });

    const appendResult = await expectTool("append_file", {
      path: "workspace/a.md",
      content: "\nend",
    }, "Appended 4 char(s) to workspace/a.md");
    expect(appendResult.fileEvent).toMatchObject({
      operation: "append",
      path: "workspace/a.md",
      changed: true,
      bytes: 20,
      deltaBytes: 4,
    });

    const statResult = await executeFileTool(rootDir, call("stat_path", { path: "workspace/a.md" }));
    expect(statResult.ok).toBe(true);
    expect(statResult.fileEvent).toMatchObject({
      kind: "file_operation",
      operation: "stat",
      path: "workspace/a.md",
      changed: false,
    });
    expect(JSON.parse(statResult.content)).toMatchObject({
      path: "workspace/a.md",
      type: "file",
    });

    const listResult = await executeFileTool(rootDir, call("list_files", { path: "workspace" }));
    expect(listResult.ok).toBe(true);
    expect(listResult.fileEvent).toMatchObject({
      kind: "file_operation",
      operation: "list",
      path: "workspace",
      changed: false,
      entryCount: 1,
    });

    const grepResult = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "gamma",
      maxMatches: 10,
    }));
    expect(grepResult.ok).toBe(true);
    expect(grepResult.fileEvent).toMatchObject({
      kind: "file_operation",
      operation: "grep",
      path: "workspace",
      matches: 2,
      changed: false,
    });
    expect(JSON.parse(grepResult.content)).toMatchObject({
      matches: [
        { path: "workspace/a.md", line: 1, text: "gamma" },
        { path: "workspace/a.md", line: 3, text: "gamma" },
      ],
      truncated: false,
    });

    const copyResult = await expectTool("copy_file", {
      sourcePath: "workspace/a.md",
      targetPath: "reports/b.md",
    }, "Copied workspace/a.md to reports/b.md");
    expect(copyResult.fileEvent).toMatchObject({
      operation: "copy",
      sourcePath: "workspace/a.md",
      targetPath: "reports/b.md",
      changed: true,
      bytes: 20,
    });
    expect(await readFile(join(rootDir, "reports", "b.md"), "utf8")).toContain("gamma");

    const moveResult = await expectTool("move_file", {
      sourcePath: "reports/b.md",
      targetPath: "workspace/c.md",
    }, "Moved reports/b.md to workspace/c.md");
    expect(moveResult.fileEvent).toMatchObject({
      operation: "move",
      sourcePath: "reports/b.md",
      targetPath: "workspace/c.md",
      changed: true,
      bytes: 20,
    });

    const deleteResult = await expectTool("delete_file", {
      path: "workspace/c.md",
    }, "Deleted workspace/c.md");
    expect(deleteResult.fileEvent).toMatchObject({
      operation: "delete",
      path: "workspace/c.md",
      changed: true,
      bytes: 20,
    });
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

    await expectToolFailure("delete_file", {
      path: "workspace/nope.md",
    }, "ENOENT");
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

    await expectTool("append_file", {
      path: "workspace/nested/new.md",
      content: "nested",
      createIfMissing: true,
    }, "Appended 6 char(s) to workspace/nested/new.md");
    expect(await readFile(join(rootDir, "workspace", "nested", "new.md"), "utf8")).toBe("nested");
  });

  test("handles literal replacement text, regex grep, overwrite paths, and validation edges", async () => {
    await expectTool("create_file", {
      path: "workspace/edge.md",
      content: "PRICE\nAlpha\nalpha\nBeta42",
    }, "Created workspace/edge.md");

    await expectTool("replace_in_file", {
      path: "workspace/edge.md",
      oldText: "PRICE",
      newText: "Price: $50 and $&",
    }, "Replaced 1 occurrence(s) in workspace/edge.md");
    expect(await readFile(join(rootDir, "workspace", "edge.md"), "utf8")).toContain("Price: $50 and $&");

    await expectToolFailure("replace_in_file", {
      path: "workspace/edge.md",
      oldText: "",
      newText: "x",
    }, "oldText must not be empty");

    const regexResult = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/edge.md",
      pattern: "^Alpha$",
      regex: true,
      caseSensitive: true,
    }));
    expect(regexResult.ok).toBe(true);
    expect(JSON.parse(regexResult.content)).toMatchObject({
      matches: [{ path: "workspace/edge.md", line: 2, text: "Alpha" }],
      truncated: false,
    });

    const dirStat = await executeFileTool(rootDir, call("stat_path", { path: "workspace" }));
    expect(dirStat.ok).toBe(true);
    expect(JSON.parse(dirStat.content)).toMatchObject({ path: "workspace", type: "directory" });

    await expectToolFailure("read_file", {
      path: "workspace/edge.md",
      startLine: 0,
    }, "startLine must be a positive integer");
    await expectToolFailure("read_file", {
      path: "workspace/edge.md",
      startLine: 3,
      endLine: 2,
    }, "endLine must be greater than or equal to startLine");
    await expectToolFailure("read_file", {
      path: "workspace/edge.md",
      startLine: "1",
    }, "startLine must be a number");

    await expectTool("create_file", {
      path: "workspace/target.md",
      content: "old",
    }, "Created workspace/target.md");
    await expectTool("copy_file", {
      sourcePath: "workspace/edge.md",
      targetPath: "workspace/target.md",
      overwrite: true,
    }, "Copied workspace/edge.md to workspace/target.md");
    expect(await readFile(join(rootDir, "workspace", "target.md"), "utf8")).toContain("Beta42");

    await expectTool("create_file", {
      path: "reports/move-target.md",
      content: "old move",
    }, "Created reports/move-target.md");
    await expectTool("move_file", {
      sourcePath: "workspace/target.md",
      targetPath: "reports/move-target.md",
      overwrite: true,
    }, "Moved workspace/target.md to reports/move-target.md");
    expect(await readFile(join(rootDir, "reports", "move-target.md"), "utf8")).toContain("Beta42");
  });
});

async function expectTool(name: string, args: Record<string, unknown>, content: string): Promise<ToolResult> {
  const result = await executeFileTool(rootDir, call(name, args));
  expect(result.ok).toBe(true);
  expect(result.content).toBe(content);
  expect(result.fileEvent).toMatchObject({ kind: "file_operation" });
  return result;
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeFileTool } from "../src/core/tools";
import type { ToolResult } from "../src/core/tools";
import { AssetResolver } from "../src/core/runtime/assets";

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vesicle-file-tools-"));
  await mkdir(join(rootDir, "workspace"), { recursive: true });
  await mkdir(join(rootDir, "reports"), { recursive: true });
  await mkdir(join(rootDir, "source_materials"), { recursive: true });
  await writeFile(join(rootDir, "source_materials", "seed.md"), "Alpha seed\nBeta seed\n", "utf8");
  await writeFile(join(rootDir, "source_materials", "reference.png"), Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("file tools v2", () => {
  test("views guarded project images as structured attachments", async () => {
    const result = await expectTool("view_image", {
      path: "source_materials/reference.png",
      detail: "high",
    }, "Viewed source_materials/reference.png");
    expect(result.fileEvent).toMatchObject({ operation: "view", changed: false });
    expect(result.images?.[0]).toMatchObject({
      source: "project",
      sourcePath: "source_materials/reference.png",
      mediaType: "image/png",
      detail: "high",
    });
    await expectToolFailure("view_image", { path: "../reference.png" }, "escapes project root");
  });
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
      sha256: sha256("alpha\nbeta\nalpha"),
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
      sha256: sha256("gamma\nbeta\ngamma"),
      occurrences: 2,
      matchLines: [1, 3],
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
      sha256: sha256("gamma\nbeta\ngamma\nend"),
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

  test("writes source material inside writable project roots and refuses unsafe paths", async () => {
    await expectToolFailure("write_file", {
      path: "assets/leak.md",
      content: "nope",
    }, "Path must be under one of");

    await expectToolFailure("delete_file", {
      path: "workspace",
    }, "Path must be a file");

    await expectTool("copy_file", {
      sourcePath: "source_materials/seed.md",
      targetPath: "workspace/seed.md",
    }, "Copied source_materials/seed.md to workspace/seed.md");

    await expectTool("create_file", {
      path: "source_materials/generated-research.md",
      content: "Initial research",
    }, "Created source_materials/generated-research.md");

    await expectTool("append_file", {
      path: "source_materials/generated-research.md",
      content: "\nSearch capture",
    }, "Appended 15 char(s) to source_materials/generated-research.md");

    await expectTool("move_file", {
      sourcePath: "source_materials/generated-research.md",
      targetPath: "source_materials/archive/generated-research.md",
    }, "Moved source_materials/generated-research.md to source_materials/archive/generated-research.md");

    await expectToolFailure("delete_file", {
      path: "workspace/nope.md",
    }, "ENOENT");
  });

  test("creates, lists, moves, and deletes guarded directories", async () => {
    const created = await expectTool("create_directory", {
      path: "workspace/part_01/empty",
    }, "Created directory workspace/part_01/empty");
    expect(created.fileEvent).toMatchObject({
      operation: "create_directory",
      path: "workspace/part_01/empty",
      changed: true,
    });

    await expectTool("create_file", {
      path: "workspace/part_01/chapter.md",
      content: "chapter one",
    }, "Created workspace/part_01/chapter.md");

    const listed = await executeFileTool(rootDir, call("list_directory", {
      path: "workspace",
      recursive: true,
    }));
    expect(listed.ok).toBe(true);
    expect(listed.fileEvent).toMatchObject({ operation: "list_directory", entryCount: 3 });
    expect(JSON.parse(listed.content)).toMatchObject({
      entries: [
        { path: "workspace/part_01", type: "directory" },
        { path: "workspace/part_01/chapter.md", type: "file", size: 11 },
        { path: "workspace/part_01/empty", type: "directory" },
      ],
      truncated: false,
    });

    const moved = await expectTool("move_directory", {
      sourcePath: "workspace/part_01",
      targetPath: "workspace/part_02",
    }, "Moved directory workspace/part_01 to workspace/part_02");
    expect(moved.fileEvent).toMatchObject({
      operation: "move_directory",
      sourcePath: "workspace/part_01",
      targetPath: "workspace/part_02",
    });
    expect(await readFile(join(rootDir, "workspace", "part_02", "chapter.md"), "utf8")).toBe("chapter one");

    await expectToolFailure("delete_directory", {
      path: "workspace/part_02",
    }, "Directory is not empty");
    await expectTool("delete_directory", {
      path: "workspace/part_02/empty",
    }, "Deleted directory workspace/part_02/empty");
    await expectToolFailure("delete_directory", {
      path: "workspace",
    }, "Fixed writable roots");
  });

  test("rejects symbolic links in model-visible paths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vesicle-file-tools-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "outside", "utf8");
      await symlink(outside, join(rootDir, "workspace", "linked"), "dir");
      await expectToolFailure("read_file", {
        path: "workspace/linked/secret.md",
      }, "Symbolic links are not allowed");
      await expectToolFailure("create_file", {
        path: "workspace/linked/new.md",
        content: "escape",
      }, "Symbolic links are not allowed");
      expect((await stat(join(outside, "secret.md"))).isFile()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reads the merged asset namespace without exposing physical global paths", async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), "vesicle-file-tool-assets-"));
    try {
      const config = join(assetRoot, "config");
      const bundled = join(assetRoot, "bundled-assets");
      await mkdir(join(rootDir, "assets", "specs"), { recursive: true });
      await mkdir(join(config, "assets", "specs"), { recursive: true });
      await mkdir(join(bundled, "specs"), { recursive: true });
      await writeFile(join(rootDir, "assets", "specs", "project.md"), "project marker", "utf8");
      await writeFile(join(config, "assets", "specs", "global.md"), "global marker", "utf8");
      await writeFile(join(config, "assets", "specs", "global.png"), Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
      ]));
      await writeFile(join(bundled, "manifest.json"), "{}", "utf8");
      await writeFile(join(bundled, "specs", "default.md"), "default marker", "utf8");
      const assets = new AssetResolver(rootDir, {
        env: { VESICLE_CONFIG_DIR: config },
        bundledDirectory: bundled,
        executablePath: join(assetRoot, "missing", "vesicle"),
      });

      const list = await executeFileTool(rootDir, call("list_files", {
        path: "assets/specs",
        recursive: true,
      }), { assets });
      expect(list.ok).toBe(true);
      expect(list.content.split("\n")).toEqual([
        "assets/specs/default.md",
        "assets/specs/global.md",
        "assets/specs/global.png",
        "assets/specs/project.md",
      ]);
      expect(list.content).not.toContain(assetRoot);

      const read = await executeFileTool(rootDir, call("read_file", {
        path: "assets/specs/global.md",
      }), { assets });
      expect(read.ok).toBe(true);
      expect(read.content).toBe("global marker");
      expect(read.fileEvent?.path).toBe("assets/specs/global.md");

      const grep = await executeFileTool(rootDir, call("grep_files", {
        path: "assets/specs",
        pattern: "marker",
      }), { assets });
      expect(grep.ok).toBe(true);
      expect(JSON.parse(grep.content).matches).toHaveLength(3);

      const stat = await executeFileTool(rootDir, call("stat_path", {
        path: "assets/specs/global.md",
      }), { assets });
      expect(stat.ok).toBe(true);
      expect(JSON.parse(stat.content)).toMatchObject({ path: "assets/specs/global.md", type: "file" });
      expect(stat.content).not.toContain(assetRoot);

      const view = await executeFileTool(rootDir, call("view_image", {
        path: "assets/specs/global.png",
      }), { assets });
      expect(view.ok).toBe(true);
      expect(view.fileEvent?.path).toBe("assets/specs/global.png");
      expect(view.images?.[0]?.sourcePath).toBe("assets/specs/global.png");
      expect(JSON.stringify(view)).not.toContain(assetRoot);

      const copy = await executeFileTool(rootDir, call("copy_file", {
        sourcePath: "assets/specs/global.md",
        targetPath: "workspace/copied-global.md",
      }), { assets });
      expect(copy.ok).toBe(true);
      expect(copy.fileEvent?.sourcePath).toBe("assets/specs/global.md");
      expect(await readFile(join(rootDir, "workspace", "copied-global.md"), "utf8")).toBe("global marker");
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  test("replace_in_file records the affected line range for a single match", async () => {
    await writeFile(join(rootDir, "workspace", "lines.md"), "one\ntwo\nthree\nfour\n", "utf8");
    const result = await expectTool("replace_in_file", {
      path: "workspace/lines.md",
      oldText: "two\nthree",
      newText: "TWO\nTHREE\nTHREE-B",
    }, "Replaced 1 occurrence(s) in workspace/lines.md");
    expect(result.fileEvent).toMatchObject({
      operation: "replace",
      occurrences: 1,
      matchLines: [2],
    });
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

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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

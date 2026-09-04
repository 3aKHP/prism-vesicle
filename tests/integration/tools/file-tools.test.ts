import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { executeFileTool } from "../../../src/core/tools";
import type { ToolResult } from "../../../src/core/tools";
import { AssetResolver } from "../../../src/core/runtime/assets";
import { buildCatalog, loadSkill } from "../../../src/skills";
import type { LoadedSkill } from "../../../src/skills";
import { recordActivation, SkillMount } from "../../../src/core/skills";
import type { ResolvedSkillCatalog } from "../../../src/core/skills";
import { symlinkCapable } from "../../support/symlink-capability";

let rootDir = "";
let skillScratch = "";
let skillSessionId = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vesicle-file-tools-"));
  skillScratch = await mkdtemp(join(tmpdir(), "vesicle-file-tools-skills-"));
  skillSessionId = randomUUID();
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
  await rm(skillScratch, { recursive: true, force: true });
});

describe("file tools v2", () => {
  test("orients at the virtual root without exposing host project files", async () => {
    await writeFile(join(rootDir, "package.json"), "{}", "utf8");
    await mkdir(join(rootDir, ".vesicle"), { recursive: true });

    const result = await executeFileTool(rootDir, call("list_directory", { path: "." }));

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      path: ".",
      status: "ok",
      detail: "full",
      entries: [
        { path: "assets", type: "directory", readOnly: true },
        { path: "source_materials", type: "directory" },
        { path: "workspace", type: "directory" },
        { path: "novels", type: "directory" },
        { path: "reports", type: "directory" },
        { path: "test_runs", type: "directory" },
        { path: "tmp", type: "directory" },
      ],
      fileCount: 0,
      directoryCount: 7,
      otherCount: 0,
      empty: false,
      truncated: false,
    });
    expect(result.content).not.toContain("package.json");
    expect(result.content).not.toContain(".vesicle");
  });

  test("returns typed observations for missing and non-directory paths", async () => {
    await writeFile(join(rootDir, "workspace", "file.md"), "body", "utf8");

    const missingStat = await executeFileTool(rootDir, call("stat_path", { path: "workspace/missing.md" }));
    expect(missingStat.ok).toBe(true);
    expect(JSON.parse(missingStat.content)).toEqual({ path: "workspace/missing.md", type: "not_found" });

    const nestedBelowFile = await executeFileTool(rootDir, call("stat_path", { path: "workspace/file.md/child" }));
    expect(nestedBelowFile.ok).toBe(true);
    expect(JSON.parse(nestedBelowFile.content)).toEqual({ path: "workspace/file.md/child", type: "not_found" });

    const missingList = await executeFileTool(rootDir, call("list_directory", { path: "workspace/missing" }));
    expect(missingList.ok).toBe(true);
    expect(JSON.parse(missingList.content)).toMatchObject({ status: "not_found", entries: [] });

    const fileList = await executeFileTool(rootDir, call("list_directory", { path: "workspace/file.md" }));
    expect(fileList.ok).toBe(true);
    expect(JSON.parse(fileList.content)).toMatchObject({ status: "not_directory", entries: [] });

    await expectToolFailure("stat_path", { path: "VESICLE.md" }, "host-managed Persistent Instruction");
    await expectToolFailure("stat_path", { path: "../outside" }, "escapes project root");
  });

  test("bounds recursive full and names listings across directory-only trees", async () => {
    await Promise.all(Array.from({ length: 2_100 }, (_, index) =>
      mkdir(join(rootDir, "workspace", `empty-${index}`), { recursive: true })));

    const full = await executeFileTool(rootDir, call("list_directory", { path: "workspace", recursive: true }));
    const names = await executeFileTool(rootDir, call("list_directory", { path: "workspace", recursive: true, detail: "names" }));

    expect(full.ok).toBe(true);
    expect(names.ok).toBe(true);
    expect(JSON.parse(full.content).truncated).toBe(true);
    expect(JSON.parse(names.content).truncated).toBe(true);
  });

  test("names mode distinguishes an empty directory from one containing only directories", async () => {
    await mkdir(join(rootDir, "workspace", "nested"), { recursive: true });

    const root = JSON.parse((await executeFileTool(rootDir, call("list_directory", {
      path: "workspace",
      detail: "names",
    }))).content);
    const nested = JSON.parse((await executeFileTool(rootDir, call("list_directory", {
      path: "workspace/nested",
      detail: "names",
    }))).content);

    expect(root).toMatchObject({ entries: [], fileCount: 0, directoryCount: 1, empty: false });
    expect(nested).toMatchObject({ entries: [], fileCount: 0, directoryCount: 0, empty: true });
  });

  test.skipIf(!symlinkCapable)("does not report a directory containing only a symlink as empty", async () => {
    await symlink(join(rootDir, "source_materials", "seed.md"), join(rootDir, "workspace", "linked.md"));

    const listed = JSON.parse((await executeFileTool(rootDir, call("list_directory", {
      path: "workspace",
    }))).content);

    expect(listed).toMatchObject({ fileCount: 0, directoryCount: 0, otherCount: 1, empty: false });
    expect(listed.entries).toContainEqual(expect.objectContaining({ path: "workspace/linked.md", type: "symlink" }));
  });

  test("continues scanning root siblings after one recursive branch reaches max depth", async () => {
    let deep = join(rootDir, "workspace", "a-deep");
    for (let depth = 0; depth < 10; depth++) {
      deep = join(deep, `level-${depth}`);
      await mkdir(deep, { recursive: true });
    }
    await writeFile(join(rootDir, "workspace", "z-visible.md"), "visible", "utf8");

    const listed = JSON.parse((await executeFileTool(rootDir, call("list_directory", {
      path: "workspace",
      recursive: true,
      detail: "names",
    }))).content);

    expect(listed.truncated).toBe(true);
    expect(listed.entries).toContain("workspace/z-visible.md");
  });

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

    const listResult = await executeFileTool(rootDir, call("list_directory", { path: "workspace", detail: "names" }));
    expect(listResult.ok).toBe(true);
    expect(listResult.fileEvent).toMatchObject({
      kind: "file_operation",
      operation: "list_directory",
      path: "workspace",
      changed: false,
      entryCount: 1,
    });
    expect(JSON.parse(listResult.content)).toMatchObject({
      path: "workspace",
      status: "ok",
      detail: "names",
      entries: ["workspace/a.md"],
      fileCount: 1,
      directoryCount: 0,
      empty: false,
      truncated: false,
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
      path: "workspace",
      status: "ok",
      detail: "full",
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

  test("treats project-relative tmp/ as a guarded scratch root", async () => {
    await expectTool("create_directory", {
      path: "tmp/skillify/example",
    }, "Created directory tmp/skillify/example");

    await expectTool("create_file", {
      path: "tmp/skillify/example/SKILL.md",
      content: "# Scratch Skill\nknown-marker-line\n",
    }, "Created tmp/skillify/example/SKILL.md");

    const read = await expectTool("read_file", {
      path: "tmp/skillify/example/SKILL.md",
    }, "# Scratch Skill\nknown-marker-line\n");
    expect(read.fileEvent).toMatchObject({
      operation: "read",
      path: "tmp/skillify/example/SKILL.md",
      changed: false,
    });

    const grep = await executeFileTool(rootDir, call("grep_files", {
      path: "tmp/skillify",
      pattern: "known-marker-line",
    }));
    expect(grep.ok).toBe(true);
    expect(JSON.parse(grep.content)).toMatchObject({
      matches: [{ path: "tmp/skillify/example/SKILL.md", line: 2, text: "known-marker-line" }],
      truncated: false,
    });

    await expectTool("copy_file", {
      sourcePath: "tmp/skillify/example/SKILL.md",
      targetPath: "workspace/copied-skill.md",
    }, "Copied tmp/skillify/example/SKILL.md to workspace/copied-skill.md");
    expect(await readFile(join(rootDir, "workspace", "copied-skill.md"), "utf8")).toContain("known-marker-line");

    await expectTool("copy_file", {
      sourcePath: "workspace/copied-skill.md",
      targetPath: "tmp/skillify/copied-back.md",
    }, "Copied workspace/copied-skill.md to tmp/skillify/copied-back.md");

    await expectTool("move_file", {
      sourcePath: "tmp/skillify/copied-back.md",
      targetPath: "reports/scratch-note.md",
    }, "Moved tmp/skillify/copied-back.md to reports/scratch-note.md");

    await expectTool("delete_file", {
      path: "tmp/skillify/example/SKILL.md",
    }, "Deleted tmp/skillify/example/SKILL.md");

    await expectToolFailure("delete_directory", {
      path: "tmp",
    }, "Fixed writable roots");

    await expectToolFailure("read_file", {
      path: "/tmp/host-secret",
    }, "Only project-relative paths are allowed");
  });

  test.skipIf(!symlinkCapable)("rejects symbolic links below the project tmp/ scratch root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "vesicle-file-tools-outside-"));
    try {
      await mkdir(join(rootDir, "tmp"), { recursive: true });
      await writeFile(join(outside, "secret.md"), "outside", "utf8");
      await symlink(outside, join(rootDir, "tmp", "linked"), "dir");
      await expectToolFailure("read_file", {
        path: "tmp/linked/secret.md",
      }, "Symbolic links are not allowed");
      expect((await stat(join(outside, "secret.md"))).isFile()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(!symlinkCapable)("rejects symbolic links in model-visible paths", async () => {
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

      const list = await executeFileTool(rootDir, call("list_directory", {
        path: "assets/specs",
        recursive: true,
        detail: "names",
      }), { assets });
      expect(list.ok).toBe(true);
      expect(JSON.parse(list.content).entries).toEqual([
        "assets/specs/default.md",
        "assets/specs/global.md",
        "assets/specs/global.png",
        "assets/specs/project.md",
      ]);
      expect(list.content).not.toContain(assetRoot);

      const fullList = await executeFileTool(rootDir, call("list_directory", {
        path: "assets/specs",
        recursive: true,
      }), { assets });
      expect(fullList.ok).toBe(true);
      const full = JSON.parse(fullList.content);
      expect(full).toMatchObject({
        path: "assets/specs",
        status: "ok",
        detail: "full",
        truncated: false,
      });
      expect(full.entries).toContainEqual(expect.objectContaining({ path: "assets/specs/default.md", type: "file", size: 14 }));
      expect(full.entries).toContainEqual(expect.objectContaining({ path: "assets/specs/project.md", type: "file", size: 14 }));
      expect(fullList.content).not.toContain(assetRoot);

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

describe("read_file bounded byte read and grep excerpt cap", () => {
  test("offsetBytes/maxBytes reads a bounded slice without a line range", async () => {
    const body = `${"x".repeat(100)}MARKER${"y".repeat(50)}`;
    await expectTool("create_file", { path: "workspace/large.txt", content: body }, "Created workspace/large.txt");
    const slice = await executeFileTool(rootDir, call("read_file", { path: "workspace/large.txt", offsetBytes: 100, maxBytes: 6 }));
    expect(slice.ok).toBe(true);
    expect(slice.content).toBe("MARKER");
    expect(slice.fileEvent).toMatchObject({ bytes: 6, truncated: true });
  });

  test("maxBytes without offset reads from the start and flags truncation", async () => {
    await expectTool("create_file", { path: "workspace/head.txt", content: "0123456789" }, "Created workspace/head.txt");
    const slice = await executeFileTool(rootDir, call("read_file", { path: "workspace/head.txt", maxBytes: 4 }));
    expect(slice.ok).toBe(true);
    expect(slice.content).toBe("0123");
    expect(slice.fileEvent).toMatchObject({ bytes: 4, truncated: true });
  });

  test("a slice covering the whole file is not truncated", async () => {
    await expectTool("create_file", { path: "workspace/small.txt", content: "abc" }, "Created workspace/small.txt");
    const slice = await executeFileTool(rootDir, call("read_file", { path: "workspace/small.txt", maxBytes: 64 }));
    expect(slice.ok).toBe(true);
    expect(slice.content).toBe("abc");
    expect(slice.fileEvent?.truncated).toBeFalsy();
  });

  test("maxBytes is rejected for the assets namespace", async () => {
    const result = await executeFileTool(rootDir, call("read_file", { path: "assets/seed.md", maxBytes: 8 }));
    expect(result.ok).toBe(false);
    expect(result.content).toContain("assets namespace");
  });

  test("offsetBytes without maxBytes is rejected (would silently return the whole file)", async () => {
    await expectTool("create_file", { path: "workspace/edge.txt", content: "data" }, "Created workspace/edge.txt");
    const result = await executeFileTool(rootDir, call("read_file", { path: "workspace/edge.txt", offsetBytes: 2 }));
    expect(result.ok).toBe(false);
    expect(result.content).toContain("offsetBytes requires maxBytes");
  });

  test("grep caps a giant single-line match", async () => {
    await expectTool("create_file", { path: "workspace/giant.txt", content: "z".repeat(2000) }, "Created workspace/giant.txt");
    const grep = await executeFileTool(rootDir, call("grep_files", { path: "workspace/giant.txt", pattern: "z" }));
    expect(grep.ok).toBe(true);
    const parsed = JSON.parse(grep.content);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0].text.length).toBeLessThan(2000);
    expect(parsed.matches[0].text).toContain("[truncated");
  });
});

describe("grep context lines and output modes", () => {
  test("contextLines returns surrounding lines for each match", async () => {
    await writeFile(join(rootDir, "workspace", "multi.md"), "line1\nline2\nMARKER\nline4\nline5\n", "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/multi.md",
      pattern: "MARKER",
      contextLines: 2,
    }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toMatchObject({ line: 3, text: "MARKER" });
    expect(parsed.matches[0].before).toEqual([
      { line: 1, text: "line1" },
      { line: 2, text: "line2" },
    ]);
    expect(parsed.matches[0].after).toEqual([
      { line: 4, text: "line4" },
      { line: 5, text: "line5" },
    ]);
  });

  test("contextLines at file boundaries yields empty before/after", async () => {
    await writeFile(join(rootDir, "workspace", "boundary.md"), "FIRST\nmiddle\nLAST\n", "utf8");

    const first = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/boundary.md",
      pattern: "FIRST",
      contextLines: 2,
    }));
    const firstParsed = JSON.parse(first.content);
    expect(firstParsed.matches[0].before).toEqual([]);
    expect(firstParsed.matches[0].after).toEqual([
      { line: 2, text: "middle" },
      { line: 3, text: "LAST" },
    ]);

    const last = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/boundary.md",
      pattern: "LAST",
      contextLines: 2,
    }));
    const lastParsed = JSON.parse(last.content);
    expect(lastParsed.matches[0].before).toEqual([
      { line: 1, text: "FIRST" },
      { line: 2, text: "middle" },
    ]);
    expect(lastParsed.matches[0].after).toEqual([]);
  });

  test("contextLines is capped at 10", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
    lines[12] = "MARKER";
    await writeFile(join(rootDir, "workspace", "cap.md"), lines.join("\n") + "\n", "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/cap.md",
      pattern: "MARKER",
      contextLines: 99,
    }));
    const parsed = JSON.parse(result.content);
    expect(parsed.matches[0].before).toHaveLength(10);
    expect(parsed.matches[0].after).toHaveLength(10);
  });

  test("outputMode files_with_matches returns only file paths", async () => {
    await writeFile(join(rootDir, "workspace", "a.md"), "alpha\n", "utf8");
    await writeFile(join(rootDir, "workspace", "b.md"), "beta\n", "utf8");
    await mkdir(join(rootDir, "workspace", "sub"), { recursive: true });
    await writeFile(join(rootDir, "workspace", "sub", "c.md"), "alpha\n", "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "alpha",
      outputMode: "files_with_matches",
    }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.outputMode).toBe("files_with_matches");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files).toContain("workspace/a.md");
    expect(parsed.files).toContain("workspace/sub/c.md");
    expect(parsed).not.toHaveProperty("matches");
    expect(result.fileEvent).toMatchObject({
      operation: "grep",
      outputMode: "files_with_matches",
      fileCount: 2,
    });
  });

  test("outputMode count returns per-file match counts", async () => {
    await writeFile(join(rootDir, "workspace", "count_a.md"), "alpha\nbeta\nalpha\n", "utf8");
    await writeFile(join(rootDir, "workspace", "count_b.md"), "alpha\n", "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "alpha",
      outputMode: "count",
    }));
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.outputMode).toBe("count");
    expect(parsed.totalMatches).toBe(3);
    expect(parsed.counts).toHaveLength(2);
    const countA = parsed.counts.find((c: { path: string }) => c.path === "workspace/count_a.md");
    expect(countA.matches).toBe(2);
    expect(result.fileEvent).toMatchObject({
      operation: "grep",
      outputMode: "count",
      matches: 3,
      fileCount: 2,
    });
  });

  test("files_with_matches respects maxMatches as file limit", async () => {
    for (const name of ["f1", "f2", "f3"]) {
      await writeFile(join(rootDir, "workspace", `${name}.md`), "target\n", "utf8");
    }
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "target",
      outputMode: "files_with_matches",
      maxMatches: 2,
    }));
    const parsed = JSON.parse(result.content);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test("count mode respects maxMatches as file limit", async () => {
    for (const name of ["f1", "f2", "f3"]) {
      await writeFile(join(rootDir, "workspace", `${name}.md`), "target\n", "utf8");
    }
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace",
      pattern: "target",
      outputMode: "count",
      maxMatches: 2,
    }));
    const parsed = JSON.parse(result.content);
    expect(parsed.counts).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  test("content mode output budget truncates before maxMatches", async () => {
    const padding = "x".repeat(300);
    const lines = Array.from({ length: 200 }, () => `MATCH${padding}`);
    await writeFile(join(rootDir, "workspace", "big.md"), lines.join("\n"), "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/big.md",
      pattern: "MATCH",
      maxMatches: 200,
    }));
    const parsed = JSON.parse(result.content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.matches.length).toBeLessThan(200);
  });

  test("outputMode rejects unknown values", async () => {
    await writeFile(join(rootDir, "workspace", "safe.md"), "hello\n", "utf8");
    const result = await executeFileTool(rootDir, call("grep_files", {
      path: "workspace/safe.md",
      pattern: "hello",
      outputMode: "bogus",
    }));
    expect(result.ok).toBe(false);
    expect(result.content).toContain("outputMode must be one of");
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

/** Write one loadable skill outside the project root and load it as `user` scope. */
async function writeMountedSkill(name: string, files: Record<string, string | Uint8Array>): Promise<LoadedSkill> {
  const root = join(skillScratch, name);
  await mkdir(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`, "utf8");
  const loaded = await loadSkill(root, "user");
  if (!loaded.parsed.ok) throw new Error(`fixture skill failed to load: ${loaded.parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return loaded;
}

/** Mount loaded skills as activated in the isolated session. */
async function mountFor(skills: LoadedSkill[], activated: LoadedSkill[] = skills): Promise<SkillMount> {
  const catalog: ResolvedSkillCatalog = {
    catalog: buildCatalog(skills),
    byName: new Map(skills.map((skill) => [skill.name, skill])),
  };
  for (const skill of activated) {
    if (skill.parsed.ok) recordActivation(skillSessionId, skill.name, skill.parsed.bodySha256);
  }
  return new SkillMount(catalog, skillSessionId);
}

describe("skills read-only mount", () => {
  test("virtual root discovery lists skills as read-only only when mounted", async () => {
    const mount = await mountFor([await writeMountedSkill("alpha", { "references/note.md": "text" })]);
    const mounted = await executeFileTool(rootDir, call("list_directory", { path: "." }), { skillMount: mount });
    const entries = JSON.parse(mounted.content).entries;
    expect(entries).toContainEqual({ path: "skills", type: "directory", readOnly: true });
    // Without a mount the discovery surface is unchanged (regression guard
    // for isolated runtimes that never wire a catalog).
    const bare = await executeFileTool(rootDir, call("list_directory", { path: "." }));
    expect(JSON.parse(bare.content).entries.map((entry: { path: string }) => entry.path)).not.toContain("skills");
  });

  test("lists and stats the mounted inventory without exposing host paths", async () => {
    const mount = await mountFor([await writeMountedSkill("alpha", { "references/note.md": "needle here" })]);

    const rootList = await executeFileTool(rootDir, call("list_directory", { path: "skills" }), { skillMount: mount });
    expect(JSON.parse(rootList.content)).toMatchObject({ status: "ok", directoryCount: 1 });
    expect(rootList.content).toContain("skills/alpha");
    expect(rootList.content).not.toContain(skillScratch);

    const skillList = await executeFileTool(rootDir, call("list_directory", { path: "skills/alpha" }), { skillMount: mount });
    const listed = JSON.parse(skillList.content);
    expect(listed.entries.map((entry: { path: string }) => entry.path)).toEqual(["skills/alpha/references", "skills/alpha/SKILL.md"]);

    const fileStat = await executeFileTool(rootDir, call("stat_path", { path: "skills/alpha/references/note.md" }), { skillMount: mount });
    expect(JSON.parse(fileStat.content)).toMatchObject({ path: "skills/alpha/references/note.md", type: "file" });

    const missing = await executeFileTool(rootDir, call("stat_path", { path: "skills/alpha/references/missing.md" }), { skillMount: mount });
    expect(JSON.parse(missing.content)).toEqual({ path: "skills/alpha/references/missing.md", type: "not_found" });
  });

  test("reads mounted files with line ranges and rejects byte slices", async () => {
    const mount = await mountFor([await writeMountedSkill("alpha", { "references/note.md": "one\ntwo\nthree\n" })]);

    const read = await executeFileTool(rootDir, call("read_file", { path: "skills/alpha/references/note.md", startLine: 2, endLine: 3 }), { skillMount: mount });
    expect(read.ok).toBe(true);
    expect(read.content).toBe("two\nthree");

    const sliced = await executeFileTool(
      rootDir,
      call("read_file", { path: "skills/alpha/references/note.md", offsetBytes: 0, maxBytes: 4 }),
      { skillMount: mount },
    );
    expect(sliced.ok).toBe(false);
    expect(sliced.content).toContain("not supported for the skills mount");
  });

  test("greps the mount with skill-scoped paths and match shapes", async () => {
    const mount = await mountFor([await writeMountedSkill("alpha", { "references/note.md": "needle here\nplain line" })]);

    const content = await executeFileTool(
      rootDir,
      call("grep_files", { path: "skills/alpha", pattern: "needle" }),
      { skillMount: mount },
    );
    const parsed = JSON.parse(content.content);
    expect(parsed).toMatchObject({ outputMode: "content", truncated: false });
    expect(parsed.matches).toEqual([
      { path: "skills/alpha/references/note.md", line: 1, text: "needle here" },
    ]);
    expect(content.content).not.toContain(skillScratch);

    const fileList = await executeFileTool(
      rootDir,
      call("grep_files", { path: "skills", pattern: "needle", outputMode: "files_with_matches" }),
      { skillMount: mount },
    );
    expect(JSON.parse(fileList.content)).toMatchObject({ files: ["skills/alpha/references/note.md"] });
  });

  test("views images bundled with a mounted skill", async () => {
    const mount = await mountFor([
      await writeMountedSkill("alpha", { "assets/diagram.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) }),
    ]);
    const result = await executeFileTool(rootDir, call("view_image", { path: "skills/alpha/assets/diagram.png" }), { skillMount: mount });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Viewed skills/alpha/assets/diagram.png");
    expect(result.images?.length).toBe(1);
  });

  test("rejects oversized images before buffering on every view_image surface", async () => {
    // The pre-flight protects the host from buffering a multi-gigabyte file
    // before the 20 MiB attachment cap fires; the error must come from the
    // size check on all three surfaces (project, assets, skills mount).
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 0x89);
    await writeFile(join(rootDir, "source_materials", "huge.png"), oversized);
    await mkdir(join(rootDir, "assets", "imgs"), { recursive: true });
    await writeFile(join(rootDir, "assets", "imgs", "huge.png"), oversized);
    const mount = await mountFor([await writeMountedSkill("alpha", { "assets/huge.png": new Uint8Array(oversized) })]);

    const project = await executeFileTool(rootDir, call("view_image", { path: "source_materials/huge.png" }));
    expect(project.ok).toBe(false);
    expect(project.content).toContain("exceeds the 20 MiB limit");

    const asset = await executeFileTool(rootDir, call("view_image", { path: "assets/imgs/huge.png" }));
    expect(asset.ok).toBe(false);
    expect(asset.content).toContain("exceeds the 20 MiB limit");

    const mounted = await executeFileTool(rootDir, call("view_image", { path: "skills/alpha/assets/huge.png" }), { skillMount: mount });
    expect(mounted.ok).toBe(false);
    expect(mounted.content).toContain("exceeds the 20 MiB limit");
  });

  test("unactivated and absent mounts fail closed with redirects", async () => {
    const alpha = await writeMountedSkill("alpha", { "references/note.md": "text" });
    const locked = await mountFor([alpha], []);
    const unactivated = await executeFileTool(rootDir, call("read_file", { path: "skills/alpha/references/note.md" }), { skillMount: locked });
    expect(unactivated.ok).toBe(false);
    expect(unactivated.content).toContain("not active in this session");
    expect(unactivated.content).toContain('activate_skill("alpha")');

    const absent = await executeFileTool(rootDir, call("grep_files", { path: "skills/alpha", pattern: "text" }));
    expect(absent.ok).toBe(false);
    expect(absent.content).toContain("skills/ mount is unavailable");
  });

  test("write and structure tools reject the read-only mount instructively", async () => {
    const mount = await mountFor([await writeMountedSkill("alpha", { "references/note.md": "text" })]);
    const options = { skillMount: mount };
    await expectToolFailure("write_file", { path: "skills/alpha/references/evil.md", content: "x" }, "read-only mount", options);
    await expectToolFailure("delete_file", { path: "skills/alpha/references/note.md" }, "read-only mount", options);
    await expectToolFailure("move_file", { sourcePath: "skills/alpha/references/note.md", targetPath: "workspace/note.md" }, "read-only mount", options);
  });
});

async function expectToolFailure(name: string, args: Record<string, unknown>, content: string, options: { skillMount?: SkillMount } = {}): Promise<void> {
  const result = await executeFileTool(rootDir, call(name, args), options);
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

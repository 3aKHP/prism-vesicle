import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureProjectRoots, formatRootCreationFailure } from "../../../../src/core/project/ensure-roots";
import { modelWritableRoots } from "../../../../src/core/project/roots";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ensure-roots-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ensureProjectRoots", () => {
  test("creates every model-writable root and no others", async () => {
    const failures = await ensureProjectRoots(root);

    expect(failures).toEqual([]);
    for (const name of modelWritableRoots) {
      expect((await lstat(join(root, name))).isDirectory()).toBe(true);
    }
    // The read-only assets root is deliberately not created.
    await expect(lstat(join(root, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("is idempotent over roots that already exist", async () => {
    await writeFile(join(root, "placeholder.txt"), "keep\n");
    await ensureProjectRoots(root);
    await writeFile(join(root, "workspace/note.md"), "draft\n");

    const failures = await ensureProjectRoots(root);

    expect(failures).toEqual([]);
    expect((await lstat(join(root, "workspace/note.md"))).isFile()).toBe(true);
  });

  test("collects a failure instead of throwing when a file squats on a root path", async () => {
    await writeFile(join(root, "workspace"), "not a directory\n");

    const failures = await ensureProjectRoots(root);

    expect(failures.length).toBe(1);
    expect(failures[0]!.root).toBe("workspace");
    expect(formatRootCreationFailure(failures[0]!)).toContain('"workspace"');
    // The remaining roots were still created.
    expect((await lstat(join(root, "novels"))).isDirectory()).toBe(true);
  });
});

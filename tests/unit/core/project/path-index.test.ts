import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectPathIndex } from "../../../../src/core/project/path-index";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-path-index-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await mkdir(join(root, "novels"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n\nA card.\n");
  await writeFile(join(root, "workspace/notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "novels/draft.md"), "draft\n");
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(join(root, "fake.txt"), Buffer.from([0x41, 0x00, 0x42])); // NUL inside
  await writeFile(join(root, ".hidden.md"), "secret\n");
  await writeFile(join(root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project path index", () => {
  test("indexes visible files and directories without following symlinks", async () => {
    await symlink(join(root, "novels"), join(root, "linked-novels"));
    await writeFile(join(root, "foo\\..\\bar.md"), "unsafe-name\n");
    const index = await buildProjectPathIndex(root, { showHidden: false });
    expect(index).toContainEqual({ path: "workspace", kind: "dir" });
    expect(index).toContainEqual({ path: "workspace/cards/mira.md", kind: "file" });
    expect(index.some((entry) => entry.path.startsWith("linked-novels"))).toBe(false);
    expect(index.some((entry) => entry.path.startsWith(".hidden"))).toBe(false);
    expect(index.some((entry) => entry.path.includes(".."))).toBe(false);
  });
});

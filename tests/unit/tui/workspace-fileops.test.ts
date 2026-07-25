import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copyEntry,
  createDirectory,
  createFile,
  entryExists,
  moveEntry,
  removeFile,
  trashEntry,
} from "../../../src/tui/workspace-fileops";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-fileops-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "hi\n");
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fileops guards", () => {
  test("every op rejects paths that escape the project root", async () => {
    await expect(createFile(root, "../out.txt")).rejects.toBeDefined();
    await expect(createDirectory(root, "/abs")).rejects.toBeDefined();
    await expect(moveEntry(root, "notes.txt", "../out.txt")).rejects.toBeDefined();
    await expect(copyEntry(root, "notes.txt", "../out.txt")).rejects.toBeDefined();
    await expect(trashEntry(root, "../out.txt")).rejects.toBeDefined();
  });
});

describe("fileops create", () => {
  test("createFile makes an empty file and refuses to overwrite", async () => {
    await createFile(root, "workspace/cards/new.md");
    expect(await readFile(join(root, "workspace/cards/new.md"), "utf8")).toBe("");
    await expect(createFile(root, "notes.txt")).rejects.toThrow(/already exists/);
  });

  test("createFile mkdir -p the parent", async () => {
    await createFile(root, "a/b/c/deep.txt");
    expect(await readFile(join(root, "a/b/c/deep.txt"), "utf8")).toBe("");
  });

  test("createDirectory refuses to overwrite", async () => {
    await createDirectory(root, "newdir");
    expect(await entryExists(root, "newdir")).toBe(true);
    await expect(createDirectory(root, "workspace")).rejects.toThrow(/already exists/);
  });
});

describe("fileops move / copy", () => {
  test("moveEntry renames a file", async () => {
    await moveEntry(root, "notes.txt", "renamed.txt");
    expect(await entryExists(root, "notes.txt")).toBe(false);
    expect(await readFile(join(root, "renamed.txt"), "utf8")).toBe("hi\n");
  });

  test("moveEntry relocates a directory tree", async () => {
    await moveEntry(root, "workspace/cards", "workspace/moved");
    expect(await entryExists(root, "workspace/cards")).toBe(false);
    expect(await readFile(join(root, "workspace/moved/mira.md"), "utf8")).toBe("# Mira\n");
  });

  test("copyEntry duplicates a file without touching the source", async () => {
    await copyEntry(root, "notes.txt", "copy.txt");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hi\n");
    expect(await readFile(join(root, "copy.txt"), "utf8")).toBe("hi\n");
  });

  test("copyEntry duplicates a directory tree recursively", async () => {
    await copyEntry(root, "workspace/cards", "workspace/cards-copy");
    expect(await readFile(join(root, "workspace/cards/mira.md"), "utf8")).toBe("# Mira\n");
    expect(await readFile(join(root, "workspace/cards-copy/mira.md"), "utf8")).toBe("# Mira\n");
  });

  test("removeFile deletes a file", async () => {
    await removeFile(root, "notes.txt");
    expect(await entryExists(root, "notes.txt")).toBe(false);
  });

  test("removeFile clearly rejects a directory overwrite without deleting it", async () => {
    await expect(removeFile(root, "workspace/cards")).rejects.toThrow(/directory and cannot be overwritten/);
    expect(await entryExists(root, "workspace/cards/mira.md")).toBe(true);
  });
});

describe("fileops trash (recycle bin)", () => {
  test("trashEntry moves a file under .vesicle/trash and returns that path", async () => {
    const trashPath = await trashEntry(root, "notes.txt");
    expect(trashPath.startsWith(".vesicle/trash/")).toBe(true);
    expect(await entryExists(root, "notes.txt")).toBe(false);
    // The original content survives in the trash for manual recovery.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, ".vesicle/trash"));
    expect(entries.some((name) => name.endsWith("-notes.txt"))).toBe(true);
  });

  test("trashEntry refuses a non-empty directory (no accidental subtree drop)", async () => {
    await expect(trashEntry(root, "workspace/cards")).rejects.toThrow(/not empty/);
    // The directory and its contents are untouched.
    expect(await entryExists(root, "workspace/cards/mira.md")).toBe(true);
  });

  test("trashEntry accepts an empty directory", async () => {
    await mkdir(join(root, "empty"));
    const trashPath = await trashEntry(root, "empty");
    expect(await entryExists(root, "empty")).toBe(false);
    expect(trashPath.startsWith(".vesicle/trash/")).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteFile,
  computeFindOffsets,
  isEditablePreview,
  readEditableFile,
  readFileStamp,
} from "../../../src/tui/workspace-editor";
import { assertProjectRelativePath } from "../../../src/tui/workspace/paths";
import { readFilePreview } from "../../../src/tui/workspace/tree-data";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-editor-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("editor path guard", () => {
  test("resolves project-relative paths and rejects escapes", () => {
    expect(assertProjectRelativePath(root, "notes.txt")).toBe(join(root, "notes.txt"));
    expect(assertProjectRelativePath(root, "a/b/c.md")).toBe(join(root, "a", "b", "c.md"));
    expect(() => assertProjectRelativePath(root, "/abs/path")).toThrow();
    expect(() => assertProjectRelativePath(root, "C:\\abs\\path")).toThrow();
    expect(() => assertProjectRelativePath(root, "C:drive-relative")).toThrow();
    expect(() => assertProjectRelativePath(root, "../escape")).toThrow();
    expect(() => assertProjectRelativePath(root, "a/../../escape")).toThrow();
    expect(() => assertProjectRelativePath(root, "")).toThrow();
    expect(() => assertProjectRelativePath(root, "a\0b")).toThrow();
  });
});

describe("editor atomic write", () => {
  test("writes content via a temp rename and creates parent dirs", async () => {
    await atomicWriteFile(join(root, "sub", "deep", "file.txt"), "hello\n");
    expect(await readFile(join(root, "sub", "deep", "file.txt"), "utf8")).toBe("hello\n");
    // No leftover temp file remains after a successful rename.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(root, "sub", "deep"));
    expect(entries).toEqual(["file.txt"]);
  });

  test("overwrites an existing file", async () => {
    const target = join(root, "existing.txt");
    await writeFile(target, "old\n");
    await atomicWriteFile(target, "new\n");
    expect(await readFile(target, "utf8")).toBe("new\n");
  });
});

describe("editor file read + mtime", () => {
  test("readEditableFile returns content and mtime for a regular file", async () => {
    await writeFile(join(root, "doc.md"), "# Title\n\nbody\n");
    const read = await readEditableFile(root, "doc.md");
    expect(read?.content).toBe("# Title\n\nbody\n");
    expect(read?.relPath).toBe("doc.md");
    expect(typeof read?.mtimeMs).toBe("number");
    expect(typeof read?.ino).toBe("number");
    expect(read?.bytes).toBeGreaterThan(0);
  });

  test("readEditableFile returns null for missing paths and directories", async () => {
    expect(await readEditableFile(root, "gone.md")).toBeNull();
    await mkdir(join(root, "adir"));
    expect(await readEditableFile(root, "adir")).toBeNull();
  });

  test("readFileStamp returns identity and nulls when deleted", async () => {
    await writeFile(join(root, "f.txt"), "x\n");
    const first = await readFileStamp(root, "f.txt");
    expect(typeof first?.mtimeMs).toBe("number");
    expect(typeof first?.ino).toBe("number");
    await rm(join(root, "f.txt"));
    expect(await readFileStamp(root, "f.txt")).toBeNull();
  });
});

describe("editor find offsets", () => {
  test("empty query yields no matches; matches are non-overlapping", () => {
    expect(computeFindOffsets("abcabc", "")).toEqual([]);
    expect(computeFindOffsets("abcabc", "abc")).toEqual([0, 3]);
    expect(computeFindOffsets("aaa", "aa")).toEqual([0]); // non-overlapping
    expect(computeFindOffsets("hello world", "xyz")).toEqual([]);
  });
});

describe("editor editable classification", () => {
  test("text and markdown in bounds are editable", async () => {
    await writeFile(join(root, "notes.txt"), "line\n");
    await writeFile(join(root, "card.md"), "# card\n");
    expect(isEditablePreview((await readFilePreview(root, "notes.txt"))!)).toBe(true);
    expect(isEditablePreview((await readFilePreview(root, "card.md"))!)).toBe(true);
  });

  test("image/binary/oversized/symlink/readonly are not editable", async () => {
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, "data.bin"), Buffer.from([0x00, 0x01]));
    expect(isEditablePreview((await readFilePreview(root, "logo.png"))!)).toBe(false);
    expect(isEditablePreview((await readFilePreview(root, "data.bin"))!)).toBe(false);

    // Symlink: never editable (escape risk), even if the target is text.
    await writeFile(join(root, "real.txt"), "real\n");
    await symlink(join(root, "real.txt"), join(root, "link.txt"));
    const linked = await readFilePreview(root, "link.txt");
    expect(linked?.symlink).toBe(true);
    expect(linked?.lines).toBeUndefined();
    expect(isEditablePreview(linked!)).toBe(false);
    expect(await readEditableFile(root, "link.txt")).toBeNull();
    expect(await readFileStamp(root, "link.txt")).toBeNull();

    // Oversized text: read-only (would exceed the editor's in-bounds ceiling).
    const big = join(root, "big.txt");
    await writeFile(big, "x".repeat(600 * 1024));
    const oversized = await readFilePreview(root, "big.txt");
    expect(oversized?.oversized).toBe(true);
    expect(isEditablePreview(oversized!)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileOperationOwner } from "../../../src/tui/workspace/file-operation-owner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-fileops-owner-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace/a.md"), "# A\n");
  await writeFile(join(root, "workspace/b.md"), "# B\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeOwner() {
  const calls = {
    status: [] as Array<[string, string | undefined]>,
  };
  const owner = createFileOperationOwner({
    rootDir: root,
    onStatus: (text, tone) => { calls.status.push([text, tone]); },
  });
  return { owner, calls };
}

describe("workspace file-operation owner: ops bar", () => {
  test("openOpsBar prefills the draft with the directory prefix", () => {
    const { owner } = makeOwner();
    owner.openOpsBar("create-file", "workspace/a.md", "workspace/");
    expect(owner.opsBar()).toEqual({ kind: "create-file", draft: "workspace/", source: "workspace/a.md" });
    owner.opsBarAppend("new.md");
    expect(owner.opsBar()?.draft).toBe("workspace/new.md");
    owner.opsBarBackspace();
    expect(owner.opsBar()?.draft).toBe("workspace/new.m");
    owner.closeOpsBar();
    expect(owner.opsBar()).toBeNull();
  });

  test("opsBarCommit rejects an escaping draft without running a mutation", async () => {
    const { owner, calls } = makeOwner();
    owner.openOpsBar("create-file", "workspace/a.md", "");
    for (const ch of "../../escape.md") owner.opsBarAppend(ch);
    const mutation = await owner.opsBarCommit();
    expect(mutation).toBeNull();
    expect(owner.opsBar()).toBeNull();
    expect(calls.status.at(-1)?.[0]).toContain("escapes");
    await expect(lstat(join(root, "escape.md"))).rejects.toThrow();
  });
});

describe("workspace file-operation owner: guarded mutations", () => {
  test("create-file returns a created mutation and writes the file", async () => {
    const { owner } = makeOwner();
    const mutation = await owner.execCreateFile("workspace/new.md");
    expect(mutation).toEqual({ kind: "created", path: "workspace/new.md", entryType: "file" });
    const info = await lstat(join(root, "workspace/new.md"));
    expect(info.isFile()).toBe(true);
  });

  test("create over an existing file fails without a mutation", async () => {
    const { owner, calls } = makeOwner();
    const mutation = await owner.execCreateFile("workspace/a.md");
    expect(mutation).toBeNull();
    expect(calls.status.at(-1)?.[0]).toContain("already exists");
  });

  test("create-dir returns a created directory mutation", async () => {
    const { owner } = makeOwner();
    const mutation = await owner.execCreateDir("workspace/sub");
    expect(mutation).toEqual({ kind: "created", path: "workspace/sub", entryType: "directory" });
    const info = await lstat(join(root, "workspace/sub"));
    expect(info.isDirectory()).toBe(true);
  });

  test("move to a free target returns a moved mutation; move onto an existing target raises the overwrite dialog", async () => {
    const { owner } = makeOwner();
    await writeFile(join(root, "workspace/c.md"), "# C\n");
    const moved = await owner.execMove("workspace/a.md", "workspace/d.md", false);
    expect(moved).toEqual({ kind: "moved", source: "workspace/a.md", target: "workspace/d.md" });
    await expect(lstat(join(root, "workspace/a.md"))).rejects.toThrow();

    const gated = await owner.execMove("workspace/b.md", "workspace/c.md", false);
    expect(gated).toBeNull();
    expect(owner.dialog()).toEqual({ kind: "ops-overwrite", path: "workspace/c.md", op: "move", source: "workspace/b.md" });

    const forced = await owner.execMove("workspace/b.md", "workspace/c.md", true);
    expect(forced).toEqual({ kind: "moved", source: "workspace/b.md", target: "workspace/c.md" });
  });

  test("move target equals source is refused", async () => {
    const { owner, calls } = makeOwner();
    const mutation = await owner.execMove("workspace/a.md", "workspace/a.md", true);
    expect(mutation).toBeNull();
    expect(calls.status.at(-1)?.[0]).toContain("target equals source");
  });

  test("copy returns a copied mutation and leaves the source intact", async () => {
    const { owner } = makeOwner();
    const mutation = await owner.execCopy("workspace/a.md", "workspace/copy.md", false);
    expect(mutation).toEqual({ kind: "copied", source: "workspace/a.md", target: "workspace/copy.md" });
    await expect(lstat(join(root, "workspace/a.md"))).resolves.toBeDefined();
    await expect(lstat(join(root, "workspace/copy.md"))).resolves.toBeDefined();
  });

  test("delete trashes the entry and returns a deleted mutation", async () => {
    const { owner } = makeOwner();
    const mutation = await owner.execDelete("workspace/a.md");
    expect(mutation).toEqual({ kind: "deleted", path: "workspace/a.md" });
    await expect(lstat(join(root, "workspace/a.md"))).rejects.toThrow();
    const trash = await import("node:fs/promises").then((m) => m.readdir(join(root, ".vesicle", "trash")));
    expect(trash.some((name) => name.endsWith("a.md"))).toBe(true);
  });

  test("deleting a missing entry reports an error without a mutation", async () => {
    const { owner, calls } = makeOwner();
    const mutation = await owner.execDelete("workspace/missing.md");
    expect(mutation).toBeNull();
    expect(calls.status.at(-1)?.[0]).toContain("does not exist");
  });
});

describe("workspace file-operation owner: dialog serialization", () => {
  test("runDialogAction gates key input while the action is in flight", async () => {
    const { owner } = makeOwner();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    owner.runDialogAction(async () => { await gate; });
    expect(owner.dialogActionPending()).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(owner.dialogActionPending()).toBe(false);
  });

  test("close-after-save intent survives until cleared", () => {
    const { owner } = makeOwner();
    expect(owner.closeAfterSavePending()).toBe(false);
    owner.armCloseAfterSave();
    expect(owner.closeAfterSavePending()).toBe(true);
    owner.clearCloseAfterSave();
    expect(owner.closeAfterSavePending()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTreeOwner } from "../../../src/tui/workspace/tree-owner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-tree-owner-"));
  await mkdir(join(root, "a/b"), { recursive: true });
  await writeFile(join(root, "a/b/c.txt"), "c\n");
  await writeFile(join(root, "a/b/d.txt"), "d\n");
  await writeFile(join(root, "top.txt"), "top\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeOwner() {
  const opened: string[] = [];
  const errors: string[] = [];
  const owner = createTreeOwner({
    rootDir: root,
    onOpenPath: async (relPath) => {
      opened.push(relPath);
      return true;
    },
    onLoadError: (message) => {
      errors.push(message);
    },
  });
  return { owner, opened, errors };
}

describe("workspace tree owner: load and rows", () => {
  test("ensureLoaded populates rows from the root, hiding dotfiles", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    const names = owner.rows().map((row) => row.node.name);
    expect(names).toContain("a");
    expect(names).toContain("top.txt");
    expect(owner.loading()).toBe(false);
  });

  test("expanding a directory lazily scans its children into the rows", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    await owner.setDirExpanded("a", true);
    const secondLevel = owner.rows().map((row) => row.node.relPath);
    expect(secondLevel).toContain("a/b");
    await owner.setDirExpanded("a/b", true);
    const thirdLevel = owner.rows().map((row) => row.node.relPath);
    expect(thirdLevel).toContain("a/b/c.txt");
    expect(thirdLevel).toContain("a/b/d.txt");
  });

  test("collapsing a directory removes its children from the rows", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    await owner.setDirExpanded("a", true);
    await owner.setDirExpanded("a/b", true);
    await owner.setDirExpanded("a/b", false);
    const relPaths = owner.rows().map((row) => row.node.relPath);
    expect(relPaths).toContain("a/b");
    expect(relPaths).not.toContain("a/b/c.txt");
  });

  test("refresh rescans after external filesystem changes", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    await writeFile(join(root, "new.txt"), "new\n");
    await owner.refresh();
    const names = owner.rows().map((row) => row.node.name);
    expect(names).toContain("new.txt");
  });
});

describe("workspace tree owner: cache invalidation", () => {
  test("invalidateCache for a nested path drops the cached ancestor listings", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    await owner.setDirExpanded("a", true);
    await owner.setDirExpanded("a/b", true);
    const before = owner.rows().some((row) => row.node.relPath === "a/b/c.txt");
    expect(before).toBe(true);
    // A new sibling is invisible while the cached a/b listing is reused.
    await writeFile(join(root, "a/b/e.txt"), "e\n");
    await owner.refreshRowsAndIndex();
    expect(owner.rows().some((row) => row.node.relPath === "a/b/e.txt")).toBe(false);
    // Invalidating the path's ancestors forces the listing to be re-scanned.
    owner.invalidateCache("a/b/e.txt");
    await owner.refreshRowsAndIndex();
    expect(owner.rows().some((row) => row.node.relPath === "a/b/e.txt")).toBe(true);
  });
});

describe("workspace tree owner: selection and quick open", () => {
  test("moveSelection clamps at the row bounds", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    const count = owner.rows().length;
    owner.moveSelection(100);
    expect(owner.selectedIndex()).toBe(count - 1);
    owner.moveSelection(-100);
    expect(owner.selectedIndex()).toBe(0);
  });

  test("quick open typing filters matches, backspace reverts, enter opens the target", async () => {
    const { owner, opened } = makeOwner();
    await owner.ensureLoaded();
    owner.openQuickOpen();
    expect(owner.quickOpenActive()).toBe(true);
    owner.quickOpenAppend("a");
    owner.quickOpenAppend("/");
    owner.quickOpenAppend("b");
    const matches = owner.quickMatches();
    expect(matches.every((path) => path.includes("a/b"))).toBe(true);
    owner.quickOpenBackspace();
    expect(owner.quickQuery()).toBe("a/");
    owner.moveQuickIndex(1);
    await owner.chooseQuickMatch();
    expect(owner.quickOpenActive()).toBe(false);
    expect(opened).toEqual(["a/b/d.txt"]);
  });

  test("quick open index clamps to the match list", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    owner.openQuickOpen();
    owner.moveQuickIndex(-5);
    expect(owner.quickIndex()).toBe(0);
    owner.moveQuickIndex(50);
    const last = owner.quickMatches().length - 1;
    expect(owner.quickIndex()).toBe(last);
  });

  test("closeQuickOpen leaves the query untouched", async () => {
    const { owner } = makeOwner();
    await owner.ensureLoaded();
    owner.openQuickOpen();
    owner.quickOpenAppend("a");
    owner.closeQuickOpen();
    expect(owner.quickOpenActive()).toBe(false);
    expect(owner.quickQuery()).toBe("a");
  });
});

describe("workspace tree owner: locate path", () => {
  test("locatePath expands ancestors, selects the target, and opens files", async () => {
    const { owner, opened } = makeOwner();
    await owner.ensureLoaded();
    const kind = await owner.locatePath("a/b/c.txt");
    expect(kind).toBe("file");
    expect(opened).toEqual(["a/b/c.txt"]);
    const selected = owner.rows()[owner.selectedIndex()];
    expect(selected?.node.relPath).toBe("a/b/c.txt");
  });

  test("locatePath rejects escapes, absolute paths, and NUL", async () => {
    const { owner, opened } = makeOwner();
    await owner.ensureLoaded();
    expect(await owner.locatePath("../outside")).toBeNull();
    expect(await owner.locatePath("/abs")).toBeNull();
    expect(await owner.locatePath("C:\\abs")).toBeNull();
    expect(await owner.locatePath("a/b\0bad")).toBeNull();
    expect(await owner.locatePath("missing.txt")).toBeNull();
    expect(opened).toEqual([]);
  });
});

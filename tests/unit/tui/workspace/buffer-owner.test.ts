import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TextareaRenderable } from "@opentui/core";
import { createBufferOwner, type BufferWritten } from "../../../../src/tui/workspace/buffer-owner";
import type { FileStamp } from "../../../../src/tui/workspace/buffer-io";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-buffer-owner-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace/a.md"), "# A\n\nbody\n");
  await writeFile(join(root, "workspace/b.md"), "# B\n\nbody\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Headless stand-in for a mounted textarea (same contract the controller
 * suites use): plainText drives dirty, replaceText/setSelection/gotoLine
 * record imperative calls.
 */
function mockEditor(initial: string) {
  let text = initial;
  const calls = {
    setSelection: [] as Array<[number, number]>,
    gotoLine: [] as number[],
    replaceText: [] as string[],
  };
  return {
    get plainText() { return text; },
    setSelection: (start: number, end: number) => { calls.setSelection.push([start, end]); },
    gotoLine: (n: number) => { calls.gotoLine.push(n); },
    insertText: (s: string) => { text += s; },
    replaceText: (s: string) => { text = s; calls.replaceText.push(s); },
    logicalCursor: { row: 0, col: 0, offset: 0 },
    editorView: {
      getViewport: () => ({ offsetX: 0, offsetY: 0, width: 80, height: 24 }),
      setViewport: () => undefined,
    },
    calls,
    type: (s: string) => { text = s; },
  } as unknown as TextareaRenderable & {
    calls: typeof calls;
    type: (s: string) => void;
  };
}

function makeOwner() {
  const calls = {
    status: [] as Array<[string, string | undefined]>,
    written: [] as BufferWritten[],
    reloaded: [] as BufferWritten[],
    saveAsTargetActivated: [] as string[],
    overwriteConfirm: [] as string[],
    saveAsOverwrite: [] as string[],
    reloadConfirm: [] as string[],
    saveStarted: 0,
  };
  const owner = createBufferOwner({
    rootDir: root,
    onStatus: (text, tone) => { calls.status.push([text, tone]); },
    onWritten: (result) => { calls.written.push(result); },
    onReloaded: (result) => { calls.reloaded.push(result); },
    onSaveAsTargetActivated: async (target) => { calls.saveAsTargetActivated.push(target); },
    onOverwriteConfirm: (path) => { calls.overwriteConfirm.push(path); },
    onSaveAsOverwrite: (target) => { calls.saveAsOverwrite.push(target); },
    onReloadConfirm: (path) => { calls.reloadConfirm.push(path); },
    onSaveStarted: () => { calls.saveStarted += 1; },
  });
  return { owner, calls };
}

async function openEditable(relPath: string, content?: string) {
  const { owner, calls } = makeOwner();
  await owner.open(relPath);
  const inst = mockEditor(content ?? "# A\n\nbody\n");
  owner.registerEditorInstance(relPath, inst);
  return { owner, calls, inst };
}

function stampOf(written: BufferWritten): FileStamp {
  expect(written.stamp).not.toBeNull();
  return written.stamp!;
}

describe("workspace buffer owner: pool lifecycle", () => {
  test("open admits a buffer, close removes it from every pool set", async () => {
    const { owner } = makeOwner();
    await owner.open("workspace/a.md");
    expect(owner.editorOrder()).toEqual(["workspace/a.md"]);
    expect(owner.activeEditorPath()).toBe("workspace/a.md");
    const inst = mockEditor("# A\n\nbody\n");
    owner.registerEditorInstance("workspace/a.md", inst);
    inst.type("# A\n\nchanged\n");
    owner.markEditorContentChanged("workspace/a.md");
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(true);
    owner.close("workspace/a.md");
    expect(owner.editorOrder()).toEqual([]);
    expect(owner.activeEditorPath()).toBeNull();
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(false);
    expect(owner.stampOf("workspace/a.md")).toBeNull();
  });

  test("close purges a stale external-changed entry (status warn can clear)", async () => {
    const { owner } = makeOwner();
    await owner.open("workspace/a.md");
    owner.registerEditorInstance("workspace/a.md", mockEditor("# A\n\nbody\n"));
    // Simulate a disk change observed by the page-reactivation check.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "workspace/a.md"), "# A\n\nchanged on disk\n");
    await owner.checkExternalModifications();
    expect(owner.externalChanged().has("workspace/a.md")).toBe(true);
    owner.close("workspace/a.md");
    expect(owner.externalChanged().has("workspace/a.md")).toBe(false);
  });

  test("LRU eviction closes the oldest clean victim; all-dirty refusal keeps it closed", async () => {
    const { owner, calls } = makeOwner();
    const instances: Array<ReturnType<typeof mockEditor>> = [];
    for (let i = 0; i < 8; i += 1) {
      const p = `workspace/f${i}.md`;
      await writeFile(join(root, p), `f${i}\n`);
      await owner.open(p);
      const inst = mockEditor(`f${i}\n`);
      instances.push(inst);
      owner.registerEditorInstance(p, inst);
      inst.type(`g${i}\n`);
      owner.markEditorContentChanged(p);
    }
    // Ninth open with every buffer dirty: refused, no victim.
    await writeFile(join(root, "workspace/f8.md"), "f8\n");
    await owner.open("workspace/f8.md");
    expect(owner.activeEditorPath()).toBeNull();
    expect(calls.status.at(-1)?.[0]).toContain("all dirty");
    // Clean one buffer (f3): the oldest clean victim gets evicted for f8.
    instances[3]!.type("f3\n");
    owner.markEditorContentChanged("workspace/f3.md");
    await owner.open("workspace/f8.md");
    expect(owner.activeEditorPath()).toBe("workspace/f8.md");
    expect(owner.editorOrder().length).toBe(8);
    expect(owner.stampOf("workspace/f3.md")).toBeNull();
  });

  test("rekey moves pool state to the new path; rekey onto an open buffer closes it first", async () => {
    const { owner } = makeOwner();
    await owner.open("workspace/a.md");
    const instA = mockEditor("# A\n\nbody\n");
    owner.registerEditorInstance("workspace/a.md", instA);
    instA.type("# A\n\ndirty\n");
    owner.markEditorContentChanged("workspace/a.md");
    await owner.open("workspace/b.md");
    const instB = mockEditor("# B\n\nbody\n");
    owner.registerEditorInstance("workspace/b.md", instB);

    owner.rekey("workspace/a.md", "workspace/b.md");
    // B's stale buffer closed first, A rekeyed onto it: exactly one entry.
    // The pre-existing close-then-rekey sequence leaves the active path null
    // when B was the active buffer (the view falls back to the read-only
    // preview); preserved verbatim, W3's applyMutation owns any change.
    expect(owner.editorOrder().filter((p) => p === "workspace/b.md").length).toBe(1);
    expect(owner.activeEditorPath()).toBeNull();
    expect(owner.dirtyPaths().has("workspace/b.md")).toBe(true);
    expect(owner.stampOf("workspace/a.md")).toBeNull();
    expect(owner.stampOf("workspace/b.md")).not.toBeNull();
  });
});

describe("workspace buffer owner: save and save-as", () => {
  test("saveActive writes, clears dirty, and reports the written outcome", async () => {
    const { owner, calls, inst } = await openEditable("workspace/a.md");
    inst.type("# A\n\nedited\n");
    owner.markEditorContentChanged("workspace/a.md");
    const saved = await owner.saveActive();
    expect(saved).toBe(true);
    expect(calls.saveStarted).toBe(1);
    expect(calls.written.length).toBe(1);
    expect(calls.written[0]!.path).toBe("workspace/a.md");
    expect(calls.written[0]!.content).toBe("# A\n\nedited\n");
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(false);
    expect(calls.status.some(([t]) => t.startsWith("saved"))).toBe(true);
  });

  test("saveActive diverts to the overwrite confirm when the disk identity changed", async () => {
    const { owner, calls } = await openEditable("workspace/a.md");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "workspace/a.md"), "# A\n\noutside\n");
    const saved = await owner.saveActive();
    expect(saved).toBe(false);
    expect(calls.overwriteConfirm).toEqual(["workspace/a.md"]);
    expect(calls.written.length).toBe(0);
  });

  test("forceSave writes even after an external disk change", async () => {
    const { owner, calls } = await openEditable("workspace/a.md");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "workspace/a.md"), "# A\n\noutside\n");
    const saved = await owner.forceSave();
    expect(saved).toBe(true);
    expect(calls.written.length).toBe(1);
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(false);
  });

  test("save-as to a free target switches the buffer and activates the target", async () => {
    const { owner, calls, inst } = await openEditable("workspace/a.md");
    inst.type("# A\n\nsave-as\n");
    owner.markEditorContentChanged("workspace/a.md");
    await owner.commitSaveAs("workspace/new.md");
    expect(calls.written.some((w) => w.path === "workspace/new.md")).toBe(true);
    expect(calls.saveAsTargetActivated).toEqual(["workspace/new.md"]);
    expect(owner.activeEditorPath()).toBe("workspace/new.md");
    expect(owner.editorOrder()).toEqual(["workspace/new.md"]);
    expect(owner.dirtyPaths().has("workspace/new.md")).toBe(false);
  });

  test("save-as to an existing different file raises the overwrite confirm", async () => {
    const { owner, calls } = await openEditable("workspace/a.md");
    await owner.commitSaveAs("workspace/b.md");
    expect(calls.saveAsOverwrite).toEqual(["workspace/b.md"]);
    expect(owner.activeEditorPath()).toBe("workspace/a.md");
    expect(calls.saveAsTargetActivated.length).toBe(0);
  });

  test("save-as records the real written stamp so the next save is not a false overwrite", async () => {
    const { owner, calls } = await openEditable("workspace/a.md");
    await owner.commitSaveAs("workspace/new.md");
    const stamp = stampOf(calls.written.find((w) => w.path === "workspace/new.md")!);
    expect(owner.stampOf("workspace/new.md")).toEqual(stamp);
  });
});

describe("workspace buffer owner: reload and external reconciliation", () => {
  test("requestReloadActive raises the confirm when dirty, notes current otherwise", async () => {
    const { owner, calls, inst } = await openEditable("workspace/a.md");
    inst.type("# A\n\ndirty\n");
    owner.markEditorContentChanged("workspace/a.md");
    owner.requestReloadActive();
    expect(calls.reloadConfirm).toEqual(["workspace/a.md"]);
    // Undo back to clean: the reload request now reports "already current".
    inst.type("# A\n\nbody\n");
    owner.markEditorContentChanged("workspace/a.md");
    owner.requestReloadActive();
    expect(calls.status.some(([t]) => t.includes("already current"))).toBe(true);
  });

  test("reloadActiveBuffer replaces text, clears dirty, and reports the reloaded content", async () => {
    const { owner, calls, inst } = await openEditable("workspace/a.md");
    inst.type("# A\n\nlocal\n");
    owner.markEditorContentChanged("workspace/a.md");
    await writeFile(join(root, "workspace/a.md"), "# A\n\nfresh\n");
    await owner.reloadActiveBuffer();
    expect(inst.calls.replaceText).toEqual(["# A\n\nfresh\n"]);
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(false);
    expect(calls.reloaded.length).toBe(1);
    expect(calls.reloaded[0]!.content).toBe("# A\n\nfresh\n");
    expect(owner.stampOf("workspace/a.md")).toEqual(stampOf(calls.reloaded[0]!));
  });

  test("checkExternalModifications flags stamp-mismatched open buffers", async () => {
    const { owner, calls } = await openEditable("workspace/a.md");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "workspace/a.md"), "# A\n\nchanged\n");
    await owner.checkExternalModifications();
    expect(owner.externalChanged().has("workspace/a.md")).toBe(true);
    expect(calls.status.some(([t]) => t.includes("changed on disk"))).toBe(true);
  });

  test("reconcileExternalChange classifies unchanged, modified, removed, and non-resident", async () => {
    const { owner, calls, inst } = await openEditable("workspace/a.md");
    // unchanged: same disk identity.
    expect(await owner.reconcileExternalChange("workspace/a.md")).toBe("unchanged");
    expect(calls.status.some(([t]) => t.includes("no changes"))).toBe(true);
    // modified: new mtime + new content → replaceText + reloaded.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, "workspace/a.md"), "# A\n\nedited outside\n");
    expect(await owner.reconcileExternalChange("workspace/a.md")).toBe("modified");
    expect(inst.calls.replaceText).toEqual(["# A\n\nedited outside\n"]);
    expect(calls.reloaded.at(-1)?.content).toBe("# A\n\nedited outside\n");
    // removed: gone from disk → buffer closed.
    await rm(join(root, "workspace/a.md"));
    expect(await owner.reconcileExternalChange("workspace/a.md")).toBe("removed");
    expect(owner.stampOf("workspace/a.md")).toBeNull();
    expect(owner.dirtyPaths().has("workspace/a.md")).toBe(false);
    // not-resident: a path with no buffer just reports the class.
    expect(await owner.reconcileExternalChange("workspace/b.md")).toBe("not-resident");
  });

  test.skipIf(process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0))(
    "reconcileExternalChange classifies an unreadable file as unreadable and closes the buffer",
    async () => {
      const { owner, calls } = await openEditable("workspace/a.md");
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(root, "workspace/a.md"), "# A\n\nlocked\n");
      await chmod(join(root, "workspace/a.md"), 0o000);
      try {
        expect(await owner.reconcileExternalChange("workspace/a.md")).toBe("unreadable");
        expect(owner.stampOf("workspace/a.md")).toBeNull();
        expect(calls.status.some(([t]) => t.includes("no longer a readable file"))).toBe(true);
      } finally {
        await chmod(join(root, "workspace/a.md"), 0o644);
      }
    },
  );
});

describe("workspace buffer owner: find / goto / save-as bars", () => {
  test("find bar matches, advances, and jumps via setSelection", async () => {
    const { owner, inst } = await openEditable("workspace/a.md", "aa bb aa cc\n");
    owner.openFind();
    owner.findAppend("aa");
    expect(owner.findMatches()).toEqual([0, 6]);
    owner.advanceFindMatch(1);
    expect(inst.calls.setSelection).toEqual([[0, 2], [6, 8]]);
    owner.closeFind();
    expect(owner.findActive()).toBe(false);
  });

  test("goto bar commits a 1-based line jump", async () => {
    const { owner, inst } = await openEditable("workspace/a.md", "l1\nl2\nl3\n");
    owner.openGoto();
    owner.gotoAppend("2");
    owner.gotoCommit();
    expect(inst.calls.gotoLine).toEqual([1]);
    expect(owner.gotoActive()).toBe(false);
  });
});

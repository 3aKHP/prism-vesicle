import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";
import type { TextareaRenderable } from "@opentui/core";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-edit-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n\nbody\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function key(name: string, mods: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ...mods } as TuiKeyEvent;
}

/**
 * Headless stand-in for a mounted textarea. The controller drives the real
 * component imperatively (plainText, setSelection, gotoLine, replaceText); a
 * plain object with those members exercises the same paths without OpenTUI's
 * useKeyboard (which the headless harness cannot run — see the B3 spike).
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
    calls,
    /** Test hook: simulate the user typing — mutates plainText. */
    type: (s: string) => { text = s; },
  } as unknown as TextareaRenderable & {
    calls: typeof calls;
    type: (s: string) => void;
  };
}

async function openEditable(controller: ReturnType<typeof createWorkspaceController>, relPath: string, content?: string) {
  await controller.openWorkspaceTarget();
  await controller.openPath(relPath);
  const preview = controller.openFile();
  const initial = content ?? preview?.lines?.join("\n") ?? "";
  const inst = mockEditor(initial);
  controller.registerEditorInstance(relPath, inst);
  return inst;
}

describe("workspace editor: dirty tracking and save", () => {
  test("opening an editable file creates a clean buffer; edits mark it dirty", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    expect(controller.activeEditorPath()).toBe("notes.txt");
    expect(controller.isEditing()).toBe(true);
    expect(controller.dirtyPaths().has("notes.txt")).toBe(false);

    inst.type("line one\nline two\nEDITED\n");
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);

    // Undo-back-to-clean clears the dot (plainText-vs-snapshot, not a one-way flag).
    inst.type("line one\nline two\n");
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(false);
  });

  test("Ctrl+S writes the buffer atomically and clears dirty", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("line one\nline two\nnew line\n");
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);

    expect(controller.handleKey(key("s", { ctrl: true }))).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.dirtyPaths().has("notes.txt")).toBe(false);
    expect(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "notes.txt"), "utf8")))
      .toBe("line one\nline two\nnew line\n");
  });

  test("Ctrl+S dual-encoding (raw DC3 byte) also saves", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("DC3\n");
    controller.markEditorContentChanged("notes.txt");
    // A terminal that sends 0x13 without decomposing it to ctrl+s.
    expect(controller.handleKey({ sequence: "\x13" } as TuiKeyEvent)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "notes.txt"), "utf8")))
      .toBe("DC3\n");
  });

  test("status tone escalates with severity (success / warn / error)", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt");
    expect(controller.editorStatusTone()).toBe("info");

    // A clean save reads as a success tone.
    controller.handleKey(key("s", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.editorStatusTone()).toBe("success");

    // Editing clears the stale "saved" note back to neutral.
    const inst2 = mockEditor("line one\nline two\nMORE\n");
    controller.registerEditorInstance("notes.txt", inst2);
    controller.markEditorContentChanged("notes.txt");
    expect(controller.editorStatus()).toBe("");
    expect(controller.editorStatusTone()).toBe("info");

    // An external disk change is a warning.
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "notes.txt"), "disk version\n");
    controller.setActivePage("workspace");
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.editorStatusTone()).toBe("warn");
  });

  test("all-dirty refusal and failed save-as report an error tone", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    for (let i = 1; i <= 8; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `file ${i}\n`);
      await controller.openPath(`f${i}.txt`);
      const inst = mockEditor(`file ${i}\nDIRTY\n`);
      controller.registerEditorInstance(`f${i}.txt`, inst);
      controller.markEditorContentChanged(`f${i}.txt`);
    }
    await writeFile(join(root, "f9.txt"), "file 9\n");
    await controller.openPath("f9.txt");
    expect(controller.editorStatusTone()).toBe("error");

    // A save-as to an escaping path also reads as an error.
    await openEditable(controller, "notes.txt");
    controller.handleKey(key("s", { ctrl: true, shift: true }));
    for (const ch of "../escape.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.editorStatusTone()).toBe("error");
  });
});

describe("workspace editor: key routing", () => {
  test("editable source passes printable keys through to the textarea", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt");
    // Printable characters, arrows, Tab, and undo/redo return false so the
    // global listener does not consume them and the focused textarea acts.
    for (const k of ["a", "left", "right", "up", "down", "tab", "backspace", "enter"]) {
      expect(controller.handleKey(key(k))).toBe(false);
    }
    // undo/redo via the textarea's custom keyBindings propagate too.
    expect(controller.handleKey(key("z", { ctrl: true }))).toBe(false);
    expect(controller.handleKey(key("y", { ctrl: true }))).toBe(false);
  });

  test("editable source consumes command keys at the global layer", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt");
    expect(controller.handleKey(key("f", { ctrl: true }))).toBe(true);
    expect(controller.findActive()).toBe(true);
    controller.handleKey(key("escape")); // close find
    expect(controller.handleKey(key("g", { ctrl: true }))).toBe(true);
    expect(controller.gotoActive()).toBe(true);
    controller.handleKey(key("escape"));
  });
});

describe("workspace editor: find and goto", () => {
  test("find bar computes offsets and cycles matches with selection", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt", "foo bar foo baz foo");
    controller.handleKey(key("f", { ctrl: true }));
    for (const ch of "foo") controller.handleKey(key(ch));
    expect(controller.findQuery()).toBe("foo");
    expect(controller.findMatches()).toEqual([0, 8, 16]);
    expect(inst.calls.setSelection).toContainEqual([0, 3]);
    // Enter advances to the next match.
    controller.handleKey(key("enter"));
    expect(controller.findMatchIndex()).toBe(1);
    expect(inst.calls.setSelection).toContainEqual([8, 11]);
    // Shift+Enter wraps back to the previous match.
    controller.handleKey(key("enter", { shift: true }));
    expect(controller.findMatchIndex()).toBe(0);
    controller.handleKey(key("escape"));
    expect(controller.findActive()).toBe(false);
  });

  test("goto bar jumps to the entered line (1-indexed input, 0-indexed API)", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt", "a\nb\nc\nd\ne");
    controller.handleKey(key("g", { ctrl: true }));
    for (const ch of "4") controller.handleKey(key(ch));
    expect(controller.gotoDraft()).toBe("4");
    controller.handleKey(key("enter"));
    expect(inst.calls.gotoLine).toContain(3);
    expect(controller.gotoActive()).toBe(false);
  });
});

describe("workspace editor: dirty-on-close confirm", () => {
  test("Esc on a dirty buffer prompts; n discards and returns to tree", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("line one\nline two\nDIRTY\n");
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);

    controller.handleKey(key("escape"));
    expect(controller.dialog()?.kind).toBe("dirty-confirm");
    controller.handleKey(key("n"));
    expect(controller.dialog()).toBeNull();
    expect(controller.activeEditorPath()).toBeNull();
    expect(controller.openFile()).toBeNull();
    expect(controller.focusRegion()).toBe("tree");
    // The file on disk is unchanged (edits were discarded).
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("line one\nline two\n");
  });

  test("y on the dirty-confirm saves and closes", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("line one\nline two\nSAVED\n");
    controller.markEditorContentChanged("notes.txt");
    controller.handleKey(key("escape"));
    controller.handleKey(key("y"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.activeEditorPath()).toBeNull();
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("line one\nline two\nSAVED\n");
  });

  test("Esc cancels the confirm and keeps editing", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("line one\nline two\nDIRTY\n");
    controller.markEditorContentChanged("notes.txt");
    controller.handleKey(key("escape"));
    expect(controller.dialog()?.kind).toBe("dirty-confirm");
    controller.handleKey(key("escape"));
    expect(controller.dialog()).toBeNull();
    expect(controller.isEditing()).toBe(true);
  });

  test("y on an externally-changed file diverts to overwrite-confirm without losing the edits", async () => {
    // Regression: 'y' used to run afterDirtyConfirm unconditionally, closing
    // the buffer (edits lost) while leaving a dead overwrite dialog behind.
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("my local edit\n");
    controller.markEditorContentChanged("notes.txt");
    // External writer lands a distinct mtime after the buffer was opened.
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "notes.txt"), "external change\n");

    controller.handleKey(key("escape"));
    expect(controller.dialog()?.kind).toBe("dirty-confirm");
    controller.handleKey(key("y"));
    await new Promise((r) => setTimeout(r, 30));

    // The save diverted: overwrite confirm is live and the buffer survived.
    expect(controller.dialog()?.kind).toBe("overwrite-confirm");
    expect(controller.activeEditorPath()).toBe("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("external change\n");

    // Force-overwrite completes the original "save and close" intent.
    controller.handleKey(key("o"));
    await new Promise((r) => setTimeout(r, 30));
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("my local edit\n");
    expect(controller.activeEditorPath()).toBeNull();
    expect(controller.focusRegion()).toBe("tree");
  });

  test("cancelling the diverted overwrite-confirm keeps the dirty buffer open", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    inst.type("still mine\n");
    controller.markEditorContentChanged("notes.txt");
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "notes.txt"), "external change\n");

    controller.handleKey(key("escape"));
    controller.handleKey(key("y"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.dialog()?.kind).toBe("overwrite-confirm");
    controller.handleKey(key("c"));
    expect(controller.dialog()).toBeNull();
    expect(controller.activeEditorPath()).toBe("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("external change\n");
  });
});

describe("workspace editor: LRU pool", () => {
  test("opening a 9th clean buffer evicts the least-recent one", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    for (let i = 1; i <= 8; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `file ${i}\n`);
      await controller.openPath(`f${i}.txt`);
    }
    expect(controller.editorOrder()).toHaveLength(8);
    expect(controller.editorOrder()).toContain("f1.txt");

    await writeFile(join(root, "f9.txt"), "file 9\n");
    await controller.openPath("f9.txt");
    expect(controller.editorOrder()).toHaveLength(8);
    // f1 (least recently used) is evicted; f9 is at the front.
    expect(controller.editorOrder()).not.toContain("f1.txt");
    expect(controller.editorOrder()[0]).toBe("f9.txt");
  });

  test("all-dirty refusal leaves the new file read-only with a status note", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    for (let i = 1; i <= 8; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `file ${i}\n`);
      await controller.openPath(`f${i}.txt`);
      const inst = mockEditor(`file ${i}\nDIRTY\n`);
      controller.registerEditorInstance(`f${i}.txt`, inst);
      controller.markEditorContentChanged(`f${i}.txt`);
    }
    await writeFile(join(root, "f9.txt"), "file 9\n");
    await controller.openPath("f9.txt");
    // No buffer created for f9 — it opens read-only.
    expect(controller.activeEditorPath()).toBeNull();
    expect(controller.isEditing()).toBe(false);
    expect(controller.editorStatus()).toContain("all dirty");
  });
});

describe("workspace editor: save-as", () => {
  test("Ctrl+Shift+S writes a new path and switches the buffer to it", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt", "line one\nline two\n");
    inst.type("line one\nline two\nNEW\n");
    controller.markEditorContentChanged("notes.txt");
    controller.handleKey(key("s", { ctrl: true, shift: true }));
    expect(controller.saveAsActive()).toBe(true);
    for (const ch of "copy.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "copy.txt"), "utf8")).toBe("line one\nline two\nNEW\n");
    expect(controller.activeEditorPath()).toBe("copy.txt");
    expect(controller.dirtyPaths().has("copy.txt")).toBe(false);
  });

  test("save-as rejects a path that escapes the project root", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt", "x\n");
    controller.handleKey(key("s", { ctrl: true, shift: true }));
    for (const ch of "../escape.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.editorStatus()).toContain("escapes project root");
    const fs = await import("node:fs/promises");
    await expect(fs.readFile(join(root, "..", "escape.txt"), "utf8")).rejects.toBeDefined();
  });

  test("the first save after save-as writes directly (no spurious overwrite confirm)", async () => {
    // Regression: commitSaveAs recorded Date.now() as the buffer mtime, which
    // never matches the on-disk stat, so the next Ctrl+S always raised a
    // false "changed on disk" confirm.
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt", "line one\nline two\n");
    inst.type("line one\nline two\nNEW\n");
    controller.markEditorContentChanged("notes.txt");
    controller.handleKey(key("s", { ctrl: true, shift: true }));
    for (const ch of "copy.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.activeEditorPath()).toBe("copy.txt");

    const inst2 = mockEditor("line one\nline two\nNEW\n");
    controller.registerEditorInstance("copy.txt", inst2);
    inst2.type("line one\nline two\nNEW\nmore\n");
    controller.markEditorContentChanged("copy.txt");
    controller.handleKey(key("s", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.dialog()).toBeNull();
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(join(root, "copy.txt"), "utf8")).toBe("line one\nline two\nNEW\nmore\n");
  });
});

describe("workspace editor: external modification detection", () => {
  test("saving over an externally-changed file opens an overwrite confirm", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt");
    // Wait a beat so the external write lands a distinct mtime.
    await new Promise((r) => setTimeout(r, 25));
    // Simulate another writer changing the file after we opened it.
    await writeFile(join(root, "notes.txt"), "externally changed\n");
    controller.handleKey(key("s", { ctrl: true }));
    // saveActive is fire-and-forget; the dialog is set after its mtime read.
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.dialog()?.kind).toBe("overwrite-confirm");
    // 's' routes to save-as, 'o' force-overwrites.
    controller.handleKey(key("o"));
    await new Promise((r) => setTimeout(r, 30));
    const fs = await import("node:fs/promises");
    // The buffer content (the opened snapshot, unedited) now wins on disk.
    expect(await fs.readFile(join(root, "notes.txt"), "utf8")).toBe("line one\nline two\n");
  });

  test("reactivating the page stats open buffers and marks disk-changed ones", async () => {
    const controller = createWorkspaceController(root);
    await openEditable(controller, "notes.txt");
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "notes.txt"), "changed on disk\n");
    // Re-entering the workspace page triggers the mtime sweep.
    controller.setActivePage("workspace");
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.externalChanged().has("notes.txt")).toBe(true);
    expect(controller.editorStatus()).toContain("changed on disk");
  });

  test("Ctrl+R on a disk-changed buffer reloads it (replaceText preserves undo)", async () => {
    const controller = createWorkspaceController(root);
    const inst = await openEditable(controller, "notes.txt");
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "notes.txt"), "fresh from disk\n");
    controller.setActivePage("workspace");
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.externalChanged().has("notes.txt")).toBe(true);
    controller.handleKey(key("r", { ctrl: true }));
    expect(controller.dialog()?.kind).toBe("reload-confirm");
    controller.handleKey(key("y"));
    await new Promise((r) => setTimeout(r, 20));
    expect(inst.calls.replaceText).toContain("fresh from disk\n");
    expect(controller.externalChanged().has("notes.txt")).toBe(false);
  });
});

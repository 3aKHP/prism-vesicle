import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";
import type { TextareaRenderable } from "@opentui/core";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-ops-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "workspace/cards/mira.md"), "---\narchetype: x\n---\nbody\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function key(name: string, mods: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ...mods } as TuiKeyEvent;
}

function mockEditor(initial: string) {
  let text = initial;
  const calls = { gotoLine: [] as number[], setSelection: [] as Array<[number, number]>, replaceText: [] as string[] };
  return {
    get plainText() { return text; },
    setSelection: (a: number, b: number) => { calls.setSelection.push([a, b]); },
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
  } as unknown as TextareaRenderable & { calls: typeof calls; type: (s: string) => void };
}

/** Press F6 until the tree region owns focus (max one full cycle). */
function gotoTree(controller: ReturnType<typeof createWorkspaceController>): void {
  for (let i = 0; i < 4 && controller.focusRegion() !== "tree"; i += 1) {
    controller.handleKey(key("f6"));
  }
}

/** Select a project-relative path in the tree by walking ↑/↓. */
function selectInTree(controller: ReturnType<typeof createWorkspaceController>, relPath: string): void {
  const target = controller.rows().findIndex((row) => row.node.relPath === relPath);
  expect(target).toBeGreaterThanOrEqual(0);
  while (controller.selectedIndex() < target) controller.handleKey(key("down"));
  while (controller.selectedIndex() > target) controller.handleKey(key("up"));
}

async function openTree(controller: ReturnType<typeof createWorkspaceController>) {
  await controller.openWorkspaceTarget();
  gotoTree(controller);
}

describe("file management: create (a / A)", () => {
  test("`a` creates a file via the input bar and auto-opens it", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt"); // root file → empty dir-prefix prefill
    controller.handleKey(key("a"));
    expect(controller.opsBar()?.kind).toBe("create-file");
    for (const ch of "new.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 40));
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("");
    // The new file is auto-opened in the editor.
    expect(controller.openFile()?.relPath).toBe("new.txt");
    expect(controller.focusRegion()).toBe("editor");
  });

  test("`A` (shift) creates a directory", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("a", { shift: true }));
    expect(controller.opsBar()?.kind).toBe("create-dir");
    for (const ch of "sub/dir") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 40));
    // mkdir -p created the nested directory; "sub" appears as a new top-level
    // entry (collapsed, so the nested "dir" is not in the flattened rows).
    expect(controller.rows().some((row) => row.node.relPath === "sub")).toBe(true);
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(root, "sub/dir")).catch(() => null))?.isDirectory()).toBe(true);
  });

  test("create refuses a path that escapes the project root", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("a"));
    for (const ch of "../escape.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.editorStatus()).toContain("escapes project root");
  });
});

describe("file management: move / copy (m / c)", () => {
  test("`m` moves a file and the tree reflects the new path", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("m"));
    expect(controller.opsBar()?.kind).toBe("move");
    // draft is prefilled with the dir prefix (root → ""); type the new name.
    for (const ch of "renamed.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.rows().some((row) => row.node.relPath === "renamed.txt")).toBe(true);
    expect(controller.rows().some((row) => row.node.relPath === "notes.txt")).toBe(false);
  });

  test("moving an OPEN editable buffer rekeys it (active path + dirty survive)", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    await controller.openPath("notes.txt");
    const inst = mockEditor("line one\nline two\nEDIT\n");
    controller.registerEditorInstance("notes.txt", inst);
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);

    gotoTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("m"));
    for (const ch of "moved.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 40));

    // The buffer rekeyed to the new path; the dirty flag survived.
    expect(controller.activeEditorPath()).toBe("moved.txt");
    expect(controller.dirtyPaths().has("moved.txt")).toBe(true);
    expect(controller.dirtyPaths().has("notes.txt")).toBe(false);
    expect(controller.editorOrder()).toContain("moved.txt");
    expect(controller.openFile()?.relPath).toBe("moved.txt");
  });

  test("renaming A onto an already-open B closes B's buffer (no duplicate, no clobber)", async () => {
    await writeFile(join(root, "target.md"), "---\narchetype: x\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    // Open B (target.md) as an editable buffer, then move A (notes.txt) onto it.
    await controller.openPath("target.md");
    const instB = mockEditor("---\narchetype: x\n---\nbody\n");
    controller.registerEditorInstance("target.md", instB);
    expect(controller.editorOrder()).toContain("target.md");

    gotoTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("m"));
    for (const ch of "target.md") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    // target.md exists → overwrite confirm; 'o' completes the move.
    expect(controller.dialog()?.kind).toBe("ops-overwrite");
    controller.handleKey(key("o"));
    await new Promise((r) => setTimeout(r, 40));

    // A rekeyed onto target.md; target.md appears exactly once in the pool.
    const targetCount = controller.editorOrder().filter((p) => p === "target.md").length;
    expect(targetCount).toBe(1);
    expect(controller.activeEditorPath()).toBe("target.md");
    expect(controller.editorOrder()).not.toContain("notes.txt");
  });

  test("`c` copies a file, leaving the source untouched", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("c"));
    for (const ch of "copy.txt") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 40));
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("line one\nline two\n");
    expect(await readFile(join(root, "copy.txt"), "utf8")).toBe("line one\nline two\n");
  });

  test("moving onto an existing target opens an overwrite confirm", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("m"));
    for (const ch of "workspace/cards/mira.md") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.dialog()?.kind).toBe("ops-overwrite");
    // 'o' overwrites; 'c' cancels.
    controller.handleKey(key("o"));
    await new Promise((r) => setTimeout(r, 40));
    expect(await readFile(join(root, "workspace/cards/mira.md"), "utf8")).toBe("line one\nline two\n");
    expect(controller.rows().some((row) => row.node.relPath === "notes.txt")).toBe(false);
  });

  test("confirming overwrite of a directory reports a clear error and preserves both entries", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("m"));
    for (const ch of "workspace/cards") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.dialog()?.kind).toBe("ops-overwrite");

    controller.handleKey(key("o"));
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.editorStatus()).toContain("directory and cannot be overwritten");
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("line one\nline two\n");
    expect(await readFile(join(root, "workspace/cards/mira.md"), "utf8")).toContain("archetype");
  });
});

describe("file management: delete (d)", () => {
  test("`d` moves a file to .vesicle/trash on confirm; any other key cancels", async () => {
    const controller = createWorkspaceController(root);
    await openTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("d"));
    expect(controller.dialog()?.kind).toBe("delete-confirm");
    // A non-y key cancels.
    controller.handleKey(key("n"));
    expect(controller.dialog()).toBeNull();
    expect(controller.rows().some((row) => row.node.relPath === "notes.txt")).toBe(true);

    controller.handleKey(key("d"));
    controller.handleKey(key("y"));
    // The dismissed dialog keeps input ownership until the trash move lands;
    // a fast second `d` must not open another delete confirm.
    controller.handleKey(key("d"));
    expect(controller.dialog()).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.rows().some((row) => row.node.relPath === "notes.txt")).toBe(false);
    expect(controller.editorStatus()).toContain("trash");
  });

  test("deleting the open file closes its buffer and viewer", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    await controller.openPath("notes.txt");
    expect(controller.openFile()?.relPath).toBe("notes.txt");
    gotoTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("d"));
    controller.handleKey(key("y"));
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.openFile()).toBeNull();
    expect(controller.activeEditorPath()).toBeNull();
    expect(controller.focusRegion()).toBe("tree");
  });

  test("delete-confirm flags an unsaved open buffer", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    await controller.openPath("notes.txt");
    const inst = mockEditor("line one\nline two\nDIRTY\n");
    controller.registerEditorInstance("notes.txt", inst);
    controller.markEditorContentChanged("notes.txt");
    gotoTree(controller);
    selectInTree(controller, "notes.txt");
    controller.handleKey(key("d"));
    expect(controller.dialog()?.kind).toBe("delete-confirm");
    // The status line (read via the dialog state) reflects unsaved edits — the
    // dirty set still contains the path while the confirm is open.
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);
    controller.handleKey(key("escape")); // cancel
  });
});

describe("in-page validation: target and ownership (#118)", () => {
  test("tree `v` validates the selected file, not the previously open file", async () => {
    await writeFile(join(root, "workspace/cards/alpha.md"), "---\narchetype: x\n---\nbody\n");
    await writeFile(join(root, "workspace/cards/beta.md"), "---\narchetype: b\n---\nbody\n");
    const controller = createWorkspaceController(root);
    // Open alpha first — its verdict would wrongly attach to a later `v` under
    // the old behavior.
    await controller.openWorkspaceTarget("workspace/cards/alpha.md");
    const alphaSnap = controller.validationSnapshot();
    expect(alphaSnap.state).toBe("result");
    if (alphaSnap.state === "result") {
      expect(alphaSnap.path).toBe("workspace/cards/alpha.md");
    }

    gotoTree(controller);
    selectInTree(controller, "workspace/cards/beta.md");
    controller.handleKey(key("v"));
    await new Promise((r) => setTimeout(r, 30));
    // The snapshot now describes the selected beta, not the still-open alpha.
    expect(controller.findingsOpen()).toBe(true);
    const betaSnap = controller.validationSnapshot();
    expect(betaSnap.state).toBe("result");
    if (betaSnap.state === "result") {
      expect(betaSnap.path).toBe("workspace/cards/beta.md");
    }
  });

  test("cross-file findings: Enter is not reachable when the panel describes a different file than the open one (#118 review)", async () => {
    // tree `v` validates the selection WITHOUT opening it, so the panel can
    // describe beta while alpha is still the open editable buffer. Enter must
    // not jump — it would land beta's line in alpha.
    await writeFile(join(root, "workspace/cards/alpha.md"), "---\narchetype: x\n---\nbody\n");
    await writeFile(join(root, "workspace/cards/beta.md"), "---\narchetype: b\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/alpha.md");
    const inst = mockEditor("---\narchetype: x\n---\nbody\n");
    controller.registerEditorInstance("workspace/cards/alpha.md", inst);
    expect(controller.canEditOpenFile()).toBe(true);

    gotoTree(controller);
    selectInTree(controller, "workspace/cards/beta.md");
    controller.handleKey(key("v"));
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.findingsOpen()).toBe(true);
    expect(controller.canJumpToSelectedFinding()).toBe(false);
    // Enter is a no-op: no focus steal to the editor (would mean a jump ran).
    controller.handleKey(key("enter"));
    expect(controller.focusRegion()).toBe("tree");
  });

  test("tree `v` on a directory keeps the panel closed with a status hint", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    gotoTree(controller);
    selectInTree(controller, "workspace"); // a directory
    controller.handleKey(key("v"));
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.findingsOpen()).toBe(false);
    expect(controller.editorStatus()).toContain("select a file");
  });

  test("tree `v` on a dirty buffer refuses to validate the stale disk image", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    const inst = mockEditor("---\narchetype: x\n---\nbody\nDIRTY\n");
    controller.registerEditorInstance("workspace/cards/mira.md", inst);
    controller.markEditorContentChanged("workspace/cards/mira.md");
    gotoTree(controller);
    selectInTree(controller, "workspace/cards/mira.md");
    controller.handleKey(key("v"));
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.findingsOpen()).toBe(false);
    expect(controller.editorStatus()).toContain("save");
  });

  test("renaming the validated file rekeys the snapshot path (verdict survives)", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    expect(controller.validationSnapshot().state).toBe("result");
    gotoTree(controller);
    selectInTree(controller, "workspace/cards/mira.md");
    controller.handleKey(key("m"));
    // The move bar prefills the directory prefix; type only the new name.
    for (const ch of "renamed.md") controller.handleKey(key(ch));
    controller.handleKey(key("enter"));
    await new Promise((r) => setTimeout(r, 30));
    // The result is retained but now attributed to the new path.
    const rekeyedSnap = controller.validationSnapshot();
    expect(rekeyedSnap.state).toBe("result");
    if (rekeyedSnap.state === "result") {
      expect(rekeyedSnap.path).toBe("workspace/cards/renamed.md");
    }
  });
});

describe("in-page validation (v)", () => {
  test("opening a card runs the validators and the status summary reflects findings", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    const state = controller.validationState();
    expect(state.state).toBe("result");
    if (state.state === "result") {
      // mira.md has archetype frontmatter but no Module A sections → errors.
      expect(state.ok).toBe(false);
      expect(state.findings.some((f) => f.severity === "error")).toBe(true);
    }
  });

  test("`v` opens the findings panel; ↑↓ navigates; Enter jumps; Esc closes", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    // The buffer must be editable + registered for Enter to jump via gotoLine.
    const inst = mockEditor("---\narchetype: x\n---\nbody\n");
    controller.registerEditorInstance("workspace/cards/mira.md", inst);
    gotoTree(controller);
    controller.handleKey(key("v"));
    expect(controller.findingsOpen()).toBe(true);
    const state = controller.validationState();
    const count = state.state === "result" ? state.findings.length : 0;
    expect(count).toBeGreaterThan(0);
    // Walk down the list.
    controller.handleKey(key("down"));
    // Enter jumps to a finding's line (closes the panel, focuses the editor).
    controller.handleKey(key("enter"));
    expect(controller.findingsOpen()).toBe(false);
    expect(controller.focusRegion()).toBe("editor");
  });

  test("`v` on a non-card file reports no validator matched", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    expect(controller.validationState().state).toBe("no-match");
    gotoTree(controller);
    controller.handleKey(key("v"));
    expect(controller.findingsOpen()).toBe(true);
  });
});

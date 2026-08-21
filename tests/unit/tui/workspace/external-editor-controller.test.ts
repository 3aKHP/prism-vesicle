import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceController } from "../../../../src/tui/workspace";
import type { TuiKeyEvent } from "../../../../src/tui/decision-interaction";
import type { TextareaRenderable } from "@3akhp/opentui-core";

let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-ext-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "card.md"), "---\narchetype: x\n---\nbody\n");
  await writeFile(join(root, "sub/deep.md"), "---\narchetype: x\n---\nbody\n");
  // Pin env so editor resolution + settings.yaml are deterministic and don't
  // touch the real user config.
  savedEnv = { ...process.env };
  process.env.VESICLE_EDITOR = "mockedit";
  process.env.VESICLE_CONFIG_DIR = root;
});
afterEach(async () => {
  process.env = savedEnv;
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

/** Editor runtime that records the suspend/spawn/resume sequence without a tty. */
function mockRuntime() {
  const calls = { suspend: 0, resume: 0, spawn: [] as string[], exitCode: 0 };
  return {
    calls,
    runtime: {
      suspend: () => { calls.suspend += 1; },
      resume: () => { calls.resume += 1; },
      spawn: async (command: string, args: string[]) => {
        calls.spawn.push([command, ...args].join(" "));
        return calls.exitCode;
      },
    },
  };
}

function gotoTree(controller: ReturnType<typeof createWorkspaceController>): void {
  for (let i = 0; i < 4 && controller.focusRegion() !== "tree"; i += 1) {
    controller.handleKey(key("f6"));
  }
}

function selectInTree(controller: ReturnType<typeof createWorkspaceController>, relPath: string): void {
  const target = controller.rows().findIndex((row) => row.node.relPath === relPath);
  expect(target).toBeGreaterThanOrEqual(0);
  while (controller.selectedIndex() < target) controller.handleKey(key("down"));
  while (controller.selectedIndex() > target) controller.handleKey(key("up"));
}

describe("external editor handoff: target resolution + gate", () => {
  test("Ctrl+X from the editor region hands off the open file", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const inst = mockEditor("line one\nline two\n");
    controller.registerEditorInstance("notes.txt", inst);
    const { runtime, calls } = mockRuntime();
    controller.registerExternalEditor(runtime);

    expect(controller.handleKey(key("x", { ctrl: true }))).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.suspend).toBe(1);
    expect(calls.resume).toBe(1);
    // The file's absolute path is appended after the resolved editor command.
    expect(calls.spawn[0]).toBe(`mockedit ${join(root, "notes.txt")}`);
  });

  test("Ctrl+X from the tree hands off the selected file", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    gotoTree(controller);
    selectInTree(controller, "card.md");
    const { runtime, calls } = mockRuntime();
    controller.registerExternalEditor(runtime);

    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.spawn[0]).toBe(`mockedit ${join(root, "card.md")}`);
  });

  test("a dirty buffer is refused with a pointer to Ctrl+S", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const inst = mockEditor("line one\nline two\nDIRTY\n");
    controller.registerEditorInstance("notes.txt", inst);
    controller.markEditorContentChanged("notes.txt");
    expect(controller.dirtyPaths().has("notes.txt")).toBe(true);
    const { runtime, calls } = mockRuntime();
    controller.registerExternalEditor(runtime);

    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.suspend).toBe(0); // never spawned
    expect(controller.editorStatus()).toContain("Ctrl+S");
  });

  test("a directory selection is refused", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    gotoTree(controller);
    selectInTree(controller, "sub");
    const { runtime, calls } = mockRuntime();
    controller.registerExternalEditor(runtime);

    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.suspend).toBe(0);
    // A directory is not a handoff target → the "select a file" message fires.
    expect(controller.editorStatus()).toContain("select a file");
  });

  test("Ctrl+Shift+X does not trigger the handoff (shift guard)", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const { runtime, calls } = mockRuntime();
    controller.registerExternalEditor(runtime);
    // Ctrl+Shift+X must fall through (no handoff), so the editor keeps it.
    expect(controller.handleKey(key("x", { ctrl: true, shift: true }))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.suspend).toBe(0);
  });
});

describe("external editor handoff: refresh after return", () => {
  test("an unchanged file reports no changes and leaves the buffer alone", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const inst = mockEditor("line one\nline two\n");
    controller.registerEditorInstance("notes.txt", inst);
    controller.registerExternalEditor(mockRuntime().runtime);

    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(inst.calls.replaceText).toEqual([]); // no reload
    expect(controller.editorStatus()).toContain("no changes");
  });

  test("a changed file is reloaded into the buffer and revalidated", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("card.md");
    const inst = mockEditor("---\narchetype: x\n---\nbody\n");
    controller.registerEditorInstance("card.md", inst);
    controller.registerExternalEditor(mockRuntime().runtime);

    // Simulate the external editor writing new content (after the buffer opened).
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "card.md"), "---\narchetype: x\n---\n## Visual Cortex\n");

    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(inst.calls.replaceText).toContain("---\narchetype: x\n---\n## Visual Cortex\n");
    expect(controller.editorStatus()).toContain("reloaded");
  });

  test("a file deleted by the external editor closes its buffer", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const inst = mockEditor("line one\nline two\n");
    controller.registerEditorInstance("notes.txt", inst);
    controller.registerExternalEditor(mockRuntime().runtime);

    await rm(join(root, "notes.txt"));
    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.activeEditorPath()).toBeNull();
    expect(controller.openFile()).toBeNull();
    expect(controller.editorStatus()).toContain("removed");
  });

  test("a file that was not open just refreshes the tree", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt"); // something else is open
    gotoTree(controller);
    selectInTree(controller, "card.md"); // card.md is not open
    controller.registerExternalEditor(mockRuntime().runtime);

    // External editor adds a sibling file at the root.
    await new Promise((r) => setTimeout(r, 25));
    await writeFile(join(root, "sibling.md"), "new\n");
    controller.handleKey(key("x", { ctrl: true }));
    await new Promise((r) => setTimeout(r, 30));
    // The tree picked up the new file (cache invalidated + rebuilt).
    expect(controller.quickMatches()).toContain("sibling.md");
  });
});

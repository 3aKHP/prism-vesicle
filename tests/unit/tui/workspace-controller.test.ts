import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-ctrl-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await mkdir(join(root, "novels"), { recursive: true });
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n\nA card.\n");
  await writeFile(join(root, "novels/draft.md"), "draft\n");
  await writeFile(join(root, "notes.txt"), "line one\n");
  await writeFile(join(root, ".hidden.md"), "secret\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function key(name: string, mods: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ...mods } as TuiKeyEvent;
}

describe("workspace controller: page and loading", () => {
  test("switching to the workspace page loads the tree and index", async () => {
    const controller = createWorkspaceController(root);
    expect(controller.activePage()).toBe("chat");
    await controller.openWorkspaceTarget();
    expect(controller.activePage()).toBe("workspace");
    const names = controller.rows().map((row) => row.node.name);
    expect(names).toContain("workspace");
    expect(names).toContain("notes.txt");
    expect(names).not.toContain(".hidden.md");
    expect(controller.quickMatches().length).toBeGreaterThan(0);
  });

  test("openPath opens a markdown file in preview mode with editor focus", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    const opened = await controller.openPath("workspace/cards/mira.md");
    expect(opened).toBe(true);
    expect(controller.openFile()?.relPath).toBe("workspace/cards/mira.md");
    expect(controller.openFile()?.kind).toBe("markdown");
    expect(controller.viewMode()).toBe("preview");
    expect(controller.focusRegion()).toBe("editor");
    controller.toggleViewMode();
    expect(controller.viewMode()).toBe("source");
  });

  test("locatePath expands ancestors and selects directories, rejects escapes", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    expect(await controller.locatePath("../outside")).toBeNull();
    expect(await controller.locatePath("/abs/path")).toBeNull();
    expect(await controller.locatePath("C:\\abs\\path")).toBeNull();
    expect(await controller.locatePath("workspace/\0bad")).toBeNull();
    expect(await controller.locatePath("no/such/thing")).toBeNull();

    expect(await controller.locatePath("workspace")).toBe("dir");
    const selected = controller.rows()[controller.rows().findIndex((row) => row.node.relPath === "workspace")];
    expect(selected?.expanded).toBe(true);

    expect(await controller.locatePath("workspace/cards/mira.md")).toBe("file");
    expect(controller.openFile()?.relPath).toBe("workspace/cards/mira.md");
    // ancestors of the file were expanded so the tree row exists
    expect(controller.rows().some((row) => row.node.relPath === "workspace/cards/mira.md")).toBe(true);
  });
});

describe("workspace controller: keyboard focus model", () => {
  test("tree keys navigate, enter expands a directory, and input is swallowed", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    const first = controller.selectedIndex();
    expect(controller.handleKey(key("down"))).toBe(true);
    expect(controller.selectedIndex()).toBe(first + 1);
    expect(controller.handleKey(key("up"))).toBe(true);
    expect(controller.selectedIndex()).toBe(first);
    // printable keys are swallowed by the focused tree, not sent anywhere
    expect(controller.handleKey(key("x"))).toBe(true);

    // Enter on a directory expands it asynchronously.
    const dirIndex = controller.rows().findIndex((row) => row.node.relPath === "workspace");
    while (controller.selectedIndex() < dirIndex) controller.handleKey(key("down"));
    while (controller.selectedIndex() > dirIndex) controller.handleKey(key("up"));
    expect(controller.handleKey(key("enter"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.rows()[dirIndex]?.expanded).toBe(true);
    expect(controller.rows().some((row) => row.node.relPath === "workspace/cards")).toBe(true);
  });

  test("escape steps focus back tree -> composer; F6 cycles regions", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    expect(controller.focusRegion()).toBe("tree");
    controller.handleKey(key("escape"));
    expect(controller.focusRegion()).toBe("composer");
    // composer region lets keys fall through to the shared composer
    expect(controller.handleKey(key("x"))).toBe(false);
    // F6 cycles; without an open file the editor region is skipped
    controller.handleKey(key("f6"));
    expect(controller.focusRegion()).toBe("tree");
    controller.handleKey(key("f6"));
    expect(controller.focusRegion()).toBe("composer");
    controller.handleKey(key("f6", { shift: true }));
    expect(controller.focusRegion()).toBe("tree");
  });

  test("editable markdown: m is one-way (preview→source); Esc unwinds source→preview→tree", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    await controller.openPath("workspace/cards/mira.md");
    expect(controller.focusRegion()).toBe("editor");
    expect(controller.viewMode()).toBe("preview");
    // m in preview enters the editable source
    controller.handleKey(key("m"));
    expect(controller.viewMode()).toBe("source");
    expect(controller.isEditing()).toBe(true);
    // m in editable source falls through to the textarea (B3: m types, D4 text
    // input exclusion) — it does NOT toggle back to preview
    expect(controller.handleKey(key("m"))).toBe(false);
    expect(controller.viewMode()).toBe("source");
    // Esc unwinds one level: markdown source → preview (still editor region)
    controller.handleKey(key("escape"));
    expect(controller.viewMode()).toBe("preview");
    expect(controller.focusRegion()).toBe("editor");
    // Esc again: preview → tree
    controller.handleKey(key("escape"));
    expect(controller.focusRegion()).toBe("tree");
    // F6 returns to the editor region
    controller.handleKey(key("f6"));
    expect(controller.focusRegion()).toBe("editor");
  });

  test("keymap review patches: q aliases escape in tree/viewer, hjkl normalize, right opens files", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    // hjkl drive the tree selection like arrows (D4)
    const first = controller.selectedIndex();
    controller.handleKey(key("j"));
    expect(controller.selectedIndex()).toBe(first + 1);
    controller.handleKey(key("k"));
    expect(controller.selectedIndex()).toBe(first);
    // quick open still receives literal hjkl as query text
    controller.handleKey(key("p", { ctrl: true }));
    controller.handleKey(key("j"));
    expect(controller.quickQuery()).toBe("j");
    controller.handleKey(key("escape"));

    // right on a file row opens it in the viewer with editor focus (D1)
    const fileIndex = controller.rows().findIndex((row) => row.node.relPath === "notes.txt");
    while (controller.selectedIndex() < fileIndex) controller.handleKey(key("down"));
    while (controller.selectedIndex() > fileIndex) controller.handleKey(key("up"));
    controller.handleKey(key("right"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.openFile()?.relPath).toBe("notes.txt");
    expect(controller.focusRegion()).toBe("editor");
    expect(controller.isEditing()).toBe(true);

    // notes.txt is an editable source: q falls through to the textarea (D4 —
    // q/hjkl are inert while text input is active), so focus does not move.
    expect(controller.handleKey(key("q"))).toBe(false);
    expect(controller.focusRegion()).toBe("editor");
    // Esc (clean) returns to the tree; q then aliases Esc at the tree level.
    controller.handleKey(key("escape"));
    expect(controller.focusRegion()).toBe("tree");
    controller.handleKey(key("q"));
    expect(controller.focusRegion()).toBe("composer");
  });

  test("hidden toggle and refresh keep the tree usable", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    await controller.toggleHidden();
    expect(controller.rows().some((row) => row.node.name === ".hidden.md")).toBe(true);
    await controller.toggleHidden();
    expect(controller.rows().some((row) => row.node.name === ".hidden.md")).toBe(false);
    await writeFile(join(root, "fresh.txt"), "new\n");
    await controller.refresh();
    expect(controller.rows().some((row) => row.node.name === "fresh.txt")).toBe(true);
    expect(controller.quickMatches().some((path) => path === "fresh.txt")).toBe(true);
  });
});

describe("workspace controller: quick open", () => {
  test("ctrl+p opens the panel, typing filters, enter opens the match", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    expect(controller.handleKey(key("p", { ctrl: true }))).toBe(true);
    expect(controller.quickOpenActive()).toBe(true);

    for (const ch of ["m", "i", "r", "a"]) controller.handleKey(key(ch));
    expect(controller.quickQuery()).toBe("mira");
    expect(controller.quickMatches()[0]).toBe("workspace/cards/mira.md");

    controller.handleKey(key("backspace"));
    expect(controller.quickQuery()).toBe("mir");

    expect(controller.handleKey(key("enter"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.quickOpenActive()).toBe(false);
    expect(controller.openFile()?.relPath).toBe("workspace/cards/mira.md");
  });

  test("escape closes the panel without opening anything", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    controller.handleKey(key("p", { ctrl: true }));
    controller.handleKey(key("escape"));
    expect(controller.quickOpenActive()).toBe(false);
    expect(controller.openFile()).toBeNull();
  });
});

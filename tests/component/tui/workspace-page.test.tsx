import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspacePage } from "../../../src/tui/views/WorkspacePage";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vesicle-ws-page-"));
  await mkdir(join(root, "workspace/cards"), { recursive: true });
  await writeFile(join(root, "workspace/cards/mira.md"), "# Mira\n\nA card body.\n");
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function renderPage(controller: ReturnType<typeof createWorkspaceController>, width = 100, height = 24) {
  return testRender(() => (
    <WorkspacePage
      controller={controller}
      projectRoot={root}
      width={width}
      height={height}
      treeWidth={30}
      compact={width < 96}
    />
  ), { width, height });
}

describe("tui: workspace page (B2)", () => {
  test("renders the file tree with directories and files", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Files");
    expect(frame).toContain("workspace");
    expect(frame).toContain("notes.txt");
    expect(frame).toContain("No file open");
  });

  test("opening a markdown file shows the preview in the viewer", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("workspace/cards/mira.md");
    expect(frame).toContain("md · preview");
    // Note: the preview body renders through OpenTUI's <markdown> element, which
    // the headless testRender harness does not rasterize (same limitation as
    // MessageStream and SideQuestionOverlay tests). Markdown rendering is
    // verified in the real terminal, so this frame asserts only the chrome:
    // preview mode is active (numbered source lines are not shown).
    expect(frame).not.toContain("1  # Mira");
  });

  test("editable text source renders the file content in the textarea", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("notes.txt");
    // B3: notes.txt is editable, so source mode is the live textarea (with a
    // line_number gutter) rather than the B2 read-only numbered <text>. The
    // headless harness rasterizes the textarea, so the body is visible.
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    expect(controller.isEditing()).toBe(true);
  });

  test("an empty editable file keeps the full editor width while typing", async () => {
    // Regression: the textarea had no explicit width, so Yoga sized it to its
    // content — an empty/small file collapsed the editor to a 1-column
    // viewport and every typed char scrolled the line out of view.
    await writeFile(join(root, "fresh.txt"), "");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("fresh.txt");
    const setup = await renderPage(controller);
    await setup.flush();
    await setup.mockInput.typeText("abcdefghij");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("abcdefghij");
  });

  test("image files show metadata instead of contents", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("logo.png");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("logo.png");
    expect(frame).toContain("image file");
    expect(frame).toContain("inline-renderable");
  });

  test("symlink files show metadata without loading the target", async () => {
    await symlink(join(root, "notes.txt"), join(root, "notes-link.txt"));
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes-link.txt");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("symbolic link");
    expect(frame).toContain("targets are not loaded");
    expect(frame).not.toContain("line one");
  });

  test("editable source shows the editor status line with key hints", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    // The D5 low-band hint bar sits below the viewer: the active buffer name,
    // cursor readout, and the frozen editor keymap (B3 plan §4.5).
    expect(frame).toContain("notes.txt");
    expect(frame).toContain("Ln 1:1");
    expect(frame).toContain("Ctrl+S save");
    expect(frame).toContain("Ctrl+F find");
  });

  test("oversized files open read-only with numbered source, not the editor", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(600 * 1024));
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("big.txt");
    expect(controller.isEditing()).toBe(false);
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    // The read-only viewer path: the title flags it as truncated, and the
    // status line names the viewing mode (no Ctrl+S editor hint).
    expect(frame).toContain("big.txt");
    expect(frame).toContain("truncated");
    expect(frame).not.toContain("Ctrl+S save");
  });

  test("a dirty-on-close confirm surfaces in the status line", async () => {
    // The status bar must actually carry the "unsaved edits" prompt (and in a
    // real terminal it renders amber+bold via the warn tone). The headless
    // frame is text-only, so this asserts the prompt is present and the neutral
    // editor hint is replaced by it.
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(root, "notes.txt"), "line one\nline two\nDIRTY\n");
    // Register a mock instance so the controller sees the buffer as dirty.
    const inst = {
      get plainText() { return "line one\nline two\nDIRTY\n"; },
      setSelection: () => {},
      gotoLine: () => {},
      insertText: () => {},
      replaceText: () => {},
    } as unknown as import("@opentui/core").TextareaRenderable;
    controller.registerEditorInstance("notes.txt", inst);
    controller.markEditorContentChanged("notes.txt");
    controller.handleKey({ name: "escape" });
    expect(controller.dialog()?.kind).toBe("dirty-confirm");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("unsaved edits");
    expect(frame).toContain("y save");
  });

  test("opening a card surfaces a validation summary in the status line", async () => {
    await writeFile(join(root, "card.md"), "---\narchetype: x\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("card.md");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    // mira.md-shaped card → character-card validator applies, reports missing
    // sections. The status line carries a pure ✗ summary and a single
    // `v findings` action (never the old duplicated `v view`).
    expect(frame).toContain("✗");
    expect(frame).toContain("v findings");
    expect(frame).not.toContain("v view");
    // Exactly one `v findings` action — the duplicate-action bug is gone.
    expect(frame.split("v findings").length - 1).toBe(1);
  });

  test("a non-editable oversized Markdown advertises `m source`, not `m edit`", async () => {
    // Issue #118 §4: `m edit` must require an admitted editable buffer. An
    // oversized Markdown is not editable, so the toggle hint degrades to the
    // truthful `m source` (switch to a read-only source view).
    await writeFile(join(root, "big.md"), `---\narchetype: x\n---\n${"x".repeat(600 * 1024)}\n`);
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("big.md");
    expect(controller.canEditOpenFile()).toBe(false);
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("m source");
    expect(frame).not.toContain("m edit");
  });

  test("a non-editable target omits `Enter jump` from the findings footer", async () => {
    // Issue #118 §4/§7: Enter only jumps when an editable buffer is admitted.
    await writeFile(join(root, "big.md"), `---\narchetype: x\n---\n${"x".repeat(600 * 1024)}\n`);
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("big.md");
    controller.handleKey({ name: "v" }); // viewer-focus v opens findings
    expect(controller.findingsOpen()).toBe(true);
    expect(controller.canJumpToSelectedFinding()).toBe(false);
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).not.toContain("Enter jump");
  });

  test("the findings header keeps the verdict visible for a long card path (#118 §8)", async () => {
    // Regression: the header budget arithmetic used the full panel width and
    // ignored the summary, so a moderately long path clipped the ✗ verdict.
    const longName = "a-very-long-character-card-name-exceeding-the-panel.md";
    await writeFile(join(root, `workspace/cards/${longName}`), "---\narchetype: x\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget(`workspace/cards/${longName}`);
    controller.handleKey({ name: "v" });
    expect(controller.findingsOpen()).toBe(true);
    const setup = await renderPage(controller, 80, 24);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("findings:");
    expect(frame).toContain("✗");
  });

  test("`v` opens the findings panel with the validator findings", async () => {
    await writeFile(join(root, "card.md"), "---\narchetype: x\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("card.md");
    // Walk to the tree and open the findings panel.
    for (let i = 0; i < 4 && controller.focusRegion() !== "tree"; i += 1) {
      controller.handleKey({ name: "f6" });
    }
    controller.handleKey({ name: "v" });
    expect(controller.findingsOpen()).toBe(true);
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("findings:");
    expect(frame).toContain("missing mandatory section");
    expect(frame).toContain("Enter jump");
  });

  test("quick open panel lists fuzzy matches above the page", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget();
    controller.openQuickOpen();
    for (const ch of ["m", "i", "r", "a"]) controller.handleKey({ name: ch });
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Open file: mira");
    expect(frame).toContain("workspace/cards/mira.md");
    expect(frame).toContain("Enter open");
  });

  test("compact width shows only the focused region", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("workspace/cards/mira.md");
    const setup = await renderPage(controller, 80, 20);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    // editor focused: the viewer fills the compact page, tree is hidden
    expect(frame).toContain("workspace/cards/mira.md");
    expect(frame).not.toContain("notes.txt");
  });

  test("moving up from a long line keeps the short line's start visible", async () => {
    // Regression for the OpenTUI horizontal-scroll bug: landing the cursor on
    // a line longer than the viewport scrolls right; moving to a shorter line
    // left offsetX stale, so the shorter line rendered with its start cut off.
    // Line 1 is the long line (drives the scroll), line 2 the short victim.
    await writeFile(join(root, "lines.txt"), `${"x".repeat(80)}\nshort top line\n`);
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("lines.txt");
    // Narrow viewport so the 80-char line overflows the textarea.
    const setup = await testRender(() => (
      <WorkspacePage controller={controller} projectRoot={root} width={50} height={10} treeWidth={20} compact={false} />
    ), { width: 50, height: 10 });
    await setup.flush();

    // Walk the cursor right along the long line 1 until the viewport scrolls.
    for (let i = 0; i < 70; i += 1) await setup.mockInput.pressArrow("right");
    await setup.flush();
    // Down to the short line 2; the stale-offset reset is deferred via setTimeout.
    await setup.mockInput.pressArrow("down");
    await new Promise((r) => setTimeout(r, 15));
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    // The full short line must be readable — without the fix, the stale offset
    // hides it entirely (line 2 is only 14 chars, all left of the offset).
    expect(frame).toContain("short top line");
  });

  test("a save confirmation surfaces in the status row (#118 review: status text restored)", async () => {
    // The statusLine refactor had dropped the `${note}` suffix; controller
    // status() messages (save/reload/refusal/error) must be visible again.
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    // typeText does not route through onContentChange in this harness, so drive
    // dirty + save through a mock instance the way the controller unit tests do,
    // and set the state BEFORE rendering so the first frame already shows it.
    const inst = {
      get plainText() { return "line one\nline two\nEDIT\n"; },
      setSelection: () => {}, gotoLine: () => {}, insertText: () => {}, replaceText: () => {},
    } as unknown as import("@opentui/core").TextareaRenderable;
    controller.registerEditorInstance("notes.txt", inst);
    controller.markEditorContentChanged("notes.txt");
    await controller.saveActive();
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("saved");
  });

  test("a dirty preview-mode Markdown does not advertise `v findings` (#118 review)", async () => {
    // A dirty buffer under a read-only preview: `v` would refuse (dirty guard),
    // so the viewer row must not advertise `v findings` as a reachable action.
    await writeFile(join(root, "card.md"), "---\narchetype: x\n---\nbody\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("card.md");
    const inst = {
      get plainText() { return "---\narchetype: x\n---\nbody\nDIRTY\n"; },
      setSelection: () => {}, gotoLine: () => {}, insertText: () => {}, replaceText: () => {},
    } as unknown as import("@opentui/core").TextareaRenderable;
    controller.registerEditorInstance("card.md", inst);
    controller.markEditorContentChanged("card.md");
    expect(controller.dirtyPaths().has("card.md")).toBe(true);
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).not.toContain("v findings");
    expect(frame).toContain("validation stale");
  });

  test("a long document never paints over the shell's bottom surface", async () => {
    // Regression for the B2 overlap bug: the page used an explicit height that
    // ignored the dynamically sized BottomSurface, so long viewer content
    // painted over the composer. The page must flex-fill the main row instead.
    // B3 adds a one-row editor status line between the viewer and the composer;
    // the document must stay inside the viewer, above that status line.
    const longLines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} content`);
    await writeFile(join(root, "long.txt"), longLines.join("\n") + "\n");
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("long.txt");
    const setup = await testRender(() => (
      <box flexDirection="column" width="100%" height="100%">
        <box height={3} border>
          <text content="HEADER" wrapMode="none" />
        </box>
        <box flexDirection="row" flexGrow={1}>
          <WorkspacePage
            controller={controller}
            projectRoot={root}
            width={100}
            height={17}
            treeWidth={30}
            compact={false}
          />
        </box>
        <box height={3} border>
          <text content="COMPOSER" wrapMode="none" />
        </box>
        <box height={1}>
          <text content="FOOTER" wrapMode="none" />
        </box>
      </box>
    ), { width: 100, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const rows = frame.split("\n");
    const composerRow = rows.findIndex((row) => row.includes("COMPOSER"));
    expect(composerRow).toBeGreaterThan(0);
    // findIndex lands on the COMPOSER content row; the composer's top border
    // is one above, and the editor status line is two above (between the
    // viewer's bottom border and the composer).
    const statusRow = composerRow - 2;
    expect(rows[statusRow]).toContain("long.txt");
    expect(rows[statusRow]).toContain("Ctrl+S");
    expect(rows[statusRow - 1]).toContain("└"); // viewer bottom border
    // No document body text may appear on or below the status line: the
    // editable buffer must stay bounded inside the viewer.
    for (let i = statusRow; i < rows.length; i += 1) {
      expect(rows[i]).not.toContain(" content");
    }
  });
});

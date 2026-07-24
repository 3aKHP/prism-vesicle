import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

    // The read-only viewer path: the title flags it, and the status line says
    // read-only (no Ctrl+S editor hint).
    expect(frame).toContain("big.txt");
    expect(frame).toContain("read-only");
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

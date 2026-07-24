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

  test("source mode shows numbered lines after toggling", async () => {
    const controller = createWorkspaceController(root);
    await controller.openWorkspaceTarget("notes.txt");
    const setup = await renderPage(controller);
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("notes.txt");
    expect(frame).toContain("1  line one");
    expect(frame).toContain("2  line two");
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
});

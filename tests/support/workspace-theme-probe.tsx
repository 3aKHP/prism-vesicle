import { parseColor, type Renderable, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paletteFor, setThemePreference, type ThemeMode } from "../../src/tui/theme";
import { createWorkspaceController } from "../../src/tui/workspace";
import { WorkspacePage } from "../../src/tui/workspace/view";

function findTextarea(renderable: Renderable): TextareaRenderable | undefined {
  if (renderable instanceof TextareaRenderable) return renderable;
  for (const child of renderable.getChildren()) {
    const found = child instanceof TextareaRenderable ? child : findTextarea(child as Renderable);
    if (found) return found;
  }
  return undefined;
}

function assertColor(actual: number[], expectedHex: string, phase: string): void {
  const expected = parseColor(expectedHex).toInts();
  if (actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${phase}: expected ${expected.join(",")}, received ${actual.join(",")}`);
  }
}

function assertEditor(
  setup: Awaited<ReturnType<typeof testRender>>,
  textarea: TextareaRenderable,
  mode: ThemeMode,
  phase: string,
): void {
  const colors = paletteFor(mode);
  assertColor(textarea.textColor.toInts(), colors.textPrimary, `${phase} text`);
  assertColor(textarea.cursorColor.toInts(), colors.editorCursor, `${phase} cursor`);
  assertColor(textarea.selectionBg?.toInts() ?? [], colors.selectionBackground, `${phase} selection background property`);
  assertColor(textarea.selectionFg?.toInts() ?? [], colors.selectionForeground, `${phase} selection foreground property`);
  const selected = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text === "line" && span.bg.toInts()[3] !== 0);
  if (!selected) throw new Error(`${phase}: missing selected Workspace span`);
  assertColor(selected.fg.toInts(), colors.selectionForeground, `${phase} selected foreground`);
  assertColor(selected.bg.toInts(), colors.selectionBackground, `${phase} selected background`);
  if (textarea.getSelectedText() !== "line") throw new Error(`${phase}: selected text changed`);
}

const root = await mkdtemp(join(tmpdir(), "vesicle-workspace-theme-"));
try {
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "notes.txt"), "line one\nline two\n");
  setThemePreference("light");
  const controller = createWorkspaceController(root);
  await controller.openWorkspaceTarget("notes.txt");
  const setup = await testRender(() => (
    <WorkspacePage
      controller={controller}
      projectRoot={root}
      width={100}
      height={24}
      treeWidth={30}
      compact={false}
    />
  ), { width: 100, height: 24 });
  await setup.flush();
  const textarea = findTextarea(setup.renderer.root);
  if (!textarea) throw new Error("Workspace textarea was not mounted");
  textarea.setSelection(0, 4);
  await setup.flush();
  assertEditor(setup, textarea, "light", "light mount");
  setThemePreference("dark");
  await setup.flush();
  assertEditor(setup, textarea, "dark", "light to dark");
  setup.renderer.destroy();
  console.log("Workspace theme refresh passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

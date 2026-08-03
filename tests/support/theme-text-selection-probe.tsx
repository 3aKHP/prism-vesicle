import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, setThemePreference, type ThemeMode } from "../../src/tui/theme";
import { ThemedText } from "../../src/tui/theme-text";

function assertSelection(
  setup: Awaited<ReturnType<typeof testRender>>,
  mode: ThemeMode,
  phase: string,
): void {
  const selected = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.trim().length > 0 && span.bg.toInts()[3] !== 0);
  if (!selected) throw new Error(`${phase}: missing selected span`);
  const expectedForeground = parseColor(paletteFor(mode).selectionForeground).toInts();
  const expectedBackground = parseColor(paletteFor(mode).selectionBackground).toInts();
  if (selected.fg.toInts().some((value, index) => value !== expectedForeground[index])) {
    throw new Error(`${phase}: selection foreground did not refresh`);
  }
  if (selected.bg.toInts().some((value, index) => value !== expectedBackground[index])) {
    throw new Error(`${phase}: selection background did not refresh`);
  }
  if (setup.renderer.getSelection()?.getSelectedText() !== "select") {
    throw new Error(`${phase}: selected text changed`);
  }
}

for (const [initial, next] of [["dark", "light"], ["light", "dark"]] as const) {
  setThemePreference(initial);
  const setup = await testRender(
    () => <ThemedText content="select this text" />,
    { width: 30, height: 3 },
  );
  await setup.flush();
  await setup.mockMouse.drag(0, 0, 6, 0);
  await setup.flush();
  assertSelection(setup, initial, `${initial} mount`);
  setThemePreference(next);
  await setup.flush();
  assertSelection(setup, next, `${initial} to ${next}`);
  setup.renderer.destroy();
}

console.log("ThemedText selection refresh passed");

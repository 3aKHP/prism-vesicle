import { fg, parseColor, StyledText, type TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, setThemePreference, type ThemeMode } from "../../src/tui/theme";
import { ThemedText } from "../../src/tui/theme-text";

function assertSelection(
  setup: Awaited<ReturnType<typeof testRender>>,
  mode: ThemeMode,
  phase: string,
  selectedText: string,
  minimumSelectedLines: number,
): void {
  const expectedForeground = parseColor(paletteFor(mode).selectionForeground).toInts();
  const expectedBackground = parseColor(paletteFor(mode).selectionBackground).toInts();
  const selectedLines = setup.captureSpans().lines
    .map((line) => line.spans.filter((span) => (
      span.bg.toInts().every((value, index) => value === expectedBackground[index])
    )))
    .filter((spans) => spans.length > 0);
  if (selectedLines.length < minimumSelectedLines) {
    throw new Error(
      `${phase}: expected selection on ${minimumSelectedLines} line(s), received ${selectedLines.length}; selected=${JSON.stringify(selectedText)}\n${setup.captureCharFrame()}`,
    );
  }
  if (selectedLines.flat().some((span) => (
    span.fg.toInts().some((value, index) => value !== expectedForeground[index])
  ))) {
    throw new Error(`${phase}: selection foreground did not refresh uniformly`);
  }
  if (setup.renderer.getSelection()?.getSelectedText() !== selectedText) {
    throw new Error(`${phase}: selected text changed`);
  }
}

const scenarios = [
  {
    name: "plain-text",
    content: "select this text",
    drag: [0, 0, 6, 0] as const,
    height: 1,
    minimumSelectedLines: 1,
  },
  {
    name: "styled-multiline-wide-text",
    content: new StyledText([
      fg("#ef4444")("red 中文🙂\n"),
      fg("#2563eb")("blue 界 text"),
    ]),
    drag: [0, 0, 8, 1] as const,
    height: 2,
    minimumSelectedLines: 2,
  },
] as const;

for (const [initial, next] of [["dark", "light"], ["light", "dark"]] as const) {
  for (const scenario of scenarios) {
    setThemePreference(initial);
    let text: TextRenderable | undefined;
    const setup = await testRender(
      () => (
        <ThemedText
          ref={(value: TextRenderable) => { text = value; }}
          content={typeof scenario.content === "string" ? scenario.content : ""}
          height={scenario.height}
        />
      ),
      { width: 40, height: 4 },
    );
    try {
      await setup.flush();
      if (scenario.content instanceof StyledText) {
        if (!text) throw new Error(`${scenario.name}: text renderable was not mounted`);
        text.content = scenario.content;
        await setup.flush();
      }
      await setup.mockMouse.drag(
        scenario.drag[0],
        scenario.drag[1],
        scenario.drag[2],
        scenario.drag[3],
      );
      await setup.flush();
      const selectedText = setup.renderer.getSelection()?.getSelectedText();
      if (!selectedText) throw new Error(`${scenario.name} ${initial} mount: selection was empty`);
      assertSelection(setup, initial, `${scenario.name} ${initial} mount`, selectedText, scenario.minimumSelectedLines);
      setThemePreference(next);
      await setup.flush();
      assertSelection(setup, next, `${scenario.name} ${initial} to ${next}`, selectedText, scenario.minimumSelectedLines);
    } finally {
      setup.renderer.destroy();
    }
  }
}

console.log("ThemedText selection refresh passed");

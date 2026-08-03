import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, setThemePreference, type ThemeMode } from "../../src/tui/theme";
import { MarkdownContent } from "../../src/tui/widgets/MarkdownContent";

type Scenario = {
  name: string;
  content: string;
  needle: string;
  initial: ThemeMode;
  next: ThemeMode;
  dragFromLineStart?: boolean;
  minimumSelectedSpans?: number;
};

const scenarios: Scenario[] = [
  { name: "prose", content: "# Heading\n\nprose alpha", needle: "alpha", initial: "light", next: "dark" },
  {
    name: "list",
    content: "# Heading\n\n- list beta",
    needle: "list beta",
    initial: "dark",
    next: "light",
    dragFromLineStart: true,
    minimumSelectedSpans: 2,
  },
  {
    name: "link",
    content: "# Heading\n\n[link epsilon](https://example.com)",
    needle: "epsilon",
    initial: "light",
    next: "dark",
  },
  { name: "fenced-code", content: "```ts\ncode gamma\n```", needle: "code", initial: "dark", next: "light" },
  {
    name: "table-cell",
    content: "| Head | Value |\n| --- | --- |\n| row | table delta |",
    needle: "delta",
    initial: "light",
    next: "dark",
  },
];

const requested = process.env.VESICLE_MARKDOWN_SELECTION_SCENARIO;
const scenario = scenarios.find((candidate) => candidate.name === requested);
if (!scenario) throw new Error(`Unknown Markdown selection scenario: ${requested ?? "(missing)"}`);

function colorMatches(actual: number[], expected: number[]): boolean {
  return actual.every((value, index) => value === expected[index]);
}

function findNeedle(frame: string, needle: string, phase: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = 0; y < lines.length; y += 1) {
    const x = lines[y]!.indexOf(needle);
    if (x >= 0) return { x, y };
  }
  throw new Error(`${phase}: missing ${JSON.stringify(needle)} in frame\n${frame}`);
}

async function waitForNeedle(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string,
  phase: string,
): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (frame.includes(needle)) return findNeedle(frame, needle, phase);
    await Bun.sleep(10);
  }
  return findNeedle(setup.captureCharFrame(), needle, phase);
}

function assertSelectedColors(
  setup: Awaited<ReturnType<typeof testRender>>,
  mode: ThemeMode,
  phase: string,
  minimumSelectedSpans: number,
): void {
  const colors = paletteFor(mode);
  const expectedForeground = parseColor(colors.selectionForeground).toInts();
  const expectedBackground = parseColor(colors.selectionBackground).toInts();
  const selected = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .filter((span) => colorMatches(span.bg.toInts(), expectedBackground));
  if (selected.length < minimumSelectedSpans) {
    throw new Error(`${phase}: expected ${minimumSelectedSpans} selected span(s), received ${selected.length}`);
  }
  if (selected.some((span) => !colorMatches(span.fg.toInts(), expectedForeground))) {
    throw new Error(`${phase}: selected foreground did not use the theme pair`);
  }
}

setThemePreference(scenario.initial);
const setup = await testRender(
  () => <MarkdownContent content={scenario.content} />,
  { width: 60, height: 10 },
);
try {
  const point = await waitForNeedle(setup, scenario.needle, `${scenario.name} ${scenario.initial} mount`);
  await setup.mockMouse.drag(
    scenario.dragFromLineStart ? 0 : point.x,
    point.y,
    point.x + scenario.needle.length,
    point.y,
  );
  await setup.flush();
  const selectedText = setup.renderer.getSelection()?.getSelectedText();
  if (!selectedText) throw new Error(`${scenario.name} ${scenario.initial} mount: selection was empty`);
  assertSelectedColors(setup, scenario.initial, `${scenario.name} ${scenario.initial} mount`, scenario.minimumSelectedSpans ?? 1);
  setThemePreference(scenario.next);
  await setup.flush();
  assertSelectedColors(setup, scenario.next, `${scenario.name} ${scenario.initial} to ${scenario.next}`, scenario.minimumSelectedSpans ?? 1);
  if (setup.renderer.getSelection()?.getSelectedText() !== selectedText) {
    throw new Error(`${scenario.name} ${scenario.initial} to ${scenario.next}: selected text changed`);
  }
} finally {
  setup.renderer.destroy();
}
console.log(`Markdown selection theme propagation passed: ${scenario.name}`);

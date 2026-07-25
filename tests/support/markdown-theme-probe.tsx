import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, setThemePreference } from "../../src/tui/theme";
import { MarkdownContent } from "../../src/tui/widgets/MarkdownContent";
import { foregroundFor } from "./markdown-test-utils";

const content = "```\nplain code\n```";

function assertForeground(
  actual: [number, number, number, number],
  expected: [number, number, number, number],
  phase: string,
): void {
  if (actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${phase}: expected ${expected.join(",")}, received ${actual.join(",")}`);
  }
}

setThemePreference("dark");
const setup = await testRender(() => <MarkdownContent content={content} />, { width: 40, height: 5 });
await setup.flush();
assertForeground(
  foregroundFor(setup, "plain code"),
  parseColor(paletteFor("dark").textPrimary).toInts(),
  "dark mount",
);

setThemePreference("light");
await setup.flush();
assertForeground(
  foregroundFor(setup, "plain code"),
  parseColor(paletteFor("light").textPrimary).toInts(),
  "light refresh",
);

console.log("dark-to-light Markdown refresh passed");
setup.renderer.destroy();

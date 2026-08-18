import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@3akhp/opentui-core";
import { testRender } from "@3akhp/opentui-solid";
import { paletteFor, reportTerminalThemeMode, setThemePreference, type ThemeMode } from "../../../src/tui/theme";
import { ThemedText } from "../../../src/tui/theme-text";

function selectedColors(setup: Awaited<ReturnType<typeof testRender>>) {
  const selected = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.trim().length > 0 && span.bg.toInts()[3] !== 0);
  if (!selected) throw new Error("Missing selected text span");
  return { foreground: selected.fg.toInts(), background: selected.bg.toInts() };
}

function expectSelection(
  setup: Awaited<ReturnType<typeof testRender>>,
  mode: ThemeMode,
): void {
  const colors = selectedColors(setup);
  expect(colors.foreground).toEqual(parseColor(paletteFor(mode).selectionForeground).toInts());
  expect(colors.background).toEqual(parseColor(paletteFor(mode).selectionBackground).toInts());
}

afterEach(() => {
  setThemePreference("dark");
  reportTerminalThemeMode(null);
});

describe("ThemedText native selection colors", () => {
  for (const mode of ["dark", "light"] as const) {
    test(`uses the ${mode} pair without changing selected text`, async () => {
      setThemePreference(mode);
      const setup = await testRender(
        () => <ThemedText content="select this text" />,
        { width: 30, height: 3 },
      );
      await setup.flush();
      await setup.mockMouse.drag(0, 0, 6, 0);
      await setup.flush();

      expectSelection(setup, mode);
      expect(setup.renderer.getSelection()?.getSelectedText()).toBe("select");
      setup.renderer.destroy();
    });
  }

  test("refreshes active selections in both theme-switch directions", async () => {
    const probe = Bun.spawn([
      process.execPath,
      "--preload",
      "@3akhp/opentui-solid/preload",
      "tests/support/theme-text-selection-probe.tsx",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => probe.kill(), 10_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited.finally(() => clearTimeout(timeout)),
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`ThemedText selection probe failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain("ThemedText selection refresh passed");
  }, 15_000);
});

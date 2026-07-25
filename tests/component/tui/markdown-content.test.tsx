import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, reportTerminalThemeMode, setThemePreference } from "../../../src/tui/theme";
import { MarkdownContent } from "../../../src/tui/widgets/MarkdownContent";

const markdownWithUntaggedCode = [
  "Before code.",
  "",
  "```",
  "plain code",
  "```",
  "",
  "After code.",
].join("\n");

function foregroundFor(setup: Awaited<ReturnType<typeof testRender>>, text: string): [number, number, number, number] {
  const span = setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((candidate) => candidate.text.includes(text));
  if (!span) throw new Error(`Missing rendered span: ${text}`);
  return span.fg.toInts();
}

afterEach(() => {
  setThemePreference("dark");
  reportTerminalThemeMode(null);
});

describe("MarkdownContent theme colors", () => {
  test("uses readable light-theme text for untagged fenced code", async () => {
    setThemePreference("light");
    const setup = await testRender(
      () => <MarkdownContent content={markdownWithUntaggedCode} />,
      { width: 60, height: 10 },
    );
    await setup.flush();

    expect(foregroundFor(setup, "plain code")).toEqual(parseColor(paletteFor("light").textPrimary).toInts());
    setup.renderer.destroy();
  });

  test("refreshes mounted Markdown colors when the theme changes", async () => {
    const probe = Bun.spawn([
      process.execPath,
      "--preload",
      "@opentui/solid/preload",
      "tests/support/markdown-theme-probe.ts",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Markdown theme probe failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain("dark-to-light Markdown refresh passed");
  });
});

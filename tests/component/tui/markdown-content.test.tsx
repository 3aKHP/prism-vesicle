import { afterEach, describe, expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { paletteFor, reportTerminalThemeMode, setThemePreference } from "../../../src/tui/theme";
import { MarkdownContent } from "../../../src/tui/widgets/MarkdownContent";
import { foregroundFor } from "../../support/markdown-test-utils";

const markdownWithUntaggedCode = [
  "Before code.",
  "",
  "```",
  "plain code",
  "```",
  "",
  "After code.",
].join("\n");

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
      "tests/support/markdown-theme-probe.tsx",
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
    if (exitCode !== 0) throw new Error(`Markdown theme probe failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain("dark-to-light Markdown refresh passed");
  }, 15_000);
});

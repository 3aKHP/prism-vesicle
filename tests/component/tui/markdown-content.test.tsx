import { afterEach, describe, expect, test } from "bun:test";
import { CodeRenderable, MarkdownRenderable, parseColor, type Renderable, TextRenderable } from "@3akhp/opentui-core";
import { testRender } from "@3akhp/opentui-solid";
import { paletteFor, reportTerminalThemeMode, setThemePreference, syntaxStyle } from "../../../src/tui/theme";
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

function descendants(root: Renderable): Renderable[] {
  return root.getChildren().flatMap((child) => [child as Renderable, ...descendants(child as Renderable)]);
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
      "@3akhp/opentui-solid/preload",
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

  test("propagates the selection pair to Markdown prose and list markers", async () => {
    const light = paletteFor("light");
    let markdown: MarkdownRenderable | undefined;
    const setup = await testRender(() => (
      <markdown
        ref={(value: MarkdownRenderable) => { markdown = value; }}
        content={"prose alpha\n\n- list beta\n\n```ts\ncode gamma\n```"}
        syntaxStyle={syntaxStyle()}
        selectionBg={light.selectionBackground}
        selectionFg={light.selectionForeground}
        internalBlockMode="top-level"
      />
    ), { width: 60, height: 10 });
    await setup.renderOnce();
    expect(markdown).toBeDefined();
    const children = descendants(markdown!);
    const prose = children.find((child) => child instanceof CodeRenderable && child.plainText.includes("prose alpha"));
    const marker = children.find((child) => child instanceof TextRenderable && child.id.endsWith("-marker"));
    expect(prose).toBeDefined();
    expect(marker).toBeDefined();
    expect((prose as CodeRenderable).selectionBg?.toInts()).toEqual(parseColor(light.selectionBackground).toInts());
    expect((prose as CodeRenderable).selectionFg?.toInts()).toEqual(parseColor(light.selectionForeground).toInts());
    expect((marker as TextRenderable).selectionBg?.toInts()).toEqual(parseColor(light.selectionBackground).toInts());
    expect((marker as TextRenderable).selectionFg?.toInts()).toEqual(parseColor(light.selectionForeground).toInts());

    const dark = paletteFor("dark");
    markdown!.selectionBg = dark.selectionBackground;
    markdown!.selectionFg = dark.selectionForeground;
    markdown!.refreshStyles();
    const updatedChildren = descendants(markdown!);
    const updatedProse = updatedChildren.find((child) => child instanceof CodeRenderable && child.plainText.includes("prose alpha"));
    const updatedMarker = updatedChildren.find((child) => child instanceof TextRenderable && child.id.endsWith("-marker"));
    expect((updatedProse as CodeRenderable).selectionBg?.toInts()).toEqual(parseColor(dark.selectionBackground).toInts());
    expect((updatedProse as CodeRenderable).selectionFg?.toInts()).toEqual(parseColor(dark.selectionForeground).toInts());
    expect((updatedMarker as TextRenderable).selectionBg?.toInts()).toEqual(parseColor(dark.selectionBackground).toInts());
    expect((updatedMarker as TextRenderable).selectionFg?.toInts()).toEqual(parseColor(dark.selectionForeground).toInts());
    setup.renderer.destroy();
  });

  test("uses native theme-owned selection colors across Markdown renderables", async () => {
    const scenarios = ["prose", "list", "link", "fenced-code", "table-cell"];
    const results = await Promise.all(scenarios.map(async (scenario) => {
      const probe = Bun.spawn([
        process.execPath,
        "--preload",
        "@3akhp/opentui-solid/preload",
        "tests/support/markdown-selection-theme-probe.tsx",
      ], {
        cwd: process.cwd(),
        env: { ...process.env, VESICLE_MARKDOWN_SELECTION_SCENARIO: scenario },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => probe.kill(), 15_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        probe.exited.finally(() => clearTimeout(timeout)),
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ]);
      if (exitCode !== 0) throw new Error(`Markdown ${scenario} selection probe failed:\n${stdout}\n${stderr}`);
      return stdout;
    }));
    for (const [index, scenario] of scenarios.entries()) {
      expect(results[index]).toContain(`Markdown selection theme propagation passed: ${scenario}`);
    }
  }, 20_000);
});

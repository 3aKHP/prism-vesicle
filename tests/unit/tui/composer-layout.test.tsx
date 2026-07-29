import { describe, expect, test } from "bun:test";
import { renderComposerLines } from "../../../src/tui/PromptComposer";
import { composerCursorCoords, layoutComposerText } from "../../../src/tui/composer-layout";

describe("tui: prompt composer", () => {
  test("prompt composer soft-wraps long input instead of truncating it", () => {
    const rendered = renderComposerLines("abcdefghijkl", 12, "placeholder", 5, 4);

    expect(rendered.map((line) => line.text)).toEqual(["abcde", "fghij", "kl"]);
    expect(rendered.some((line) => line.text.includes("..."))).toBe(false);
  });

  test("prompt composer wraps long text after an explicit newline", () => {
    const rendered = renderComposerLines("one\nabcdefghijkl", 16, "placeholder", 5, 5);

    expect(rendered.map((line) => line.text)).toEqual(["one", "abcde", "fghij", "kl"]);
  });

  test("prompt composer renders full-width visual line without truncation", () => {
    const rendered = renderComposerLines("abcde", 5, "placeholder", 5, 2);

    expect(rendered.map((line) => line.text)).toEqual(["abcde"]);
  });

  test("prompt composer follows the cursor when wrapped input exceeds visible height", () => {
    const rendered = renderComposerLines("abcdefghijklmnop", 16, "placeholder", 4, 2);

    expect(rendered.map((line) => line.text)).toEqual(["⋯ kl", "mnop"]);
  });

  test("empty value renders placeholder", () => {
    const rendered = renderComposerLines("", 0, "Type here", 20, 2);

    expect(rendered).toEqual([{ text: "Type here", placeholder: true }]);
  });
});

describe("tui: composer cursor coords", () => {
  test("ASCII cursor at start", () => {
    const layout = layoutComposerText("hello", 0, 20, 4);
    expect(composerCursorCoords("hello", 0, layout)).toEqual({ row: 0, col: 0 });
  });

  test("ASCII cursor mid-line", () => {
    const layout = layoutComposerText("hello", 3, 20, 4);
    expect(composerCursorCoords("hello", 3, layout)).toEqual({ row: 0, col: 3 });
  });

  test("CJK cursor uses display width", () => {
    const layout = layoutComposerText("你好世界", 2, 20, 4);
    expect(composerCursorCoords("你好世界", 2, layout)).toEqual({ row: 0, col: 4 });
  });

  test("cursor on second visual line after wrap", () => {
    const layout = layoutComposerText("abcdefgh", 6, 4, 4);
    expect(composerCursorCoords("abcdefgh", 6, layout)).toEqual({ row: 1, col: 2 });
  });

  test("cursor on empty line after explicit newline", () => {
    const layout = layoutComposerText("ab\n", 3, 20, 4);
    expect(composerCursorCoords("ab\n", 3, layout)).toEqual({ row: 1, col: 0 });
  });

  test("cursor row is relative to visible window", () => {
    const layout = layoutComposerText("a\nb\nc\nd\ne", 8, 20, 2);
    const coords = composerCursorCoords("a\nb\nc\nd\ne", 8, layout);
    expect(coords.row).toBe(layout.cursorLine - layout.visibleStart);
    expect(coords.row).toBeGreaterThanOrEqual(0);
    expect(coords.row).toBeLessThan(2);
  });

  test("emoji cursor uses display width", () => {
    const value = "A👨‍👩‍👧B";
    const layout = layoutComposerText(value, 1, 20, 4);
    const coords = composerCursorCoords(value, 1, layout);
    expect(coords.col).toBe(1);
  });
});

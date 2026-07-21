import { describe, expect, test } from "bun:test";
import { renderComposerLines } from "../../../src/tui/PromptComposer";

describe("tui: prompt composer", () => {
  test("prompt composer soft-wraps long input instead of truncating it", () => {
    const rendered = renderComposerLines("abcdefghijkl", 12, "placeholder", 5, 4, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["abcde", "fghij", "kl "]);
    expect(rendered.some((line) => line.prefix.includes("...") || line.suffix.includes("..."))).toBe(false);
  });

  test("prompt composer wraps long text after an explicit newline", () => {
    const rendered = renderComposerLines("one\nabcdefghijkl", 16, "placeholder", 5, 5, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["one", "abcde", "fghij", "kl "]);
  });

  test("prompt composer keeps the cursor within a full-width visual line", () => {
    const rendered = renderComposerLines("abcde", 5, "placeholder", 5, 2, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["abcde"]);
  });

  test("prompt composer follows the cursor when wrapped input exceeds visible height", () => {
    const rendered = renderComposerLines("abcdefghijklmnop", 16, "placeholder", 4, 2, true);

    expect(rendered.map((line) => `${line.prefix}${line.cursor ? line.cursorChar : ""}${line.suffix}`))
      .toEqual(["⋯ kl", "mnop"]);
  });

});

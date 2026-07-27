import { describe, expect, test } from "bun:test";
import { findSuspiciousMarkdownWraps } from "../../../scripts/check-staged-markdown-wrap.ts";

function added(...lines: number[]): Set<number> {
  return new Set(lines);
}

describe("staged Markdown wrap advisory", () => {
  test("warns when either side of a prose boundary was added", () => {
    const source = "First source line\nSecond source line\n";

    expect(findSuspiciousMarkdownWraps(source, added(2))).toEqual([
      { line: 2, reason: "Added prose appears to continue the preceding source line." },
    ]);
    expect(findSuspiciousMarkdownWraps(source, added(1))).toEqual([
      { line: 1, reason: "Added prose appears to continue onto the following source line." },
    ]);
  });

  test("warns on an added list-item continuation", () => {
    const source = "- One list item that should stay on one source line\n  continued prose\n";

    expect(findSuspiciousMarkdownWraps(source, added(2))).toHaveLength(1);
  });

  test("does not report boundaries outside the added lines", () => {
    const source = "Existing wrapped\nparagraph\n\nNew paragraph.\n";

    expect(findSuspiciousMarkdownWraps(source, added(4))).toEqual([]);
  });

  test("preserves structural and intentional line boundaries", () => {
    const source = [
      "> Quoted paragraph.",
      ">",
      "> Next quoted paragraph.",
      "",
      "| Column A | Column B |",
      "|---|---|",
      "| Value A | Value B |",
      "",
      "Column A | Column B",
      "--- | ---",
      "Value A | Value B",
      "Value C | Value D",
      "",
      "<div>",
      "HTML content line one",
      "HTML content line two",
      "</div>",
      "",
      "Explicit hard break.  ",
      "Next line.",
      "",
      "```text",
      "code line one",
      "code line two",
      "```",
      "",
    ].join("\n");

    expect(findSuspiciousMarkdownWraps(source, new Set(source.split("\n").map((_, index) => index + 1)))).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { findSuspiciousMarkdownWraps } from "../../../scripts/check/check-staged-markdown-wrap.ts";

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

  test("warns on quoted prose and indented list-item continuations", () => {
    const quoted = "> First quoted source line\n> Second quoted source line\n";
    const listItem = "- One list item that should stay on one source line\n  continued prose\n";

    expect(findSuspiciousMarkdownWraps(quoted, added(2))).toEqual([
      { line: 2, reason: "Added prose appears to continue the preceding source line." },
    ]);
    expect(findSuspiciousMarkdownWraps(listItem, added(2))).toHaveLength(1);
    expect(findSuspiciousMarkdownWraps("- Complete item\nNext paragraph.\n", added(2))).toEqual([]);
  });

  test("does not report boundaries outside the added lines", () => {
    const source = "Existing wrapped\nparagraph\n\nNew paragraph.\n";

    expect(findSuspiciousMarkdownWraps(source, added(4))).toEqual([]);
  });

  test("preserves table and link-definition boundaries adjacent to prose", () => {
    const source = [
      "Introductory prose.",
      "| Column A | Column B |",
      "|---|---|",
      "| Value A | Value B |",
      "Following prose.",
      "",
      "Another paragraph.",
      "[reference]: https://example.com/reference",
      "Closing prose.",
      "",
    ].join("\n");

    expect(findSuspiciousMarkdownWraps(source, new Set(source.split("\n").map((_, index) => index + 1)))).toEqual([]);
  });

  test("preserves HTML block interiors and their surrounding boundaries", () => {
    const source = [
      "Before the HTML block.",
      "<!--",
      "HTML comment content line one",
      "HTML comment content line two",
      "-->",
      "After the comment.",
      "",
      "<pre>",
      "raw content line one",
      "raw content line two",
      "</pre>",
      "After the raw block.",
      "",
    ].join("\n");

    expect(findSuspiciousMarkdownWraps(source, new Set(source.split("\n").map((_, index) => index + 1)))).toEqual([]);
  });

  test("preserves explicit line breaks and indented code", () => {
    const source = [
      "Explicit HTML break.<br>",
      "Next line.",
      "",
      "Explicit Markdown break.  ",
      "Next line.",
      "",
      "    const first = 1;",
      "    const second = 2;",
      "",
    ].join("\n");

    expect(findSuspiciousMarkdownWraps(source, new Set(source.split("\n").map((_, index) => index + 1)))).toEqual([]);
  });

  test("preserves structural and fenced-code boundaries", () => {
    const source = [
      "> Quoted paragraph.",
      ">",
      "> Next quoted paragraph.",
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
